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

export type ForceDrainResult = {
  updatedPending: number;
  updatedProcessing: number;
  updatedRetryable: number;
  totalUpdated: number;
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

/**
 * Force-drain all active (pending / processing / retryable) rows in the
 * legacy SQLite `_memory_maintenance_jobs` table by updating their status
 * to "exhausted". This does NOT delete any rows — it only transitions
 * their status so they are no longer considered active.
 *
 * Returns a summary of how many rows were updated per original status.
 */
export async function forceDrain(dbPath: string): Promise<ForceDrainResult> {
  const db = new Database(dbPath);

  try {
    const tableRow = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='_memory_maintenance_jobs'`,
      )
      .get();

    if (!tableRow) {
      return { updatedPending: 0, updatedProcessing: 0, updatedRetryable: 0, totalUpdated: 0 };
    }

    const countPending = db
      .query<{ count: number }, []>(
        `SELECT CAST(COUNT(*) AS INTEGER) AS count FROM _memory_maintenance_jobs WHERE status = 'pending'`,
      )
      .get();
    const countProcessing = db
      .query<{ count: number }, []>(
        `SELECT CAST(COUNT(*) AS INTEGER) AS count FROM _memory_maintenance_jobs WHERE status = 'processing'`,
      )
      .get();
    const countRetryable = db
      .query<{ count: number }, []>(
        `SELECT CAST(COUNT(*) AS INTEGER) AS count FROM _memory_maintenance_jobs WHERE status = 'retryable'`,
      )
      .get();

    const updatedPending = countPending?.count ?? 0;
    const updatedProcessing = countProcessing?.count ?? 0;
    const updatedRetryable = countRetryable?.count ?? 0;

    db.run(
      `UPDATE _memory_maintenance_jobs SET status = 'exhausted', updated_at = ? WHERE status IN ('pending', 'processing', 'retryable')`,
      [Date.now()],
    );

    return {
      updatedPending,
      updatedProcessing,
      updatedRetryable,
      totalUpdated: updatedPending + updatedProcessing + updatedRetryable,
    };
  } finally {
    db.close();
  }
}
