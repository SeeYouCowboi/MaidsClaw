import { InteractionStore } from "../../../interaction/store.js";
import type { RecentCognitionSlotRepo } from "../contracts/recent-cognition-slot-repo.js";

export class SqliteRecentCognitionSlotRepoAdapter implements RecentCognitionSlotRepo {
  constructor(private readonly impl: InteractionStore) {}

  async upsertRecentCognitionSlot(
    sessionId: string,
    agentId: string,
    settlementId: string,
    newEntriesJson = "[]",
  ): Promise<void> {
    return Promise.resolve(this.impl.upsertRecentCognitionSlot(sessionId, agentId, settlementId, newEntriesJson));
  }
}
