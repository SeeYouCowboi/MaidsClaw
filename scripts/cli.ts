#!/usr/bin/env bun

/**
 * MaidsClaw CLI entry point.
 *
 * Dispatches process.argv to registered command handlers.
 * Heavy runtime modules are lazy-imported inside individual command handlers,
 * NOT at the top level of this file.
 */

import { registerAgentCommands } from "../src/cli/commands/agent.js";
import { registerChatCommand } from "../src/cli/commands/chat.js";
import { registerConfigCommands } from "../src/cli/commands/config.js";
import { registerDebugCommands } from "../src/cli/commands/debug.js";
import { registerHealthCommand } from "../src/cli/commands/health.js";
import { registerServerCommands } from "../src/cli/commands/server.js";
import { registerSessionCommands } from "../src/cli/commands/session.js";
import { registerTurnCommands } from "../src/cli/commands/turn.js";
import { CliError, EXIT_RUNTIME } from "../src/cli/errors.js";
import { dispatch } from "../src/cli/parser.js";

// ── Register commands ────────────────────────────────────────────────

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

// debug namespace — real handlers from src/cli/commands/debug.ts
registerDebugCommands();

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
