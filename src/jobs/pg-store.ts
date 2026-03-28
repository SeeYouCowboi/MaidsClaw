import type postgres from "postgres";
import type { JobKind } from "./types.js";
import type {
  DurableJobStore,
  EnqueueJobInput,
  EnqueueResult,
  ClaimNextInput,
  ClaimNextResult,
  HeartbeatResult,
  CompleteResult,
  PgJobFailInput,
  FailResult,
  CancelResult,
  PgJobCurrentRow,
  PgJobAttemptHistoryRow,
  PgStatusCount,
} from "./durable-store.js";

/**
 * PostgreSQL-backed implementation of `DurableJobStore`.
 *
 * T6 implements `enqueue()` with `job_key`-level idempotency.
 * Remaining methods are stubs for T7–T10.
 */
export class PgJobStore implements DurableJobStore {
  constructor(private readonly sql: postgres.Sql) {}

  // ── enqueue ─────────────────────────────────────────────────────────
  async enqueue<K extends JobKind>(input: EnqueueJobInput<K>): Promise<EnqueueResult> {
    const nextAttemptAt = input.next_attempt_at ?? input.now_ms;

    const rows = await this.sql`
      INSERT INTO jobs_current (
        job_key,
        job_type,
        job_family_key,
        execution_class,
        concurrency_key,
        status,
        payload_schema_version,
        payload_json,
        family_state_json,
        claim_version,
        attempt_count,
        max_attempts,
        next_attempt_at,
        created_at,
        updated_at
      ) VALUES (
        ${input.job_key},
        ${input.job_type},
        ${input.job_family_key ?? null},
        ${input.execution_class},
        ${input.concurrency_key},
        ${"pending"},
        ${input.payload_schema_version},
        ${JSON.stringify(input.payload_json)},
        ${JSON.stringify({})},
        ${0},
        ${0},
        ${input.max_attempts},
        ${nextAttemptAt},
        ${input.now_ms},
        ${input.now_ms}
      )
      ON CONFLICT (job_key) DO NOTHING
    `;

    if (rows.count === 0) {
      const existing = await this.sql<PgJobCurrentRow[]>`
        SELECT job_key, job_family_key, status, claim_version
        FROM jobs_current
        WHERE job_key = ${input.job_key}
      `;

      const row = existing[0];
      return {
        outcome: "duplicate" as const,
        job_key: input.job_key,
        job_family_key: row?.job_family_key ?? input.job_family_key ?? undefined,
        status: (row?.status ?? "pending") as PgJobCurrentRow["status"],
        claim_version: row?.claim_version ?? 0,
      };
    }

    return {
      outcome: "created" as const,
      job_key: input.job_key,
      job_family_key: input.job_family_key ?? undefined,
      status: "pending" as const,
      claim_version: 0,
    };
  }

  // ── stubs (T7–T10) ─────────────────────────────────────────────────
  async claimNext(_input: ClaimNextInput): Promise<ClaimNextResult> {
    throw new Error("not yet implemented");
  }

  async heartbeat(_job_key: string, _cv: number, _now: number): Promise<HeartbeatResult> {
    throw new Error("not yet implemented");
  }

  async complete(_job_key: string, _cv: number): Promise<CompleteResult> {
    throw new Error("not yet implemented");
  }

  async fail(_job_key: string, _cv: number, _err: PgJobFailInput): Promise<FailResult> {
    throw new Error("not yet implemented");
  }

  async cancel(_job_key: string, _cv: number): Promise<CancelResult> {
    throw new Error("not yet implemented");
  }

  async inspect(_job_key: string): Promise<PgJobCurrentRow | undefined> {
    throw new Error("not yet implemented");
  }

  async listActive(): Promise<PgJobCurrentRow[]> {
    throw new Error("not yet implemented");
  }

  async listExpiredLeases(_nowMs: number): Promise<PgJobCurrentRow[]> {
    throw new Error("not yet implemented");
  }

  async countByStatus(): Promise<PgStatusCount> {
    throw new Error("not yet implemented");
  }

  async getHistory(_job_key: string): Promise<PgJobAttemptHistoryRow[]> {
    throw new Error("not yet implemented");
  }
}
