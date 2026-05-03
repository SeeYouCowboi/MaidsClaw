import { afterEach, describe, expect, it } from "bun:test";
import type {
	GatewayContext,
	WorldStateInspectionEdgeRow,
	WorldStateInspectionUnresolvedRow,
} from "../../src/gateway/context.js";
import { GatewayServer } from "../../src/gateway/server.js";

describe("agent memory world-state debug routes", () => {
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

	it("GET /v1/agents/{agent_id}/memory/world-state returns normalized edge rows for an entity", async () => {
		let capturedParams: Record<string, unknown> | undefined;
		const fakeEdges: WorldStateInspectionEdgeRow[] = [
			{
				id: 42,
				source_ref: "entity:5",
				target_ref: "entity:6",
				edge_kind: "located_at",
				layer: "world_state",
				truth_bearing: true,
				heuristic_only: false,
				lifecycle: "supersedable",
				fact_text: "Item is in the tea room",
				t_valid: 1700000000000,
				t_invalid: null,
				source_kind: "settlement",
				source_ref_origin: "stl:abc:0",
				owner_agent_id: null,
				created_at: 1700000000000,
			},
		];

		startServer({
			worldStateInspection: {
				async worldStateOf(params) {
					capturedParams = params as unknown as Record<string, unknown>;
					return fakeEdges;
				},
				async listUnresolvedOps() {
					return [];
				},
			},
		});

		const res = await fetch(
			`${baseUrl}/v1/agents/maid:main/memory/world-state?entity_ref=entity:5&mode=active&limit=10`,
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			agent_id: string;
			entity_ref: string;
			mode: string;
			items: WorldStateInspectionEdgeRow[];
		};
		expect(body.agent_id).toBe("maid:main");
		expect(body.entity_ref).toBe("entity:5");
		expect(body.mode).toBe("active");
		expect(body.items).toEqual(fakeEdges);
		expect(capturedParams).toEqual({
			agentId: "maid:main",
			entityRef: "entity:5",
			mode: "active",
			limit: 10,
		});
	});

	it("GET /v1/agents/{agent_id}/memory/world-state defaults mode to active and limit to 100", async () => {
		let capturedParams: Record<string, unknown> | undefined;
		startServer({
			worldStateInspection: {
				async worldStateOf(params) {
					capturedParams = params as unknown as Record<string, unknown>;
					return [];
				},
				async listUnresolvedOps() {
					return [];
				},
			},
		});

		const res = await fetch(
			`${baseUrl}/v1/agents/maid:main/memory/world-state?entity_ref=entity:7`,
		);
		expect(res.status).toBe(200);
		expect(capturedParams).toEqual({
			agentId: "maid:main",
			entityRef: "entity:7",
			mode: "active",
			limit: 100,
		});
	});

	it("GET /v1/agents/{agent_id}/memory/world-state rejects missing entity_ref", async () => {
		startServer({
			worldStateInspection: {
				async worldStateOf() {
					throw new Error("should not be called");
				},
				async listUnresolvedOps() {
					return [];
				},
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents/maid:main/memory/world-state`);
		expect(res.status).toBe(400);
	});

	it("GET /v1/agents/{agent_id}/memory/world-state rejects invalid mode", async () => {
		startServer({
			worldStateInspection: {
				async worldStateOf() {
					throw new Error("should not be called");
				},
				async listUnresolvedOps() {
					return [];
				},
			},
		});

		const res = await fetch(
			`${baseUrl}/v1/agents/maid:main/memory/world-state?entity_ref=entity:5&mode=bogus`,
		);
		expect(res.status).toBe(400);
	});

	it("GET /v1/agents/{agent_id}/memory/world-state returns 501 when worldStateInspection service is unavailable", async () => {
		startServer({});
		const res = await fetch(
			`${baseUrl}/v1/agents/maid:main/memory/world-state?entity_ref=entity:5`,
		);
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		expect(body.error.message).toContain("worldStateInspection");
	});

	it("GET /v1/agents/{agent_id}/memory/world-state/unresolved-ops lists pending queue rows", async () => {
		const fakeRows: WorldStateInspectionUnresolvedRow[] = [
			{
				id: 7,
				session_id: "sess-x",
				settlement_id: "stl:queued",
				op_index: 0,
				status: "pending",
				agent_id: "maid:main",
				predicate: "knows",
				fact_text: "alice knows bob",
				subject_pointer_key: "char:alice",
				object_pointer_key: "char:bob",
				retry_count: 1,
				last_error: "[world-state-ops] unresolved pointer_key",
				created_at: 1700000000000,
				updated_at: 1700000000050,
			},
		];

		let captured: Record<string, unknown> | undefined;
		startServer({
			worldStateInspection: {
				async worldStateOf() {
					return [];
				},
				async listUnresolvedOps(params) {
					captured = params as unknown as Record<string, unknown>;
					return fakeRows;
				},
			},
		});

		const res = await fetch(
			`${baseUrl}/v1/agents/maid:main/memory/world-state/unresolved-ops`,
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			agent_id: string;
			items: WorldStateInspectionUnresolvedRow[];
		};
		expect(body.agent_id).toBe("maid:main");
		expect(body.items).toEqual(fakeRows);
		expect(captured).toEqual({
			agentId: "maid:main",
			limit: 100,
		});
	});

	it("GET /v1/agents/{agent_id}/memory/world-state/unresolved-ops?status=dead_letter forwards filter", async () => {
		let captured: Record<string, unknown> | undefined;
		startServer({
			worldStateInspection: {
				async worldStateOf() {
					return [];
				},
				async listUnresolvedOps(params) {
					captured = params as unknown as Record<string, unknown>;
					return [];
				},
			},
		});

		const res = await fetch(
			`${baseUrl}/v1/agents/maid:main/memory/world-state/unresolved-ops?status=dead_letter&limit=20`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status_filter?: string };
		expect(body.status_filter).toBe("dead_letter");
		expect(captured).toEqual({
			agentId: "maid:main",
			status: "dead_letter",
			limit: 20,
		});
	});

	it("GET /v1/agents/{agent_id}/memory/world-state/unresolved-ops rejects unknown status", async () => {
		startServer({
			worldStateInspection: {
				async worldStateOf() {
					return [];
				},
				async listUnresolvedOps() {
					return [];
				},
			},
		});

		const res = await fetch(
			`${baseUrl}/v1/agents/maid:main/memory/world-state/unresolved-ops?status=mystery`,
		);
		expect(res.status).toBe(400);
	});
});
