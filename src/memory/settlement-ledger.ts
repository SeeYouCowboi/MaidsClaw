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
