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

export type RetrievalTraceCapture = {
  query_string: string;
  strategy: string;
  narrative_facets_used: string[];
  cognition_facets_used: string[];
  segment_count: number;
  segments?: Array<{
    source: string;
    content: string;
    score?: number;
  }>;
  navigator?: {
    seeds: string[];
    steps: Array<{
      depth: number;
      visited_ref: string;
      via_ref?: string;
      via_relation?: string;
      score?: number;
      pruned?: string | null;
    }>;
    final_selection: string[];
  };
};

export type TraceBundle = {
  request_id: string;
  session_id: string;
  agent_id: string;
  captured_at: number;
  prompt?: PromptCapture;
  retrieval?: RetrievalTraceCapture;
  public_chunks: ObservationEvent[];
  settlement?: RedactedSettlement;
  flush?: FlushCapture;
  log_entries: LogEntry[];
};

export type TraceSummary = {
  request_id: string;
  session_id: string;
  agent_id: string;
  captured_at: number;
  log_entry_count: number;
  chunk_count: number;
  has_prompt: boolean;
  has_settlement: boolean;
  has_retrieval: boolean;
};
