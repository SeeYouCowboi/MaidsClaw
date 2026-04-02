/**
 * @classification: prompt_cache
 * Canonical source is private_cognition_events (append-only ledger).
 * This repo manages a denormalized prompt convenience cache (session-scoped,
 * trimmed to 64 entries). Can be rebuilt from ledger if lost.
 * No dedicated rebuild path exists — adding one is a V3.1+ candidate
 * (see §14.3 in MEMORY_V3_REMAINING_GAPS_2026-04-01.zh-CN.md).
 */
export interface RecentCognitionSlotRepo {
  upsertRecentCognitionSlot(
    sessionId: string,
    agentId: string,
    settlementId: string,
    newEntriesJson?: string,
  ): Promise<void>;

  getSlotPayload(sessionId: string, agentId: string): Promise<string | undefined>;
}
