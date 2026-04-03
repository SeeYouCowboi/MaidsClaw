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
    versionIncrement?: 'talker' | 'thinker',
  ): Promise<{ talkerTurnCounter?: number; thinkerCommittedVersion?: number }>;

  getSlotPayload(sessionId: string, agentId: string): Promise<string | undefined>;

  getBySession(
    sessionId: string,
    agentId: string,
  ): Promise<
    | {
        lastSettlementId: string | null;
        slotPayload: unknown[];
        updatedAt: number;
        talkerTurnCounter: number;
        thinkerCommittedVersion: number;
      }
    | undefined
  >;

  getVersionGap(
    sessionId: string,
    agentId: string,
  ): Promise<{ talkerCounter: number; thinkerVersion: number; gap: number } | undefined>;
}
