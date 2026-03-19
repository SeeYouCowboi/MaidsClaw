/**
 * CLI context — the global flags and environment visible to every command handler.
 */

import type { CliMode } from "./types.js";
import { CliError, EXIT_USAGE } from "./errors.js";

// ── CliContext ────────────────────────────────────────────────────────

/** Immutable context built from global CLI flags. */
export interface CliContext {
  readonly cwd: string;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly mode: CliMode;
}

// ── parseGlobalFlags ─────────────────────────────────────────────────

/** Result of extracting global flags from argv. */
export interface GlobalFlagsResult {
  context: CliContext;
  /** Remaining argv elements after global flags are extracted. */
  rest: string[];
}

/**
 * Extract `--json`, `--quiet`, and `--cwd <path>` from anywhere in argv.
 * Everything else is passed through in `rest` (preserving order).
 *
 * @throws {CliError} if `--cwd` is present but has no value.
 */
export function parseGlobalFlags(argv: string[]): GlobalFlagsResult {
  let cwd = process.cwd();
  let json = false;
  let quiet = false;
  const rest: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--json") {
      json = true;
      i++;
    } else if (arg === "--quiet") {
      quiet = true;
      i++;
    } else if (arg === "--cwd") {
      i++;
      if (i >= argv.length || argv[i].startsWith("--")) {
        throw new CliError(
          "MISSING_CWD_VALUE",
          "--cwd requires a path argument",
          EXIT_USAGE,
        );
      }
      cwd = argv[i];
      i++;
    } else {
      rest.push(arg);
      i++;
    }
  }

  return {
    context: { cwd, json, quiet, mode: "local" },
    rest,
  };
}
