export type RuntimeTalkerThinkerDto = {
  enabled: boolean;
  staleness_threshold: number;
  soft_block_timeout_ms: number;
  soft_block_poll_interval_ms: number;
  global_concurrency_cap?: number;
};

export type RuntimeOrchestrationDto = {
  enabled: boolean;
  role: string;
  durable_mode: boolean;
  lease_reclaim_active: boolean;
};

export type RuntimeGatewayDto = {
  cors_allowed_origins: string[];
};

export type RuntimeSnapshotDto = {
  backend_type: string;
  memory_pipeline_status: string;
  memory_pipeline_ready: boolean;
  talker_thinker: RuntimeTalkerThinkerDto;
  orchestration: RuntimeOrchestrationDto;
  gateway: RuntimeGatewayDto;
  effective_organizer_embedding_model_id?: string;
};
