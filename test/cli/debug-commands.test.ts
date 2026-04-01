import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createAppHost } from "../../src/app/host/create-app-host.js";
import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";
import { registerDebugCommands } from "../../src/terminal-cli/commands/debug.js";
import { dispatch, resetCommands } from "../../src/terminal-cli/parser.js";
import { TraceStore } from "../../src/app/diagnostics/trace-store.js";
import type { JsonEnvelope } from "../../src/terminal-cli/types.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import type { TurnSettlementPayload } from "../../src/interaction/contracts.js";
import { InteractionStore } from "../../src/interaction/store.js";

const tempRoots: string[] = [];
let savedAnthropicKey: string | undefined;
let savedOpenAIKey: string | undefined;
let _savedBackend: string | undefined;

function createTempDir(): string {
	const tempRoot = join(
		import.meta.dir,
		`../../.tmp-debug-cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	mkdirSync(tempRoot, { recursive: true });
	tempRoots.push(tempRoot);
	return tempRoot;
}

function cleanupTempDirs(): void {
	for (const tempRoot of tempRoots.splice(0, tempRoots.length)) {
		try {
			rmSync(tempRoot, { recursive: true, force: true });
		} catch {}
	}
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = (chunk: string | Uint8Array): boolean => {
		chunks.push(
			typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
		);
		return true;
	};
	try {
		await fn();
	} finally {
		process.stdout.write = originalWrite;
	}
	return chunks.join("");
}

function parseJsonOutput(raw: string): JsonEnvelope {
	const line = raw.trim().split("\n")[0];
	if (!line) {
		throw new Error("Expected JSON output line");
	}
	return JSON.parse(line) as JsonEnvelope;
}

describe("debug commands", () => {
	beforeEach(() => {
		resetCommands();
		registerDebugCommands();
		savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
		savedOpenAIKey = process.env.OPENAI_API_KEY;
		_savedBackend = process.env.MAIDSCLAW_BACKEND;
		process.env.MAIDSCLAW_BACKEND = "sqlite";
		process.env.OPENAI_API_KEY = "sk-openai-test";
		delete process.env.ANTHROPIC_API_KEY;
	});

	afterEach(() => {
		cleanupTempDirs();
		if (_savedBackend === undefined) delete process.env.MAIDSCLAW_BACKEND;
		else process.env.MAIDSCLAW_BACKEND = _savedBackend;
		if (savedOpenAIKey !== undefined) {
			process.env.OPENAI_API_KEY = savedOpenAIKey;
		} else {
			delete process.env.OPENAI_API_KEY;
		}
		if (savedAnthropicKey !== undefined) {
			process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
		} else {
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	it("debug diagnose returns concrete subsystem classification", async () => {
		const tmpRoot = createTempDir();
		const requestId = "req-diag-1";

		await seedPendingSettlementCase(tmpRoot, requestId);

		const raw = await captureStdout(async () => {
			await dispatch([
				"--json",
				"--cwd",
				tmpRoot,
				"debug",
				"diagnose",
				"--request",
				requestId,
			]);
		});

		const envelope = parseJsonOutput(raw);
		const data = envelope.data as {
			subsystem: string;
			next_commands: string[];
			locator?: string;
		};
		const allowedSubsystems = new Set([
			"configuration",
			"bootstrap",
			"rp_turn_contract",
			"interaction_log",
			"turn_settlement",
			"gateway",
			"prompt",
			"model_call",
			"tool_execution",
			"session_recovery",
			"pending_settlement",
			"memory_pipeline",
		]);

		expect(envelope.ok).toBe(true);
		expect(allowedSubsystems.has(data.subsystem)).toBe(true);
		expect(typeof data.locator).toBe("string");
		expect(data.next_commands.length > 0).toBe(true);
		expect(data.next_commands.every((value) => value.includes("maidsclaw "))).toBe(
			true,
		);
	});

	it("debug trace export is redacted by default", async () => {
		const tmpRoot = createTempDir();
		const requestId = "req-trace-redacted";
		await seedTraceCase(tmpRoot, requestId);

		const raw = await captureStdout(async () => {
			await dispatch([
				"--json",
				"--cwd",
				tmpRoot,
				"debug",
				"trace",
				"export",
				"--request",
				requestId,
			]);
		});

		const envelope = parseJsonOutput(raw);
		const data = envelope.data as {
			interaction_settlement?: {
				privateCognition?: { redacted?: boolean; ops?: unknown[] };
			};
		};

		expect(envelope.ok).toBe(true);
		expect(data.interaction_settlement?.privateCognition?.redacted).toBe(true);
		expect(data.interaction_settlement?.privateCognition?.ops).toBeUndefined();
	});

	it("debug trace export --unsafe-raw includes settlement payload", async () => {
		const tmpRoot = createTempDir();
		const requestId = "req-trace-raw";
		await seedTraceCase(tmpRoot, requestId);

		const raw = await captureStdout(async () => {
			await dispatch([
				"--json",
				"--cwd",
				tmpRoot,
				"debug",
				"trace",
				"export",
				"--request",
				requestId,
				"--unsafe-raw",
			]);
		});

		const envelope = parseJsonOutput(raw);
		const data = envelope.data as {
			interaction_settlement?: {
				privateCognition?: { ops?: unknown[]; redacted?: boolean };
			};
		};

		expect(envelope.ok).toBe(true);
		expect(Array.isArray(data.interaction_settlement?.privateCognition?.ops)).toBe(
			true,
		);
		expect(
			data.interaction_settlement?.privateCognition?.redacted,
		).toBeUndefined();
	});

	it("debug memory includes pending sweeper state", async () => {
		const tmpRoot = createTempDir();
		const requestId = "req-memory-1";
		const sessionId = await seedPendingSettlementCase(tmpRoot, requestId);

		const raw = await captureStdout(async () => {
			await dispatch([
				"--json",
				"--cwd",
				tmpRoot,
				"debug",
				"memory",
				"--session",
				sessionId,
			]);
		});

		const envelope = parseJsonOutput(raw);
		const data = envelope.data as {
			pending_sweeper_state: {
				status?: string;
				last_error_code?: string | null;
			};
		};

		expect(envelope.ok).toBe(true);
		expect(data.pending_sweeper_state.status).toBe("retry_scheduled");
		expect(data.pending_sweeper_state.last_error_code).toBe(
			"COGNITION_UNRESOLVED_REFS",
		);
	});

	// ── T17: debug summary ────────────────────────────────────────

	it("debug summary returns required fields from view model", async () => {
		const tmpRoot = createTempDir();
		const requestId = "req-summary-1";
		const sessionId = await seedSummaryCase(tmpRoot, requestId);

		const raw = await captureStdout(async () => {
			await dispatch([
				"--json",
				"--cwd",
				tmpRoot,
				"debug",
				"summary",
				"--request",
				requestId,
			]);
		});

		const envelope = parseJsonOutput(raw);
		const data = envelope.data as {
			request_id: string;
			session_id?: string;
			agent_id?: string;
			has_public_reply: boolean;
			private_cognition_count: number;
			memory_flush: { requested: boolean };
			pending_sweep_state: Record<string, unknown>;
			trace_available: boolean;
			recovery_required: boolean;
		};

		expect(envelope.ok).toBe(true);
		expect(data.request_id).toBe(requestId);
		expect(data.session_id).toBe(sessionId);
		expect(typeof data.has_public_reply).toBe("boolean");
		expect(data.has_public_reply).toBe(true);
		expect(typeof data.private_cognition_count).toBe("number");
		expect(typeof data.memory_flush.requested).toBe("boolean");
		expect(data.trace_available).toBe(true);
		expect(typeof data.recovery_required).toBe("boolean");
	});

	// ── T17: debug transcript ─────────────────────────────────────

	it("debug transcript --raw shows tool records but NOT settlement payload", async () => {
		const tmpRoot = createTempDir();
		const requestId = "req-transcript-raw";
		const sessionId = await seedTranscriptCase(tmpRoot, requestId);

		// raw mode shows tool/status records
		const raw = await captureStdout(async () => {
			await dispatch([
				"--json",
				"--cwd",
				tmpRoot,
				"debug",
				"transcript",
				"--session",
				sessionId,
				"--raw",
			]);
		});

		const envelope = parseJsonOutput(raw);
		const data = envelope.data as {
			session_id: string;
			raw_observation_mode: boolean;
			unsafe_raw_settlement_mode: boolean;
			entries: Array<{
				record_type: string;
				payload?: {
					privateCognition?: { redacted?: boolean; ops?: unknown[] };
					viewerSnapshot?: { redacted?: boolean };
				};
			}>;
		};

		expect(envelope.ok).toBe(true);
		expect(data.raw_observation_mode).toBe(true);
		expect(data.unsafe_raw_settlement_mode).toBe(false);

		// tool/status records visible in raw mode
		expect(data.entries.some((e) => e.record_type === "tool_call")).toBe(true);
		expect(data.entries.some((e) => e.record_type === "status")).toBe(true);

		// settlement present but payload is redacted (not raw settlement)
		const settlement = data.entries.find(
			(e) => e.record_type === "turn_settlement",
		);
		expect(settlement).toBeDefined();
		expect(settlement?.payload?.privateCognition?.redacted).toBe(true);
		expect(settlement?.payload?.privateCognition?.ops).toBeUndefined();
	});

	// ── T17: debug prompt ────────────────────────────────────────

	it("debug prompt --sections includes section breakdown", async () => {
		const tmpRoot = createTempDir();
		const requestId = "req-prompt-sect";
		await seedPromptCase(tmpRoot, requestId);

		const raw = await captureStdout(async () => {
			await dispatch([
				"--json",
				"--cwd",
				tmpRoot,
				"debug",
				"prompt",
				"--request",
				requestId,
				"--sections",
			]);
		});

		const envelope = parseJsonOutput(raw);
		const data = envelope.data as {
			request_id: string;
			conversation_messages: Array<{ role: string; content: string }>;
			sections?: Record<string, string>;
			recent_cognition?: string;
			rendered_system_prompt?: string;
		};

		expect(envelope.ok).toBe(true);
		expect(data.request_id).toBe(requestId);
		expect(data.conversation_messages.length).toBeGreaterThan(0);
		expect(data.sections).toBeDefined();
		expect(data.sections?.PERSONA).toContain("Alice");
		expect(data.sections?.RECENT_COGNITION).toContain("friendly");
	});

	it("debug prompt without --sections strips sections from JSON output", async () => {
		const tmpRoot = createTempDir();
		const requestId = "req-prompt-nosect";
		await seedPromptCase(tmpRoot, requestId);

		const raw = await captureStdout(async () => {
			await dispatch([
				"--json",
				"--cwd",
				tmpRoot,
				"debug",
				"prompt",
				"--request",
				requestId,
			]);
		});

		const envelope = parseJsonOutput(raw);
		const data = envelope.data as {
			request_id: string;
			sections?: Record<string, string>;
		};

		expect(envelope.ok).toBe(true);
		expect(data.request_id).toBe(requestId);
		// sections should be stripped when --sections not set
		expect(data.sections).toBeUndefined();
	});

	// ── T17: debug chunks ────────────────────────────────────────

	it("debug chunks preserves ordering", async () => {
		const tmpRoot = createTempDir();
		const requestId = "req-chunks-order";
		await seedChunksCase(tmpRoot, requestId);

		const raw = await captureStdout(async () => {
			await dispatch([
				"--json",
				"--cwd",
				tmpRoot,
				"debug",
				"chunks",
				"--request",
				requestId,
			]);
		});

		const envelope = parseJsonOutput(raw);
		const data = envelope.data as {
			request_id: string;
			public_only: boolean;
			chunks: Array<{
				index: number;
				type: string;
				preview?: string;
			}>;
		};

		expect(envelope.ok).toBe(true);
		expect(data.request_id).toBe(requestId);
		expect(data.public_only).toBe(true);
		expect(data.chunks.length).toBe(4);

		// Verify ordering preserved
		expect(data.chunks[0].index).toBe(0);
		expect(data.chunks[0].type).toBe("text_delta");
		expect(data.chunks[0].preview).toBe("Hello");

		expect(data.chunks[1].index).toBe(1);
		expect(data.chunks[1].type).toBe("tool_use_start");

		expect(data.chunks[2].index).toBe(2);
		expect(data.chunks[2].type).toBe("text_delta");
		expect(data.chunks[2].preview).toBe(" world");

		expect(data.chunks[3].index).toBe(3);
		expect(data.chunks[3].type).toBe("message_end");
	});

});

async function seedPendingSettlementCase(cwd: string, requestId: string): Promise<string> {
	const runtime = bootstrapRuntime({ cwd });
	const host = await createAppHost({ role: "local", cwd, requireAllProviders: false }, runtime);
	try {
		const session = await runtime.sessionService.createSession("rp:alice");
		const interactionStore = new InteractionStore(runtime.db);
		const commitService = new CommitService(interactionStore);
		const settlementPayload = makeSettlementPayload(
			session.sessionId,
			requestId,
			false,
		);
		commitService.commitWithId({
			sessionId: session.sessionId,
			actorType: "rp_agent",
			recordType: "turn_settlement",
			recordId: settlementPayload.settlementId,
			payload: settlementPayload,
			correlatedTurnId: requestId,
		});

		runtime.db.run(
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

		return session.sessionId;
	} finally {
		await host.shutdown();
	}
}

async function seedTraceCase(cwd: string, requestId: string): Promise<string> {
	const runtime = bootstrapRuntime({ cwd });
	const host = await createAppHost({ role: "local", cwd, requireAllProviders: false }, runtime);
	try {
		const session = await runtime.sessionService.createSession("rp:alice");
		const interactionStore = new InteractionStore(runtime.db);
		const commitService = new CommitService(interactionStore);
		const settlementPayload = makeSettlementPayload(
			session.sessionId,
			requestId,
			true,
		);
		commitService.commitWithId({
			sessionId: session.sessionId,
			actorType: "rp_agent",
			recordType: "turn_settlement",
			recordId: settlementPayload.settlementId,
			payload: settlementPayload,
			correlatedTurnId: requestId,
		});

		const tracesPath = join(cwd, "data", "debug", "traces");
		const traceStore = new TraceStore(tracesPath);
		traceStore.initTrace(requestId, session.sessionId, "rp:alice");
		traceStore.addLogEntry(requestId, {
			level: "info",
			message: "seeded-trace",
			timestamp: Date.now(),
		});
		traceStore.finalizeTrace(requestId);

		return session.sessionId;
	} finally {
		await host.shutdown();
	}
}

async function seedSummaryCase(cwd: string, requestId: string): Promise<string> {
	const runtime = bootstrapRuntime({ cwd });
	const host = await createAppHost({ role: "local", cwd, requireAllProviders: false }, runtime);
	try {
		const session = await runtime.sessionService.createSession("rp:alice");
		const interactionStore = new InteractionStore(runtime.db);
		const commitService = new CommitService(interactionStore);
		commitService.commit({
			sessionId: session.sessionId,
			actorType: "user",
			recordType: "message",
			payload: { role: "user", content: "hello" },
			correlatedTurnId: requestId,
		});
		const settlementPayload = makeSettlementPayload(
			session.sessionId,
			requestId,
			true,
		);
		commitService.commitWithId({
			sessionId: session.sessionId,
			actorType: "rp_agent",
			recordType: "turn_settlement",
			recordId: settlementPayload.settlementId,
			payload: settlementPayload,
			correlatedTurnId: requestId,
		});
		const tracesPath = join(cwd, "data", "debug", "traces");
		const traceStore = new TraceStore(tracesPath);
		traceStore.initTrace(requestId, session.sessionId, "rp:alice");
		traceStore.addFlushResult(requestId, { requested: true, result: "succeeded" });
		traceStore.finalizeTrace(requestId);
		return session.sessionId;
	} finally {
		await host.shutdown();
	}
}

async function seedTranscriptCase(cwd: string, requestId: string): Promise<string> {
	const runtime = bootstrapRuntime({ cwd });
	const host = await createAppHost({ role: "local", cwd, requireAllProviders: false }, runtime);
	try {
		const session = await runtime.sessionService.createSession("rp:alice");
		const interactionStore = new InteractionStore(runtime.db);
		const commitService = new CommitService(interactionStore);
		commitService.commit({
			sessionId: session.sessionId,
			actorType: "user",
			recordType: "message",
			payload: { role: "user", content: "hello" },
			correlatedTurnId: requestId,
		});
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
			payload: { event: "turn_started" },
			correlatedTurnId: requestId,
		});
		const settlementPayload = makeSettlementPayload(
			session.sessionId,
			requestId,
			true,
		);
		commitService.commitWithId({
			sessionId: session.sessionId,
			actorType: "rp_agent",
			recordType: "turn_settlement",
			recordId: settlementPayload.settlementId,
			payload: settlementPayload,
			correlatedTurnId: requestId,
		});
		return session.sessionId;
	} finally {
		await host.shutdown();
	}
}

async function seedPromptCase(cwd: string, requestId: string): Promise<string> {
	const runtime = bootstrapRuntime({ cwd });
	const host = await createAppHost({ role: "local", cwd, requireAllProviders: false }, runtime);
	try {
		const session = await runtime.sessionService.createSession("rp:alice");
		const interactionStore = new InteractionStore(runtime.db);
		const commitService = new CommitService(interactionStore);
		commitService.commit({
			sessionId: session.sessionId,
			actorType: "user",
			recordType: "message",
			payload: { role: "user", content: "hello" },
			correlatedTurnId: requestId,
		});
		const tracesPath = join(cwd, "data", "debug", "traces");
		const traceStore = new TraceStore(tracesPath);
		traceStore.initTrace(requestId, session.sessionId, "rp:alice");
		traceStore.addPromptCapture(requestId, {
			sections: {
				PERSONA: "You are Alice, a helpful maid.",
				LORE: "The mansion has three floors.",
				RECENT_COGNITION: "User seems friendly.",
			},
			rendered_system: "Full system prompt content here.",
		});
		traceStore.finalizeTrace(requestId);
		return session.sessionId;
	} finally {
		await host.shutdown();
	}
}

async function seedChunksCase(cwd: string, requestId: string): Promise<string> {
	const runtime = bootstrapRuntime({ cwd });
	const host = await createAppHost({ role: "local", cwd, requireAllProviders: false }, runtime);
	try {
		const session = await runtime.sessionService.createSession("rp:alice");
		const tracesPath = join(cwd, "data", "debug", "traces");
		const traceStore = new TraceStore(tracesPath);
		traceStore.initTrace(requestId, session.sessionId, "rp:alice");
		traceStore.addChunk(requestId, { type: "text_delta", timestamp: 1000, text: "Hello" });
		traceStore.addChunk(requestId, { type: "tool_use_start", timestamp: 2000, tool: "memory_read" });
		traceStore.addChunk(requestId, { type: "text_delta", timestamp: 3000, text: " world" });
		traceStore.addChunk(requestId, { type: "message_end", timestamp: 4000 });
		traceStore.finalizeTrace(requestId);
		return session.sessionId;
	} finally {
		await host.shutdown();
	}
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
