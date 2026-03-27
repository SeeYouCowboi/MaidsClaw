import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  CANONICAL_LEDGER_TABLES,
  REPORT_TABLES,
  getTableRowCount,
  runRetention,
  runIntegrityCheck,
  gatherReportRows,
} from "../../scripts/memory-maintenance.js";
import { createTempDb, cleanupDb, type Db } from "../helpers/memory-test-utils.js";

describe("memory-maintenance", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    const tmp = createTempDb();
    db = tmp.db;
    dbPath = tmp.dbPath;
  });

  afterEach(() => {
    cleanupDb(db, dbPath);
  });

  describe("retention safety", () => {
    it("deletes expired exhausted/reconciled jobs without touching canonical ledgers", () => {
      // given: record baseline private_cognition_events count
      const beforeCognition = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM private_cognition_events",
      );
      const beforeEpisode = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM private_episode_events",
      );

      // given: insert 10 expired maintenance jobs
      const veryOldTs = Date.now() - 365 * 24 * 60 * 60 * 1000;
      for (let i = 0; i < 5; i++) {
        db.run(
          `INSERT INTO _memory_maintenance_jobs
           (job_type, status, idempotency_key, payload, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [`test.job`, "exhausted", `expired-exhausted-${i}`, null, veryOldTs, veryOldTs],
        );
      }
      for (let i = 0; i < 5; i++) {
        db.run(
          `INSERT INTO _memory_maintenance_jobs
           (job_type, status, idempotency_key, payload, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [`test.job`, "reconciled", `expired-reconciled-${i}`, null, veryOldTs, veryOldTs],
        );
      }

      // given: insert 2 recent jobs that should NOT be deleted
      const recentTs = Date.now() + 60_000;
      db.run(
        `INSERT INTO _memory_maintenance_jobs
         (job_type, status, idempotency_key, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [`test.job`, "reconciled", `recent-1`, null, recentTs, recentTs],
      );
      db.run(
        `INSERT INTO _memory_maintenance_jobs
         (job_type, status, idempotency_key, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [`test.job`, "pending", `pending-1`, null, veryOldTs, veryOldTs],
      );

      const beforeJobs = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM _memory_maintenance_jobs",
      );
      expect(beforeJobs?.count).toBe(12);

      // when: run retention with --days 0 (cleans everything older than now)
      const deleted = runRetention(db, 0);

      // then: 10 expired jobs deleted (5 exhausted + 5 reconciled), recent + pending kept
      expect(deleted).toBe(10);

      const afterJobs = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM _memory_maintenance_jobs",
      );
      expect(afterJobs?.count).toBe(2);

      // then: canonical ledger tables unchanged
      const afterCognition = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM private_cognition_events",
      );
      const afterEpisode = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM private_episode_events",
      );
      expect(afterCognition?.count).toBe(beforeCognition?.count ?? 0);
      expect(afterEpisode?.count).toBe(beforeEpisode?.count ?? 0);
    });

    it("does not delete pending or processing jobs regardless of age", () => {
      const veryOldTs = Date.now() - 365 * 24 * 60 * 60 * 1000;
      const statuses = ["pending", "processing", "retryable"] as const;
      for (const status of statuses) {
        db.run(
          `INSERT INTO _memory_maintenance_jobs
           (job_type, status, idempotency_key, payload, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [`test.job`, status, `keep-${status}`, null, veryOldTs, veryOldTs],
        );
      }

      const deleted = runRetention(db, 0);

      expect(deleted).toBe(0);
      const remaining = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM _memory_maintenance_jobs",
      );
      expect(remaining?.count).toBe(3);
    });
  });

  describe("canonical protection", () => {
    it("CANONICAL_LEDGER_TABLES includes area_state_events and world_state_events", () => {
      expect(CANONICAL_LEDGER_TABLES).toContain("area_state_events");
      expect(CANONICAL_LEDGER_TABLES).toContain("world_state_events");
    });

    it("CANONICAL_LEDGER_TABLES includes settlement_processing_ledger", () => {
      expect(CANONICAL_LEDGER_TABLES).toContain("settlement_processing_ledger");
    });

    it("CANONICAL_LEDGER_TABLES includes original private ledgers", () => {
      expect(CANONICAL_LEDGER_TABLES).toContain("private_cognition_events");
      expect(CANONICAL_LEDGER_TABLES).toContain("private_episode_events");
    });

    it("all canonical tables are in REPORT_TABLES", () => {
      for (const table of CANONICAL_LEDGER_TABLES) {
        expect((REPORT_TABLES as readonly string[]).includes(table)).toBe(true);
      }
    });
  });

  describe("report", () => {
    it("returns row counts for known tables", () => {
      const count = getTableRowCount(db, "_memory_maintenance_jobs");
      expect(count).toBe(0);
    });

    it("returns null for unknown tables", () => {
      const count = getTableRowCount(db, "nonexistent_table");
      expect(count).toBeNull();
    });

    it("REPORT_TABLES includes area_state_events and world_state_events", () => {
      expect((REPORT_TABLES as readonly string[]).includes("area_state_events")).toBe(true);
      expect((REPORT_TABLES as readonly string[]).includes("world_state_events")).toBe(true);
    });

    it("gatherReportRows returns structured data for all tables", () => {
      const rows = gatherReportRows(db);
      expect(rows.length).toBe(REPORT_TABLES.length);

      for (const row of rows) {
        expect(typeof row.table).toBe("string");
        expect(typeof row.isProtected).toBe("boolean");
      }

      // then: canonical tables are marked protected
      const protectedRows = rows.filter((r) => r.isProtected);
      expect(protectedRows.length).toBe(CANONICAL_LEDGER_TABLES.length);
    });

    it("gatherReportRows shows oldest record when created_at exists", () => {
      const ts = Date.now() - 86_400_000;
      db.run(
        `INSERT INTO _memory_maintenance_jobs
         (job_type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        ["test.job", "pending", ts, ts],
      );

      const rows = gatherReportRows(db);
      const jobsRow = rows.find((r) => r.table === "_memory_maintenance_jobs");
      expect(jobsRow).toBeDefined();
      expect(jobsRow!.rows).toBe(1);
      expect(jobsRow!.oldestRecord).toBeTruthy();
    });
  });

  describe("integrity check", () => {
    it("returns true for a healthy database", () => {
      const result = runIntegrityCheck(db);
      expect(result).toBe(true);
    });
  });
});
