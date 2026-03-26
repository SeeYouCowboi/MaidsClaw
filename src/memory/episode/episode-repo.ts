import type { Db } from "../../storage/database.js";

const VALID_CATEGORIES = new Set(["speech", "action", "observation", "state_change"]);

const REJECTED_FIELDS = new Set([
  "emotion",
  "cognition_key",
  "cognitionKey",
  "projection_class",
  "projectionClass",
  "projectable_summary",
  "projectableSummary",
]);

export type EpisodeAppendParams = {
  agentId: string;
  sessionId: string;
  settlementId: string;
  category: string;
  summary: string;
  privateNotes?: string;
  locationEntityId?: number;
  locationText?: string;
  validTime?: number;
  committedTime: number;
  sourceLocalRef?: string;
};

export type EpisodeRow = {
  id: number;
  agent_id: string;
  session_id: string;
  settlement_id: string;
  category: string;
  summary: string;
  private_notes: string | null;
  location_entity_id: number | null;
  location_text: string | null;
  valid_time: number | null;
  committed_time: number;
  source_local_ref: string | null;
  created_at: number;
};

export class EpisodeRepository {
  constructor(private readonly db: Db) {}

  append(params: EpisodeAppendParams & Record<string, unknown>): number {
    if (params.category === "thought") {
      throw new Error(`episode category "thought" is not allowed`);
    }

    if (!VALID_CATEGORIES.has(params.category)) {
      throw new Error(`invalid episode category: ${JSON.stringify(params.category)}`);
    }

    if (params.committedTime === undefined || params.committedTime === null) {
      throw new Error("committed_time is required for episode events");
    }

    for (const key of Object.keys(params)) {
      if (REJECTED_FIELDS.has(key)) {
        throw new Error(`field "${key}" is not allowed on episode events`);
      }
    }

    const now = Date.now();
    const result = this.db.run(
      `INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, private_notes, location_entity_id, location_text, valid_time, committed_time, source_local_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.agentId,
        params.sessionId,
        params.settlementId,
        params.category,
        params.summary,
        params.privateNotes ?? null,
        params.locationEntityId ?? null,
        params.locationText ?? null,
        params.validTime ?? null,
        params.committedTime,
        params.sourceLocalRef ?? null,
        now,
      ],
    );

    return Number(result.lastInsertRowid);
  }

  readBySettlement(settlementId: string, agentId: string): EpisodeRow[] {
    return this.db.query<EpisodeRow>(
      `SELECT id, agent_id, session_id, settlement_id, category, summary, private_notes, location_entity_id, location_text, valid_time, committed_time, source_local_ref, created_at FROM private_episode_events WHERE settlement_id = ? AND agent_id = ? ORDER BY id ASC`,
      [settlementId, agentId],
    );
  }

  readByAgent(agentId: string, limit?: number): EpisodeRow[] {
    const effectiveLimit = limit ?? 100;
    return this.db.query<EpisodeRow>(
      `SELECT id, agent_id, session_id, settlement_id, category, summary, private_notes, location_entity_id, location_text, valid_time, committed_time, source_local_ref, created_at FROM private_episode_events WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      [agentId, effectiveLimit],
    );
  }
}
