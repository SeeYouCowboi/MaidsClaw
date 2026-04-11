import { afterEach, describe, expect, it } from "bun:test";
import type { GatewayContext } from "../../src/gateway/context.js";
import { GatewayServer } from "../../src/gateway/server.js";

const SENSITIVE_PATTERN = /(token|secret|password|authorization)/i;

function randomInt(maxExclusive: number): number {
	return Math.floor(Math.random() * maxExclusive);
}

function randomAlpha(length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz";
	let out = "";
	for (let i = 0; i < length; i++) {
		out += alphabet[randomInt(alphabet.length)];
	}
	return out;
}

function randomSensitiveKey(): string {
	const tokens = ["token", "secret", "password", "authorization"];
	const base = tokens[randomInt(tokens.length)];
	return `${randomAlpha(3)}_${base}_${randomAlpha(4)}`;
}

function gatherKeyNames(value: unknown): string[] {
	if (Array.isArray(value)) {
		const keys: string[] = [];
		for (const item of value) {
			keys.push(...gatherKeyNames(item));
		}
		return keys;
	}

	if (!value || typeof value !== "object") {
		return [];
	}

	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	for (const child of Object.values(record)) {
		keys.push(...gatherKeyNames(child));
	}
	return keys;
}

describe("GET /v1/providers redaction property checks", () => {
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

	it("property: unknown sensitive nested keys never survive projection", async () => {
		const attempts = 30;
		for (let i = 0; i < attempts; i++) {
			const injectedKeys = [
				randomSensitiveKey(),
				randomSensitiveKey(),
				randomSensitiveKey(),
			];

			startServer({
				providerCatalog: {
					listProviders: async () => ({
						providers: [
							{
								id: `provider-${i}`,
								display_name: `Provider ${i}`,
								transport_family: "openai-compatible",
								api_kind: "openai",
								risk_tier: "compatible",
								base_url: "https://example.test/v1",
								auth_modes: ["api-key"],
								configured: i % 2 === 0,
								selection_policy: {
									enabled_by_default: true,
									eligible_for_auto_fallback: false,
									is_auto_default: false,
									[injectedKeys[0]]: "should-not-survive",
									deep: {
										[injectedKeys[1]]: "should-not-survive",
									},
								},
								models: [
									{
										id: "model-a",
										display_name: "Model A",
										context_window: 4096,
										max_output_tokens: 512,
										supports_tools: true,
										supports_vision: false,
										supports_embedding: false,
										meta: {
											[injectedKeys[2]]: "should-not-survive",
										},
									},
								],
							},
						],
					}),
				},
			});

			const res = await fetch(`${baseUrl}/v1/providers`);
			expect(res.status).toBe(200);

			const body = (await res.json()) as { providers: unknown[] };
			const keyNames = gatherKeyNames(body.providers);
			for (const injected of injectedKeys) {
				expect(keyNames.includes(injected)).toBe(false);
			}

			const sensitiveSurvivors = keyNames.filter(
				(key) => SENSITIVE_PATTERN.test(key) && key !== "max_output_tokens",
			);
			expect(sensitiveSurvivors).toHaveLength(0);

			server.stop();
		}
	});
});
