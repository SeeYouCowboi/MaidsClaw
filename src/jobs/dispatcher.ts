import type { EventBus } from "../core/event-bus.js";
import type { JobDedupEngine } from "./dedup.js";
import type { JobEntry, JobPersistence } from "./persistence.js";
import type { JobQueue } from "./queue.js";
import {
  CONCURRENCY_CAPS,
  EXECUTION_CLASS_PRIORITY,
  JOB_MAX_ATTEMPTS,
  type Job,
  type JobKey,
  type JobKind,
} from "./types.js";

export type WorkerFn = (job: Job) => Promise<void>;

type SubmitSpec = Omit<Job, "jobId" | "status" | "attempts" | "createdAt" | "ownershipAccepted">;

export class JobDispatcher {
  private readonly workers = new Map<JobKind, WorkerFn>();
  private readonly jobsByKey = new Map<JobKey, Job>();
  private readonly inFlightByKey = new Set<string>();
  private started = false;

  constructor(
    private readonly deps: {
      queue: JobQueue;
      dedup: JobDedupEngine;
      eventBus?: EventBus;
      persistence?: JobPersistence;
    },
  ) {}

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    if (!this.deps.persistence) {
      return;
    }

    const recovered = [
      ...this.deps.persistence.listPending(),
      ...this.deps.persistence.listRetryable(Date.now()),
    ];

