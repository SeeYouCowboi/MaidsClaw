import { z } from "zod";

export const CoreMemoryBlockSchema = z
  .object({
    label: z.string(),
    content: z.string(),
    chars_current: z.number(),
    chars_limit: z.number(),
    read_only: z.boolean(),
    updated_at: z.number(),
  })
  .strict();
export type CoreMemoryBlock = z.infer<typeof CoreMemoryBlockSchema>;
export type CoreMemoryBlockDto = CoreMemoryBlock;

export const CoreMemoryBlockListResponseSchema = z
  .object({
    blocks: z.array(CoreMemoryBlockSchema),
  })
  .strict();
export type CoreMemoryBlockListResponse = z.infer<
  typeof CoreMemoryBlockListResponseSchema
>;
export type CoreMemoryBlockListResponseDto = CoreMemoryBlockListResponse;

export const PinnedSummarySchema = z
  .object({
    label: z.string(),
    content: z.string(),
    chars_current: z.number(),
    updated_at: z.number(),
  })
  .strict();
export type PinnedSummary = z.infer<typeof PinnedSummarySchema>;
export type PinnedSummaryDto = PinnedSummary;

export const PinnedSummaryListResponseSchema = z
  .object({
    agent_id: z.string(),
    summaries: z.array(PinnedSummarySchema),
  })
  .strict();
export type PinnedSummaryListResponse = z.infer<
  typeof PinnedSummaryListResponseSchema
>;
export type PinnedSummaryListResponseDto = PinnedSummaryListResponse;

export const EpisodeItemSchema = z
  .object({
    episode_id: z.union([z.string(), z.number()]),
    settlement_id: z.string(),
    category: z.string(),
    summary: z.string(),
    committed_time: z.number(),
    created_at: z.number(),
    private_notes: z.string().optional(),
    location_text: z.string().optional(),
  })
  .strict();
export type EpisodeItem = z.infer<typeof EpisodeItemSchema>;
export type EpisodeItemDto = EpisodeItem;

export const EpisodeListResponseSchema = z
  .object({
    agent_id: z.string(),
    items: z.array(EpisodeItemSchema),
  })
  .strict();
export type EpisodeListResponse = z.infer<typeof EpisodeListResponseSchema>;
export type EpisodeListResponseDto = EpisodeListResponse;

export const NarrativeItemSchema = z
  .object({
    scope: z.enum(["world", "area"]),
    scope_id: z.string(),
    summary_text: z.string(),
    updated_at: z.number(),
  })
  .strict();
export type NarrativeItem = z.infer<typeof NarrativeItemSchema>;
export type NarrativeItemDto = NarrativeItem;

export const NarrativeListResponseSchema = z
  .object({
    agent_id: z.string(),
    items: z.array(NarrativeItemSchema),
  })
  .strict();
export type NarrativeListResponse = z.infer<typeof NarrativeListResponseSchema>;
export type NarrativeListResponseDto = NarrativeListResponse;

export const SettlementItemSchema = z
  .object({
    settlement_id: z.string(),
    status: z.string(),
    attempt_count: z.number(),
    created_at: z.number(),
    updated_at: z.number(),
    payload_hash: z.string().optional(),
    claimed_by: z.string().optional(),
    claimed_at: z.number().optional(),
    applied_at: z.number().optional(),
    error_message: z.string().optional(),
  })
  .strict();
export type SettlementItem = z.infer<typeof SettlementItemSchema>;
export type SettlementItemDto = SettlementItem;

export const SettlementListResponseSchema = z
  .object({
    agent_id: z.string(),
    items: z.array(SettlementItemSchema),
  })
  .strict();
export type SettlementListResponse = z.infer<
  typeof SettlementListResponseSchema
>;
export type SettlementListResponseDto = SettlementListResponse;

const RetrievalTraceDataSchema = z
  .object({
    query_string: z.string(),
    strategy: z.string(),
    narrative_facets_used: z.array(z.string()),
    cognition_facets_used: z.array(z.string()),
    segment_count: z.number(),
  })
  .strict();

export const RetrievalTraceResponseSchema = z
  .object({
    request_id: z.string(),
    retrieval: RetrievalTraceDataSchema.nullable(),
  })
  .strict();
export type RetrievalTraceResponse = z.infer<
  typeof RetrievalTraceResponseSchema
>;
export type RetrievalTraceResponseDto = RetrievalTraceResponse;
