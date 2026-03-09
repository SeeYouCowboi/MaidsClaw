import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { loadAuthConfig, resolveProviderCredential } from "../../src/core/config.js";

// Use a temp directory for auth.json fixtures to avoid polluting real config/
describe("Auth config loading", () => {
  const tmpDir = join(process.cwd(), ".tmp-auth-test-" + Date.now());
  const tmpAuthFile = join(tmpDir, "auth.json");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    // Clear relevant env vars
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.OPENAI_CODEX_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_SETUP_TOKEN;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns ok:true with empty credentials when auth.json does not exist", () => {
    const result = loadAuthConfig({ authFilePath: tmpAuthFile });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auth.credentials).toHaveLength(0);
    }
  });

  it("loads valid auth.json with api-key credential", () => {
    writeFileSync(tmpAuthFile, JSON.stringify({
      credentials: [{ type: "api-key", provider: "moonshot", apiKey: "sk-test" }]
    }));
    const result = loadAuthConfig({ authFilePath: tmpAuthFile });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auth.credentials).toHaveLength(1);
      const cred = result.auth.credentials[0];
      expect(cred?.type).toBe("api-key");
      if (cred?.type === "api-key") {
        expect(cred.provider).toBe("moonshot");
        expect(cred.apiKey).toBe("sk-test");
      }
    }
  });

  it("loads valid auth.json with oauth-token credential", () => {
    writeFileSync(tmpAuthFile, JSON.stringify({
      credentials: [{ type: "oauth-token", provider: "openai-chatgpt-codex-oauth", accessToken: "oa-abc", expiresAt: 9999999999000 }]
    }));
    const result = loadAuthConfig({ authFilePath: tmpAuthFile });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const cred = result.auth.credentials[0];
      expect(cred?.type).toBe("oauth-token");
    }
  });

  it("loads valid auth.json with setup-token credential", () => {
    writeFileSync(tmpAuthFile, JSON.stringify({
      credentials: [{ type: "setup-token", provider: "anthropic-claude-pro-max-oauth", token: "stp-test" }]
    }));
    const result = loadAuthConfig({ authFilePath: tmpAuthFile });
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with CONFIG_ERROR for malformed JSON", () => {
    writeFileSync(tmpAuthFile, "{ bad json }");
    const result = loadAuthConfig({ authFilePath: tmpAuthFile });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.type === "CONFIG_ERROR")).toBe(true);
      expect(result.errors.some(e => e.message.toLowerCase().includes("json"))).toBe(true);
    }
  });

  it("returns ok:false when credentials is not an array", () => {
    writeFileSync(tmpAuthFile, JSON.stringify({ credentials: "not-an-array" }));
    const result = loadAuthConfig({ authFilePath: tmpAuthFile });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when a credential has unknown type", () => {
    writeFileSync(tmpAuthFile, JSON.stringify({
      credentials: [{ type: "invalid-type", provider: "foo", apiKey: "bar" }]
    }));
    const result = loadAuthConfig({ authFilePath: tmpAuthFile });
    expect(result.ok).toBe(false);
  });

  it("env var overrides file-based credential for same provider", () => {
    writeFileSync(tmpAuthFile, JSON.stringify({
      credentials: [{ type: "api-key", provider: "moonshot", apiKey: "file-key" }]
    }));
    process.env.MOONSHOT_API_KEY = "env-key";
    const result = loadAuthConfig({ authFilePath: tmpAuthFile });
    if (!result.ok) throw new Error("Expected ok");
    const cred = resolveProviderCredential("moonshot", result.auth);
    expect(cred?.type).toBe("api-key");
    if (cred?.type === "api-key") {
      expect(cred.apiKey).toBe("env-key");  // env wins
    }
  });

  it("resolveProviderCredential returns null for unconfigured provider", () => {
    const cred = resolveProviderCredential("unknown-provider", { credentials: [] });
    expect(cred).toBeNull();
  });

  it("resolveProviderCredential returns api-key from file when no env var set", () => {
    const auth = { credentials: [{ type: "api-key" as const, provider: "minimax", apiKey: "minimax-key" }] };
    const cred = resolveProviderCredential("minimax", auth);
    expect(cred?.type).toBe("api-key");
    if (cred?.type === "api-key") {
      expect(cred.apiKey).toBe("minimax-key");
    }
  });
});
