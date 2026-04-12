export type CoreMemoryBlockDto = {
  label: string;
  content: string;
  chars_current: number;
  chars_limit: number;
  read_only: boolean;
  updated_at: number;
};

export type CoreMemoryBlockListResponseDto = {
  blocks: CoreMemoryBlockDto[];
};

export type PinnedSummaryDto = {
  label: string;
  content: string;
  chars_current: number;
  updated_at: number;
};

export type PinnedSummaryListResponseDto = {
  agent_id: string;
  summaries: PinnedSummaryDto[];
};

export type EpisodeItemDto = {
  episode_id: string | number;
  settlement_id: string;
  category: string;
  summary: string;
  committed_time: number;
  created_at: number;
  private_notes?: string;
  location_text?: string;
};

export type EpisodeListResponseDto = {
  agent_id: string;
  items: EpisodeItemDto[];
};

export type NarrativeItemDto = {
  scope: "world" | "area";
  scope_id: string;
  summary_text: string;
  updated_at: number;
};

export type NarrativeListResponseDto = {
  agent_id: string;
  items: NarrativeItemDto[];
};

export type SettlementItemDto = {
  settlement_id: string;
  status: string;
  attempt_count: number;
  created_at: number;
  updated_at: number;
  payload_hash?: string;
  claimed_by?: string;
  claimed_at?: number;
  applied_at?: number;
  error_message?: string;
};

export type SettlementListResponseDto = {
  agent_id: string;
  items: SettlementItemDto[];
};

export type RetrievalTraceResponseDto = {
  request_id: string;
  retrieval: {
    query_string: string;
    strategy: string;
    narrative_facets_used: string[];
    cognition_facets_used: string[];
    segment_count: number;
  } | null;
};
