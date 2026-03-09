import { describe, expect, it } from "bun:test";
import {
  BUILT_IN_PROVIDERS,
  BUILT_IN_PROVIDER_IDS,
  getBuiltInProvider,
  mergeProviderOverrides,
} from "../../../src/core/models/provider-catalog.js";
import type { ProviderCatalogEntry } from "../../../src/core/models/provider-types.js";

describe("Provider catalog", () => {
  it("contains all 6 required built-in provider IDs", () => {
    expect(BUILT_IN_PROVIDER_IDS).toHaveLength(6);
    expect(BUILT_IN_PROVIDERS).toHaveLength(6);

    const expectedIds = [
      "anthropic",
      "openai",
      "moonshot",
      "minimax",
      "openai-chatgpt-codex-oauth",
      "anthropic-claude-pro-max-oauth",
    ];

    for (const id of expectedIds) {
      expect((BUILT_IN_PROVIDER_IDS as readonly string[]).includes(id)).toBe(true);
      expect(getBuiltInProvider(id)).toBeDefined();
    }
  });

  it("OpenAI ChatGPT Codex OAuth has exact display name", () => {
    expect(getBuiltInProvider("openai-chatgpt-codex-oauth")?.displayName).toBe(
      "OpenAI ChatGPT Codex OAuth",
    );
  });

  it("Anthropic Claude Pro/Max OAuth has exact display name", () => {
    expect(getBuiltInProvider("anthropic-claude-pro-max-oauth")?.displayName).toBe(
      "Anthropic Claude Pro/Max OAuth",
    );
  });

  it("stable providers have isAutoDefault=true", () => {
    const stableIds = ["anthropic", "openai"];
    for (const id of stableIds) {
      const provider = getBuiltInProvider(id);
      expect(provider).toBeDefined();
      expect(provider!.riskTier).toBe("stable");
      expect(provider!.selectionPolicy.isAutoDefault).toBe(true);
      expect(provider!.selectionPolicy.eligibleForAutoFallback).toBe(true);
    }
  });

  it("experimental providers have isAutoDefault=false and eligibleForAutoFallback=false", () => {
    const experimentalIds = ["openai-chatgpt-codex-oauth", "anthropic-claude-pro-max-oauth"];
    for (const id of experimentalIds) {
      const provider = getBuiltInProvider(id);
      expect(provider).toBeDefined();
      expect(provider!.riskTier).toBe("experimental");
      expect(provider!.selectionPolicy.isAutoDefault).toBe(false);
      expect(provider!.selectionPolicy.eligibleForAutoFallback).toBe(false);
    }
  });

  it("experimental providers have warningMessage", () => {
    const experimentalIds = ["openai-chatgpt-codex-oauth", "anthropic-claude-pro-max-oauth"];
    for (const id of experimentalIds) {
      const provider = getBuiltInProvider(id);
      expect(provider).toBeDefined();
      expect(provider!.warningMessage).toBeDefined();
      expect(typeof provider!.warningMessage).toBe("string");
      expect(provider!.warningMessage!.length).toBeGreaterThan(0);
    }
  });

  it("mergeProviderOverrides replaces built-in entry with matching user override", () => {
    const override: ProviderCatalogEntry = {
      id: "openai",
      displayName: "My Custom OpenAI",
      transportFamily: "openai-compatible",
      apiKind: "openai",
      riskTier: "stable",
      baseUrl: "https://my-proxy.example.com",
      authModes: ["api-key"],
      selectionPolicy: {
        enabledByDefault: true,
        eligibleForAutoFallback: false,
        isAutoDefault: false,
      },
      models: [],
    };

    const merged = mergeProviderOverrides(BUILT_IN_PROVIDERS, [override]);
    const openai = merged.find((p) => p.id === "openai");

    expect(openai).toBeDefined();
    expect(openai!.displayName).toBe("My Custom OpenAI");
    expect(openai!.baseUrl).toBe("https://my-proxy.example.com");
    // Other built-in providers should still be present
    expect(merged.find((p) => p.id === "anthropic")).toBeDefined();
    expect(merged).toHaveLength(6);
  });

  it("mergeProviderOverrides adds new user-defined provider not in built-in list", () => {
    const customProvider: ProviderCatalogEntry = {
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
    };

    const merged = mergeProviderOverrides(BUILT_IN_PROVIDERS, [customProvider]);
    const local = merged.find((p) => p.id === "my-local-llm");

    expect(local).toBeDefined();
    expect(local!.displayName).toBe("My Local LLM");
    expect(merged).toHaveLength(7); // 6 built-in + 1 custom
  });

  it("moonshot baseUrl is https://api.moonshot.ai/v1", () => {
    const moonshot = getBuiltInProvider("moonshot");
    expect(moonshot).toBeDefined();
    expect(moonshot!.baseUrl).toBe("https://api.moonshot.ai/v1");
  });

  it("minimax baseUrl is https://api.minimax.io/v1", () => {
    const minimax = getBuiltInProvider("minimax");
    expect(minimax).toBeDefined();
    expect(minimax!.baseUrl).toBe("https://api.minimax.io/v1");
  });
});
