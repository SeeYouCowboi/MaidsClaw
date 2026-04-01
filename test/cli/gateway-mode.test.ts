import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AppUserFacade } from "../../src/app/clients/app-clients.js";
import { LocalHealthClient } from "../../src/app/clients/local/local-health-client.js";
import { LocalInspectClient } from "../../src/app/clients/local/local-inspect-client.js";
import { LocalSessionClient } from "../../src/app/clients/local/local-session-client.js";
import { LocalTurnClient } from "../../src/app/clients/local/local-turn-client.js";
import type { ObservationEvent } from "../../src/app/contracts/execution.js";
import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";
import { GatewayServer } from "../../src/gateway/server.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import type { TurnSettlementPayload } from "../../src/interaction/contracts.js";
import { InteractionStore } from "../../src/interaction/store.js";
import { registerDebugCommands } from "../../src/terminal-cli/commands/debug.js";
import { registerSessionCommands } from "../../src/terminal-cli/commands/session.js";
import { registerTurnCommands } from "../../src/terminal-cli/commands/turn.js";
import { CliError } from "../../src/terminal-cli/errors.js";
import { GatewayClient } from "../../src/terminal-cli/gateway-client.js";
import { dispatch, resetCommands } from "../../src/terminal-cli/parser.js";

type RuntimeRef = ReturnType<typeof bootstrapRuntime>;

const tempDirs: string[] = [];

