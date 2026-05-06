import type postgres from "postgres";

import type { GraphRetrievalEdgeRow } from "../../storage/domain-repos/contracts/graph-retrieval-edge-repo.js";
import { PgGraphRetrievalEdgeRepo } from "../../storage/domain-repos/pg/graph-retrieval-edge-repo.js";
import type { GraphRetrievalConfig } from "./graph-retrieval-config.js";
import { resolveGraphSeeds } from "./graph-seed-resolver.js";

const MIN_EFFECTIVE_EDGE_WEIGHT = 1e-6;

type FallbackReason =
  | "no_visible_seeds"
  | "node_limit_exceeded"
  | "edge_limit_exceeded"
  | "disabled_by_config";

type EntityVisibilityRow = {
  pointer_key: string;
  memory_scope: string;
  owner_agent_id: string | null;
};

type WeightedEdge = {
  sourceRef: string;
  targetRef: string;
  weight: number;
};

export type GraphLoaderResult = {
  nodes: Set<string>;
  adjacency: Map<string, Map<string, number>>;
  seedRefs: string[];
  visibleNodeCount: number;
  visibleEdgeCount: number;
  fallbackReason?: FallbackReason;
};

export type GraphLoaderParams = {
  sql: postgres.Sql;
  viewerAgentId: string;
  queryTime: number;
  config: GraphRetrievalConfig;
  seedHints: GraphSeedHint[];
  sessionId?: string;
};

export type GraphSeedHint = {
  ref: string;
  kind?: "entity" | "alias";
};

