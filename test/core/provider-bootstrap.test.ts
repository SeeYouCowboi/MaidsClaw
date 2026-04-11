import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	buildGatewayRuntimeContextExtensions,
	createProviderCatalogService,
} from "../../src/bootstrap/runtime.js";
import type { AuthConfig } from "../../src/core/config-schema.js";
import type { ProviderCatalogEntry } from "../../src/core/models/provider-types.js";

describe("provider bootstrap catalog service", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.OPENAI_API_KEY;
		delete process.env.BAILIAN_API_KEY;
		delete process.env.KIMI_CODING_API_KEY;
		delete process.env.MOONSHOT_API_KEY;
		delete process.env.MINIMAX_API_KEY;
		delete process.env.OPENAI_CODEX_OAUTH_TOKEN;
		delete process.env.ANTHROPIC_SETUP_TOKEN;
	});

	afterEach(() => {
		Object.keys(process.env).forEach((key) => {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		});
		Object.assign(process.env, originalEnv);
	});

	it("returns merged providers with configured booleans", async () => {
		process.env.ANTHROPIC_API_KEY = "env-anthropic";

		const auth: AuthConfig = {
			credentials: [
				{ type: "api-key", provider: "moonshot", apiKey: "moonshot-secret" },
			],
		};

		const providerOverrides: ProviderCatalogEntry[] = [
			{
				id: "my-local-llm",
				displayName: "My Local LLM",
				transportFamily: "openai-compatible",
				apiKind: "openai",
				riskTier: "compatible",
				baseUrl: "http://localhost:11434/v1",
				authModes: ["api-key"],
				selectionPolicy: {
					enabledByDefault: true,
					eligibleForAutoFallback: false,
					isAutoDefault: false,
				},
				models: [
					{
						id: "llama3",
						displayName: "Llama 3",
						contextWindow: 8192,
						maxOutputTokens: 4096,
						supportsTools: false,
						supportsVision: false,
						supportsEmbedding: false,
					},
				],
			},
			{
				id: "kimi-coding",
				displayName: "Kimi for Coding",
				transportFamily: "openai-compatible",
				apiKind: "openai",
				riskTier: "compatible",
				baseUrl: "https://api.kimi.com/coding",
				authModes: ["api-key"],
				selectionPolicy: {
					enabledByDefault: true,
					eligibleForAutoFallback: false,
					isAutoDefault: false,
				},
				models: [
					{
						id: "kimi-for-coding",
						displayName: "Kimi for Coding",
						contextWindow: 262_144,
						maxOutputTokens: 32_768,
						supportsTools: true,
						supportsVision: true,
						supportsEmbedding: false,
					},
				],
				extraHeaders: {
					Authorization: "Bearer should-not-leak",
					"x-custom": "safe-value",
				},
			},
		];

		const service = createProviderCatalogService({
			auth,
			providerOverrides,
		});
		const result = await service.listProviders();

		const moonshot = result.providers.find((provider) => provider.id === "moonshot");
		expect(moonshot?.configured).toBe(true);

		const anthropic = result.providers.find(
			(provider) => provider.id === "anthropic",
		);
		expect(anthropic?.configured).toBe(true);

		const openai = result.providers.find((provider) => provider.id === "openai");
		expect(openai?.configured).toBe(false);

		const custom = result.providers.find(
			(provider) => provider.id === "my-local-llm",
		);
		expect(custom).toBeDefined();

		const kimi = result.providers.find((provider) => provider.id === "kimi-coding");
		expect(kimi?.extra_headers?.Authorization).toBe("[REDACTED]");
		expect(kimi?.extra_headers?.["x-custom"]).toBe("safe-value");
	});

	it("wires provider catalog into gateway context extensions", async () => {
		const auth: AuthConfig = { credentials: [] };
		const providerCatalogService = createProviderCatalogService({
			auth,
			providerOverrides: [],
		});

		const runtimeLike = {
			providerCatalogService,
		} as unknown as Parameters<typeof buildGatewayRuntimeContextExtensions>[0];

		const extensions = buildGatewayRuntimeContextExtensions(runtimeLike);
		expect(extensions.providerCatalog).toBe(providerCatalogService);
		expect(extensions.blackboard).toBeUndefined();

		const providers = await extensions.providerCatalog?.listProviders();
		expect(Array.isArray(providers?.providers)).toBe(true);
	});
});
