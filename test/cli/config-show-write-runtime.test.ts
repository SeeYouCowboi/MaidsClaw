import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dispatch, resetCommands } from "../../src/terminal-cli/parser.js";
import { registerConfigCommands } from "../../src/terminal-cli/commands/config.js";

// ── Temp directory helpers ──────────────────────────────────────────

const tempRoots: string[] = [];

function createTempDir(): string {
  const tempRoot = join(
    import.meta.dir,
    `../../.tmp-config-show-wr-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(join(tempRoot, "config"), { recursive: true });
  tempRoots.push(tempRoot);
  return tempRoot;
}

function cleanupTempDirs(): void {
  for (const tempRoot of tempRoots.splice(0, tempRoots.length)) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function writeConfigJson(tmpRoot: string, fileName: string, data: unknown): void {
  writeFileSync(
    join(tmpRoot, "config", fileName),
    JSON.stringify(data, null, 2),
    "utf-8",
  );
}

/**
 * Capture stdout from a dispatch call.
 * Returns parsed JSON envelope.
 */
async function captureDispatch(
  argv: string[],
): Promise<Record<string, unknown>> {
  const originalWrite = process.stdout.write;
  let captured = "";
  process.stdout.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;

  try {
    await dispatch(argv);
  } finally {
    process.stdout.write = originalWrite;
  }

  return JSON.parse(captured.trim());
}

// ── Env var management ──────────────────────────────────────────────

let savedAnthropicKey: string | undefined;
let savedOpenAIKey: string | undefined;

// ── Test suite ──────────────────────────────────────────────────────

describe("config show", () => {
  beforeEach(() => {
    resetCommands();
    registerConfigCommands();
    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-anthropic-key";
    process.env.OPENAI_API_KEY = "sk-test-openai-key";
  });

  afterEach(() => {
    cleanupTempDirs();
    if (savedAnthropicKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (savedOpenAIKey !== undefined) {
      process.env.OPENAI_API_KEY = savedOpenAIKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("config show auth --json redacts secrets by default", async () => {
    const tmpRoot = createTempDir();
    writeConfigJson(tmpRoot, "auth.json", {
      credentials: [
        { type: "api-key", provider: "moonshot", apiKey: "sk-real-secret-123" },
        {
          type: "oauth-token",
          provider: "codex",
          accessToken: "oa-real-token-456",
          expiresAt: 9999999999000,
        },
        {
          type: "setup-token",
          provider: "claude-oauth",
          token: "stp-real-token-789",
          expiresAt: 9999999999000,
        },
      ],
    });

    const result = await captureDispatch([
      "--json", "--cwd", tmpRoot, "config", "show", "auth",
    ]);

    expect(result.ok).toBe(true);
    expect(result.command).toBe("config show");

    const data = result.data as { selector: string; sections: { auth: { credentials: Array<Record<string, unknown>> } } };
    expect(data.selector).toBe("auth");

    const creds = data.sections.auth.credentials;
    expect(creds).toHaveLength(3);

    // apiKey should be redacted
    expect(creds[0].apiKey).toBe("***");
    // accessToken should be redacted
    expect(creds[1].accessToken).toBe("***");
    // token should be redacted
    expect(creds[2].token).toBe("***");
  });

  it("config show auth --json --show-secrets shows actual values", async () => {
    const tmpRoot = createTempDir();
    writeConfigJson(tmpRoot, "auth.json", {
      credentials: [
        { type: "api-key", provider: "moonshot", apiKey: "sk-real-secret-123" },
        {
          type: "oauth-token",
          provider: "codex",
          accessToken: "oa-real-token-456",
        },
      ],
    });

    const result = await captureDispatch([
      "--json", "--cwd", tmpRoot, "config", "show", "auth", "--show-secrets",
    ]);

    expect(result.ok).toBe(true);
    const data = result.data as { sections: { auth: { credentials: Array<Record<string, unknown>> } } };
    const creds = data.sections.auth.credentials;

    // Secrets should be visible
    expect(creds[0].apiKey).toBe("sk-real-secret-123");
    expect(creds[1].accessToken).toBe("oa-real-token-456");
  });

  it("config show all returns multiple sections", async () => {
    const tmpRoot = createTempDir();
    writeConfigJson(tmpRoot, "runtime.json", {
      memory: {
        embeddingModelId: "text-embedding-3-small",
        migrationChatModelId: "claude-3-5-sonnet",
      },
    });
    writeConfigJson(tmpRoot, "agents.json", [
      { id: "rp:alice", role: "rp_agent" },
    ]);
    writeConfigJson(tmpRoot, "personas.json", [
      { id: "alice", name: "Alice" },
    ]);
    writeConfigJson(tmpRoot, "auth.json", { credentials: [] });

    const result = await captureDispatch([
      "--json", "--cwd", tmpRoot, "config", "show", "all",
    ]);

    expect(result.ok).toBe(true);
    const data = result.data as { selector: string; sections: Record<string, unknown> };
    expect(data.selector).toBe("all");
    // Should include all expected sections
    expect("server" in data.sections).toBe(true);
    expect("storage" in data.sections).toBe(true);
    expect("memory" in data.sections).toBe(true);
    expect("providers" in data.sections).toBe(true);
    expect("runtime" in data.sections).toBe(true);
    expect("auth" in data.sections).toBe(true);
    expect("agents" in data.sections).toBe(true);
    expect("personas" in data.sections).toBe(true);
  });

  it("config show defaults to all when no selector", async () => {
    const tmpRoot = createTempDir();

    const result = await captureDispatch([
      "--json", "--cwd", tmpRoot, "config", "show",
    ]);

    expect(result.ok).toBe(true);
    const data = result.data as { selector: string; sections: Record<string, unknown> };
    expect(data.selector).toBe("all");
    expect("server" in data.sections).toBe(true);
  });

  it("config show runtime includes effectiveOrganizerEmbeddingModelId", async () => {
    const tmpRoot = createTempDir();
    writeConfigJson(tmpRoot, "runtime.json", {
      memory: {
        embeddingModelId: "text-embedding-3-small",
        migrationChatModelId: "claude-3-5-sonnet",
      },
    });

    const result = await captureDispatch([
      "--json", "--cwd", tmpRoot, "config", "show", "runtime",
    ]);

    expect(result.ok).toBe(true);
    const data = result.data as { sections: { runtime: Record<string, unknown> } };
    // organizerEmbeddingModelId not set → effective falls back to embeddingModelId
    expect(data.sections.runtime.effectiveOrganizerEmbeddingModelId).toBe("text-embedding-3-small");
  });

  it("config show providers --json redacts API keys", async () => {
    const tmpRoot = createTempDir();

    const result = await captureDispatch([
      "--json", "--cwd", tmpRoot, "config", "show", "providers",
    ]);

    expect(result.ok).toBe(true);
    const data = result.data as { sections: { providers: { anthropic: Record<string, unknown>; openai: Record<string, unknown> } } };
    // Provider API keys should be redacted
    expect(data.sections.providers.anthropic.apiKey).toBe("***");
    expect(data.sections.providers.openai.apiKey).toBe("***");
  });

  it("config show rejects invalid selector", async () => {
    const tmpRoot = createTempDir();

    let caught = false;
    try {
      await captureDispatch([
        "--json", "--cwd", tmpRoot, "config", "show", "invalid-section",
      ]);
    } catch (e: unknown) {
      caught = true;
      expect((e as { code: string }).code).toBe("INVALID_SELECTOR");
    }
    expect(caught).toBe(true);
  });
});

describe("config write-runtime", () => {
  beforeEach(() => {
    resetCommands();
    registerConfigCommands();
    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
  });

  afterEach(() => {
    cleanupTempDirs();
    if (savedAnthropicKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (savedOpenAIKey !== undefined) {
      process.env.OPENAI_API_KEY = savedOpenAIKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("creates runtime.json with correct memory section", async () => {
    const tmpRoot = createTempDir();

    const result = await captureDispatch([
      "--json", "--cwd", tmpRoot,
      "config", "write-runtime",
      "--migration-chat-model", "claude-3-5-sonnet-20241022",
      "--embedding-model", "text-embedding-3-small",
    ]);

    expect(result.ok).toBe(true);
    expect(result.command).toBe("config write-runtime");

    const data = result.data as { written: boolean; effectiveOrganizerEmbeddingModelId: string };
    expect(data.written).toBe(true);
    // Organizer defaults to embedding model
    expect(data.effectiveOrganizerEmbeddingModelId).toBe("text-embedding-3-small");

    // Verify file content
    const filePath = join(tmpRoot, "config", "runtime.json");
    expect(existsSync(filePath)).toBe(true);
    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(content.memory.migrationChatModelId).toBe("claude-3-5-sonnet-20241022");
    expect(content.memory.embeddingModelId).toBe("text-embedding-3-small");
    expect(content.memory.organizerEmbeddingModelId).toBe("text-embedding-3-small");
  });

  it("preserves unrelated keys when updating existing file", async () => {
    const tmpRoot = createTempDir();
    // Write existing runtime.json with extra keys
    writeConfigJson(tmpRoot, "runtime.json", {
      customKey: "preserve-me",
      anotherSection: { nested: true },
      memory: {
        embeddingModelId: "old-model",
      },
    });

    const result = await captureDispatch([
      "--json", "--cwd", tmpRoot,
      "config", "write-runtime",
      "--migration-chat-model", "claude-3-5-sonnet",
      "--embedding-model", "text-embedding-3-small",
    ]);

    expect(result.ok).toBe(true);

    // Verify file preserves extra keys
    const filePath = join(tmpRoot, "config", "runtime.json");
    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(content.customKey).toBe("preserve-me");
    expect(content.anotherSection).toEqual({ nested: true });
    // Memory section should be overwritten
    expect(content.memory.migrationChatModelId).toBe("claude-3-5-sonnet");
    expect(content.memory.embeddingModelId).toBe("text-embedding-3-small");
  });

  it("organizer-embedding-model defaults to embedding-model when omitted", async () => {
    const tmpRoot = createTempDir();

    const result = await captureDispatch([
      "--json", "--cwd", tmpRoot,
      "config", "write-runtime",
      "--migration-chat-model", "claude-3-5-sonnet",
      "--embedding-model", "text-embedding-3-large",
    ]);

    const data = result.data as { effectiveOrganizerEmbeddingModelId: string };
    expect(data.effectiveOrganizerEmbeddingModelId).toBe("text-embedding-3-large");

    const content = JSON.parse(readFileSync(join(tmpRoot, "config", "runtime.json"), "utf-8"));
    expect(content.memory.organizerEmbeddingModelId).toBe("text-embedding-3-large");
  });

  it("uses explicit organizer-embedding-model when provided", async () => {
    const tmpRoot = createTempDir();

    const result = await captureDispatch([
      "--json", "--cwd", tmpRoot,
      "config", "write-runtime",
      "--migration-chat-model", "claude-3-5-sonnet",
      "--embedding-model", "text-embedding-3-small",
      "--organizer-embedding-model", "text-embedding-3-large",
    ]);

    const data = result.data as { effectiveOrganizerEmbeddingModelId: string };
    expect(data.effectiveOrganizerEmbeddingModelId).toBe("text-embedding-3-large");

    const content = JSON.parse(readFileSync(join(tmpRoot, "config", "runtime.json"), "utf-8"));
    expect(content.memory.organizerEmbeddingModelId).toBe("text-embedding-3-large");
  });

  it("rejects when --migration-chat-model is missing", async () => {
    const tmpRoot = createTempDir();

    let caught = false;
    try {
      await captureDispatch([
        "--json", "--cwd", tmpRoot,
        "config", "write-runtime",
        "--embedding-model", "text-embedding-3-small",
      ]);
    } catch (e: unknown) {
      caught = true;
      expect((e as { code: string }).code).toBe("MISSING_FLAG");
    }
    expect(caught).toBe(true);
  });

  it("rejects when --embedding-model is missing", async () => {
    const tmpRoot = createTempDir();

    let caught = false;
    try {
      await captureDispatch([
        "--json", "--cwd", tmpRoot,
        "config", "write-runtime",
        "--migration-chat-model", "claude-3-5-sonnet",
      ]);
    } catch (e: unknown) {
      caught = true;
      expect((e as { code: string }).code).toBe("MISSING_FLAG");
    }
    expect(caught).toBe(true);
  });

  it("errors on malformed existing file without --force", async () => {
    const tmpRoot = createTempDir();
    writeFileSync(join(tmpRoot, "config", "runtime.json"), "{ bad json }", "utf-8");

    let caught = false;
    try {
      await captureDispatch([
        "--json", "--cwd", tmpRoot,
        "config", "write-runtime",
        "--migration-chat-model", "claude-3-5-sonnet",
        "--embedding-model", "text-embedding-3-small",
      ]);
    } catch (e: unknown) {
      caught = true;
      expect((e as { code: string }).code).toBe("CONFIG_PARSE_ERROR");
    }
    expect(caught).toBe(true);
  });

  it("overwrites malformed file with --force", async () => {
    const tmpRoot = createTempDir();
    writeFileSync(join(tmpRoot, "config", "runtime.json"), "{ bad json }", "utf-8");

    const result = await captureDispatch([
      "--json", "--cwd", tmpRoot,
      "config", "write-runtime",
      "--migration-chat-model", "claude-3-5-sonnet",
      "--embedding-model", "text-embedding-3-small",
      "--force",
    ]);

    expect(result.ok).toBe(true);
    const content = JSON.parse(readFileSync(join(tmpRoot, "config", "runtime.json"), "utf-8"));
    expect(content.memory.migrationChatModelId).toBe("claude-3-5-sonnet");
  });

  it("creates config directory if missing", async () => {
    const tempRoot = join(
      import.meta.dir,
      `../../.tmp-config-show-wr-nodir-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    tempRoots.push(tempRoot);
    mkdirSync(tempRoot, { recursive: true });
    // Don't create config/ subdirectory

    const result = await captureDispatch([
      "--json", "--cwd", tempRoot,
      "config", "write-runtime",
      "--migration-chat-model", "claude-3-5-sonnet",
      "--embedding-model", "text-embedding-3-small",
    ]);

    expect(result.ok).toBe(true);
    expect(existsSync(join(tempRoot, "config", "runtime.json"))).toBe(true);
  });
});
