import type postgres from "postgres";
import type { NodeRef } from "../../../memory/types.js";
import type {
  SearchProjectionRepo,
  SearchProjectionScope,
  UpsertCognitionDocParams,
} from "../contracts/search-projection-repo.js";

const ALL_AGENTS_SENTINEL = "_all_agents";

type PrivateDocRow = {
  id: string | number;
  doc_type: string;
  source_ref: string;
  agent_id: string;
  content: string;
  created_at: string | number;
  score?: string | number;
};

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

type UpsertPrivateDocParams = {
  sourceRef: NodeRef;
  content: string;
  agentId: string;
  createdAt?: number;
};

type UpsertAreaDocParams = {
  sourceRef: NodeRef;
  content: string;
  locationEntityId: number;
  createdAt?: number;
};

type UpsertWorldDocParams = {
  sourceRef: NodeRef;
  content: string;
  createdAt?: number;
};

function toNumber(value: string | number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  return typeof value === "number" ? value : Number(value);
}

function getDocTypeFromRef(sourceRef: NodeRef): string {
  const [kind] = sourceRef.split(":", 1);
  return kind || "node";
}

export class PgSearchProjectionRepo implements SearchProjectionRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async syncSearchDoc(
    scope: "private" | "area" | "world",
    sourceRef: NodeRef,
    content: string,
    agentId?: string,
    locationEntityId?: number,
  ): Promise<number> {
    if (scope === "private") {
      if (!agentId) {
        throw new Error("agentId is required for private search docs");
      }
      return this.upsertPrivateDoc({ sourceRef, content, agentId });
    }

    if (scope === "area") {
      if (locationEntityId === undefined) {
        throw new Error("locationEntityId is required for area search docs");
      }
      return this.upsertAreaDoc({ sourceRef, content, locationEntityId });
    }

    return this.upsertWorldDoc({ sourceRef, content });
  }

  async removeSearchDoc(scope: "private" | "area" | "world", sourceRef: NodeRef): Promise<void> {
    if (scope === "private") {
      await this.sql`
        DELETE FROM search_docs_private
        WHERE source_ref = ${sourceRef}
      `;
      return;
    }

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
    if (scope === "private") {
      if (agentId === ALL_AGENTS_SENTINEL) {
        await this.sql`DELETE FROM search_docs_private`;
      } else {
        await this.sql`
          DELETE FROM search_docs_private
          WHERE agent_id = ${agentId}
        `;
      }
      return;
    }

    if (scope === "area") {
      await this.sql`DELETE FROM search_docs_area`;
      return;
    }

    if (scope === "world") {
      await this.sql`DELETE FROM search_docs_world`;
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

  async upsertPrivateDoc(params: UpsertPrivateDocParams): Promise<number> {
    const now = params.createdAt ?? Date.now();
    const docType = getDocTypeFromRef(params.sourceRef);

    const existing = await this.sql<PrivateDocRow[]>`
      SELECT id, doc_type, content
      FROM search_docs_private
      WHERE source_ref = ${params.sourceRef}
        AND agent_id = ${params.agentId}
      LIMIT 1
    `;

    if (existing.length === 0) {
      const inserted = await this.sql<{ id: string | number }[]>`
        INSERT INTO search_docs_private (doc_type, source_ref, agent_id, content, created_at)
        VALUES (${docType}, ${params.sourceRef}, ${params.agentId}, ${params.content}, ${now})
        RETURNING id
      `;
      return toNumber(inserted[0]?.id);
    }

    const row = existing[0];
    if (row.doc_type !== docType || row.content !== params.content) {
      await this.sql`
        UPDATE search_docs_private
        SET doc_type = ${docType},
            content = ${params.content}
        WHERE id = ${row.id}
      `;
    }

    return toNumber(row.id);
  }

  async upsertAreaDoc(params: UpsertAreaDocParams): Promise<number> {
    const now = params.createdAt ?? Date.now();
    const docType = getDocTypeFromRef(params.sourceRef);

    const existing = await this.sql<AreaDocRow[]>`
      SELECT id, doc_type, location_entity_id, content
      FROM search_docs_area
      WHERE source_ref = ${params.sourceRef}
      LIMIT 1
    `;

    if (existing.length === 0) {
      const inserted = await this.sql<{ id: string | number }[]>`
        INSERT INTO search_docs_area (doc_type, source_ref, location_entity_id, content, created_at)
        VALUES (${docType}, ${params.sourceRef}, ${params.locationEntityId}, ${params.content}, ${now})
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
            content = ${params.content}
        WHERE id = ${row.id}
      `;
    }

    return toNumber(row.id);
  }

  async upsertWorldDoc(params: UpsertWorldDocParams): Promise<number> {
    const now = params.createdAt ?? Date.now();
    const docType = getDocTypeFromRef(params.sourceRef);

    const existing = await this.sql<WorldDocRow[]>`
      SELECT id, doc_type, content
      FROM search_docs_world
      WHERE source_ref = ${params.sourceRef}
      LIMIT 1
    `;

    if (existing.length === 0) {
      const inserted = await this.sql<{ id: string | number }[]>`
        INSERT INTO search_docs_world (doc_type, source_ref, content, created_at)
        VALUES (${docType}, ${params.sourceRef}, ${params.content}, ${now})
        RETURNING id
      `;
      return toNumber(inserted[0]?.id);
    }

    const row = existing[0];
    if (row.doc_type !== docType || row.content !== params.content) {
      await this.sql`
        UPDATE search_docs_world
        SET doc_type = ${docType},
            content = ${params.content}
        WHERE id = ${row.id}
      `;
    }

    return toNumber(row.id);
  }

  async upsertCognitionDoc(params: UpsertCognitionDocParams): Promise<number> {
    const now = Date.now();
    const docType = getDocTypeFromRef(params.sourceRef);

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
          (doc_type, source_ref, agent_id, kind, basis, stance, content, updated_at, created_at)
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
            ${params.createdAt ?? now}
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
            updated_at = ${params.updatedAt ?? now}
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

  async deletePrivateDoc(sourceRef: NodeRef, agentId: string): Promise<void> {
    await this.sql`
      DELETE FROM search_docs_private
      WHERE source_ref = ${sourceRef}
        AND agent_id = ${agentId}
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

  async searchPrivate(
    query: string,
    agentId: string,
    limit = 20,
  ): Promise<Array<{
    id: number;
    docType: string;
    sourceRef: string;
    agentId: string;
    content: string;
    createdAt: number;
    score: number;
  }>> {
    const pattern = `%${query}%`;
    const rows = await this.sql<PrivateDocRow[]>`
      SELECT id, doc_type, source_ref, agent_id, content, created_at,
             similarity(content, ${query}) AS score
      FROM search_docs_private
      WHERE agent_id = ${agentId}
        AND (content % ${query} OR content ILIKE ${pattern})
      ORDER BY score DESC, created_at DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      id: toNumber(row.id),
      docType: row.doc_type,
      sourceRef: row.source_ref,
      agentId: row.agent_id,
      content: row.content,
      createdAt: toNumber(row.created_at),
      score: toNumber(row.score),
    }));
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
    const pattern = `%${query}%`;
    const rows = await this.sql<AreaDocRow[]>`
      SELECT id, doc_type, source_ref, location_entity_id, content, created_at,
             similarity(content, ${query}) AS score
      FROM search_docs_area
      WHERE location_entity_id = ${locationEntityId}
        AND (content % ${query} OR content ILIKE ${pattern})
      ORDER BY score DESC, created_at DESC
      LIMIT ${limit}
    `;

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
    const pattern = `%${query}%`;
    const rows = await this.sql<WorldDocRow[]>`
      SELECT id, doc_type, source_ref, content, created_at,
             similarity(content, ${query}) AS score
      FROM search_docs_world
      WHERE content % ${query} OR content ILIKE ${pattern}
      ORDER BY score DESC, created_at DESC
      LIMIT ${limit}
    `;

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
    const pattern = `%${query}%`;
    const rows = await this.sql<CognitionDocRow[]>`
      SELECT id, doc_type, source_ref, agent_id, kind, basis, stance, content, updated_at, created_at,
             similarity(content, ${query}) AS score
      FROM search_docs_cognition
      WHERE agent_id = ${agentId}
        AND (content % ${query} OR content ILIKE ${pattern})
      ORDER BY score DESC, updated_at DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      id: toNumber(row.id),
      docType: row.doc_type,
      sourceRef: row.source_ref,
      agentId: row.agent_id,
      kind: row.kind,
      basis: row.basis,
      stance: row.stance,
      content: row.content,
      updatedAt: toNumber(row.updated_at),
      createdAt: toNumber(row.created_at),
      score: toNumber(row.score),
    }));
  }
}
