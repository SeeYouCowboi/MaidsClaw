import type { PgJobCurrentRow } from "./durable-store.js";
import type { PgJobStore } from "./pg-store.js";

export type PgWorkerFn = (job: PgJobCurrentRow) => Promise<unknown>;

/**
 * Lightweight, non-bootstrap PG job runner harness.
 *
 * Designed for local/test verification of the durable job pipeline.
 * Uses `PgJobStore` as the single source of truth — no in-memory queue.
 * NOT wired into `src/bootstrap/runtime.ts`.
 */
export class PgJobRunner {
  private readonly workers = new Map<string, PgWorkerFn>();

  constructor(
    private readonly store: PgJobStore,
    private readonly options: { workerId: string; leaseDurationMs: number },
  ) {}

  registerWorker(jobType: string, fn: PgWorkerFn): void {
    this.workers.set(jobType, fn);
  }

  async processNext(): Promise<"processed" | "none_ready"> {
    const nowMs = Date.now();
    const result = await this.store.claimNext({
      worker_id: this.options.workerId,
      now_ms: nowMs,
      lease_duration_ms: this.options.leaseDurationMs,
    });

    if (result.outcome === "none_ready") return "none_ready";

    const { job } = result;
    const worker = this.workers.get(job.job_type);

    if (!worker) {
      await this.store.fail(job.job_key, job.claim_version, {
        now_ms: Date.now(),
        error_message: `No worker registered for job type: ${job.job_type}`,
      });
      return "processed";
    }

    try {
      const resultJson = await worker(job);
      await this.store.complete(job.job_key, job.claim_version, resultJson);
    } catch (err) {
      await this.store.fail(job.job_key, job.claim_version, {
        now_ms: Date.now(),
        error_message: err instanceof Error ? err.message : String(err),
      });
    }
    return "processed";
  }
}
