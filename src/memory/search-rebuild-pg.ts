/**
 * PG search rebuild: rebuilds `search_docs_*` from canonical authority sources via DELETE+INSERT.
 *
 * Authority sources:
 *   - search_docs_private:   entity_nodes (private_overlay) + private_cognition_current (active)
 *   - search_docs_area:      event_nodes (area_visible)
 *   - search_docs_world:     event_nodes (world_public) + entity_nodes (shared_public) + fact_edges
 *   - search_docs_cognition: private_cognition_current
 *
 * No FTS sidecar sync needed — pg_trgm GIN indexes auto-update on insert.
 */

import type postgres from "postgres";
import { PgSearchProjectionRepo } from "../storage/domain-repos/pg/search-projection-repo.js";

const ALL_AGENTS_SENTINEL = "_all_agents";

export type PgSearchRebuildScope = "private" | "area" | "world" | "cognition" | "episode" | "all";

export type PgSearchRebuildPayload = {
  agentId: string;
  scope: PgSearchRebuildScope;
};

export class PgSearchRebuilder {
  private readonly repo: PgSearchProjectionRepo;

  constructor(private readonly sql: postgres.Sql) {
    this.repo = new PgSearchProjectionRepo(sql);
  }

  async rebuild(payload: PgSearchRebuildPayload): Promise<void> {
    const { scope, agentId } = payload;

    if (scope === "all") {
      await this.rebuildPrivate(agentId);
      await this.rebuildArea();
      await this.rebuildWorld();
      await this.rebuildCognition(agentId);
      await this.rebuildEpisode(agentId);
      return;
    }

    switch (scope) {
      case "private":
        await this.rebuildPrivate(agentId);
        break;
      case "area":
        await this.rebuildArea();
        break;
      case "world":
        await this.rebuildWorld();
        break;
      case "cognition":
        await this.rebuildCognition(agentId);
        break;
      case "episode":
        await this.rebuildEpisode(agentId);
        break;
    }
  }

  async rebuildPrivate(agentId: string): Promise<void> {
    if (agentId === ALL_AGENTS_SENTINEL) {
      const agentIds = await this.listPrivateSearchAuthorityAgentIds();
      for (const id of agentIds) {
        await this.rebuildPrivateForAgent(id);
      }
      return;
    }
    await this.rebuildPrivateForAgent(agentId);
  }

  async rebuildArea(): Promise<void> {
    await this.repo.rebuildForScope("area");

    const now = Date.now();
    const rows = await this.buildAreaSearchAuthorityRows();

    for (const row of rows) {
      await this.sql`
        INSERT INTO search_docs_area (doc_type, source_ref, location_entity_id, content, created_at)
        VALUES ('event', ${row.sourceRef}, ${row.locationEntityId}, ${row.content}, ${now})
      `;
    }
  }

  async rebuildWorld(): Promise<void> {
    await this.repo.rebuildForScope("world");

    const now = Date.now();
    const rows = await this.buildWorldSearchAuthorityRows();

    for (const row of rows) {
      await this.sql`
        INSERT INTO search_docs_world (doc_type, source_ref, content, created_at)
        VALUES (${row.docType}, ${row.sourceRef}, ${row.content}, ${now})
      `;
    }
  }

