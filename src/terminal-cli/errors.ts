/**
 * CLI exit codes and error types.
 *
 * Exit codes follow the stable set from the CLI implementation plan:
 *   0 = success
 *   2 = usage / argument error
 *   3 = configuration error
 *   4 = runtime / service error
 *   5 = partial result (degraded, recovery_required, etc.)
 */

// ── Exit code constants ──────────────────────────────────────────────

/** Successful completion. */
export const EXIT_OK = 0;

/** Bad flags, unknown command, or invalid argument. */
export const EXIT_USAGE = 2;

/** Configuration error (missing file, bad schema, etc.). */
export const EXIT_CONFIG = 3;

/** Runtime or service error. */
export const EXIT_RUNTIME = 4;

/** Partial result — degraded, recovery_required, or similar diagnostic-level issue. */
export const EXIT_PARTIAL = 5;

// ── CliError ─────────────────────────────────────────────────────────

/**
 * Structured CLI error with a stable code, human-readable message, and exit code.
 *
 * Handlers throw this; the dispatch layer catches it, writes appropriate output
 * (JSON envelope or stderr text), and the entry point calls `process.exit()`.
 */
export class CliError extends Error {
  override readonly name = "CliError";

  constructor(
    /** Machine-readable error code (e.g. "UNKNOWN_COMMAND", "INVALID_FLAG"). */
    public readonly code: string,
    message: string,
    /** Process exit code — one of the EXIT_* constants. */
    public readonly exitCode: number,
  ) {
    super(message);
  }

  toJSON(): { code: string; message: string; exitCode: number } {
    return { code: this.code, message: this.message, exitCode: this.exitCode };
  }
}
