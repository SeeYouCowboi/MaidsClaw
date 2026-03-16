import type { AgentRunRequest } from "../core/agent-loop.js";
import type { AgentProfile } from "../agents/profile.js";
import type { Chunk } from "../core/chunk.js";
import type { ChatMessage } from "../core/models/chat-provider.js";
import type { CommitService, CommitInput } from "../interaction/commit-service.js";
import type {
  AssistantMessagePayloadV3,
  InteractionRecord,
  TurnSettlementPayload,
} from "../interaction/contracts.js";
import type { FlushSelector } from "../interaction/flush-selector.js";
import type { InteractionStore } from "../interaction/store.js";
import { CognitionOpCommitter } from "../memory/cognition-op-committer.js";
import type { GraphStorageService } from "../memory/storage.js";
import type { ViewerContext } from "../memory/types.js";
import type { MemoryFlushRequest, MemoryTaskAgent } from "../memory/task-agent.js";
import type {
  RpBufferedExecutionResult,
  RpTurnOutcomeSubmission,
  CognitionOp,
  CognitionKind,
  AssertionRecord,
  EvaluationRecord,
  CommitmentRecord,
  CognitionEntityRef,
  CognitionSelector,
} from "./rp-turn-contract.js";
import type { SessionService } from "../session/service.js";
import type { RuntimeProjectionSink } from "../core/runtime-projection.js";
import type { ProjectionAppendix } from "../core/types.js";

type TurnServiceAgentLoop = {
  run(request: AgentRunRequest): AsyncIterable<Chunk>;
  runBuffered?: (request: AgentRunRequest) => Promise<RpBufferedExecutionResult>;
};

export class TurnService {
  constructor(
    private readonly agentLoop: TurnServiceAgentLoop,
    private readonly commitService: CommitService,
    private readonly interactionStore: InteractionStore,
    private readonly flushSelector: FlushSelector,
    private readonly memoryTaskAgent: MemoryTaskAgent | null,
    private readonly sessionService: SessionService,
    private readonly viewerContextResolver?: (params: {
      sessionId: string;
      agentId: string;
      role: AgentProfile["role"];
    }) => ViewerContext | Promise<ViewerContext>,
    private readonly projectionSink?: RuntimeProjectionSink,
    private readonly graphStorage?: GraphStorageService,
  ) {}

  async *run(request: AgentRunRequest): AsyncGenerator<Chunk> {
    const userRecord = this.commitService.commit({
      sessionId: request.sessionId,
      actorType: "user",
      recordType: "message",
      payload: {
        role: "user",
        content: getLatestUserMessage(request.messages),
      },
      correlatedTurnId: request.requestId,
    });

    const turnRangeStart = userRecord.recordIndex;
    const assistantActorType = this.resolveAssistantActorType(request.sessionId);

    if (assistantActorType === "rp_agent") {
      yield* this.runRpBufferedTurn(request, turnRangeStart);
      return;
    }

    let assistantText = "";
    let hasAssistantVisibleActivity = false;
    let errorChunk: { code?: string; message?: string } | null = null;

    try {
      for await (const chunk of this.agentLoop.run(request)) {
        if (chunk.type === "text_delta") {
          if (chunk.text.length > 0) {
            assistantText += chunk.text;
            hasAssistantVisibleActivity = true;
          }
        } else if (chunk.type === "tool_use_start" || chunk.type === "tool_use_delta" || chunk.type === "tool_use_end") {
          hasAssistantVisibleActivity = true;
        } else if (chunk.type === "error") {
          errorChunk = { code: chunk.code, message: chunk.message };
        }

        yield chunk;
      }
    } catch (error: unknown) {
      errorChunk = {
        code: "AGENT_LOOP_EXCEPTION",
        message: error instanceof Error ? error.message : String(error),
      };
      yield {
        type: "error" as const,
        code: errorChunk.code ?? "UNKNOWN",
        message: errorChunk.message ?? "Unknown error",
        retriable: false,
      };
    }

    if (errorChunk === null) {
      if (assistantText.length > 0) {
        this.commitService.commit({
          sessionId: request.sessionId,
          actorType: assistantActorType,
          recordType: "message",
          payload: {
            role: "assistant",
            content: assistantText,
          },
          correlatedTurnId: request.requestId,
        });
      }

      await this.flushIfDue(request.sessionId);
      return;
    }

    this.handleFailedTurn({
      request,
      turnRangeStart,
      errorChunk,
      assistantText,
      hasAssistantVisibleActivity,
    });
  }

