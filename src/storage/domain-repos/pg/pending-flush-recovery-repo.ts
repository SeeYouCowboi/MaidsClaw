import type postgres from "postgres";
import type {
  PendingFlushRecoveryRecord,
  PendingFlushRecoveryRepo,
  PendingFlushRecoveryStatus,
} from "../contracts/pending-flush-recovery-repo.js";

const ACTIVE_STATUSES = ["pending", "retry_scheduled"] as const;

const VALID_STATUSES: ReadonlySet<string> = new Set<PendingFlushRecoveryStatus>([
  "pending",
  "retry_scheduled",
  "resolved",
  "hard_failed",
]);

function isValidStatus(s: string): s is PendingFlushRecoveryStatus {
  return VALID_STATUSES.has(s);
}

type RecoveryRow = {
  session_id: string;
  agent_id: string;
  flush_range_start: string | number;
  flush_range_end: string | number;
  failure_count: string | number;
  backoff_ms: string | number;
  next_attempt_at: string | number | null;
  last_error: string | null;
  status: string;
  updated_at: string | number;
};

function rowToRecord(row: RecoveryRow): PendingFlushRecoveryRecord {
  return {
    session_id: row.session_id,
    agent_id: row.agent_id,
    flush_range_start: Number(row.flush_range_start),
    flush_range_end: Number(row.flush_range_end),
    failure_count: Number(row.failure_count),
    backoff_ms: Number(row.backoff_ms),
    next_attempt_at: row.next_attempt_at != null ? Number(row.next_attempt_at) : null,
    last_error: row.last_error,
    status: isValidStatus(row.status) ? row.status : "pending",
    updated_at: Number(row.updated_at),
  };
}

export class PgPendingFlushRecoveryRepo implements PendingFlushRecoveryRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async recordPending(input: {
    sessionId: string;
    agentId: string;
    flushRangeStart: number;
    flushRangeEnd: number;
    nextAttemptAt?: number | null;
  }): Promise<void> {
    const now = Date.now();
    await this.sql`
      INSERT INTO pending_settlement_recovery
        (session_id, agent_id, flush_range_start, flush_range_end,
         failure_count, backoff_ms, next_attempt_at, status, created_at, updated_at)
      VALUES
        (${input.sessionId}, ${input.agentId}, ${input.flushRangeStart}, ${input.flushRangeEnd},
         0, 0, ${input.nextAttemptAt ?? null}, 'pending', ${now}, ${now})
      ON CONFLICT (session_id) WHERE status IN ('pending', 'retry_scheduled')
      DO NOTHING
    `;
  }

  async markAttempted(input: {
    sessionId: string;
    failureCount: number;
    backoffMs: number;
    nextAttemptAt: number | null;
    lastError?: string | null;
  }): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE pending_settlement_recovery
      SET status          = 'retry_scheduled',
          failure_count   = ${input.failureCount},
          backoff_ms      = ${input.backoffMs},
          next_attempt_at = ${input.nextAttemptAt},
          last_error      = ${input.lastError ?? null},
          updated_at      = ${now}
      WHERE session_id = ${input.sessionId}
        AND status != 'resolved'
    `;
  }

  async markResolved(sessionId: string): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE pending_settlement_recovery
      SET status     = 'resolved',
          updated_at = ${now}
      WHERE session_id = ${sessionId}
        AND status IN (${ACTIVE_STATUSES[0]}, ${ACTIVE_STATUSES[1]})
    `;
  }

  async queryActive(nowMs: number): Promise<PendingFlushRecoveryRecord[]> {
    const rows = await this.sql<RecoveryRow[]>`
      SELECT session_id, agent_id, flush_range_start, flush_range_end,
             failure_count, backoff_ms, next_attempt_at, last_error, status, updated_at
      FROM pending_settlement_recovery
      WHERE status IN (${ACTIVE_STATUSES[0]}, ${ACTIVE_STATUSES[1]})
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${nowMs})
      ORDER BY next_attempt_at ASC NULLS FIRST
    `;
    return rows.map(rowToRecord);
  }

  async markHardFail(sessionId: string, lastError: string): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE pending_settlement_recovery
      SET status     = 'hard_failed',
          last_error = ${lastError},
          updated_at = ${now}
      WHERE session_id = ${sessionId}
        AND status IN (${ACTIVE_STATUSES[0]}, ${ACTIVE_STATUSES[1]})
    `;
  }
}
