import { describe, expect, it, beforeEach } from "bun:test";
import {
  registerCommand,
  dispatch,
  resetCommands,
} from "../../src/cli/parser.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/context.js";
import { CliError, EXIT_USAGE } from "../../src/cli/errors.js";

describe("CLI Parser", () => {
  beforeEach(() => {
    resetCommands();
  });

  // ── Route dispatch ───────────────────────────────────────────────

  it("dispatches to a valid namespace-only command", async () => {
    let called = false;
    registerCommand({
      namespace: "health",
      handler: async () => {
        called = true;
      },
    });

    await dispatch(["health"]);
    expect(called).toBe(true);
  });

  it("dispatches to a valid subcommand route", async () => {
    let captured: string | undefined;
    registerCommand({
      namespace: "config",
      subcommand: "show",
      handler: async () => {
        captured = "config show";
      },
    });

    await dispatch(["config", "show"]);
    expect(captured).toBe("config show");
  });

  it("passes command-specific positional args to handler", async () => {
    let capturedArgs: ParsedArgs | undefined;
    registerCommand({
      namespace: "agent",
      subcommand: "show",
      handler: async (_ctx, args) => {
        capturedArgs = args;
      },
    });

    await dispatch(["agent", "show", "maid-01"]);
    expect(capturedArgs?.positional).toEqual(["maid-01"]);
  });

  it("passes command-specific flags to handler", async () => {
    let capturedArgs: ParsedArgs | undefined;
    registerCommand({
      namespace: "test",
      handler: async (_ctx, args) => {
        capturedArgs = args;
      },
    });

    await dispatch(["test", "--verbose"]);
    expect(capturedArgs?.flags).toEqual({ verbose: true });
  });

  it("passes command-specific flag values to handler", async () => {
    let capturedArgs: ParsedArgs | undefined;
    registerCommand({
      namespace: "test",
      handler: async (_ctx, args) => {
        capturedArgs = args;
      },
    });

    await dispatch(["test", "--output", "file.txt"]);
    expect(capturedArgs?.flags).toEqual({ output: "file.txt" });
  });

  // ── Unknown command / subcommand ─────────────────────────────────

  it("throws CliError with exit 2 on unknown command", async () => {
    registerCommand({
      namespace: "known",
      handler: async () => {},
    });

    try {
      await dispatch(["unknown"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err instanceof CliError).toBe(true);
      expect((err as CliError).exitCode).toBe(2);
      expect((err as CliError).code).toBe("UNKNOWN_COMMAND");
    }
  });

  it("throws CliError with exit 2 on unknown subcommand", async () => {
    registerCommand({
      namespace: "config",
      subcommand: "show",
      handler: async () => {},
    });

    try {
      await dispatch(["config", "bad"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err instanceof CliError).toBe(true);
      expect((err as CliError).exitCode).toBe(2);
      expect((err as CliError).code).toBe("UNKNOWN_SUBCOMMAND");
    }
  });

  it("throws CliError with exit 2 when no command provided", async () => {
    registerCommand({ namespace: "test", handler: async () => {} });

    try {
      await dispatch([]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err instanceof CliError).toBe(true);
      expect((err as CliError).exitCode).toBe(2);
      expect((err as CliError).code).toBe("NO_COMMAND");
    }
  });

  it("throws CliError when namespace requires subcommand but none given", async () => {
    registerCommand({
      namespace: "config",
      subcommand: "show",
      handler: async () => {},
    });

    try {
      await dispatch(["config"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err instanceof CliError).toBe(true);
      expect((err as CliError).exitCode).toBe(2);
      expect((err as CliError).code).toBe("UNKNOWN_SUBCOMMAND");
    }
  });

  // ── Global flags ─────────────────────────────────────────────────

  it("parses --json flag correctly (before command)", async () => {
    let capturedCtx: CliContext | undefined;
    registerCommand({
      namespace: "test",
      handler: async (ctx) => {
        capturedCtx = ctx;
      },
    });

    await dispatch(["--json", "test"]);
    expect(capturedCtx?.json).toBe(true);
  });

  it("parses --json flag correctly (after command)", async () => {
    let capturedCtx: CliContext | undefined;
    registerCommand({
      namespace: "test",
      handler: async (ctx) => {
        capturedCtx = ctx;
      },
    });

    await dispatch(["test", "--json"]);
    expect(capturedCtx?.json).toBe(true);
  });

  it("parses --quiet flag correctly", async () => {
    let capturedCtx: CliContext | undefined;
    registerCommand({
      namespace: "test",
      handler: async (ctx) => {
        capturedCtx = ctx;
      },
    });

    await dispatch(["--quiet", "test"]);
    expect(capturedCtx?.quiet).toBe(true);
  });

  it("parses --cwd <path> correctly", async () => {
    let capturedCtx: CliContext | undefined;
    registerCommand({
      namespace: "test",
      handler: async (ctx) => {
        capturedCtx = ctx;
      },
    });

    await dispatch(["--cwd", "/tmp", "test"]);
    expect(capturedCtx?.cwd).toBe("/tmp");
  });

  it("throws CliError when --cwd has no value", async () => {
    registerCommand({ namespace: "test", handler: async () => {} });

    try {
      await dispatch(["--cwd"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err instanceof CliError).toBe(true);
      expect((err as CliError).exitCode).toBe(2);
      expect((err as CliError).code).toBe("MISSING_CWD_VALUE");
    }
  });

  it("default context has json=false, quiet=false, mode=local", async () => {
    let capturedCtx: CliContext | undefined;
    registerCommand({
      namespace: "test",
      handler: async (ctx) => {
        capturedCtx = ctx;
      },
    });

    await dispatch(["test"]);
    expect(capturedCtx?.json).toBe(false);
    expect(capturedCtx?.quiet).toBe(false);
    expect(capturedCtx?.mode).toBe("local");
  });

  // ── chat --json rejection ────────────────────────────────────────

  it("chat --json returns error code 2", async () => {
    registerCommand({
      namespace: "chat",
      handler: async (ctx) => {
        if (ctx.json) {
          throw new CliError(
            "INVALID_FLAG",
            "chat does not support --json",
            EXIT_USAGE,
          );
        }
      },
    });

    try {
      await dispatch(["chat", "--json"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err instanceof CliError).toBe(true);
      expect((err as CliError).exitCode).toBe(2);
      expect((err as CliError).code).toBe("INVALID_FLAG");
    }
  });

  // ── --help ───────────────────────────────────────────────────────

  it("--help does not throw", async () => {
    registerCommand({ namespace: "test", handler: async () => {} });

    // Should resolve without throwing
    await dispatch(["--help"]);
  });

  // ── Multiple global flags combined ───────────────────────────────

  it("handles multiple global flags together", async () => {
    let capturedCtx: CliContext | undefined;
    registerCommand({
      namespace: "test",
      handler: async (ctx) => {
        capturedCtx = ctx;
      },
    });

    await dispatch(["--json", "--quiet", "--cwd", "/opt", "test"]);
    expect(capturedCtx?.json).toBe(true);
    expect(capturedCtx?.quiet).toBe(true);
    expect(capturedCtx?.cwd).toBe("/opt");
  });
});
