import type { PgJobAttemptHistoryRow, PgJobCurrentRow, PgStatusCount } from "./durable-store.js";
import type { PgJobStore } from "./pg-store.js";

export type PgJobsInspectReport = {
  countsByStatus: PgStatusCount;
  activeRows: PgJobCurrentRow[];
  expiredLeaseRows: PgJobCurrentRow[];
};

export async function inspectPgJobs(store: PgJobStore, nowMs?: number): Promise<PgJobsInspectReport> {
  const effectiveNow = nowMs ?? Date.now();

  const [countsByStatus, activeRows, expiredLeaseRows] = await Promise.all([
    store.countByStatus(),
    store.listActive(),
    store.listExpiredLeases(effectiveNow),
  ]);

  return {
    countsByStatus,
    activeRows,
    expiredLeaseRows,
  };
}

export async function inspectJobHistory(
  store: PgJobStore,
  jobKey: string,
): Promise<PgJobAttemptHistoryRow[]> {
  return store.getHistory(jobKey);
}
