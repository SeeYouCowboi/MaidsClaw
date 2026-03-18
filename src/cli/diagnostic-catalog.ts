import type { RuntimeBootstrapResult } from "../bootstrap/types.js";
import type { InteractionRecord, TurnSettlementPayload } from "../interaction/contracts.js";
import { InteractionStore } from "../interaction/store.js";
import type { TraceStore } from "./trace-store.js";
import type { InspectContext } from "./inspect/context-resolver.js";

export type DiagnosticEntry = {
	primary_cause: string;
	subsystem:
		| "configuration"
		| "bootstrap"
		| "rp_turn_contract"
		| "interaction_log"
		| "turn_settlement"
		| "gateway"
		| "prompt"
		| "model_call"
		| "tool_execution"
		| "session_recovery"
		| "pending_settlement"
		| "memory_pipeline";
	locator?: string;
	evidence: string[];
	likely_source_files: string[];
	next_commands: string[];
};

export function diagnose(params: {
	runtime: RuntimeBootstrapResult;
	traceStore?: TraceStore;
	context: InspectContext;
}): DiagnosticEntry {
	if (!params.context.requestId) {
		return {
			primary_cause: "missing_request_id",
			subsystem: "configuration",
			locator: "--request",
			evidence: ["request_id is required for request-scoped diagnose"],
			likely_source_files: ["src/cli/inspect/context-resolver.ts"],
			next_commands: [
				"maidsclaw debug diagnose --request <request_id>",
				"maidsclaw debug summary --request <request_id>",
			],
		};
	}

	const requestId = params.context.requestId;
	const interactionStore = new InteractionStore(params.runtime.db);
	const records = getRecordsForRequest(interactionStore, params.runtime, params.context, requestId);
	const settlementPayload = getSettlementPayload(records);
	const sessionId = settlementPayload?.sessionId ?? params.context.sessionId;
	const trace = (params.traceStore ?? params.runtime.traceStore)?.readTrace(requestId) ?? null;

	if (!params.runtime.memoryPipelineReady) {
		return {
			primary_cause: params.runtime.memoryPipelineStatus,
			subsystem: "memory_pipeline",
			locator: "runtime.memoryPipelineStatus",
			evidence: [
				`memory_pipeline_ready=${String(params.runtime.memoryPipelineReady)}`,
				`memory_pipeline_status=${params.runtime.memoryPipelineStatus}`,
			],
			likely_source_files: [
				"src/bootstrap/runtime.ts",
				"config/runtime.json",
			],
			next_commands: [
				"maidsclaw config doctor --json",
				"maidsclaw config show memory --json",
			],
		};
	}

	if (sessionId) {
		const pending = interactionStore.getPendingSettlementJobState(sessionId);
		if (pending?.last_error_code === "COGNITION_UNRESOLVED_REFS") {
			return {
				primary_cause: "unresolved_explicit_cognition_refs",
				subsystem: "pending_settlement",
				locator: `_memory_maintenance_jobs: pending_flush:${sessionId}`,
				evidence: [
					`job.status=${pending.status ?? "unknown"}`,
					`job.last_error_code=${pending.last_error_code}`,
					`job.failure_count=${String(pending.failure_count ?? 0)}`,
				],
				likely_source_files: [
					"src/memory/pending-settlement-sweeper.ts",
					"src/memory/cognition-op-committer.ts",
				],
				next_commands: [
					`maidsclaw debug memory --session ${sessionId} --json`,
					`maidsclaw debug transcript --session ${sessionId} --raw --json`,
				],
			};
		}

		if (params.runtime.sessionService.requiresRecovery(sessionId)) {
			return {
				primary_cause: "session_recovery_required",
				subsystem: "session_recovery",
				locator: `session:${sessionId}`,
				evidence: ["sessionService.requiresRecovery=true"],
				likely_source_files: [
					"src/runtime/turn-service.ts",
					"src/session/service.ts",
				],
				next_commands: [
					`maidsclaw session recover ${sessionId} --json`,
					`maidsclaw debug transcript --session ${sessionId} --raw --json`,
				],
			};
		}
	}

	const statusError = records
		.filter((record) => record.recordType === "status")
		.map((record) => parseStatusCode(record.payload))
		.find((code) => code !== undefined);
	if (statusError) {
		const mapped = mapCodeToSubsystem(statusError);
		return {
			primary_cause: statusError,
			subsystem: mapped.subsystem,
			locator: `request:${requestId}`,
			evidence: [`status.error_code=${statusError}`],
			likely_source_files: mapped.files,
			next_commands: mapped.commands(requestId, sessionId),
		};
	}

	const traceError = trace?.log_entries.find((entry) => entry.level === "error");
	if (traceError) {
		const mapped = mapTraceMessage(traceError.message);
		return {
			primary_cause: traceError.message,
			subsystem: mapped.subsystem,
			locator: `trace:${requestId}`,
			evidence: [traceError.message],
			likely_source_files: mapped.files,
			next_commands: mapped.commands(requestId, sessionId),
		};
	}

	return {
		primary_cause: "no_actionable_error_found",
		subsystem: "interaction_log",
		locator: `request:${requestId}`,
		evidence: [
			`records=${records.length}`,
			`trace_entries=${trace?.log_entries.length ?? 0}`,
		],
		likely_source_files: ["src/interaction/store.ts", "src/runtime/turn-service.ts"],
		next_commands: [
			`maidsclaw debug summary --request ${requestId} --json`,
			`maidsclaw debug logs --request ${requestId} --json`,
		],
	};
}

