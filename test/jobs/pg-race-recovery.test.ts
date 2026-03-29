import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { buildOrganizeEnqueueInput } from "../../src/jobs/pg-job-builders.js";
import { bootstrapPgJobsSchema } from "../../src/jobs/pg-schema.js";
import { PgJobStore } from "../../src/jobs/pg-store.js";
import { createTestPg, ensureTestDb, resetSchema, teardown } from "../helpers/pg-test-utils.js";

type AttemptRow = {
  claim_version: number | string;
  worker_id: string;
  outcome: string;
  finished_at: number | string | null;
  backoff_until: number | string | null;
};

type CurrentRow = {
  status: string;
  attempt_count: number | string;
  claim_version: number | string;
  next_attempt_at: number | string;
};

describe("pg race recovery semantics", () => {
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

  it("lease expiry: lease expiry transfers ownership from worker A to worker B", async () => {
    const now = Date.now();
    const enqueueInput = {
      ...buildOrganizeEnqueueInput({
        settlementId: "race-lease-expiry",
        agentId: "agent-race-a",
        chunkOrdinal: "001",
        chunkNodeRefs: ["node-1"],
        embeddingModelId: "text-embedding-3-small",
      }),
      now_ms: now,
      next_attempt_at: now,
    };

    const enqueue = await store.enqueue(enqueueInput);
    expect(enqueue.outcome).toBe("created");

    const workerAClaim = await store.claimNext({
      worker_id: "worker-a",
      now_ms: now + 1,
      lease_duration_ms: 100,
    });
    expect(workerAClaim.outcome).toBe("claimed");
    if (workerAClaim.outcome !== "claimed") {
      throw new Error("expected worker A claim");
    }
    expect(workerAClaim.job.claim_version).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 150));

    const reaperNow = Date.now();
    const reclaimedCount = await store.reclaimExpiredLeases(reaperNow);
    expect(reclaimedCount).toBe(1);

    const workerBClaim = await store.claimNext({
      worker_id: "worker-b",
      now_ms: reaperNow,
      lease_duration_ms: 30_000,
    });
    expect(workerBClaim.outcome).toBe("claimed");
    if (workerBClaim.outcome !== "claimed") {
      throw new Error("expected worker B claim");
    }
    expect(workerBClaim.job.claim_version).toBe(2);

    const staleHeartbeat = await store.heartbeat(enqueueInput.job_key, 1, reaperNow + 1);
    expect(staleHeartbeat.outcome).toBe("stale_claim");

    const staleComplete = await store.complete(enqueueInput.job_key, 1);
    expect(staleComplete.outcome).toBe("stale_claim");

    const [attemptA] = await sql<AttemptRow[]>`
      SELECT claim_version, worker_id, outcome, finished_at, backoff_until
      FROM job_attempts
      WHERE job_key = ${enqueueInput.job_key}
        AND claim_version = 1
      LIMIT 1
    `;
    expect(Number(attemptA.claim_version)).toBe(1);
    expect(attemptA.worker_id).toBe("worker-a");
    expect(attemptA.outcome).toBe("lease_lost");
    expect(attemptA.finished_at).toBeTruthy();

    const [attemptBBeforeComplete] = await sql<AttemptRow[]>`
      SELECT claim_version, worker_id, outcome, finished_at, backoff_until
      FROM job_attempts
      WHERE job_key = ${enqueueInput.job_key}
        AND claim_version = 2
      LIMIT 1
    `;
    expect(Number(attemptBBeforeComplete.claim_version)).toBe(2);
    expect(attemptBBeforeComplete.worker_id).toBe("worker-b");
    expect(attemptBBeforeComplete.outcome).toBe("running");

    const workerBComplete = await store.complete(enqueueInput.job_key, 2);
    expect(workerBComplete.outcome).toBe("succeeded");

    const [attemptBAfterComplete] = await sql<AttemptRow[]>`
      SELECT claim_version, worker_id, outcome, finished_at, backoff_until
      FROM job_attempts
      WHERE job_key = ${enqueueInput.job_key}
        AND claim_version = 2
      LIMIT 1
    `;
    expect(attemptBAfterComplete.outcome).toBe("succeeded");
    expect(attemptBAfterComplete.finished_at).toBeTruthy();
  });

  it("retry schedule: retry-scheduled job becomes claimable after next_attempt_at", async () => {
    const now = Date.now();
    const enqueueInput = {
      ...buildOrganizeEnqueueInput({
        settlementId: "race-retry-schedule",
        agentId: "agent-race-retry",
        chunkOrdinal: "002",
        chunkNodeRefs: ["node-2"],
        embeddingModelId: "text-embedding-3-small",
      }),
      max_attempts: 3,
      now_ms: now,
      next_attempt_at: now,
    };

    const enqueue = await store.enqueue(enqueueInput);
    expect(enqueue.outcome).toBe("created");

    const firstClaim = await store.claimNext({
      worker_id: "worker-a",
      now_ms: now + 1,
      lease_duration_ms: 30_000,
    });
    expect(firstClaim.outcome).toBe("claimed");
    if (firstClaim.outcome !== "claimed") {
      throw new Error("expected first claim");
    }
    expect(firstClaim.job.claim_version).toBe(1);

    const failNow = now + 10;
    const failResult = await store.fail(enqueueInput.job_key, 1, {
      now_ms: failNow,
      error_code: "E_TRANSIENT",
      error_message: "temporary failure",
      retry_delay_ms: 5_000,
    });
    expect(failResult.outcome).toBe("retry_scheduled");
    if (failResult.outcome !== "retry_scheduled") {
      throw new Error("expected retry_scheduled");
    }

    const immediateClaim = await store.claimNext({
      worker_id: "worker-b",
      now_ms: failNow + 1,
      lease_duration_ms: 30_000,
    });
    expect(immediateClaim.outcome).toBe("none_ready");

    const simulatedNow = Date.now();
    await sql`
      UPDATE jobs_current
      SET next_attempt_at = ${simulatedNow - 1},
          updated_at = ${simulatedNow}
      WHERE job_key = ${enqueueInput.job_key}
        AND status = 'pending'
    `;

    const secondClaim = await store.claimNext({
      worker_id: "worker-b",
      now_ms: simulatedNow,
      lease_duration_ms: 30_000,
    });
    expect(secondClaim.outcome).toBe("claimed");
    if (secondClaim.outcome !== "claimed") {
      throw new Error("expected second claim");
    }

    expect(secondClaim.job.status).toBe("running");
    expect(secondClaim.job.attempt_count).toBe(2);
    expect(secondClaim.job.claim_version).toBe(2);

    const [current] = await sql<CurrentRow[]>`
      SELECT status, attempt_count, claim_version, next_attempt_at
      FROM jobs_current
      WHERE job_key = ${enqueueInput.job_key}
      LIMIT 1
    `;
    expect(current.status).toBe("running");
    expect(Number(current.attempt_count)).toBe(2);
    expect(Number(current.claim_version)).toBe(2);

    const attempts = await sql<AttemptRow[]>`
      SELECT claim_version, worker_id, outcome, finished_at, backoff_until
      FROM job_attempts
      WHERE job_key = ${enqueueInput.job_key}
      ORDER BY claim_version ASC
    `;
    expect(attempts.length).toBe(2);
    expect(Number(attempts[0].claim_version)).toBe(1);
    expect(attempts[0].outcome).toBe("failed_retry_scheduled");
    expect(Number(attempts[0].backoff_until)).toBe(failNow + 5_000);
    expect(Number(attempts[1].claim_version)).toBe(2);
    expect(attempts[1].outcome).toBe("running");
  });
});
