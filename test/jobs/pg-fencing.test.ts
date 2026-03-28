import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  buildOrganizeEnqueueInput,
  buildSearchRebuildEnqueueInput,
} from "../../src/jobs/pg-job-builders.js";
import { bootstrapPgJobsSchema } from "../../src/jobs/pg-schema.js";
import { PgJobStore } from "../../src/jobs/pg-store.js";
import { createTestPg, ensureTestDb, resetSchema, teardown } from "../helpers/pg-test-utils.js";

type AttemptOutcomeRow = {
  outcome: string;
  finished_at: number | string | null;
};

type CurrentFenceRow = {
  job_key: string;
  status: string;
  claim_version: number | string;
  next_attempt_at: number | string;
  last_error_message: string | null;
  terminal_at: number | string | null;
  job_family_key: string | null;
  family_state_json: Record<string, unknown> | string;
};

function parseJsonRecord(value: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value;
}

describe("pg fencing mutations", () => {
  let sql: postgres.Sql;
  let store: PgJobStore;

  beforeAll(async () => {
    await ensureTestDb();
    sql = createTestPg();
    store = new PgJobStore(sql);
  });

  beforeEach(async () => {
    await resetSchema(sql);
    await bootstrapPgJobsSchema(sql);
  });

  afterAll(async () => {
    await teardown(sql);
  });

  it("stale worker: stale worker complete is fenced after newer claim", async () => {
    const baseNow = 1_700_020_000_000;
    const enqueueInput = {
      ...buildOrganizeEnqueueInput({
        settlementId: "fence-stale",
        agentId: "agent-stale",
        chunkOrdinal: "001",
        chunkNodeRefs: ["node-1"],
        embeddingModelId: "text-embedding-3-small",
      }),
      now_ms: baseNow,
      next_attempt_at: baseNow,
    };

    await store.enqueue(enqueueInput);
    const claimed = await store.claimNext({
      worker_id: "worker-a",
      now_ms: baseNow + 10,
      lease_duration_ms: 60_000,
    });
    expect(claimed.outcome).toBe("claimed");

    await sql`
      UPDATE jobs_current
      SET claim_version = 2,
          updated_at = ${baseNow + 20}
      WHERE job_key = ${enqueueInput.job_key}
    `;

    const completeResult = await store.complete(enqueueInput.job_key, 1);
    expect(completeResult.outcome).toBe("stale_claim");

    const [current] = await sql<CurrentFenceRow[]>`
      SELECT job_key, status, claim_version, next_attempt_at, last_error_message, terminal_at, job_family_key, family_state_json
      FROM jobs_current
      WHERE job_key = ${enqueueInput.job_key}
    `;

    expect(current.status).toBe("running");
    expect(Number(current.claim_version)).toBe(2);

    const [attempt] = await sql<AttemptOutcomeRow[]>`
      SELECT outcome, finished_at
      FROM job_attempts
      WHERE job_key = ${enqueueInput.job_key}
        AND claim_version = ${1}
      LIMIT 1
    `;

    expect(attempt.outcome).toBe("lease_lost");
    expect(attempt.finished_at).toBeTruthy();
  });

  it("retry scheduled: retryable failure re-schedules as pending with next_attempt_at", async () => {
    const baseNow = 1_700_020_100_000;
    const enqueueInput = {
      ...buildOrganizeEnqueueInput({
        settlementId: "fence-retry",
        agentId: "agent-retry",
        chunkOrdinal: "002",
        chunkNodeRefs: ["node-2"],
        embeddingModelId: "text-embedding-3-small",
      }),
      max_attempts: 3,
      now_ms: baseNow,
      next_attempt_at: baseNow,
    };

    await store.enqueue(enqueueInput);
    const claimed = await store.claimNext({
      worker_id: "worker-retry",
      now_ms: baseNow + 10,
      lease_duration_ms: 60_000,
    });
    expect(claimed.outcome).toBe("claimed");

    const failNow = baseNow + 30;
    const failResult = await store.fail(enqueueInput.job_key, 1, {
      now_ms: failNow,
      error_code: "E_TRANSIENT",
      error_message: "temporary network failure",
      retry_delay_ms: 12_000,
    });

    expect(failResult.outcome).toBe("retry_scheduled");
    if (failResult.outcome !== "retry_scheduled") {
      throw new Error("expected retry_scheduled outcome");
    }

    const [current] = await sql<CurrentFenceRow[]>`
      SELECT job_key, status, claim_version, next_attempt_at, last_error_message, terminal_at, job_family_key, family_state_json
      FROM jobs_current
      WHERE job_key = ${enqueueInput.job_key}
    `;

    expect(current.status).toBe("pending");
    expect(Number(current.next_attempt_at)).toBe(failNow + 12_000);
    expect(Number(current.next_attempt_at)).toBeGreaterThan(failNow);
    expect(current.last_error_message).toBe("temporary network failure");
    expect(current.terminal_at).toBeNull();

    const [attempt] = await sql<AttemptOutcomeRow[]>`
      SELECT outcome, finished_at
      FROM job_attempts
      WHERE job_key = ${enqueueInput.job_key}
        AND claim_version = ${1}
      LIMIT 1
    `;

    expect(attempt.outcome).toBe("failed_retryable");
    expect(attempt.finished_at).toBeTruthy();
  });

  it("rerun requested successor: successful search.rebuild with rerunRequested spawns next generation", async () => {
    const baseNow = 1_700_020_200_000;
    const enqueueInput = {
      ...buildSearchRebuildEnqueueInput({
        scope: "private",
        targetAgentId: "agent-rerun",
        triggerSource: "manual_cli",
        triggerReason: "full_rebuild",
      }),
      now_ms: baseNow,
      next_attempt_at: baseNow,
    };

    await store.enqueue(enqueueInput);
    const claimed = await store.claimNext({
      worker_id: "worker-rerun",
      now_ms: baseNow + 10,
      lease_duration_ms: 60_000,
    });
    expect(claimed.outcome).toBe("claimed");

    await sql`
      UPDATE jobs_current
      SET family_state_json = ${JSON.stringify({
        rerunRequested: true,
        coalescedRequestCount: 4,
        triggerSourceCounts: { manual_cli: 2, doctor_verify: 1 },
        triggerReasonCounts: { full_rebuild: 2, verify_mismatch: 1 },
      })},
          updated_at = ${baseNow + 20}
      WHERE job_key = ${enqueueInput.job_key}
    `;

    const completeResult = await store.complete(enqueueInput.job_key, 1);
    expect(completeResult.outcome).toBe("succeeded");

    const rows = await sql<CurrentFenceRow[]>`
      SELECT job_key, status, claim_version, next_attempt_at, last_error_message, terminal_at, job_family_key, family_state_json
      FROM jobs_current
      WHERE job_family_key = ${enqueueInput.job_family_key}
      ORDER BY created_at ASC
    `;

    expect(rows.length).toBe(2);

    const original = rows.find((row) => row.job_key === enqueueInput.job_key);
    const successor = rows.find((row) => row.job_key !== enqueueInput.job_key);

    if (!original || !successor) {
      throw new Error("expected original and successor rows");
    }

    expect(original.status).toBe("succeeded");
    expect(original.terminal_at).toBeTruthy();

    expect(successor.status).toBe("pending");
    expect(successor.job_family_key).toBe(enqueueInput.job_family_key);
    expect(successor.job_key).not.toBe(enqueueInput.job_key);

    const successorFamilyState = parseJsonRecord(successor.family_state_json);
    expect(successorFamilyState.rerunRequested).toBe(false);
    expect(successorFamilyState.coalescedRequestCount).toBe(0);
    expect(successorFamilyState.triggerSourceCounts).toEqual({ manual_cli: 2, doctor_verify: 1 });
    expect(successorFamilyState.triggerReasonCounts).toEqual({ full_rebuild: 2, verify_mismatch: 1 });
  });
});