  private async *runRpBufferedTurn(request: AgentRunRequest, turnRangeStart: number): AsyncGenerator<Chunk> {
    let bufferedResult: RpBufferedExecutionResult;
    let viewerSnapshot: TurnSettlementPayload["viewerSnapshot"] | undefined;

    try {
      if (!this.agentLoop.runBuffered) {
        throw new Error("RP buffered execution is unavailable");
      }
      bufferedResult = await this.agentLoop.runBuffered(request);
    } catch (error: unknown) {
      const errorChunk = {
        code: "AGENT_LOOP_EXCEPTION",
        message: error instanceof Error ? error.message : String(error),
      };
      yield {
        type: "error" as const,
        code: errorChunk.code,
        message: errorChunk.message,
        retriable: false,
      };
      this.handleFailedTurn({
        request,
        turnRangeStart,
        errorChunk,
        assistantText: "",
        hasAssistantVisibleActivity: false,
      });
      return;
    }

    if ("error" in bufferedResult) {
      const errorChunk = {
        code: "RP_BUFFERED_EXECUTION_FAILED",
        message: bufferedResult.error,
      };
      yield {
        type: "error" as const,
        code: errorChunk.code,
        message: errorChunk.message,
        retriable: false,
      };
      this.handleFailedTurn({
        request,
        turnRangeStart,
        errorChunk,
        assistantText: "",
        hasAssistantVisibleActivity: false,
      });
      return;
    }

    const outcome = bufferedResult.outcome;
    const hasPrivateOps = (outcome.privateCommit?.ops.length ?? 0) > 0;
    const hasPublicReply = outcome.publicReply.length > 0;
    const hasAssistantVisibleActivity = hasPublicReply;

    if (!hasPublicReply && !hasPrivateOps) {
      const errorChunk = {
        code: "RP_EMPTY_TURN",
        message: "empty turn: publicReply is empty and privateCommit has no ops",
      };
      yield {
        type: "error" as const,
        code: errorChunk.code,
        message: errorChunk.message,
        retriable: false,
      };
      this.handleFailedTurn({
        request,
        turnRangeStart,
        errorChunk,
        assistantText: outcome.publicReply,
        hasAssistantVisibleActivity,
      });
      return;
    }

    const settlementId = crypto.randomUUID();
    if (this.interactionStore.settlementExists(settlementId)) {
      if (hasPublicReply) {
        yield {
          type: "text_delta",
          text: outcome.publicReply,
        };
      }
      yield {
        type: "message_end",
        stopReason: "end_turn",
      };
      await this.flushIfDue(request.sessionId);
      return;
    }

    try {
      const resolvedViewerSnapshot = await this.resolveViewerSnapshot(request.sessionId, "rp_agent");
      viewerSnapshot = resolvedViewerSnapshot;
      this.interactionStore.runInTransaction(() => {
        const settlementPayload: TurnSettlementPayload = {
          settlementId,
          requestId: request.requestId,
          sessionId: request.sessionId,
          publicReply: outcome.publicReply,
          hasPublicReply,
          viewerSnapshot: resolvedViewerSnapshot,
        };

        this.commitService.commitWithId({
          sessionId: request.sessionId,
          actorType: "rp_agent",
          recordId: settlementId,
          recordType: "turn_settlement",
          payload: settlementPayload,
          correlatedTurnId: request.requestId,
        });

        if (hasPublicReply) {
          const assistantPayload: AssistantMessagePayloadV3 = {
            role: "assistant",
            content: outcome.publicReply,
            settlementId,
          };

          this.commitService.commit({
            sessionId: request.sessionId,
            actorType: "rp_agent",
            recordType: "message",
            payload: assistantPayload,
            correlatedTurnId: request.requestId,
          });
        }

        if (hasPrivateOps && this.graphStorage) {
          const queueOwnerAgentId = this.resolveQueueOwnerAgentId(request.sessionId) ?? "";
          const committer = new CognitionOpCommitter(this.graphStorage, queueOwnerAgentId);
          committer.commit(outcome.privateCommit!.ops, settlementId);
        }

        const slotPayload = buildCognitionSlotPayload(outcome.privateCommit?.ops ?? []);
        this.interactionStore.upsertRecentCognitionSlot(
          request.sessionId,
          this.resolveQueueOwnerAgentId(request.sessionId) ?? "",
          settlementId,
          JSON.stringify(slotPayload),
        );
      });
    } catch (error: unknown) {
      const errorChunk = {
        code: "TURN_SETTLEMENT_FAILED",
        message: error instanceof Error ? error.message : String(error),
      };
      yield {
        type: "error" as const,
        code: errorChunk.code,
        message: errorChunk.message,
        retriable: false,
      };
      this.handleFailedTurn({
        request,
        turnRangeStart,
        errorChunk,
        assistantText: outcome.publicReply,
        hasAssistantVisibleActivity,
      });
      return;
    }

    const queueOwnerAgentId = this.resolveQueueOwnerAgentId(request.sessionId) ?? "unknown";
    this.projectionSink?.onProjectionEligible(
      createProjectionAppendix({
        publicReply: outcome.publicReply,
        agentId: queueOwnerAgentId,
        settlementId,
        locationEntityId: String(viewerSnapshot?.currentLocationEntityId ?? "unknown"),
      }),
      request.sessionId,
    );

    if (hasPublicReply) {
      yield {
        type: "text_delta",
        text: outcome.publicReply,
      };
    }
    yield {
      type: "message_end",
      stopReason: "end_turn",
    };

    await this.flushIfDue(request.sessionId);
  }

