import type postgres from "postgres";
import type { RecentCognitionSlotRepo } from "../contracts/recent-cognition-slot-repo.js";

export class PgRecentCognitionSlotRepo implements RecentCognitionSlotRepo {
  private readonly sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  async upsertRecentCognitionSlot(
    sessionId: string,
    agentId: string,
    settlementId: string,
    newEntriesJson: string = "[]",
  ): Promise<void> {
    const rows = await this.sql`
      SELECT slot_payload FROM recent_cognition_slots
      WHERE session_id = ${sessionId} AND agent_id = ${agentId}
    `;

    let entries: unknown[];
    if (rows.length > 0) {
      const existing = rows[0].slot_payload;
      entries = Array.isArray(existing) ? existing : [];
    } else {
      entries = [];
    }

    let newEntries: unknown[];
    try {
      newEntries = JSON.parse(newEntriesJson);
      if (!Array.isArray(newEntries)) newEntries = [];
    } catch {
      newEntries = [];
    }

    entries = entries.concat(newEntries);

    if (entries.length > 64) {
      entries = entries.slice(entries.length - 64);
    }

    const now = Date.now();
    const payloadJson = JSON.stringify(entries);
    await this.sql`
      INSERT INTO recent_cognition_slots (session_id, agent_id, last_settlement_id, slot_payload, updated_at)
      VALUES (${sessionId}, ${agentId}, ${settlementId}, ${payloadJson}::jsonb, ${now})
      ON CONFLICT (session_id, agent_id)
      DO UPDATE SET
        last_settlement_id = ${settlementId},
        slot_payload = ${payloadJson}::jsonb,
        updated_at = ${now}
    `;
  }

  async getBySession(
    sessionId: string,
    agentId: string,
  ): Promise<
    | { lastSettlementId: string | null; slotPayload: unknown[]; updatedAt: number }
    | undefined
  > {
    const rows = await this.sql`
      SELECT last_settlement_id, slot_payload, updated_at
      FROM recent_cognition_slots
      WHERE session_id = ${sessionId} AND agent_id = ${agentId}
    `;
    if (rows.length === 0) return undefined;
    const row = rows[0];
    const payload = row.slot_payload;
    return {
      lastSettlementId: (row.last_settlement_id as string) ?? null,
      slotPayload: Array.isArray(payload) ? payload : [],
      updatedAt: Number(row.updated_at),
    };
  }

  async getSlotPayload(sessionId: string, agentId: string): Promise<string | undefined> {
    const rows = await this.sql`
      SELECT slot_payload FROM recent_cognition_slots
      WHERE session_id = ${sessionId} AND agent_id = ${agentId}
    `;
    if (rows.length === 0) return undefined;
    const payload = rows[0].slot_payload;
    return typeof payload === "string" ? payload : JSON.stringify(payload);
  }

  async deleteBySession(sessionId: string): Promise<void> {
    await this.sql`
      DELETE FROM recent_cognition_slots WHERE session_id = ${sessionId}
    `;
  }
}
