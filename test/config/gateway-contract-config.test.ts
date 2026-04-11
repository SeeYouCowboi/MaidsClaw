import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthConfig, loadRuntimeConfig } from "../../src/core/config.js";

describe("gateway contract config compatibility", () => {
  let tmpDir = "";
  let authFilePath = "";
  let runtimeFilePath = "";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "maidsclaw-gateway-config-"));
    mkdirSync(tmpDir, { recursive: true });
    authFilePath = join(tmpDir, "auth.json");
    runtimeFilePath = join(tmpDir, "runtime.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts auth config without gateway section", () => {
    writeFileSync(
      authFilePath,
      JSON.stringify({
        credentials: [
          {
            type: "api-key",
            provider: "moonshot",
            apiKey: "sk-test",
          },
        ],
      }),
    );

    const result = loadAuthConfig({ authFilePath });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auth.credentials).toHaveLength(1);
      expect(result.auth.gateway).toBeUndefined();
    }
  });

  it("accepts auth config with optional gateway.tokens[] section", () => {
    writeFileSync(
      authFilePath,
      JSON.stringify({
        credentials: [],
        gateway: {
          tokens: [
            {
              id: "dashboard-read",
              token: "token-read",
              scopes: ["read"],
            },
            {
              id: "dashboard-write",
              token: "token-write",
              scopes: ["write"],
              disabled: false,
            },
          ],
        },
      }),
    );

    const result = loadAuthConfig({ authFilePath });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auth.credentials).toHaveLength(0);
      expect(result.auth.gateway?.tokens).toHaveLength(2);
      expect(result.auth.gateway?.tokens[0]?.scopes).toEqual(["read"]);
      expect(result.auth.gateway?.tokens[1]?.scopes).toEqual(["write"]);
    }
  });

  it("accepts runtime config without runtime.gateway section", () => {
    writeFileSync(
      runtimeFilePath,
      JSON.stringify({
        memory: { embeddingModelId: "text-embedding-3-small" },
        talkerThinker: {
          enabled: true,
          stalenessThreshold: 2,
          softBlockTimeoutMs: 3000,
          softBlockPollIntervalMs: 500,
        },
      }),
    );

    const result = loadRuntimeConfig({ runtimeFilePath });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runtime.memory?.embeddingModelId).toBe("text-embedding-3-small");
      expect(result.runtime.runtime?.gateway?.corsAllowedOrigins).toBeUndefined();
    }
  });

  it("accepts runtime config with optional runtime.gateway.corsAllowedOrigins", () => {
    writeFileSync(
      runtimeFilePath,
      JSON.stringify({
        runtime: {
          gateway: {
            corsAllowedOrigins: ["http://localhost:5173", "https://dashboard.example.com"],
          },
        },
      }),
    );

    const result = loadRuntimeConfig({ runtimeFilePath });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runtime.runtime?.gateway?.corsAllowedOrigins).toEqual([
        "http://localhost:5173",
        "https://dashboard.example.com",
      ]);
    }
  });
});
