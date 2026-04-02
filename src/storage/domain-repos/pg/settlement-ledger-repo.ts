import type postgres from "postgres";
import type {
  SettlementLedgerRepo,
  SettlementLedgerRecord,
} from "../contracts/settlement-ledger-repo.js";
import type {
  SettlementLedgerCheckResult,
  SettlementLedgerStatus,
} from "../../../memory/settlement-ledger.js";

const VALID_STATUSES: ReadonlySet<string> = new Set<SettlementLedgerStatus>([
  "pending",
  "claimed",
  "applying",
  "applied",
  "replayed_noop",
  "conflict",
  "failed_retryable",
  "failed_terminal",
]);

function isSettlementLedgerStatus(s: string): s is SettlementLedgerStatus {
  return VALID_STATUSES.has(s);
}

type LedgerRow = {
  settlement_id: string;
  agent_id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  payload_hash: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  applied_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

function rowToRecord(row: LedgerRow): SettlementLedgerRecord {
  return {
    settlementId: row.settlement_id,
    agentId: row.agent_id,
    status: (isSettlementLedgerStatus(row.status) ? row.status : "pending") as SettlementLedgerStatus,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    payloadHash: row.payload_hash,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at != null ? Number(row.claimed_at) : null,
    appliedAt: row.applied_at != null ? Number(row.applied_at) : null,
    errorMessage: row.error_message,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class PgSettlementLedgerRepo implements SettlementLedgerRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async check(settlementId: string): Promise<SettlementLedgerCheckResult> {
    const status = await this.rawStatus(settlementId);
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

  async rawStatus(settlementId: string): Promise<SettlementLedgerStatus | null> {
    const rows = await this.sql`
      SELECT status
      FROM settlement_processing_ledger
      WHERE settlement_id = ${settlementId}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return null;
    }
    const s = String(rows[0].status);
    return isSettlementLedgerStatus(s) ? s : null;
  }

  async markPending(settlementId: string, agentId: string): Promise<void> {
    const now = Date.now();
    await this.sql`
      INSERT INTO settlement_processing_ledger
        (settlement_id, agent_id, status, attempt_count, max_attempts, created_at, updated_at)
      VALUES
        (${settlementId}, ${agentId}, 'pending', 0, 4, ${now}, ${now})
      ON CONFLICT (settlement_id) DO NOTHING
    `;
  }

  async markClaimed(settlementId: string, claimedBy: string): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE settlement_processing_ledger
      SET status        = 'claimed',
          claimed_by    = ${claimedBy},
          claimed_at    = ${now},
          error_message = NULL,
          updated_at    = ${now}
      WHERE settlement_id = ${settlementId}
    `;
  }

  async markApplying(
    settlementId: string,
    agentId: string,
    payloadHash?: string,
  ): Promise<void> {
    const now = Date.now();
    const payload = payloadHash ?? null;

    const updated = await this.sql`
      UPDATE settlement_processing_ledger
      SET status        = 'applying',
          agent_id      = ${agentId},
          payload_hash  = COALESCE(payload_hash, ${payload}),
          attempt_count = attempt_count + 1,
          claimed_by    = ${agentId},
          claimed_at    = ${now},
          error_message = NULL,
          updated_at    = ${now}
      WHERE settlement_id = ${settlementId}
        AND status IN ('pending', 'failed_retryable')
    `;

    if (updated.count > 0) {
      return;
    }

    await this.sql`
      INSERT INTO settlement_processing_ledger
        (settlement_id, agent_id, payload_hash, status, attempt_count, max_attempts,
         claimed_by, claimed_at, created_at, updated_at)
      VALUES
        (${settlementId}, ${agentId}, ${payload}, 'applying', 1, 4,
         ${agentId}, ${now}, ${now}, ${now})
      ON CONFLICT (settlement_id) DO NOTHING
    `;
  }

  async markApplied(settlementId: string): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE settlement_processing_ledger
      SET status        = 'applied',
          applied_at    = ${now},
          error_message = NULL,
          updated_at    = ${now}
      WHERE settlement_id = ${settlementId}
    `;
  }

  async markReplayedNoop(settlementId: string): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE settlement_processing_ledger
      SET status        = 'replayed_noop',
          error_message = NULL,
          updated_at    = ${now}
      WHERE settlement_id = ${settlementId}
    `;
  }

  async markConflict(settlementId: string, errorMessage: string): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE settlement_processing_ledger
      SET status        = 'conflict',
          error_message = ${errorMessage},
          updated_at    = ${now}
      WHERE settlement_id = ${settlementId}
    `;
  }

  async markFailedRetryScheduled(
    settlementId: string,
    errorMessage: string,
  ): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE settlement_processing_ledger
      SET status        = 'failed_retryable',
          error_message = ${errorMessage},
          updated_at    = ${now}
      WHERE settlement_id = ${settlementId}
    `;
  }

  async markFailedTerminal(
    settlementId: string,
    errorMessage: string,
  ): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE settlement_processing_ledger
      SET status        = 'failed_terminal',
          error_message = ${errorMessage},
          updated_at    = ${now}
      WHERE settlement_id = ${settlementId}
    `;
  }

  async getBySettlementId(settlementId: string): Promise<SettlementLedgerRecord | null> {
    const rows = await this.sql<LedgerRow[]>`
      SELECT settlement_id, agent_id, status, attempt_count, max_attempts,
             payload_hash, claimed_by, claimed_at, applied_at, error_message,
             created_at, updated_at
      FROM settlement_processing_ledger
      WHERE settlement_id = ${settlementId}
      LIMIT 1
    `;
    return rows.length > 0 ? rowToRecord(rows[0]) : null;
  }

  async getByHash(payloadHash: string): Promise<SettlementLedgerRecord | null> {
    const rows = await this.sql<LedgerRow[]>`
      SELECT settlement_id, agent_id, status, attempt_count, max_attempts,
             payload_hash, claimed_by, claimed_at, applied_at, error_message,
             created_at, updated_at
      FROM settlement_processing_ledger
      WHERE payload_hash = ${payloadHash}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows.length > 0 ? rowToRecord(rows[0]) : null;
  }
}
