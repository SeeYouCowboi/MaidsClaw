import { describe, expect, it } from "bun:test";
import { decodeCursor, encodeCursor } from "../../src/contracts/cockpit/cursor.js";
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
  PgStatusCount,
} from "../../src/jobs/durable-store.js";
import { createJobQueryService } from "../../src/jobs/job-query-service.js";
import type { JobKind } from "../../src/jobs/types.js";

const STATUS_ORDER = ["pending", "running", "succeeded", "failed_terminal", "cancelled"] as const;

function makeRow(overrides: Partial<PgJobCurrentRow>): PgJobCurrentRow {
  return {
    job_key: overrides.job_key ?? crypto.randomUUID(),
    job_type: overrides.job_type ?? "task.run",
    job_family_key: overrides.job_family_key,
    execution_class: overrides.execution_class ?? "background.autonomy",
    concurrency_key: overrides.concurrency_key ?? "task.run:default-parent:1",
    status: overrides.status ?? "pending",
    payload_schema_version: overrides.payload_schema_version ?? 1,
    payload_json: overrides.payload_json ?? {},
    family_state_json: overrides.family_state_json ?? {},
    claim_version: overrides.claim_version ?? 0,
    claimed_by: overrides.claimed_by,
    claimed_at: overrides.claimed_at,
    lease_expires_at: overrides.lease_expires_at,
    last_heartbeat_at: overrides.last_heartbeat_at,
    attempt_count: overrides.attempt_count ?? 0,
    max_attempts: overrides.max_attempts ?? 3,
    next_attempt_at: overrides.next_attempt_at ?? 0,
    last_error_code: overrides.last_error_code,
    last_error_message: overrides.last_error_message,
    last_error_at: overrides.last_error_at,
    created_at: overrides.created_at ?? Date.now(),
    updated_at: overrides.updated_at ?? Date.now(),
    terminal_at: overrides.terminal_at,
  };
}

class InMemoryDurableJobStore implements DurableJobStore {
  private readonly rowsByJobId = new Map<string, PgJobCurrentRow>();
  private readonly pageItems: CockpitJobItem[];
  private readonly historyByJobId = new Map<string, PgJobAttemptHistoryRow[]>();

  constructor(rows: PgJobCurrentRow[], pageItems: CockpitJobItem[], history: Record<string, PgJobAttemptHistoryRow[]> = {}) {
    for (const row of rows) {
      this.rowsByJobId.set(row.job_key, row);
    }
    this.pageItems = pageItems;
    for (const [jobId, attempts] of Object.entries(history)) {
      this.historyByJobId.set(jobId, attempts);
    }
  }

  async listPage(params: JobListPageParams): Promise<JobListPageResult> {
    const limit = Math.max(1, Math.min(200, params.limit));

    let items = this.pageItems
      .filter((item) => (params.status ? item.status === params.status : true))
      .filter((item) => (params.type ? item.job_type === params.type : true))
      .sort((a, b) => {
        const updatedDiff = Date.parse(b.updated_at) - Date.parse(a.updated_at);
        if (updatedDiff !== 0) {
          return updatedDiff;
        }
        return b.job_id.localeCompare(a.job_id);
      });

    if (params.cursor) {
      const payload = decodeCursor(params.cursor);
      const boundaryUpdatedAt = Date.parse(String(payload.sort_key));
      const boundaryJobId = payload.tie_breaker;
      items = items.filter((item) => {
        const itemUpdatedAt = Date.parse(item.updated_at);
        if (itemUpdatedAt < boundaryUpdatedAt) {
          return true;
        }
        if (itemUpdatedAt > boundaryUpdatedAt) {
          return false;
        }
        return item.job_id < boundaryJobId;
      });
    }

    const hasNext = items.length > limit;
    const pageItems = hasNext ? items.slice(0, limit) : items;
    const nextCursor = hasNext && pageItems.length > 0
      ? encodeCursor({
        v: 1,
        sort_key: pageItems[pageItems.length - 1].updated_at,
        tie_breaker: pageItems[pageItems.length - 1].job_id,
      })
      : null;

    return {
      items: pageItems,
      nextCursor,
    };
  }

  async inspect(job_key: string): Promise<PgJobCurrentRow | undefined> {
    return this.rowsByJobId.get(job_key);
  }

  async getHistory(job_key: string): Promise<PgJobAttemptHistoryRow[]> {
    return this.historyByJobId.get(job_key) ?? [];
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
    return {
      pending: 0,
      running: 0,
      succeeded: 0,
      failed_terminal: 0,
      cancelled: 0,
    };
  }
}

