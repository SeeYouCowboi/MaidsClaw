import { Database } from "bun:sqlite";

export type DrainCheckReport = {
  ready: boolean;
  activeCounts: {
    pending: number;
    processing: number;
    retryable: number;
  };
  terminalCounts: {
    exhausted: number;
    reconciled: number;
  };
  totalCount: number;
  message: string;
};

type StatusCountRow = {
  status: string;
  count: number;
};

/**
 * Inspect the legacy SQLite `_memory_maintenance_jobs` table and report
 * whether the necessary precondition for a future producer freeze /
 * traffic-switch has been met.
 *
 * READY means no active (pending / processing / retryable) rows remain.
 * This is a *necessary* precondition only — runtime adoption and cutover
 * remain out of scope.
 */
export async function checkDrainReady(dbPath: string): Promise<DrainCheckReport> {
  const db = new Database(dbPath, { readonly: true });

  try {
    const tableRow = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='_memory_maintenance_jobs'`,
      )
      .get();

    if (!tableRow) {
      return {
        ready: true,
        activeCounts: { pending: 0, processing: 0, retryable: 0 },
        terminalCounts: { exhausted: 0, reconciled: 0 },
        totalCount: 0,
        message:
          "No legacy _memory_maintenance_jobs table found — nothing to drain. " +
          "This is a necessary precondition for future producer freeze / traffic switch, " +
          "but runtime adoption and cutover remain out of scope.",
      };
    }

    const rows = db
      .query<StatusCountRow, []>(
        `SELECT status, CAST(COUNT(*) AS INTEGER) AS count FROM _memory_maintenance_jobs GROUP BY status`,
      )
      .all();

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = row.count;
    }

    const pending = counts["pending"] ?? 0;
    const processing = counts["processing"] ?? 0;
    const retryable = counts["retryable"] ?? 0;
    const exhausted = counts["exhausted"] ?? 0;
    const reconciled = counts["reconciled"] ?? 0;

    const totalActive = pending + processing + retryable;
    const totalCount = totalActive + exhausted + reconciled;

    const ready = totalActive === 0;

    const message = ready
      ? "No active legacy rows found. " +
        "This is a necessary precondition for future producer freeze / traffic switch, " +
        "but runtime adoption and cutover remain out of scope."
      : `NOT READY: ${pending} pending, ${processing} processing, ${retryable} retryable rows require draining before considering cutover.`;

    return {
      ready,
      activeCounts: { pending, processing, retryable },
      terminalCounts: { exhausted, reconciled },
      totalCount,
      message,
    };
  } finally {
    db.close();
  }
}
