import type postgres from "postgres";
import type { NodeRef } from "../../../memory/types.js";
import type {
  SearchProjectionRepo,
  SearchProjectionScope,
  UpsertCognitionDocParams,
  UpsertEpisodeDocParams,
} from "../contracts/search-projection-repo.js";
import { PgSearchLexicalBackend } from "./pg-search-backend.js";

const ALL_AGENTS_SENTINEL = "_all_agents";

type AreaDocRow = {
  id: string | number;
  doc_type: string;
  source_ref: string;
  location_entity_id: string | number;
  content: string;
  created_at: string | number;
  score?: string | number;
};

type WorldDocRow = {
  id: string | number;
  doc_type: string;
  source_ref: string;
  content: string;
  created_at: string | number;
  score?: string | number;
};

type CognitionDocRow = {
  id: string | number;
  doc_type: string;
  source_ref: string;
  agent_id: string;
  kind: string;
  basis: string | null;
  stance: string | null;
  content: string;
  updated_at: string | number;
  created_at: string | number;
  score?: string | number;
};

type UpsertAreaDocParams = {
  sourceRef: NodeRef;
  content: string;
  locationEntityId: number;
  createdAt?: number;
  aliasText?: string;
};

type UpsertWorldDocParams = {
  sourceRef: NodeRef;
  content: string;
  createdAt?: number;
  aliasText?: string;
};

function toNumber(value: string | number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  return typeof value === "number" ? value : Number(value);
}

function parseSourceRefId(sourceRef: string): number {
  const parts = sourceRef.split(":");
  if (parts.length < 2) {
    return 0;
  }
  const numeric = Number(parts[parts.length - 1]);
  return Number.isFinite(numeric) ? numeric : 0;
}

function getDocTypeFromRef(sourceRef: NodeRef): string {
  const [kind] = sourceRef.split(":", 1);
  return kind || "node";
}

function buildSearchTexts(
  content: string,
  aliasText: string | undefined,
): { searchText: string; ngramText: string; aliasText: string } {
  const alias = (aliasText ?? "").trim();
  const composed = alias.length > 0 ? `${content} | aliases: ${alias}` : content;
  return { searchText: composed, ngramText: composed, aliasText: alias };
}

