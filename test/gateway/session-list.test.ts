import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { LocalSessionClient } from "../../src/app/clients/local/local-session-client.js";
import { GatewayServer } from "../../src/gateway/server.js";
import {
	type SessionRecord,
	SessionService,
} from "../../src/session/service.js";

function seedSessions(service: SessionService): void {
	const state = service as unknown as {
		sessions: Map<string, SessionRecord>;
		recoveryRequired: Set<string>;
	};

	state.sessions.set("sess-d", {
		sessionId: "sess-d",
		agentId: "agent-a",
		createdAt: 400,
	});
	state.sessions.set("sess-c", {
		sessionId: "sess-c",
		agentId: "agent-a",
		createdAt: 400,
		closedAt: 450,
	});
	state.sessions.set("sess-b", {
		sessionId: "sess-b",
		agentId: "agent-b",
		createdAt: 300,
	});
	state.sessions.set("sess-a", {
		sessionId: "sess-a",
		agentId: "agent-a",
		createdAt: 200,
		closedAt: 250,
	});

	state.recoveryRequired.add("sess-c");
	state.recoveryRequired.add("sess-b");
}

describe("GET /v1/sessions", () => {
	let server: GatewayServer;
	let baseUrl = "";

	beforeAll(() => {
		const service = new SessionService();
		seedSessions(service);

		server = new GatewayServer({
			port: 0,
			host: "localhost",
			context: {
				session: new LocalSessionClient({ sessionService: service }),
			},
		});
		server.start();
		baseUrl = `http://localhost:${server.getPort()}`;
	});

	afterAll(() => {
		server.stop();
	});

	it("returns deterministic ordering and next_cursor", async () => {
		const response = await fetch(`${baseUrl}/v1/sessions?limit=2`);
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			items: Array<{ session_id: string; status: string }>;
			next_cursor: string | null;
		};

		expect(body.items.map((item) => item.session_id)).toEqual([
			"sess-d",
			"sess-c",
		]);
		expect(body.items.map((item) => item.status)).toEqual([
			"open",
			"recovery_required",
		]);
		expect(body.next_cursor).toBeTruthy();
	});

	it("applies filters and paginates by cursor", async () => {
		const first = await fetch(
			`${baseUrl}/v1/sessions?agent_id=agent-a&limit=1`,
		);
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as {
			items: Array<{ session_id: string }>;
			next_cursor: string | null;
		};
		expect(firstBody.items.map((item) => item.session_id)).toEqual(["sess-d"]);
		expect(firstBody.next_cursor).toBeTruthy();

		const second = await fetch(
			`${baseUrl}/v1/sessions?agent_id=agent-a&limit=2&cursor=${encodeURIComponent(firstBody.next_cursor ?? "")}`,
		);
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as {
			items: Array<{ session_id: string }>;
			next_cursor: string | null;
		};
		expect(secondBody.items.map((item) => item.session_id)).toEqual([
			"sess-c",
			"sess-a",
		]);
		expect(secondBody.next_cursor).toBeNull();

		const recoveryOnly = await fetch(
			`${baseUrl}/v1/sessions?status=recovery_required`,
		);
		expect(recoveryOnly.status).toBe(200);
		const recoveryBody = (await recoveryOnly.json()) as {
			items: Array<{ session_id: string }>;
		};
		expect(recoveryBody.items.map((item) => item.session_id)).toEqual([
			"sess-c",
			"sess-b",
		]);
	});

	it("returns BAD_REQUEST for invalid cursor", async () => {
		const response = await fetch(`${baseUrl}/v1/sessions?cursor=%%%`);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("BAD_REQUEST");
	});
});