  private async resolveViewerSnapshot(
    sessionId: string,
    role: AgentProfile["role"],
  ): Promise<TurnSettlementPayload["viewerSnapshot"]> {
    const agentId = this.resolveQueueOwnerAgentId(sessionId) ?? "";
    const viewerContext = await this.resolveViewerContext({ sessionId, agentId, role });
    const currentLocationEntityId =
      typeof viewerContext.current_area_id === "number" ? viewerContext.current_area_id : undefined;

    return {
      selfPointerKey: "__self__",
      userPointerKey: "__user__",
      currentLocationEntityId,
    };
  }

  private async resolveViewerContext(params: {
    sessionId: string;
    agentId: string;
    role: AgentProfile["role"];
  }): Promise<ViewerContext> {
    if (this.viewerContextResolver) {
      return await this.viewerContextResolver(params);
    }

    return {
      viewer_agent_id: params.agentId,
      viewer_role: params.role,
      session_id: params.sessionId,
      current_area_id: undefined,
    };
  }

  private handleFailedTurn(params: {
    request: AgentRunRequest;
    turnRangeStart: number;
    errorChunk: { code?: string; message?: string };
    assistantText: string;
    hasAssistantVisibleActivity: boolean;
  }): void {
    const { request, turnRangeStart, errorChunk, assistantText, hasAssistantVisibleActivity } = params;

    const outcome = hasAssistantVisibleActivity
      ? "failed_with_partial_output"
      : "failed_no_output";

    const statusRecord = this.commitService.commit({
      sessionId: request.sessionId,
      actorType: "system",
      recordType: "status",
      payload: {
        event: "turn_failure",
        details: {
          outcome,
          request_id: request.requestId,
          error_code: errorChunk.code ?? "UNKNOWN",
          error_message: errorChunk.message ?? "Unknown error",
          partial_text: assistantText,
          assistant_visible_activity: hasAssistantVisibleActivity,
          committed_at: Date.now(),
        },
      },
      correlatedTurnId: request.requestId,
    } satisfies CommitInput);

    this.interactionStore.markRangeProcessed(request.sessionId, turnRangeStart, statusRecord.recordIndex);
    if (hasAssistantVisibleActivity) {
      this.sessionService.setRecoveryRequired(request.sessionId);
    }
  }

  async flushOnSessionClose(sessionId: string, agentId: string): Promise<void> {
    if (this.memoryTaskAgent === null) {
      return;
    }

    const flushRequest = this.flushSelector.buildSessionCloseFlush(sessionId, agentId);
    if (flushRequest === null) {
      return;
    }

    try {
      await this.runFlush(flushRequest, agentId);
    } catch {
      return;
    }
  }

  private async flushIfDue(sessionId: string): Promise<void> {
    if (this.memoryTaskAgent === null) {
      return;
    }

    const queueOwnerAgentId = this.resolveQueueOwnerAgentId(sessionId);
    if (!queueOwnerAgentId) {
      return;
    }

    const flushRequest = this.flushSelector.shouldFlush(sessionId, queueOwnerAgentId);
    if (flushRequest === null) {
      return;
    }

    try {
      await this.runFlush(flushRequest, queueOwnerAgentId);
    } catch {
      return;
    }
  }