export async function loadVisibilityFilteredGraph(params: GraphLoaderParams): Promise<GraphLoaderResult> {
  const seedResolution = await resolveGraphSeeds({
    sql: params.sql,
    hints: params.seedHints,
    viewerAgentId: params.viewerAgentId,
    config: params.config,
  });
  const seedRefs = seedResolution.resolvedRefs;

  if (!params.config.enabled) {
    return emptyGraph(seedRefs, "disabled_by_config");
  }
  if (seedRefs.length === 0) {
    return emptyGraph(seedRefs, "no_visible_seeds");
  }

  const repo = new PgGraphRetrievalEdgeRepo(params.sql);
  const activeEdges = await repo.loadActiveEdges({
    ownerAgentId: params.viewerAgentId,
    visibilityScope: ["shared_public", "private_overlay", "area_visible", "world_public"],
    limit: Math.max(params.config.ppr.maxVisibleEdges * 4, params.config.ppr.maxVisibleEdges, 1),
  });
  const entityEdges = activeEdges.filter((edge) =>
    edge.active &&
    edge.sourceKind === "entity" &&
    edge.targetKind === "entity" &&
    isEdgeVisibleToViewer(edge, params.viewerAgentId)
  );
  const endpointRefs = collectEndpointRefs(entityEdges, seedRefs);
  const visibleEntities = await loadVisibleEntityRefs(params.sql, endpointRefs, params.viewerAgentId);
  const visibleSeedRefs = seedRefs.filter((ref) => visibleEntities.has(ref));

  if (visibleSeedRefs.length === 0) {
    return emptyGraph(visibleSeedRefs, "no_visible_seeds");
  }

  const weightedEdges: WeightedEdge[] = [];
  const visibleNodes = new Set<string>(visibleSeedRefs);
  for (const edge of entityEdges) {
    if (!visibleEntities.has(edge.sourceRef) || !visibleEntities.has(edge.targetRef)) {
      continue;
    }
    const weight = applyRecencyDecay(edge, params.queryTime, params.config, params.sessionId);
    if (weight < MIN_EFFECTIVE_EDGE_WEIGHT) {
      continue;
    }
    visibleNodes.add(edge.sourceRef);
    visibleNodes.add(edge.targetRef);
    weightedEdges.push({ sourceRef: edge.sourceRef, targetRef: edge.targetRef, weight });
  }

  const maxVisibleNodes = resolvePositiveLimit(params.config.ppr.maxVisibleNodes, 2_000);
  if (visibleNodes.size > maxVisibleNodes) {
    console.warn(
      `[graph-loader] visible node limit exceeded: ${visibleNodes.size} > ${maxVisibleNodes}; falling back to seeds only`,
    );
    return {
      nodes: new Set(visibleSeedRefs),
      adjacency: new Map(),
      seedRefs: visibleSeedRefs,
      visibleNodeCount: visibleNodes.size,
      visibleEdgeCount: weightedEdges.length,
      fallbackReason: "node_limit_exceeded",
    };
  }

  const maxVisibleEdges = resolvePositiveLimit(params.config.ppr.maxVisibleEdges, 8_000);
  let edgesForAdjacency = weightedEdges;
  let fallbackReason: FallbackReason | undefined;
  if (weightedEdges.length > maxVisibleEdges) {
    console.warn(
      `[graph-loader] visible edge limit exceeded: ${weightedEdges.length} > ${maxVisibleEdges}; truncating to highest-weight edges`,
    );
    edgesForAdjacency = [...weightedEdges]
      .sort(compareWeightedEdgesBySurvivalPriority)
      .slice(0, maxVisibleEdges);
    fallbackReason = "edge_limit_exceeded";
  }

  const adjacency = normalizeAdjacency(combineDuplicateEdges(edgesForAdjacency));
  const adjacencyNodes = collectAdjacencyNodes(adjacency);
  for (const seed of visibleSeedRefs) {
    adjacencyNodes.add(seed);
  }

  return {
    nodes: adjacencyNodes,
    adjacency,
    seedRefs: visibleSeedRefs,
    visibleNodeCount: adjacencyNodes.size,
    visibleEdgeCount: edgesForAdjacency.length,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

function emptyGraph(seedRefs: string[], fallbackReason: FallbackReason): GraphLoaderResult {
  return {
    nodes: new Set(seedRefs),
    adjacency: new Map(),
    seedRefs,
    visibleNodeCount: seedRefs.length,
    visibleEdgeCount: 0,
    fallbackReason,
  };
}

function isEdgeVisibleToViewer(edge: GraphRetrievalEdgeRow, viewerAgentId: string): boolean {
  if (edge.visibilityScope === "shared_public" || edge.visibilityScope === "area_visible" || edge.visibilityScope === "world_public") {
    return true;
  }
  if (edge.visibilityScope === "private_overlay") {
    return edge.ownerAgentId === viewerAgentId;
  }
  return false;
}

function collectEndpointRefs(edges: GraphRetrievalEdgeRow[], seedRefs: string[]): string[] {
  const refs = new Set(seedRefs);
  for (const edge of edges) {
    refs.add(edge.sourceRef);
    refs.add(edge.targetRef);
  }
  return [...refs];
}

async function loadVisibleEntityRefs(
  sql: postgres.Sql,
  refs: string[],
  viewerAgentId: string,
): Promise<Set<string>> {
  if (refs.length === 0) {
    return new Set();
  }
  const rows = await sql<EntityVisibilityRow[]>`
    SELECT pointer_key, memory_scope, owner_agent_id
    FROM entity_nodes
    WHERE pointer_key = ANY(${refs})
  `;
  const visible = new Set<string>();
  for (const row of rows) {
    if (isEntityVisibleToViewer(row, viewerAgentId)) {
      visible.add(row.pointer_key);
    }
  }
  return visible;
}

function isEntityVisibleToViewer(entity: EntityVisibilityRow, viewerAgentId: string): boolean {
  if (entity.memory_scope === "shared_public" || entity.memory_scope === "area_visible" || entity.memory_scope === "world_public") {
    return true;
  }
  if (entity.memory_scope === "private_overlay") {
    return entity.owner_agent_id === viewerAgentId;
  }
  return false;
}

function applyRecencyDecay(
  edge: GraphRetrievalEdgeRow,
  queryTime: number,
  config: GraphRetrievalConfig,
  sessionId: string | undefined,
): number {
  const ageMs = Math.max(0, queryTime - edge.lastSeenAt);
  const halfLifeMs = selectHalfLifeMs(edge, config, sessionId);
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) {
    return edge.weight;
  }
  return edge.weight * Math.exp(-ageMs / halfLifeMs);
}

function selectHalfLifeMs(
  edge: GraphRetrievalEdgeRow,
  config: GraphRetrievalConfig,
  sessionId: string | undefined,
): number {
  if (
    config.recency.scope === "session" &&
    sessionId &&
    (edge.sourcePassageRefs ?? []).some((ref) => ref === sessionId || ref.includes(sessionId))
  ) {
    return config.recency.sessionHalfLifeMs;
  }
  return config.recency.globalHalfLifeMs;
}

function combineDuplicateEdges(edges: WeightedEdge[]): Map<string, Map<string, number>> {
  const adjacency = new Map<string, Map<string, number>>();
  for (const edge of edges) {
    const outgoing = adjacency.get(edge.sourceRef) ?? new Map<string, number>();
    outgoing.set(edge.targetRef, (outgoing.get(edge.targetRef) ?? 0) + edge.weight);
    adjacency.set(edge.sourceRef, outgoing);
  }
  return adjacency;
}

function normalizeAdjacency(adjacency: Map<string, Map<string, number>>): Map<string, Map<string, number>> {
  const normalized = new Map<string, Map<string, number>>();
  for (const [sourceRef, outgoing] of adjacency.entries()) {
    let total = 0;
    for (const weight of outgoing.values()) {
      total += weight;
    }
    if (total <= 0) {
      continue;
    }
    const normalizedOutgoing = new Map<string, number>();
    for (const [targetRef, weight] of outgoing.entries()) {
      normalizedOutgoing.set(targetRef, weight / total);
    }
    normalized.set(sourceRef, normalizedOutgoing);
  }
  return normalized;
}

function collectAdjacencyNodes(adjacency: Map<string, Map<string, number>>): Set<string> {
  const nodes = new Set<string>();
  for (const [sourceRef, outgoing] of adjacency.entries()) {
    nodes.add(sourceRef);
    for (const targetRef of outgoing.keys()) {
      nodes.add(targetRef);
    }
  }
  return nodes;
}

function compareWeightedEdgesBySurvivalPriority(a: WeightedEdge, b: WeightedEdge): number {
  return b.weight - a.weight ||
    a.sourceRef.localeCompare(b.sourceRef) ||
    a.targetRef.localeCompare(b.targetRef);
}

function resolvePositiveLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}
