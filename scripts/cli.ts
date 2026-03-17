#!/usr/bin/env bun
/**
 * MaidsClaw CLI entry point.
 *
 * Dispatches process.argv to registered command handlers.
 * Heavy runtime modules are lazy-imported inside individual command handlers,
 * NOT at the top level of this file.
 */

import { CliError, EXIT_RUNTIME, EXIT_USAGE } from "../src/cli/errors.js";
import { writeJson, writeText } from "../src/cli/output.js";
import { registerCommand, dispatch } from "../src/cli/parser.js";
import type { CliContext } from "../src/cli/context.js";
import type { CommandHandler, ParsedArgs } from "../src/cli/parser.js";

// ── Stub handler factory ─────────────────────────────────────────────

/**
 * Create a stub handler for a not-yet-implemented command.
 * Rejects unknown flags and returns a placeholder response.
 */
function stubHandler(commandName: string): CommandHandler {
  return async (ctx: CliContext, args: ParsedArgs): Promise<void> => {
    // Reject unknown flags — stubs accept no flags
    const unknownFlags = Object.keys(args.flags);
    if (unknownFlags.length > 0) {
      throw new CliError(
        "UNKNOWN_FLAGS",
        `Unknown flag(s) for "${commandName}": ${unknownFlags.map((f) => `--${f}`).join(", ")}`,
        EXIT_USAGE,
      );
    }

    // Stub response
    if (ctx.json) {
      writeJson({
        ok: true,
        command: commandName,
        mode: ctx.mode,
        data: { status: "not_implemented" },
      });
    } else if (!ctx.quiet) {
      writeText(`${commandName}: not yet implemented`);
    }
  };
}

// ── Register command stubs ───────────────────────────────────────────

// config namespace
for (const sub of ["init", "validate", "doctor", "show", "write-runtime"]) {
  registerCommand({
    namespace: "config",
    subcommand: sub,
    handler: stubHandler(`config ${sub}`),
  });
}

// server namespace
registerCommand({
  namespace: "server",
  subcommand: "start",
  handler: stubHandler("server start"),
});

// health (namespace-only, no subcommand)
registerCommand({
  namespace: "health",
  handler: stubHandler("health"),
});

// agent namespace
for (const sub of [
  "list",
  "show",
  "create-rp",
  "create-task",
  "enable",
  "disable",
  "remove",
  "validate",
]) {
  registerCommand({
    namespace: "agent",
    subcommand: sub,
    handler: stubHandler(`agent ${sub}`),
  });
}

// session namespace
for (const sub of ["create", "close", "recover"]) {
  registerCommand({
    namespace: "session",
    subcommand: sub,
    handler: stubHandler(`session ${sub}`),
  });
}

// turn namespace
registerCommand({
  namespace: "turn",
  subcommand: "send",
  handler: stubHandler("turn send"),
});

// chat (namespace-only, interactive — REJECTS --json)
registerCommand({
  namespace: "chat",
  handler: async (ctx: CliContext, args: ParsedArgs): Promise<void> => {
    // chat is the ONLY interactive command — it MUST NOT use the JSON stdout path
    if (ctx.json) {
      throw new CliError(
        "INVALID_FLAG",
        "chat command does not support --json mode",
        EXIT_USAGE,
      );
    }

    // Reject unknown flags
    const unknownFlags = Object.keys(args.flags);
    if (unknownFlags.length > 0) {
      throw new CliError(
        "UNKNOWN_FLAGS",
        `Unknown flag(s) for "chat": ${unknownFlags.map((f) => `--${f}`).join(", ")}`,
        EXIT_USAGE,
      );
    }

    if (!ctx.quiet) {
      writeText("chat: interactive mode not yet implemented");
    }
  },
});

// debug namespace
for (const sub of [
  "summary",
  "transcript",
  "prompt",
  "chunks",
  "logs",
  "memory",
  "trace",
  "diagnose",
]) {
  registerCommand({
    namespace: "debug",
    subcommand: sub,
    handler: stubHandler(`debug ${sub}`),
  });
}

// ── Entry point ──────────────────────────────────────────────────────

dispatch(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof CliError) {
    // writeError already called by dispatch — just exit with the code
    process.exit(err.exitCode);
  }
  // Unexpected non-CLI error
  console.error("Unexpected error:", err);
  process.exit(EXIT_RUNTIME);
});
