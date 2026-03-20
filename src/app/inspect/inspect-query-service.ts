import type { RuntimeBootstrapResult } from "../../bootstrap/types.js";
import type {
	InteractionRecord,
	TurnSettlementPayload,
} from "../../interaction/contracts.js";
import { redactInteractionRecord } from "../../interaction/redaction.js";
import { normalizeSettlementPayload } from "../../interaction/settlement-adapter.js";
import { InteractionStore } from "../../interaction/store.js";
import type { InspectContext } from "../contracts/inspect.js";
import type { TraceBundle } from "../contracts/trace.js";
import type { TraceStore } from "../diagnostics/trace-store.js";

export type InspectAccessMode = "local" | "gateway";

export type RequestEvidence = {
	requestId: string;
	context: InspectContext;
	records: InteractionRecord[];
	settlementPayload?: TurnSettlementPayload;
	trace: TraceBundle | null;
};

export function getRecordsForRequest(
	runtime: RuntimeBootstrapResult,
	context: InspectContext,
	requestId: string,
): InteractionRecord[] {
	return getRequestEvidence({ runtime, context, requestId }).records;
}

export function getSettlementRecord(
	records: InteractionRecord[],
	params: { unsafeRaw?: boolean; mode?: InspectAccessMode },
): InteractionRecord | undefined {
	const settlement = records.find(
		(record) => record.recordType === "turn_settlement",
	);
	if (!settlement) {
		return undefined;
	}

	const unsafeRawMode = resolveUnsafeRawMode(
		params.mode,
		params.unsafeRaw ?? false,
	);
	if (unsafeRawMode) {
		return {
			...settlement,
			payload: normalizeSettlementPayload(
				settlement.payload as TurnSettlementPayload,
			),
		};
	}

	return redactInteractionRecord(settlement);
}

export function getRequestEvidence(params: {
	runtime: RuntimeBootstrapResult;
	context: InspectContext;
	requestId: string;
	traceStore?: TraceStore;
}): RequestEvidence {
	const trace = getTraceBundle(
		params.runtime,
		params.requestId,
		params.traceStore,
	);
	const interactionStore = getInteractionStore(params.runtime);
	const context = completeContext(
		params.context,
		params.requestId,
		interactionStore,
		trace,
	);

	const records = context.sessionId
		? interactionStore
				.getBySession(context.sessionId)
				.filter((record) => record.correlatedTurnId === params.requestId)
		: [];

	const settlementPayloadRaw = context.sessionId
		? interactionStore.getSettlementPayload(context.sessionId, params.requestId)
		: undefined;
	const settlementPayload = settlementPayloadRaw
		? normalizeSettlementPayload(settlementPayloadRaw)
		: undefined;

	return {
		requestId: params.requestId,
		context,
		records,
		...(settlementPayload ? { settlementPayload } : {}),
		trace,
	};
}

function completeContext(
	context: InspectContext,
	requestId: string,
	interactionStore: InteractionStore,
	trace: TraceBundle | null,
): InspectContext {
	const sessionId = resolveSessionId(
		context,
		requestId,
		interactionStore,
		trace,
	);
	return {
		...(context.requestId ? { requestId: context.requestId } : {}),
		...(sessionId ? { sessionId } : {}),
		...(context.agentId
			? { agentId: context.agentId }
			: trace?.agent_id
				? { agentId: trace.agent_id }
				: {}),
	};
}

function resolveSessionId(
	context: InspectContext,
	requestId: string,
	interactionStore: InteractionStore,
	trace: TraceBundle | null,
): string | undefined {
	const requestedSession = normalize(context.sessionId);
	if (
		requestedSession &&
		hasRequestInSession(interactionStore, requestedSession, requestId)
	) {
		return requestedSession;
	}

	const sessionFromRequest =
		interactionStore.findSessionIdByRequestId(requestId);
	if (sessionFromRequest) {
		return sessionFromRequest;
	}

	const sessionFromTrace = normalize(trace?.session_id);
	if (
		sessionFromTrace &&
		hasRequestInSession(interactionStore, sessionFromTrace, requestId)
	) {
		return sessionFromTrace;
	}

	return requestedSession ?? sessionFromTrace;
}

function hasRequestInSession(
	interactionStore: InteractionStore,
	sessionId: string,
	requestId: string,
): boolean {
	return interactionStore
		.getBySession(sessionId)
		.some((record) => record.correlatedTurnId === requestId);
}

function getTraceBundle(
	runtime: RuntimeBootstrapResult,
	requestId: string,
	traceStore?: TraceStore,
): TraceBundle | null {
	const store = traceStore ?? runtime.traceStore;
	if (!store) {
		return null;
	}
	return store.readTrace(requestId);
}

function normalize(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
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

function getInteractionStore(
	runtime: RuntimeBootstrapResult,
): InteractionStore {
	return new InteractionStore(runtime.db);
}
