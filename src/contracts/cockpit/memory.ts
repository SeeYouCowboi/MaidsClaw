import { z } from "zod";

export const CoreMemoryBlockSchema = z
  .object({
    label: z.string(),
    content: z.string(),
    chars_current: z.number(),
    chars_limit: z.number(),
    read_only: z.boolean(),
    updated_at: z.number(),
    snapshot_source: z.string().optional(),
    snapshot_source_id: z.string().optional(),
    snapshot_captured_at: z.number().optional(),
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
    request_id: z.string().optional().nullable(),
    entity_refs: z.array(z.string()).optional(),
  })
  .strict();
export type EpisodeItem = z.infer<typeof EpisodeItemSchema>;
export type EpisodeItemDto = EpisodeItem;

export const ResolvedEntityNodeSchema = z
  .object({
    id: z.number(),
    pointer_key: z.string(),
    display_name: z.string(),
    entity_type: z.string(),
    memory_scope: z.enum(["shared_public", "private_overlay"]),
  })
  .strict();
export type ResolvedEntityNode = z.infer<typeof ResolvedEntityNodeSchema>;

export const EpisodeListResponseSchema = z
  .object({
    agent_id: z.string(),
    items: z.array(EpisodeItemSchema),
    entity_refs_resolved: z
      .record(z.string(), ResolvedEntityNodeSchema)
      .optional(),
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
    segments: z
      .array(
        z
          .object({
            source: z.string(),
            content: z.string(),
            score: z.number().optional(),
          })
          .strict(),
      )
      .optional(),
    navigator: z
      .object({
        seeds: z.array(z.string()),
        steps: z.array(
          z
            .object({
              depth: z.number(),
              visited_ref: z.string(),
              via_ref: z.string().optional(),
              via_relation: z.string().optional(),
              score: z.number().optional(),
              pruned: z.string().nullable().optional(),
            })
            .strict(),
        ),
        final_selection: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();

const RetrievalTracePromptSectionsSchema = z
  .object({
    pinned_shared: z.string().optional(),
    recent_cognition: z.string().optional(),
    typed_retrieval: z.string().optional(),
    lore_entries: z.string().optional(),
    known_entities: z.string().optional(),
  })
  .strict();

export const RetrievalTraceResponseSchema = z
  .object({
    request_id: z.string(),
    retrieval: RetrievalTraceDataSchema.nullable(),
    prompt_sections: RetrievalTracePromptSectionsSchema.optional(),
  })
  .strict();
export type RetrievalTraceResponse = z.infer<
  typeof RetrievalTraceResponseSchema
>;
export type RetrievalTraceResponseDto = RetrievalTraceResponse;

export const RecentRequestItemSchema = z
  .object({
    request_id: z.string(),
    session_id: z.string(),
    agent_id: z.string(),
    captured_at: z.number(),
    has_retrieval: z.boolean(),
    has_settlement: z.boolean(),
    has_prompt: z.boolean(),
  })
  .strict();
export type RecentRequestItem = z.infer<typeof RecentRequestItemSchema>;
export type RecentRequestItemDto = RecentRequestItem;

export const RecentRequestListResponseSchema = z
  .object({
    items: z.array(RecentRequestItemSchema),
  })
  .strict();
export type RecentRequestListResponse = z.infer<
  typeof RecentRequestListResponseSchema
>;
export type RecentRequestListResponseDto = RecentRequestListResponse;

// ─── Consensus memory edges: world-state inspection (debug surface) ──────────
//
// Shape is intentionally close to PgUnifiedEdgeReadRepo's normalized record so
// the Cockpit/Study Room can render it 1:1 for debugging the worldStateOps →
// fact_edges → talker [world_state] retrieval pipeline. Unresolved-queue rows
// expose the same payload the entity-judge replayer reads, so a developer can
// see why a queued op is stuck or dead-lettered.

export const WorldStateEdgeItemSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    source_ref: z.string(),
    target_ref: z.string(),
    edge_kind: z.string(),
    layer: z.string(),
    truth_bearing: z.boolean(),
    heuristic_only: z.boolean(),
    lifecycle: z.string(),
    fact_text: z.string().nullable().optional(),
    t_valid: z.number().optional(),
    t_invalid: z.number().nullable().optional(),
    source_kind: z.string().nullable().optional(),
    source_ref_origin: z.string().nullable().optional(),
    owner_agent_id: z.string().nullable().optional(),
    created_at: z.number().optional(),
  })
  .strict();
export type WorldStateEdgeItem = z.infer<typeof WorldStateEdgeItemSchema>;
export type WorldStateEdgeItemDto = WorldStateEdgeItem;

export const WorldStateEdgesResponseSchema = z
  .object({
    agent_id: z.string(),
    entity_ref: z.string(),
    /** "active" omits invalidated rows; "all" includes the supersedable history. */
    mode: z.enum(["active", "all"]),
    items: z.array(WorldStateEdgeItemSchema),
  })
  .strict();
export type WorldStateEdgesResponse = z.infer<
  typeof WorldStateEdgesResponseSchema
>;
export type WorldStateEdgesResponseDto = WorldStateEdgesResponse;

export const UnresolvedWorldStateOpStatusSchema = z.enum([
  "pending",
  "resolved",
  "dead_letter",
]);
export type UnresolvedWorldStateOpStatus = z.infer<
  typeof UnresolvedWorldStateOpStatusSchema
>;

export const UnresolvedWorldStateOpItemSchema = z
  .object({
    id: z.number(),
    session_id: z.string(),
    settlement_id: z.string(),
    op_index: z.number(),
    status: UnresolvedWorldStateOpStatusSchema,
    agent_id: z.string().optional(),
    predicate: z.string().optional(),
    fact_text: z.string().optional(),
    subject_pointer_key: z.string().optional(),
    object_pointer_key: z.string().optional(),
    visibility: z.string().optional(),
    contradicted_fact_edge_ids: z.array(z.number()).optional(),
    retry_count: z.number(),
    last_error: z.string().nullable().optional(),
    turn_timestamp: z.number().optional(),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .strict();
export type UnresolvedWorldStateOpItem = z.infer<
  typeof UnresolvedWorldStateOpItemSchema
>;
export type UnresolvedWorldStateOpItemDto = UnresolvedWorldStateOpItem;

export const UnresolvedWorldStateOpsResponseSchema = z
  .object({
    agent_id: z.string(),
    status_filter: UnresolvedWorldStateOpStatusSchema.optional(),
    items: z.array(UnresolvedWorldStateOpItemSchema),
  })
  .strict();
export type UnresolvedWorldStateOpsResponse = z.infer<
  typeof UnresolvedWorldStateOpsResponseSchema
>;
export type UnresolvedWorldStateOpsResponseDto = UnresolvedWorldStateOpsResponse;
