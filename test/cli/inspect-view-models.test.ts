import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceStore } from "../../src/app/diagnostics/trace-store.js";
import type { RuntimeBootstrapResult } from "../../src/bootstrap/types.js";
import { diagnose } from "../../src/app/diagnostics/diagnose-service.js";
import {
	loadSummaryView,
	loadTranscriptView,
} from "../../src/app/inspect/view-models.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import type { TurnSettlementPayload } from "../../src/interaction/contracts.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { runSessionMigrations } from "../../src/session/migrations.js";
import { SessionService } from "../../src/session/service.js";
import { closeDatabaseGracefully, openDatabase, type Db } from "../../src/storage/database.js";

describe("inspect view models", () => {
	let db: Db;
	let interactionStore: InteractionStore;
	let commitService: CommitService;
	let sessionService: SessionService;
	let traceDir: string;
	let traceStore: TraceStore;

	beforeEach(() => {
		db = openDatabase({ path: ":memory:" });
		runInteractionMigrations(db);
		runMemoryMigrations(db);
		runSessionMigrations(db);
		interactionStore = new InteractionStore(db);
		commitService = new CommitService(interactionStore);
		sessionService = new SessionService(db);
		traceDir = mkdtempSync(join(tmpdir(), "maidsclaw-inspect-"));
		traceStore = new TraceStore(traceDir);
	});

	afterEach(() => {
		closeDatabaseGracefully(db);
		rmSync(traceDir, { recursive: true, force: true });
	});

	it("loadSummaryView returns required fields", () => {
		const session = sessionService.createSession("rp:alice");
		const requestId = "req-summary";
		commitService.commit({
			sessionId: session.sessionId,
			actorType: "user",
			recordType: "message",
			payload: { role: "user", content: "hello" },
			correlatedTurnId: requestId,
		});
		const settlementPayload = makeSettlementPayload(session.sessionId, requestId, true);
		commitService.commitWithId({
			sessionId: session.sessionId,
			actorType: "rp_agent",
			recordType: "turn_settlement",
			recordId: settlementPayload.settlementId,
			payload: settlementPayload,
			correlatedTurnId: requestId,
		});
		traceStore.initTrace(requestId, session.sessionId, "rp:alice");
		traceStore.addFlushResult(requestId, { requested: true, result: "succeeded" });
		traceStore.finalizeTrace(requestId);

		const view = loadSummaryView({
			runtime: makeRuntime(db, sessionService, traceStore),
			traceStore,
			context: { requestId, sessionId: session.sessionId, agentId: "rp:alice" },
		});

		expect(view.request_id).toBe(requestId);
		expect(view.session_id).toBe(session.sessionId);
		expect(typeof view.has_public_reply).toBe("boolean");
		expect(typeof view.private_cognition_count).toBe("number");
		expect(typeof view.memory_flush.requested).toBe("boolean");
		expect(typeof view.pending_sweep_state).toBe("object");
	});

	it("loadTranscriptView redacts settlement by default", () => {
		const session = sessionService.createSession("rp:alice");
		const requestId = "req-redacted";
		const settlementPayload = makeSettlementPayload(session.sessionId, requestId, true);
		commitService.commitWithId({
			sessionId: session.sessionId,
			actorType: "rp_agent",
			recordType: "turn_settlement",
			recordId: settlementPayload.settlementId,
			payload: settlementPayload,
			correlatedTurnId: requestId,
		});

		const view = loadTranscriptView({
			runtime: makeRuntime(db, sessionService, traceStore),
			context: { sessionId: session.sessionId },
		});

		const settlement = view.entries.find((entry) => entry.record_type === "turn_settlement");
		expect(settlement).toBeDefined();
		const payload = settlement?.payload as {
			viewerSnapshot?: { redacted?: boolean };
			privateCognition?: { redacted?: boolean };
		};
		expect(payload.viewerSnapshot?.redacted).toBe(true);
		expect(payload.privateCognition?.redacted).toBe(true);
	});

	it("raw mode shows tool/status records", () => {
		const session = sessionService.createSession("rp:alice");
		const requestId = "req-raw";
		commitService.commit({
			sessionId: session.sessionId,
			actorType: "rp_agent",
			recordType: "tool_call",
			payload: { toolName: "memory_read", arguments: { key: "x" } },
			correlatedTurnId: requestId,
		});
		commitService.commit({
			sessionId: session.sessionId,
			actorType: "system",
			recordType: "status",
			payload: { event: "turn_failure", details: { error_code: "TEST" } },
			correlatedTurnId: requestId,
		});

		const view = loadTranscriptView({
			runtime: makeRuntime(db, sessionService, traceStore),
			context: { sessionId: session.sessionId },
			raw: true,
		});

		expect(view.entries.some((entry) => entry.record_type === "tool_call")).toBe(true);
		expect(view.entries.some((entry) => entry.record_type === "status")).toBe(true);
	});

	it("diagnose returns concrete subsystem and next_commands", () => {
		const session = sessionService.createSession("rp:alice");
		const requestId = "req-diagnose";
		const settlementPayload = makeSettlementPayload(session.sessionId, requestId, false);
		commitService.commitWithId({
			sessionId: session.sessionId,
			actorType: "rp_agent",
			recordType: "turn_settlement",
			recordId: settlementPayload.settlementId,
			payload: settlementPayload,
			correlatedTurnId: requestId,
		});
		db.run(
			`INSERT INTO _memory_maintenance_jobs (job_type, status, idempotency_key, payload, created_at, updated_at, next_attempt_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				"pending_settlement_flush",
				"retry_scheduled",
				`pending_flush:${session.sessionId}`,
				JSON.stringify({
					failureCount: 2,
					lastErrorCode: "COGNITION_UNRESOLVED_REFS",
					lastErrorMessage: "unresolved refs",
				}),
				Date.now(),
				Date.now(),
				Date.now() + 1000,
			],
		);

		const entry = diagnose({
			runtime: makeRuntime(db, sessionService, traceStore),
			traceStore,
			context: { requestId, sessionId: session.sessionId },
		});

		expect(entry.subsystem).toBe("pending_settlement");
		expect(entry.next_commands.length > 0).toBe(true);
	});
});

function makeRuntime(
	db: Db,
	sessionService: SessionService,
	traceStore: TraceStore,
): RuntimeBootstrapResult {
	return {
		db,
		rawDb: db.raw,
		sessionService,
		memoryPipelineReady: true,
		memoryPipelineStatus: "ready",
		traceStore,
	} as unknown as RuntimeBootstrapResult;
}

function makeSettlementPayload(
	sessionId: string,
	requestId: string,
	hasPublicReply: boolean,
): TurnSettlementPayload {
	return {
		settlementId: `stl:${requestId}`,
		requestId,
		sessionId,
		ownerAgentId: "rp:alice",
		publicReply: hasPublicReply ? "hello" : "",
		hasPublicReply,
		viewerSnapshot: {
			selfPointerKey: "__self__",
			userPointerKey: "__user__",
		},
		privateCognition: {
			schemaVersion: "rp_private_cognition_v4",
			ops: [{ op: "retract", target: { kind: "assertion", key: "k1" } }],
		} as unknown as TurnSettlementPayload["privateCognition"],
	};
}
