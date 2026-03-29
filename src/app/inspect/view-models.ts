import { formatRecentCognitionFromPayload } from "../../memory/prompt-data.js";
import type { RuntimeBootstrapResult } from "../../bootstrap/types.js";
import type { InteractionRecord } from "../../interaction/contracts.js";
import { redactInteractionRecord } from "../../interaction/redaction.js";
import type { InteractionRepo } from "../../storage/domain-repos/contracts/interaction-repo.js";
import type { InspectContext } from "../contracts/inspect.js";
import type { LogEntry, TraceBundle } from "../contracts/trace.js";
import type { TraceStore } from "../diagnostics/trace-store.js";
import {
  getRequestEvidence,
  getSettlementRecord,
  type InspectAccessMode,
} from "./inspect-query-service.js";

export type InspectViewLoadParams = {
  runtime: RuntimeBootstrapResult;
  traceStore?: TraceStore;
  context: InspectContext;
  raw?: boolean;
  unsafeRaw?: boolean;
  mode?: InspectAccessMode;
};

export type SummaryView = {
  request_id: string;
  session_id?: string;
  agent_id?: string;
  settlement: {
    settlement_id?: string;
    has_public_reply: boolean;
    private_cognition_op_count: number;
    private_cognition_kinds: string[];
    redacted: boolean;
  };
  error?: {
    code?: string;
    message: string;
  };
  has_public_reply: boolean;
  private_cognition_count: number;
  memory_flush: {
    requested: boolean;
    result?: string;
  };
  pending_sweep_state: {
    status?: string;
    failure_count?: number;
    next_attempt_at?: number | null;
    last_error_code?: string | null;
    last_error_message?: string | null;
  };
  recovery_required: boolean;
  trace_available: boolean;
};

export type TranscriptEntry = {
  record_index: number;
  timestamp: number;
  actor: InteractionRecord["actorType"];
  record_type: InteractionRecord["recordType"];
  request_id?: string;
  text?: string;
  payload?: unknown;
};

export type TranscriptView = {
  session_id: string;
  raw_observation_mode: boolean;
  unsafe_raw_settlement_mode: boolean;
  entries: TranscriptEntry[];
};

export type PromptView = {
  request_id: string;
  session_id?: string;
  agent_id?: string;
  rendered_system_prompt?: string;
  conversation_messages: Array<{ role: string; content: string }>;
  sections?: Record<string, string>;
  recent_cognition?: string;
};

export type ChunksView = {
  request_id: string;
  public_only: true;
  chunks: Array<{
    index: number;
    type: string;
    timestamp?: number;
    preview?: string;
  }>;
};

export type LogsView = {
  filters: {
    request_id?: string;
    session_id?: string;
    agent_id?: string;
  };
  entries: Array<LogEntry & { request_id: string; session_id: string; agent_id: string }>;
};

export type MemoryView = {
  session_id: string;
  agent_id?: string;
  memory_pipeline: {
    ready: boolean;
    status: RuntimeBootstrapResult["memoryPipelineStatus"];
  };
  core_memory_summary: Array<{
    label: string;
    chars_current: number;
    char_limit: number;
  }>;
  recent_cognition: string;
  flush_state: {
    unprocessed_settlements: number;
  };
  pending_sweeper_state: {
    status?: string;
    failure_count?: number;
    next_attempt_at?: number | null;
    last_error_code?: string | null;
    last_error_message?: string | null;
  };
};

export type TraceView = {
  request_id: string;
  unsafe_raw_settlement_mode: boolean;
  bundle: {
    trace?: TraceBundle;
    interaction_settlement?: unknown;
  };
};

