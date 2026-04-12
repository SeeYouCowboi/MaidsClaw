import { z } from "zod";
import { GATEWAY_ERROR_CODES } from "./errors.js";

export { GATEWAY_ERROR_CODES };
export type { GatewayErrorCode, GatewayErrorCodeUnion } from "./errors.js";

export const GatewayErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retriable: z.boolean(),
        details: z.unknown().optional(),
      })
      .strict(),
    request_id: z.string().optional(),
  })
  .strict();
export type GatewayErrorEnvelope = z.infer<typeof GatewayErrorEnvelopeSchema>;

export const GatewayNoBodyRequestSchema = z.undefined();
export type GatewayNoBodyRequest = z.infer<typeof GatewayNoBodyRequestSchema>;

export const GatewayUnknownRequestSchema = z.unknown();
export type GatewayUnknownRequest = z.infer<typeof GatewayUnknownRequestSchema>;

export const GatewayUnknownResponseSchema = z.unknown();
export type GatewayUnknownResponse = z.infer<
  typeof GatewayUnknownResponseSchema
>;

export const JobListResponseSchema = z
  .object({
    items: z.array(z.unknown()),
    next_cursor: z.string().nullable(),
  })
  .strict();
export type JobListResponse = z.infer<typeof JobListResponseSchema>;

export const JobDetailResponseSchema = z
  .object({
    history: z.array(z.unknown()),
  })
  .passthrough();
export type JobDetailResponse = z.infer<typeof JobDetailResponseSchema>;

export const HealthzResponseSchema = z
  .object({
    status: z.literal("ok"),
  })
  .strict();
export type HealthzResponse = z.infer<typeof HealthzResponseSchema>;

export const ReadyzSubsystemStatusSchema = z.enum([
  "ok",
  "degraded",
  "unavailable",
]);
export type ReadyzSubsystemStatus = z.infer<typeof ReadyzSubsystemStatusSchema>;

export const ReadyzResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    storage: ReadyzSubsystemStatusSchema,
    models: ReadyzSubsystemStatusSchema,
  })
  .passthrough();
export type ReadyzResponse = z.infer<typeof ReadyzResponseSchema>;

export const SessionCreateRequestSchema = z
  .object({
    agent_id: z.string().min(1),
  })
  .strict();
export type SessionCreateRequest = z.infer<typeof SessionCreateRequestSchema>;

export const SessionCreateResponseSchema = z
  .object({
    session_id: z.string().min(1),
    created_at: z.number().int().nonnegative(),
  })
  .strict();
export type SessionCreateResponse = z.infer<typeof SessionCreateResponseSchema>;

export const SessionCloseResponseSchema = z
  .object({
    session_id: z.string().min(1),
    closed_at: z.number().int().nonnegative(),
    host_steps: z
      .object({
        flush_on_session_close: z.enum([
          "completed",
          "not_applicable",
          "skipped_no_agent",
        ]),
      })
      .strict(),
  })
  .strict();
export type SessionCloseResponse = z.infer<typeof SessionCloseResponseSchema>;

export const SessionRecoverRequestSchema = z
  .object({
    action: z.literal("discard_partial_turn"),
  })
  .strict();
export type SessionRecoverRequest = z.infer<typeof SessionRecoverRequestSchema>;

export const SessionRecoverResponseSchema = z
  .object({
    session_id: z.string().min(1),
    recovered: z.literal(true),
    action: z.literal("discard_partial_turn"),
    note_code: z.literal("partial_output_not_canonized"),
  })
  .strict();
export type SessionRecoverResponse = z.infer<
  typeof SessionRecoverResponseSchema
>;

export const TurnStreamRequestSchema = z
  .object({
    agent_id: z.string().min(1).optional(),
    request_id: z.string().min(1).optional(),
    user_message: z
      .object({
        id: z.string().min(1).optional(),
        text: z.string().min(1),
      })
      .strict(),
    client_context: z.unknown().optional(),
    metadata: z.unknown().optional(),
  })
  .strict();
export type TurnStreamRequest = z.infer<typeof TurnStreamRequestSchema>;

export const SessionStatusSchema = z.enum([
  "open",
  "closed",
  "recovery_required",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionListItemSchema = z
  .object({
    session_id: z.string().min(1),
    agent_id: z.string().min(1),
    created_at: z.number().int().nonnegative(),
    closed_at: z.number().int().nonnegative().optional(),
    status: SessionStatusSchema,
  })
  .strict();
export type SessionListItem = z.infer<typeof SessionListItemSchema>;

export const SessionListResponseSchema = z
  .object({
    items: z.array(SessionListItemSchema),
    next_cursor: z.string().nullable(),
  })
  .strict();
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

export * from "./agents.js";
export * from "./lore.js";
export type {
  CoreMemoryBlockListResponse as CoreMemoryBlockList,
  EpisodeListResponse as EpisodeList,
  NarrativeListResponse as NarrativeList,
  PinnedSummaryListResponse as PinnedSummaryList,
  RetrievalTraceResponse as RetrievalTrace,
  SettlementListResponse as SettlementList,
} from "./memory.js";
export * from "./memory.js";
export {
  CoreMemoryBlockListResponseSchema as CoreMemoryBlockListSchema,
  CoreMemoryBlockSchema,
  EpisodeItemSchema,
  EpisodeListResponseSchema as EpisodeListSchema,
  NarrativeItemSchema,
  NarrativeListResponseSchema as NarrativeListSchema,
  PinnedSummaryListResponseSchema as PinnedSummaryListSchema,
  PinnedSummarySchema,
  RetrievalTraceResponseSchema as RetrievalTraceSchema,
  SettlementItemSchema,
  SettlementListResponseSchema as SettlementListSchema,
} from "./memory.js";
export * from "./personas.js";
export * from "./providers.js";
export * from "./runtime.js";
export type {
  MaidenDecisionListResponse as MaidenDecisionList,
  StateSnapshotResponse as StateSnapshot,
} from "./state.js";
export * from "./state.js";
export {
  MaidenDecisionItemSchema,
  MaidenDecisionListResponseSchema as MaidenDecisionListSchema,
  StateSnapshotResponseSchema as StateSnapshotSchema,
} from "./state.js";
