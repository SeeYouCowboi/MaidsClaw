import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { buildOrganizeEnqueueInput, buildSearchRebuildEnqueueInput } from "../../src/jobs/pg-job-builders.js";
import { bootstrapPgJobsSchema } from "../../src/jobs/pg-schema.js";
import { PgJobStore } from "../../src/jobs/pg-store.js";
import { createTestPg, ensureTestDb, resetSchema, teardown, skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("pg retention and inspect", () => {
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

  it("history remains: terminal current row removed while attempt history stays", async () => {
    const baseNow = 1_700_030_000_000;
    const input = {
      ...buildOrganizeEnqueueInput({
        settlementId: "ret-hist-1",
        agentId: "agent-ret",
        chunkOrdinal: "001",
        chunkNodeRefs: ["node-1"],
        embeddingModelId: "text-embedding-3-small",
      }),
      now_ms: baseNow,
      next_attempt_at: baseNow,
    };

    await store.enqueue(input);

    const claimed = await store.claimNext({
      worker_id: "worker-ret",
      now_ms: baseNow + 10,
      lease_duration_ms: 60_000,
    });
    expect(claimed.outcome).toBe("claimed");
    if (claimed.outcome !== "claimed") throw new Error("unreachable");

    const completed = await store.complete(input.job_key, claimed.job.claim_version);
    expect(completed.outcome).toBe("succeeded");

    const beforeCleanup = await store.inspect(input.job_key);
    expect(beforeCleanup).toBeDefined();
    expect(beforeCleanup!.status).toBe("succeeded");

    const deleted = await store.cleanupTerminal(0);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const afterCleanup = await store.inspect(input.job_key);
    expect(afterCleanup).toBeUndefined();

    const history = await store.getHistory(input.job_key);
    expect(history.length).toBe(1);
    expect(history[0].outcome).toBe("succeeded");
  });

  it("family override: family-specific window delays cleanup", async () => {
    const baseNow = 1_700_040_000_000;

    const inputA = {
      ...buildOrganizeEnqueueInput({
        settlementId: "ret-fam-a",
        agentId: "agent-fam",
        chunkOrdinal: "001",
        chunkNodeRefs: ["node-a"],
        embeddingModelId: "text-embedding-3-small",
      }),
      now_ms: baseNow,
      next_attempt_at: baseNow,
    };

    const inputB = {
      ...buildSearchRebuildEnqueueInput({
        scope: "world",
        triggerSource: "manual_cli",
        triggerReason: "full_rebuild",
      }),
      now_ms: baseNow,
      next_attempt_at: baseNow,
    };
    const familyKeyB = inputB.job_family_key;

    await store.enqueue(inputA);
    await store.enqueue(inputB);

    const claimedA = await store.claimNext({
      worker_id: "worker-fam-a",
      now_ms: baseNow + 10,
      lease_duration_ms: 60_000,
    });
    expect(claimedA.outcome).toBe("claimed");
    if (claimedA.outcome !== "claimed") throw new Error("unreachable");
    await store.complete(inputA.job_key, claimedA.job.claim_version);

    const claimedB = await store.claimNext({
      worker_id: "worker-fam-b",
      now_ms: baseNow + 20,
      lease_duration_ms: 60_000,
    });
    expect(claimedB.outcome).toBe("claimed");
    if (claimedB.outcome !== "claimed") throw new Error("unreachable");
    await store.complete(inputB.job_key, claimedB.job.claim_version);

    const deleted = await store.cleanupTerminal(0, { [familyKeyB]: 999_999_999 });

    const afterA = await store.inspect(inputA.job_key);
    expect(afterA).toBeUndefined();

    const afterB = await store.inspect(inputB.job_key);
    expect(afterB).toBeDefined();
    expect(afterB!.status).toBe("succeeded");
  });

  it("inspect returns undefined for unknown key", async () => {
    const result = await store.inspect("nonexistent-job-key-xyz");
    expect(result).toBeUndefined();
  });

  it("listExpiredLeases surfaces expired running rows", async () => {
    const baseNow = 1_700_050_000_000;
    const input = {
      ...buildOrganizeEnqueueInput({
        settlementId: "ret-lease-exp",
        agentId: "agent-lease",
        chunkOrdinal: "001",
        chunkNodeRefs: ["node-l"],
        embeddingModelId: "text-embedding-3-small",
      }),
      now_ms: baseNow,
      next_attempt_at: baseNow,
    };

    await store.enqueue(input);

    const claimed = await store.claimNext({
      worker_id: "worker-lease",
      now_ms: baseNow + 10,
      lease_duration_ms: 1_000,
    });
    expect(claimed.outcome).toBe("claimed");

    const futureMs = baseNow + 100_000;
    const expired = await store.listExpiredLeases(futureMs);
    expect(expired.length).toBeGreaterThanOrEqual(1);

    const found = expired.find((r) => r.job_key === input.job_key);
    expect(found).toBeDefined();
    expect(found!.status).toBe("running");
  });
});
