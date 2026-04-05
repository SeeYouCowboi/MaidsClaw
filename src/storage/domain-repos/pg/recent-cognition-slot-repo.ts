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
    versionIncrement?: 'talker' | 'thinker',
    setThinkerVersion?: number,
  ): Promise<{ talkerTurnCounter?: number; thinkerCommittedVersion?: number }> {
    const now = Date.now();

    if (versionIncrement !== undefined && setThinkerVersion !== undefined) {
      throw new Error('Cannot provide both versionIncrement and setThinkerVersion simultaneously');
    }

    // Talker path: increment counter only, no payload change
    if (versionIncrement === 'talker') {
      const result = await this.sql`
        INSERT INTO recent_cognition_slots (
          session_id, agent_id, last_settlement_id, updated_at, talker_turn_counter, thinker_committed_version
        )
        VALUES (
          ${sessionId}, ${agentId}, ${settlementId}, ${now}, 1, 0
        )
        ON CONFLICT (session_id, agent_id)
        DO UPDATE SET
          last_settlement_id = ${settlementId},
          updated_at = ${now},
          talker_turn_counter = recent_cognition_slots.talker_turn_counter + 1
        RETURNING talker_turn_counter
      `;
      return {
        talkerTurnCounter: result.length > 0 ? Number(result[0].talker_turn_counter) : undefined,
      };
    }

    // Thinker path: read existing payload, concat new entries, trim, write + increment version.
    // Uses transaction + FOR UPDATE to serialize concurrent thinker workers on the same session.
    if (versionIncrement === 'thinker') {
      return this.sql.begin(async (rawTx) => {
        const tx = rawTx as unknown as postgres.Sql;
        const existingRows = await tx`
          SELECT slot_payload FROM recent_cognition_slots
          WHERE session_id = ${sessionId} AND agent_id = ${agentId}
          FOR UPDATE
        `;

        let entries: unknown[];
        if (existingRows.length > 0) {
          const existing = existingRows[0].slot_payload;
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
        const payloadJson = JSON.stringify(entries);

        const result = await tx`
          INSERT INTO recent_cognition_slots (
            session_id, agent_id, last_settlement_id, slot_payload, updated_at, talker_turn_counter, thinker_committed_version
          )
          VALUES (
            ${sessionId}, ${agentId}, ${settlementId}, ${payloadJson}::jsonb, ${now}, 0, 1
          )
          ON CONFLICT (session_id, agent_id)
          DO UPDATE SET
            last_settlement_id = ${settlementId},
            slot_payload = ${payloadJson}::jsonb,
            updated_at = ${now},
            thinker_committed_version = recent_cognition_slots.thinker_committed_version + 1
          RETURNING thinker_committed_version
        `;
        return {
          thinkerCommittedVersion: result.length > 0 ? Number(result[0].thinker_committed_version) : undefined,
        };
      });
    }

    // setThinkerVersion path: used by batch-split sub-jobs with explicit version numbers.
    // Uses transaction + FOR UPDATE to serialize concurrent workers and prevent payload regression.
    if (setThinkerVersion !== undefined) {
      return this.sql.begin(async (rawTx) => {
        const tx = rawTx as unknown as postgres.Sql;
        const existingRows = await tx`
          SELECT slot_payload, thinker_committed_version FROM recent_cognition_slots
          WHERE session_id = ${sessionId} AND agent_id = ${agentId}
          FOR UPDATE
        `;

        // If a higher version already committed, skip this write to prevent payload regression
        if (existingRows.length > 0) {
          const currentVersion = Number(existingRows[0].thinker_committed_version ?? 0);
          if (setThinkerVersion < currentVersion) {
            return { thinkerCommittedVersion: currentVersion };
          }
        }

        let entries: unknown[];
        if (existingRows.length > 0) {
          const existing = existingRows[0].slot_payload;
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
        const payloadJson = JSON.stringify(entries);

        const result = await tx`
          INSERT INTO recent_cognition_slots (
            session_id, agent_id, last_settlement_id, slot_payload, updated_at, talker_turn_counter, thinker_committed_version
          )
          VALUES (
            ${sessionId}, ${agentId}, ${settlementId}, ${payloadJson}::jsonb, ${now}, 0, ${setThinkerVersion}
          )
          ON CONFLICT (session_id, agent_id)
          DO UPDATE SET
            last_settlement_id = ${settlementId},
            slot_payload = ${payloadJson}::jsonb,
            updated_at = ${now},
            thinker_committed_version = GREATEST(recent_cognition_slots.thinker_committed_version, ${setThinkerVersion})
          RETURNING thinker_committed_version
        `;
        return {
          thinkerCommittedVersion: result.length > 0 ? Number(result[0].thinker_committed_version) : undefined,
        };
      });
    }

    // Default/backwards-compatible path: no version column touched
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

    const payloadJson = JSON.stringify(entries);
    await this.sql`
      INSERT INTO recent_cognition_slots (
        session_id, agent_id, last_settlement_id, slot_payload, updated_at, talker_turn_counter, thinker_committed_version
      )
      VALUES (
        ${sessionId}, ${agentId}, ${settlementId}, ${payloadJson}::jsonb, ${now}, 0, 0
      )
      ON CONFLICT (session_id, agent_id)
      DO UPDATE SET
        last_settlement_id = ${settlementId},
        slot_payload = ${payloadJson}::jsonb,
        updated_at = ${now}
    `;

    return {};
  }

  async getBySession(
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
  > {
    const rows = await this.sql`
      SELECT last_settlement_id, slot_payload, updated_at, talker_turn_counter, thinker_committed_version
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
      talkerTurnCounter: Number(row.talker_turn_counter ?? 0),
      thinkerCommittedVersion: Number(row.thinker_committed_version ?? 0),
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

  async getVersionGap(
    sessionId: string,
    agentId: string,
  ): Promise<{ talkerCounter: number; thinkerVersion: number; gap: number } | undefined> {
    const rows = await this.sql`
      SELECT talker_turn_counter, thinker_committed_version
      FROM recent_cognition_slots
      WHERE session_id = ${sessionId} AND agent_id = ${agentId}
    `;
    if (rows.length === 0) return undefined;
    const row = rows[0];
    const talkerCounter = Number(row.talker_turn_counter ?? 0);
    const thinkerVersion = Number(row.thinker_committed_version ?? 0);
    return {
      talkerCounter,
      thinkerVersion,
      gap: talkerCounter - thinkerVersion,
    };
  }

  async deleteBySession(sessionId: string): Promise<void> {
    await this.sql`
      DELETE FROM recent_cognition_slots WHERE session_id = ${sessionId}
    `;
  }
}
