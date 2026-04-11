import { afterEach, describe, expect, it } from "bun:test";
import type { GatewayContext } from "../../src/gateway/context.js";
import { GatewayServer } from "../../src/gateway/server.js";

describe("agent memory narratives route", () => {
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

	it("GET /v1/agents/{agent_id}/memory/narratives returns projected ordered items", async () => {
		let capturedAgentId = "";
		startServer({
			areaWorldProjection: {
				listByAgent: async (agentId) => {
					capturedAgentId = agentId;
					return [
						{ scope: "area", area_id: 2, summary_text: "area two newer", updated_at: 1700000500000 },
						{ scope: "world", summary_text: "world latest", updated_at: 1700000600000 },
						{ scope: "area", area_id: 1, summary_text: "area one older", updated_at: 1700000200000 },
						{ scope: "world", summary_text: "world older", updated_at: 1700000100000 },
					];
				},
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents/maid:main/memory/narratives`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			agent_id: string;
			items: Array<{
				scope: "world" | "area";
				scope_id: string;
				summary_text: string;
				updated_at: number;
			}>;
		};
		expect(capturedAgentId).toBe("maid:main");
		expect(body.agent_id).toBe("maid:main");
		expect(body.items).toEqual([
			{
				scope: "world",
				scope_id: "world",
				summary_text: "world latest",
				updated_at: 1700000600000,
			},
			{
				scope: "world",
				scope_id: "world",
				summary_text: "world older",
				updated_at: 1700000100000,
			},
			{
				scope: "area",
				scope_id: "area:2",
				summary_text: "area two newer",
				updated_at: 1700000500000,
			},
			{
				scope: "area",
				scope_id: "area:1",
				summary_text: "area one older",
				updated_at: 1700000200000,
			},
		]);
	});

	it("GET /v1/agents/{agent_id}/memory/narratives returns empty list when no data", async () => {
		startServer({
			areaWorldProjection: {
				listByAgent: async () => [],
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents/maid:main/memory/narratives`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { agent_id: string; items: unknown[] };
		expect(body.agent_id).toBe("maid:main");
		expect(body.items).toEqual([]);
	});

	it("GET /v1/agents/{agent_id}/memory/narratives returns 501 when areaWorldProjection missing", async () => {
		startServer({});
		const res = await fetch(`${baseUrl}/v1/agents/maid:main/memory/narratives`);
		expect(res.status).toBe(501);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		expect(body.error.message).toContain("areaWorldProjection");
	});
});
