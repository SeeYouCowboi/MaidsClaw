type DbLike = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
};

export type SettlementLedgerStatus =
  | "pending"
  | "claimed"
  | "applying"
  | "applied"
  | "replayed_noop"
  | "conflict"
  | "failed_retryable"
  | "failed_terminal";

export type SettlementLedgerCheckResult = "pending" | "applied" | "not_found" | "failed";

export interface SettlementLedger {
  check(settlementId: string): SettlementLedgerCheckResult;
  rawStatus(settlementId: string): SettlementLedgerStatus | null;
  markPending(settlementId: string, agentId: string): void;
  markClaimed(settlementId: string, claimedBy: string): void;
  markApplying(settlementId: string, agentId: string, payloadHash?: string): void;
  markApplied(settlementId: string): void;
  markReplayedNoop(settlementId: string): void;
  markConflict(settlementId: string, errorMessage: string): void;
  markFailed(settlementId: string, errorMessage: string, retryable: boolean): void;
}

type LedgerStatusRow = {
  status: string;
};

type LedgerIdentityRow = {
  agent_id: string;
};

export class SqliteSettlementLedger implements SettlementLedger {
  constructor(
    private readonly db: DbLike,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  check(settlementId: string): SettlementLedgerCheckResult {
    const status = this.rawStatus(settlementId);
    if (!status) {
      return "not_found";
    }

    if (status === "applied" || status === "replayed_noop") {
      return "applied";
    }

    if (status === "failed_terminal" || status === "conflict") {
      return "failed";
    }

    return "pending";
  }

  rawStatus(settlementId: string): SettlementLedgerStatus | null {
    const row = this.db
      .prepare("SELECT status FROM settlement_processing_ledger WHERE settlement_id = ? LIMIT 1")
      .get(settlementId) as LedgerStatusRow | null;

    if (!row) {
      return null;
    }

    return isSettlementLedgerStatus(row.status) ? row.status : null;
  }

  markPending(settlementId: string, agentId: string): void {
    const now = this.clock();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO settlement_processing_ledger
         (settlement_id, agent_id, status, attempt_count, max_attempts, created_at, updated_at)
         VALUES (?, ?, 'pending', 0, 4, ?, ?)`,
      )
      .run(settlementId, agentId, now, now);
  }

  markClaimed(settlementId: string, claimedBy: string): void {
    const now = this.clock();
    this.db
      .prepare(
        `UPDATE settlement_processing_ledger
         SET status = 'claimed',
             claimed_by = ?,
             claimed_at = ?,
             error_message = NULL,
             updated_at = ?
         WHERE settlement_id = ?`,
      )
      .run(claimedBy, now, now, settlementId);
  }

  markApplying(settlementId: string, agentId: string, payloadHash?: string): void {
    const now = this.clock();
    const payload = payloadHash ?? null;

    const updated = this.db
      .prepare(
        `UPDATE settlement_processing_ledger
         SET status = 'applying',
             agent_id = ?,
             payload_hash = COALESCE(payload_hash, ?),
             attempt_count = attempt_count + 1,
             claimed_by = ?,
             claimed_at = ?,
             error_message = NULL,
             updated_at = ?
         WHERE settlement_id = ?
           AND status IN ('pending', 'failed_retryable')`,
      )
      .run(agentId, payload, agentId, now, now, settlementId);

    if (updated.changes > 0) {
      return;
    }

    this.db
      .prepare(
        `INSERT OR IGNORE INTO settlement_processing_ledger
         (settlement_id, agent_id, payload_hash, status, attempt_count, max_attempts, claimed_by, claimed_at, created_at, updated_at)
         VALUES (?, ?, ?, 'applying', 1, 4, ?, ?, ?, ?)`,
      )
      .run(settlementId, agentId, payload, agentId, now, now, now);
  }

  markApplied(settlementId: string): void {
    const now = this.clock();

    this.db
      .prepare(
        `UPDATE settlement_processing_ledger
         SET status = 'applied',
             applied_at = ?,
             error_message = NULL,
             updated_at = ?
         WHERE settlement_id = ?`,
      )
      .run(now, now, settlementId);
  }

  markReplayedNoop(settlementId: string): void {
    const now = this.clock();
    this.db
      .prepare(
        `UPDATE settlement_processing_ledger
         SET status = 'replayed_noop',
             error_message = NULL,
             updated_at = ?
         WHERE settlement_id = ?`,
      )
      .run(now, settlementId);
  }

  markConflict(settlementId: string, errorMessage: string): void {
    const now = this.clock();
    this.db
      .prepare(
        `UPDATE settlement_processing_ledger
         SET status = 'conflict',
             error_message = ?,
             updated_at = ?
         WHERE settlement_id = ?`,
      )
      .run(errorMessage, now, settlementId);
  }

  markFailed(settlementId: string, errorMessage: string, retryable: boolean): void {
    const now = this.clock();
    const nextStatus = retryable ? "failed_retryable" : "failed_terminal";
    const existing = this.db
      .prepare("SELECT agent_id FROM settlement_processing_ledger WHERE settlement_id = ? LIMIT 1")
      .get(settlementId) as LedgerIdentityRow | null;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO settlement_processing_ledger
           (settlement_id, agent_id, status, attempt_count, max_attempts, error_message, created_at, updated_at)
           VALUES (?, ?, ?, 1, 4, ?, ?, ?)`,
        )
        .run(settlementId, "unknown", nextStatus, errorMessage, now, now);
      return;
    }

    this.db
      .prepare(
        `UPDATE settlement_processing_ledger
         SET status = ?,
             error_message = ?,
             updated_at = ?
         WHERE settlement_id = ?`,
      )
      .run(nextStatus, errorMessage, now, settlementId);
  }
}

function isSettlementLedgerStatus(status: string): status is SettlementLedgerStatus {
  return status === "pending"
    || status === "claimed"
    || status === "applying"
    || status === "applied"
    || status === "replayed_noop"
    || status === "conflict"
    || status === "failed_retryable"
    || status === "failed_terminal";
}
