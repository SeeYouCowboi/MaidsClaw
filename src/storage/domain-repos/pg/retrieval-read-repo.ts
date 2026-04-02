import type postgres from "postgres";
import type { EpisodeRow } from "../../../memory/episode/episode-repo.js";
import { MAX_INTEGER } from "../../../memory/schema.js";
import type {
  EntityNode,
  EventNode,
  FactEdge,
  Topic,
  ViewerContext,
} from "../../../memory/types.js";
import { VisibilityPolicy } from "../../../memory/visibility-policy.js";
import type {
  EntityReadResult,
  RetrievalReadRepo,
  TopicReadResult,
} from "../contracts/retrieval-read-repo.js";

const PG_MAX_BIGINT = "9223372036854775807";

type RedirectRow = {
  new_name: string;
};

type AliasRow = {
  canonical_id: number | string;
};

export class PgRetrievalReadRepo implements RetrievalReadRepo {
  private readonly visibilityPolicy = new VisibilityPolicy();

  constructor(private readonly sql: postgres.Sql) {}

  async readByEntity(pointerKey: string, viewerContext: ViewerContext): Promise<EntityReadResult> {
    const resolvedPointer = await this.resolveRedirect(pointerKey, viewerContext.viewer_agent_id);
    const entity = await this.resolveEntityByPointer(resolvedPointer, viewerContext.viewer_agent_id);
    if (!entity) {
      return { entity: null, facts: [], events: [], episodes: [] };
    }

    const factRows = await this.sql<postgres.Row[]>`
      SELECT *
      FROM fact_edges
      WHERE (source_entity_id = ${entity.id} OR target_entity_id = ${entity.id})
        AND t_invalid = ${PG_MAX_BIGINT}
    `;

    const eventVisibilityPredicate = this.visibilityPolicy.eventVisibilityPredicate(viewerContext);
    const eventRows = await this.sql.unsafe<postgres.Row[]>(
      `SELECT *
       FROM event_nodes
       WHERE (participants LIKE $1 OR primary_actor_entity_id = $2)
         AND ${eventVisibilityPredicate}`,
      [`%entity:${entity.id}%`, entity.id],
    );

    const episodeRows = await this.sql<postgres.Row[]>`
      SELECT id, agent_id, session_id, settlement_id, category, summary, private_notes,
             location_entity_id, location_text, valid_time, committed_time, source_local_ref, created_at
      FROM private_episode_events
      WHERE agent_id = ${viewerContext.viewer_agent_id}
        AND location_entity_id = ${entity.id}
    `;

    return {
      entity,
      facts: factRows.map(normalizeFactRow),
      events: eventRows.map(normalizeEventRow),
      episodes: episodeRows.map(normalizeEpisodeRow),
    };
  }

  async readByTopic(name: string, viewerContext: ViewerContext): Promise<TopicReadResult> {
    const resolvedName = await this.resolveRedirect(name, viewerContext.viewer_agent_id);
    const topicRows = await this.sql<postgres.Row[]>`
      SELECT *
      FROM topics
      WHERE name = ${resolvedName}
      LIMIT 1
    `;
    const topic = topicRows[0] ? normalizeTopicRow(topicRows[0]) : null;
    if (!topic) {
      return { topic: null, events: [], episodes: [] };
    }

    const eventVisibilityPredicate = this.visibilityPolicy.eventVisibilityPredicate(viewerContext);
    const eventRows = await this.sql.unsafe<postgres.Row[]>(
      `SELECT *
       FROM event_nodes
       WHERE topic_id = $1
         AND ${eventVisibilityPredicate}`,
      [topic.id],
    );

    return {
      topic,
      events: eventRows.map(normalizeEventRow),
      episodes: [],
    };
  }

  async readByEventIds(ids: number[], viewerContext: ViewerContext): Promise<EventNode[]> {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0) {
      return [];
    }

    const eventVisibilityPredicate = this.visibilityPolicy.eventVisibilityPredicate(viewerContext);
    const rows = await this.sql.unsafe<postgres.Row[]>(
      `SELECT *
       FROM event_nodes
       WHERE id = ANY($1)
         AND ${eventVisibilityPredicate}`,
      [uniqueIds],
    );

