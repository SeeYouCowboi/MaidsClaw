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
  enqueue(entry: Omit<JobEntry, "attemptCount" | "createdAt" | "updatedAt">): Promise<void>;
  claim(jobId: string, claimedBy: string, leaseDurationMs: number): Promise<boolean>;
  complete(jobId: string): Promise<void>;
  fail(jobId: string, errorMessage: string, retryable: boolean): Promise<void>;
  retry(jobId: string): Promise<boolean>;
  listPending(limit?: number): Promise<JobEntry[]>;
  listRetryable(beforeTime: number, limit?: number): Promise<JobEntry[]>;
  countByStatus(status: PersistentJobStatus): Promise<number>;
  /** Cancel a pending (unclaimed) job by key. Returns true if a job was cancelled. */
  cancelPendingByKey?(jobKey: string): Promise<boolean>;
}
