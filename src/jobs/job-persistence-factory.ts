import type {
  DurableJobStore,
  EnqueueJobInput,
  PgJobCurrentRow,
} from "./durable-store.js";
import type {
  JobEntry,
  JobPersistence,
  PersistentJobStatus,
} from "./persistence.js";
import type { JobKind } from "./types.js";
import type { PgBackendFactory } from "../storage/backend-types.js";

type PgFactoryWithStore = PgBackendFactory & { store?: DurableJobStore };

export class PgJobPersistence implements JobPersistence {
  constructor(private readonly pgFactory: PgBackendFactory) {}

  async enqueue(entry: Omit<JobEntry, "attemptCount" | "createdAt" | "updatedAt">): Promise<void> {
    const store = this.resolveStore();
    const input = this.toEnqueueInput(entry);
    await store.enqueue(input);
  }

  async claim(jobId: string, claimedBy: string, leaseDurationMs: number): Promise<boolean> {
    const store = this.resolveStore();
    const result = await store.claimNext({
      worker_id: claimedBy,
      now_ms: Date.now(),
      lease_duration_ms: leaseDurationMs,
    });
    return result.outcome === "claimed" && result.job.job_key === jobId;
  }

  async complete(jobId: string): Promise<void> {
    const store = this.resolveStore();
    const inspected = await store.inspect(jobId);
    await store.complete(jobId, inspected?.claim_version ?? 0);
  }

  async fail(jobId: string, errorMessage: string, retryable: boolean): Promise<void> {
    const store = this.resolveStore();
    const inspected = await store.inspect(jobId);
    await store.fail(jobId, inspected?.claim_version ?? 0, {
      now_ms: Date.now(),
      error_message: errorMessage,
      ...(retryable ? { retry_delay_ms: 0 } : {}),
    });
  }

  async retry(jobId: string): Promise<boolean> {
    const store = this.resolveStore();
    const inspected = await store.inspect(jobId);
    return inspected?.status === "pending";
  }

  async listPending(limit = 100): Promise<JobEntry[]> {
    const store = this.resolveStore();
    const active = await store.listActive();
    return active
      .filter((row) => row.status === "pending")
      .slice(0, normalizeLimit(limit))
      .map((row) => this.toEntry(row, "pending"));
  }

  async listRetryable(beforeTime: number, limit = 100): Promise<JobEntry[]> {
    const store = this.resolveStore();
    const active = await store.listActive();
    return active
      .filter(
        (row) =>
          row.status === "pending"
          && row.attempt_count > 0
          && row.next_attempt_at <= beforeTime,
      )
      .slice(0, normalizeLimit(limit))
      .map((row) => this.toEntry(row, "retryable"));
  }

  async countByStatus(status: PersistentJobStatus): Promise<number> {
    const store = this.resolveStore();
    if (status === "retryable") {
      const active = await store.listActive();
      return active.filter((row) => row.status === "pending" && row.attempt_count > 0).length;
    }

    const counts = await store.countByStatus();
    if (status === "pending") {
      return counts.pending;
    }
    if (status === "processing") {
      return counts.running;
    }
    if (status === "reconciled") {
      return counts.succeeded;
    }
    if (status === "exhausted") {
      return counts.failed_terminal + counts.cancelled;
    }
    return 0;
  }

  private resolveStore(): DurableJobStore {
    const store = (this.pgFactory as PgFactoryWithStore).store;
    if (!store) {
      throw new Error("PG backend factory does not expose durable store");
    }
    return store;
  }

