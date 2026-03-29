import type { Db } from "../../database.js";
import {
  type SettlementLedgerCheckResult,
  type SettlementLedgerStatus,
  SqliteSettlementLedger,
} from "../../../memory/settlement-ledger.js";
import type {
  SettlementLedgerRecord,
  SettlementLedgerRepo,
} from "../contracts/settlement-ledger-repo.js";

type SettlementLedgerDbRow = {
  settlement_id: string;
  agent_id: string;
  status: SettlementLedgerStatus;
  attempt_count: number;
  max_attempts: number;
  payload_hash: string | null;
  claimed_by: string | null;
  claimed_at: number | null;
  applied_at: number | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
};

export class SqliteSettlementLedgerRepoAdapter implements SettlementLedgerRepo {
  constructor(
    private readonly impl: SqliteSettlementLedger,
    private readonly db?: Db,
  ) {}

  async check(settlementId: string): Promise<SettlementLedgerCheckResult> {
    return Promise.resolve(this.impl.check(settlementId));
  }

  async rawStatus(settlementId: string): Promise<SettlementLedgerStatus | null> {
    return Promise.resolve(this.impl.rawStatus(settlementId));
  }

  async markPending(settlementId: string, agentId: string): Promise<void> {
    return Promise.resolve(this.impl.markPending(settlementId, agentId));
  }

  async markClaimed(settlementId: string, claimedBy: string): Promise<void> {
    return Promise.resolve(this.impl.markClaimed(settlementId, claimedBy));
  }

  async markApplying(settlementId: string, agentId: string, payloadHash?: string): Promise<void> {
    return Promise.resolve(this.impl.markApplying(settlementId, agentId, payloadHash));
  }

  async markApplied(settlementId: string): Promise<void> {
    return Promise.resolve(this.impl.markApplied(settlementId));
  }

  async markReplayedNoop(settlementId: string): Promise<void> {
    return Promise.resolve(this.impl.markReplayedNoop(settlementId));
  }

  async markConflict(settlementId: string, errorMessage: string): Promise<void> {
    return Promise.resolve(this.impl.markConflict(settlementId, errorMessage));
  }

  async markFailedRetryScheduled(settlementId: string, errorMessage: string): Promise<void> {
    return Promise.resolve(this.impl.markFailed(settlementId, errorMessage, true));
  }

  async markFailedTerminal(settlementId: string, errorMessage: string): Promise<void> {
    return Promise.resolve(this.impl.markFailed(settlementId, errorMessage, false));
  }

  async getBySettlementId(settlementId: string): Promise<SettlementLedgerRecord | null> {
    if (!this.db) {
      return Promise.resolve(null);
    }

    const row = this.db.get<SettlementLedgerDbRow>(
      `SELECT settlement_id, agent_id, status, attempt_count, max_attempts, payload_hash,
              claimed_by, claimed_at, applied_at, error_message, created_at, updated_at
       FROM settlement_processing_ledger
       WHERE settlement_id = ?
       LIMIT 1`,
      [settlementId],
    );

    return Promise.resolve(row ? toRecord(row) : null);
  }

  async getByHash(payloadHash: string): Promise<SettlementLedgerRecord | null> {
    if (!this.db) {
      return Promise.resolve(null);
    }

    const row = this.db.get<SettlementLedgerDbRow>(
      `SELECT settlement_id, agent_id, status, attempt_count, max_attempts, payload_hash,
              claimed_by, claimed_at, applied_at, error_message, created_at, updated_at
       FROM settlement_processing_ledger
       WHERE payload_hash = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [payloadHash],
    );

    return Promise.resolve(row ? toRecord(row) : null);
  }
}

function toRecord(row: SettlementLedgerDbRow): SettlementLedgerRecord {
  return {
    settlementId: row.settlement_id,
    agentId: row.agent_id,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    payloadHash: row.payload_hash,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    appliedAt: row.applied_at,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
