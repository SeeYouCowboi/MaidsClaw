import { afterEach, describe, expect, it } from "bun:test";
import type { GatewayContext } from "../../src/gateway/context.js";
import { GatewayServer } from "../../src/gateway/server.js";
import { MaidenDecisionLog } from "../../src/agents/maiden/decision-log.js";

describe("GET /v1/state/maiden-decisions", () => {
	let server: GatewayServer;
	let baseUrl = "";

	function startServer(ctx: GatewayContext): void {
		server = new GatewayServer({
			port: 0,
			host: "localhost",
			context: ctx,
		});
		server.start();
		baseUrl = `http://localhost:${server.getPort()}`;
	}

	afterEach(() => {
		server?.stop();
	});

	it("returns 501 when decisionLog service is unavailable", async () => {
		startServer({});
		const res = await fetch(`${baseUrl}/v1/state/maiden-decisions`);
		expect(res.status).toBe(501);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		expect(body.error.message).toContain("decisionLog");
	});

	it("returns ordered items with filters and cursor pagination", async () => {
		const log = new MaidenDecisionLog();
		await log.append({
			decision_id: "dec:aaa",
			request_id: "req:a",
			session_id: "s1",
			delegation_depth: 0,
			action: "direct_reply",
			chosen_from_agent_ids: [],
			created_at: 100,
		});
		await log.append({
			decision_id: "dec:bbb",
			request_id: "req:b",
			session_id: "s1",
			delegation_depth: 0,
			action: "delegate",
			target_agent_id: "rp:default",
			chosen_from_agent_ids: ["rp:default"],
			created_at: 200,
		});
		await log.append({
			decision_id: "dec:ccc",
			request_id: "req:c",
			session_id: "s2",
			delegation_depth: 1,
			action: "direct_reply",
			chosen_from_agent_ids: [],
			created_at: 300,
		});

		startServer({ decisionLog: log });

		const page1Res = await fetch(
			`${baseUrl}/v1/state/maiden-decisions?session_id=s1&limit=1`,
		);
		expect(page1Res.status).toBe(200);
		const page1 = (await page1Res.json()) as {
			items: Array<Record<string, unknown>>;
			next_cursor: string | null;
			filters: { session_id?: string };
		};

		expect(page1.filters).toEqual({ session_id: "s1" });
		expect(page1.items).toHaveLength(1);
		expect(page1.items[0]).toMatchObject({
			decision_id: "dec:bbb",
			action: "delegate",
		});
		expect(page1.next_cursor).toBeString();

		const page2Res = await fetch(
			`${baseUrl}/v1/state/maiden-decisions?session_id=s1&limit=1&cursor=${encodeURIComponent(page1.next_cursor ?? "")}`,
		);
		expect(page2Res.status).toBe(200);
		const page2 = (await page2Res.json()) as {
			items: Array<Record<string, unknown>>;
			next_cursor: string | null;
		};

		expect(page2.items).toHaveLength(1);
		expect(page2.items[0]).toMatchObject({
			decision_id: "dec:aaa",
			action: "direct_reply",
		});
		expect(page2.next_cursor).toBeNull();
	});

	it("returns empty list for no matches", async () => {
		const log = new MaidenDecisionLog();
		startServer({ decisionLog: log });

		const res = await fetch(
			`${baseUrl}/v1/state/maiden-decisions?session_id=missing`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: unknown[];
			next_cursor: string | null;
			filters: { session_id?: string };
		};

		expect(body.items).toEqual([]);
		expect(body.next_cursor).toBeNull();
		expect(body.filters).toEqual({ session_id: "missing" });
	});
});
