import { z } from "zod";

export const RuntimeTalkerThinkerSchema = z
  .object({
    enabled: z.boolean(),
    staleness_threshold: z.number(),
    soft_block_timeout_ms: z.number(),
    soft_block_poll_interval_ms: z.number(),
    global_concurrency_cap: z.number().optional(),
  })
  .strict();
export type RuntimeTalkerThinker = z.infer<typeof RuntimeTalkerThinkerSchema>;
export type RuntimeTalkerThinkerDto = RuntimeTalkerThinker;

export const RuntimeOrchestrationSchema = z
  .object({
    enabled: z.boolean(),
    role: z.string(),
    durable_mode: z.boolean(),
    lease_reclaim_active: z.boolean(),
  })
  .strict();
export type RuntimeOrchestration = z.infer<typeof RuntimeOrchestrationSchema>;
export type RuntimeOrchestrationDto = RuntimeOrchestration;

export const RuntimeGatewaySchema = z
  .object({
    cors_allowed_origins: z.array(z.string()),
  })
  .strict();
export type RuntimeGateway = z.infer<typeof RuntimeGatewaySchema>;
export type RuntimeGatewayDto = RuntimeGateway;

export const RuntimeSnapshotSchema = z
  .object({
    backend_type: z.string(),
    memory_pipeline_status: z.string(),
    memory_pipeline_ready: z.boolean(),
    talker_thinker: RuntimeTalkerThinkerSchema,
    orchestration: RuntimeOrchestrationSchema,
    gateway: RuntimeGatewaySchema,
    effective_organizer_embedding_model_id: z.string().optional(),
  })
  .strict();
export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>;
export type RuntimeSnapshotDto = RuntimeSnapshot;
