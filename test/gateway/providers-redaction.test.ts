import { afterEach, describe, expect, it } from "bun:test";
import type { GatewayContext } from "../../src/gateway/context.js";
import { GatewayServer } from "../../src/gateway/server.js";

describe("GET /v1/providers redaction of known secret keys", () => {
	let server: GatewayServer;
	let baseUrl = "";

	function startServer(ctx: GatewayContext) {
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

	it("removes apiKey/accessToken/token and extraHeaders.Authorization from response", async () => {
		startServer({
			providerCatalog: {
				listProviders: async () => ({
					providers: [
						{
							id: "sensitive-provider",
							display_name: "Sensitive Provider",
							transport_family: "openai-compatible",
							api_kind: "openai",
							risk_tier: "compatible",
							base_url: "https://example.test/v1",
							auth_modes: ["api-key"],
							configured: true,
							selection_policy: {
								enabled_by_default: true,
								eligible_for_auto_fallback: false,
								is_auto_default: false,
								apiKey: "should-not-leak",
							},
							models: [
								{
									id: "model-x",
									display_name: "Model X",
									context_window: 1024,
									max_output_tokens: 256,
									supports_tools: true,
									supports_vision: false,
									supports_embedding: false,
									token: "nested-model-token",
								},
							],
							apiKey: "root-api-key",
							accessToken: "root-access-token",
							token: "root-token",
							extraHeaders: {
								Authorization: "Bearer should-not-leak",
								"x-safe": "ok",
							},
						},
					],
				}),
			},
		});

		const res = await fetch(`${baseUrl}/v1/providers`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			providers: Array<Record<string, unknown>>;
		};
		expect(body.providers).toHaveLength(1);

		const provider = body.providers[0];
		expect(provider.apiKey).toBeUndefined();
		expect(provider.accessToken).toBeUndefined();
		expect(provider.token).toBeUndefined();
		expect(provider.extraHeaders).toBeUndefined();

		const selection = provider.selection_policy as Record<string, unknown>;
		expect(selection).toBeDefined();
		expect(selection.apiKey).toBeUndefined();

		const model = (provider.models as Array<Record<string, unknown>>)[0];
		expect(model.token).toBeUndefined();
	});
});