export class PgSearchProjectionRepo implements SearchProjectionRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async syncSearchDoc(
    scope: "area" | "world",
    sourceRef: NodeRef,
    content: string,
    agentId?: string,
    locationEntityId?: number,
    aliasText?: string,
  ): Promise<number> {
    if (scope === "area") {
      if (locationEntityId === undefined) {
        throw new Error("locationEntityId is required for area search docs");
      }
      return this.upsertAreaDoc({ sourceRef, content, locationEntityId, aliasText });
    }

    return this.upsertWorldDoc({ sourceRef, content, aliasText });
  }

  async removeSearchDoc(scope: "area" | "world", sourceRef: NodeRef): Promise<void> {
    if (scope === "area") {
      await this.sql`
        DELETE FROM search_docs_area
        WHERE source_ref = ${sourceRef}
      `;
      return;
    }

    await this.sql`
      DELETE FROM search_docs_world
      WHERE source_ref = ${sourceRef}
    `;
  }

  async rebuildForScope(scope: SearchProjectionScope, agentId = ALL_AGENTS_SENTINEL): Promise<void> {
    if (scope === "area") {
      await this.sql`DELETE FROM search_docs_area`;
      return;
    }

    if (scope === "world") {
      await this.sql`DELETE FROM search_docs_world`;
      return;
    }

    if (scope === "episode") {
      if (agentId === ALL_AGENTS_SENTINEL) {
        await this.sql`DELETE FROM search_docs_episode`;
      } else {
        await this.sql`
          DELETE FROM search_docs_episode
          WHERE agent_id = ${agentId}
        `;
      }
      return;
    }

    if (agentId === ALL_AGENTS_SENTINEL) {
      await this.sql`DELETE FROM search_docs_cognition`;
      return;
    }

    await this.sql`
      DELETE FROM search_docs_cognition
      WHERE agent_id = ${agentId}
    `;
  }

  async upsertAreaDoc(params: UpsertAreaDocParams): Promise<number> {
    const now = params.createdAt ?? Date.now();
    const docType = getDocTypeFromRef(params.sourceRef);
    const texts = buildSearchTexts(params.content, params.aliasText);

    const existing = await this.sql<AreaDocRow[]>`
      SELECT id, doc_type, location_entity_id, content
      FROM search_docs_area
      WHERE source_ref = ${params.sourceRef}
      LIMIT 1
    `;

    if (existing.length === 0) {
      const inserted = await this.sql<{ id: string | number }[]>`
        INSERT INTO search_docs_area
          (doc_type, source_ref, location_entity_id, content, created_at,
           content_search_text, content_ngram_text, alias_text)
        VALUES
          (${docType}, ${params.sourceRef}, ${params.locationEntityId}, ${params.content}, ${now},
           ${texts.searchText}, ${texts.ngramText}, ${texts.aliasText})
        RETURNING id
      `;
      return toNumber(inserted[0]?.id);
    }

    const row = existing[0];
    if (
      row.doc_type !== docType
      || toNumber(row.location_entity_id) !== params.locationEntityId
      || row.content !== params.content
    ) {
      await this.sql`
        UPDATE search_docs_area
        SET doc_type = ${docType},
            location_entity_id = ${params.locationEntityId},
            content = ${params.content},
            content_search_text = ${texts.searchText},
            content_ngram_text = ${texts.ngramText},
            alias_text = ${texts.aliasText}
        WHERE id = ${row.id}
      `;
    } else {
      await this.sql`
        UPDATE search_docs_area
        SET content_search_text = ${texts.searchText},
            content_ngram_text = ${texts.ngramText},
            alias_text = ${texts.aliasText}
        WHERE id = ${row.id}
      `;
    }

    return toNumber(row.id);
  }

  async upsertWorldDoc(params: UpsertWorldDocParams): Promise<number> {
    const now = params.createdAt ?? Date.now();
    const docType = getDocTypeFromRef(params.sourceRef);
    const texts = buildSearchTexts(params.content, params.aliasText);

    const existing = await this.sql<WorldDocRow[]>`
      SELECT id, doc_type, content
      FROM search_docs_world
      WHERE source_ref = ${params.sourceRef}
      LIMIT 1
    `;

    if (existing.length === 0) {
      const inserted = await this.sql<{ id: string | number }[]>`
        INSERT INTO search_docs_world
          (doc_type, source_ref, content, created_at,
           content_search_text, content_ngram_text, alias_text)
        VALUES
          (${docType}, ${params.sourceRef}, ${params.content}, ${now},
           ${texts.searchText}, ${texts.ngramText}, ${texts.aliasText})
        RETURNING id
      `;
      return toNumber(inserted[0]?.id);
    }

    const row = existing[0];
    if (row.doc_type !== docType || row.content !== params.content) {
      await this.sql`
        UPDATE search_docs_world
        SET doc_type = ${docType},
            content = ${params.content},
            content_search_text = ${texts.searchText},
            content_ngram_text = ${texts.ngramText},
            alias_text = ${texts.aliasText}
        WHERE id = ${row.id}
      `;
    } else {
      await this.sql`
        UPDATE search_docs_world
        SET content_search_text = ${texts.searchText},
            content_ngram_text = ${texts.ngramText},
            alias_text = ${texts.aliasText}
        WHERE id = ${row.id}
      `;
    }

    return toNumber(row.id);
  }

  async upsertCognitionDoc(params: UpsertCognitionDocParams): Promise<number> {
    const now = Date.now();
    const docType = getDocTypeFromRef(params.sourceRef);
    const texts = buildSearchTexts(params.content, params.aliasText);

    const existing = await this.sql<CognitionDocRow[]>`
      SELECT id, doc_type, kind, basis, stance, content
      FROM search_docs_cognition
      WHERE source_ref = ${params.sourceRef}
        AND agent_id = ${params.agentId}
      LIMIT 1
    `;

    if (existing.length === 0) {
      const inserted = await this.sql<{ id: string | number }[]>`
        INSERT INTO search_docs_cognition
          (doc_type, source_ref, agent_id, kind, basis, stance, content, updated_at, created_at,
           content_search_text, content_ngram_text, alias_text)
        VALUES
          (
            ${docType},
            ${params.sourceRef},
            ${params.agentId},
            ${params.kind},
            ${params.basis ?? null},
            ${params.stance ?? null},
            ${params.content},
            ${params.updatedAt ?? now},
            ${params.createdAt ?? now},
            ${texts.searchText},
            ${texts.ngramText},
            ${texts.aliasText}
          )
        RETURNING id
      `;
      return toNumber(inserted[0]?.id);
    }

    const row = existing[0];
    if (
      row.doc_type !== docType
      || row.kind !== params.kind
      || row.basis !== (params.basis ?? null)
      || row.stance !== (params.stance ?? null)
      || row.content !== params.content
    ) {
      await this.sql`
        UPDATE search_docs_cognition
        SET doc_type = ${docType},
            kind = ${params.kind},
            basis = ${params.basis ?? null},
            stance = ${params.stance ?? null},
            content = ${params.content},
            updated_at = ${params.updatedAt ?? now},
            content_search_text = ${texts.searchText},
            content_ngram_text = ${texts.ngramText},
            alias_text = ${texts.aliasText}
        WHERE id = ${row.id}
      `;
    } else {
      await this.sql`
        UPDATE search_docs_cognition
        SET content_search_text = ${texts.searchText},
            content_ngram_text = ${texts.ngramText},
            alias_text = ${texts.aliasText}
        WHERE id = ${row.id}
      `;
    }

    return toNumber(row.id);
  }

  async updateCognitionSearchDocStanceBySourceRef(
    sourceRef: NodeRef,
    agentId: string,
    stance: string,
    updatedAt: number,
  ): Promise<void> {
    await this.sql`
      UPDATE search_docs_cognition
      SET stance = ${stance}, updated_at = ${updatedAt}
      WHERE source_ref = ${sourceRef} AND agent_id = ${agentId}
    `;
  }

  async deleteAreaDoc(sourceRef: NodeRef, locationEntityId: number): Promise<void> {
    await this.sql`
      DELETE FROM search_docs_area
      WHERE source_ref = ${sourceRef}
        AND location_entity_id = ${locationEntityId}
    `;
  }

  async deleteWorldDoc(sourceRef: NodeRef): Promise<void> {
    await this.sql`
      DELETE FROM search_docs_world
      WHERE source_ref = ${sourceRef}
    `;
  }

  async deleteCognitionDoc(sourceRef: NodeRef, agentId: string): Promise<void> {
    await this.sql`
      DELETE FROM search_docs_cognition
      WHERE source_ref = ${sourceRef}
        AND agent_id = ${agentId}
    `;
  }

  async searchArea(
    query: string,
    locationEntityId: number,
    limit = 20,
  ): Promise<Array<{
    id: number;
    docType: string;
    sourceRef: string;
    locationEntityId: number;
    content: string;
    createdAt: number;
    score: number;
  }>> {
    const backend = new PgSearchLexicalBackend(this.sql);
    const rows = await backend.searchArea({
      query,
      locationEntityId,
      limit,
    });

    return rows.map((row) => ({
      id: toNumber(row.id),
      docType: row.doc_type,
      sourceRef: row.source_ref,
      locationEntityId: toNumber(row.location_entity_id),
      content: row.content,
      createdAt: toNumber(row.created_at),
      score: toNumber(row.score),
    }));
  }

  async searchWorld(
    query: string,
    limit = 20,
  ): Promise<Array<{
    id: number;
    docType: string;
    sourceRef: string;
    content: string;
    createdAt: number;
    score: number;
  }>> {
    const backend = new PgSearchLexicalBackend(this.sql);
    const rows = await backend.searchWorld({ query, limit });

    return rows.map((row) => ({
      id: toNumber(row.id),
      docType: row.doc_type,
      sourceRef: row.source_ref,
      content: row.content,
      createdAt: toNumber(row.created_at),
      score: toNumber(row.score),
    }));
  }

  async searchCognition(
    query: string,
    agentId: string,
    limit = 20,
  ): Promise<Array<{
    id: number;
    docType: string;
    sourceRef: string;
    agentId: string;
    kind: string;
    basis: string | null;
    stance: string | null;
    content: string;
    updatedAt: number;
    createdAt: number;
    score: number;
  }>> {
    const backend = new PgSearchLexicalBackend(this.sql);
    const rows = await backend.searchCognition({
      query,
      agentId,
      limit,
    });

    return rows.map((row) => ({
      id: parseSourceRefId(row.source_ref),
      docType: row.kind,
      sourceRef: row.source_ref,
      agentId,
      kind: row.kind,
      basis: row.basis,
      stance: row.stance,
      content: row.content,
      updatedAt: toNumber(row.updated_at),
      createdAt: toNumber(row.updated_at),
      score: toNumber(row.score),
    }));
  }

  async upsertEpisodeDoc(params: UpsertEpisodeDocParams): Promise<number> {
    const now = params.createdAt ?? Date.now();
    const entityPointerKeys = params.entityPointerKeys ?? [];
    const aliasSource = params.aliasText ?? entityPointerKeys.join(" ");
    const texts = buildSearchTexts(params.content, aliasSource);
    const actor = params.actor === "user" ? "user" : "agent";

    const existing = await this.sql<{ id: string | number; content: string; category: string; actor: string }[]>`
      SELECT id, content, category, actor
      FROM search_docs_episode
      WHERE source_ref = ${params.sourceRef}
        AND agent_id = ${params.agentId}
      LIMIT 1
    `;

    if (existing.length === 0) {
      const inserted = await this.sql<{ id: string | number }[]>`
        INSERT INTO search_docs_episode
          (doc_type, source_ref, agent_id, category, content, committed_at, created_at, entity_pointer_keys, actor,
            content_search_text, content_ngram_text, alias_text)
        VALUES
          ('episode', ${params.sourceRef}, ${params.agentId}, ${params.category},
            ${params.content}, ${params.committedAt}, ${now}, ${entityPointerKeys}, ${actor},
            ${texts.searchText}, ${texts.ngramText}, ${texts.aliasText})
        RETURNING id
      `;
      return toNumber(inserted[0]?.id);
    }

    const row = existing[0];
    if (row.content !== params.content || row.category !== params.category || row.actor !== actor) {
      await this.sql`
        UPDATE search_docs_episode
        SET content = ${params.content},
            category = ${params.category},
            committed_at = ${params.committedAt},
            entity_pointer_keys = ${entityPointerKeys},
            actor = ${actor},
            content_search_text = ${texts.searchText},
            content_ngram_text = ${texts.ngramText},
            alias_text = ${texts.aliasText}
        WHERE id = ${row.id}
      `;
    } else {
      await this.sql`
        UPDATE search_docs_episode
        SET content_search_text = ${texts.searchText},
            content_ngram_text = ${texts.ngramText},
            alias_text = ${texts.aliasText}
        WHERE id = ${row.id}
      `;
    }

    return toNumber(row.id);
  }

  async searchEpisode(
    query: string,
    agentId: string,
    limit = 20,
  ): Promise<Array<{
    id: number;
    sourceRef: string;
    agentId: string;
    category: string;
    content: string;
    committedAt: number;
    createdAt: number;
    actor: "user" | "agent";
    score: number;
  }>> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const backend = new PgSearchLexicalBackend(this.sql);
    const rows = await backend.searchEpisode({
      query: trimmed,
      agentId,
      limit,
    });

    return rows.map((row) => ({
      id: toNumber(row.id),
      sourceRef: row.source_ref,
      agentId: row.agent_id,
      category: row.category,
      content: row.content,
      committedAt: toNumber(row.committed_at),
      createdAt: toNumber(row.created_at),
      actor: row.actor === "user" ? "user" : "agent",
      score: toNumber(row.score),
    }));
  }
}
