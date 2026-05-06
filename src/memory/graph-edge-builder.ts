import type postgres from "postgres";

import type {
  DerivedEdgeKind,
  GraphRetrievalEdgeInsert,
} from "../storage/domain-repos/contracts/graph-retrieval-edge-repo.js";
import { PgGraphRetrievalEdgeRepo } from "../storage/domain-repos/pg/graph-retrieval-edge-repo.js";
import {
  DEFAULT_GRAPH_RETRIEVAL_CONFIG,
  type GraphRetrievalConfig,
} from "./retrieval/graph-retrieval-config.js";

const PG_MAX_BIGINT = "9223372036854775807";
const DEFAULT_ALGORITHM_VERSION = "v1";
const CONTRASTIVE_FACT_PREDICATES = new Set(["contrasts_with", "conflicts_with"]);

type GraphEdgeVisibilityScope =
  | "shared_public"
  | "private_overlay"
  | "area_visible"
  | "world_public";

type GraphEdgeNodeKind = "entity" | "episode" | "cognition";

export type BuildGraphEdgesParams = {
  sql: postgres.Sql;
  agentId: string;
  runId: string;
  algorithmVersion?: string;
  config?: GraphRetrievalConfig;
};

export type BuildGraphEdgesResult = {
  runId: string;
  mentionEdges: number;
  cooccurrenceEdges: number;
  factEdges: number;
  semanticEdges: number;
  totalInserted: number;
};

export type GraphEdgeBuilderPassageInput = {
  ref: string;
  kind: "episode" | "cognition";
  entityPointerKeys: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  visibilityScope: GraphEdgeVisibilityScope;
  ownerAgentId: string | null;
};

export type GraphEdgeBuilderFactInput = {
  id: number;
  sourceRef: string;
  targetRef: string;
  predicate: string;
  firstSeenAt: number;
  lastSeenAt: number;
  visibilityScope: GraphEdgeVisibilityScope;
  ownerAgentId: string | null;
};

export type GraphEdgeBuilderSemanticInput = {
  id: string;
  sourceRef: string;
  targetRef: string;
  weight: number;
  firstSeenAt: number;
  lastSeenAt: number;
  visibilityScope: GraphEdgeVisibilityScope;
  ownerAgentId: string | null;
};

export type MaterializeGraphRetrievalEdgesInput = {
  runId: string;
  algorithmVersion?: string;
  config?: GraphRetrievalConfig;
  passages: GraphEdgeBuilderPassageInput[];
  facts?: GraphEdgeBuilderFactInput[];
  semantics?: GraphEdgeBuilderSemanticInput[];
};

export type MaterializeGraphRetrievalEdgesResult = BuildGraphEdgesResult & {
  edges: GraphRetrievalEdgeInsert[];
};

type EpisodePointerRow = {
  id: number | string;
  agent_id: string;
  created_at: number | string;
  entity_pointer_keys: string[] | null;
};

type CognitionPointerRow = {
  id: number | string;
  agent_id: string;
  cognition_key: string;
  kind: string;
  record_json: unknown;
  updated_at: number | string;
};

type FactEdgeRow = {
  id: number | string;
  source_pointer_key: string;
  target_pointer_key: string;
  predicate: string;
  t_created: number | string;
  owner_agent_id: string | null;
};

type SemanticEdgeRow = {
  id: number | string;
  source: string;
  target: string;
  weight: number | string;
  created_at: number | string;
  updated_at: number | string;
  owner_agent_id?: string | null;
};

type CooccurrenceAccumulator = {
  a: string;
  b: string;
  passageRefs: string[];
  passageRefSet: Set<string>;
  firstSeenAt: number;
  lastSeenAt: number;
  visibilityScope: GraphEdgeVisibilityScope;
  ownerAgentId: string | null;
};

export async function buildGraphRetrievalEdges(
  params: BuildGraphEdgesParams,
): Promise<BuildGraphEdgesResult> {
  const algorithmVersion = params.algorithmVersion ?? DEFAULT_ALGORITHM_VERSION;
  const config = params.config ?? DEFAULT_GRAPH_RETRIEVAL_CONFIG;
  const [episodes, cognitions, facts, semantics] = await Promise.all([
    loadEpisodePassages(params.sql, params.agentId),
    loadCognitionPassages(params.sql, params.agentId),
    loadFactEdges(params.sql, params.agentId),
    loadSemanticEdges(params.sql, params.agentId),
  ]);

  const materialized = materializeGraphRetrievalEdges({
    runId: params.runId,
    algorithmVersion,
    config,
    passages: [...episodes, ...cognitions],
    facts,
    semantics,
  });

  const repo = new PgGraphRetrievalEdgeRepo(params.sql);
  await repo.insertBatch(materialized.edges);
  await repo.atomicSwapRun(params.runId);

  return {
    runId: materialized.runId,
    mentionEdges: materialized.mentionEdges,
    cooccurrenceEdges: materialized.cooccurrenceEdges,
    factEdges: materialized.factEdges,
    semanticEdges: materialized.semanticEdges,
    totalInserted: materialized.totalInserted,
  };
}

