import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProviderOverrides } from "../../src/core/models/provider-overrides-loader.js";

describe("loadProviderOverrides", () => {
	let tmpDir = "";

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "maidsclaw-provider-overrides-"));
		mkdirSync(join(tmpDir, "config"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns [] when config/providers.json does not exist", () => {
		const result = loadProviderOverrides({ cwd: tmpDir });
		expect(result).toEqual([]);
	});

	it("loads valid overrides from config/providers.json", () => {
		writeFileSync(
			join(tmpDir, "config", "providers.json"),
			JSON.stringify({
				providers: [
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
				],
			}),
		);

		const result = loadProviderOverrides({ cwd: tmpDir });
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("my-local-llm");
		expect(result[0]?.baseUrl).toBe("http://localhost:11434/v1");
	});

	it("throws descriptive error on malformed JSON", () => {
		writeFileSync(join(tmpDir, "config", "providers.json"), "{ invalid-json }");

		expect(() => loadProviderOverrides({ cwd: tmpDir })).toThrow(
			"Invalid provider overrides JSON",
		);
	});

	it("throws descriptive error when required fields are missing", () => {
		writeFileSync(
			join(tmpDir, "config", "providers.json"),
			JSON.stringify({
				providers: [
					{
						id: "broken-provider",
						displayName: "Broken",
						apiKind: "openai",
						riskTier: "compatible",
						authModes: ["api-key"],
						selectionPolicy: {
							enabledByDefault: true,
							eligibleForAutoFallback: false,
							isAutoDefault: false,
						},
						models: [],
					},
				],
			}),
		);

		expect(() => loadProviderOverrides({ cwd: tmpDir })).toThrow(
			"Invalid provider overrides config",
		);
	});
});
