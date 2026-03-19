import type { Chunk } from "../../../core/chunk.js";
import type { TurnSettlementPayload } from "../../../interaction/contracts.js";
import type { InteractionStore } from "../../../interaction/store.js";
import {
  executeUserTurn,
  type ExecuteUserTurnDeps,
} from "../../turn/user-turn-service.js";
import { TraceStore } from "../../diagnostics/trace-store.js";
import type {
  ObservationEvent,
  TurnExecutionResult,
} from "../../contracts/execution.js";
import type { PrivateCommitSummary } from "../../contracts/inspect.js";
import type { SessionService } from "../../../session/service.js";

// ── Public param / dep types ─────────────────────────────────────────

export type LocalTurnParams = {
  sessionId: string;
  agentId: string;
  text: string;
  saveTrace?: boolean;
};

export type LocalTurnDeps = {
  sessionService: SessionService;
  turnService: ExecuteUserTurnDeps["turnService"];
  interactionStore: InteractionStore;
  traceStore?: TraceStore;
};

// ── Entry point ──────────────────────────────────────────────────────

export async function executeLocalTurn(
  params: LocalTurnParams,
  deps: LocalTurnDeps,
): Promise<TurnExecutionResult> {
  const requestId = crypto.randomUUID();

  const perTurnTraceStore = params.saveTrace
    ? (deps.traceStore ?? new TraceStore())
    : undefined;

  const stream = executeUserTurn(
    {
      sessionId: params.sessionId,
      agentId: params.agentId,
      userText: params.text,
      requestId,
      metadata: {
        traceStore: perTurnTraceStore,
      },
    },
    {
      sessionService: deps.sessionService,
      turnService: deps.turnService,
    },
  );

  let assistantText = "";
  const publicChunks: ObservationEvent[] = [];
  const toolEvents: ObservationEvent[] = [];

  for await (const chunk of stream) {
    if (chunk.type === "text_delta") {
      assistantText += chunk.text;
    }

    const normalized = normalizeChunk(chunk, Date.now());
    if (normalized !== null) {
      publicChunks.push(normalized);
      if (isToolEvent(normalized)) {
        toolEvents.push(normalized);
      }
    }
  }

  const settlementPayload = deps.interactionStore.getSettlementPayload(
    params.sessionId,
    requestId,
  );

  const privateCommit = summarizePrivateCommit(settlementPayload);
  const hasPublicReply =
    typeof settlementPayload?.hasPublicReply === "boolean"
      ? settlementPayload.hasPublicReply
      : assistantText.length > 0;

  return {
    mode: "local",
    session_id: params.sessionId,
    request_id: requestId,
    settlement_id:
      typeof settlementPayload?.settlementId === "string"
        ? settlementPayload.settlementId
        : undefined,
    assistant_text: assistantText,
    has_public_reply: hasPublicReply,
    private_commit: privateCommit,
    recovery_required: deps.sessionService.requiresRecovery(params.sessionId),
    public_chunks: publicChunks,
    tool_events: toolEvents,
  };
}

// ── Helpers (moved from local-runtime.ts) ────────────────────────────

function isToolEvent(event: ObservationEvent): boolean {
  return (
    event.type === "tool_use_start"
    || event.type === "tool_use_delta"
    || event.type === "tool_use_end"
    || event.type === "tool_execution_result"
  );
}

function normalizeChunk(chunk: Chunk, timestamp: number): ObservationEvent | null {
  switch (chunk.type) {
    case "text_delta":
      return {
        type: "text_delta",
        timestamp,
        text: chunk.text,
      };
    case "tool_use_start":
      return {
        type: "tool_use_start",
        timestamp,
        id: chunk.id,
        tool: chunk.name,
        input: { id: chunk.id, status: "started" },
      };
    case "tool_use_delta":
      return {
        type: "tool_use_delta",
        timestamp,
        id: chunk.id,
        input_delta: chunk.partialJson,
      };
    case "tool_use_end":
      return {
        type: "tool_use_end",
        timestamp,
        id: chunk.id,
      };
    case "tool_execution_result":
      return {
        type: "tool_execution_result",
        timestamp,
        id: chunk.id,
        tool: chunk.name,
        output: chunk.result,
        is_error: chunk.isError,
      };
    case "error":
      return {
        type: "error",
        timestamp,
        code: chunk.code,
        message: chunk.message,
        retriable: chunk.retriable,
      };
    case "message_end":
      return {
        type: "message_end",
        timestamp,
        stop_reason: chunk.stopReason,
        usage: {
          input_tokens: chunk.inputTokens,
          output_tokens: chunk.outputTokens,
        },
      };
    default:
      return null;
  }
}

function summarizePrivateCommit(
  settlementPayload: TurnSettlementPayload | undefined,
): PrivateCommitSummary {
  const ops = settlementPayload?.privateCommit?.ops ?? [];
  if (ops.length === 0) {
    return {
      present: false,
      op_count: 0,
      kinds: [],
    };
  }

  const kinds: string[] = [];
  for (const op of ops) {
    const kind =
      op.op === "upsert" ? op.record.kind : op.op === "retract" ? op.target.kind : undefined;
    if (kind && !kinds.includes(kind)) {
      kinds.push(kind);
    }
  }

  return {
    present: true,
    op_count: ops.length,
    kinds,
  };
}
