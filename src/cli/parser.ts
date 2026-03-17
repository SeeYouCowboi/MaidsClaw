/**
 * Table-driven CLI argument parser.
 *
 * Zero runtime dependencies. Commands self-register via `registerCommand()`,
 * and `dispatch()` resolves the correct handler from process.argv.
 */

import { parseGlobalFlags } from "./context.js";
import type { CliContext } from "./context.js";
import { CliError, EXIT_RUNTIME, EXIT_USAGE } from "./errors.js";
import { writeError } from "./output.js";

// ── Types ────────────────────────────────────────────────────────────

/** Parsed positional args and flags for a command handler. */
export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

/** Handler signature — every command implements this. */
export type CommandHandler = (
  ctx: CliContext,
  args: ParsedArgs,
) => Promise<void>;

/** A single route in the command table. */
export type CommandRoute = {
  namespace: string;
  subcommand?: string;
  handler: CommandHandler;
};

// ── Command table (module-level, mutable) ────────────────────────────

const routes: CommandRoute[] = [];

/** Register a command route. */
export function registerCommand(route: CommandRoute): void {
  routes.push(route);
}

/** Clear all registered commands. Exported for testing only. */
export function resetCommands(): void {
  routes.length = 0;
}

// ── Internal helpers ─────────────────────────────────────────────────

function getKnownNamespaces(): string[] {
  return [...new Set(routes.map((r) => r.namespace))];
}

function parseCommandArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }

  return { positional, flags };
}

function showUsage(): void {
  const namespaces = getKnownNamespaces();
  const lines = [
    "Usage: maidsclaw <command> [subcommand] [flags]",
    "",
    "Commands:",
    ...namespaces.map((ns) => `  ${ns}`),
    "",
    "Global flags:",
    "  --json          Output in JSON format",
    "  --quiet         Suppress non-essential output",
    "  --cwd <path>    Override working directory",
  ];
  process.stderr.write(lines.join("\n") + "\n");
}

// ── dispatch ─────────────────────────────────────────────────────────

/**
 * Parse argv, resolve a matching route, and call its handler.
 *
 * - Success: resolves normally (handler writes its own output).
 * - Error: writes error output via {@link writeError}, then throws {@link CliError}.
 *
 * The entry point (`scripts/cli.ts`) catches the thrown error and calls `process.exit()`.
 */
export async function dispatch(argv: string[]): Promise<void> {
  // 1. Parse global flags
  let ctx: CliContext;
  let rest: string[];

  try {
    const result = parseGlobalFlags(argv);
    ctx = result.context;
    rest = result.rest;
  } catch (err) {
    if (err instanceof CliError) {
      // Best-effort context for early errors (before ctx is built)
      const fallback: CliContext = {
        cwd: process.cwd(),
        json: argv.includes("--json"),
        quiet: argv.includes("--quiet"),
        mode: "local",
      };
      writeError(fallback, err);
      throw err;
    }
    throw err;
  }

  // 2. No command provided
  if (rest.length === 0) {
    const err = new CliError(
      "NO_COMMAND",
      "No command provided. Run with --help for usage.",
      EXIT_USAGE,
    );
    if (ctx.json) {
      writeError(ctx, err);
    } else {
      showUsage();
    }
    throw err;
  }

  // 3. Top-level --help
  if (rest[0] === "--help" || rest[0] === "-h") {
    showUsage();
    return;
  }

  // 4. Resolve namespace
  const namespace = rest[0];
  const knownNamespaces = getKnownNamespaces();

  if (!knownNamespaces.includes(namespace)) {
    const err = new CliError(
      "UNKNOWN_COMMAND",
      `Unknown command: "${namespace}". Available: ${knownNamespaces.join(", ")}`,
      EXIT_USAGE,
    );
    writeError(ctx, err, namespace);
    throw err;
  }

  // 5. Resolve subcommand
  const candidateSub =
    rest.length > 1 && !rest[1].startsWith("-") ? rest[1] : undefined;
  let route: CommandRoute | undefined;
  let commandArgsStart = 1; // default: skip namespace only

  if (candidateSub) {
    route = routes.find(
      (r) => r.namespace === namespace && r.subcommand === candidateSub,
    );
    if (route) {
      commandArgsStart = 2; // skip namespace + subcommand
    }
  }

  if (!route) {
    // Try namespace-only handler
    route = routes.find((r) => r.namespace === namespace && !r.subcommand);
    if (route) {
      commandArgsStart = 1;
    }
  }

  if (!route) {
    const availableSubs = routes
      .filter((r) => r.namespace === namespace && r.subcommand)
      .map((r) => r.subcommand!);

    const msg = candidateSub
      ? `Unknown subcommand "${candidateSub}" for "${namespace}". Available: ${availableSubs.join(", ")}`
      : `"${namespace}" requires a subcommand. Available: ${availableSubs.join(", ")}`;

    const err = new CliError("UNKNOWN_SUBCOMMAND", msg, EXIT_USAGE);
    writeError(ctx, err, namespace);
    throw err;
  }

  // 6. Parse command-specific args
  const commandArgv = rest.slice(commandArgsStart);
  const args = parseCommandArgs(commandArgv);

  // 7. Build command name for error output
  const commandName = route.subcommand
    ? `${namespace} ${route.subcommand}`
    : namespace;

  // 8. Call handler
  try {
    await route.handler(ctx, args);
  } catch (err) {
    if (err instanceof CliError) {
      writeError(ctx, err, commandName);
      throw err;
    }
    // Wrap unknown errors
    const cliErr = new CliError(
      "INTERNAL_ERROR",
      err instanceof Error ? err.message : String(err),
      EXIT_RUNTIME,
    );
    writeError(ctx, cliErr, commandName);
    throw cliErr;
  }
}