  private async runFlush(flushRequest: MemoryFlushRequest, queueOwnerAgentId: string): Promise<void> {
    if (this.memoryTaskAgent === null) {
      return;
    }

    const records = this.interactionStore.getByRange(
      flushRequest.sessionId,
      flushRequest.rangeStart,
      flushRequest.rangeEnd,
    );

    await this.memoryTaskAgent.runMigrate({
      ...flushRequest,
      dialogueRecords: toDialogueRecords(records),
      queueOwnerAgentId,
    });

    this.interactionStore.markProcessed(flushRequest.sessionId, flushRequest.rangeEnd);
  }

  private resolveQueueOwnerAgentId(sessionId: string): string | undefined {
    return this.sessionService.getSession(sessionId)?.agentId;
  }

  private resolveAssistantActorType(sessionId: string): "rp_agent" | "maiden" | "task_agent" {
    const agentId = this.resolveQueueOwnerAgentId(sessionId);
    if (agentId?.startsWith("maid:")) {
      return "maiden";
    }
    if (agentId?.startsWith("task:")) {
      return "task_agent";
    }
    return "rp_agent";
  }
}

function createProjectionAppendix(params: {
  publicReply: string;
  agentId: string;
  settlementId: string;
  locationEntityId: string;
}): ProjectionAppendix {
  return {
    publicSummarySeed: params.publicReply,
    primaryActorEntityId: params.agentId,
    locationEntityId: params.locationEntityId,
    eventCategory: "speech",
    projectionClass: params.publicReply.trim().length > 0 ? "area_candidate" : "non_projectable",
    sourceRecordId: params.settlementId,
  };
}

function toDialogueRecords(records: InteractionRecord[]): Array<{
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  recordId: string;
  recordIndex: number;
}> {
  type DialogueRecord = {
    role: "user" | "assistant";
    content: string;
    timestamp: number;
    recordId: string;
    recordIndex: number;
  };

  return records
    .filter((record) => record.recordType === "message")
    .map((record): DialogueRecord | undefined => {
      const payload = record.payload as { role?: unknown; content?: unknown };
      const role = payload.role;
      if (role !== "user" && role !== "assistant") {
        return undefined;
      }
      return {
        role,
        content: typeof payload.content === "string" ? payload.content : "",
        timestamp: record.committedAt,
        recordId: record.recordId,
        recordIndex: record.recordIndex,
      };
    })
    .filter((record): record is DialogueRecord => record !== undefined);
}

type CognitionSlotItem = {
  kind: CognitionKind;
  key: string;
  summary: string;
};

function refValue(ref: CognitionEntityRef | CognitionSelector): string {
  if ("value" in ref) return ref.value;
  return (ref as CognitionSelector).key;
}

function summarizeAssertion(record: AssertionRecord): string {
  return `${record.proposition.subject.value} ${record.proposition.predicate} ${record.proposition.object.ref.value} (${record.stance})`;
}

function summarizeEvaluation(record: EvaluationRecord): string {
  const targetLabel = refValue(record.target);
  const dims = record.dimensions.map((d) => `${d.name}:${d.value}`).join(", ");
  return `eval ${targetLabel} [${dims}]`;
}

function summarizeCommitment(record: CommitmentRecord): string {
  let targetDesc: string;
  if (typeof record.target === "object" && "action" in record.target) {
    targetDesc = record.target.action;
  } else if (typeof record.target === "object" && "predicate" in record.target) {
    targetDesc = (record.target as { predicate?: string }).predicate ?? "";
  } else {
    targetDesc = "";
  }
  return `${record.mode}: ${targetDesc} (${record.status})`;
}

function buildCognitionSlotPayload(ops: CognitionOp[]): CognitionSlotItem[] {
  const items: CognitionSlotItem[] = [];

  for (const op of ops) {
    if (op.op === "upsert") {
      const record = op.record;
      let summary: string;
      switch (record.kind) {
        case "assertion":
          summary = summarizeAssertion(record as AssertionRecord);
          break;
        case "evaluation":
          summary = summarizeEvaluation(record as EvaluationRecord);
          break;
        case "commitment":
          summary = summarizeCommitment(record as CommitmentRecord);
          break;
      }
      items.push({ kind: record.kind, key: record.key, summary });
    } else if (op.op === "retract") {
      items.push({ kind: op.target.kind, key: op.target.key, summary: "[retracted]" });
    }
  }

  // Cap at last 8 items
  return items.slice(-8);
}

function getLatestUserMessage(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") {
      continue;
    }

    if (typeof message.content === "string") {
      return message.content;
    }

    return message.content
      .map((block) => {
        if (block.type === "text") {
          return block.text;
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }

  return "";
}
