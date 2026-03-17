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
import { registerConfigCommands } from "../src/cli/commands/config.js";
import { registerAgentCommands } from "../src/cli/commands/agent.js";
import { registerServerCommands } from "../src/cli/commands/server.js";
import { registerHealthCommand } from "../src/cli/commands/health.js";
import { registerSessionCommands } from "../src/cli/commands/session.js";
import { registerTurnCommands } from "../src/cli/commands/turn.js";
import { registerChatCommand } from "../src/cli/commands/chat.js";

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

// config namespace — real handler from src/cli/commands/config.ts
registerConfigCommands();

// server namespace — real handler from src/cli/commands/server.ts
registerServerCommands();

// health — real handler from src/cli/commands/health.ts
registerHealthCommand();

// agent namespace — real handlers from src/cli/commands/agent.ts
registerAgentCommands();

// session namespace — real handlers from src/cli/commands/session.ts
registerSessionCommands();

// turn namespace — real handler from src/cli/commands/turn.ts
registerTurnCommands();

// chat — real handler from src/cli/commands/chat.ts
registerChatCommand();

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
