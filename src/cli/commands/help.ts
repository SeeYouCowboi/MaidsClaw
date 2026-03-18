/**
 * CLI help command.
 *
 * `help`             — show all commands grouped by namespace
 * `help <namespace>` — show subcommands for a specific namespace
 */

import { registerCommand, getRoutes } from "../parser.js";
import type { CliContext, } from "../context.js";
import type { ParsedArgs } from "../parser.js";
import { writeText } from "../output.js";

// ── Namespace-level descriptions ─────────────────────────────────────

const NAMESPACE_DESCRIPTIONS: Record<string, string> = {
  config: "Configuration management",
  server: "Gateway HTTP server",
  health: "Runtime health checks",
  agent: "Agent management",
  session: "Session lifecycle",
  turn: "Conversation turns",
  chat: "Interactive chat shell",
  debug: "Debugging and inspection",
  help: "Show this help",
};

// ── Handler ──────────────────────────────────────────────────────────

async function handleHelp(
  _ctx: CliContext,
  args: ParsedArgs,
): Promise<void> {
  const target = args.positional[0];

  if (target) {
    showNamespaceHelp(target);
  } else {
    showOverview();
  }
}

function showOverview(): void {
  const routes = getRoutes();
  const namespaces = [...new Set(routes.map((r) => r.namespace))];

  writeText("MaidsClaw CLI\n");
  writeText("Usage: bun cli <command> [subcommand] [flags]\n");
  writeText("Commands:");

  for (const ns of namespaces) {
    const desc = NAMESPACE_DESCRIPTIONS[ns] ?? "";
    const nsRoutes = routes.filter((r) => r.namespace === ns);
    const subs = nsRoutes
      .filter((r) => r.subcommand)
      .map((r) => r.subcommand!);

    const subList = subs.length > 0 ? ` {${subs.join(", ")}}` : "";
    const descStr = desc ? `  ${desc}` : "";
    writeText(`  ${ns}${subList}${descStr}`);
  }

  writeText("\nGlobal flags:");
  writeText("  --json          Output in JSON format");
  writeText("  --quiet         Suppress non-essential output");
  writeText("  --cwd <path>    Override working directory");
  writeText("\nRun 'bun cli help <command>' for details on a specific command.");
}

function showNamespaceHelp(namespace: string): void {
  const routes = getRoutes();
  const nsRoutes = routes.filter((r) => r.namespace === namespace);

  if (nsRoutes.length === 0) {
    const known = [...new Set(routes.map((r) => r.namespace))];
    writeText(`Unknown command: "${namespace}". Available: ${known.join(", ")}`);
    return;
  }

  const desc = NAMESPACE_DESCRIPTIONS[namespace] ?? "";
  writeText(`${namespace}${desc ? ` — ${desc}` : ""}\n`);

  const hasSubcommands = nsRoutes.some((r) => r.subcommand);

  if (hasSubcommands) {
    writeText(`Usage: bun cli ${namespace} <subcommand> [flags]\n`);
    writeText("Subcommands:");

    const maxLen = Math.max(...nsRoutes.map((r) => (r.subcommand ?? "").length));
    for (const route of nsRoutes) {
      if (!route.subcommand) continue;
      const pad = route.subcommand.padEnd(maxLen + 2);
      const rdesc = route.description ?? "";
      writeText(`  ${pad}${rdesc}`);
    }
  } else {
    writeText(`Usage: bun cli ${namespace} [flags]`);
    const rdesc = nsRoutes[0]?.description;
    if (rdesc) {
      writeText(`\n  ${rdesc}`);
    }
  }
}

// ── Registration ─────────────────────────────────────────────────────

export function registerHelpCommand(): void {
  registerCommand({
    namespace: "help",
    description: "Show usage information",
    handler: handleHelp,
  });
}
