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

export type PromptCapture = {
  sections: Record<string, string>;
  rendered_system?: string;
};

export type PublicChunkRecord = {
  type:
    | "text_delta"
    | "tool_use_start"
    | "tool_use_delta"
    | "tool_use_end"
    | "tool_execution_result"
    | "message_end"
    | "error"
    | "tool_call"
    | "tool_result";
  timestamp?: number;
  text?: string;
  id?: string;
  name?: string;
  partialJson?: string;
  result?: unknown;
  isError?: boolean;
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  inputTokens?: number;
  outputTokens?: number;
  code?: string;
  message?: string;
  retriable?: boolean;
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
};

export type RedactedSettlement = {
  type: string;
  op_count?: number;
  kinds?: string[];
};

export type FlushCapture = {
  requested: boolean;
  result?: string;
  pending_job?: {
    status?: string;
    failure_count?: number;
    next_attempt_at?: number | null;
    last_error_code?: string | null;
    last_error_message?: string | null;
  };
};

export type LogEntry = {
  level: string;
  message: string;
  timestamp: number;
};

export type TraceBundle = {
  request_id: string;
  session_id: string;
  agent_id: string;
  captured_at: number;
  prompt?: PromptCapture;
  public_chunks: PublicChunkRecord[];
  settlement?: RedactedSettlement;
  flush?: FlushCapture;
  log_entries: LogEntry[];
};

export type PrivateCommitSummary = {
  present: boolean;
  op_count: number;
  kinds: string[];
};

export type TurnExecutionResult = {
  mode: CliMode;
  session_id: string;
  request_id: string;
  settlement_id?: string;
  assistant_text: string;
  has_public_reply: boolean;
  private_commit: PrivateCommitSummary;
  recovery_required: boolean;
  public_chunks: PublicChunkRecord[];
  tool_events: PublicChunkRecord[];
};
