import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDrainReady } from "../../src/jobs/sqlite-drain-check.js";

const JOBS_TABLE_DDL = `
  CREATE TABLE _memory_maintenance_jobs (
    id INTEGER PRIMARY KEY,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL,
    idempotency_key TEXT,
    payload TEXT,
    attempt_count INTEGER,
    max_attempts INTEGER,
    error_message TEXT,
    claimed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    next_attempt_at INTEGER
  )
`;

function makeTempDbPath(): string {
  return join(tmpdir(), `maidsclaw-drain-test-${randomUUID()}.db`);
}

function insertJob(db: Database, status: string, jobType = "memory.organize"): void {
  const now = Date.now();
  db.run(
    `INSERT INTO _memory_maintenance_jobs (job_type, status, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [jobType, status, randomUUID(), now, now],
  );
}

function cleanupFile(path: string): void {
  for (const suffix of ["", "-shm", "-wal"]) {
    try { rmSync(`${path}${suffix}`, { force: true }); } catch {}
  }
}

describe("sqlite drain-gate preflight", () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    for (const p of tempPaths) cleanupFile(p);
    tempPaths.length = 0;
  });

  it("active legacy rows: reports NOT READY with pending/processing/retryable rows", async () => {
    const dbPath = makeTempDbPath();
    tempPaths.push(dbPath);

    const db = new Database(dbPath, { create: true });
    db.exec(JOBS_TABLE_DDL);
    insertJob(db, "pending");
    insertJob(db, "pending");
    insertJob(db, "processing");
    insertJob(db, "retryable");
    insertJob(db, "exhausted");
    db.close();

    const report = await checkDrainReady(dbPath);

    expect(report.ready).toBe(false);
    expect(report.activeCounts.pending).toBe(2);
    expect(report.activeCounts.processing).toBe(1);
    expect(report.activeCounts.retryable).toBe(1);
    expect(report.terminalCounts.exhausted).toBe(1);
    expect(report.totalCount).toBe(5);
    expect(report.message).toContain("NOT READY");
    expect(report.message).toContain("2 pending");
    expect(report.message).toContain("1 processing");
    expect(report.message).toContain("1 retryable");
  });

  it("terminal legacy rows: reports READY when only terminal rows remain", async () => {
    const dbPath = makeTempDbPath();
    tempPaths.push(dbPath);

    const db = new Database(dbPath, { create: true });
    db.exec(JOBS_TABLE_DDL);
    insertJob(db, "exhausted");
    insertJob(db, "exhausted");
    insertJob(db, "reconciled");
    db.close();

    const report = await checkDrainReady(dbPath);

    expect(report.ready).toBe(true);
    expect(report.activeCounts.pending).toBe(0);
    expect(report.activeCounts.processing).toBe(0);
    expect(report.activeCounts.retryable).toBe(0);
    expect(report.terminalCounts.exhausted).toBe(2);
    expect(report.terminalCounts.reconciled).toBe(1);
    expect(report.totalCount).toBe(3);
    expect(report.message).toMatch(/precondition|future/i);
  });

  it("no table: reports READY when _memory_maintenance_jobs doesn't exist", async () => {
    const dbPath = makeTempDbPath();
    tempPaths.push(dbPath);

    const db = new Database(dbPath, { create: true });
    db.close();

    const report = await checkDrainReady(dbPath);

    expect(report.ready).toBe(true);
    expect(report.activeCounts.pending).toBe(0);
    expect(report.activeCounts.processing).toBe(0);
    expect(report.activeCounts.retryable).toBe(0);
    expect(report.totalCount).toBe(0);
    expect(report.message).toContain("No legacy");
  });
});
