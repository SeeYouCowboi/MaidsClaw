import type { JobDispatcher } from "./dispatcher.js";
import type { Job } from "./types.js";

type SubmitSpec = Omit<Job, "jobId" | "status" | "attempts" | "createdAt" | "ownershipAccepted">;

export class JobScheduler {
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private tickInFlight = false;

  constructor(private readonly deps: { dispatcher: JobDispatcher; intervalMs?: number }) {
    this.intervalMs = deps.intervalMs ?? 25;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      if (this.tickInFlight) {
        return;
      }

      this.tickInFlight = true;
      this.deps.dispatcher
        .processNext()
        .catch(() => {
          return undefined;
        })
        .finally(() => {
          this.tickInFlight = false;
        });
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  submit(spec: SubmitSpec): Job | null {
    return this.deps.dispatcher.submit(spec);
  }
}
