import { describe, expect, it } from "bun:test";
import type {
  CancelResult,
  ClaimNextInput,
  ClaimNextResult,
  CockpitJobItem,
  CompleteResult,
  DurableJobStore,
  EnqueueJobInput,
  FailResult,
  HeartbeatResult,
  JobListPageParams,
  JobListPageResult,
  PgJobAttemptHistoryRow,
  PgJobCurrentRow,
  PgJobFailInput,
  PgJobStatus,
  PgStatusCount,
} from "../../src/jobs/durable-store.js";
import { createJobQueryService } from "../../src/jobs/job-query-service.js";
import type { JobKind } from "../../src/jobs/types.js";

const DURABLE_STATUSES = ["pending", "running", "succeeded", "failed_terminal", "cancelled"] as const satisfies readonly PgJobStatus[];

function isPgJobStatus(value: string): value is PgJobStatus {
  return DURABLE_STATUSES.includes(value as PgJobStatus);
}

class InMemoryDurableStore implements DurableJobStore {
  constructor(private readonly pageItems: CockpitJobItem[]) {}

  async listPage(params: JobListPageParams): Promise<JobListPageResult> {
    const limit = Math.max(1, Math.min(200, params.limit));
    const items = this.pageItems
      .filter((item) => (params.status ? item.status === params.status : true))
      .filter((item) => (params.type ? item.job_type === params.type : true))
      .slice(0, limit);
    return { items, nextCursor: null };
  }

  async enqueue<K extends JobKind>(_input: EnqueueJobInput<K>) {
    throw new Error("not implemented");
  }

  async claimNext(_input: ClaimNextInput): Promise<ClaimNextResult> {
    throw new Error("not implemented");
  }

  async heartbeat(_job_key: string, _claim_version: number, _nowMs: number): Promise<HeartbeatResult> {
    throw new Error("not implemented");
  }

  async complete(_job_key: string, _claim_version: number, _resultJson?: unknown): Promise<CompleteResult> {
    throw new Error("not implemented");
  }

  async fail(_job_key: string, _claim_version: number, _error: PgJobFailInput): Promise<FailResult> {
    throw new Error("not implemented");
  }

  async cancel(_job_key: string, _claim_version: number): Promise<CancelResult> {
    throw new Error("not implemented");
  }

  async reclaimExpiredLeases(_nowMs: number): Promise<number> {
    return 0;
  }

  async inspect(_job_key: string): Promise<PgJobCurrentRow | undefined> {
    return undefined;
  }

  async listActive(): Promise<PgJobCurrentRow[]> {
    return [];
  }

  async listPendingByKindAndPayload(
    _jobType: JobKind,
    _payloadFilter: Record<string, string>,
    _now_ms: number,
  ): Promise<PgJobCurrentRow[]> {
    return [];
  }

  async listExpiredLeases(_nowMs: number): Promise<PgJobCurrentRow[]> {
    return [];
  }

  async countByStatus(): Promise<PgStatusCount> {
    return { pending: 0, running: 0, succeeded: 0, failed_terminal: 0, cancelled: 0 };
  }

  async getHistory(_job_key: string): Promise<PgJobAttemptHistoryRow[]> {
    return [];
  }
}

describe("job query durable statuses", () => {
  it("job items never contain processing/retryable/reconciled", async () => {
    const items: CockpitJobItem[] = DURABLE_STATUSES.map((status, index) => ({
      job_id: `job-${index + 1}`,
      job_type: "task.run",
      execution_class: "background.autonomy",
      status,
      created_at: "2026-04-12T00:00:00.000Z",
      updated_at: "2026-04-12T00:00:00.000Z",
      attempt_count: 0,
      max_attempts: 3,
    }));

    const service = createJobQueryService(new InMemoryDurableStore(items));
    const result = await service.listJobs({ limit: 50 });
    const statuses = result.items.map((item) => item.status);

    expect(statuses.includes("processing" as PgJobStatus)).toBe(false);
    expect(statuses.includes("retryable" as PgJobStatus)).toBe(false);
    expect(statuses.includes("reconciled" as PgJobStatus)).toBe(false);
  });

  it("all 5 durable statuses are accepted", async () => {
    const items: CockpitJobItem[] = DURABLE_STATUSES.map((status, index) => ({
      job_id: `job-${index + 1}`,
      job_type: "task.run",
      execution_class: "background.autonomy",
      status,
      created_at: "2026-04-12T00:00:00.000Z",
      updated_at: "2026-04-12T00:00:00.000Z",
      attempt_count: 0,
      max_attempts: 3,
    }));

    const service = createJobQueryService(new InMemoryDurableStore(items));

    for (const status of DURABLE_STATUSES) {
      const result = await service.listJobs({ status, limit: 50 });
      expect(result.items.length).toBe(1);
      expect(result.items[0].status).toBe(status);
    }
  });

  it("status strings in response match PgJobStatus exactly", async () => {
    const items: CockpitJobItem[] = DURABLE_STATUSES.map((status, index) => ({
      job_id: `job-${index + 1}`,
      job_type: "task.run",
      execution_class: "background.autonomy",
      status,
      created_at: "2026-04-12T00:00:00.000Z",
      updated_at: "2026-04-12T00:00:00.000Z",
      attempt_count: 0,
      max_attempts: 3,
    }));

    const service = createJobQueryService(new InMemoryDurableStore(items));
    const result = await service.listJobs({ limit: 50 });

    for (const item of result.items) {
      expect(isPgJobStatus(item.status)).toBe(true);
    }
  });
});
