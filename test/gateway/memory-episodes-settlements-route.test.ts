import { afterEach, describe, expect, it } from "bun:test";
import type { GatewayContext } from "../../src/gateway/context.js";
import { GatewayServer } from "../../src/gateway/server.js";

describe("agent memory episodes + settlements routes", () => {
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

	it("GET /v1/agents/{agent_id}/memory/episodes returns projected ordered items and applies since/limit", async () => {
		let capturedAgentId = "";
		let capturedOptions: { since?: number; limit?: number } | undefined;
		startServer({
			episodeRepo: {
				listByAgent: async (agentId, options) => {
					capturedAgentId = agentId;
					capturedOptions = options;
					return [
						{
							id: 10,
							settlement_id: "set-10",
							category: "observation",
							summary: "newest",
							private_notes: "only-me",
							location_text: "library",
							committed_time: 1700000200000,
							created_at: 1700000100000,
							extra_field: "must_not_leak",
						},
						{
							id: 9,
							settlement_id: "set-09",
							category: "fact",
							summary: "middle",
							committed_time: 1700000150000,
							created_at: 1700000090000,
						},
						{
							id: 8,
							settlement_id: "set-08",
							category: "fact",
							summary: "older-than-since",
							committed_time: 1700000050000,
							created_at: 1700000010000,
						},
					];
				},
			},
		});

		const res = await fetch(
			`${baseUrl}/v1/agents/maid:main/memory/episodes?since=1700000090000&limit=2`,
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			agent_id: string;
			items: Array<Record<string, unknown>>;
		};
		expect(capturedAgentId).toBe("maid:main");
		expect(capturedOptions).toEqual({ since: 1700000090000, limit: 2 });
		expect(body.agent_id).toBe("maid:main");
		expect(body.items).toHaveLength(2);
		expect(body.items[0]).toEqual({
			episode_id: 10,
			settlement_id: "set-10",
			category: "observation",
			summary: "newest",
			private_notes: "only-me",
			location_text: "library",
			committed_time: 1700000200000,
			created_at: 1700000100000,
		});
		expect(body.items[1]).toEqual({
			episode_id: 9,
			settlement_id: "set-09",
			category: "fact",
			summary: "middle",
			committed_time: 1700000150000,
			created_at: 1700000090000,
		});
	});

	it("GET /v1/agents/{agent_id}/memory/episodes returns empty list when no data", async () => {
		startServer({
			episodeRepo: {
				listByAgent: async () => [],
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents/maid:main/memory/episodes`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { agent_id: string; items: unknown[] };
		expect(body.agent_id).toBe("maid:main");
		expect(body.items).toEqual([]);
	});

	it("GET /v1/agents/{agent_id}/memory/episodes returns 501 when episodeRepo missing", async () => {
		startServer({});
		const res = await fetch(`${baseUrl}/v1/agents/maid:main/memory/episodes`);
		expect(res.status).toBe(501);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		expect(body.error.message).toContain("episodeRepo");
	});

	it("GET /v1/agents/{agent_id}/memory/settlements returns projected ordered items and clamps limit", async () => {
		let capturedAgentId = "";
		let capturedOptions: { limit?: number } | undefined;
		startServer({
			settlementRepo: {
				listByAgent: async (agentId, options) => {
					capturedAgentId = agentId;
					capturedOptions = options;
					return [
						{
							settlement_id: "set-c",
							status: "failed_retryable",
							attempt_count: 2,
							payload_hash: "hash-c",
							claimed_by: "worker-1",
							claimed_at: 1700000300000,
							applied_at: 1700000400000,
							error_message: "retry",
							created_at: 1700000000000,
							updated_at: 1700000200000,
							max_attempts: 4,
						},
						{
							settlement_id: "set-z",
							status: "applied",
							attempt_count: 1,
							created_at: 1700000000001,
							updated_at: 1700000200000,
						},
						{
							settlement_id: "set-a",
							status: "pending",
							attempt_count: 0,
							created_at: 1700000000002,
							updated_at: 1700000100000,
						},
					];
				},
			},
		});

		const res = await fetch(
			`${baseUrl}/v1/agents/maid:main/memory/settlements?limit=999`,
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			agent_id: string;
			items: Array<Record<string, unknown>>;
		};
		expect(capturedAgentId).toBe("maid:main");
		expect(capturedOptions).toEqual({ limit: 200 });
		expect(body.agent_id).toBe("maid:main");
		expect(body.items).toHaveLength(3);
		expect(body.items[0]).toEqual({
			settlement_id: "set-z",
			status: "applied",
			attempt_count: 1,
			created_at: 1700000000001,
			updated_at: 1700000200000,
		});
		expect(body.items[1]).toEqual({
			settlement_id: "set-c",
			status: "failed_retryable",
			attempt_count: 2,
			payload_hash: "hash-c",
			claimed_by: "worker-1",
			claimed_at: 1700000300000,
			applied_at: 1700000400000,
			error_message: "retry",
			created_at: 1700000000000,
			updated_at: 1700000200000,
		});
		expect(body.items[2]).toEqual({
			settlement_id: "set-a",
			status: "pending",
			attempt_count: 0,
			created_at: 1700000000002,
			updated_at: 1700000100000,
		});
	});

	it("GET /v1/agents/{agent_id}/memory/settlements returns empty list when no data", async () => {
		startServer({
			settlementRepo: {
				listByAgent: async () => [],
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents/maid:main/memory/settlements`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { agent_id: string; items: unknown[] };
		expect(body.agent_id).toBe("maid:main");
		expect(body.items).toEqual([]);
	});

	it("GET /v1/agents/{agent_id}/memory/settlements returns 501 when settlementRepo missing", async () => {
		startServer({});
		const res = await fetch(`${baseUrl}/v1/agents/maid:main/memory/settlements`);
		expect(res.status).toBe(501);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		expect(body.error.message).toContain("settlementRepo");
	});
});
