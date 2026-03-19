import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliContext } from "../../src/terminal-cli/context.js";
import type { CliDiagnostic } from "../../src/terminal-cli/types.js";

/**
 * To test `handleConfigValidate` without going through dispatch + registerCommand,
 * we import the module and call the handler directly via the registration hook.
 * Since `handleConfigValidate` is not exported, we use an integration approach:
 * import the module (which registers commands), then call dispatch.
 *
 * But for unit tests, it's cleaner to import the handler indirectly.
 * We'll test via the parser dispatch mechanism.
 */
import { dispatch, resetCommands } from "../../src/terminal-cli/parser.js";
import { registerConfigCommands } from "../../src/terminal-cli/commands/config.js";

// ── Temp directory helpers ──────────────────────────────────────────

const tempRoots: string[] = [];

function createTempDir(): string {
  const tempRoot = join(
    import.meta.dir,
    `../../.tmp-config-validate-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

/** Write a valid .env file with at least one API key. */
function writeEnv(tmpRoot: string, content?: string): void {
  writeFileSync(
    join(tmpRoot, ".env"),
    content ?? "ANTHROPIC_API_KEY=sk-test-key\n",
    "utf-8",
  );
}

/** Write a JSON config file under config/. */
function writeConfigJson(tmpRoot: string, fileName: string, data: unknown): void {
  writeFileSync(
    join(tmpRoot, "config", fileName),
    JSON.stringify(data, null, 2),
    "utf-8",
  );
}

/** Write raw string content as a config file. */
function writeConfigRaw(tmpRoot: string, fileName: string, content: string): void {
  writeFileSync(join(tmpRoot, "config", fileName), content, "utf-8");
}

/** Create a minimal valid config set. */
function writeValidConfig(tmpRoot: string): void {
  writeEnv(tmpRoot);
  writeConfigJson(tmpRoot, "providers.json", {
    providers: [{ id: "anthropic", transport: "anthropic" }],
  });
  writeConfigJson(tmpRoot, "agents.json", [
    { id: "rp:alice", role: "rp_agent", personaId: "alice" },
  ]);
  writeConfigJson(tmpRoot, "personas.json", [
    { id: "alice", name: "Alice" },
  ]);
  writeConfigJson(tmpRoot, "lore.json", []);
  writeConfigJson(tmpRoot, "runtime.json", {
    memory: {
      embeddingModelId: "text-embedding-3-small",
      migrationChatModelId: "claude-3-5-sonnet-20241022",
    },
  });
}

/**
 * Capture stdout from a dispatch call.
 * Returns parsed JSON envelope.
 */
async function runValidate(
  tmpRoot: string,
  extraArgs: string[] = [],
): Promise<{ ok: boolean; command: string; data?: { diagnostics: CliDiagnostic[] } }> {
  const originalWrite = process.stdout.write;
  let captured = "";
  process.stdout.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;

  try {
    await dispatch(["--json", "--cwd", tmpRoot, "config", "validate", ...extraArgs]);
  } finally {
    process.stdout.write = originalWrite;
  }

  return JSON.parse(captured.trim());
}

// ── Env var management ──────────────────────────────────────────────

let savedAnthropicKey: string | undefined;
let savedOpenAIKey: string | undefined;
let savedMoonshotKey: string | undefined;
let savedBailianKey: string | undefined;

// ── Test suite ──────────────────────────────────────────────────────

describe("config validate", () => {
  beforeEach(() => {
    resetCommands();
    registerConfigCommands();
    // Save and set env vars so env checks pass by default
    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    savedMoonshotKey = process.env.MOONSHOT_API_KEY;
    savedBailianKey = process.env.BAILIAN_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
  });

  afterEach(() => {
    cleanupTempDirs();
    // Restore env vars
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
    if (savedMoonshotKey !== undefined) {
      process.env.MOONSHOT_API_KEY = savedMoonshotKey;
    } else {
      delete process.env.MOONSHOT_API_KEY;
    }
    if (savedBailianKey !== undefined) {
      process.env.BAILIAN_API_KEY = savedBailianKey;
    } else {
      delete process.env.BAILIAN_API_KEY;
    }
  });

  it("valid config produces empty diagnostics", async () => {
    const tmpRoot = createTempDir();
    writeValidConfig(tmpRoot);

    const result = await runValidate(tmpRoot);

    expect(result.ok).toBe(true);
    expect(result.command).toBe("config validate");
    expect(result.data!.diagnostics).toHaveLength(0);
  });

  it("missing required file emits config.missing_required_file", async () => {
    const tmpRoot = createTempDir();
    // Only write .env, skip providers.json
    writeEnv(tmpRoot);

    const result = await runValidate(tmpRoot);

    expect(result.ok).toBe(false);
    const codes = result.data!.diagnostics.map((d) => d.code);
    expect(codes).toContain("config.missing_required_file");

    const providerDiag = result.data!.diagnostics.find(
      (d) => d.code === "config.missing_required_file" && d.locator === "config/providers.json",
    );
    expect(providerDiag).toBeDefined();
  });

  it("missing .env emits config.missing_required_file", async () => {
    const tmpRoot = createTempDir();
    // Write providers but no .env
    writeConfigJson(tmpRoot, "providers.json", {});

    const result = await runValidate(tmpRoot);

    const envDiag = result.data!.diagnostics.find(
      (d) => d.code === "config.missing_required_file" && d.locator === ".env",
    );
    expect(envDiag).toBeDefined();
  });

  it("malformed JSON emits config.parse_error", async () => {
    const tmpRoot = createTempDir();
    writeEnv(tmpRoot);
    writeConfigRaw(tmpRoot, "providers.json", "{ invalid json }}}");

    const result = await runValidate(tmpRoot);

    expect(result.ok).toBe(false);
    const parseDiag = result.data!.diagnostics.find(
      (d) => d.code === "config.parse_error",
    );
    expect(parseDiag).toBeDefined();
    expect(parseDiag!.locator).toBe("config/providers.json");
  });

  it("missing env vars emits config.missing_required_env", async () => {
    const tmpRoot = createTempDir();
    writeEnv(tmpRoot);
    writeConfigJson(tmpRoot, "providers.json", {});

    // Clear all API keys
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.BAILIAN_API_KEY;

    const result = await runValidate(tmpRoot);

    expect(result.ok).toBe(false);
    const envDiag = result.data!.diagnostics.find(
      (d) => d.code === "config.missing_required_env",
    );
    expect(envDiag).toBeDefined();
    expect(envDiag!.locator).toBe(".env");
  });

  it("having OPENAI_API_KEY alone satisfies env check", async () => {
    const tmpRoot = createTempDir();
    writeValidConfig(tmpRoot);

    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-test";

    const result = await runValidate(tmpRoot);

    const envDiags = result.data!.diagnostics.filter(
      (d) => d.code === "config.missing_required_env",
    );
    expect(envDiags).toHaveLength(0);
  });

  it("RP agent missing submit_rp_turn emits config.rp_missing_submit_rp_turn_permission", async () => {
    const tmpRoot = createTempDir();
    writeEnv(tmpRoot);
    writeConfigJson(tmpRoot, "providers.json", {});
    writeConfigJson(tmpRoot, "agents.json", [
      {
        id: "rp:bad",
        role: "rp_agent",
        toolPermissions: ["memory_read", "memory_search"],
      },
    ]);

    const result = await runValidate(tmpRoot);

    expect(result.ok).toBe(false);
    const rpDiag = result.data!.diagnostics.find(
      (d) => d.code === "config.rp_missing_submit_rp_turn_permission",
    );
    expect(rpDiag).toBeDefined();
  });

  it("duplicate persona IDs emit config.duplicate_persona_id", async () => {
    const tmpRoot = createTempDir();
    writeEnv(tmpRoot);
    writeConfigJson(tmpRoot, "providers.json", {});
    writeConfigJson(tmpRoot, "personas.json", [
      { id: "alice", name: "Alice" },
      { id: "bob", name: "Bob" },
      { id: "alice", name: "Alice 2" },
    ]);

    const result = await runValidate(tmpRoot);

    expect(result.ok).toBe(false);
    const dupDiag = result.data!.diagnostics.find(
      (d) => d.code === "config.duplicate_persona_id",
    );
    expect(dupDiag).toBeDefined();
    expect(dupDiag!.message).toContain("alice");
  });

  it("invalid runtime memory shape emits config.invalid_runtime_memory_shape", async () => {
    const tmpRoot = createTempDir();
    writeEnv(tmpRoot);
    writeConfigJson(tmpRoot, "providers.json", {});
    writeConfigJson(tmpRoot, "runtime.json", {
      memory: "not-an-object",
    });

    const result = await runValidate(tmpRoot);

    expect(result.ok).toBe(false);
    const memDiag = result.data!.diagnostics.find(
      (d) => d.code === "config.invalid_runtime_memory_shape",
    );
    expect(memDiag).toBeDefined();
  });

  it("runtime memory with non-string field emits config.invalid_runtime_memory_shape", async () => {
    const tmpRoot = createTempDir();
    writeEnv(tmpRoot);
    writeConfigJson(tmpRoot, "providers.json", {});
    writeConfigJson(tmpRoot, "runtime.json", {
      memory: {
        embeddingModelId: 42,
      },
    });

    const result = await runValidate(tmpRoot);

    expect(result.ok).toBe(false);
    const memDiag = result.data!.diagnostics.find(
      (d) =>
        d.code === "config.invalid_runtime_memory_shape" &&
        d.locator?.includes("embeddingModelId"),
    );
    expect(memDiag).toBeDefined();
  });

  it("runtime.json as array emits config.invalid_runtime_memory_shape", async () => {
    const tmpRoot = createTempDir();
    writeEnv(tmpRoot);
    writeConfigJson(tmpRoot, "providers.json", {});
    writeConfigJson(tmpRoot, "runtime.json", [1, 2, 3]);

    const result = await runValidate(tmpRoot);

    expect(result.ok).toBe(false);
    const memDiag = result.data!.diagnostics.find(
      (d) => d.code === "config.invalid_runtime_memory_shape",
    );
    expect(memDiag).toBeDefined();
  });

  it("invalid agent role emits config.invalid_agent_role", async () => {
    const tmpRoot = createTempDir();
    writeEnv(tmpRoot);
    writeConfigJson(tmpRoot, "providers.json", {});
    writeConfigJson(tmpRoot, "agents.json", [
      { id: "bad:role", role: "wizard" },
    ]);

    const result = await runValidate(tmpRoot);

    expect(result.ok).toBe(false);
    const roleDiag = result.data!.diagnostics.find(
      (d) => d.code === "config.invalid_agent_role",
    );
    expect(roleDiag).toBeDefined();
  });

  it("duplicate agent IDs emit config.duplicate_agent_id", async () => {
    const tmpRoot = createTempDir();
    writeEnv(tmpRoot);
    writeConfigJson(tmpRoot, "providers.json", {});
    writeConfigJson(tmpRoot, "agents.json", [
      { id: "rp:dup", role: "rp_agent" },
      { id: "rp:dup", role: "rp_agent" },
    ]);

    const result = await runValidate(tmpRoot);

    expect(result.ok).toBe(false);
    const dupDiag = result.data!.diagnostics.find(
      (d) => d.code === "config.duplicate_agent_id",
    );
    expect(dupDiag).toBeDefined();
  });

  it("agent referencing missing persona emits config.agent_persona_not_found", async () => {
    const tmpRoot = createTempDir();
    writeEnv(tmpRoot);
    writeConfigJson(tmpRoot, "providers.json", {});
    writeConfigJson(tmpRoot, "personas.json", [
      { id: "alice", name: "Alice" },
    ]);
    writeConfigJson(tmpRoot, "agents.json", [
      { id: "rp:bad-ref", role: "rp_agent", personaId: "nonexistent" },
    ]);

    const result = await runValidate(tmpRoot);

    expect(result.ok).toBe(false);
    const refDiag = result.data!.diagnostics.find(
      (d) => d.code === "config.agent_persona_not_found",
    );
    expect(refDiag).toBeDefined();
  });

  it("optional files missing does not produce errors", async () => {
    const tmpRoot = createTempDir();
    writeEnv(tmpRoot);
    writeConfigJson(tmpRoot, "providers.json", {});
    // agents.json, personas.json, lore.json, runtime.json are all optional

    const result = await runValidate(tmpRoot);

    expect(result.ok).toBe(true);
    expect(result.data!.diagnostics).toHaveLength(0);
  });

  it("runtime.json without memory section is valid", async () => {
    const tmpRoot = createTempDir();
    writeEnv(tmpRoot);
    writeConfigJson(tmpRoot, "providers.json", {});
    writeConfigJson(tmpRoot, "runtime.json", {});

    const result = await runValidate(tmpRoot);

    const memDiags = result.data!.diagnostics.filter(
      (d) => d.code === "config.invalid_runtime_memory_shape",
    );
    expect(memDiags).toHaveLength(0);
  });

  it("multiple errors are reported together", async () => {
    const tmpRoot = createTempDir();
    // No .env file
    // No providers.json
    // Clear env vars
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.BAILIAN_API_KEY;

    // Write malformed agents.json
    writeConfigRaw(tmpRoot, "agents.json", "not json!");
    // Write personas with duplicates
    writeConfigJson(tmpRoot, "personas.json", [
      { id: "dup", name: "One" },
      { id: "dup", name: "Two" },
    ]);

    const result = await runValidate(tmpRoot);

    expect(result.ok).toBe(false);
    const codes = result.data!.diagnostics.map((d) => d.code);
    expect(codes).toContain("config.missing_required_file"); // .env
    expect(codes).toContain("config.missing_required_file"); // providers.json
    expect(codes).toContain("config.missing_required_env");
    expect(codes).toContain("config.parse_error"); // agents.json
    expect(codes).toContain("config.duplicate_persona_id");
  });
});