  private toEntry(row: PgJobCurrentRow, status: PersistentJobStatus): JobEntry {
    return {
      id: row.job_key,
      jobType: row.job_type,
      payload: row.payload_json,
      status,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      errorMessage: row.last_error_message,
      nextAttemptAt: row.next_attempt_at,
      claimedAt: row.claimed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toEnqueueInput(
    entry: Omit<JobEntry, "attemptCount" | "createdAt" | "updatedAt">,
  ): EnqueueJobInput<JobKind> {
    if (entry.jobType === "search.rebuild") {
      return {
        job_key: entry.id,
        job_type: "search.rebuild",
        job_family_key: this.searchRebuildFamilyKey(entry.id),
        execution_class: "background.search_rebuild",
        concurrency_key: "search.rebuild:global",
        payload_schema_version: 1,
        payload_json: entry.payload as never,
        max_attempts: entry.maxAttempts,
        now_ms: Date.now(),
        next_attempt_at: entry.nextAttemptAt,
      };
    }

    if (entry.jobType === "memory.migrate") {
      return {
        job_key: entry.id,
        job_type: "memory.migrate",
        execution_class: "background.memory_migrate",
        concurrency_key: "memory.migrate:global",
        payload_schema_version: 1,
        payload_json: entry.payload as never,
        max_attempts: entry.maxAttempts,
        now_ms: Date.now(),
        next_attempt_at: entry.nextAttemptAt,
      };
    }

    if (entry.jobType === "memory.organize") {
      return {
        job_key: entry.id,
        job_type: "memory.organize",
        execution_class: "background.memory_organize",
        concurrency_key: "memory.organize:global",
        payload_schema_version: 1,
        payload_json: entry.payload as never,
        max_attempts: entry.maxAttempts,
        now_ms: Date.now(),
        next_attempt_at: entry.nextAttemptAt,
      };
    }

    if (entry.jobType === "maintenance.replay_projection") {
      return {
        job_key: entry.id,
        job_type: "maintenance.replay_projection",
        execution_class: "background.maintenance_replay",
        concurrency_key: "maintenance.replay_projection:global",
        payload_schema_version: 1,
        payload_json: entry.payload as never,
        max_attempts: entry.maxAttempts,
        now_ms: Date.now(),
        next_attempt_at: entry.nextAttemptAt,
      };
    }

    if (entry.jobType === "maintenance.rebuild_derived") {
      return {
        job_key: entry.id,
        job_type: "maintenance.rebuild_derived",
        execution_class: "background.maintenance_rebuild_derived",
        concurrency_key: "maintenance.rebuild_derived:global",
        payload_schema_version: 1,
        payload_json: entry.payload as never,
        max_attempts: entry.maxAttempts,
        now_ms: Date.now(),
        next_attempt_at: entry.nextAttemptAt,
      };
    }

    if (entry.jobType === "maintenance.full") {
      return {
        job_key: entry.id,
        job_type: "maintenance.full",
        execution_class: "background.maintenance_full",
        concurrency_key: "maintenance.full:global",
        payload_schema_version: 1,
        payload_json: entry.payload as never,
        max_attempts: entry.maxAttempts,
        now_ms: Date.now(),
        next_attempt_at: entry.nextAttemptAt,
      };
    }

    if (entry.jobType === "cognition.thinker") {
      const p = entry.payload as { sessionId?: string };
      const sessionId = p?.sessionId ?? "unknown";
      return {
        job_key: entry.id,
        job_type: "cognition.thinker",
        execution_class: "background.cognition_thinker",
        concurrency_key: `cognition.thinker:session:${sessionId}`,
        payload_schema_version: 1,
        payload_json: entry.payload as never,
        max_attempts: entry.maxAttempts,
        now_ms: Date.now(),
        next_attempt_at: entry.nextAttemptAt,
      };
    }

    return {
      job_key: entry.id,
      job_type: "task.run",
      execution_class: "background.autonomy",
      concurrency_key: "task.run:default-parent:1",
      payload_schema_version: 1,
      payload_json: entry.payload as never,
      max_attempts: entry.maxAttempts,
      now_ms: Date.now(),
      next_attempt_at: entry.nextAttemptAt,
    };
  }

  private searchRebuildFamilyKey(jobKey: string): string {
    const requestDelimiter = ":req:";
    const index = jobKey.indexOf(requestDelimiter);
    if (index > 0) {
      return jobKey.slice(0, index);
    }
    return jobKey;
  }
}

export function createJobPersistence(
  backendType: "pg",
  options: { pgFactory?: PgBackendFactory },
): JobPersistence {
  if (!options.pgFactory) {
    throw new Error("PG backend requires pgFactory");
  }
  return new PgJobPersistence(options.pgFactory);
}

function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
}
