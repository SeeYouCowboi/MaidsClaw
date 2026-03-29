export interface RecentCognitionSlotRepo {
  upsertRecentCognitionSlot(
    sessionId: string,
    agentId: string,
    settlementId: string,
    newEntriesJson?: string,
  ): Promise<void>;

  getSlotPayload(sessionId: string, agentId: string): Promise<string | undefined>;
}