export function materializeGraphRetrievalEdges(
  input: MaterializeGraphRetrievalEdgesInput,
): MaterializeGraphRetrievalEdgesResult {
  const algorithmVersion = input.algorithmVersion ?? DEFAULT_ALGORITHM_VERSION;
  const config = input.config ?? DEFAULT_GRAPH_RETRIEVAL_CONFIG;
  const facts = input.facts ?? [];
  const semantics = input.semantics ?? [];
  const contrastivePairs = buildContrastivePairSet(facts);

  const mentionEdges = buildMentionEdges(input.runId, algorithmVersion, input.passages);
  const cooccurrenceEdges = buildCooccurrenceEdges(
    input.runId,
    algorithmVersion,
    input.passages,
    contrastivePairs,
    config,
  );
  const factEdges = buildFactEdges(input.runId, algorithmVersion, facts, config);
  const semanticEdges = buildSemanticEdges(input.runId, algorithmVersion, semantics);
  const edges = stableSortEdges([
    ...mentionEdges,
    ...cooccurrenceEdges,
    ...factEdges,
    ...semanticEdges,
  ]);

  return {
    runId: input.runId,
    mentionEdges: mentionEdges.length,
    cooccurrenceEdges: cooccurrenceEdges.length,
    factEdges: factEdges.length,
    semanticEdges: semanticEdges.length,
    totalInserted: edges.length,
    edges,
  };
}

async function loadEpisodePassages(
  sql: postgres.Sql,
  agentId: string,
): Promise<GraphEdgeBuilderPassageInput[]> {
  const rows = await sql<EpisodePointerRow[]>`
    SELECT id, agent_id, created_at, entity_pointer_keys
    FROM private_episode_events
    WHERE agent_id = ${agentId}
      AND array_length(entity_pointer_keys, 1) > 0
    ORDER BY created_at ASC, id ASC
  `;

  return rows.map((row) => {
    const seenAt = Number(row.created_at);
    return {
      ref: `ep:${row.id}`,
      kind: "episode",
      entityPointerKeys: normalizePointerKeys(row.entity_pointer_keys ?? []),
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      visibilityScope: "private_overlay",
      ownerAgentId: row.agent_id,
    };
  });
}

async function loadCognitionPassages(
  sql: postgres.Sql,
  agentId: string,
): Promise<GraphEdgeBuilderPassageInput[]> {
  const rows = await sql<CognitionPointerRow[]>`
    SELECT id, agent_id, cognition_key, kind, record_json, updated_at
    FROM private_cognition_current
    WHERE agent_id = ${agentId}
      AND COALESCE(status, 'active') = 'active'
    ORDER BY updated_at ASC, id ASC
  `;

  return rows
    .map((row): GraphEdgeBuilderPassageInput | undefined => {
      const entityPointerKeys = extractCognitionPointerKeys(row.record_json);
      if (entityPointerKeys.length === 0) {
        return undefined;
      }
      const seenAt = Number(row.updated_at);
      return {
        ref: `cog:${row.cognition_key}`,
        kind: "cognition" as const,
        entityPointerKeys,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        visibilityScope: "private_overlay" as const,
        ownerAgentId: row.agent_id,
      };
    })
    .filter((passage): passage is GraphEdgeBuilderPassageInput => passage !== undefined);
}

