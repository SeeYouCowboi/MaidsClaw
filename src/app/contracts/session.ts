export type AppExecutionMode = "local" | "gateway";

export type SessionCreateResult = {
  session_id: string;
  created_at: number;
};

export type SessionCloseResult = {
  session_id: string;
  closed_at: number;
};

export type SessionRecoverResult = {
  session_id: string;
  recovered: boolean;
};
