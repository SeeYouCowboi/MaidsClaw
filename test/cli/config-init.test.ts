import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  registerCommand,
  dispatch,
  resetCommands,
} from "../../src/terminal-cli/parser.js";
import { registerConfigCommands } from "../../src/terminal-cli/commands/config.js";
import type { ConfigInitData } from "../../src/terminal-cli/commands/config.js";
import type { JsonEnvelope } from "../../src/cli/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Capture stdout writes during a callback.
 * Returns the concatenated stdout output.
 */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join("");
}

/** Parse the first JSON line from captured stdout. */
function parseJsonOutput(raw: string): JsonEnvelope<ConfigInitData> {
  const line = raw.trim().split("\n")[0];
  return JSON.parse(line) as JsonEnvelope<ConfigInitData>;
}

// ── Test suite ───────────────────────────────────────────────────────

describe("config init", () => {
  let tempDir: string;

  const EXPECTED_TARGETS = [
    ".env",
    "config/providers.json",
    "config/auth.json",
    "config/agents.json",
    "config/personas.json",
    "config/lore.json",
    "config/runtime.json",
  ];

  beforeEach(() => {
    resetCommands();
    registerConfigCommands();
    // Create a unique temp directory for each test
    tempDir = join(tmpdir(), `maidsclaw-test-init-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── Fresh init creates all 7 files ──────────────────────────────

  it("creates all 7 files with action 'created' on fresh init (JSON)", async () => {
    const raw = await captureStdout(async () => {
      await dispatch(["--json", "--cwd", tempDir, "config", "init"]);
    });

    const envelope = parseJsonOutput(raw);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("config init");
    expect(envelope.data).toBeDefined();
    expect(envelope.data!.files).toHaveLength(7);

    for (const file of envelope.data!.files) {
      expect(file.action).toBe("created");
    }

    // Verify targets match expected set
    const targets = envelope.data!.files.map((f) => f.target);
    expect(targets.sort()).toEqual([...EXPECTED_TARGETS].sort());

    // Verify files actually exist on disk
    for (const target of EXPECTED_TARGETS) {
      expect(existsSync(join(tempDir, target))).toBe(true);
    }
  });

  it("creates all 7 files with action 'created' on fresh init (text)", async () => {
    const raw = await captureStdout(async () => {
      await dispatch(["--cwd", tempDir, "config", "init"]);
    });

    // Verify text output mentions each target
    for (const target of EXPECTED_TARGETS) {
      expect(raw).toContain(target);
      expect(raw).toContain("created");
    }

    // Verify files actually exist on disk
    for (const target of EXPECTED_TARGETS) {
      expect(existsSync(join(tempDir, target))).toBe(true);
    }
  });

  // ── Re-run without --force → all skipped ────────────────────────

  it("reports all files as 'skipped' on re-run without --force", async () => {
    // First run: create
    await captureStdout(async () => {
      await dispatch(["--json", "--cwd", tempDir, "config", "init"]);
    });

    // Reset commands to avoid double-registration
    resetCommands();
    registerConfigCommands();

    // Second run: should skip
    const raw = await captureStdout(async () => {
      await dispatch(["--json", "--cwd", tempDir, "config", "init"]);
    });

    const envelope = parseJsonOutput(raw);
    expect(envelope.ok).toBe(true);
    expect(envelope.data!.files).toHaveLength(7);

    for (const file of envelope.data!.files) {
      expect(file.action).toBe("skipped");
    }
  });

  // ── Re-run with --force → all overwritten ───────────────────────

  it("reports all files as 'overwritten' on re-run with --force", async () => {
    // First run: create
    await captureStdout(async () => {
      await dispatch(["--json", "--cwd", tempDir, "config", "init"]);
    });

    // Reset commands to avoid double-registration
    resetCommands();
    registerConfigCommands();

    // Second run with --force: should overwrite
    const raw = await captureStdout(async () => {
      await dispatch(["--json", "--cwd", tempDir, "config", "init", "--force"]);
    });

    const envelope = parseJsonOutput(raw);
    expect(envelope.ok).toBe(true);
    expect(envelope.data!.files).toHaveLength(7);

    for (const file of envelope.data!.files) {
      expect(file.action).toBe("overwritten");
    }
  });

  // ── --with-runtime includes runtime.json ────────────────────────

  it("--with-runtime includes runtime.json in result", async () => {
    const raw = await captureStdout(async () => {
      await dispatch(["--json", "--cwd", tempDir, "config", "init", "--with-runtime"]);
    });

    const envelope = parseJsonOutput(raw);
    expect(envelope.ok).toBe(true);
    expect(envelope.data!.files).toHaveLength(7);

    const runtimeFile = envelope.data!.files.find(
      (f) => f.target === "config/runtime.json",
    );
    expect(runtimeFile).toBeDefined();
    expect(runtimeFile!.action).toBe("created");
    expect(existsSync(join(tempDir, "config/runtime.json"))).toBe(true);
  });

  // ── Partial skip when some files exist ──────────────────────────

  it("reports mixed actions when some files pre-exist", async () => {
    // Pre-create just .env
    writeFileSync(join(tempDir, ".env"), "PRE_EXISTING=true\n");

    const raw = await captureStdout(async () => {
      await dispatch(["--json", "--cwd", tempDir, "config", "init"]);
    });

    const envelope = parseJsonOutput(raw);
    expect(envelope.ok).toBe(true);

    const envEntry = envelope.data!.files.find((f) => f.target === ".env");
    expect(envEntry!.action).toBe("skipped");

    // Others should be created
    const others = envelope.data!.files.filter((f) => f.target !== ".env");
    for (const file of others) {
      expect(file.action).toBe("created");
    }

    // Pre-existing .env should not be overwritten
    const envContent = readFileSync(join(tempDir, ".env"), "utf-8");
    expect(envContent).toBe("PRE_EXISTING=true\n");
  });

  // ── --force overwrites pre-existing files ───────────────────────

  it("--force overwrites pre-existing files with example content", async () => {
    // Pre-create .env with custom content
    writeFileSync(join(tempDir, ".env"), "OLD_CONTENT=true\n");

    const raw = await captureStdout(async () => {
      await dispatch(["--json", "--cwd", tempDir, "config", "init", "--force"]);
    });

    const envelope = parseJsonOutput(raw);
    const envEntry = envelope.data!.files.find((f) => f.target === ".env");
    expect(envEntry!.action).toBe("overwritten");

    // Content should now be the example file content
    const envContent = readFileSync(join(tempDir, ".env"), "utf-8");
    expect(envContent).toContain("ANTHROPIC_API_KEY");
  });

  // ── Creates config/ directory if not present ────────────────────

  it("creates config/ directory when it does not exist", async () => {
    expect(existsSync(join(tempDir, "config"))).toBe(false);

    await captureStdout(async () => {
      await dispatch(["--json", "--cwd", tempDir, "config", "init"]);
    });

    expect(existsSync(join(tempDir, "config"))).toBe(true);
    expect(existsSync(join(tempDir, "config/agents.json"))).toBe(true);
  });

  // ── Copied files match source content ───────────────────────────

  it("copied files match example source content", async () => {
    await captureStdout(async () => {
      await dispatch(["--json", "--cwd", tempDir, "config", "init"]);
    });

    // Spot-check: runtime.json should match runtime.example.json
    const repoRoot = resolve(import.meta.dir, "..", "..");
    const sourceContent = readFileSync(
      join(repoRoot, "config/runtime.example.json"),
      "utf-8",
    );
    const targetContent = readFileSync(
      join(tempDir, "config/runtime.json"),
      "utf-8",
    );
    expect(targetContent).toBe(sourceContent);
  });

  // ── Quiet mode produces no stdout ───────────────────────────────

  it("--quiet produces no stdout output in text mode", async () => {
    const raw = await captureStdout(async () => {
      await dispatch(["--quiet", "--cwd", tempDir, "config", "init"]);
    });

    expect(raw).toBe("");

    // Files should still be created
    for (const target of EXPECTED_TARGETS) {
      expect(existsSync(join(tempDir, target))).toBe(true);
    }
  });
});