async function loadFactEdges(
  sql: postgres.Sql,
  agentId: string,
): Promise<GraphEdgeBuilderFactInput[]> {
  // Visibility filter: include the agent's private facts AND any
  // shared/public facts (owner_agent_id IS NULL). The previous filter
  // `fe.owner_agent_id = ${agentId}` excluded all world-level facts —
  // e.g. `location_of(管家, 庄园)` — so PPR could never traverse them.
  // Plan Task 12 acceptance requires "Active controlled fact edges
  // affect PPR traversal" for the agent's visible scope, which the
  // VisibilityPolicy treats as the union of private-owned and shared.
  const rows = await sql<FactEdgeRow[]>`
    SELECT
      fe.id,
      source_entity.pointer_key AS source_pointer_key,
      target_entity.pointer_key AS target_pointer_key,
      fe.predicate,
      fe.t_created,
      fe.owner_agent_id
    FROM fact_edges fe
    JOIN entity_nodes source_entity ON source_entity.id = fe.source_entity_id
    JOIN entity_nodes target_entity ON target_entity.id = fe.target_entity_id
    WHERE (fe.owner_agent_id = ${agentId} OR fe.owner_agent_id IS NULL)
      AND fe.t_invalid = ${PG_MAX_BIGINT}
      AND fe.t_expired = ${PG_MAX_BIGINT}
    ORDER BY fe.t_created ASC, fe.id ASC
  `;

  return rows.map((row) => {
    const seenAt = Number(row.t_created);
    return {
      id: Number(row.id),
      sourceRef: row.source_pointer_key,
      targetRef: row.target_pointer_key,
      predicate: row.predicate,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      // Mirror loadSemanticEdges: shared facts (owner null) get
      // shared_public; agent-owned facts stay private_overlay.
      visibilityScope: row.owner_agent_id ? "private_overlay" : "shared_public",
      ownerAgentId: row.owner_agent_id ?? null,
    };
  });
}

async function loadSemanticEdges(
  sql: postgres.Sql,
  agentId: string,
): Promise<GraphEdgeBuilderSemanticInput[]> {
  const hasOwnerAgentId = await hasColumn(sql, "semantic_edges", "owner_agent_id");
  const rows = hasOwnerAgentId
    ? await sql<SemanticEdgeRow[]>`
        SELECT id, source, target, weight, created_at, updated_at, owner_agent_id
        FROM semantic_edges
        WHERE owner_agent_id = ${agentId} OR owner_agent_id IS NULL
        ORDER BY updated_at ASC, id ASC
      `
    : await sql<SemanticEdgeRow[]>`
        SELECT id, source, target, weight, created_at, updated_at
        FROM semantic_edges
        ORDER BY updated_at ASC, id ASC
      `;

  return rows.map((row) => ({
    id: String(row.id),
    sourceRef: row.source,
    targetRef: row.target,
    weight: Number(row.weight),
    firstSeenAt: Number(row.created_at),
    lastSeenAt: Number(row.updated_at),
    visibilityScope: row.owner_agent_id ? "private_overlay" : "shared_public",
    ownerAgentId: row.owner_agent_id ?? null,
  }));
}

async function hasColumn(
  sql: postgres.Sql,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const rows = await sql<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ${tableName}
        AND column_name = ${columnName}
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

function buildMentionEdges(
  runId: string,
  algorithmVersion: string,
  passages: GraphEdgeBuilderPassageInput[],
): GraphRetrievalEdgeInsert[] {
  const edges: GraphRetrievalEdgeInsert[] = [];
  for (const passage of passages) {
    const edgeKind: DerivedEdgeKind = passage.kind === "episode"
      ? "mention_episode_entity"
      : "mention_cognition_entity";
    for (const pointerKey of normalizePointerKeys(passage.entityPointerKeys)) {
      edges.push({
        runId,
        algorithmVersion,
        edgeKind,
        sourceRef: passage.ref,
        sourceKind: passage.kind,
        targetRef: pointerKey,
        targetKind: "entity",
        weight: 1,
        visibilityScope: passage.visibilityScope,
        ownerAgentId: passage.ownerAgentId,
        firstSeenAt: passage.firstSeenAt,
        lastSeenAt: passage.lastSeenAt,
        sourcePassageRefs: [passage.ref],
        sourceHash: sourceHash(runId, edgeKind, passage.ref, pointerKey),
      });
    }
  }
  return dedupeEdges(edges);
}

function buildCooccurrenceEdges(
  runId: string,
  algorithmVersion: string,
  passages: GraphEdgeBuilderPassageInput[],
  contrastivePairs: Set<string>,
  config: GraphRetrievalConfig,
): GraphRetrievalEdgeInsert[] {
  const accumulators = new Map<string, CooccurrenceAccumulator>();

  for (const passage of passages) {
    const keys = normalizePointerKeys(passage.entityPointerKeys).sort((a, b) => a.localeCompare(b));
    if (keys.length < 2) {
      continue;
    }
    for (let i = 0; i < keys.length - 1; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const a = keys[i];
        const b = keys[j];
        const pairKey = entityPairKey(a, b);
        const existing = accumulators.get(pairKey);
        if (existing) {
          if (!existing.passageRefSet.has(passage.ref)) {
            existing.passageRefSet.add(passage.ref);
            existing.passageRefs.push(passage.ref);
          }
          existing.firstSeenAt = Math.min(existing.firstSeenAt, passage.firstSeenAt);
          existing.lastSeenAt = Math.max(existing.lastSeenAt, passage.lastSeenAt);
          continue;
        }
        accumulators.set(pairKey, {
          a,
          b,
          passageRefs: [passage.ref],
          passageRefSet: new Set([passage.ref]),
          firstSeenAt: passage.firstSeenAt,
          lastSeenAt: passage.lastSeenAt,
          visibilityScope: passage.visibilityScope,
          ownerAgentId: passage.ownerAgentId,
        });
      }
    }
  }

  const directedCandidates: GraphRetrievalEdgeInsert[] = [];
  for (const accumulator of accumulators.values()) {
    const isContrastive = contrastivePairs.has(entityPairKey(accumulator.a, accumulator.b));
    const edgeKind: DerivedEdgeKind = isContrastive
      ? "cooccurrence_contrastive"
      : "cooccurrence_associative";
    const count = accumulator.passageRefs.length;
    const baseWeight = Math.min(config.cooccurrence.maxWeight, Math.log1p(count));
    const weight = isContrastive
      ? baseWeight * config.cooccurrence.contrastiveMultiplier
      : baseWeight;
    for (const [sourceRef, targetRef] of [
      [accumulator.a, accumulator.b],
      [accumulator.b, accumulator.a],
    ] as const) {
      directedCandidates.push({
        runId,
        algorithmVersion,
        edgeKind,
        sourceRef,
        sourceKind: "entity",
        targetRef,
        targetKind: "entity",
        weight,
        visibilityScope: accumulator.visibilityScope,
        ownerAgentId: accumulator.ownerAgentId,
        firstSeenAt: accumulator.firstSeenAt,
        lastSeenAt: accumulator.lastSeenAt,
        sourcePassageRefs: [...accumulator.passageRefs].sort((a, b) => a.localeCompare(b)),
        sourceHash: sourceHash(runId, edgeKind, sourceRef, targetRef),
      });
    }
  }

  return applyDegreeCap(directedCandidates, config.cooccurrence.degreeCap);
}

