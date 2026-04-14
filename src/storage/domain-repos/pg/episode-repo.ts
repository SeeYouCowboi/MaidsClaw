import type postgres from "postgres";
import type {
  EpisodeAppendParams,
  EpisodeRow,
} from "../../../memory/episode/episode-repo.js";
import type { EpisodeRepo } from "../contracts/episode-repo.js";

const VALID_CATEGORIES = new Set([
  "speech",
  "action",
  "observation",
  "state_change",
]);

const REJECTED_FIELDS = new Set([
  "emotion",
  "cognition_key",
  "cognitionKey",
  "projection_class",
  "projectionClass",
  "projectable_summary",
  "projectableSummary",
]);

export class PgEpisodeRepo implements EpisodeRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async readById(id: number): Promise<EpisodeRow | null> {
    const rows = await this.sql`
      SELECT id, agent_id, session_id, settlement_id, category, summary,
             private_notes, location_entity_id, location_text,
             valid_time, committed_time, source_local_ref, request_id, created_at,
             entity_pointer_keys
      FROM private_episode_events
      WHERE id = ${id}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return null;
    }
    return normalizeEpisodeRow(rows[0]);
  }

  async append(
    params: EpisodeAppendParams & Record<string, unknown>,
  ): Promise<number> {
    if (!VALID_CATEGORIES.has(params.category)) {
      throw new Error(
        `invalid episode category: ${JSON.stringify(params.category)}`,
      );
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
    const entityPointerKeys = params.entityPointerKeys ?? [];

    const rows = await this.sql`
      INSERT INTO private_episode_events
        (agent_id, session_id, settlement_id, category, summary,
         private_notes, location_entity_id, location_text,
         valid_time, committed_time, source_local_ref, request_id, created_at,
         entity_pointer_keys)
      VALUES
        (${params.agentId}, ${params.sessionId}, ${params.settlementId},
         ${params.category}, ${params.summary},
         ${params.privateNotes ?? null}, ${params.locationEntityId ?? null},
         ${params.locationText ?? null}, ${params.validTime ?? null},
         ${params.committedTime}, ${params.sourceLocalRef ?? null},
         ${params.requestId ?? null}, ${now},
         ${entityPointerKeys})
      ON CONFLICT (settlement_id, source_local_ref)
        WHERE source_local_ref IS NOT NULL
        DO NOTHING
      RETURNING id
    `;

    if (rows.length === 0) {
      return 0;
    }
    return Number(rows[0].id);
  }

  async readBySettlement(
    settlementId: string,
    agentId: string,
  ): Promise<EpisodeRow[]> {
    const rows = await this.sql`
      SELECT id, agent_id, session_id, settlement_id, category, summary,
             private_notes, location_entity_id, location_text,
             valid_time, committed_time, source_local_ref, request_id, created_at,
             entity_pointer_keys
      FROM private_episode_events
      WHERE settlement_id = ${settlementId}
        AND agent_id = ${agentId}
      ORDER BY id ASC
    `;
    return rows.map(normalizeEpisodeRow);
  }

  async readPublicationsBySettlement(
    settlementId: string,
  ): Promise<Array<{ id: number; source_pub_index: number | null }>> {
    const rows = await this.sql`
      SELECT id, source_pub_index
      FROM event_nodes
      WHERE source_settlement_id = ${settlementId}
      ORDER BY id ASC
    `;

    return rows.map((row) => ({
      id: Number(row.id),
      source_pub_index:
        row.source_pub_index == null ? null : Number(row.source_pub_index),
    }));
  }

  async readByAgent(agentId: string, limit?: number): Promise<EpisodeRow[]> {
    const effectiveLimit = limit ?? 100;
    const rows = await this.sql`
      SELECT id, agent_id, session_id, settlement_id, category, summary,
             private_notes, location_entity_id, location_text,
             valid_time, committed_time, source_local_ref, request_id, created_at,
             entity_pointer_keys
      FROM private_episode_events
      WHERE agent_id = ${agentId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${effectiveLimit}
    `;
    return rows.map(normalizeEpisodeRow);
  }
}

function normalizeEpisodeRow(row: postgres.Row): EpisodeRow {
  const rawKeys = row.entity_pointer_keys;
  const entityPointerKeys: string[] = Array.isArray(rawKeys)
    ? (rawKeys as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  return {
    id: Number(row.id),
    agent_id: row.agent_id as string,
    session_id: row.session_id as string,
    settlement_id: row.settlement_id as string,
    category: row.category as string,
    summary: row.summary as string,
    private_notes: (row.private_notes as string) ?? null,
    location_entity_id:
      row.location_entity_id != null ? Number(row.location_entity_id) : null,
    location_text: (row.location_text as string) ?? null,
    valid_time: row.valid_time != null ? Number(row.valid_time) : null,
    committed_time: Number(row.committed_time),
    source_local_ref: (row.source_local_ref as string) ?? null,
    request_id: (row.request_id as string) ?? null,
    created_at: Number(row.created_at),
    entity_pointer_keys: entityPointerKeys,
  };
}
