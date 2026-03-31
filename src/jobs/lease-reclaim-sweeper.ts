import type { DurableJobStore } from "./durable-store.js";

const DEFAULT_INTERVAL_MS = 60_000;

export class LeaseReclaimSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: DurableJobStore,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.store.reclaimExpiredLeases(Date.now()).catch((error) => {
        console.error("[LeaseReclaimSweeper] reclaim failed", error);
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
}