    return rows.map(normalizeEventRow);
  }

  async readByFactIds(ids: number[], _viewerContext: ViewerContext): Promise<FactEdge[]> {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0) {
      return [];
    }

    const rows = await this.sql<postgres.Row[]>`
      SELECT *
      FROM fact_edges
      WHERE id IN ${this.sql(uniqueIds)}
        AND t_invalid = ${PG_MAX_BIGINT}
    `;

    return rows.map(normalizeFactRow);
  }

  async resolveRedirect(name: string, ownerAgentId?: string): Promise<string> {
    if (ownerAgentId) {
      const agentRows = await this.sql<RedirectRow[]>`
        SELECT new_name
        FROM pointer_redirects
        WHERE old_name = ${name}
          AND owner_agent_id = ${ownerAgentId}
        LIMIT 1
      `;
      if (agentRows.length > 0) {
        return agentRows[0].new_name;
      }
    }

    const globalRows = await this.sql<RedirectRow[]>`
      SELECT new_name
      FROM pointer_redirects
      WHERE old_name = ${name}
        AND owner_agent_id IS NULL
      LIMIT 1
    `;

    return globalRows[0]?.new_name ?? name;
  }

  async resolveEntityByPointer(pointerKey: string, viewerAgentId: string): Promise<EntityNode | null> {
    const privateRows = await this.sql<postgres.Row[]>`
      SELECT *
      FROM entity_nodes
      WHERE pointer_key = ${pointerKey}
        AND memory_scope = 'private_overlay'
        AND owner_agent_id = ${viewerAgentId}
      LIMIT 1
    `;
    if (privateRows.length > 0) {
      return normalizeEntityRow(privateRows[0]);
    }

    const sharedRows = await this.sql<postgres.Row[]>`
      SELECT *
      FROM entity_nodes
      WHERE pointer_key = ${pointerKey}
        AND memory_scope = 'shared_public'
      LIMIT 1
    `;
    if (sharedRows.length > 0) {
      return normalizeEntityRow(sharedRows[0]);
    }

    const aliasRows = await this.sql<AliasRow[]>`
      SELECT canonical_id
      FROM entity_aliases
      WHERE alias = ${pointerKey}
        AND (owner_agent_id = ${viewerAgentId} OR owner_agent_id IS NULL)
      ORDER BY CASE WHEN owner_agent_id = ${viewerAgentId} THEN 0 ELSE 1 END
      LIMIT 1
    `;
    if (aliasRows.length === 0) {
      return null;
    }

    const canonicalId = Number(aliasRows[0].canonical_id);
    const aliasedPrivateRows = await this.sql<postgres.Row[]>`
      SELECT *
      FROM entity_nodes
      WHERE id = ${canonicalId}
        AND memory_scope = 'private_overlay'
        AND owner_agent_id = ${viewerAgentId}
      LIMIT 1
    `;
    if (aliasedPrivateRows.length > 0) {
      return normalizeEntityRow(aliasedPrivateRows[0]);
    }

    const aliasedSharedRows = await this.sql<postgres.Row[]>`
      SELECT *
      FROM entity_nodes
      WHERE id = ${canonicalId}
        AND memory_scope = 'shared_public'
      LIMIT 1
    `;
    if (aliasedSharedRows.length > 0) {
      return normalizeEntityRow(aliasedSharedRows[0]);
    }
    return null;
  }

  async countNodeEmbeddings(): Promise<number> {
    const rows = await this.sql<{ count: number | string }[]>`
      SELECT count(*) AS count
      FROM node_embeddings
    `;
    return Number(rows[0]?.count ?? 0);
  }
}

function normalizeTopicRow(row: postgres.Row): Topic {
  return {
    id: Number(row.id),
    name: row.name as string,
    description: (row.description as string) ?? null,
    created_at: Number(row.created_at),
  };
}

function normalizeEntityRow(row: postgres.Row): EntityNode {
  return {
    id: Number(row.id),
    pointer_key: row.pointer_key as string,
    display_name: row.display_name as string,
    entity_type: row.entity_type as string,
    memory_scope: row.memory_scope as EntityNode["memory_scope"],
    owner_agent_id: (row.owner_agent_id as string) ?? null,
    canonical_entity_id: row.canonical_entity_id != null ? Number(row.canonical_entity_id) : null,
    summary: (row.summary as string) ?? null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function normalizeEventRow(row: postgres.Row): EventNode {
  return {
    id: Number(row.id),
    session_id: row.session_id as string,
    raw_text: (row.raw_text as string) ?? null,
    summary: (row.summary as string) ?? null,
    timestamp: Number(row.timestamp),
    created_at: Number(row.created_at),
    participants: (row.participants as string) ?? null,
    emotion: (row.emotion as string) ?? null,
    topic_id: row.topic_id != null ? Number(row.topic_id) : null,
    visibility_scope: row.visibility_scope as EventNode["visibility_scope"],
    location_entity_id: Number(row.location_entity_id),
    event_category: row.event_category as EventNode["event_category"],
    primary_actor_entity_id: row.primary_actor_entity_id != null ? Number(row.primary_actor_entity_id) : null,
    promotion_class: row.promotion_class as EventNode["promotion_class"],
    source_record_id: (row.source_record_id as string) ?? null,
    event_origin: row.event_origin as EventNode["event_origin"],
  };
}

function normalizeFactRow(row: postgres.Row): FactEdge {
  return {
    id: Number(row.id),
    source_entity_id: Number(row.source_entity_id),
    target_entity_id: Number(row.target_entity_id),
    predicate: row.predicate as string,
    t_valid: Number(row.t_valid),
    t_invalid: Number(row.t_invalid ?? MAX_INTEGER),
    t_created: Number(row.t_created),
    t_expired: Number(row.t_expired),
    source_event_id: row.source_event_id != null ? Number(row.source_event_id) : null,
  };
}

function normalizeEpisodeRow(row: postgres.Row): EpisodeRow {
  return {
    id: Number(row.id),
    agent_id: row.agent_id as string,
    session_id: row.session_id as string,
    settlement_id: row.settlement_id as string,
    category: row.category as string,
    summary: row.summary as string,
    private_notes: (row.private_notes as string) ?? null,
    location_entity_id: row.location_entity_id != null ? Number(row.location_entity_id) : null,
    location_text: (row.location_text as string) ?? null,
    valid_time: row.valid_time != null ? Number(row.valid_time) : null,
    committed_time: Number(row.committed_time),
    source_local_ref: (row.source_local_ref as string) ?? null,
    created_at: Number(row.created_at),
  };
}
