import type { Chunk } from "../../../core/chunk.js";
import type { TurnSettlementPayload } from "../../../interaction/contracts.js";
import { normalizeSettlementPayload } from "../../../interaction/settlement-adapter.js";
import type { InteractionStore } from "../../../interaction/store.js";
import type { SessionService } from "../../../session/service.js";
import type {
	ObservationEvent,
	TurnExecutionResult,
} from "../../contracts/execution.js";
import type { PrivateCommitSummary } from "../../contracts/inspect.js";
import { TraceStore } from "../../diagnostics/trace-store.js";
import {
	type ExecuteUserTurnDeps,
	executeUserTurn,
} from "../../turn/user-turn-service.js";
import type { TurnClient, TurnRequest } from "../turn-client.js";

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

export class LocalTurnClient implements TurnClient {
	constructor(private readonly deps: LocalTurnDeps) {}

	async *streamTurn(params: TurnRequest): AsyncIterable<ObservationEvent> {
		const perTurnTraceStore = params.saveTrace
			? (this.deps.traceStore ?? new TraceStore())
			: undefined;

		const stream = executeUserTurn(
			{
				sessionId: params.sessionId,
				agentId: params.agentId,
				userText: params.text,
				requestId: params.requestId,
				metadata: {
					traceStore: perTurnTraceStore,
				},
			},
			{
				sessionService: this.deps.sessionService,
				turnService: this.deps.turnService,
			},
		);

		for await (const chunk of stream) {
			const normalized = normalizeChunk(chunk, Date.now());
			if (normalized !== null) {
				yield normalized;
			}
		}
	}
}

// ── Entry point ──────────────────────────────────────────────────────

export async function executeLocalTurn(
	params: LocalTurnParams,
	deps: LocalTurnDeps,
): Promise<TurnExecutionResult> {
	const requestId = crypto.randomUUID();
	const turnClient = new LocalTurnClient(deps);

	let assistantText = "";
	const publicChunks: ObservationEvent[] = [];
	const toolEvents: ObservationEvent[] = [];

	for await (const event of turnClient.streamTurn({
		sessionId: params.sessionId,
		agentId: params.agentId,
		text: params.text,
		requestId,
		saveTrace: params.saveTrace,
	})) {
		if (event.type === "text_delta") {
			assistantText += event.text;
		}
		publicChunks.push(event);
		if (isToolEvent(event)) {
			toolEvents.push(event);
		}
	}

	const settlementPayloadRaw = deps.interactionStore.getSettlementPayload(
		params.sessionId,
		requestId,
	);
	const settlementPayload = settlementPayloadRaw
		? normalizeSettlementPayload(settlementPayloadRaw)
		: undefined;

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
		event.type === "tool_use_start" ||
		event.type === "tool_use_delta" ||
		event.type === "tool_use_end" ||
		event.type === "tool_execution_result"
	);
}

function normalizeChunk(
	chunk: Chunk,
	timestamp: number,
): ObservationEvent | null {
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
			op.op === "upsert"
				? op.record.kind
				: op.op === "retract"
					? op.target.kind
					: undefined;
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
