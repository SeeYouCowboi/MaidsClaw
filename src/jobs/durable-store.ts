import type { ExecutionClass, JobKind } from "./types.js";

export type PgJobStatus = "pending" | "running" | "succeeded" | "failed_terminal" | "cancelled";

export const PG_JOB_ACTIVE_STATUSES: readonly PgJobStatus[] = ["pending", "running"];

export const DURABLE_SEARCH_REBUILD_SCOPES = ["private", "area", "world", "cognition"] as const;

export type DurableSearchRebuildScope = (typeof DURABLE_SEARCH_REBUILD_SCOPES)[number];

export const DURABLE_ALL_AGENTS_SENTINEL = "_all_agents";

export type SearchRebuildTriggerSource =
  | "fts_sync_failure"
  | "manual_cli"
  | "doctor_verify"
  | "scheduled_maintenance"
  | "drift_detector"
  | (string & {});

export type SearchRebuildTriggerReason =
  | "fts_repair"
  | "full_rebuild"
  | "verify_mismatch"
  | "drift_detected"
  | "backfill"
  | (string & {});

export type DurableSearchRebuildPayload =
  | {
      version: 1;
      scope: "private" | "cognition";
      targetAgentId: string;
      triggerSource: SearchRebuildTriggerSource;
      triggerReason: SearchRebuildTriggerReason;
      requestedBy?: string;
      requestedAt?: number;
    }
  | {
      version: 1;
      scope: "area" | "world";
      targetAgentId?: null;
      triggerSource: SearchRebuildTriggerSource;
      triggerReason: SearchRebuildTriggerReason;
      requestedBy?: string;
      requestedAt?: number;
    };

export type CognitionThinkerJobPayload = {
  sessionId: string;
  agentId: string;
  settlementId: string;
  talkerTurnVersion: number;
};

export type DurablePayloadByKind = {
  "memory.migrate": unknown;
  "memory.organize": unknown;
  "task.run": unknown;
  "search.rebuild": DurableSearchRebuildPayload;
  "maintenance.replay_projection": unknown;
  "maintenance.rebuild_derived": unknown;
  "maintenance.full": unknown;
  "cognition.thinker": CognitionThinkerJobPayload;
};

export type PgJobCurrentRow<K extends JobKind = JobKind> = {
  job_key: string;
  job_type: K;
  job_family_key?: string;
  execution_class: ExecutionClass;
  concurrency_key: string;
  status: PgJobStatus;
  payload_schema_version: number;
  payload_json: DurablePayloadByKind[K];
  family_state_json: Record<string, unknown>;
  claim_version: number;
  claimed_by?: string;
  claimed_at?: number;
  lease_expires_at?: number;
  last_heartbeat_at?: number;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: number;
  last_error_code?: string;
  last_error_message?: string;
  last_error_at?: number;
  created_at: number;
  updated_at: number;
  terminal_at?: number;
};

export type PgJobAttemptOutcome =
  | "running"
  | "succeeded"
  | "failed_retry_scheduled"
  | "failed_terminal"
  | "cancelled"
  | "lease_lost";

export type PgJobAttemptHistoryRow = {
  attempt_id: number;
  job_key: string;
  job_type: JobKind;
  job_family_key?: string;
  execution_class: ExecutionClass;
  concurrency_key: string;
  claim_version: number;
  attempt_no: number;
  worker_id: string;
  outcome: PgJobAttemptOutcome;
  payload_schema_version: number;
  payload_snapshot_json: unknown;
  family_state_snapshot_json: Record<string, unknown>;
  started_at: number;
  last_heartbeat_at?: number;
  lease_expires_at: number;
  finished_at?: number;
  error_code?: string;
  error_message?: string;
  backoff_until?: number;
};

export type EnqueueJobInput<K extends JobKind = JobKind> = K extends "search.rebuild"
  ? {
      job_key: string;
      job_type: K;
      job_family_key: string;
      execution_class: ExecutionClass;
      concurrency_key: string;
      payload_schema_version: number;
      payload_json: DurablePayloadByKind[K];
      max_attempts: number;
      now_ms: number;
      next_attempt_at?: number;
    }
  : {
      job_key: string;
      job_type: K;
      job_family_key?: string;
      execution_class: ExecutionClass;
      concurrency_key: string;
      payload_schema_version: number;
      payload_json: DurablePayloadByKind[K];
      max_attempts: number;
      now_ms: number;
      next_attempt_at?: number;
    };

