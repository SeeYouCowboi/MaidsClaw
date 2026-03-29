import { wrapError } from "../core/errors.js";
import type { InteractionRecord } from "../interaction/contracts.js";
import type { FlushSelector } from "../interaction/flush-selector.js";
import type { InteractionStore } from "../interaction/store.js";
import type { PendingFlushRecoveryRepo } from "../storage/domain-repos/contracts/pending-flush-recovery-repo.js";
import type { MemoryTaskAgent, MemoryFlushRequest } from "./task-agent.js";

const PERIODIC_INTERVAL_MS = 30_000;
const PERIODIC_STALE_CUTOFF_MS = 120_000;
const TRANSIENT_BASE_BACKOFF_MS = 30_000;
const TRANSIENT_MAX_BACKOFF_MS = 15 * 60_000;
const UNRESOLVED_BASE_BACKOFF_MS = 5 * 60_000;
const UNRESOLVED_MAX_BACKOFF_MS = 6 * 60 * 60_000;
const UNRESOLVED_BLOCK_AFTER_FAILURES = 5;
const SWEEP_LOCK_CLAIMANT = "system:pending_settlement_sweeper";

export class PendingSettlementSweeper {
  private timer?: ReturnType<typeof setInterval>;
  private sweepInFlight = false;
  private stopped = true;

  constructor(
    private readonly pendingFlushRepo: PendingFlushRecoveryRepo,
    private readonly interactionStore: InteractionStore,
    private readonly flushSelector: FlushSelector,
    private readonly memoryTaskAgent: MemoryTaskAgent,
    private readonly options: {
      intervalMs?: number;
      periodicStaleCutoffMs?: number;
      now?: () => number;
      random?: () => number;
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

    const acquired = await this.tryAcquireSweepGuard();
    if (!acquired) {
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
      await this.releaseSweepGuard();
    }
  }

  private async tryAcquireSweepGuard(): Promise<boolean> {
    if (this.sweepInFlight) {
      return false;
    }

    const locked = await this.pendingFlushRepo.trySweepLock(SWEEP_LOCK_CLAIMANT);
    if (!locked) {
      return false;
    }

    this.sweepInFlight = true;
    return true;
  }

  private async releaseSweepGuard(): Promise<void> {
    this.sweepInFlight = false;
    await this.pendingFlushRepo.releaseSweepLock();
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

    const existingRecord = await this.pendingFlushRepo.getBySession(sessionId);
    if (existingRecord && existingRecord.status === "hard_failed") {
      return;
    }

    const now = this.now();
    if (
      existingRecord?.next_attempt_at !== null &&
      existingRecord?.next_attempt_at !== undefined &&
      existingRecord.next_attempt_at > now
    ) {
      return;
    }

    const previousFailureCount = existingRecord?.failure_count ?? 0;
    const records = this.interactionStore.getByRange(
      flushRequest.sessionId,
      flushRequest.rangeStart,
      flushRequest.rangeEnd,
    );

    if (!existingRecord) {
      await this.pendingFlushRepo.recordPending({
        sessionId: flushRequest.sessionId,
        agentId,
        flushRangeStart: flushRequest.rangeStart,
        flushRangeEnd: flushRequest.rangeEnd,
        nextAttemptAt: null,
      });
    }

    try {
      await this.memoryTaskAgent.runMigrate({
        ...flushRequest,
        dialogueRecords: toDialogueRecords(records),
        interactionRecords: records,
        queueOwnerAgentId: agentId,
      });

      this.interactionStore.markProcessed(flushRequest.sessionId, flushRequest.rangeEnd);
      await this.pendingFlushRepo.markResolved(sessionId);
    } catch (thrown) {
      const error = wrapError(thrown);
      if (error.code === "COGNITION_UNRESOLVED_REFS") {
        const failureCount = previousFailureCount + 1;
        if (failureCount >= UNRESOLVED_BLOCK_AFTER_FAILURES) {
          await this.pendingFlushRepo.markHardFail(
            sessionId,
            `${error.code}: ${error.message}`,
            failureCount,
          );
          return;
        }

        const delayMs = this.calculateBackoffMs(failureCount, UNRESOLVED_BASE_BACKOFF_MS, UNRESOLVED_MAX_BACKOFF_MS);
        await this.pendingFlushRepo.markAttempted({
          sessionId,
          failureCount,
          backoffMs: delayMs,
          nextAttemptAt: now + delayMs,
          lastError: `${error.code}: ${error.message}`,
        });
        return;
      }

      if (!error.retriable) {
        const failureCount = previousFailureCount + 1;
        await this.pendingFlushRepo.markHardFail(
          sessionId,
          `${error.code}: ${error.message}`,
          failureCount,
        );
        return;
      }

      const failureCount = previousFailureCount + 1;
      const delayMs = this.calculateBackoffMs(failureCount, TRANSIENT_BASE_BACKOFF_MS, TRANSIENT_MAX_BACKOFF_MS);
      await this.pendingFlushRepo.markAttempted({
        sessionId,
        failureCount,
        backoffMs: delayMs,
        nextAttemptAt: now + delayMs,
        lastError: `${error.code}: ${error.message}`,
      });
    }
  }

  private calculateBackoffMs(failureCount: number, baseMs: number, maxMs: number): number {
    const attempt = Math.max(0, failureCount - 1);
    const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
    const jitter = Math.floor(exponential * 0.2 * this.random());
    return Math.min(maxMs, exponential + jitter);
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
