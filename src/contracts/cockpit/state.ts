import { z } from "zod";

export const BlackboardSnapshotEntrySchema = z
  .object({
    key: z.string(),
    value: z.unknown(),
  })
  .strict();
export type BlackboardSnapshotEntry = z.infer<
  typeof BlackboardSnapshotEntrySchema
>;
export type BlackboardSnapshotEntryDto = BlackboardSnapshotEntry;

const StateSnapshotFiltersSchema = z
  .object({
    session_id: z.string().optional(),
  })
  .strict();

export const StateSnapshotResponseSchema = z
  .object({
    filters: StateSnapshotFiltersSchema,
    entries: z.array(BlackboardSnapshotEntrySchema),
  })
  .strict();
export type StateSnapshotResponse = z.infer<typeof StateSnapshotResponseSchema>;
export type StateSnapshotResponseDto = StateSnapshotResponse;

export const MaidenDecisionItemSchema = z
  .object({
    decision_id: z.string(),
    request_id: z.string(),
    session_id: z.string(),
    delegation_depth: z.number(),
    action: z.enum(["direct_reply", "delegate"]),
    target_agent_id: z.string().optional(),
    chosen_from_agent_ids: z.array(z.string()),
    created_at: z.number(),
  })
  .strict();
export type MaidenDecisionItem = z.infer<typeof MaidenDecisionItemSchema>;
export type MaidenDecisionItemDto = MaidenDecisionItem;

export const MaidenDecisionListResponseSchema = z
  .object({
    items: z.array(MaidenDecisionItemSchema),
    next_cursor: z.string().nullable(),
    filters: StateSnapshotFiltersSchema,
  })
  .strict();
export type MaidenDecisionListResponse = z.infer<
  typeof MaidenDecisionListResponseSchema
>;
export type MaidenDecisionListResponseDto = MaidenDecisionListResponse;
