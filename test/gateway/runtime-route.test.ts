import { afterEach, describe, expect, it } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";
import type { GatewayContext } from "../../src/gateway/context.js";

function makeHostStatus(overrides: Record<string, unknown> = {}) {
	return {
		backendType: "pg" as const,
		memoryPipelineStatus: "ready" as const,
		migrationStatus: { succeeded: true },
		...overrides,
	};
}

function makePipelineStatus(overrides: Record<string, unknown> = {}) {
	return {
		memoryPipelineStatus: "ready" as const,
		memoryPipelineReady: true,
		effectiveOrganizerEmbeddingModelId: undefined as string | undefined,
		...overrides,
	};
}

describe("GET /v1/runtime", () => {
	let server: GatewayServer;
	let baseUrl: string;

	function startServer(ctx: GatewayContext, corsAllowedOrigins?: string[]) {
		server = new GatewayServer({
			port: 0,
			host: "localhost",
			context: ctx,
			corsAllowedOrigins,
		});
		server.start();
		baseUrl = `http://localhost:${server.getPort()}`;
	}

	afterEach(() => {
		server?.stop();
	});

	it("returns correct shape from host/pipeline status", async () => {
		const hostStatus = makeHostStatus({
			orchestration: {
				enabled: true,
				role: "server",
				durableMode: true,
				leaseReclaimActive: false,
			},
		});
		const pipelineStatus = makePipelineStatus({
			effectiveOrganizerEmbeddingModelId: "text-embedding-3-small",
		});

		startServer(
			{
				getHostStatus: async () => hostStatus,
				getPipelineStatus: async () => pipelineStatus,
				corsAllowedOrigins: ["http://localhost:5173"],
			},
			["http://localhost:5173"],
		);

		const res = await fetch(`${baseUrl}/v1/runtime`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as Record<string, unknown>;

		expect(body.backend_type).toBe("pg");
		expect(body.memory_pipeline_status).toBe("ready");
		expect(body.memory_pipeline_ready).toBe(true);
		expect(body.effective_organizer_embedding_model_id).toBe(
			"text-embedding-3-small",
		);

		const tt = body.talker_thinker as { enabled: boolean };
		expect(tt).toBeDefined();
		expect(typeof tt.enabled).toBe("boolean");

		const orch = body.orchestration as {
			enabled: boolean;
			role: string;
			durable_mode: boolean;
			lease_reclaim_active: boolean;
		};
		expect(orch.enabled).toBe(true);
		expect(orch.role).toBe("server");
		expect(orch.durable_mode).toBe(true);
		expect(orch.lease_reclaim_active).toBe(false);

		const gw = body.gateway as { cors_allowed_origins: string[] };
		expect(gw.cors_allowed_origins).toEqual(["http://localhost:5173"]);
	});

	it("returns 501 UNSUPPORTED_RUNTIME_MODE when getHostStatus is absent", async () => {
		startServer({});

		const res = await fetch(`${baseUrl}/v1/runtime`);
		expect(res.status).toBe(501);

		const body = (await res.json()) as {
			error: { code: string; retriable: boolean; message: string };
		};
		expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		expect(body.error.retriable).toBe(false);
		expect(body.error.message).toContain("getHostStatus");
	});

	it("includes talker_thinker and orchestration fields", async () => {
		startServer({
			getHostStatus: async () => makeHostStatus(),
		});

		const res = await fetch(`${baseUrl}/v1/runtime`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as Record<string, unknown>;

		expect(body.talker_thinker).toBeDefined();
		expect((body.talker_thinker as { enabled: boolean }).enabled).toBe(false);

		expect(body.orchestration).toBeDefined();
		const orch = body.orchestration as {
			enabled: boolean;
			role: string;
			durable_mode: boolean;
			lease_reclaim_active: boolean;
		};
		expect(orch.enabled).toBe(false);
		expect(orch.durable_mode).toBe(false);
		expect(orch.lease_reclaim_active).toBe(false);
	});

	it("gateway.cors_allowed_origins matches context", async () => {
		const origins = ["http://example.com", "https://app.test"];
		startServer(
			{
				getHostStatus: async () => makeHostStatus(),
				corsAllowedOrigins: origins,
			},
			origins,
		);

		const res = await fetch(`${baseUrl}/v1/runtime`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			gateway: { cors_allowed_origins: string[] };
		};
		expect(body.gateway.cors_allowed_origins).toEqual(origins);
	});

	it("omits effective_organizer_embedding_model_id when undefined", async () => {
		startServer({
			getHostStatus: async () => makeHostStatus(),
			getPipelineStatus: async () => makePipelineStatus(),
		});

		const res = await fetch(`${baseUrl}/v1/runtime`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body).not.toHaveProperty("effective_organizer_embedding_model_id");
	});

	it("uses safe defaults when getPipelineStatus is absent", async () => {
		startServer({
			getHostStatus: async () => makeHostStatus(),
		});

		const res = await fetch(`${baseUrl}/v1/runtime`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.memory_pipeline_status).toBe("ready");
		expect(body.memory_pipeline_ready).toBe(false);
	});
});
