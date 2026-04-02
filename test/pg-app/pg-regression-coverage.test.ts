import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  ensureTestPgAppDb,
  createTestPgAppPool,
  withTestAppSchema,
  teardownAppPool,
} from "../helpers/pg-app-test-utils.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { PgCoreMemoryBlockRepo } from "../../src/storage/domain-repos/pg/core-memory-block-repo.js";
import { PgSettlementLedgerRepo } from "../../src/storage/domain-repos/pg/settlement-ledger-repo.js";
import { PgPendingFlushRecoveryRepo } from "../../src/storage/domain-repos/pg/pending-flush-recovery-repo.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("combined schema bootstrap idempotency", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("truth + ops + derived bootstrapped together is idempotent", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapOpsSchema(sql);
      await bootstrapDerivedSchema(sql);

      await bootstrapTruthSchema(sql);
      await bootstrapOpsSchema(sql);
      await bootstrapDerivedSchema(sql);

      const tables = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN (
            'settlement_processing_ledger',
            'sessions',
            'search_docs_private'
          )
        ORDER BY table_name
      `;
      expect(tables.map((r) => r.table_name)).toEqual([
        "search_docs_private",
        "sessions",
        "settlement_processing_ledger",
      ]);
    });
  });

  it("bootstrap order truth→ops→derived is stable after double run", async () => {
    await withTestAppSchema(pool, async (sql) => {
      for (let i = 0; i < 2; i++) {
        await bootstrapTruthSchema(sql);
        await bootstrapOpsSchema(sql);
        await bootstrapDerivedSchema(sql);
      }

      const truthCount = await sql`
        SELECT COUNT(*)::int AS cnt FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'entity_nodes'
      `;
      expect(truthCount[0].cnt).toBe(1);

      const opsCount = await sql`
        SELECT COUNT(*)::int AS cnt FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'interaction_records'
      `;
      expect(opsCount[0].cnt).toBe(1);

      const derivedCount = await sql`
        SELECT COUNT(*)::int AS cnt FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'graph_nodes'
      `;
      expect(derivedCount[0].cnt).toBe(1);
    });
  });
});

describe.skipIf(skipPgTests)("core memory block multi-agent isolation", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("agent A blocks are isolated from agent B blocks", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCoreMemoryBlockRepo(sql);

      await repo.initializeBlocks("agent-a");
      await repo.initializeBlocks("agent-b");

      await repo.appendBlock("agent-a", "persona", "Alice is diligent");

      const blockB = await repo.getBlock("agent-b", "persona");
      expect(blockB.value).toBe("");

      const blockA = await repo.getBlock("agent-a", "persona");
      expect(blockA.value).toBe("Alice is diligent");
    });
  });

  it("getAllBlocks returns only the requested agent's blocks", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCoreMemoryBlockRepo(sql);

      await repo.initializeBlocks("agent-x");
      await repo.initializeBlocks("agent-y");

      await repo.appendBlock("agent-x", "pinned_summary", "X summary");
      await repo.appendBlock("agent-y", "pinned_summary", "Y summary");

      const blocksX = await repo.getAllBlocks("agent-x");
      const blocksY = await repo.getAllBlocks("agent-y");

      expect(blocksX.length).toBe(5);
      expect(blocksY.length).toBe(5);

      const summaryX = blocksX.find((b) => b.label === "pinned_summary");
      const summaryY = blocksY.find((b) => b.label === "pinned_summary");

      expect(summaryX!.value).toBe("X summary");
      expect(summaryY!.value).toBe("Y summary");
    });
  });

  it("replaceBlock on agent A does not affect agent B", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCoreMemoryBlockRepo(sql);

      await repo.initializeBlocks("agent-1");
      await repo.initializeBlocks("agent-2");

      await repo.appendBlock("agent-1", "pinned_summary", "shared text");
      await repo.appendBlock("agent-2", "pinned_summary", "shared text");

      await repo.replaceBlock("agent-1", "pinned_summary", "shared", "modified");

      const block1 = await repo.getBlock("agent-1", "pinned_summary");
      const block2 = await repo.getBlock("agent-2", "pinned_summary");

      expect(block1.value).toBe("modified text");
      expect(block2.value).toBe("shared text");
    });
  });
});

describe.skipIf(skipPgTests)("settlement ledger concurrent agents", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("different agents can have independent settlement entries", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);

      await repo.markPending("stl-agent-a", "agent-a");
      await repo.markPending("stl-agent-b", "agent-b");

      const recA = await repo.getBySettlementId("stl-agent-a");
      const recB = await repo.getBySettlementId("stl-agent-b");

      expect(recA!.agentId).toBe("agent-a");
      expect(recB!.agentId).toBe("agent-b");
      expect(recA!.status).toBe("pending");
      expect(recB!.status).toBe("pending");
    });
  });

  it("markApplied on one settlement does not affect another", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSettlementLedgerRepo(sql);

      await repo.markPending("stl-iso-1", "agent-a");
      await repo.markPending("stl-iso-2", "agent-a");

      await repo.markApplying("stl-iso-1", "agent-a", "hash-1");
      await repo.markApplied("stl-iso-1");

      expect(await repo.check("stl-iso-1")).toBe("applied");
      expect(await repo.check("stl-iso-2")).toBe("pending");
    });
  });
});

describe.skipIf(skipPgTests)("pending flush recovery full retry cycle", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("pending → attempt (retry_scheduled) → resolve completes cleanly", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapOpsSchema(sql);
      const repo = new PgPendingFlushRecoveryRepo(sql);

      await repo.recordPending({
        sessionId: "sess-cycle",
        agentId: "agent-cycle",
        flushRangeStart: 0,
        flushRangeEnd: 10,
        nextAttemptAt: null,
      });

      await repo.markAttempted({
        sessionId: "sess-cycle",
        failureCount: 1,
        backoffMs: 1000,
        nextAttemptAt: 5000,
        lastError: "first failure",
      });

      const rows1 = await sql`
        SELECT status, failure_count FROM pending_settlement_recovery
        WHERE session_id = 'sess-cycle'
      `;
      expect(rows1[0].status).toBe("retry_scheduled");
      expect(Number(rows1[0].failure_count)).toBe(1);

      await repo.markAttempted({
        sessionId: "sess-cycle",
        failureCount: 2,
        backoffMs: 2000,
        nextAttemptAt: 10000,
        lastError: "second failure",
      });

      await repo.markResolved("sess-cycle");

      const rows2 = await sql`
        SELECT status FROM pending_settlement_recovery WHERE session_id = 'sess-cycle'
      `;
      expect(rows2[0].status).toBe("resolved");

      const active = await repo.queryActive(Date.now());
      expect(active.map((r) => r.session_id)).not.toContain("sess-cycle");
    });
  });

  it("queryActive respects backoff — future next_attempt_at excluded", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapOpsSchema(sql);
      const repo = new PgPendingFlushRecoveryRepo(sql);
      const now = Date.now();

      await repo.recordPending({
        sessionId: "sess-future",
        agentId: "agent-f",
        flushRangeStart: 0,
        flushRangeEnd: 5,
        nextAttemptAt: now + 999999,
      });

      await repo.recordPending({
        sessionId: "sess-past",
        agentId: "agent-p",
        flushRangeStart: 0,
        flushRangeEnd: 5,
        nextAttemptAt: now - 1000,
      });

      const active = await repo.queryActive(now);
      const ids = active.map((r) => r.session_id);

      expect(ids).toContain("sess-past");
      expect(ids).not.toContain("sess-future");
    });
  });
});
