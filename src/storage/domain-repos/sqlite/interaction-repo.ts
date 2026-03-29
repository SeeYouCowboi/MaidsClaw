import {
  InteractionStore,
  type GetBySessionOptions,
} from "../../../interaction/store.js";
import type { InteractionRecord, TurnSettlementPayload } from "../../../interaction/contracts.js";
import type {
  InteractionRepo,
  InteractionTransactionContext,
} from "../contracts/interaction-repo.js";

export class SqliteInteractionRepoAdapter implements InteractionRepo {
  constructor(private readonly impl: InteractionStore) {}

  async commit(record: InteractionRecord): Promise<void> {
    return Promise.resolve(this.impl.commit(record));
  }

  async runInTransaction<T>(fn: (tx: InteractionTransactionContext) => Promise<T>): Promise<T> {
    return Promise.resolve(
      this.impl.runInTransaction(() => fn({ interactionRepo: this })),
    ).then((result) => result);
  }

  async settlementExists(sessionId: string, settlementId: string): Promise<boolean> {
    return Promise.resolve(this.impl.settlementExists(sessionId, settlementId));
  }

  async findRecordByCorrelatedTurnId(
    sessionId: string,
    correlatedTurnId: string,
    actorType: string,
  ): Promise<InteractionRecord | undefined> {
    return Promise.resolve(this.impl.findRecordByCorrelatedTurnId(sessionId, correlatedTurnId, actorType));
  }

  async findSessionIdByRequestId(requestId: string): Promise<string | undefined> {
    return Promise.resolve(this.impl.findSessionIdByRequestId(requestId));
  }

  async getSettlementPayload(sessionId: string, requestId: string): Promise<TurnSettlementPayload | undefined> {
    return Promise.resolve(this.impl.getSettlementPayload(sessionId, requestId));
  }

  async getMessageRecords(sessionId: string): Promise<InteractionRecord[]> {
    return Promise.resolve(this.impl.getMessageRecords(sessionId));
  }

  async getBySession(sessionId: string, options?: GetBySessionOptions): Promise<InteractionRecord[]> {
    return Promise.resolve(this.impl.getBySession(sessionId, options));
  }

  async getByRange(sessionId: string, rangeStart: number, rangeEnd: number): Promise<InteractionRecord[]> {
    return Promise.resolve(this.impl.getByRange(sessionId, rangeStart, rangeEnd));
  }

  async markProcessed(sessionId: string, upToIndex: number): Promise<void> {
    return Promise.resolve(this.impl.markProcessed(sessionId, upToIndex));
  }

  async markRangeProcessed(sessionId: string, rangeStart: number, rangeEnd: number): Promise<void> {
    return Promise.resolve(this.impl.markRangeProcessed(sessionId, rangeStart, rangeEnd));
  }

  async countUnprocessedRpTurns(sessionId: string): Promise<number> {
    return Promise.resolve(this.impl.countUnprocessedRpTurns(sessionId));
  }

  async getMinMaxUnprocessedIndex(sessionId: string): Promise<{ min: number; max: number } | undefined> {
    return Promise.resolve(this.impl.getMinMaxUnprocessedIndex(sessionId));
  }

  async getMaxIndex(sessionId: string): Promise<number | undefined> {
    return Promise.resolve(this.impl.getMaxIndex(sessionId));
  }

  async getPendingSettlementJobState(sessionId: string): Promise<{
    status?: string;
    failure_count?: number;
    next_attempt_at?: number | null;
    last_error_code?: string | null;
    last_error_message?: string | null;
  } | null> {
    return Promise.resolve(this.impl.getPendingSettlementJobState(sessionId));
  }

  async countUnprocessedSettlements(sessionId: string): Promise<number> {
    return Promise.resolve(this.impl.countUnprocessedSettlements(sessionId));
  }

  async getUnprocessedSettlementRange(sessionId: string): Promise<{ min: number; max: number } | null> {
    return Promise.resolve(this.impl.getUnprocessedSettlementRange(sessionId));
  }

  async listStalePendingSettlementSessions(
    staleCutoffMs: number,
  ): Promise<Array<{ sessionId: string; agentId: string; oldestSettlementAt: number }>> {
    return Promise.resolve(this.impl.listStalePendingSettlementSessions(staleCutoffMs));
  }

  async getUnprocessedRangeForSession(sessionId: string): Promise<{ rangeStart: number; rangeEnd: number } | null> {
    return Promise.resolve(this.impl.getUnprocessedRangeForSession(sessionId));
  }
}