    for (const entry of recovered) {
      const job = this.toRecoveredJob(entry);
      if (!job || this.deps.queue.getByKey(job.jobKey)) {
        continue;
      }
      this.deps.queue.enqueue(job);
      this.jobsByKey.set(job.jobKey, job);
    }
  }

  registerWorker(kind: JobKind, worker: WorkerFn): void {
    this.workers.set(kind, worker);
  }

  submit(jobSpec: SubmitSpec): Job | null {
    this.start();

    const existing = this.deps.queue.getByKey(jobSpec.jobKey);
    if (existing) {
      this.jobsByKey.set(existing.jobKey, existing);
    }

    const action = this.deps.dedup.checkDuplicate(this.jobsByKey, jobSpec.jobKey);
    if (action !== "accept") {
      return null;
    }

    const now = Date.now();
    const normalizedMaxAttempts =
      jobSpec.maxAttempts > 0 ? jobSpec.maxAttempts : JOB_MAX_ATTEMPTS[jobSpec.kind];

    const job: Job = {
      ...jobSpec,
      jobId: crypto.randomUUID(),
      status: "pending",
      attempts: 0,
      createdAt: now,
      ownershipAccepted: false,
      maxAttempts: normalizedMaxAttempts,
    };

    this.deps.queue.enqueue(job);
    this.jobsByKey.set(job.jobKey, job);
    this.emitEnqueued(job);
    return job;
  }

  async processNext(): Promise<boolean> {
    this.start();

    const next = this.selectNextRunnableJob();
    if (!next) {
      return false;
    }

    const worker = this.workers.get(next.kind);
    if (!worker) {
      const failedAt = Date.now();
      this.deps.queue.updateJob(next.jobId, {
        status: "failed",
        completedAt: failedAt,
        error: `No worker registered for job kind: ${next.kind}`,
      });

      const failed = this.deps.queue.getByKey(next.jobKey);
      if (failed) {
        this.jobsByKey.set(failed.jobKey, failed);
      }
      return true;
    }

    const startedAt = Date.now();
    this.inFlightByKey.add(this.concurrencyKey(next));
    this.deps.queue.updateJob(next.jobId, {
      ownershipAccepted: true,
      status: "running",
      startedAt,
      attempts: next.attempts + 1,
      error: undefined,
    });

    let running = this.deps.queue.getByKey(next.jobKey);
    if (!running) {
      this.inFlightByKey.delete(this.concurrencyKey(next));
      return true;
    }

    this.jobsByKey.set(running.jobKey, running);
    this.emitStarted(running);

    try {
      await worker(running);

      const completedAt = Date.now();
      this.deps.queue.updateJob(running.jobId, {
        status: "completed",
        completedAt,
      });

      const completed = this.deps.queue.getByKey(running.jobKey);
      if (completed) {
        this.jobsByKey.set(completed.jobKey, completed);
        this.emitCompleted(completed, true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      running = this.deps.queue.getByKey(running.jobKey) ?? running;

      if (running.retriable && running.attempts < running.maxAttempts) {
        this.deps.queue.updateJob(running.jobId, {
          status: "pending",
          error: message,
        });

        const retried = this.deps.queue.getByKey(running.jobKey);
        if (retried) {
          this.jobsByKey.set(retried.jobKey, retried);
          this.emitCompleted(retried, false, "JOB_FAILED");
        }
      } else {
        const failedAt = Date.now();
        this.deps.queue.updateJob(running.jobId, {
          status: "failed",
          completedAt: failedAt,
          error: message,
        });

        const failed = this.deps.queue.getByKey(running.jobKey);
        if (failed) {
          this.jobsByKey.set(failed.jobKey, failed);
          this.emitCompleted(failed, false, "JOB_FAILED");
        }
      }
    } finally {
      this.inFlightByKey.delete(this.concurrencyKey(next));
    }

    return true;
  }

  private selectNextRunnableJob(): Job | undefined {
    const pending = this.deps.queue
      .getAll()
      .filter((job) => job.status === "pending")
      .sort((a, b) => {
        const aPriority = EXECUTION_CLASS_PRIORITY[a.executionClass];
        const bPriority = EXECUTION_CLASS_PRIORITY[b.executionClass];
        if (aPriority !== bPriority) {
          return aPriority - bPriority;
        }
        if (a.createdAt !== b.createdAt) {
          return a.createdAt - b.createdAt;
        }
        return a.jobId.localeCompare(b.jobId);
      });

    for (const candidate of pending) {
      if (this.canRun(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private canRun(job: Job): boolean {
    if (job.kind === "memory.migrate") {
      const key = this.concurrencyKey(job);
      return !this.inFlightByKey.has(key);
    }

    if (job.kind === "memory.organize") {
      let running = 0;
      for (const key of this.inFlightByKey) {
        if (key.startsWith("memory.organize:global")) {
          running += 1;
        }
      }
      return running < CONCURRENCY_CAPS.memory_organize_global;
    }

    if (job.kind === "task.run") {
      const key = this.concurrencyKey(job);
      return !this.inFlightByKey.has(key);
    }

    if (job.kind === "search.rebuild") {
      let running = 0;
      for (const key of this.inFlightByKey) {
        if (key.startsWith("search.rebuild:global")) {
          running += 1;
        }
      }
      return running < CONCURRENCY_CAPS.search_rebuild_global;
    }

    return true;
  }

  private concurrencyKey(job: Job): string {
    if (job.kind === "memory.migrate") {
      const agentId = job.agentId ?? "unknown-agent";
      const sessionId = job.sessionId ?? "unknown-session";
      return `memory.migrate:${agentId}:${sessionId}:${CONCURRENCY_CAPS.memory_migrate_per_agent_session}`;
    }

    if (job.kind === "memory.organize") {
      return "memory.organize:global";
    }

    if (job.kind === "search.rebuild") {
      return "search.rebuild:global";
    }

    const parentRunId =
      this.asRecord(job.payload)?.parentRunId ??
      this.asRecord(job.payload)?.parentJobId ??
      job.idempotencyKey ??
      job.sessionId ??
      "default-parent";
    return `task.run:${String(parentRunId)}:${CONCURRENCY_CAPS.task_run_per_parent}`;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  private emitEnqueued(job: Job): void {
    if (!this.deps.eventBus) {
      return;
    }

    this.deps.eventBus.emit("job.enqueued", {
      jobKey: job.jobKey,
      jobType: job.kind,
      scope: this.extractScope(job.jobKey),
    });
  }

  private emitStarted(job: Job): void {
    if (!this.deps.eventBus) {
      return;
    }

    this.deps.eventBus.emit("job.started", {
      jobKey: job.jobKey,
      jobType: job.kind,
      runId: job.jobId,
    });
  }

  private emitCompleted(job: Job, success: boolean, errorCode?: string): void {
    if (!this.deps.eventBus) {
      return;
    }

    const payload = {
      jobKey: job.jobKey,
      jobType: job.kind,
      runId: job.jobId,
      success,
      errorCode,
    };
    this.deps.eventBus.emit("job.completed", payload);
  }

  private extractScope(jobKey: string): string {
    const parts = jobKey.split(":");
    return parts.length >= 2 ? parts[1] : "global";
  }

  private toRecoveredJob(entry: JobEntry): Job | undefined {
    if (!entry.id || !isJobKind(entry.jobType)) {
      return undefined;
    }

    const payloadRecord = this.asRecord(entry.payload);
    const payload = payloadRecord ?? {};

    const jobKey = this.readString(payload, "jobKey") ?? entry.id;

    const payloadKind = this.readString(payload, "kind");
    const kind: JobKind = isJobKind(payloadKind) ? payloadKind : entry.jobType;

    const payloadExecutionClass = this.readString(payload, "executionClass");
    const executionClass: Job["executionClass"] = isExecutionClass(payloadExecutionClass)
      ? payloadExecutionClass
      : defaultExecutionClass(kind);

    return {
      jobId: this.readString(payload, "jobId") ?? crypto.randomUUID(),
      jobKey,
      kind,
      executionClass,
      sessionId: this.readString(payload, "sessionId") ?? undefined,
      agentId: this.readString(payload, "agentId") ?? undefined,
      idempotencyKey: this.readString(payload, "idempotencyKey") ?? entry.id,
      payload: payloadRecord && "payload" in payloadRecord ? payloadRecord.payload : entry.payload,
      status: "pending",
      attempts: Math.max(0, entry.attemptCount),
      maxAttempts: Math.max(1, entry.maxAttempts),
      retriable: this.readBoolean(payload, "retriable", true),
      createdAt: this.readNumber(payload, "createdAt") ?? entry.createdAt,
      startedAt: undefined,
      completedAt: undefined,
      error: entry.errorMessage,
      ownershipAccepted: false,
    };
  }

  private readString(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    return typeof value === "string" ? value : undefined;
  }

  private readNumber(payload: Record<string, unknown>, key: string): number | undefined {
    const value = payload[key];
    return typeof value === "number" ? value : undefined;
  }

  private readBoolean(payload: Record<string, unknown>, key: string, fallback: boolean): boolean {
    const value = payload[key];
    return typeof value === "boolean" ? value : fallback;
  }
}

function isJobKind(value: string | undefined): value is JobKind {
  return value === "memory.migrate" || value === "memory.organize" || value === "task.run" || value === "search.rebuild";
}

function isExecutionClass(value: string | undefined): value is Job["executionClass"] {
  return (
    value === "interactive.user_turn"
    || value === "interactive.delegated_task"
    || value === "background.memory_migrate"
    || value === "background.memory_organize"
    || value === "background.search_rebuild"
    || value === "background.autonomy"
  );
}

function defaultExecutionClass(kind: JobKind): Job["executionClass"] {
  if (kind === "memory.migrate") {
    return "background.memory_migrate";
  }
  if (kind === "memory.organize") {
    return "background.memory_organize";
  }
  if (kind === "search.rebuild") {
    return "background.search_rebuild";
  }
  return "background.autonomy";
}
