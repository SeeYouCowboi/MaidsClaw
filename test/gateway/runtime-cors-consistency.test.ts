import { afterEach, describe, expect, it } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";
import type { GatewayContext } from "../../src/gateway/context.js";

function makeHostStatus() {
	return {
		backendType: "pg" as const,
		memoryPipelineStatus: "ready" as const,
		migrationStatus: { succeeded: true },
	};
}

describe("GET /v1/runtime — CORS consistency", () => {
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

	it("returns the same corsAllowedOrigins array from context", async () => {
		const origins = ["https://my-app.example.com", "http://localhost:3001"];

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

	it("returns default [\"http://localhost:5173\"] when no corsAllowedOrigins in context", async () => {
		startServer({
			getHostStatus: async () => makeHostStatus(),
		});

		const res = await fetch(`${baseUrl}/v1/runtime`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			gateway: { cors_allowed_origins: string[] };
		};
		expect(body.gateway.cors_allowed_origins).toEqual([
			"http://localhost:5173",
		]);
	});
});