  async rebuildCognition(agentId: string): Promise<void> {
    if (agentId === ALL_AGENTS_SENTINEL) {
      const agentIds = await this.listCognitionSearchAuthorityAgentIds();
      for (const id of agentIds) {
        await this.rebuildCognitionForAgent(id);
      }
      return;
    }
    await this.rebuildCognitionForAgent(agentId);
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private async rebuildPrivateForAgent(agentId: string): Promise<void> {
    await this.repo.rebuildForScope("private", agentId);

    const now = Date.now();
    const rows = await this.buildPrivateSearchAuthorityRows(agentId);

    for (const row of rows) {
      await this.sql`
        INSERT INTO search_docs_private (doc_type, source_ref, agent_id, content, created_at)
        VALUES (${row.docType}, ${row.sourceRef}, ${row.agentId}, ${row.content}, ${now})
      `;
    }
  }

  private async rebuildCognitionForAgent(agentId: string): Promise<void> {
    await this.repo.rebuildForScope("cognition", agentId);

    const now = Date.now();
    const rows = await this.buildCognitionSearchAuthorityRows(agentId);

    for (const row of rows) {
      await this.sql`
        INSERT INTO search_docs_cognition
          (doc_type, source_ref, agent_id, kind, basis, stance, content, updated_at, created_at)
        VALUES
          (${row.docType}, ${row.sourceRef}, ${row.agentId}, ${row.kind},
           ${row.basis ?? null}, ${row.stance ?? null}, ${row.content},
           ${row.updatedAt}, ${now})
      `;
    }
  }

  async rebuildEpisode(agentId: string): Promise<void> {
    if (agentId === ALL_AGENTS_SENTINEL) {
      const agentIds = await this.listEpisodeSearchAuthorityAgentIds();
      for (const id of agentIds) {
        await this.rebuildEpisodeForAgent(id);
      }
      return;
    }
    await this.rebuildEpisodeForAgent(agentId);
  }

  private async rebuildEpisodeForAgent(agentId: string): Promise<void> {
    await this.repo.rebuildForScope("episode", agentId);

    const now = Date.now();
    const rows = await this.buildEpisodeSearchAuthorityRows(agentId);

    for (const row of rows) {
      const contentWithEntities =
        row.entityPointerKeys.length > 0
          ? `${row.content} | entities: ${row.entityPointerKeys.join(" ")}`
          : row.content;
      await this.sql`
        INSERT INTO search_docs_episode
          (doc_type, source_ref, agent_id, category, content, committed_at, created_at, entity_pointer_keys)
        VALUES
          ('episode', ${row.sourceRef}, ${row.agentId}, ${row.category},
           ${contentWithEntities}, ${row.committedAt}, ${now}, ${row.entityPointerKeys})
      `;
    }
  }

  // ── Authority source queries (PG equivalents of search-authority.ts) ──

  private async listEpisodeSearchAuthorityAgentIds(): Promise<string[]> {
    const rows = await this.sql<{ agent_id: string }[]>`
      SELECT DISTINCT agent_id
      FROM private_episode_events
      ORDER BY agent_id ASC
    `;
    return rows.map((r) => r.agent_id);
  }

  private async buildEpisodeSearchAuthorityRows(
    agentId: string,
  ): Promise<
    Array<{
      sourceRef: string;
      agentId: string;
      category: string;
      content: string;
      committedAt: number;
      entityPointerKeys: string[];
    }>
  > {
    const rows = await this.sql<
      {
        id: string | number;
        category: string;
        summary: string;
        committed_time: string | number;
        entity_pointer_keys: string[] | null;
      }[]
    >`
      SELECT id, category, summary, committed_time, entity_pointer_keys
      FROM private_episode_events
      WHERE agent_id = ${agentId}
      ORDER BY id ASC
    `;

    return rows.map((row) => ({
      sourceRef: `episode:${Number(row.id)}`,
      agentId,
      category: row.category,
      content: row.summary,
      committedAt: Number(row.committed_time),
      entityPointerKeys: Array.isArray(row.entity_pointer_keys)
        ? row.entity_pointer_keys.filter((v): v is string => typeof v === "string")
        : [],
    }));
  }

  private async listPrivateSearchAuthorityAgentIds(): Promise<string[]> {
    const rows = await this.sql<{ agent_id: string }[]>`
      SELECT DISTINCT agent_id
      FROM (
        SELECT agent_id AS agent_id
        FROM private_cognition_current
        UNION
        SELECT owner_agent_id AS agent_id
        FROM entity_nodes
        WHERE memory_scope = 'private_overlay'
      ) AS sub
      WHERE agent_id IS NOT NULL
      ORDER BY agent_id ASC
    `;
    return rows.map((r) => r.agent_id);
  }

  private async listCognitionSearchAuthorityAgentIds(): Promise<string[]> {
    const rows = await this.sql<{ agent_id: string }[]>`
      SELECT DISTINCT agent_id
      FROM private_cognition_current
      ORDER BY agent_id ASC
    `;
    return rows.map((r) => r.agent_id);
  }

  private async buildPrivateSearchAuthorityRows(
    agentId: string,
  ): Promise<
    Array<{
      docType: string;
      sourceRef: string;
      agentId: string;
      content: string;
    }>
  > {
    const result: Array<{
      docType: string;
      sourceRef: string;
      agentId: string;
      content: string;
    }> = [];

    const entities = await this.sql<
      {
        id: string | number;
        display_name: string;
        summary: string | null;
      }[]
    >`
      SELECT id, display_name, summary
      FROM entity_nodes
      WHERE memory_scope = 'private_overlay' AND owner_agent_id = ${agentId}
      ORDER BY id ASC
    `;

    for (const entity of entities) {
      result.push({
        docType: "entity",
        sourceRef: `entity:${Number(entity.id)}`,
        agentId,
        content: [entity.display_name, entity.summary].filter(Boolean).join(" "),
      });
    }

    const evalCommit = await this.sql<
      {
        id: string | number;
        kind: string;
        summary_text: string | null;
        record_json: Record<string, unknown> | string | null;
      }[]
    >`
      SELECT id, kind, summary_text, record_json
      FROM private_cognition_current
      WHERE agent_id = ${agentId}
        AND kind IN ('evaluation', 'commitment')
        AND status != 'retracted'
      ORDER BY id ASC
    `;

    for (const row of evalCommit) {
      const record = safeParseJsonb(row.record_json);
      const privateNotes = typeof record.private_notes === "string" ? record.private_notes : "";
      result.push({
        docType: row.kind,
        sourceRef: `${row.kind}:${Number(row.id)}`,
        agentId,
        content: [privateNotes, row.summary_text].filter(Boolean).join(" "),
      });
    }

    const assertions = await this.sql<
      {
        id: string | number;
        summary_text: string | null;
        record_json: Record<string, unknown> | string | null;
      }[]
    >`
      SELECT id, summary_text, record_json
      FROM private_cognition_current
      WHERE agent_id = ${agentId}
        AND kind = 'assertion'
        AND (stance IS NULL OR stance NOT IN ('rejected', 'abandoned'))
      ORDER BY id ASC
    `;

    for (const row of assertions) {
      const record = safeParseJsonb(row.record_json);
      const provenance = typeof record.provenance === "string" ? record.provenance : "";
      result.push({
        docType: "assertion",
        sourceRef: `assertion:${Number(row.id)}`,
        agentId,
        content: [row.summary_text, provenance].filter(Boolean).join(" "),
      });
    }

    return result;
  }

  private async buildAreaSearchAuthorityRows(): Promise<
    Array<{
      docType: string;
      sourceRef: string;
      locationEntityId: number;
      content: string;
    }>
  > {
    const events = await this.sql<
      {
        id: string | number;
        summary: string;
        location_entity_id: string | number;
      }[]
    >`
      SELECT id, summary, location_entity_id
      FROM event_nodes
      WHERE visibility_scope = 'area_visible' AND summary IS NOT NULL
      ORDER BY id ASC
    `;

    return events.map((event) => ({
      docType: "event",
      sourceRef: `event:${Number(event.id)}`,
      locationEntityId: Number(event.location_entity_id),
      content: event.summary,
    }));
  }

  private async buildWorldSearchAuthorityRows(): Promise<
    Array<{
      docType: string;
      sourceRef: string;
      content: string;
    }>
  > {
    const result: Array<{ docType: string; sourceRef: string; content: string }> = [];

    const events = await this.sql<
      {
        id: string | number;
        summary: string;
      }[]
    >`
      SELECT id, summary
      FROM event_nodes
      WHERE visibility_scope = 'world_public' AND summary IS NOT NULL
      ORDER BY id ASC
    `;

    for (const event of events) {
      result.push({
        docType: "event",
        sourceRef: `event:${Number(event.id)}`,
        content: event.summary,
      });
    }

    const entities = await this.sql<
      {
        id: string | number;
        display_name: string;
        summary: string | null;
      }[]
    >`
      SELECT id, display_name, summary
      FROM entity_nodes
      WHERE memory_scope = 'shared_public'
      ORDER BY id ASC
    `;

    for (const entity of entities) {
      result.push({
        docType: "entity",
        sourceRef: `entity:${Number(entity.id)}`,
        content: [entity.display_name, entity.summary].filter(Boolean).join(" "),
      });
    }

    const facts = await this.sql<
      {
        id: string | number;
        source_entity_id: string | number;
        predicate: string;
        target_entity_id: string | number;
      }[]
    >`
      SELECT id, source_entity_id, predicate, target_entity_id
      FROM fact_edges
      ORDER BY id ASC
    `;

    for (const fact of facts) {
      result.push({
        docType: "fact",
        sourceRef: `fact:${Number(fact.id)}`,
        content: `${Number(fact.source_entity_id)} ${fact.predicate} ${Number(fact.target_entity_id)}`,
      });
    }

    return result;
  }

  private async buildCognitionSearchAuthorityRows(
    agentId: string,
  ): Promise<
    Array<{
      docType: string;
      sourceRef: string;
      agentId: string;
      kind: string;
      basis: string | null;
      stance: string | null;
      content: string;
      updatedAt: number;
    }>
  > {
    const rows = await this.sql<
      {
        id: string | number;
        kind: string;
        basis: string | null;
        stance: string | null;
        summary_text: string | null;
        updated_at: string | number;
      }[]
    >`
      SELECT id, kind, basis, stance, summary_text, updated_at
      FROM private_cognition_current
      WHERE agent_id = ${agentId}
      ORDER BY id ASC
    `;

    return rows.map((row) => ({
      docType: row.kind,
      sourceRef: `${row.kind}:${Number(row.id)}`,
      agentId,
      kind: row.kind,
      basis: row.basis,
      stance: row.stance,
      content: row.summary_text ?? "",
      updatedAt: Number(row.updated_at),
    }));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function safeParseJsonb(value: Record<string, unknown> | string | null): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
