import type { RuntimeBootstrapResult } from "../../bootstrap/types.js";
import type {
	InteractionRecord,
	TurnSettlementPayload,
} from "../../interaction/contracts.js";
import { redactInteractionRecord } from "../../interaction/redaction.js";
import { normalizeSettlementPayload } from "../../interaction/settlement-adapter.js";
import type { InteractionRepo } from "../../storage/domain-repos/contracts/interaction-repo.js";
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

export async function getRecordsForRequest(
	runtime: RuntimeBootstrapResult,
	context: InspectContext,
	requestId: string,
): Promise<InteractionRecord[]> {
	return (await getRequestEvidence({ runtime, context, requestId })).records;
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

export async function getRequestEvidence(params: {
	runtime: RuntimeBootstrapResult;
	context: InspectContext;
	requestId: string;
	traceStore?: TraceStore;
}): Promise<RequestEvidence> {
	const trace = getTraceBundle(
		params.runtime,
		params.requestId,
		params.traceStore,
	);
	const interactionRepo = getInteractionRepo(params.runtime);
	const context = await completeContext(
		params.context,
		params.requestId,
		interactionRepo,
		trace,
	);

	const records = context.sessionId
		? (await interactionRepo
				.getBySession(context.sessionId))
				.filter((record: InteractionRecord) => record.correlatedTurnId === params.requestId)
		: [];

	const settlementPayloadRaw = context.sessionId
		? await interactionRepo.getSettlementPayload(context.sessionId, params.requestId)
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

async function completeContext(
	context: InspectContext,
	requestId: string,
	interactionRepo: InteractionRepo,
	trace: TraceBundle | null,
): Promise<InspectContext> {
	const sessionId = await resolveSessionId(
		context,
		requestId,
		interactionRepo,
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

async function resolveSessionId(
	context: InspectContext,
	requestId: string,
	interactionRepo: InteractionRepo,
	trace: TraceBundle | null,
): Promise<string | undefined> {
	const requestedSession = normalize(context.sessionId);
	if (
		requestedSession &&
		await hasRequestInSession(interactionRepo, requestedSession, requestId)
	) {
		return requestedSession;
	}

	const sessionFromRequest =
		await interactionRepo.findSessionIdByRequestId(requestId);
	if (sessionFromRequest) {
		return sessionFromRequest;
	}

	const sessionFromTrace = normalize(trace?.session_id);
	if (
		sessionFromTrace &&
		await hasRequestInSession(interactionRepo, sessionFromTrace, requestId)
	) {
		return sessionFromTrace;
	}

	return requestedSession ?? sessionFromTrace;
}

async function hasRequestInSession(
	interactionRepo: InteractionRepo,
	sessionId: string,
	requestId: string,
): Promise<boolean> {
	return (await interactionRepo
		.getBySession(sessionId))
		.some((record: InteractionRecord) => record.correlatedTurnId === requestId);
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

function getInteractionRepo(
	runtime: RuntimeBootstrapResult,
): InteractionRepo {
	return runtime.interactionRepo;
}
