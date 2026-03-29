export type PendingFlushRecoveryStatus = "pending" | "retry_scheduled" | "resolved" | "hard_failed";

export type PendingFlushRecoveryRecord = {
  session_id: string;
  agent_id: string;
  flush_range_start: number;
  flush_range_end: number;
  failure_count: number;
  backoff_ms: number;
  next_attempt_at: number | null;
  last_error: string | null;
  status: PendingFlushRecoveryStatus;
  updated_at: number;
};

export interface PendingFlushRecoveryRepo {
  recordPending(input: {
    sessionId: string;
    agentId: string;
    flushRangeStart: number;
    flushRangeEnd: number;
    nextAttemptAt?: number | null;
  }): Promise<void>;
  markAttempted(input: {
    sessionId: string;
    failureCount: number;
    backoffMs: number;
    nextAttemptAt: number | null;
    lastError?: string | null;
  }): Promise<void>;
  markResolved(sessionId: string): Promise<void>;
  queryActive(nowMs: number): Promise<PendingFlushRecoveryRecord[]>;
  markHardFail(sessionId: string, lastError: string, failureCount?: number): Promise<void>;
  getBySession(sessionId: string): Promise<PendingFlushRecoveryRecord | null>;
  /**
   * Attempt to acquire an exclusive sweep lock.
   * Returns true if the lock was acquired, false if already held.
   */
  trySweepLock(claimant: string): Promise<boolean>;
  /**
   * Release the sweep lock previously acquired via trySweepLock.
   */
  releaseSweepLock(): Promise<void>;
}
