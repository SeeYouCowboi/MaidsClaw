/**
 * Shared CLI type definitions for MaidsClaw non-interactive commands.
 *
 * All non-interactive commands produce a {@link JsonEnvelope} when `--json` is active.
 * The envelope shape is stable across versions.
 */

// ── Operating mode ───────────────────────────────────────────────────

/** Whether the CLI is operating against a local runtime or a remote gateway. */
export type CliMode = "local" | "gateway";

// ── JSON envelope ────────────────────────────────────────────────────

/**
 * A single diagnostic entry in a CLI response.
 * Diagnostics are non-fatal observations (warnings, degraded states, etc.).
 */
export type CliDiagnostic = {
  code: string;
  message: string;
  /** Optional locator (e.g. agent ID, file path) for the diagnostic source. */
  locator?: string;
};

/**
 * Standard JSON envelope for non-interactive CLI output.
 *
 * All non-interactive commands MUST produce this shape when `--json` is active.
 * `chat` is the only interactive command and MUST NOT use this envelope.
 */
export type JsonEnvelope<T = unknown> = {
  ok: boolean;
  command: string;
  mode?: CliMode;
  data?: T;
  diagnostics?: CliDiagnostic[];
  error?: {
    code: string;
    message: string;
    exitCode: number;
  };
};
