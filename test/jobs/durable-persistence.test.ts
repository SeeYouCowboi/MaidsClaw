import { describe, expect, it } from "bun:test";
import { JobDedupEngine } from "../../src/jobs/dedup.js";
import { JobDispatcher } from "../../src/jobs/dispatcher.js";
import { MEMORY_MIGRATIONS, runMemoryMigrations } from "../../src/memory/schema.js";
import { SqliteJobPersistence } from "../../src/jobs/persistence.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { openDatabase } from "../../src/storage/database.js";
import { cleanupDb, createTempDb } from "../helpers/memory-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("SqliteJobPersistence", () => {
  it("recovers pending jobs after restart and allows claim + complete", async () => {
    const { db, dbPath } = createTempDb();

    try {
      const firstBoot = new SqliteJobPersistence(db);
      firstBoot.enqueue({
        id: "durable-crash-job",
        jobType: "memory.organize",
        payload: { batchId: "b-1" },
        status: "pending",
        maxAttempts: 4,
        nextAttemptAt: Date.now(),
      });

      db.close();

      const restartedDb = openDatabase({ path: dbPath });
      runMemoryMigrations(restartedDb);

      const restarted = new SqliteJobPersistence(restartedDb);
      const pending = restarted.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe("durable-crash-job");

      const queue = new JobQueue(restarted);
      const dedup = new JobDedupEngine();
      const dispatcher = new JobDispatcher({ queue, dedup, persistence: restarted });
      let workerCalls = 0;
      dispatcher.registerWorker("memory.organize", async () => {
        workerCalls += 1;
      });

      dispatcher.start();
      const didProcess = await dispatcher.processNext();
      expect(didProcess).toBe(true);
      expect(workerCalls).toBe(1);

      const statusRow = restartedDb.get<{ status: string }>(
        "SELECT status FROM _memory_maintenance_jobs WHERE idempotency_key = ?",
        ["durable-crash-job"],
      );
      expect(statusRow?.status).toBe("reconciled");

      cleanupDb(restartedDb, dbPath);
    } finally {
      cleanupDb(db);
    }
  });

  it("keeps enqueue idempotent by idempotency key", () => {
    const { db, dbPath } = createTempDb();

    try {
      const persistence = new SqliteJobPersistence(db);
      const entry = {
        id: "idempotent-job-key",
        jobType: "memory.organize",
        payload: { run: 1 },
        status: "pending" as const,
        maxAttempts: 4,
        nextAttemptAt: Date.now(),
      };

      persistence.enqueue(entry);
      persistence.enqueue(entry);

      const count = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM _memory_maintenance_jobs WHERE job_type = ? AND idempotency_key = ?",
        [entry.jobType, entry.id],
      );
      expect(count?.count).toBe(1);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("keeps memory:033 migration idempotent when run twice", () => {
    const { db, dbPath } = createTempDb();

    try {
      const migration033 = MEMORY_MIGRATIONS.find(
        (migration) => migration.id === "memory:033:extend-maintenance-jobs-for-durable-queue",
      );
      expect(migration033).toBeDefined();
      if (!migration033) {
        throw new Error("memory:033 migration not found");
      }

      migration033.up(db);
      migration033.up(db);

      const columns = db.query<{ name: string }>("PRAGMA table_info(_memory_maintenance_jobs)");
      const columnNames = new Set(columns.map((column) => column.name));
      expect(columnNames.has("attempt_count")).toBe(true);
      expect(columnNames.has("max_attempts")).toBe(true);
      expect(columnNames.has("error_message")).toBe(true);
      expect(columnNames.has("claimed_at")).toBe(true);

      const index = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        ["idx_memory_maintenance_jobs_status_next"],
      );
      expect(index?.name).toBe("idx_memory_maintenance_jobs_status_next");
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("retries a retryable job back to pending with explicit retry()", () => {
    const { db, dbPath } = createTempDb();

    try {
      const persistence = new SqliteJobPersistence(db);
      const jobId = "retry-contract-job";

      persistence.enqueue({
        id: jobId,
        jobType: "memory.organize",
        payload: { batchId: "b-retry" },
        status: "pending",
        maxAttempts: 4,
        nextAttemptAt: Date.now(),
      });

      expect(persistence.claim(jobId, "worker-1", 30_000)).toBe(true);
      persistence.fail(jobId, "transient failure", true);

      const retryableRow = db.get<{ status: string }>(
        "SELECT status FROM _memory_maintenance_jobs WHERE idempotency_key = ?",
        [jobId],
      );
      expect(retryableRow?.status).toBe("retryable");

      expect(persistence.retry(jobId)).toBe(true);

      const pendingRow = db.get<{ status: string }>(
        "SELECT status FROM _memory_maintenance_jobs WHERE idempotency_key = ?",
        [jobId],
      );
      expect(pendingRow?.status).toBe("pending");
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("returns false when retry() is called on reconciled job", () => {
    const { db, dbPath } = createTempDb();

    try {
      const persistence = new SqliteJobPersistence(db);
      const jobId = "retry-contract-reconciled";

      persistence.enqueue({
        id: jobId,
        jobType: "memory.organize",
        payload: { batchId: "b-reconciled" },
        status: "pending",
        maxAttempts: 4,
        nextAttemptAt: Date.now(),
      });
      persistence.complete(jobId);

      expect(persistence.retry(jobId)).toBe(false);

      const row = db.get<{ status: string }>(
        "SELECT status FROM _memory_maintenance_jobs WHERE idempotency_key = ?",
        [jobId],
      );
      expect(row?.status).toBe("reconciled");
    } finally {
      cleanupDb(db, dbPath);
    }
  });
});
