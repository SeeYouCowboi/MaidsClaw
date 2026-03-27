import type { Db } from "../storage/database.js";

export type PersistentJobStatus =
  | "pending"
  | "processing"
  | "retryable"
  | "exhausted"
  | "reconciled";

export interface JobEntry {
  id: string;
  jobType: string;
  payload: unknown;
  status: PersistentJobStatus;
  attemptCount: number;
  maxAttempts: number;
  errorMessage?: string;
  nextAttemptAt?: number;
  claimedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface JobPersistence {
  enqueue(entry: Omit<JobEntry, "attemptCount" | "createdAt" | "updatedAt">): void;
  claim(jobId: string, claimedBy: string, leaseDurationMs: number): boolean;
  complete(jobId: string): void;
  fail(jobId: string, errorMessage: string, retryable: boolean): void;
  listPending(limit?: number): JobEntry[];
  listRetryable(beforeTime: number, limit?: number): JobEntry[];
}

type JobRow = {
  job_type: string;
  status: string;
  idempotency_key: string | null;
  payload: string | null;
  attempt_count: number | null;
  max_attempts: number | null;
  error_message: string | null;
  next_attempt_at: number | null;
  claimed_at: number | null;
  created_at: number;
  updated_at: number;
};

export class SqliteJobPersistence implements JobPersistence {
  constructor(
    private readonly db: Db,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  enqueue(entry: Omit<JobEntry, "attemptCount" | "createdAt" | "updatedAt">): void {
    const now = this.clock();
    this.db.run(
      `INSERT OR IGNORE INTO _memory_maintenance_jobs
       (job_type, status, idempotency_key, payload, attempt_count, max_attempts, error_message, claimed_at, created_at, updated_at, next_attempt_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      [
        entry.jobType,
        entry.status,
        entry.id,
        JSON.stringify(entry.payload),
        entry.maxAttempts,
        entry.errorMessage ?? null,
        entry.claimedAt ?? null,
        now,
        now,
        entry.nextAttemptAt ?? null,
      ],
    );
  }

  claim(jobId: string, claimedBy: string, leaseDurationMs: number): boolean {
    void claimedBy;
    void leaseDurationMs;

    const now = this.clock();
    const result = this.db.run(
      `UPDATE _memory_maintenance_jobs
       SET status = 'processing', claimed_at = ?, updated_at = ?
       WHERE idempotency_key = ? AND status = 'pending'`,
      [now, now, jobId],
    );
    return result.changes > 0;
  }

  complete(jobId: string): void {
    const now = this.clock();
    this.db.run(
      `UPDATE _memory_maintenance_jobs
       SET status = 'reconciled', error_message = NULL, next_attempt_at = NULL, updated_at = ?
       WHERE idempotency_key = ?`,
      [now, jobId],
    );
  }

  fail(jobId: string, errorMessage: string, retryable: boolean): void {
    const row = this.db.get<{ attempt_count: number | null; max_attempts: number | null }>(
      `SELECT attempt_count, max_attempts FROM _memory_maintenance_jobs WHERE idempotency_key = ?`,
      [jobId],
    );
    if (!row) {
      return;
    }

    const nextAttemptCount = (row.attempt_count ?? 0) + 1;
    const maxAttempts = row.max_attempts ?? 1;
    const canRetry = retryable && nextAttemptCount < maxAttempts;
    const now = this.clock();

    this.db.run(
      `UPDATE _memory_maintenance_jobs
       SET status = ?,
           attempt_count = ?,
           error_message = ?,
           next_attempt_at = ?,
           updated_at = ?,
           claimed_at = NULL
       WHERE idempotency_key = ?`,
      [canRetry ? "retryable" : "exhausted", nextAttemptCount, errorMessage, canRetry ? now : null, now, jobId],
    );
  }

  listPending(limit = 100): JobEntry[] {
    const rows = this.db.query<JobRow>(
      `SELECT job_type, status, idempotency_key, payload, attempt_count, max_attempts, error_message, next_attempt_at, claimed_at, created_at, updated_at
       FROM _memory_maintenance_jobs
       WHERE status = 'pending'
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      [normalizeLimit(limit)],
    );
    return rows.map((row) => toEntry(row));
  }

  listRetryable(beforeTime: number, limit = 100): JobEntry[] {
    const rows = this.db.query<JobRow>(
      `SELECT job_type, status, idempotency_key, payload, attempt_count, max_attempts, error_message, next_attempt_at, claimed_at, created_at, updated_at
       FROM _memory_maintenance_jobs
       WHERE status = 'retryable'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY COALESCE(next_attempt_at, created_at) ASC, id ASC
       LIMIT ?`,
      [beforeTime, normalizeLimit(limit)],
    );
    return rows.map((row) => toEntry(row));
  }
}

function toEntry(row: JobRow): JobEntry {
  return {
    id: row.idempotency_key ?? "",
    jobType: row.job_type,
    payload: parsePayload(row.payload),
    status: coerceStatus(row.status),
    attemptCount: row.attempt_count ?? 0,
    maxAttempts: row.max_attempts ?? 1,
    errorMessage: row.error_message ?? undefined,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    claimedAt: row.claimed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePayload(raw: string | null): unknown {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function coerceStatus(status: string): PersistentJobStatus {
  if (
    status === "pending"
    || status === "processing"
    || status === "retryable"
    || status === "exhausted"
    || status === "reconciled"
  ) {
    return status;
  }
  return "pending";
}

function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
}
