import type { RedactedSettlement } from "./inspect.js";
import type { ObservationEvent } from "./execution.js";

export type PromptCapture = {
  sections: Record<string, string>;
  rendered_system?: string;
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
  public_chunks: ObservationEvent[];
  settlement?: RedactedSettlement;
  flush?: FlushCapture;
  log_entries: LogEntry[];
};
