import { InteractionStore } from "../../../interaction/store.js";
import type { Db } from "../../database.js";
import type { RecentCognitionSlotRepo } from "../contracts/recent-cognition-slot-repo.js";

export class SqliteRecentCognitionSlotRepoAdapter implements RecentCognitionSlotRepo {
  constructor(
    private readonly impl: InteractionStore,
    private readonly db: Db,
  ) {}

  async upsertRecentCognitionSlot(
    sessionId: string,
    agentId: string,
    settlementId: string,
    newEntriesJson = "[]",
  ): Promise<void> {
    return Promise.resolve(this.impl.upsertRecentCognitionSlot(sessionId, agentId, settlementId, newEntriesJson));
  }

  async getSlotPayload(sessionId: string, agentId: string): Promise<string | undefined> {
    const row = this.db.get<{ slot_payload: string }>(
      `SELECT slot_payload FROM recent_cognition_slots WHERE session_id = ? AND agent_id = ?`,
      [sessionId, agentId],
    );
    return Promise.resolve(row?.slot_payload);
  }
}