function buildFactEdges(
  runId: string,
  algorithmVersion: string,
  facts: GraphEdgeBuilderFactInput[],
  config: GraphRetrievalConfig,
): GraphRetrievalEdgeInsert[] {
  return facts.map((fact) => {
    const weight = fact.predicate === "contrasts_with"
      ? config.cooccurrence.contrastiveMultiplier
      : 1;
    const edgeKind: DerivedEdgeKind = "fact_relation";
    return {
      runId,
      algorithmVersion,
      edgeKind,
      sourceRef: fact.sourceRef,
      sourceKind: "entity",
      targetRef: fact.targetRef,
      targetKind: "entity",
      weight,
      visibilityScope: fact.visibilityScope,
      ownerAgentId: fact.ownerAgentId,
      firstSeenAt: fact.firstSeenAt,
      lastSeenAt: fact.lastSeenAt,
      sourceFactEdgeIds: [fact.id],
      sourceHash: sourceHash(runId, edgeKind, fact.sourceRef, fact.targetRef, String(fact.id)),
    };
  });
}

function buildSemanticEdges(
  runId: string,
  algorithmVersion: string,
  semantics: GraphEdgeBuilderSemanticInput[],
): GraphRetrievalEdgeInsert[] {
  const edges: GraphRetrievalEdgeInsert[] = [];
  for (const semantic of semantics) {
    const sourceKind = inferGraphEdgeNodeKind(semantic.sourceRef);
    const targetKind = inferGraphEdgeNodeKind(semantic.targetRef);
    if (!sourceKind || !targetKind) {
      continue;
    }
    const edgeKind: DerivedEdgeKind = "semantic_projection";
    edges.push({
      runId,
      algorithmVersion,
      edgeKind,
      sourceRef: semantic.sourceRef,
      sourceKind,
      targetRef: semantic.targetRef,
      targetKind,
      weight: semantic.weight,
      visibilityScope: semantic.visibilityScope,
      ownerAgentId: semantic.ownerAgentId,
      firstSeenAt: semantic.firstSeenAt,
      lastSeenAt: semantic.lastSeenAt,
      sourceSemanticEdgeRefs: [semantic.id],
      sourceHash: sourceHash(runId, edgeKind, semantic.sourceRef, semantic.targetRef, semantic.id),
    });
  }
  return edges;
}

