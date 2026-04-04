import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  ensureTestPgAppDb,
  createTestPgAppPool,
  withTestAppSchema,
  teardownAppPool,
} from "../helpers/pg-app-test-utils.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import { PgSettlementLedgerRepo } from "../../src/storage/domain-repos/pg/settlement-ledger-repo.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("PgSettlementLedgerRepo", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("full lifecycle: pending → claimed → applying → applied", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      const sid = "stl-lifecycle-1";

      await repo.markPending(sid, "agent-1");
      expect(await repo.rawStatus(sid)).toBe("pending");
      expect(await repo.check(sid)).toBe("pending");

      await repo.markClaimed(sid, "worker-1");
      expect(await repo.rawStatus(sid)).toBe("claimed");

      await repo.markApplying(sid, "agent-1", "hash-abc");
      expect(await repo.rawStatus(sid)).toBe("applying");

      await repo.markApplied(sid);
      expect(await repo.rawStatus(sid)).toBe("applied");
      expect(await repo.check(sid)).toBe("applied");
    });
  });

  it("markApplying upserts when no prior row exists", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      const sid = "stl-upsert-1";

      await repo.markApplying(sid, "agent-2", "hash-xyz");
      const record = await repo.getBySettlementId(sid);

      expect(record).not.toBeNull();
      expect(record!.status).toBe("applying");
      expect(record!.attemptCount).toBe(1);
      expect(record!.payloadHash).toBe("hash-xyz");
      expect(record!.claimedBy).toBe("agent-2");
    });
  });

  it("markConflict sets status and error message", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      const sid = "stl-conflict-1";

      await repo.markPending(sid, "agent-1");
      await repo.markConflict(sid, "hash mismatch");

      expect(await repo.rawStatus(sid)).toBe("conflict");
      expect(await repo.check(sid)).toBe("failed");

      const record = await repo.getBySettlementId(sid);
      expect(record!.errorMessage).toBe("hash mismatch");
    });
  });

  it("markFailedRetryScheduled sets failed_retryable status", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      const sid = "stl-retry-1";

      await repo.markPending(sid, "agent-1");
      await repo.markApplying(sid, "agent-1", "hash-retry");
      await repo.markFailedRetryScheduled(sid, "timeout");

      expect(await repo.rawStatus(sid)).toBe("failed_retryable");
      expect(await repo.check(sid)).toBe("pending");

      const record = await repo.getBySettlementId(sid);
      expect(record!.errorMessage).toBe("timeout");
    });
  });

  it("markFailedTerminal sets failed_terminal status", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      const sid = "stl-terminal-1";

      await repo.markPending(sid, "agent-1");
      await repo.markApplying(sid, "agent-1", "hash-terminal");
      await repo.markFailedTerminal(sid, "unrecoverable");

      expect(await repo.rawStatus(sid)).toBe("failed_terminal");
      expect(await repo.check(sid)).toBe("failed");

      const record = await repo.getBySettlementId(sid);
      expect(record!.errorMessage).toBe("unrecoverable");
    });
  });

  it("getBySettlementId returns full record with correct fields", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      const sid = "stl-get-1";

      await repo.markPending(sid, "agent-get");
      const record = await repo.getBySettlementId(sid);

      expect(record).not.toBeNull();
      expect(record!.settlementId).toBe(sid);
      expect(record!.agentId).toBe("agent-get");
      expect(record!.status).toBe("pending");
      expect(record!.attemptCount).toBe(0);
      expect(record!.maxAttempts).toBe(4);
      expect(record!.payloadHash).toBeNull();
      expect(record!.claimedBy).toBeNull();
      expect(record!.claimedAt).toBeNull();
      expect(record!.appliedAt).toBeNull();
      expect(record!.errorMessage).toBeNull();
      expect(record!.createdAt).toBeGreaterThan(0);
      expect(record!.updatedAt).toBeGreaterThan(0);
    });
  });

  it("getBySettlementId returns null for non-existent id", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      expect(await repo.getBySettlementId("no-such-id")).toBeNull();
    });
  });

  it("getByHash returns record matching payload hash", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);

      await repo.markApplying("stl-hash-1", "agent-h", "unique-hash-123");
      const record = await repo.getByHash("unique-hash-123");

      expect(record).not.toBeNull();
      expect(record!.settlementId).toBe("stl-hash-1");
      expect(record!.payloadHash).toBe("unique-hash-123");
    });
  });

  it("getByHash returns null when no match", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      expect(await repo.getByHash("nonexistent-hash")).toBeNull();
    });
  });

  it("check returns not_found for unknown settlement", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      expect(await repo.check("unknown-stl")).toBe("not_found");
    });
  });

  it("check returns applied for replayed_noop status", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      const sid = "stl-noop-1";

      await repo.markPending(sid, "agent-1");
      await repo.markReplayedNoop(sid);

      expect(await repo.rawStatus(sid)).toBe("replayed_noop");
      expect(await repo.check(sid)).toBe("applied");
    });
  });

  it("markPending is idempotent — second call is ignored", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      const sid = "stl-idempotent-1";

      await repo.markPending(sid, "agent-1");
      await repo.markPending(sid, "agent-2");

      const record = await repo.getBySettlementId(sid);
      expect(record!.agentId).toBe("agent-1");
    });
  });

  it("markApplying from failed_retryable increments attempt_count", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      const sid = "stl-retry-apply-1";

      await repo.markPending(sid, "agent-1");
      await repo.markFailedRetryScheduled(sid, "first failure");

      await repo.markApplying(sid, "agent-1", "hash-r1");
      const record = await repo.getBySettlementId(sid);

      expect(record!.status).toBe("applying");
      expect(record!.attemptCount).toBe(1);
    });
  });

  it("split-mode lifecycle: talker_committed → thinker_projecting → applied", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      const sid = "stl-split-lifecycle-1";

      await repo.markTalkerCommitted(sid, "agent-talker");
      expect(await repo.rawStatus(sid)).toBe("talker_committed");
      expect(await repo.check(sid)).toBe("pending");

      await repo.markThinkerProjecting(sid, "agent-thinker");
      expect(await repo.rawStatus(sid)).toBe("thinker_projecting");
      expect(await repo.check(sid)).toBe("pending");

      const record = await repo.getBySettlementId(sid);
      expect(record!.attemptCount).toBe(1);
      expect(record!.claimedBy).toBe("agent-thinker");

      await repo.markApplied(sid);
      expect(await repo.rawStatus(sid)).toBe("applied");
      expect(await repo.check(sid)).toBe("applied");
    });
  });

  it("split-mode retry: thinker_projecting → failed_retryable → thinker_projecting", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      const sid = "stl-split-retry-1";

      await repo.markTalkerCommitted(sid, "agent-talker");
      await repo.markThinkerProjecting(sid, "agent-thinker");
      await repo.markFailedRetryScheduled(sid, "transient error");

      expect(await repo.rawStatus(sid)).toBe("failed_retryable");
      expect(await repo.check(sid)).toBe("pending");

      await repo.markThinkerProjecting(sid, "agent-thinker-2");
      expect(await repo.rawStatus(sid)).toBe("thinker_projecting");

      const record = await repo.getBySettlementId(sid);
      expect(record!.attemptCount).toBe(2);
      expect(record!.claimedBy).toBe("agent-thinker-2");
      expect(record!.errorMessage).toBeNull();
    });
  });

  it("split-mode terminal failure: thinker_projecting → failed_terminal", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      const sid = "stl-split-terminal-1";

      await repo.markTalkerCommitted(sid, "agent-talker");
      await repo.markThinkerProjecting(sid, "agent-thinker");
      await repo.markFailedTerminal(sid, "unrecoverable split error");

      expect(await repo.rawStatus(sid)).toBe("failed_terminal");
      expect(await repo.check(sid)).toBe("failed");

      const record = await repo.getBySettlementId(sid);
      expect(record!.errorMessage).toBe("unrecoverable split error");
    });
  });

  it("markThinkerProjecting rejects invalid transition from pending", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      const sid = "stl-split-invalid-1";

      await repo.markPending(sid, "agent-1");

      let caught: Error | null = null;
      try {
        await repo.markThinkerProjecting(sid, "agent-thinker");
      } catch (e: any) {
        caught = e;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).toMatch(/no row with status talker_committed or failed_retryable/);

      expect(await repo.rawStatus(sid)).toBe("pending");
    });
  });

  it("markTalkerCommitted is idempotent — second call is ignored", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);
      const sid = "stl-split-idempotent-1";

      await repo.markTalkerCommitted(sid, "agent-1");
      await repo.markTalkerCommitted(sid, "agent-2");

      const record = await repo.getBySettlementId(sid);
      expect(record!.agentId).toBe("agent-1");
      expect(record!.status).toBe("talker_committed");
    });
  });
});
