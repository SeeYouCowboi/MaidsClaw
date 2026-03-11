import type { AgentLoop, AgentRunRequest } from "../core/agent-loop.js";
import type { Chunk } from "../core/chunk.js";
import type { ChatMessage } from "../core/models/chat-provider.js";
import type { CommitService } from "../interaction/commit-service.js";
import type { InteractionRecord } from "../interaction/contracts.js";
import type { FlushSelector } from "../interaction/flush-selector.js";
import type { InteractionStore } from "../interaction/store.js";
import type { MemoryFlushRequest, MemoryTaskAgent } from "../memory/task-agent.js";
import type { SessionService } from "../session/service.js";

export class TurnService {
  constructor(
    private readonly agentLoop: AgentLoop,
    private readonly commitService: CommitService,
    private readonly interactionStore: InteractionStore,
    private readonly flushSelector: FlushSelector,
    private readonly memoryTaskAgent: MemoryTaskAgent | null,
    private readonly sessionService: SessionService,
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
    }

    if (errorChunk === null) {
      this.commitService.commit({
        sessionId: request.sessionId,
        actorType: this.resolveAssistantActorType(request.sessionId),
        recordType: "message",
        payload: {
          role: "assistant",
          content: assistantText,
        },
        correlatedTurnId: request.requestId,
      });

      await this.flushIfDue(request.sessionId);
      return;
    }

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
    });

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
