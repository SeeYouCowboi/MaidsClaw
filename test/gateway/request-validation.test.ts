import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { SessionService } from "../../src/session/service.js";
import { GatewayServer } from "../../src/gateway/server.js";
import { LocalSessionClient } from "../../src/app/clients/local/local-session-client.js";
import type { ObservationEvent } from "../../src/app/contracts/execution.js";
import type { TurnClient, TurnRequest } from "../../src/app/clients/turn-client.js";
import type { Chunk } from "../../src/core/chunk.js";
import { chunkToObservationEvent } from "../../src/gateway/controllers.js";
import { executeUserTurn } from "../../src/app/turn/user-turn-service.js";

function buildTestFacade(sessionService: SessionService) {
	const stubTurnService = {
		async *runUserTurn(): AsyncGenerator<Chunk> {
			yield { type: "text_delta" as const, text: "ok" };
			yield { type: "message_end" as const, stopReason: "end_turn" as const, inputTokens: 0, outputTokens: 1 };
		},
	};

	const sessionClient = new LocalSessionClient({
		sessionService,
	});

	const turnClient: TurnClient = {
		async *streamTurn(params: TurnRequest): AsyncGenerator<ObservationEvent> {
			const stream = await executeUserTurn(
				{
					sessionId: params.sessionId,
					agentId: params.agentId,
					userText: params.text,
					requestId: params.requestId,
				},
				{
					sessionService,
					turnService: stubTurnService,
				},
			);
			for await (const chunk of stream) {
				const mapped = chunkToObservationEvent(chunk);
				if (mapped) yield mapped;
			}
		},
	};

	return {
		session: sessionClient,
		turn: turnClient,
		inspect: undefined as any,
		health: undefined as any,
	};
}

// ── Test Suite ───────────────────────────────────────────────────────────────

let server: GatewayServer;
let baseUrl: string;

beforeAll(() => {
	const sessionService = new SessionService();
	server = new GatewayServer({
		port: 0,
		host: "localhost",
		userFacade: buildTestFacade(sessionService),
	});
	server.start();
	baseUrl = `http://localhost:${server.getPort()}`;
});

afterAll(() => {
	server.stop();
});

describe("POST /v1/sessions — request validation", () => {
	it("invalid JSON body → 400 BAD_REQUEST", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json at all",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; message: string; retriable: boolean };
		};
		expect(body.error.code).toBe("BAD_REQUEST");
		expect(body.error.message).toBe("Invalid JSON body");
		expect(body.error.retriable).toBe(false);
	});

	it("empty object (missing agent_id) → 400 BAD_REQUEST with details", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; message: string; details: unknown };
		};
		expect(body.error.code).toBe("BAD_REQUEST");
		expect(body.error.message).toBe("Invalid request body");
		expect(body.error.details).toBeDefined();
	});

	it("agent_id is empty string → 400 BAD_REQUEST", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agent_id: "" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("BAD_REQUEST");
	});

	it("agent_id is numeric (wrong type) → 400 BAD_REQUEST", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agent_id: 42 }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string };
		};
		expect(body.error.code).toBe("BAD_REQUEST");
	});

	it("extra unknown fields are rejected (strict schema)", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agent_id: "maid:main", bonus: true }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string };
		};
		expect(body.error.code).toBe("BAD_REQUEST");
	});
});

describe("POST /v1/sessions/{id}/turns:stream — request validation", () => {
	let sessionId: string;

	beforeAll(async () => {
		const res = await fetch(`${baseUrl}/v1/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agent_id: "maid:main" }),
		});
		const body = (await res.json()) as { session_id: string };
		sessionId = body.session_id;
	});

	it("invalid JSON body on turn → 400 BAD_REQUEST (not SSE)", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns:stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{broken",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; message: string; retriable: boolean };
		};
		expect(body.error.code).toBe("BAD_REQUEST");
		expect(body.error.message).toBe("Invalid JSON body");
		expect(body.error.retriable).toBe(false);
	});
});

describe("POST /v1/sessions/{id}/recover — request validation", () => {
	let sessionId: string;

	beforeAll(async () => {
		const res = await fetch(`${baseUrl}/v1/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agent_id: "maid:main" }),
		});
		const body = (await res.json()) as { session_id: string };
		sessionId = body.session_id;
	});

	it("invalid JSON body on recover → 400 BAD_REQUEST", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/recover`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not-json",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("BAD_REQUEST");
		expect(body.error.message).toBe("Invalid JSON body");
	});

	it("missing action field on recover → 400 BAD_REQUEST", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/recover`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string };
		};
		expect(body.error.code).toBe("BAD_REQUEST");
	});
});
