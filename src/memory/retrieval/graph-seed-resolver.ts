import type postgres from "postgres";

import { PgAliasRepo } from "../../storage/domain-repos/pg/alias-repo.js";
import type { GraphRetrievalConfig } from "./graph-retrieval-config.js";
import type { GraphSeedHint } from "./graph-loader.js";

type EntityPointerRow = {
  pointer_key: string;
};

type DenseSeedRow = {
  pointer_key: string;
  similarity: number | string;
};

export type SeedResolutionResult = {
  resolvedRefs: string[];
  aliasHits: number;
  denseHits: number;
  missingRefs: string[];
};

export async function resolveGraphSeeds(params: {
  sql: postgres.Sql;
  hints: GraphSeedHint[];
  viewerAgentId: string;
  config: GraphRetrievalConfig;
}): Promise<SeedResolutionResult> {
  const maxSeeds = Math.max(0, Math.floor(params.config.seed.linkingTopK || 5));
  if (maxSeeds === 0 || params.hints.length === 0) {
    return { resolvedRefs: [], aliasHits: 0, denseHits: 0, missingRefs: params.hints.map((hint) => hint.ref) };
  }

  const aliasRepo = new PgAliasRepo(params.sql);
  const resolved = new Set<string>();
  const unresolved: GraphSeedHint[] = [];
  let aliasHits = 0;

  for (const hint of params.hints) {
    const normalized = normalizeHintRef(hint.ref);
    if (normalized.length === 0) {
      unresolved.push(hint);
      continue;
    }

    const aliasRef = await resolveAliasToPointerKey(params.sql, aliasRepo, normalized, params.viewerAgentId);
    if (aliasRef) {
      if (!resolved.has(aliasRef)) {
        aliasHits += 1;
      }
      resolved.add(aliasRef);
      if (resolved.size >= maxSeeds) break;
      continue;
    }

    const directRef = await resolveDirectPointerKey(params.sql, normalized, params.viewerAgentId);
    if (directRef) {
      if (!resolved.has(directRef)) {
        aliasHits += 1;
      }
      resolved.add(directRef);
      if (resolved.size >= maxSeeds) break;
      continue;
    }

    unresolved.push({ ...hint, ref: normalized });
  }

  let denseHits = 0;
  const missingRefs: string[] = [];
  if (resolved.size < maxSeeds && unresolved.length > 0 && await hasDenseSeedRows(params.sql)) {
    for (const hint of unresolved) {
      if (resolved.size >= maxSeeds) break;
      const before = resolved.size;
      const denseRefs = await resolveDenseSeeds(params.sql, hint.ref, params.viewerAgentId, params.config, maxSeeds);
      for (const ref of denseRefs) {
        if (resolved.size >= maxSeeds) break;
        if (!resolved.has(ref)) {
          resolved.add(ref);
          denseHits += 1;
        }
      }
      if (resolved.size === before) {
        missingRefs.push(hint.ref);
      }
    }
  } else {
    missingRefs.push(...unresolved.map((hint) => hint.ref));
  }

  return {
    resolvedRefs: [...resolved].slice(0, maxSeeds),
    aliasHits,
    denseHits,
    missingRefs,
  };
}

function normalizeHintRef(ref: string): string {
  return ref.normalize("NFKC").trim();
}

async function resolveAliasToPointerKey(
  sql: postgres.Sql,
  aliasRepo: PgAliasRepo,
  normalizedRef: string,
  viewerAgentId: string,
): Promise<string | null> {
  const canonicalId = await aliasRepo.resolveAlias(normalizedRef, viewerAgentId);
  if (canonicalId === null) {
    return null;
  }
  const rows = await sql<EntityPointerRow[]>`
    SELECT pointer_key
    FROM entity_nodes
    WHERE id = ${canonicalId}
      AND (
        memory_scope = 'shared_public'
        OR (memory_scope = 'private_overlay' AND owner_agent_id = ${viewerAgentId})
        OR memory_scope IN ('area_visible', 'world_public')
      )
    LIMIT 1
  `;
  return rows[0]?.pointer_key ?? null;
}

async function resolveDirectPointerKey(
  sql: postgres.Sql,
  normalizedRef: string,
  viewerAgentId: string,
): Promise<string | null> {
  const rows = await sql<EntityPointerRow[]>`
    SELECT pointer_key
    FROM entity_nodes
    WHERE (pointer_key = ${normalizedRef} OR LOWER(pointer_key) = LOWER(${normalizedRef}))
      AND (
        memory_scope = 'shared_public'
        OR (memory_scope = 'private_overlay' AND owner_agent_id = ${viewerAgentId})
        OR memory_scope IN ('area_visible', 'world_public')
      )
    ORDER BY
      CASE WHEN pointer_key = ${normalizedRef} THEN 0 ELSE 1 END,
      CASE WHEN memory_scope = 'private_overlay' THEN 0 ELSE 1 END
    LIMIT 1
  `;
  return rows[0]?.pointer_key ?? null;
}

async function hasDenseSeedRows(sql: postgres.Sql): Promise<boolean> {
  try {
    const rows = await sql<Array<{ has_rows: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM node_embeddings LIMIT 1) AS has_rows
    `;
    return rows[0]?.has_rows === true;
  } catch {
    return false;
  }
}

async function resolveDenseSeeds(
  sql: postgres.Sql,
  normalizedRef: string,
  viewerAgentId: string,
  config: GraphRetrievalConfig,
  remainingSeedLimit: number,
): Promise<string[]> {
  const limit = Math.max(1, Math.floor(config.seed.linkingTopK || 5));
  const threshold = Number.isFinite(config.seed.similarityThreshold)
    ? config.seed.similarityThreshold
    : 0.75;

  try {
    const rows = await sql<DenseSeedRow[]>`
      WITH query_embedding AS (
        SELECT embedding, model_id
        FROM node_embeddings
        WHERE node_ref = ${normalizedRef}
          AND node_kind = 'entity'
        ORDER BY updated_at DESC
        LIMIT 1
      )
      SELECT entity_nodes.pointer_key, 1 - (node_embeddings.embedding <=> query_embedding.embedding) AS similarity
      FROM query_embedding
      JOIN node_embeddings ON node_embeddings.model_id = query_embedding.model_id
        AND node_embeddings.node_kind = 'entity'
      JOIN entity_nodes ON entity_nodes.pointer_key = node_embeddings.node_ref
      WHERE (
          entity_nodes.memory_scope = 'shared_public'
          OR (entity_nodes.memory_scope = 'private_overlay' AND entity_nodes.owner_agent_id = ${viewerAgentId})
          OR entity_nodes.memory_scope IN ('area_visible', 'world_public')
        )
        AND (1 - (node_embeddings.embedding <=> query_embedding.embedding)) >= ${threshold}
      ORDER BY node_embeddings.embedding <=> query_embedding.embedding ASC, entity_nodes.pointer_key ASC
      LIMIT ${Math.min(limit, remainingSeedLimit)}
    `;
    return rows.map((row) => row.pointer_key);
  } catch {
    return [];
  }
}
