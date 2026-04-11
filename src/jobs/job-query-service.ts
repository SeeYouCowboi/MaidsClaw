import type {
  CockpitJobAttempt,
  CockpitJobItem,
  CognitionThinkerJobPayload,
  DurableJobStore,
  JobListPageParams,
  PgJobAttemptHistoryRow,
  PgJobCurrentRow,
  PgJobStatus,
} from "./durable-store.js";
import type { JobKind } from "./types.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export interface JobQueryService {
  listJobs(params: {
    status?: string;
    type?: string;
    limit: number;
    cursor?: string;
  }): Promise<{ items: CockpitJobItem[]; next_cursor: string | null }>;
  getJob(jobId: string): Promise<CockpitJobItem | null>;
  getJobHistory(jobId: string): Promise<CockpitJobAttempt[]>;
}

function clampLimit(limit?: number): number {
  const value = Number.isFinite(limit) ? Math.floor(limit as number) : DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, value || DEFAULT_LIST_LIMIT));
}

function isPgJobStatus(value: string): value is PgJobStatus {
  return value === "pending"
    || value === "running"
    || value === "succeeded"
    || value === "failed_terminal"
    || value === "cancelled";
}

function isJobKind(value: string): value is JobKind {
  return value === "memory.migrate"
    || value === "memory.organize"
    || value === "task.run"
    || value === "search.rebuild"
    || value === "maintenance.replay_projection"
    || value === "maintenance.rebuild_derived"
    || value === "maintenance.full"
    || value === "cognition.thinker";
}

function toIsoTimestamp(timestamp?: number): string | undefined {
  if (timestamp === undefined) {
    return undefined;
  }
  return new Date(Number(timestamp)).toISOString();
}

function isTerminalStatus(status: PgJobStatus): boolean {
  return status === "succeeded" || status === "failed_terminal" || status === "cancelled";
}

function asThinkerPayload(value: unknown): CognitionThinkerJobPayload | undefined {
  let normalized: unknown = value;
  if (typeof normalized === "string") {
    try {
      normalized = JSON.parse(normalized);
    } catch {
      return undefined;
    }
  }

  if (typeof normalized !== "object" || normalized === null) {
    return undefined;
  }

  const candidate = normalized as Record<string, unknown>;
  if (
    typeof candidate.sessionId !== "string"
    || typeof candidate.agentId !== "string"
    || typeof candidate.settlementId !== "string"
    || typeof candidate.talkerTurnVersion !== "number"
  ) {
    return undefined;
  }

  return {
    sessionId: candidate.sessionId,
    agentId: candidate.agentId,
    settlementId: candidate.settlementId,
    talkerTurnVersion: candidate.talkerTurnVersion,
  };
}

function mapCurrentRowToCockpitItem(row: PgJobCurrentRow): CockpitJobItem {
  const createdAt = toIsoTimestamp(row.created_at) ?? new Date(0).toISOString();
  const updatedAt = toIsoTimestamp(row.updated_at) ?? createdAt;
  const startedAt = toIsoTimestamp(row.claimed_at);
  const finishedAt = isTerminalStatus(row.status) ? toIsoTimestamp(row.terminal_at) : undefined;

  const thinkerPayload =
    row.job_type === "cognition.thinker"
      ? asThinkerPayload(row.payload_json)
      : undefined;

  return {
    job_id: row.job_key,
    job_type: row.job_type,
    execution_class: row.execution_class,
    status: row.status,
    ...(thinkerPayload?.sessionId ? { session_id: thinkerPayload.sessionId } : {}),
    ...(thinkerPayload?.agentId ? { agent_id: thinkerPayload.agentId } : {}),
    created_at: createdAt,
    updated_at: updatedAt,
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(finishedAt ? { finished_at: finishedAt } : {}),
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    ...(row.last_error_code ? { last_error_code: row.last_error_code } : {}),
    ...(row.last_error_message ? { last_error_message: row.last_error_message } : {}),
  };
}

function mapAttemptRowToCockpitAttempt(row: PgJobAttemptHistoryRow): CockpitJobAttempt {
  return {
    attempt_no: row.attempt_no,
    worker_id: row.worker_id,
    outcome: row.outcome,
    started_at: new Date(row.started_at).toISOString(),
    ...(row.finished_at !== undefined ? { finished_at: new Date(row.finished_at).toISOString() } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    ...(row.error_message ? { error_message: row.error_message } : {}),
  };
}

export function createJobQueryService(store: DurableJobStore): JobQueryService {
  return {
    async listJobs(params): Promise<{ items: CockpitJobItem[]; next_cursor: string | null }> {
      const limit = clampLimit(params.limit);
      const pageParams: JobListPageParams = {
        limit,
        ...(params.cursor ? { cursor: params.cursor } : {}),
        ...(params.status && isPgJobStatus(params.status) ? { status: params.status } : {}),
        ...(params.type && isJobKind(params.type) ? { type: params.type } : {}),
      };

      const page = await store.listPage(pageParams);
      return {
        items: page.items,
        next_cursor: page.nextCursor,
      };
    },

    async getJob(jobId: string): Promise<CockpitJobItem | null> {
      const row = await store.inspect(jobId);
      if (!row) {
        return null;
      }
      return mapCurrentRowToCockpitItem(row);
    },

    async getJobHistory(jobId: string): Promise<CockpitJobAttempt[]> {
      const history = await store.getHistory(jobId);
      return history.map(mapAttemptRowToCockpitAttempt);
    },
  };
}
