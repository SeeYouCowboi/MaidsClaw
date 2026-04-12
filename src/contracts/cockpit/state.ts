export type BlackboardSnapshotEntryDto = {
  key: string;
  value: unknown;
};

export type StateSnapshotResponseDto = {
  filters: { session_id?: string };
  entries: BlackboardSnapshotEntryDto[];
};

export type MaidenDecisionItemDto = {
  decision_id: string;
  request_id: string;
  session_id: string;
  delegation_depth: number;
  action: "direct_reply" | "delegate";
  target_agent_id?: string;
  chosen_from_agent_ids: string[];
  created_at: number;
};

export type MaidenDecisionListResponseDto = {
  items: MaidenDecisionItemDto[];
  next_cursor: string | null;
  filters: { session_id?: string };
};
