import { wrapError } from "../core/errors.js";
import type { InteractionRecord } from "../interaction/contracts.js";
import type { FlushSelector } from "../interaction/flush-selector.js";
import type { InteractionStore } from "../interaction/store.js";
import type { Db } from "../storage/database.js";
import type { SettlementLedger } from "./settlement-ledger.js";
import type { MemoryTaskAgent, MemoryFlushRequest } from "./task-agent.js";

const JOB_TYPE = "pending_settlement_flush";
const PERIODIC_INTERVAL_MS = 30_000;
const PERIODIC_STALE_CUTOFF_MS = 120_000;
const TRANSIENT_BASE_BACKOFF_MS = 30_000;
const TRANSIENT_MAX_BACKOFF_MS = 15 * 60_000;
const UNRESOLVED_BASE_BACKOFF_MS = 5 * 60_000;
const UNRESOLVED_MAX_BACKOFF_MS = 6 * 60 * 60_000;
const UNRESOLVED_BLOCK_AFTER_FAILURES = 5;
const SWEEP_LOCK_SETTLEMENT_ID = "__sweeper__:pending_settlement_flush";
const SWEEP_LOCK_AGENT_ID = "system:pending_settlement_sweeper";

type JobStatus = "retry_scheduled" | "succeeded" | "blocked_manual" | "failed_hard";

