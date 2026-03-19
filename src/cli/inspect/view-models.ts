import { CoreMemoryService } from "../../memory/core-memory.js";
import { getRecentCognition } from "../../memory/prompt-data.js";
import type { RuntimeBootstrapResult } from "../../bootstrap/types.js";
import type {
	InteractionRecord,
	TurnSettlementPayload,
} from "../../interaction/contracts.js";
import { redactInteractionRecord } from "../../interaction/redaction.js";
import { InteractionStore } from "../../interaction/store.js";
import type { LogEntry, TraceBundle } from "../../app/contracts/trace.js";
import type { TraceStore } from "../trace-store.js";
import type { CliMode } from "../types.js";
import {
	requireRequestId,
	type InspectContext,
} from "./context-resolver.js";

export type InspectViewLoadParams = {
	runtime: RuntimeBootstrapResult;
	traceStore?: TraceStore;
	context: InspectContext;
	raw?: boolean;
	unsafeRaw?: boolean;
	mode?: CliMode;
};

export type SummaryView = {
	request_id: string;
	session_id?: string;
	agent_id?: string;
	settlement: {
		settlement_id?: string;
		has_public_reply: boolean;
		private_commit_op_count: number;
		private_commit_kinds: string[];
		redacted: boolean;
	};
	error?: {
		code?: string;
		message: string;
	};
	has_public_reply: boolean;
	private_commit_count: number;
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

export function loadSummaryView(params: InspectViewLoadParams): SummaryView {
	const requestId = requireRequestId(params.context);
	const requestRecords = getRecordsForRequest(params.runtime, params.context, requestId);
	const settlement = getSettlementRecord(requestRecords, params);
	const settlementPayload = settlement?.payload as SettlementPayloadLike | undefined;
	const trace = getTraceBundle(params, requestId);
	const derivedSessionId = settlementPayload?.sessionId ?? trace?.session_id ?? params.context.sessionId;
	const interactionStore = getInteractionStore(params.runtime);
	const pendingState = derivedSessionId
		? interactionStore.getPendingSettlementJobState(derivedSessionId)
		: null;

	const errorFromStatus = requestRecords
		.filter((record) => record.recordType === "status")
		.map((record) => parseStatusError(record.payload))
		.find((error) => error !== undefined);
	const errorFromTrace = trace?.log_entries.find((entry) => entry.level === "error");

	return {
		request_id: requestId,
		session_id: settlementPayload?.sessionId ?? trace?.session_id ?? params.context.sessionId,
		agent_id: settlementPayload?.ownerAgentId ?? trace?.agent_id ?? params.context.agentId,
		settlement: {
			settlement_id: settlementPayload?.settlementId,
			has_public_reply: settlementPayload?.hasPublicReply ?? false,
			private_commit_op_count: extractPrivateCommitCount(settlementPayload),
			private_commit_kinds: extractPrivateCommitKinds(settlementPayload),
			redacted: true,
		},
		...(errorFromStatus
			? { error: errorFromStatus }
			: errorFromTrace
				? { error: { message: errorFromTrace.message } }
				: {}),
		has_public_reply: settlementPayload?.hasPublicReply ?? false,
		private_commit_count: extractPrivateCommitCount(settlementPayload),
		memory_flush: {
			requested: trace?.flush?.requested ?? false,
			...(trace?.flush?.result ? { result: trace.flush.result } : {}),
		},
		pending_sweep_state: pendingState ?? {},
		recovery_required: derivedSessionId
			? params.runtime.sessionService.requiresRecovery(derivedSessionId)
			: false,
		trace_available: trace !== null,
	};
}

export function loadTranscriptView(params: InspectViewLoadParams): TranscriptView {
	const sessionId = requireSessionId(params.context);
	const records = getInteractionStore(params.runtime).getBySession(sessionId);
	const unsafeRaw = resolveUnsafeRawMode(params, params.unsafeRaw ?? false);

	const entries = records
		.filter((record) => includeTranscriptRecord(record, Boolean(params.raw)))
		.map((record) => {
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

export function loadPromptView(params: InspectViewLoadParams): PromptView {
	const requestId = requireRequestId(params.context);
	const trace = getTraceBundle(params, requestId);
	const requestRecords = getRecordsForRequest(params.runtime, params.context, requestId);
	const settlementPayload = (getSettlementRecord(requestRecords, params)?.payload ?? null) as
		| SettlementPayloadLike
		| null;

	const sessionId = settlementPayload?.sessionId ?? trace?.session_id ?? params.context.sessionId;
	const agentId = settlementPayload?.ownerAgentId ?? trace?.agent_id ?? params.context.agentId;
	const recentCognition = sessionId && agentId
		? getRecentCognition(agentId, sessionId, params.runtime.db)
		: "";

	return {
		request_id: requestId,
		...(sessionId ? { session_id: sessionId } : {}),
		...(agentId ? { agent_id: agentId } : {}),
		...(trace?.prompt?.rendered_system
			? { rendered_system_prompt: trace.prompt.rendered_system }
			: {}),
		conversation_messages: requestRecords
			.filter((record) => record.recordType === "message")
			.map((record) => {
				const payload = record.payload as { role?: unknown; content?: unknown };
				return {
					role: typeof payload.role === "string" ? payload.role : "unknown",
					content: typeof payload.content === "string" ? payload.content : "",
				};
			}),
		...(trace?.prompt?.sections ? { sections: trace.prompt.sections } : {}),
		...(recentCognition.length > 0 ? { recent_cognition: recentCognition } : {}),
	};
}

export function loadChunksView(params: InspectViewLoadParams): ChunksView {
	const requestId = requireRequestId(params.context);
	const trace = getTraceBundle(params, requestId);

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

export function loadLogsView(params: InspectViewLoadParams): LogsView {
	const requestId = params.context.requestId;
	const sessionId = params.context.sessionId;
	const agentId = params.context.agentId;
	const bundles = collectTraceBundles(params, requestId, sessionId);

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

export function loadMemoryView(params: InspectViewLoadParams): MemoryView {
	const sessionId = requireSessionId(params.context);
	const agentId = params.context.agentId
		?? params.runtime.sessionService.getSession(sessionId)?.agentId;
	const pendingState = getInteractionStore(params.runtime).getPendingSettlementJobState(sessionId);

	let coreMemorySummary: MemoryView["core_memory_summary"] = [];
	if (agentId) {
		try {
			const coreMemory = new CoreMemoryService(params.runtime.db);
			coreMemorySummary = coreMemory.getAllBlocks(agentId).map((block) => ({
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
			? getRecentCognition(agentId, sessionId, params.runtime.db)
			: "",
		flush_state: {
			unprocessed_settlements:
				getInteractionStore(params.runtime).countUnprocessedSettlements(sessionId),
		},
		pending_sweeper_state: pendingState ?? {},
	};
}

export function loadTraceView(
	params: InspectViewLoadParams,
	unsafeRaw: boolean,
): TraceView {
	const requestId = requireRequestId(params.context);
	const unsafeRawMode = resolveUnsafeRawMode(params, unsafeRaw);
	const trace = getTraceBundle(params, requestId);
	const settlement = getSettlementRecord(
		getRecordsForRequest(params.runtime, params.context, requestId),
		{ ...params, unsafeRaw: unsafeRawMode },
	);

	return {
		request_id: requestId,
		unsafe_raw_settlement_mode: unsafeRawMode,
		bundle: {
			...(trace ? { trace } : {}),
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

function requireSessionId(context: InspectContext): string {
	if (!context.sessionId || context.sessionId.trim().length === 0) {
		throw new Error("INSPECT_SESSION_ID_REQUIRED");
	}

	return context.sessionId;
}

function collectTraceBundles(
	params: InspectViewLoadParams,
	requestId?: string,
	sessionId?: string,
): TraceBundle[] {
	if (requestId) {
		const trace = getTraceBundle(params, requestId);
		return trace ? [trace] : [];
	}

	if (!sessionId) {
		return [];
	}

	const records = getInteractionStore(params.runtime).getBySession(sessionId);
	const requestIds = [...new Set(records
		.map((record) => record.correlatedTurnId)
		.filter((value): value is string => typeof value === "string" && value.length > 0))];

	const bundles: TraceBundle[] = [];
	for (const id of requestIds) {
		const trace = getTraceBundle(params, id);
		if (trace) {
			bundles.push(trace);
		}
	}

	return bundles;
}

function getTraceBundle(
	params: Pick<InspectViewLoadParams, "runtime" | "traceStore">,
	requestId: string,
): TraceBundle | null {
	const store = params.traceStore ?? params.runtime.traceStore;
	if (!store) {
		return null;
	}

	return store.readTrace(requestId);
}

function getRecordsForRequest(
	runtime: RuntimeBootstrapResult,
	context: InspectContext,
	requestId: string,
): InteractionRecord[] {
	const interactionStore = getInteractionStore(runtime);
	if (context.sessionId) {
		return interactionStore.getBySession(context.sessionId).filter(
			(record) => record.correlatedTurnId === requestId,
		);
	}

	const sessions = runtime.rawDb
		.prepare("SELECT session_id FROM sessions")
		.all() as Array<{ session_id: string }>;

	for (const session of sessions) {
		const records = interactionStore.getBySession(session.session_id).filter(
			(record) => record.correlatedTurnId === requestId,
		);
		if (records.length > 0) {
			return records;
		}
	}

	return [];
}

function getSettlementRecord(
	records: InteractionRecord[],
	params: Pick<InspectViewLoadParams, "unsafeRaw" | "mode">,
): InteractionRecord | undefined {
	const settlement = records.find((record) => record.recordType === "turn_settlement");
	if (!settlement) {
		return undefined;
	}

	const unsafeRawMode = resolveUnsafeRawMode(params, params.unsafeRaw ?? false);
	if (unsafeRawMode) {
		return settlement;
	}

	return redactInteractionRecord(settlement);
}

function extractPrivateCommitKinds(
	payload: SettlementPayloadLike | undefined,
): string[] {
	if (!payload?.privateCommit) {
		return [];
	}

	if (Array.isArray(payload.privateCommit.kinds)) {
		return [...payload.privateCommit.kinds];
	}

	if (!Array.isArray(payload.privateCommit.ops)) {
		return [];
	}

	const kinds: string[] = [];
	for (const op of payload.privateCommit.ops) {
		const kind = op.op === "upsert" ? op.record.kind : op.target.kind;
		if (!kinds.includes(kind)) {
			kinds.push(kind);
		}
	}

	return kinds;
}

function extractPrivateCommitCount(payload: SettlementPayloadLike | undefined): number {
	if (!payload?.privateCommit) {
		return 0;
	}

	if (typeof payload.privateCommit.opCount === "number") {
		return payload.privateCommit.opCount;
	}

	if (Array.isArray(payload.privateCommit.ops)) {
		return payload.privateCommit.ops.length;
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
	params: Pick<InspectViewLoadParams, "mode" | "unsafeRaw">,
	requested: boolean,
): boolean {
	if (!requested) {
		return false;
	}

	if (params.mode === "gateway") {
		throw new Error("INSPECT_UNSAFE_RAW_LOCAL_ONLY");
	}

	return true;
}

function getInteractionStore(runtime: RuntimeBootstrapResult): InteractionStore {
	return new InteractionStore(runtime.db);
}

type SettlementPayloadLike = {
	settlementId: string;
	requestId: string;
	sessionId: string;
	ownerAgentId?: string;
	publicReply: string;
	hasPublicReply: boolean;
	privateCommit?: {
		ops?: Array<{ op: "upsert"; record: { kind: string } } | { op: "retract"; target: { kind: string } }>;
		opCount?: number;
		kinds?: string[];
	};
};
