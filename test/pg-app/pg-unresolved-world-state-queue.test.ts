import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  ensureTestPgAppDb,
  createTestPgAppPool,
  withTestAppSchema,
  teardownAppPool,
} from "../helpers/pg-app-test-utils.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import { PgUnresolvedWorldStateOpsRepo } from "../../src/storage/domain-repos/pg/unresolved-world-state-ops-repo.js";
import { DEAD_LETTER_THRESHOLD } from "../../src/storage/domain-repos/contracts/unresolved-world-state-ops-repo.js";
import type { WorldStateOp } from "../../src/runtime/rp-turn-contract.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

function makeOp(overrides: Partial<WorldStateOp> = {}): WorldStateOp {
  return {
    subject: { kind: "pointer_key", value: "p:alice" },
    predicate: "knows",
    object: { kind: "pointer_key", value: "p:bob" },
    factText: "Alice knows Bob",
    visibility: "private_overlay",
    ...overrides,
  };
}

describe.skipIf(skipPgTests)("PgUnresolvedWorldStateOpsRepo", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("enqueueOp is idempotent on (settlementId, opIndex)", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgUnresolvedWorldStateOpsRepo(sql);

      const first = await repo.enqueueOp({
        sessionId: "sess-1",
        settlementId: "stl-1",
        opIndex: 0,
        agentId: "agent-a",
        op: makeOp(),
        subjectPointerKey: "p:alice",
        objectPointerKey: "p:bob",
        turnTimestamp: 1000,
      });
      expect(first.created).toBe(true);
      expect(first.id).toBeGreaterThan(0);

      const second = await repo.enqueueOp({
        sessionId: "sess-1",
        settlementId: "stl-1",
        opIndex: 0,
        agentId: "agent-a",
        op: makeOp(),
      });
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);

      const all = await sql`SELECT COUNT(*)::int AS c FROM unresolved_world_state_ops`;
      expect(Number(all[0].c)).toBe(1);
    });
  });

  it("listPending returns only pending rows below dead-letter threshold", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgUnresolvedWorldStateOpsRepo(sql);

      const a = await repo.enqueueOp({
        sessionId: "sess-1", settlementId: "stl-A", opIndex: 0,
        agentId: "agent-a", op: makeOp(),
      });
      const b = await repo.enqueueOp({
        sessionId: "sess-1", settlementId: "stl-B", opIndex: 0,
        agentId: "agent-b", op: makeOp(),
      });
      const c = await repo.enqueueOp({
        sessionId: "sess-1", settlementId: "stl-C", opIndex: 0,
        agentId: "agent-a", op: makeOp(),
      });

      await repo.markResolved(b.id);

      const pending = await repo.listPending();
      const ids = pending.map((p) => p.id).sort((x, y) => x - y);
      expect(ids).toEqual([a.id, c.id].sort((x, y) => x - y));

      const filtered = await repo.listPending({ agentId: "agent-a" });
      expect(filtered.map((p) => p.id).sort((x, y) => x - y)).toEqual(
        [a.id, c.id].sort((x, y) => x - y),
      );

      const otherAgent = await repo.listPending({ agentId: "agent-b" });
      expect(otherAgent.length).toBe(0);
    });
  });

  it("incrementRetry advances retryCount and dead-letters at threshold", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgUnresolvedWorldStateOpsRepo(sql);

      const enq = await repo.enqueueOp({
        sessionId: "sess-1", settlementId: "stl-retry", opIndex: 0,
        agentId: "agent-r", op: makeOp(),
      });

      for (let i = 0; i < DEAD_LETTER_THRESHOLD - 1; i++) {
        await repo.incrementRetry(enq.id, `attempt-${i}`);
      }

      let row = await repo.getById(enq.id);
      expect(row).not.toBeNull();
      expect(row!.payload.retryCount).toBe(DEAD_LETTER_THRESHOLD - 1);
      expect(row!.status).toBe("pending");

      const pendingBefore = await repo.listPending();
      expect(pendingBefore.find((p) => p.id === enq.id)).toBeDefined();

      await repo.incrementRetry(enq.id, "final");
      row = await repo.getById(enq.id);
      expect(row!.status).toBe("dead_letter");
      expect(row!.payload.retryCount).toBe(DEAD_LETTER_THRESHOLD);
      expect(row!.lastError).toBe("final");

      const pendingAfter = await repo.listPending();
      expect(pendingAfter.find((p) => p.id === enq.id)).toBeUndefined();
    });
  });

  it("markResolved removes op from pending listing", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgUnresolvedWorldStateOpsRepo(sql);

      const enq = await repo.enqueueOp({
        sessionId: "sess-1", settlementId: "stl-resolve", opIndex: 0,
        agentId: "agent-r", op: makeOp(),
      });

      expect((await repo.listPending()).map((p) => p.id)).toContain(enq.id);

      await repo.markResolved(enq.id);

      const row = await repo.getById(enq.id);
      expect(row!.status).toBe("resolved");
      expect((await repo.listPending()).map((p) => p.id)).not.toContain(enq.id);
    });
  });

  it("markDeadLetter forces dead_letter status with reason", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgUnresolvedWorldStateOpsRepo(sql);

      const enq = await repo.enqueueOp({
        sessionId: "sess-1", settlementId: "stl-dead", opIndex: 0,
        agentId: "agent-r", op: makeOp(),
      });

      await repo.markDeadLetter(enq.id, "manual abort");
      const row = await repo.getById(enq.id);
      expect(row!.status).toBe("dead_letter");
      expect(row!.lastError).toBe("manual abort");
    });
  });

  it("payload round-trips full op + resolution metadata", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgUnresolvedWorldStateOpsRepo(sql);

      const op = makeOp({
        contradictedFactEdgeIds: [10, 20],
        validTime: 12345,
      });

      const enq = await repo.enqueueOp({
        sessionId: "sess-x", settlementId: "stl-payload", opIndex: 7,
        agentId: "agent-payload",
        op,
        subjectPointerKey: "p:s",
        objectPointerKey: "p:o",
        turnTimestamp: 999,
      });

      const row = await repo.getById(enq.id);
      expect(row).not.toBeNull();
      expect(row!.opIndex).toBe(7);
      expect(row!.sessionId).toBe("sess-x");
      expect(row!.payload.agentId).toBe("agent-payload");
      expect(row!.payload.subjectPointerKey).toBe("p:s");
      expect(row!.payload.objectPointerKey).toBe("p:o");
      expect(row!.payload.turnTimestamp).toBe(999);
      expect(row!.payload.op.factText).toBe(op.factText);
      expect(row!.payload.op.contradictedFactEdgeIds).toEqual([10, 20]);
      expect(row!.payload.op.validTime).toBe(12345);
      expect(row!.payload.retryCount).toBe(0);
    });
  });
});