function makeTempDir(): string {
	const root = join(
		import.meta.dir,
		`../../.tmp-gateway-mode-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	tempDirs.push(root);
	return root;
}

function cleanupTempDirs(): void {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		try {
			rmSync(dir, { recursive: true, force: true });
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

function parseJsonLine(raw: string): unknown {
	return JSON.parse(raw.trim().split("\n")[0]);
}

function makeSettlement(
	sessionId: string,
	requestId: string,
): TurnSettlementPayload {
	return {
		settlementId: `stl:${requestId}`,
		requestId,
		sessionId,
		ownerAgentId: "rp:default",
		publicReply: "hello",
		hasPublicReply: true,
		viewerSnapshot: {
			selfPointerKey: "__self__",
			userPointerKey: "__user__",
		},
		privateCognition: {
			schemaVersion: "rp_private_cognition_v4",
			ops: [{ op: "retract", target: { kind: "assertion", key: "k1" } }],
		},
	};
}

describe("gateway mode", () => {
	let runtime: RuntimeRef;
	let server: GatewayServer;
	let baseUrl: string;
	let _savedBackend: string | undefined;

	beforeEach(() => {
		resetCommands();
		registerDebugCommands();
		registerSessionCommands();
		registerTurnCommands();

		_savedBackend = process.env.MAIDSCLAW_BACKEND;
		process.env.MAIDSCLAW_BACKEND = "sqlite";
		runtime = bootstrapRuntime({
			databasePath: ":memory:",
			cwd: makeTempDir(),
		});
		const userFacade: AppUserFacade = {
			session: new LocalSessionClient({
				sessionService: runtime.sessionService,
				turnService: runtime.turnService,
				memoryTaskAgent: runtime.memoryTaskAgent,
			}),
			turn: new LocalTurnClient({
				sessionService: runtime.sessionService,
				turnService: runtime.turnService,
				interactionRepo: runtime.interactionRepo,
				traceStore: runtime.traceStore,
			}),
			inspect: new LocalInspectClient(runtime),
			health: new LocalHealthClient({
				memoryPipelineReady: runtime.memoryPipelineReady,
				healthChecks: runtime.healthChecks,
			}),
		};
		userFacade.turn = {
			async *streamTurn(): AsyncIterable<ObservationEvent> {
				yield { type: "text_delta", text: "Hello from MaidsClaw." };
				yield {
					type: "message_end",
					stop_reason: "end_turn",
					usage: { input_tokens: 0, output_tokens: 10 },
				};
			},
		};
		server = new GatewayServer({
			port: 0,
			host: "localhost",
			userFacade,
			traceStore: runtime.traceStore,
			hasAgent: (id) => runtime.agentRegistry.has(id),
		});
		server.start();
		baseUrl = `http://localhost:${server.getPort()}`;
	});

	afterEach(() => {
		server.stop();
		runtime.shutdown();
		cleanupTempDirs();
		if (_savedBackend === undefined) delete process.env.MAIDSCLAW_BACKEND;
		else process.env.MAIDSCLAW_BACKEND = _savedBackend;
	});

	it("GatewayClient rejects remote unsafe raw", () => {
		const client = new GatewayClient(baseUrl);
		expect(() => client.rejectUnsafeRaw()).toThrow(
			"INSPECT_UNSAFE_RAW_LOCAL_ONLY",
		);
	});

	it("debug trace export rejects --unsafe-raw in gateway mode", async () => {
		try {
			await dispatch([
				"debug",
				"trace",
				"export",
				"--request",
				"req-unsafe",
				"--mode",
				"gateway",
				"--base-url",
				baseUrl,
				"--unsafe-raw",
				"--json",
			]);
			throw new Error("Should have thrown");
		} catch (err) {
			expect(err instanceof CliError).toBe(true);
			const cliErr = err as CliError;
			expect(cliErr.code).toBe("UNSAFE_RAW_LOCAL_ONLY");
			expect(cliErr.exitCode).toBe(2);
		}
	});

	it("gateway evidence endpoints return structured JSON", async () => {
		const session = await runtime.sessionService.createSession("rp:default");
		const requestId = "req-evidence-1";
		const interactionStore = new InteractionStore(runtime.db);
		const commitService = new CommitService(interactionStore);

		commitService.commit({
			sessionId: session.sessionId,
			actorType: "user",
			recordType: "message",
			payload: { role: "user", content: "hello" },
			correlatedTurnId: requestId,
		});
		const settlement = makeSettlement(session.sessionId, requestId);
		commitService.commitWithId({
			sessionId: session.sessionId,
			actorType: "rp_agent",
			recordType: "turn_settlement",
			recordId: settlement.settlementId,
			payload: settlement,
			correlatedTurnId: requestId,
		});

		const summary = await fetch(
			`${baseUrl}/v1/requests/${requestId}/summary`,
		).then((r) => r.json());
		expect(summary.request_id).toBe(requestId);

		const prompt = await fetch(
			`${baseUrl}/v1/requests/${requestId}/prompt`,
		).then((r) => r.json());
		expect(prompt.request_id).toBe(requestId);

		const chunks = await fetch(
			`${baseUrl}/v1/requests/${requestId}/chunks`,
		).then((r) => r.json());
		expect(Array.isArray(chunks.chunks)).toBe(true);

		const diagnose = await fetch(
			`${baseUrl}/v1/requests/${requestId}/diagnose`,
		).then((r) => r.json());
		expect(typeof diagnose.primary_cause).toBe("string");

		const trace = await fetch(`${baseUrl}/v1/requests/${requestId}/trace`).then(
			(r) => r.json(),
		);
		expect(trace.unsafe_raw_settlement_mode).toBe(false);

		const transcript = await fetch(
			`${baseUrl}/v1/sessions/${session.sessionId}/transcript`,
		).then((r) => r.json());
		expect(transcript.session_id).toBe(session.sessionId);

		const memory = await fetch(
			`${baseUrl}/v1/sessions/${session.sessionId}/memory`,
		).then((r) => r.json());
		expect(memory.session_id).toBe(session.sessionId);

		const logs = await fetch(`${baseUrl}/v1/logs?request_id=${requestId}`).then(
			(r) => r.json(),
		);
		expect(logs.filters.request_id).toBe(requestId);
	});

	it("session and turn commands run in gateway mode", async () => {
		const sessionRaw = await captureStdout(async () => {
			await dispatch([
				"session",
				"create",
				"--agent",
				"rp:default",
				"--mode",
				"gateway",
				"--base-url",
				baseUrl,
				"--json",
			]);
		});

		const sessionEnvelope = parseJsonLine(sessionRaw) as {
			ok: boolean;
			data: { session_id: string };
		};
		expect(sessionEnvelope.ok).toBe(true);

		const turnRaw = await captureStdout(async () => {
			await dispatch([
				"turn",
				"send",
				"--session",
				sessionEnvelope.data.session_id,
				"--text",
				"hello",
				"--mode",
				"gateway",
				"--base-url",
				baseUrl,
				"--json",
			]);
		});

		const turnEnvelope = parseJsonLine(turnRaw) as {
			ok: boolean;
			data: { request_id: string };
		};
		expect(turnEnvelope.ok).toBe(true);
		expect(typeof turnEnvelope.data.request_id).toBe("string");
	});
});
