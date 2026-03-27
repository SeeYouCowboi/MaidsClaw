import type { Database } from "bun:sqlite";

export type SettlementLedgerCheckResult = "pending" | "applied" | "not_found" | "failed";

export interface SettlementLedger {
  check(settlementId: string): SettlementLedgerCheckResult;
  markApplying(settlementId: string, agentId: string, payloadHash?: string): void;
  markApplied(settlementId: string): void;
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
    private readonly db: Database,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  check(settlementId: string): SettlementLedgerCheckResult {
    const row = this.db
      .prepare("SELECT status FROM settlement_processing_ledger WHERE settlement_id = ? LIMIT 1")
      .get(settlementId) as LedgerStatusRow | null;

    if (!row) {
      return "not_found";
    }

    if (row.status === "applied" || row.status === "replayed_noop") {
      return "applied";
    }

    if (row.status === "failed_terminal" || row.status === "conflict") {
      return "failed";
    }

    return "pending";
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