type PendingSettlementJobPayload = {
  sessionId: string;
  agentId: string;
  rangeStart: number;
  rangeEnd: number;
  failureCount: number;
  lastAttemptAt: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

type PendingSettlementJobRow = {
  id: number;
  status: JobStatus;
  payload: string | null;
  next_attempt_at: number | null;
};

export class PendingSettlementSweeper {
  private timer?: ReturnType<typeof setInterval>;
  private sweepInFlight = false;
  private stopped = true;

  constructor(
    private readonly db: Db,
    private readonly interactionStore: InteractionStore,
    private readonly flushSelector: FlushSelector,
    private readonly memoryTaskAgent: MemoryTaskAgent,
    private readonly options: {
      intervalMs?: number;
      periodicStaleCutoffMs?: number;
      now?: () => number;
      random?: () => number;
      settlementLedger?: SettlementLedger;
    } = {},
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.stopped = false;
    this.runSweep({ includeAllPending: true }).catch(() => undefined);

    const intervalMs = this.options.intervalMs ?? PERIODIC_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.runSweep({ includeAllPending: false }).catch(() => undefined);
    }, intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async runSweep(params: { includeAllPending: boolean }): Promise<void> {
    if (this.stopped) {
      return;
    }

    const releaseSweepGuard = this.tryAcquireSweepGuard();
    if (!releaseSweepGuard) {
      return;
    }

    try {
      const staleCutoffMs = params.includeAllPending
        ? -1
        : this.options.periodicStaleCutoffMs ?? PERIODIC_STALE_CUTOFF_MS;
      const sessions = this.interactionStore.listStalePendingSettlementSessions(staleCutoffMs);

      for (const session of sessions) {
        if (this.stopped) {
          return;
        }
        await this.processSession(session.sessionId, session.agentId);
      }
    } finally {
      releaseSweepGuard();
    }
  }

  private tryAcquireSweepGuard(): (() => void) | null {
    if (!this.options.settlementLedger) {
      if (this.sweepInFlight) {
        return null;
      }

      this.sweepInFlight = true;
      return () => {
        this.sweepInFlight = false;
      };
    }

    const now = this.now();
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
      [SWEEP_LOCK_AGENT_ID, now, now, SWEEP_LOCK_SETTLEMENT_ID],
    );

    if (claimResult.changes <= 0) {
      return null;
    }

    return () => {
      const releasedAt = this.now();
      this.db.run(
        `UPDATE settlement_processing_ledger
         SET status = 'pending',
             claimed_by = NULL,
             claimed_at = NULL,
             error_message = NULL,
             updated_at = ?
         WHERE settlement_id = ?`,
        [releasedAt, SWEEP_LOCK_SETTLEMENT_ID],
      );
    };
  }

  private async processSession(sessionId: string, agentId: string): Promise<void> {
    const range = this.interactionStore.getUnprocessedRangeForSession(sessionId);
    if (!range) {
      return;
    }

    const flushRequest = this.flushSelector.buildSessionCloseFlush(sessionId, agentId);
    if (!flushRequest) {
      return;
    }

    // Session-scoped job key so backoff state persists across range expansions.
    // The actual range is tracked in the payload for diagnostics, not in the key.
    const jobKey = `pending_flush:${sessionId}`;

    const existingJob = this.getJob(jobKey);
    if (existingJob && (existingJob.status === "blocked_manual" || existingJob.status === "failed_hard")) {
      return;
    }

    const now = this.now();
    if (existingJob?.next_attempt_at !== null && existingJob?.next_attempt_at !== undefined && existingJob.next_attempt_at > now) {
      return;
    }

    const previousPayload = this.readPayload(existingJob?.payload);
    const records = this.interactionStore.getByRange(
      flushRequest.sessionId,
      flushRequest.rangeStart,
      flushRequest.rangeEnd,
    );

    const basePayload: PendingSettlementJobPayload = {
      sessionId: flushRequest.sessionId,
      agentId,
      rangeStart: flushRequest.rangeStart,
      rangeEnd: flushRequest.rangeEnd,
      failureCount: previousPayload?.failureCount ?? 0,
      lastAttemptAt: now,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    };

    try {
      await this.memoryTaskAgent.runMigrate({
        ...flushRequest,
        dialogueRecords: toDialogueRecords(records),
        interactionRecords: records,
        queueOwnerAgentId: agentId,
      });

      this.interactionStore.markProcessed(flushRequest.sessionId, flushRequest.rangeEnd);
      this.upsertJob(jobKey, "succeeded", {
        ...basePayload,
        failureCount: 0,
      });
    } catch (thrown) {
      const error = wrapError(thrown);
      if (error.code === "COGNITION_UNRESOLVED_REFS") {
        const failureCount = (previousPayload?.failureCount ?? 0) + 1;
        if (failureCount >= UNRESOLVED_BLOCK_AFTER_FAILURES) {
          this.upsertJob(jobKey, "blocked_manual", {
            ...basePayload,
            failureCount,
            nextAttemptAt: null,
            lastErrorCode: error.code,
            lastErrorMessage: error.message,
          });
          return;
        }

        const delayMs = this.calculateBackoffMs(failureCount, UNRESOLVED_BASE_BACKOFF_MS, UNRESOLVED_MAX_BACKOFF_MS);
        this.upsertJob(jobKey, "retry_scheduled", {
          ...basePayload,
          failureCount,
          nextAttemptAt: now + delayMs,
          lastErrorCode: error.code,
          lastErrorMessage: error.message,
        });
        return;
      }

      if (!error.retriable) {
        this.upsertJob(jobKey, "failed_hard", {
          ...basePayload,
          failureCount: (previousPayload?.failureCount ?? 0) + 1,
          nextAttemptAt: null,
          lastErrorCode: error.code,
          lastErrorMessage: error.message,
        });
        return;
      }

      const failureCount = (previousPayload?.failureCount ?? 0) + 1;
      const delayMs = this.calculateBackoffMs(failureCount, TRANSIENT_BASE_BACKOFF_MS, TRANSIENT_MAX_BACKOFF_MS);
      this.upsertJob(jobKey, "retry_scheduled", {
        ...basePayload,
        failureCount,
        nextAttemptAt: now + delayMs,
        lastErrorCode: error.code,
        lastErrorMessage: error.message,
      });
    }
  }

  private calculateBackoffMs(failureCount: number, baseMs: number, maxMs: number): number {
    const attempt = Math.max(0, failureCount - 1);
    const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
    const jitter = Math.floor(exponential * 0.2 * this.random());
    return Math.min(maxMs, exponential + jitter);
  }

  private getJob(idempotencyKey: string): PendingSettlementJobRow | null {
    const row = this.db.get<PendingSettlementJobRow>(
      `SELECT id, status, payload, next_attempt_at
       FROM _memory_maintenance_jobs
       WHERE job_type = ? AND idempotency_key = ?
       LIMIT 1`,
      [JOB_TYPE, idempotencyKey],
    );
    return row ?? null;
  }

  private upsertJob(idempotencyKey: string, status: JobStatus, payload: PendingSettlementJobPayload): void {
    const now = this.now();
    const existing = this.getJob(idempotencyKey);
    if (!existing) {
      this.db.run(
        `INSERT INTO _memory_maintenance_jobs
         (job_type, status, idempotency_key, payload, created_at, updated_at, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          JOB_TYPE,
          status,
          idempotencyKey,
          JSON.stringify(payload),
          now,
          now,
          payload.nextAttemptAt,
        ],
      );
      return;
    }

    this.db.run(
      `UPDATE _memory_maintenance_jobs
       SET status = ?, payload = ?, updated_at = ?, next_attempt_at = ?
       WHERE id = ?`,
      [status, JSON.stringify(payload), now, payload.nextAttemptAt, existing.id],
    );
  }

  private readPayload(payload: string | null | undefined): PendingSettlementJobPayload | null {
    if (!payload) {
      return null;
    }

    try {
      return JSON.parse(payload) as PendingSettlementJobPayload;
    } catch {
      return null;
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private random(): number {
    return this.options.random?.() ?? Math.random();
  }
}

function toDialogueRecords(records: InteractionRecord[]): Array<{
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  recordId: string;
  recordIndex: number;
  correlatedTurnId?: string;
}> {
  type DialogueRecord = {
    role: "user" | "assistant";
    content: string;
    timestamp: number;
    recordId: string;
    recordIndex: number;
    correlatedTurnId?: string;
  };

  return records
    .filter((record) => record.recordType === "message")
    .map((record): DialogueRecord | undefined => {
      const payload = record.payload as { role?: unknown; content?: unknown };
      if (payload.role !== "user" && payload.role !== "assistant") {
        return undefined;
      }

      return {
        role: payload.role,
        content: typeof payload.content === "string" ? payload.content : "",
        timestamp: record.committedAt,
        recordId: record.recordId,
        recordIndex: record.recordIndex,
        correlatedTurnId: record.correlatedTurnId,
      };
    })
    .filter((record): record is DialogueRecord => record !== undefined);
}
