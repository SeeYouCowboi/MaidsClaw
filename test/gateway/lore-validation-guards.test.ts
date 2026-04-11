import { afterEach, describe, expect, it } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";
import type { GatewayContext } from "../../src/gateway/context.js";

describe("lore validation guards", () => {
	let server: GatewayServer;
	let baseUrl: string;

	function startServer(ctx: GatewayContext) {
		server = new GatewayServer({ port: 0, host: "localhost", context: ctx });
		server.start();
		baseUrl = `http://localhost:${server.getPort()}`;
	}

	afterEach(() => {
		server?.stop();
	});

	describe("501 UNSUPPORTED_RUNTIME_MODE when loreAdmin absent", () => {
		it("GET /v1/lore returns 501", async () => {
			startServer({});

			const res = await fetch(`${baseUrl}/v1/lore`);
			expect(res.status).toBe(501);

			const body = (await res.json()) as {
				error: { code: string; retriable: boolean; message: string };
			};
			expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
			expect(body.error.retriable).toBe(false);
			expect(body.error.message).toContain("loreAdmin");
		});

		it("GET /v1/lore/{id} returns 501", async () => {
			startServer({});

			const res = await fetch(`${baseUrl}/v1/lore/some-id`);
			expect(res.status).toBe(501);

			const body = (await res.json()) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		});

		it("POST /v1/lore returns 501", async () => {
			startServer({});

			const res = await fetch(`${baseUrl}/v1/lore`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: "test" }),
			});
			expect(res.status).toBe(501);

			const body = (await res.json()) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		});

		it("PUT /v1/lore/{id} returns 501", async () => {
			startServer({});

			const res = await fetch(`${baseUrl}/v1/lore/some-id`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: "some-id" }),
			});
			expect(res.status).toBe(501);

			const body = (await res.json()) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		});

		it("DELETE /v1/lore/{id} returns 501", async () => {
			startServer({});

			const res = await fetch(`${baseUrl}/v1/lore/some-id`, {
				method: "DELETE",
			});
			expect(res.status).toBe(501);

			const body = (await res.json()) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		});
	});
});