export type EnqueueResult =
  | {
      outcome: "created";
      job_key: string;
      job_family_key?: string;
      status: "pending";
      claim_version: number;
    }
  | {
      outcome: "duplicate";
      job_key: string;
      job_family_key?: string;
      status: PgJobStatus;
      claim_version: number;
    }
  | {
      outcome: "coalesced";
      job_key: string;
      job_family_key: string;
      coalesced_into_job_key: string;
    };

export type ClaimNextInput = {
  worker_id: string;
  now_ms: number;
  lease_duration_ms: number;
};

export type ClaimNextResult =
  | {
      outcome: "claimed";
      job: PgJobCurrentRow;
    }
  | {
      outcome: "none_ready";
    };

export type HeartbeatResult =
  | {
      outcome: "renewed";
      job_key: string;
      claim_version: number;
      lease_expires_at: number;
      heartbeat_at: number;
    }
  | {
      outcome: "not_found" | "stale_claim" | "not_running";
      job_key: string;
      claim_version: number;
    };

export type CompleteResult =
  | {
      outcome: "succeeded";
      job_key: string;
      claim_version: number;
      terminal_at: number;
    }
  | {
      outcome: "not_found" | "stale_claim" | "not_running";
      job_key: string;
      claim_version: number;
    };

export type PgJobFailInput = {
  now_ms: number;
  error_code?: string;
  error_message: string;
  retry_delay_ms?: number;
};

export type FailResult =
  | {
      outcome: "retry_scheduled";
      job_key: string;
      claim_version: number;
      next_attempt_at: number;
    }
  | {
      outcome: "failed_terminal";
      job_key: string;
      claim_version: number;
      terminal_at: number;
    }
  | {
      outcome: "not_found" | "stale_claim" | "not_running";
      job_key: string;
      claim_version: number;
    };

export type CancelResult =
  | {
      outcome: "cancelled";
      job_key: string;
      claim_version: number;
      terminal_at: number;
    }
  | {
      outcome: "not_found" | "stale_claim" | "not_running";
      job_key: string;
      claim_version: number;
    };

export type PgStatusCount = Record<PgJobStatus, number>;

export interface DurableJobStore {
  enqueue<K extends JobKind>(input: EnqueueJobInput<K>): Promise<EnqueueResult>;
  claimNext(input: ClaimNextInput): Promise<ClaimNextResult>;

  heartbeat(job_key: string, claim_version: number, nowMs: number): Promise<HeartbeatResult>;
  complete(job_key: string, claim_version: number, resultJson?: unknown): Promise<CompleteResult>;
  fail(job_key: string, claim_version: number, error: PgJobFailInput): Promise<FailResult>;
  cancel(job_key: string, claim_version: number): Promise<CancelResult>;

  reclaimExpiredLeases(nowMs: number): Promise<number>;

  inspect(job_key: string): Promise<PgJobCurrentRow | undefined>;
  listActive(): Promise<PgJobCurrentRow[]>;
  listExpiredLeases(nowMs: number): Promise<PgJobCurrentRow[]>;
  countByStatus(): Promise<PgStatusCount>;
  getHistory(job_key: string): Promise<PgJobAttemptHistoryRow[]>;
}

export function isDurableSearchRebuildPayload(value: unknown): value is DurableSearchRebuildPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const payload = value as Record<string, unknown>;

  if (payload.version !== 1) {
    return false;
  }

  if (typeof payload.scope !== "string") {
    return false;
  }

  if (!DURABLE_SEARCH_REBUILD_SCOPES.includes(payload.scope as DurableSearchRebuildScope)) {
    return false;
  }

  if (typeof payload.triggerSource !== "string" || payload.triggerSource.length === 0) {
    return false;
  }

  if (typeof payload.triggerReason !== "string" || payload.triggerReason.length === 0) {
    return false;
  }

  if (
    payload.requestedBy !== undefined
    && (typeof payload.requestedBy !== "string" || payload.requestedBy.length === 0)
  ) {
    return false;
  }

  if (payload.requestedAt !== undefined && typeof payload.requestedAt !== "number") {
    return false;
  }

  if (payload.targetAgentId === DURABLE_ALL_AGENTS_SENTINEL) {
    return false;
  }

  if (payload.scope === "private" || payload.scope === "cognition") {
    return typeof payload.targetAgentId === "string" && payload.targetAgentId.length > 0;
  }

  return payload.targetAgentId === undefined || payload.targetAgentId === null;
}

export function assertDurableSearchRebuildPayload(value: unknown): asserts value is DurableSearchRebuildPayload {
  if (!isDurableSearchRebuildPayload(value)) {
    throw new Error(
      "Invalid durable search.rebuild payload: forbid scope=all and targetAgentId=_all_agents; enforce scope/targetAgentId pairing.",
    );
  }
}
