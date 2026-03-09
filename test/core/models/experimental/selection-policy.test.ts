import { describe, expect, it } from "bun:test";
import { SelectionPolicyGuard } from "../../../../src/core/models/experimental/selection-policy.js";
import { BUILT_IN_PROVIDERS } from "../../../../src/core/models/provider-catalog.js";

describe("SelectionPolicyGuard", () => {
  it("marks openai-chatgpt-codex-oauth as not eligible for auto-default", () => {
    const guard = new SelectionPolicyGuard([...BUILT_IN_PROVIDERS]);
    expect(guard.isEligibleForAutoDefault("openai-chatgpt-codex-oauth")).toBe(false);
  });

  it("marks anthropic-claude-pro-max-oauth as not eligible for auto-fallback", () => {
    const guard = new SelectionPolicyGuard([...BUILT_IN_PROVIDERS]);
    expect(guard.isEligibleForAutoFallback("anthropic-claude-pro-max-oauth")).toBe(false);
  });

  it("marks anthropic and openai as eligible for auto-default and auto-fallback", () => {
    const guard = new SelectionPolicyGuard([...BUILT_IN_PROVIDERS]);
    expect(guard.isEligibleForAutoDefault("anthropic")).toBe(true);
    expect(guard.isEligibleForAutoFallback("anthropic")).toBe(true);
    expect(guard.isEligibleForAutoDefault("openai")).toBe(true);
    expect(guard.isEligibleForAutoFallback("openai")).toBe(true);
  });

  it("includes experimental providers in discoverable set when credentials exist", () => {
    const guard = new SelectionPolicyGuard([...BUILT_IN_PROVIDERS]);
    const discoverable = guard.getDiscoverableProviders({
      credentials: [
        {
          provider: "openai-chatgpt-codex-oauth",
          type: "oauth-token",
          accessToken: "oauth-token",
        },
        {
          provider: "anthropic-claude-pro-max-oauth",
          type: "setup-token",
          token: "setup-token",
        },
      ],
    });

    const ids = discoverable.map((provider) => provider.id);
    expect(ids).toContain("openai-chatgpt-codex-oauth");
    expect(ids).toContain("anthropic-claude-pro-max-oauth");
  });

  it("excludes experimental providers from auto-selectable set even with credentials", () => {
    const guard = new SelectionPolicyGuard([...BUILT_IN_PROVIDERS]);
    const autoSelectable = guard.getAutoSelectableProviders({
      credentials: [
        {
          provider: "openai-chatgpt-codex-oauth",
          type: "oauth-token",
          accessToken: "oauth-token",
        },
        {
          provider: "anthropic-claude-pro-max-oauth",
          type: "setup-token",
          token: "setup-token",
        },
        {
          provider: "openai",
          type: "api-key",
          apiKey: "sk-openai",
        },
        {
          provider: "anthropic",
          type: "api-key",
          apiKey: "sk-anthropic",
        },
      ],
    });

    const ids = autoSelectable.map((provider) => provider.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("anthropic");
    expect(ids.includes("openai-chatgpt-codex-oauth")).toBe(false);
    expect(ids.includes("anthropic-claude-pro-max-oauth")).toBe(false);
  });
});
