import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  buildOrganizeEnqueueInput,
  buildSearchRebuildEnqueueInput,
} from "../../src/jobs/pg-job-builders.js";
import { bootstrapPgJobsSchema } from "../../src/jobs/pg-schema.js";
import { PgJobStore } from "../../src/jobs/pg-store.js";
import { createTestPg, ensureTestDb, resetSchema, teardown, skipPgTests } from "../helpers/pg-test-utils.js";

type CountRow = { cnt: number };
type CurrentJobRow = {
  job_key: string;
  job_type: string;
  status: string;
  attempt_count: number;
  claim_version: number;
};
type AttemptRow = {
  job_key: string;
  claim_version: number;
  attempt_no: number;
  worker_id: string;
  outcome: string;
};

describe.skipIf(skipPgTests)("pg claimNext lease/concurrency", () => {
  let sql: postgres.Sql;
  let storeA: PgJobStore;
  let storeB: PgJobStore;

  beforeAll(async () => {
    await ensureTestDb();
    sql = createTestPg();
    storeA = new PgJobStore(sql);
    storeB = new PgJobStore(sql);
  });

  beforeEach(async () => {
    await resetSchema(sql);
    await bootstrapPgJobsSchema(sql);
  });

  afterAll(async () => {
    await teardown(sql);
  });

  it("race claim: two workers race claim the same pending job", async () => {
    const baseNow = 1_700_010_000_000;
    const enqueueInput = {
      ...buildOrganizeEnqueueInput({
        settlementId: "race-settlement",
        agentId: "agent-race",
        chunkOrdinal: "001",
        chunkNodeRefs: ["node-1"],
        embeddingModelId: "text-embedding-3-small",
      }),
      now_ms: baseNow,
      next_attempt_at: baseNow,
    };

    const enq = await storeA.enqueue(enqueueInput);
    expect(enq.outcome).toBe("created");

    const [r1, r2] = await Promise.all([
      storeA.claimNext({ worker_id: "worker-race-a", now_ms: baseNow + 1, lease_duration_ms: 60_000 }),
      storeB.claimNext({ worker_id: "worker-race-b", now_ms: baseNow + 1, lease_duration_ms: 60_000 }),
    ]);

    const claimed = [r1, r2].filter((r) => r.outcome === "claimed");
    const noneReady = [r1, r2].filter((r) => r.outcome === "none_ready");
    expect(claimed.length).toBe(1);
    expect(noneReady.length).toBe(1);

    if (claimed[0]?.outcome !== "claimed") {
      throw new Error("expected one claimed result");
    }

    expect(claimed[0].job.status).toBe("running");
    expect(claimed[0].job.attempt_count).toBe(1);
    expect(claimed[0].job.claim_version).toBe(1);

    const [current] = await sql<CurrentJobRow[]>`
      SELECT job_key, job_type, status, attempt_count, claim_version
      FROM jobs_current
      WHERE job_key = ${enqueueInput.job_key}
    `;

    expect(current.status).toBe("running");
    expect(Number(current.attempt_count)).toBe(1);
    expect(Number(current.claim_version)).toBe(1);

    const attempts = await sql<AttemptRow[]>`
      SELECT job_key, claim_version, attempt_no, worker_id, outcome
      FROM job_attempts
      WHERE job_key = ${enqueueInput.job_key}
      ORDER BY attempt_id ASC
    `;

    expect(attempts.length).toBe(1);
    expect(attempts[0].job_key).toBe(enqueueInput.job_key);
    expect(Number(attempts[0].claim_version)).toBe(1);
    expect(Number(attempts[0].attempt_no)).toBe(1);
    expect(attempts[0].outcome).toBe("running");
    expect(["worker-race-a", "worker-race-b"]).toContain(attempts[0].worker_id);
  });

  it("concurrency cap: search.rebuild:global cap=1 blocks second concurrent claim", async () => {
    const baseNow = 1_700_010_100_000;
    const firstSearch = {
      ...buildSearchRebuildEnqueueInput({
        scope: "private",
        targetAgentId: "agent-cap-a",
        triggerSource: "manual_cli",
        triggerReason: "full_rebuild",
      }),
      now_ms: baseNow,
      next_attempt_at: baseNow,
    };
    const secondSearch = {
      ...buildSearchRebuildEnqueueInput({
        scope: "private",
        targetAgentId: "agent-cap-b",
        triggerSource: "manual_cli",
        triggerReason: "fts_repair",
      }),
      now_ms: baseNow + 1,
      next_attempt_at: baseNow + 1,
    };

    await storeA.enqueue(firstSearch);
    await storeA.enqueue(secondSearch);

    const firstClaim = await storeA.claimNext({
      worker_id: "worker-cap-1",
      now_ms: baseNow + 10,
      lease_duration_ms: 60_000,
    });
    const secondClaim = await storeB.claimNext({
      worker_id: "worker-cap-2",
      now_ms: baseNow + 11,
      lease_duration_ms: 60_000,
    });

    expect(firstClaim.outcome).toBe("claimed");
    expect(secondClaim.outcome).toBe("none_ready");

    const runningCount = await sql<CountRow[]>`
      SELECT COUNT(*)::int AS cnt
      FROM jobs_current
      WHERE concurrency_key = 'search.rebuild:global'
        AND status = 'running'
    `;
    expect(runningCount[0].cnt).toBe(1);

    const rows = await sql<CurrentJobRow[]>`
      SELECT job_key, job_type, status, attempt_count, claim_version
      FROM jobs_current
      WHERE job_key IN (${firstSearch.job_key}, ${secondSearch.job_key})
      ORDER BY job_key ASC
    `;
    expect(rows.length).toBe(2);

    const byKey = new Map(rows.map((r) => [r.job_key, r]));
    const firstRow = byKey.get(firstSearch.job_key);
    const secondRow = byKey.get(secondSearch.job_key);
    if (!firstRow || !secondRow) {
      throw new Error("expected both search rows");
    }

    expect(firstRow.status).toBe("running");
    expect(Number(firstRow.attempt_count)).toBe(1);
    expect(Number(firstRow.claim_version)).toBe(1);
    expect(secondRow.status).toBe("pending");
    expect(Number(secondRow.attempt_count)).toBe(0);
    expect(Number(secondRow.claim_version)).toBe(0);

    const attemptCount = await sql<CountRow[]>`
      SELECT COUNT(*)::int AS cnt
      FROM job_attempts
      WHERE concurrency_key = 'search.rebuild:global'
    `;
    expect(attemptCount[0].cnt).toBe(1);
  });

  it("skip blocked candidate: claim skips blocked head, finds later runnable row", async () => {
    const baseNow = 1_700_010_200_000;
    const runningSearch = {
      ...buildSearchRebuildEnqueueInput({
        scope: "private",
        targetAgentId: "agent-running",
        triggerSource: "scheduled_maintenance",
        triggerReason: "full_rebuild",
      }),
      now_ms: baseNow,
      next_attempt_at: baseNow,
    };
    await storeA.enqueue(runningSearch);

    const runningClaim = await storeA.claimNext({
      worker_id: "worker-running",
      now_ms: baseNow + 1,
      lease_duration_ms: 60_000,
    });
    expect(runningClaim.outcome).toBe("claimed");

    const blockedHeadSearch = {
      ...buildSearchRebuildEnqueueInput({
        scope: "private",
        targetAgentId: "agent-blocked-head",
        triggerSource: "manual_cli",
        triggerReason: "fts_repair",
      }),
      now_ms: baseNow + 2,
      next_attempt_at: baseNow + 2,
    };
    const laterMemory = {
      ...buildOrganizeEnqueueInput({
        settlementId: "skip-blocked",
        agentId: "agent-memory",
        chunkOrdinal: "005",
        chunkNodeRefs: ["node-a"],
        embeddingModelId: "text-embedding-3-small",
      }),
      now_ms: baseNow + 3,
      next_attempt_at: baseNow + 3,
    };

    await storeA.enqueue(blockedHeadSearch);
    await storeA.enqueue(laterMemory);

    const nextClaim = await storeB.claimNext({
      worker_id: "worker-skip",
      now_ms: baseNow + 10,
      lease_duration_ms: 60_000,
    });

    expect(nextClaim.outcome).toBe("claimed");
    if (nextClaim.outcome !== "claimed") {
      throw new Error("expected memory claim after skipping blocked head");
    }
    expect(nextClaim.job.job_key).toBe(laterMemory.job_key);
    expect(nextClaim.job.job_type).toBe("memory.organize");
    expect(nextClaim.job.status).toBe("running");

    const [blockedRow] = await sql<CurrentJobRow[]>`
      SELECT job_key, job_type, status, attempt_count, claim_version
      FROM jobs_current
      WHERE job_key = ${blockedHeadSearch.job_key}
    `;
    expect(blockedRow.status).toBe("pending");
    expect(Number(blockedRow.attempt_count)).toBe(0);
    expect(Number(blockedRow.claim_version)).toBe(0);

    const runningSearchCount = await sql<CountRow[]>`
      SELECT COUNT(*)::int AS cnt
      FROM jobs_current
      WHERE concurrency_key = 'search.rebuild:global'
        AND status = 'running'
    `;
    expect(runningSearchCount[0].cnt).toBe(1);
  });
});
