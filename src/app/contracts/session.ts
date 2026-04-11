export type AppExecutionMode = "local" | "gateway";

export type SessionCreateResult = {
  session_id: string;
  created_at: number;
};

export type SessionCloseResult = {
  session_id: string;
  closed_at: number;
  host_steps: {
    flush_on_session_close: "completed" | "not_applicable" | "skipped_no_agent";
  };
};

export type SessionRecoverResult = {
  session_id: string;
  recovered: true;
  action: "discard_partial_turn";
  note_code: "partial_output_not_canonized";
};

export type SessionListStatus = "open" | "closed" | "recovery_required";

export type SessionListItem = {
  session_id: string;
  agent_id: string;
  created_at: number;
  closed_at?: number;
  status: SessionListStatus;
};

export type SessionListQuery = {
  agent_id?: string;
  status?: SessionListStatus;
  limit?: number;
  cursor?: string;
};

export type SessionListResult = {
  items: SessionListItem[];
  next_cursor: string | null;
};