describe("createJobQueryService", () => {
  it("listJobs returns correctly shaped items", async () => {
    const now = new Date("2026-04-12T00:00:00.000Z").toISOString();
    const store = new InMemoryDurableJobStore(
      [],
      [
        {
          job_id: "job-1",
          job_type: "task.run",
          execution_class: "background.autonomy",
          status: "running",
          created_at: now,
          updated_at: now,
          started_at: now,
          attempt_count: 1,
          max_attempts: 3,
        },
      ],
    );

    const service = createJobQueryService(store);
    const result = await service.listJobs({ limit: 50 });

    expect(result.next_cursor).toBeNull();
    expect(result.items).toEqual([
      {
        job_id: "job-1",
        job_type: "task.run",
        execution_class: "background.autonomy",
        status: "running",
        created_at: now,
        updated_at: now,
        started_at: now,
        attempt_count: 1,
        max_attempts: 3,
      },
    ]);
  });

  it("listJobs({ status: 'running' }) only returns running items", async () => {
    const baseTime = new Date("2026-04-12T00:00:00.000Z").toISOString();
    const store = new InMemoryDurableJobStore(
      [],
      STATUS_ORDER.map((status, index) => ({
        job_id: `job-${index + 1}`,
        job_type: "task.run",
        execution_class: "background.autonomy",
        status,
        created_at: baseTime,
        updated_at: baseTime,
        attempt_count: 0,
        max_attempts: 3,
      })),
    );

    const service = createJobQueryService(store);
    const result = await service.listJobs({ status: "running", limit: 50 });

    expect(result.items.length).toBe(1);
    expect(result.items[0].status).toBe("running");
  });

  it("getJob(id) returns null for missing job", async () => {
    const service = createJobQueryService(new InMemoryDurableJobStore([], []));
    const job = await service.getJob("missing-job");
    expect(job).toBeNull();
  });

  it("getJob(id) returns item for existing job", async () => {
    const row = makeRow({
      job_key: "job-existing",
      job_type: "task.run",
      execution_class: "background.autonomy",
      status: "failed_terminal",
      attempt_count: 2,
      max_attempts: 3,
      claimed_at: Date.parse("2026-04-11T00:00:00.000Z"),
      terminal_at: Date.parse("2026-04-11T00:00:05.000Z"),
      created_at: Date.parse("2026-04-11T00:00:00.000Z"),
      updated_at: Date.parse("2026-04-11T00:00:05.000Z"),
      last_error_code: "WORKER_FAIL",
      last_error_message: "worker failed",
    });
    const service = createJobQueryService(new InMemoryDurableJobStore([row], []));

    const job = await service.getJob("job-existing");

    expect(job).toEqual({
      job_id: "job-existing",
      job_type: "task.run",
      execution_class: "background.autonomy",
      status: "failed_terminal",
      created_at: "2026-04-11T00:00:00.000Z",
      updated_at: "2026-04-11T00:00:05.000Z",
      started_at: "2026-04-11T00:00:00.000Z",
      finished_at: "2026-04-11T00:00:05.000Z",
      attempt_count: 2,
      max_attempts: 3,
      last_error_code: "WORKER_FAIL",
      last_error_message: "worker failed",
    });
  });

  it("getJobHistory(id) returns mapped attempts from store.getHistory()", async () => {
    const history: PgJobAttemptHistoryRow[] = [
      {
        attempt_id: 10,
        job_key: "job-history",
        job_type: "task.run",
        execution_class: "background.autonomy",
        concurrency_key: "task.run:default-parent:1",
        claim_version: 1,
        attempt_no: 2,
        worker_id: "worker-1",
        outcome: "failed_terminal",
        payload_schema_version: 1,
        payload_snapshot_json: {},
        family_state_snapshot_json: {},
        started_at: Date.parse("2026-04-11T00:00:00.000Z"),
        lease_expires_at: Date.parse("2026-04-11T00:00:30.000Z"),
        finished_at: Date.parse("2026-04-11T00:00:03.000Z"),
        error_code: "E_WORKER",
        error_message: "worker failed",
      },
    ];

    const service = createJobQueryService(
      new InMemoryDurableJobStore([], [], { "job-history": history }),
    );

    const attempts = await service.getJobHistory("job-history");

    expect(attempts).toEqual([
      {
        attempt_no: 2,
        worker_id: "worker-1",
        outcome: "failed_terminal",
        started_at: "2026-04-11T00:00:00.000Z",
        finished_at: "2026-04-11T00:00:03.000Z",
        error_code: "E_WORKER",
        error_message: "worker failed",
      },
    ]);
  });

  it("cognition.thinker payload extracts session_id and agent_id", async () => {
    const row = makeRow({
      job_key: "thinker-job",
      job_type: "cognition.thinker",
      execution_class: "background.cognition_thinker",
      concurrency_key: "cognition.thinker:session:sess-1",
      status: "running",
      payload_json: {
        sessionId: "sess-1",
        agentId: "agent-9",
        settlementId: "settle-1",
        talkerTurnVersion: 12,
      },
      claimed_at: Date.parse("2026-04-12T01:00:00.000Z"),
      created_at: Date.parse("2026-04-12T00:59:00.000Z"),
      updated_at: Date.parse("2026-04-12T01:00:00.000Z"),
    });

    const service = createJobQueryService(new InMemoryDurableJobStore([row], []));
    const job = await service.getJob("thinker-job");

    expect(job).toMatchObject({
      job_id: "thinker-job",
      job_type: "cognition.thinker",
      session_id: "sess-1",
      agent_id: "agent-9",
      status: "running",
    });
  });
});