export async function loadSummaryView(params: InspectViewLoadParams): Promise<SummaryView> {
  const requestId = requireRequestId(params.context);
  const evidence = await getRequestEvidence({
    runtime: params.runtime,
    traceStore: params.traceStore,
    context: params.context,
    requestId,
  });
  const settlement = getSettlementRecord(evidence.records, params);
  const settlementPayload = settlement?.payload as SettlementPayloadLike | undefined;
  const derivedSessionId = settlementPayload?.sessionId ?? evidence.trace?.session_id ?? evidence.context.sessionId;
  const interactionRepo = getInteractionRepo(params.runtime);
  const pendingState = derivedSessionId
    ? await interactionRepo.getPendingSettlementJobState(derivedSessionId)
    : null;

  const errorFromStatus = evidence.records
    .filter((record) => record.recordType === "status")
    .map((record) => parseStatusError(record.payload))
    .find((error) => error !== undefined);
  const errorFromTrace = evidence.trace?.log_entries.find((entry) => entry.level === "error");

  return {
    request_id: requestId,
    session_id: settlementPayload?.sessionId ?? evidence.trace?.session_id ?? evidence.context.sessionId,
    agent_id: settlementPayload?.ownerAgentId ?? evidence.trace?.agent_id ?? evidence.context.agentId,
    settlement: {
      settlement_id: settlementPayload?.settlementId,
      has_public_reply: settlementPayload?.hasPublicReply ?? false,
      private_cognition_op_count: extractPrivateCognitionCount(settlementPayload),
      private_cognition_kinds: extractPrivateCognitionKinds(settlementPayload),
      redacted: true,
    },
    ...(errorFromStatus
      ? { error: errorFromStatus }
      : errorFromTrace
        ? { error: { message: errorFromTrace.message } }
        : {}),
    has_public_reply: settlementPayload?.hasPublicReply ?? false,
    private_cognition_count: extractPrivateCognitionCount(settlementPayload),
    memory_flush: {
      requested: evidence.trace?.flush?.requested ?? false,
      ...(evidence.trace?.flush?.result ? { result: evidence.trace.flush.result } : {}),
    },
    pending_sweep_state: pendingState ?? {},
    recovery_required: derivedSessionId
      ? params.runtime.sessionService.requiresRecovery(derivedSessionId)
      : false,
    trace_available: evidence.trace !== null,
  };
}

export async function loadTranscriptView(params: InspectViewLoadParams): Promise<TranscriptView> {
  const sessionId = requireSessionId(params.context);
  const records = await getInteractionRepo(params.runtime).getBySession(sessionId);
  const unsafeRaw = resolveUnsafeRawMode(params.mode, params.unsafeRaw ?? false);

  const entries = records
    .filter((record: InteractionRecord) => includeTranscriptRecord(record, Boolean(params.raw)))
    .map((record: InteractionRecord) => {
      const requestId = record.correlatedTurnId;
      if (record.recordType === "message") {
        const payload = record.payload as { content?: unknown };
        return {
          record_index: record.recordIndex,
          timestamp: record.committedAt,
          actor: record.actorType,
          record_type: record.recordType,
          ...(requestId ? { request_id: requestId } : {}),
          text: typeof payload.content === "string" ? payload.content : "",
        } satisfies TranscriptEntry;
      }

      if (record.recordType === "turn_settlement") {
        const payload = unsafeRaw ? record.payload : redactInteractionRecord(record).payload;
        return {
          record_index: record.recordIndex,
          timestamp: record.committedAt,
          actor: record.actorType,
          record_type: record.recordType,
          ...(requestId ? { request_id: requestId } : {}),
          payload,
        } satisfies TranscriptEntry;
      }

      return {
        record_index: record.recordIndex,
        timestamp: record.committedAt,
        actor: record.actorType,
        record_type: record.recordType,
        ...(requestId ? { request_id: requestId } : {}),
        payload: record.payload,
      } satisfies TranscriptEntry;
    });

  return {
    session_id: sessionId,
    raw_observation_mode: Boolean(params.raw),
    unsafe_raw_settlement_mode: unsafeRaw,
    entries,
  };
}

export async function loadPromptView(params: InspectViewLoadParams): Promise<PromptView> {
  const requestId = requireRequestId(params.context);
  const evidence = await getRequestEvidence({
    runtime: params.runtime,
    traceStore: params.traceStore,
    context: params.context,
    requestId,
  });
  const settlementPayload = (getSettlementRecord(evidence.records, params)?.payload ?? null) as
    | SettlementPayloadLike
    | null;

  const sessionId = settlementPayload?.sessionId ?? evidence.trace?.session_id ?? evidence.context.sessionId;
  const agentId = settlementPayload?.ownerAgentId ?? evidence.trace?.agent_id ?? evidence.context.agentId;
  const recentCognition = sessionId && agentId
    ? await getRecentCognitionFromRepo(agentId, sessionId, params.runtime)
    : "";

  return {
    request_id: requestId,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(evidence.trace?.prompt?.rendered_system
      ? { rendered_system_prompt: evidence.trace.prompt.rendered_system }
      : {}),
    conversation_messages: evidence.records
      .filter((record: InteractionRecord) => record.recordType === "message")
      .map((record: InteractionRecord) => {
        const payload = record.payload as { role?: unknown; content?: unknown };
        return {
          role: typeof payload.role === "string" ? payload.role : "unknown",
          content: typeof payload.content === "string" ? payload.content : "",
        };
      }),
    ...(evidence.trace?.prompt?.sections ? { sections: evidence.trace.prompt.sections } : {}),
    ...(recentCognition.length > 0 ? { recent_cognition: recentCognition } : {}),
  };
}