function applyDegreeCap(
  edges: GraphRetrievalEdgeInsert[],
  rawDegreeCap: number,
): GraphRetrievalEdgeInsert[] {
  const degreeCap = Math.max(0, Math.floor(rawDegreeCap));
  const grouped = new Map<string, GraphRetrievalEdgeInsert[]>();
  for (const edge of edges) {
    const bucket = grouped.get(edge.sourceRef) ?? [];
    bucket.push(edge);
    grouped.set(edge.sourceRef, bucket);
  }

  const capped: GraphRetrievalEdgeInsert[] = [];
  for (const [sourceRef, bucket] of grouped.entries()) {
    bucket.sort(compareCooccurrenceBySurvivalPriority);
    const survivors = bucket.slice(0, degreeCap);
    const skipped = bucket.length - survivors.length;
    if (skipped > 0) {
      console.warn(
        `[graph-edge-builder] cooccurrence degree cap skipped ${skipped} outgoing edges for ${sourceRef}`,
      );
    }
    capped.push(...survivors);
  }
  return stableSortEdges(capped);
}

function compareCooccurrenceBySurvivalPriority(
  a: GraphRetrievalEdgeInsert,
  b: GraphRetrievalEdgeInsert,
): number {
  return b.weight - a.weight ||
    b.lastSeenAt - a.lastSeenAt ||
    a.targetRef.localeCompare(b.targetRef) ||
    a.sourceRef.localeCompare(b.sourceRef);
}

function buildContrastivePairSet(facts: GraphEdgeBuilderFactInput[]): Set<string> {
  const pairs = new Set<string>();
  for (const fact of facts) {
    if (CONTRASTIVE_FACT_PREDICATES.has(fact.predicate)) {
      pairs.add(entityPairKey(fact.sourceRef, fact.targetRef));
    }
  }
  return pairs;
}

function extractCognitionPointerKeys(recordJson: unknown): string[] {
  if (!recordJson || typeof recordJson !== "object") {
    return [];
  }
  const record = recordJson as Record<string, unknown>;
  const keys: string[] = [];
  collectPointerValue(record.holderPointerKey, keys);
  collectPointerValue(record.sourcePointerKey, keys);
  collectPointerValue(record.targetPointerKey, keys);
  collectPointerValue(record.holderId, keys);
  collectPointerArray(record.entityPointerKeys, keys);
  collectPointerArray(record.entityRefs, keys);
  return normalizePointerKeys(keys);
}

function collectPointerArray(value: unknown, output: string[]): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    collectPointerValue(item, output);
  }
}

function collectPointerValue(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (value && typeof value === "object") {
    const nestedValue = (value as Record<string, unknown>).value;
    if (typeof nestedValue === "string") {
      output.push(nestedValue);
    }
  }
}

function normalizePointerKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const key of keys) {
    const pointerKey = key.normalize("NFC").trim();
    if (pointerKey.length === 0 || seen.has(pointerKey)) {
      continue;
    }
    seen.add(pointerKey);
    normalized.push(pointerKey);
  }
  return normalized;
}

function inferGraphEdgeNodeKind(ref: string): GraphEdgeNodeKind | null {
  if (ref.startsWith("ep:") || ref.startsWith("episode:")) {
    return "episode";
  }
  if (
    ref.startsWith("cog:") ||
    ref.startsWith("assertion:") ||
    ref.startsWith("evaluation:") ||
    ref.startsWith("commitment:")
  ) {
    return "cognition";
  }
  if (ref.startsWith("event:") || ref.startsWith("fact:")) {
    return null;
  }
  return "entity";
}

function entityPairKey(a: string, b: string): string {
  return a.localeCompare(b) <= 0 ? `${a}\0${b}` : `${b}\0${a}`;
}

function sourceHash(
  runId: string,
  edgeKind: DerivedEdgeKind,
  sourceRef: string,
  targetRef: string,
  discriminator?: string,
): string {
  return [runId, edgeKind, sourceRef, targetRef, discriminator].filter(Boolean).join(":");
}

function dedupeEdges(edges: GraphRetrievalEdgeInsert[]): GraphRetrievalEdgeInsert[] {
  const byHash = new Map<string, GraphRetrievalEdgeInsert>();
  for (const edge of edges) {
    if (!edge.sourceHash) {
      continue;
    }
    byHash.set(edge.sourceHash, edge);
  }
  return stableSortEdges([...byHash.values()]);
}

function stableSortEdges(edges: GraphRetrievalEdgeInsert[]): GraphRetrievalEdgeInsert[] {
  return [...edges].sort((a, b) =>
    a.edgeKind.localeCompare(b.edgeKind) ||
    a.sourceRef.localeCompare(b.sourceRef) ||
    a.targetRef.localeCompare(b.targetRef) ||
    a.firstSeenAt - b.firstSeenAt,
  );
}
