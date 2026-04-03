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
  check(settlementId: string): Promise<SettlementLedgerCheckResult>;
  rawStatus(settlementId: string): Promise<SettlementLedgerStatus | null>;
  markPending(settlementId: string, agentId: string): Promise<void>;
  markClaimed(settlementId: string, claimedBy: string): Promise<void>;
  markApplying(settlementId: string, agentId: string, payloadHash?: string): Promise<void>;
  markApplied(settlementId: string): Promise<void>;
  markReplayedNoop(settlementId: string): Promise<void>;
  markConflict(settlementId: string, errorMessage: string): Promise<void>;
  markFailed(settlementId: string, errorMessage: string, retryable: boolean): Promise<void>;
}
