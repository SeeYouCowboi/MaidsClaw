import type { Job, JobKey, JobStatus } from "./types.js";
import { EXECUTION_CLASS_PRIORITY } from "./types.js";

type StoredJob = Job & { enqueueSeq: number };

export class JobQueue {
  private readonly jobsById = new Map<string, StoredJob>();
  private readonly jobsByKey = new Map<JobKey, string>();
  private readonly pendingJobIds = new Set<string>();
  private enqueueCounter = 0;

  enqueue(job: Job): void {
    const stored: StoredJob = {
      ...job,
      enqueueSeq: this.enqueueCounter++,
    };

    this.jobsById.set(job.jobId, stored);
    this.jobsByKey.set(job.jobKey, job.jobId);

    if (job.status === "pending") {
      this.pendingJobIds.add(job.jobId);
    }
  }

  dequeue(): Job | undefined {
    const next = this.selectNextPending();
    if (!next) {
      return undefined;
    }

    this.pendingJobIds.delete(next.jobId);
    return this.toJob(next);
  }

  peek(): Job | undefined {
    const next = this.selectNextPending();
    return next ? this.toJob(next) : undefined;
  }

  size(): number {
    return this.pendingJobIds.size;
  }

  getByKey(jobKey: JobKey): Job | undefined {
    const jobId = this.jobsByKey.get(jobKey);
    if (!jobId) {
      return undefined;
    }

    const job = this.jobsById.get(jobId);
    return job ? this.toJob(job) : undefined;
  }

  getAll(): Job[] {
    return Array.from(this.jobsById.values()).map((job) => this.toJob(job));
  }

  updateJob(jobId: string, updates: Partial<Job>): void {
    const existing = this.jobsById.get(jobId);
    if (!existing) {
      return;
    }

    const merged: StoredJob = {
      ...existing,
      ...updates,
      enqueueSeq: existing.enqueueSeq,
    };

    this.jobsById.set(jobId, merged);
    this.jobsByKey.set(merged.jobKey, merged.jobId);
    this.syncPendingState(existing.status, merged.status, merged.jobId);
  }

  private syncPendingState(previous: JobStatus, next: JobStatus, jobId: string): void {
    if (previous !== "pending" && next === "pending") {
      this.pendingJobIds.add(jobId);
      return;
    }
    if (previous === "pending" && next !== "pending") {
      this.pendingJobIds.delete(jobId);
      return;
    }
    if (next === "pending") {
      this.pendingJobIds.add(jobId);
    }
  }

  private selectNextPending(): StoredJob | undefined {
    let best: StoredJob | undefined;

    for (const pendingId of this.pendingJobIds) {
      const candidate = this.jobsById.get(pendingId);
      if (!candidate) {
        this.pendingJobIds.delete(pendingId);
        continue;
      }

      if (!best) {
        best = candidate;
        continue;
      }

      const candidatePriority = EXECUTION_CLASS_PRIORITY[candidate.executionClass];
      const bestPriority = EXECUTION_CLASS_PRIORITY[best.executionClass];

      if (candidatePriority < bestPriority) {
        best = candidate;
        continue;
      }

      if (candidatePriority === bestPriority) {
        if (candidate.createdAt < best.createdAt) {
          best = candidate;
          continue;
        }

        if (candidate.createdAt === best.createdAt && candidate.enqueueSeq < best.enqueueSeq) {
          best = candidate;
        }
      }
    }

    return best;
  }

  private toJob(job: StoredJob): Job {
    const copy: Job = {
      jobId: job.jobId,
      jobKey: job.jobKey,
      kind: job.kind,
      executionClass: job.executionClass,
      payload: job.payload,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      retriable: job.retriable,
      createdAt: job.createdAt,
      ownershipAccepted: job.ownershipAccepted,
    };

    if (job.sessionId !== undefined) {
      copy.sessionId = job.sessionId;
    }
    if (job.agentId !== undefined) {
      copy.agentId = job.agentId;
    }
    if (job.idempotencyKey !== undefined) {
      copy.idempotencyKey = job.idempotencyKey;
    }
    if (job.startedAt !== undefined) {
      copy.startedAt = job.startedAt;
    }
    if (job.completedAt !== undefined) {
      copy.completedAt = job.completedAt;
    }
    if (job.error !== undefined) {
      copy.error = job.error;
    }

    return copy;
  }
}
