import type { Db } from "../../database.js";
import type {
  PendingFlushRecoveryRecord,
  PendingFlushRecoveryRepo,
  PendingFlushRecoveryStatus,
} from "../contracts/pending-flush-recovery-repo.js";

type PendingJobDbRow = {
  idempotency_key: string;
  status: string;
  payload: string | null;
  next_attempt_at: number | null;
  updated_at: number;
};

type PendingPayload = {
  sessionId: string;
  agentId: string;
  rangeStart: number;
  rangeEnd: number;
  failureCount: number;
  backoffMs?: number;
  nextAttemptAt: number | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
};

const JOB_TYPE = "pending_settlement_flush";
const SWEEP_LOCK_SETTLEMENT_ID = "__sweeper__:pending_settlement_flush";
const SWEEP_LOCK_AGENT_ID = "system:pending_settlement_sweeper";

export class SqlitePendingFlushRecoveryRepoAdapter implements PendingFlushRecoveryRepo {
  constructor(private readonly db: Db) {}

  async recordPending(input: {
    sessionId: string;
    agentId: string;
    flushRangeStart: number;
    flushRangeEnd: number;
    nextAttemptAt?: number | null;
  }): Promise<void> {
    const now = Date.now();
    const payload: PendingPayload = {
      sessionId: input.sessionId,
      agentId: input.agentId,
      rangeStart: input.flushRangeStart,
      rangeEnd: input.flushRangeEnd,
      failureCount: 0,
      backoffMs: 0,
      nextAttemptAt: input.nextAttemptAt ?? now,
      lastErrorCode: null,
      lastErrorMessage: null,
    };

    const idempotencyKey = `pending_flush:${input.sessionId}`;
    this.db.run(
      `INSERT OR REPLACE INTO _memory_maintenance_jobs
       (job_type, status, idempotency_key, payload, created_at, updated_at, next_attempt_at)
       VALUES (?, 'pending', ?, ?, ?, ?, ?)`,
      [JOB_TYPE, idempotencyKey, JSON.stringify(payload), now, now, payload.nextAttemptAt],
    );
    return Promise.resolve();
  }

  async markAttempted(input: {
    sessionId: string;
    failureCount: number;
    backoffMs: number;
    nextAttemptAt: number | null;
    lastError?: string | null;
  }): Promise<void> {
    const job = this.loadBySession(input.sessionId);
    if (!job) {
      return Promise.resolve();
    }

    const payload = parsePayload(job.payload);
    if (!payload) {
      return Promise.resolve();
    }

    const [errorCode, errorMessage] = splitError(input.lastError ?? null);
    const updated: PendingPayload = {
      ...payload,
      failureCount: input.failureCount,
      backoffMs: input.backoffMs,
      nextAttemptAt: input.nextAttemptAt,
      lastErrorCode: errorCode,
      lastErrorMessage: errorMessage,
    };

    this.db.run(
      `UPDATE _memory_maintenance_jobs
       SET status = 'retry_scheduled', payload = ?, updated_at = ?, next_attempt_at = ?
       WHERE job_type = ? AND idempotency_key = ?`,
      [JSON.stringify(updated), Date.now(), input.nextAttemptAt, JOB_TYPE, `pending_flush:${input.sessionId}`],
    );
    return Promise.resolve();
  }

  async markResolved(sessionId: string): Promise<void> {
    this.db.run(
      `UPDATE _memory_maintenance_jobs
       SET status = 'succeeded', updated_at = ?, next_attempt_at = NULL
       WHERE job_type = ? AND idempotency_key = ?`,
      [Date.now(), JOB_TYPE, `pending_flush:${sessionId}`],
    );
    return Promise.resolve();
  }