export async function loadChunksView(params: InspectViewLoadParams): Promise<ChunksView> {
  const requestId = requireRequestId(params.context);
  const trace = (await getRequestEvidence({
    runtime: params.runtime,
    traceStore: params.traceStore,
    context: params.context,
    requestId,
  })).trace;

  return {
    request_id: requestId,
    public_only: true,
    chunks: (trace?.public_chunks ?? []).map((chunk, index) => {
      let preview: string | undefined;
      if (chunk.type === "text_delta") {
        preview = chunk.text;
      } else if (chunk.type === "error") {
        preview = chunk.message;
      }

      return {
        index,
        type: chunk.type,
        ...(chunk.timestamp !== undefined ? { timestamp: chunk.timestamp } : {}),
        ...(preview !== undefined ? { preview } : {}),
      };
    }),
  };
}

export async function loadLogsView(params: InspectViewLoadParams): Promise<LogsView> {
  const requestId = params.context.requestId;
  const sessionId = params.context.sessionId;
  const agentId = params.context.agentId;
  const bundles = await collectTraceBundles(params, requestId, sessionId);

  const entries = bundles
    .flatMap((bundle) =>
      bundle.log_entries.map((entry) => ({
        ...entry,
        request_id: bundle.request_id,
        session_id: bundle.session_id,
        agent_id: bundle.agent_id,
      })),
    )
    .filter((entry) => (agentId ? entry.agent_id === agentId : true))
    .sort((a, b) => a.timestamp - b.timestamp);

  return {
    filters: {
      ...(requestId ? { request_id: requestId } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(agentId ? { agent_id: agentId } : {}),
    },
    entries,
  };
}

export async function loadMemoryView(params: InspectViewLoadParams): Promise<MemoryView> {
  const sessionId = requireSessionId(params.context);
  const agentId = params.context.agentId
    ?? params.runtime.sessionService.getSession(sessionId)?.agentId;
  const interactionRepo = getInteractionRepo(params.runtime);
  const pendingState = await interactionRepo.getPendingSettlementJobState(sessionId);

  let coreMemorySummary: MemoryView["core_memory_summary"] = [];
  if (agentId) {
    try {
      const blocks = await params.runtime.coreMemoryBlockRepo.getAllBlocks(agentId);
      coreMemorySummary = blocks.map((block) => ({
        label: block.label,
        chars_current: block.chars_current,
        char_limit: block.char_limit,
      }));
    } catch {
      coreMemorySummary = [];
    }
  }

  return {
    session_id: sessionId,
    ...(agentId ? { agent_id: agentId } : {}),
    memory_pipeline: {
      ready: params.runtime.memoryPipelineReady,
      status: params.runtime.memoryPipelineStatus,
    },
    core_memory_summary: coreMemorySummary,
    recent_cognition: agentId
      ? await getRecentCognitionFromRepo(agentId, sessionId, params.runtime)
      : "",
    flush_state: {
      unprocessed_settlements:
        await interactionRepo.countUnprocessedSettlements(sessionId),
    },
    pending_sweeper_state: pendingState ?? {},
  };
}

export async function loadTraceView(
  params: InspectViewLoadParams,
  unsafeRaw: boolean,
): Promise<TraceView> {
  const requestId = requireRequestId(params.context);
  const unsafeRawMode = resolveUnsafeRawMode(params.mode, unsafeRaw);
  const evidence = await getRequestEvidence({
    runtime: params.runtime,
    traceStore: params.traceStore,
    context: params.context,
    requestId,
  });
  const settlement = getSettlementRecord(evidence.records, { ...params, unsafeRaw: unsafeRawMode });

  return {
    request_id: requestId,
    unsafe_raw_settlement_mode: unsafeRawMode,
    bundle: {
      ...(evidence.trace ? { trace: evidence.trace } : {}),
      ...(settlement
        ? {
          interaction_settlement: settlement.payload,
        }
        : {}),
    },
  };
}

function includeTranscriptRecord(record: InteractionRecord, raw: boolean): boolean {
  if (record.recordType === "message" || record.recordType === "turn_settlement") {
    return true;
  }

  if (!raw) {
    return false;
  }

  return (
    record.recordType === "tool_call"
    || record.recordType === "tool_result"
    || record.recordType === "status"
    || record.recordType === "delegation"
    || record.recordType === "task_result"
    || record.recordType === "schedule_trigger"
  );
}

function requireRequestId(context: InspectContext): string {
  if (!context.requestId || context.requestId.trim().length === 0) {
    throw new Error("INSPECT_REQUEST_ID_REQUIRED");
  }

  return context.requestId;
}

function requireSessionId(context: InspectContext): string {
  if (!context.sessionId || context.sessionId.trim().length === 0) {
    throw new Error("INSPECT_SESSION_ID_REQUIRED");
  }

  return context.sessionId;
}

async function collectTraceBundles(
  params: InspectViewLoadParams,
  requestId?: string,
  sessionId?: string,
): Promise<TraceBundle[]> {
  if (requestId) {
    const trace = (await getRequestEvidence({
      runtime: params.runtime,
      traceStore: params.traceStore,
      context: params.context,
      requestId,
    })).trace;
    return trace ? [trace] : [];
  }

  if (!sessionId) {
    return [];
  }

  const records = await getInteractionRepo(params.runtime).getBySession(sessionId);
  const requestIds = [...new Set(records
    .map((record: InteractionRecord) => record.correlatedTurnId)
    .filter((value): value is string => typeof value === "string" && value.length > 0))];

  const bundles: TraceBundle[] = [];
  for (const id of requestIds) {
    const trace = (await getRequestEvidence({
      runtime: params.runtime,
      traceStore: params.traceStore,
      context: { ...params.context, requestId: id },
      requestId: id,
    })).trace;
    if (trace) {
      bundles.push(trace);
    }
  }

  return bundles;
}

function extractPrivateCognitionKinds(
  payload: SettlementPayloadLike | undefined,
): string[] {
  if (!payload?.privateCognition) {
    return [];
  }

  if (Array.isArray(payload.privateCognition.kinds)) {
    return [...payload.privateCognition.kinds];
  }

  if (!Array.isArray(payload.privateCognition.ops)) {
    return [];
  }

  const kinds: string[] = [];
  for (const op of payload.privateCognition.ops) {
    const kind = op.op === "upsert" ? op.record.kind : op.target.kind;
    if (!kinds.includes(kind)) {
      kinds.push(kind);
    }
  }

  return kinds;
}

function extractPrivateCognitionCount(payload: SettlementPayloadLike | undefined): number {
  if (!payload?.privateCognition) {
    return 0;
  }

  if (typeof payload.privateCognition.opCount === "number") {
    return payload.privateCognition.opCount;
  }

  if (Array.isArray(payload.privateCognition.ops)) {
    return payload.privateCognition.ops.length;
  }

  return 0;
}

function parseStatusError(payload: unknown): { code?: string; message: string } | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const statusPayload = payload as {
    event?: unknown;
    details?: {
      error_code?: unknown;
      error_message?: unknown;
    };
  };

  if (statusPayload.event !== "turn_failure") {
    return undefined;
  }

  const code = typeof statusPayload.details?.error_code === "string"
    ? statusPayload.details.error_code
    : undefined;
  const message = typeof statusPayload.details?.error_message === "string"
    ? statusPayload.details.error_message
    : "turn_failure";

  return { ...(code ? { code } : {}), message };
}

function resolveUnsafeRawMode(
  mode: InspectAccessMode | undefined,
  requested: boolean,
): boolean {
  if (!requested) {
    return false;
  }

  if (mode === "gateway") {
    throw new Error("INSPECT_UNSAFE_RAW_LOCAL_ONLY");
  }

  return true;
}

function getInteractionRepo(runtime: RuntimeBootstrapResult): InteractionRepo {
  return runtime.interactionRepo;
}

async function getRecentCognitionFromRepo(
  agentId: string,
  sessionId: string,
  runtime: RuntimeBootstrapResult,
): Promise<string> {
  const payload = await runtime.recentCognitionSlotRepo.getSlotPayload(sessionId, agentId);
  return formatRecentCognitionFromPayload(payload);
}

type SettlementPayloadLike = {
  settlementId: string;
  requestId: string;
  sessionId: string;
  ownerAgentId?: string;
  publicReply: string;
  hasPublicReply: boolean;
  privateCognition?: {
    ops?: Array<{ op: "upsert"; record: { kind: string } } | { op: "retract"; target: { kind: string } }>;
    opCount?: number;
    kinds?: string[];
  };
};