function getRecordsForRequest(
	interactionStore: InteractionStore,
	runtime: RuntimeBootstrapResult,
	context: InspectContext,
	requestId: string,
): InteractionRecord[] {
	if (context.sessionId) {
		return interactionStore
			.getBySession(context.sessionId)
			.filter((record) => record.correlatedTurnId === requestId);
	}

	const sessions = runtime.rawDb
		.prepare("SELECT session_id FROM sessions")
		.all() as Array<{ session_id: string }>;

	for (const session of sessions) {
		const records = interactionStore
			.getBySession(session.session_id)
			.filter((record) => record.correlatedTurnId === requestId);
		if (records.length > 0) {
			return records;
		}
	}

	return [];
}

function getSettlementPayload(
	records: InteractionRecord[],
): TurnSettlementPayload | undefined {
	const settlement = records.find((record) => record.recordType === "turn_settlement");
	if (!settlement || typeof settlement.payload !== "object" || settlement.payload === null) {
		return undefined;
	}

	return settlement.payload as TurnSettlementPayload;
}

function parseStatusCode(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") {
		return undefined;
	}

	const maybeStatus = payload as {
		event?: unknown;
		details?: { error_code?: unknown };
	};

	if (maybeStatus.event !== "turn_failure") {
		return undefined;
	}

	return typeof maybeStatus.details?.error_code === "string"
		? maybeStatus.details.error_code
		: undefined;
}

function mapCodeToSubsystem(code: string): {
	subsystem: DiagnosticEntry["subsystem"];
	files: string[];
	commands: (requestId: string, sessionId?: string) => string[];
} {
	if (code === "TURN_SETTLEMENT_FAILED") {
		return {
			subsystem: "turn_settlement",
			files: ["src/runtime/turn-service.ts", "src/interaction/commit-service.ts"],
			commands: (requestId) => [
				`maidsclaw debug trace export --request ${requestId} --out trace-${requestId}.json`,
				`maidsclaw debug logs --request ${requestId} --json`,
			],
		};
	}

	if (code === "RP_BUFFERED_EXECUTION_FAILED" || code === "RP_EMPTY_TURN") {
		return {
			subsystem: "rp_turn_contract",
			files: ["src/core/agent-loop.ts", "src/runtime/turn-service.ts"],
			commands: (requestId, sessionId) => [
				`maidsclaw debug summary --request ${requestId} --json`,
				...(sessionId
					? [`maidsclaw debug transcript --session ${sessionId} --raw --json`]
					: []),
			],
		};
	}

	if (code.includes("TOOL") || code.includes("MCP")) {
		return {
			subsystem: "tool_execution",
			files: ["src/core/agent-loop.ts", "src/core/tools/tool-executor.ts"],
			commands: (requestId) => [
				`maidsclaw debug logs --request ${requestId} --json`,
				`maidsclaw debug chunks --request ${requestId} --json`,
			],
		};
	}

	if (code.includes("PROMPT")) {
		return {
			subsystem: "prompt",
			files: ["src/core/prompt-builder.ts", "src/core/prompt-renderer.ts"],
			commands: (requestId) => [
				`maidsclaw debug prompt --request ${requestId} --json`,
				`maidsclaw debug logs --request ${requestId} --json`,
			],
		};
	}

	if (code.includes("MODEL")) {
		return {
			subsystem: "model_call",
			files: ["src/core/models/registry.ts", "src/core/agent-loop.ts"],
			commands: (requestId) => [
				`maidsclaw debug logs --request ${requestId} --json`,
				"maidsclaw health --json",
			],
		};
	}

	return {
		subsystem: "interaction_log",
		files: ["src/interaction/store.ts", "src/runtime/turn-service.ts"],
		commands: (requestId) => [
			`maidsclaw debug summary --request ${requestId} --json`,
			`maidsclaw debug logs --request ${requestId} --json`,
		],
	};
}

function mapTraceMessage(message: string): {
	subsystem: DiagnosticEntry["subsystem"];
	files: string[];
	commands: (requestId: string, sessionId?: string) => string[];
} {
	const lower = message.toLowerCase();
	if (lower.includes("tool")) {
		return {
			subsystem: "tool_execution",
			files: ["src/core/agent-loop.ts", "src/core/tools/tool-executor.ts"],
			commands: (requestId) => [
				`maidsclaw debug logs --request ${requestId} --json`,
				`maidsclaw debug chunks --request ${requestId} --json`,
			],
		};
	}

	if (lower.includes("prompt")) {
		return {
			subsystem: "prompt",
			files: ["src/core/prompt-builder.ts", "src/core/prompt-renderer.ts"],
			commands: (requestId) => [
				`maidsclaw debug prompt --request ${requestId} --json`,
				`maidsclaw debug logs --request ${requestId} --json`,
			],
		};
	}

	if (lower.includes("model") || lower.includes("provider")) {
		return {
			subsystem: "model_call",
			files: ["src/core/models/registry.ts", "src/core/agent-loop.ts"],
			commands: (requestId) => [
				`maidsclaw debug logs --request ${requestId} --json`,
				"maidsclaw health --json",
			],
		};
	}

	if (lower.includes("gateway") || lower.includes("sse")) {
		return {
			subsystem: "gateway",
			files: ["src/gateway/controllers.ts", "src/gateway/sse.ts"],
			commands: (requestId) => [
				`maidsclaw debug logs --request ${requestId} --json`,
				"maidsclaw health --json",
			],
		};
	}

	return {
		subsystem: "interaction_log",
		files: ["src/runtime/turn-service.ts", "src/interaction/store.ts"],
		commands: (requestId, sessionId) => [
			`maidsclaw debug logs --request ${requestId} --json`,
			...(sessionId
				? [`maidsclaw debug transcript --session ${sessionId} --raw --json`]
				: []),
		],
	};
}
