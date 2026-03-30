import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  ensureTestPgAppDb,
  createTestPgAppPool,
  withTestAppSchema,
  teardownAppPool,
} from "../helpers/pg-app-test-utils.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("pg-ops-schema bootstrap", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    sql = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(sql);
  });

  it("creates all 4 tables on first run", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);

      const tables = await pool`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN (
            'sessions', 'interaction_records',
            'recent_cognition_slots', 'pending_settlement_recovery'
          )
        ORDER BY table_name
      `;
      expect(tables.map((r) => r.table_name)).toEqual([
        "interaction_records",
        "pending_settlement_recovery",
        "recent_cognition_slots",
        "sessions",
      ]);
    });
  });

  it("is idempotent — second call succeeds without error", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);
      await bootstrapOpsSchema(pool);
    });
  });

  describe("sessions columns", () => {
    const EXPECTED = [
      "session_id",
      "agent_id",
      "created_at",
      "closed_at",
      "recovery_required",
    ];

    it("has all required columns", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const cols = await pool`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'sessions'
        `;
        const names = cols.map((r) => r.column_name);
        for (const col of EXPECTED) {
          expect(names).toContain(col);
        }
      });
    });
  });

  describe("interaction_records columns", () => {
    const EXPECTED = [
      "id",
      "session_id",
      "record_id",
      "record_index",
      "actor_type",
      "record_type",
      "payload",
      "correlated_turn_id",
      "committed_at",
      "is_processed",
    ];

    it("has all required columns", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const cols = await pool`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'interaction_records'
        `;
        const names = cols.map((r) => r.column_name);
        for (const col of EXPECTED) {
          expect(names).toContain(col);
        }
      });
    });

    it("payload column is JSONB", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const [col] = await pool`
          SELECT data_type FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'interaction_records'
            AND column_name = 'payload'
        `;
        expect(col.data_type).toBe("jsonb");
      });
    });
  });

  describe("recent_cognition_slots columns", () => {
    it("slot_payload column is JSONB", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const [col] = await pool`
          SELECT data_type FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'recent_cognition_slots'
            AND column_name = 'slot_payload'
        `;
        expect(col.data_type).toBe("jsonb");
      });
    });
  });

  describe("pending_settlement_recovery columns", () => {
    const EXPECTED = [
      "id",
      "session_id",
      "agent_id",
      "flush_range_start",
      "flush_range_end",
      "failure_count",
      "backoff_ms",
      "next_attempt_at",
      "last_error",
      "status",
      "created_at",
      "updated_at",
    ];

    it("has all required columns", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const cols = await pool`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'pending_settlement_recovery'
        `;
        const names = cols.map((r) => r.column_name);
        for (const col of EXPECTED) {
          expect(names).toContain(col);
        }
      });
    });

    it("rejects invalid status values", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const now = Date.now();
        try {
          await pool`
            INSERT INTO pending_settlement_recovery (
              session_id, agent_id, flush_range_start, flush_range_end,
              status, created_at, updated_at
            ) VALUES (
              'sess-bad', 'agent-1', 0, 10,
              'INVALID_STATUS', ${now}, ${now}
            )
          `;
          expect(true).toBe(false);
        } catch (err: unknown) {
          expect((err as Error).message).toMatch(/check|constraint|violat/i);
        }
      });
    });

    it("accepts all valid status values", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const now = Date.now();
        const validStatuses = ["pending", "retry_scheduled", "resolved", "hard_failed"];

        for (const status of validStatuses) {
          await pool`
            INSERT INTO pending_settlement_recovery (
              session_id, agent_id, flush_range_start, flush_range_end,
              status, created_at, updated_at
            ) VALUES (
              ${"sess-" + status}, 'agent-1', 0, 10,
              ${status}, ${now}, ${now}
            )
          `;
        }

        const count = await pool`
          SELECT COUNT(*)::int AS cnt FROM pending_settlement_recovery
        `;
        expect(count[0].cnt).toBe(validStatuses.length);
      });
    });

    it("enforces unique active recovery per session", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const now = Date.now();

        await pool`
          INSERT INTO pending_settlement_recovery (
            session_id, agent_id, flush_range_start, flush_range_end,
            status, created_at, updated_at
          ) VALUES (
            'sess-dup', 'agent-1', 0, 10,
            'pending', ${now}, ${now}
          )
        `;

        try {
          await pool`
            INSERT INTO pending_settlement_recovery (
              session_id, agent_id, flush_range_start, flush_range_end,
              status, created_at, updated_at
            ) VALUES (
              'sess-dup', 'agent-2', 11, 20,
              'retry_scheduled', ${now}, ${now}
            )
          `;
          expect(true).toBe(false);
        } catch (err: unknown) {
          expect((err as Error).message).toMatch(/unique|duplicate/i);
        }
      });
    });
  });

  describe("sequences", () => {
    it("interaction_records id auto-increments", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const now = Date.now();

        await pool`
          INSERT INTO sessions (session_id, agent_id, created_at)
          VALUES ('seq-test-sess', 'agent-1', ${now})
        `;

        await pool`
          INSERT INTO interaction_records (
            session_id, record_id, record_index, actor_type, record_type,
            payload, committed_at
          ) VALUES (
            'seq-test-sess', 'rec-1', 0, 'user', 'message',
            '{"text":"hello"}'::jsonb, ${now}
          )
        `;

        await pool`
          INSERT INTO interaction_records (
            session_id, record_id, record_index, actor_type, record_type,
            payload, committed_at
          ) VALUES (
            'seq-test-sess', 'rec-2', 1, 'maiden', 'message',
            '{"text":"hi"}'::jsonb, ${now}
          )
        `;

        const rows = await pool`
          SELECT id FROM interaction_records ORDER BY id
        `;
        expect(rows.length).toBe(2);
        expect(rows[1].id).toBeGreaterThan(rows[0].id);
      });
    });

    it("pending_settlement_recovery id auto-increments", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const now = Date.now();

        await pool`
          INSERT INTO pending_settlement_recovery (
            session_id, agent_id, flush_range_start, flush_range_end,
            status, created_at, updated_at
          ) VALUES
            ('sess-seq-1', 'agent-1', 0, 5, 'resolved', ${now}, ${now}),
            ('sess-seq-2', 'agent-1', 0, 5, 'resolved', ${now}, ${now})
        `;

        const rows = await pool`
          SELECT id FROM pending_settlement_recovery ORDER BY id
        `;
        expect(rows.length).toBe(2);
        expect(rows[1].id).toBeGreaterThan(rows[0].id);
      });
    });
  });

  describe("indexes", () => {
    it("has session indexes", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const schema = await pool`SELECT current_schema() AS s`;
        const schemaName = schema[0].s;

        const indexes = await pool`
          SELECT indexname FROM pg_indexes
          WHERE schemaname = ${schemaName} AND tablename = 'sessions'
        `;
        const names = indexes.map((r) => r.indexname);
        expect(names).toContain("idx_sessions_agent_id");
        expect(names).toContain("idx_sessions_closed_at");
        expect(names).toContain("idx_sessions_recovery_required");
      });
    });

    it("has interaction_records indexes", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const schema = await pool`SELECT current_schema() AS s`;
        const schemaName = schema[0].s;

        const indexes = await pool`
          SELECT indexname FROM pg_indexes
          WHERE schemaname = ${schemaName} AND tablename = 'interaction_records'
        `;
        const names = indexes.map((r) => r.indexname);
        expect(names).toContain("idx_interaction_session_index");
        expect(names).toContain("idx_interaction_session_processed");
      });
    });

    it("has pending_settlement_recovery partial unique index", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const schema = await pool`SELECT current_schema() AS s`;
        const schemaName = schema[0].s;

        const idx = await pool`
          SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = ${schemaName}
            AND tablename = 'pending_settlement_recovery'
            AND indexname = 'ux_pending_recovery_session_active'
        `;
        expect(idx.length).toBe(1);
        expect(idx[0].indexdef).toContain("UNIQUE");
        expect(idx[0].indexdef).toContain("session_id");
        expect(idx[0].indexdef).toContain("pending");
        expect(idx[0].indexdef).toContain("retry_scheduled");
      });
    });

    it("has pending_settlement_recovery next_attempt_at index", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const schema = await pool`SELECT current_schema() AS s`;
        const schemaName = schema[0].s;

        const idx = await pool`
          SELECT indexname FROM pg_indexes
          WHERE schemaname = ${schemaName}
            AND tablename = 'pending_settlement_recovery'
            AND indexname = 'idx_pending_recovery_next_attempt'
        `;
        expect(idx.length).toBe(1);
      });
    });
  });
});
