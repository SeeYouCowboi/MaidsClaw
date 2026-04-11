import { afterEach, describe, expect, it } from "bun:test";
import type { GatewayContext } from "../../src/gateway/context.js";
import { GatewayServer } from "../../src/gateway/server.js";

type ProviderResponseItem = {
	id: string;
	display_name: string;
	transport_family: string;
	api_kind: string;
	risk_tier: string;
	base_url: string;
	auth_modes: string[];
	configured: boolean;
	selection_policy: {
		enabled_by_default: boolean;
		eligible_for_auto_fallback: boolean;
		is_auto_default: boolean;
	};
	default_chat_model_id?: string;
	default_embedding_model_id?: string;
	models: Array<{
		id: string;
		display_name: string;
		context_window: number;
		max_output_tokens: number;
		supports_tools: boolean;
		supports_vision: boolean;
		supports_embedding: boolean;
	}>;
};

describe("GET /v1/providers", () => {
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

	it("returns redacted provider list shape with configured booleans", async () => {
		startServer({
			providerCatalog: {
				listProviders: async () => ({
					providers: [
						{
							id: "anthropic",
							display_name: "Anthropic",
							transport_family: "anthropic-native",
							api_kind: "anthropic",
							risk_tier: "stable",
							base_url: "https://api.anthropic.com",
							auth_modes: ["api-key"],
							configured: true,
							selection_policy: {
								enabled_by_default: true,
								eligible_for_auto_fallback: true,
								is_auto_default: true,
							},
							default_chat_model_id: "claude-3-5-sonnet-20241022",
							models: [
								{
									id: "claude-3-5-sonnet-20241022",
									display_name: "Claude 3.5 Sonnet",
									context_window: 200000,
									max_output_tokens: 8192,
									supports_tools: true,
									supports_vision: true,
									supports_embedding: false,
								},
							],
						},
						{
							id: "openai",
							display_name: "OpenAI",
							transport_family: "openai-compatible",
							api_kind: "openai",
							risk_tier: "stable",
							base_url: "https://api.openai.com",
							auth_modes: ["api-key"],
							configured: false,
							selection_policy: {
								enabled_by_default: true,
								eligible_for_auto_fallback: true,
								is_auto_default: true,
							},
							default_embedding_model_id: "text-embedding-3-small",
							models: [
								{
									id: "text-embedding-3-small",
									display_name: "Text Embedding 3 Small",
									context_window: 8191,
									max_output_tokens: 0,
									supports_tools: false,
									supports_vision: false,
									supports_embedding: true,
								},
							],
						},
					],
				}),
			},
		});

		const res = await fetch(`${baseUrl}/v1/providers`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as { providers: ProviderResponseItem[] };
		expect(Array.isArray(body.providers)).toBe(true);
		expect(body.providers).toHaveLength(2);

		expect(body.providers[0].id).toBe("anthropic");
		expect(body.providers[0].configured).toBe(true);
		expect(body.providers[0].default_chat_model_id).toBe(
			"claude-3-5-sonnet-20241022",
		);

		expect(body.providers[1].id).toBe("openai");
		expect(body.providers[1].configured).toBe(false);
		expect(body.providers[1].default_embedding_model_id).toBe(
			"text-embedding-3-small",
		);

		expect(Object.keys(body).sort()).toEqual(["providers"]);
		expect(Object.keys(body.providers[0]).sort()).toEqual([
			"api_kind",
			"auth_modes",
			"base_url",
			"configured",
			"default_chat_model_id",
			"display_name",
			"id",
			"models",
			"risk_tier",
			"selection_policy",
			"transport_family",
		]);
		expect(Object.keys(body.providers[1]).sort()).toEqual([
			"api_kind",
			"auth_modes",
			"base_url",
			"configured",
			"default_embedding_model_id",
			"display_name",
			"id",
			"models",
			"risk_tier",
			"selection_policy",
			"transport_family",
		]);
	});

	it("returns 501 when providerCatalog service is unavailable", async () => {
		startServer({});

		const res = await fetch(`${baseUrl}/v1/providers`);
		expect(res.status).toBe(501);

		const body = (await res.json()) as {
			error: { code: string; retriable: boolean; message: string };
		};
		expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		expect(body.error.retriable).toBe(false);
		expect(body.error.message).toContain("providerCatalog");
	});
});
