/**
 * CLI output helpers.
 *
 * These write to process.stdout (JSON / text) or process.stderr (errors in text mode).
 * The runtime logger (src/core/logger.ts) writes structured JSON to stdout for
 * operational logs — CLI commands MUST NOT use the logger for their own output.
 */

import type { CliContext } from "./context.js";
import type { CliError } from "./errors.js";
import type { JsonEnvelope } from "./types.js";

/**
 * Write a JSON envelope to stdout (single line, newline-terminated).
 */
export function writeJson(envelope: JsonEnvelope): void {
  process.stdout.write(JSON.stringify(envelope) + "\n");
}

/**
 * Write plain text to stdout (for non-JSON, non-quiet mode).
 */
export function writeText(text: string): void {
  process.stdout.write(text + "\n");
}

/**
 * Write a CLI error.
 *
 * - In JSON mode → writes a JSON error envelope to stdout.
 * - In text mode → writes human-readable message to stderr.
 *
 * @param command Optional command name for the JSON envelope.
 */
export function writeError(
  ctx: CliContext,
  err: CliError,
  command?: string,
): void {
  if (ctx.json) {
    const envelope: JsonEnvelope = {
      ok: false,
      command: command ?? "",
      error: err.toJSON(),
    };
    writeJson(envelope);
  } else {
    process.stderr.write(`Error [${err.code}]: ${err.message}\n`);
  }
}
