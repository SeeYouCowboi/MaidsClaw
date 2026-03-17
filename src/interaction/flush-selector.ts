import type { MemoryFlushRequest } from "../core/types.js";
import type { InteractionStore } from "./store.js";

const FLUSH_THRESHOLD = 10;

export class FlushSelector {
  private readonly store: InteractionStore;

  constructor(store: InteractionStore) {
    this.store = store;
  }

  shouldFlush(sessionId: string, agentId: string): MemoryFlushRequest | null {
    // Settlement-aware flush detection with legacy fallback:
    // ANY unprocessed settlements → use settlement count (captures silent-private turns).
    // ZERO settlements → fall back to RP message count for legacy/hybrid sessions.
    const settlementCount = this.store.countUnprocessedSettlements(sessionId);
    const count = settlementCount > 0
      ? settlementCount
      : this.store.countUnprocessedRpTurns(sessionId);

    if (count < FLUSH_THRESHOLD) {
      return null;
    }

    const range = this.store.getMinMaxUnprocessedIndex(sessionId);
    if (range === undefined) {
      return null;
    }

    return {
      sessionId,
      agentId,
      rangeStart: range.min,
      rangeEnd: range.max,
      flushMode: "dialogue_slice",
      idempotencyKey: `memory.migrate:${sessionId}:${range.min}-${range.max}`,
    };
  }

  buildSessionCloseFlush(sessionId: string, agentId: string): MemoryFlushRequest | null {
    const range = this.store.getMinMaxUnprocessedIndex(sessionId);
    if (range === undefined) {
      return null;
    }

    return {
      sessionId,
      agentId,
      rangeStart: range.min,
      rangeEnd: range.max,
      flushMode: "session_close",
      idempotencyKey: `memory.migrate:${sessionId}:${range.min}-${range.max}`,
    };
  }
}
