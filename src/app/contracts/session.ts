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