  async queryActive(nowMs: number): Promise<PendingFlushRecoveryRecord[]> {
    const rows = this.db.query<PendingJobDbRow>(
      `SELECT idempotency_key, status, payload, next_attempt_at, updated_at
       FROM _memory_maintenance_jobs
       WHERE job_type = ?
         AND status IN ('pending', 'retry_scheduled')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
      [JOB_TYPE, nowMs],
    );

    const mapped: PendingFlushRecoveryRecord[] = [];
    for (const row of rows) {
      const payload = parsePayload(row.payload);
      if (!payload) {
        continue;
      }
      mapped.push({
        session_id: payload.sessionId,
        agent_id: payload.agentId,
        flush_range_start: payload.rangeStart,
        flush_range_end: payload.rangeEnd,
        failure_count: payload.failureCount,
        backoff_ms: payload.backoffMs ?? 0,
        next_attempt_at: row.next_attempt_at,
        last_error: payload.lastErrorMessage ?? null,
        status: mapStatus(row.status),
        updated_at: row.updated_at,
      });
    }

    return Promise.resolve(mapped);
  }

  async markHardFail(sessionId: string, lastError: string, failureCount?: number): Promise<void> {
    const job = this.loadBySession(sessionId);
    if (!job) {
      return Promise.resolve();
    }

    const payload = parsePayload(job.payload);
    if (!payload) {
      return Promise.resolve();
    }

    const [errorCode, errorMessage] = splitError(lastError);
    const updated: PendingPayload = {
      ...payload,
      failureCount: failureCount ?? payload.failureCount,
      lastErrorCode: errorCode,
      lastErrorMessage: errorMessage,
      nextAttemptAt: null,
    };

    this.db.run(
      `UPDATE _memory_maintenance_jobs
       SET status = 'failed_hard', payload = ?, updated_at = ?, next_attempt_at = NULL
       WHERE job_type = ? AND idempotency_key = ?`,
      [JSON.stringify(updated), Date.now(), JOB_TYPE, `pending_flush:${sessionId}`],
    );
    return Promise.resolve();
  }

  async getBySession(sessionId: string): Promise<PendingFlushRecoveryRecord | null> {
    const row = this.loadBySession(sessionId);
    if (!row) {
      return Promise.resolve(null);
    }
    const payload = parsePayload(row.payload);
    if (!payload) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      session_id: payload.sessionId,
      agent_id: payload.agentId,
      flush_range_start: payload.rangeStart,
      flush_range_end: payload.rangeEnd,
      failure_count: payload.failureCount,
      backoff_ms: payload.backoffMs ?? 0,
      next_attempt_at: row.next_attempt_at,
      last_error: payload.lastErrorMessage ?? null,
      status: mapStatus(row.status),
      updated_at: row.updated_at,
    });
  }

  async trySweepLock(claimant: string): Promise<boolean> {
    const now = Date.now();
    this.db.run(
      `INSERT OR IGNORE INTO settlement_processing_ledger
       (settlement_id, agent_id, status, attempt_count, max_attempts, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, 1, ?, ?)`,
      [SWEEP_LOCK_SETTLEMENT_ID, SWEEP_LOCK_AGENT_ID, now, now],
    );

    const claimResult = this.db.run(
      `UPDATE settlement_processing_ledger
       SET status = 'applying',
           claimed_by = ?,
           claimed_at = ?,
           attempt_count = attempt_count + 1,
           updated_at = ?
       WHERE settlement_id = ? AND status = 'pending'`,
      [claimant, now, now, SWEEP_LOCK_SETTLEMENT_ID],
    );

    return Promise.resolve(claimResult.changes > 0);
  }

  async releaseSweepLock(): Promise<void> {
    const now = Date.now();
    this.db.run(
      `UPDATE settlement_processing_ledger
       SET status = 'pending',
           claimed_by = NULL,
           claimed_at = NULL,
           error_message = NULL,
           updated_at = ?
       WHERE settlement_id = ?`,
      [now, SWEEP_LOCK_SETTLEMENT_ID],
    );
    return Promise.resolve();
  }

  private loadBySession(sessionId: string): PendingJobDbRow | undefined {
    return this.db.get<PendingJobDbRow>(
      `SELECT idempotency_key, status, payload, next_attempt_at, updated_at
       FROM _memory_maintenance_jobs
       WHERE job_type = ? AND idempotency_key = ? LIMIT 1`,
      [JOB_TYPE, `pending_flush:${sessionId}`],
    );
  }
}

function parsePayload(raw: string | null): PendingPayload | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as PendingPayload;
    if (!parsed.sessionId || !parsed.agentId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function mapStatus(status: string): PendingFlushRecoveryStatus {
  if (status === "pending") {
    return "pending";
  }
  if (status === "retry_scheduled") {
    return "retry_scheduled";
  }
  if (status === "succeeded") {
    return "resolved";
  }
  return "hard_failed";
}

function splitError(error: string | null): [string | null, string | null] {
  if (!error) {
    return [null, null];
  }
  const colonIndex = error.indexOf(": ");
  if (colonIndex > 0) {
    return [error.slice(0, colonIndex), error.slice(colonIndex + 2)];
  }
  return [error, error];
}
