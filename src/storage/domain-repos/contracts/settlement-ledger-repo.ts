import type {
  SettlementLedgerCheckResult,
  SettlementLedgerStatus,
} from "../../../memory/settlement-ledger.js";

export type SettlementLedgerRecord = {
  settlementId: string;
  agentId: string;
  status: SettlementLedgerStatus;
  attemptCount: number;
  maxAttempts: number;
  payloadHash: string | null;
  claimedBy: string | null;
  claimedAt: number | null;
  appliedAt: number | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

export interface SettlementLedgerRepo {
  check(settlementId: string): Promise<SettlementLedgerCheckResult>;
  rawStatus(settlementId: string): Promise<SettlementLedgerStatus | null>;
  markPending(settlementId: string, agentId: string): Promise<void>;
  markClaimed(settlementId: string, claimedBy: string): Promise<void>;
  markApplying(settlementId: string, agentId: string, payloadHash?: string): Promise<void>;
  markApplied(settlementId: string): Promise<void>;
  markReplayedNoop(settlementId: string): Promise<void>;
  markConflict(settlementId: string, errorMessage: string): Promise<void>;
  markFailedRetryScheduled(settlementId: string, errorMessage: string): Promise<void>;
  markFailedTerminal(settlementId: string, errorMessage: string): Promise<void>;
  getBySettlementId(settlementId: string): Promise<SettlementLedgerRecord | null>;
  getByHash(payloadHash: string): Promise<SettlementLedgerRecord | null>;
}
