import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";

describe("gateway service guards", () => {
	let server: GatewayServer;
	let baseUrl = "";

	beforeEach(() => {
		server = new GatewayServer({
			port: 0,
			host: "localhost",
			context: {},
		});
		server.start();
		baseUrl = `http://localhost:${server.getPort()}`;
	});

	afterEach(() => {
		server.stop();
	});

	it("returns 501 UNSUPPORTED_RUNTIME_MODE when job query service is absent", async () => {
		const response = await fetch(`${baseUrl}/v1/jobs`);
		expect(response.status).toBe(501);

		const body = (await response.json()) as {
			error: { code: string; retriable: boolean; message: string };
			request_id: string;
		};

		expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		expect(body.error.retriable).toBe(false);
		expect(body.error.message.includes("jobQueryService")).toBe(true);
		expect(body.request_id).toBe("");
	});
});
