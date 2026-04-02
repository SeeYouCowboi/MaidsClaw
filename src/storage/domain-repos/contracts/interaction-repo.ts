import type { InteractionRecord, TurnSettlementPayload } from "../../../interaction/contracts.js";

export type InteractionTransactionContext = {
  interactionRepo: InteractionRepo;
};

export interface InteractionRepo {
  commit(record: InteractionRecord): Promise<void>;
  runInTransaction<T>(fn: (tx: InteractionTransactionContext) => Promise<T>): Promise<T>;
  settlementExists(sessionId: string, settlementId: string): Promise<boolean>;
  findRecordByCorrelatedTurnId(
    sessionId: string,
    correlatedTurnId: string,
    actorType: string,
  ): Promise<InteractionRecord | undefined>;
  findSessionIdByRequestId(requestId: string): Promise<string | undefined>;
  getSettlementPayload(sessionId: string, requestId: string): Promise<TurnSettlementPayload | undefined>;
  getMessageRecords(sessionId: string): Promise<InteractionRecord[]>;
  getBySession(
    sessionId: string,
    options?: {
      fromIndex?: number;
      toIndex?: number;
      limit?: number;
    },
  ): Promise<InteractionRecord[]>;
  getByRange(sessionId: string, rangeStart: number, rangeEnd: number): Promise<InteractionRecord[]>;
  markProcessed(sessionId: string, upToIndex: number): Promise<void>;
  markRangeProcessed(sessionId: string, rangeStart: number, rangeEnd: number): Promise<void>;
  countUnprocessedRpTurns(sessionId: string): Promise<number>;
  getMinMaxUnprocessedIndex(sessionId: string): Promise<{ min: number; max: number } | undefined>;
  getMaxIndex(sessionId: string): Promise<number | undefined>;
  getPendingSettlementJobState(sessionId: string): Promise<{
    status?: string;
    failure_count?: number;
    next_attempt_at?: number | null;
    last_error_code?: string | null;
    last_error_message?: string | null;
  } | null>;
  countUnprocessedSettlements(sessionId: string): Promise<number>;
  getUnprocessedSettlementRange(sessionId: string): Promise<{ min: number; max: number } | null>;
  listStalePendingSettlementSessions(
    staleCutoffMs: number,
  ): Promise<Array<{ sessionId: string; agentId: string; oldestSettlementAt: number }>>;
  getUnprocessedRangeForSession(sessionId: string): Promise<{ rangeStart: number; rangeEnd: number } | null>;
}
