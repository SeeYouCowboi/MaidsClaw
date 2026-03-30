import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  ensureTestPgAppDb,
  createTestPgAppPool,
  withTestAppSchema,
  teardownAppPool,
} from "../helpers/pg-app-test-utils.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { PgPendingFlushRecoveryRepo } from "../../src/storage/domain-repos/pg/pending-flush-recovery-repo.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("PgPendingFlushRecoveryRepo", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    sql = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(sql);
  });

  it("recordPending creates a record, second call is idempotent", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);
      const repo = new PgPendingFlushRecoveryRepo(pool);

      await repo.recordPending({
        sessionId: "sess-1",
        agentId: "agent-1",
        flushRangeStart: 0,
        flushRangeEnd: 10,
        nextAttemptAt: 1000,
      });

      const rows = await pool`
        SELECT session_id, agent_id, flush_range_start, flush_range_end,
               failure_count, backoff_ms, next_attempt_at, status
        FROM pending_settlement_recovery
        WHERE session_id = 'sess-1'
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].session_id).toBe("sess-1");
      expect(rows[0].agent_id).toBe("agent-1");
      expect(Number(rows[0].flush_range_start)).toBe(0);
      expect(Number(rows[0].flush_range_end)).toBe(10);
      expect(Number(rows[0].failure_count)).toBe(0);
      expect(Number(rows[0].backoff_ms)).toBe(0);
      expect(Number(rows[0].next_attempt_at)).toBe(1000);
      expect(rows[0].status).toBe("pending");

      await repo.recordPending({
        sessionId: "sess-1",
        agentId: "agent-1",
        flushRangeStart: 0,
        flushRangeEnd: 20,
        nextAttemptAt: 2000,
      });

      const rowsAfter = await pool`
        SELECT * FROM pending_settlement_recovery WHERE session_id = 'sess-1'
          AND status IN ('pending', 'retry_scheduled')
      `;
      expect(rowsAfter.length).toBe(1);
      expect(Number(rowsAfter[0].flush_range_end)).toBe(10);
    });
  });

  it("markAttempted updates to retry_scheduled with backoff", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);
      const repo = new PgPendingFlushRecoveryRepo(pool);

      await repo.recordPending({
        sessionId: "sess-2",
        agentId: "agent-2",
        flushRangeStart: 5,
        flushRangeEnd: 15,
      });

      await repo.markAttempted({
        sessionId: "sess-2",
        failureCount: 1,
        backoffMs: 5000,
        nextAttemptAt: 99999,
        lastError: "timeout",
      });

      const rows = await pool`
        SELECT status, failure_count, backoff_ms, next_attempt_at, last_error
        FROM pending_settlement_recovery
        WHERE session_id = 'sess-2'
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe("retry_scheduled");
      expect(Number(rows[0].failure_count)).toBe(1);
      expect(Number(rows[0].backoff_ms)).toBe(5000);
      expect(Number(rows[0].next_attempt_at)).toBe(99999);
      expect(rows[0].last_error).toBe("timeout");
    });
  });

  it("queryActive returns only pending/retry_scheduled that are due", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);
      const repo = new PgPendingFlushRecoveryRepo(pool);

      const now = 10000;

      await repo.recordPending({
        sessionId: "sess-a",
        agentId: "agent-a",
        flushRangeStart: 0,
        flushRangeEnd: 5,
        nextAttemptAt: null,
      });

      await repo.recordPending({
        sessionId: "sess-b",
        agentId: "agent-b",
        flushRangeStart: 0,
        flushRangeEnd: 10,
        nextAttemptAt: 5000,
      });

      await repo.recordPending({
        sessionId: "sess-c",
        agentId: "agent-c",
        flushRangeStart: 0,
        flushRangeEnd: 15,
        nextAttemptAt: 20000,
      });

      const active = await repo.queryActive(now);
      const ids = active.map((r) => r.session_id);

      expect(ids).toContain("sess-a");
      expect(ids).toContain("sess-b");
      expect(ids).not.toContain("sess-c");
      expect(active[0].session_id).toBe("sess-a");
    });
  });

  it("markResolved moves to resolved, not returned by queryActive", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);
      const repo = new PgPendingFlushRecoveryRepo(pool);

      await repo.recordPending({
        sessionId: "sess-resolve",
        agentId: "agent-r",
        flushRangeStart: 0,
        flushRangeEnd: 5,
        nextAttemptAt: null,
      });

      let active = await repo.queryActive(Date.now());
      expect(active.map((r) => r.session_id)).toContain("sess-resolve");

      await repo.markResolved("sess-resolve");

      active = await repo.queryActive(Date.now());
      expect(active.map((r) => r.session_id)).not.toContain("sess-resolve");

      const rows = await pool`
        SELECT status FROM pending_settlement_recovery WHERE session_id = 'sess-resolve'
      `;
      expect(rows[0].status).toBe("resolved");
    });
  });

  it("markHardFail sets hard_failed status", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);
      const repo = new PgPendingFlushRecoveryRepo(pool);

      await repo.recordPending({
        sessionId: "sess-fail",
        agentId: "agent-f",
        flushRangeStart: 0,
        flushRangeEnd: 5,
        nextAttemptAt: null,
      });

      await repo.markHardFail("sess-fail", "unrecoverable error");

      const active = await repo.queryActive(Date.now());
      expect(active.map((r) => r.session_id)).not.toContain("sess-fail");

      const rows = await pool`
        SELECT status, last_error FROM pending_settlement_recovery WHERE session_id = 'sess-fail'
      `;
      expect(rows[0].status).toBe("hard_failed");
      expect(rows[0].last_error).toBe("unrecoverable error");
    });
  });

  it("recordPending allows new record after previous is resolved", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);
      const repo = new PgPendingFlushRecoveryRepo(pool);

      await repo.recordPending({
        sessionId: "sess-reuse",
        agentId: "agent-x",
        flushRangeStart: 0,
        flushRangeEnd: 5,
      });
      await repo.markResolved("sess-reuse");

      await repo.recordPending({
        sessionId: "sess-reuse",
        agentId: "agent-x",
        flushRangeStart: 10,
        flushRangeEnd: 20,
      });

      const active = await repo.queryActive(Date.now());
      const match = active.find((r) => r.session_id === "sess-reuse");
      expect(match).toBeDefined();
      expect(match!.flush_range_start).toBe(10);
      expect(match!.flush_range_end).toBe(20);
    });
  });
});
