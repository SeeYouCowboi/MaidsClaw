import type { Job, JobKey } from "./types.js";

export type DedupAction = "accept" | "coalesce" | "drop" | "noop";

export class JobDedupEngine {
  checkDuplicate(jobs: Map<JobKey, Job>, incomingJobKey: JobKey): DedupAction {
    const existing = jobs.get(incomingJobKey);
    if (!existing) {
      return "accept";
    }

    if (existing.status === "pending") {
      return "coalesce";
    }

    if (existing.status === "running") {
      return "drop";
    }

    return "noop";
  }
}
