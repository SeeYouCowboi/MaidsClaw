import type { Chunk } from "../core/chunk.js";
import type { TurnSettlementPayload } from "../interaction/contracts.js";
import type { RuntimeBootstrapResult } from "../bootstrap/types.js";
import { executeUserTurn } from "../app/turn/user-turn-service.js";
import { TraceStore } from "../app/diagnostics/trace-store.js";
import type {
  ObservationEvent,
  TurnExecutionResult,
} from "../app/contracts/execution.js";
import type {
  PrivateCommitSummary,
} from "../app/contracts/inspect.js";

export type LocalTurnParams = {
  sessionId: string;
  agentId: string;
  text: string;
  saveTrace?: boolean;
};

type SettlementRow = {
  payload: string;
};

export class LocalRuntime {
  constructor(private readonly runtime: RuntimeBootstrapResult) {}

  async executeTurn(params: LocalTurnParams): Promise<TurnExecutionResult> {
    const requestId = crypto.randomUUID();
    let assistantText = "";
    const publicChunks: ObservationEvent[] = [];
    const toolEvents: ObservationEvent[] = [];

    const perTurnTraceStore = params.saveTrace
      ? (this.runtime.traceStore ?? new TraceStore())
      : undefined;

    const stream = executeUserTurn({
      sessionId: params.sessionId,
      agentId: params.agentId,
      userText: params.text,
      requestId,
      metadata: {
        traceStore: perTurnTraceStore,
      },
    }, {
      sessionService: this.runtime.sessionService,
      turnService: this.runtime.turnService,
    });

    for await (const chunk of stream) {
      if (chunk.type === "text_delta") {
        assistantText += chunk.text;
      }

      const normalized = normalizeChunk(chunk, Date.now());
      if (normalized !== null) {
        publicChunks.push(normalized);
        if (
          normalized.type === "tool_use_start"
          || normalized.type === "tool_use_delta"
          || normalized.type === "tool_use_end"
          || normalized.type === "tool_execution_result"
        ) {
          toolEvents.push(normalized);
        }
      }
    }

    const settlementPayload = this.readSettlementPayload(params.sessionId, requestId);
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
      recovery_required: this.runtime.sessionService.requiresRecovery(params.sessionId),
      public_chunks: publicChunks,
      tool_events: toolEvents,
    };
  }

  private readSettlementPayload(
    sessionId: string,
    requestId: string,
  ): TurnSettlementPayload | undefined {
    const row = this.runtime.db.get<SettlementRow>(
      "SELECT payload FROM interaction_records WHERE session_id = ? AND correlated_turn_id = ? AND record_type = 'turn_settlement' ORDER BY id DESC LIMIT 1",
      [sessionId, requestId],
    );
    if (!row || typeof row.payload !== "string") {
      return undefined;
    }

    try {
      const parsed = JSON.parse(row.payload) as unknown;
      if (!parsed || typeof parsed !== "object") {
        return undefined;
      }
      return parsed as TurnSettlementPayload;
    } catch {
      return undefined;
    }
  }
}

export function createLocalRuntime(runtime: RuntimeBootstrapResult): LocalRuntime {
  return new LocalRuntime(runtime);
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
