/**
 * Centralized RelationContract registry — single source of truth for all
 * relation type definitions across the memory subsystem.
 *
 * @see docs/MEMORY_RELATION_CONTRACT.md
 */

import type {
  EdgeLayer,
  EdgeLifecycle,
  MemoryRelationType,
  NodeRefKind,
} from "../types.js";

export type EndpointFamily = NodeRefKind | "unknown";

export type RelationContract = {
  source_family: EndpointFamily;
  target_family: EndpointFamily;
  truth_bearing: boolean;
  heuristic_only: boolean;
  layer: EdgeLayer;
  temporal: boolean;
  lifecycle: EdgeLifecycle;
  cardinality_per_source?: number;
};

export type EdgeSemanticsTable =
  | "logic_edges"
  | "memory_relations"
  | "semantic_edges"
  | "fact_edges";

export type EdgeSemanticsEndpointFamily = NodeRefKind | "any";

export type EdgeSemantics = {
  table: EdgeSemanticsTable;
  layer: EdgeLayer;
  endpointFamilies: readonly [EdgeSemanticsEndpointFamily, EdgeSemanticsEndpointFamily];
  truthBearing: boolean;
  heuristicOnly: boolean;
  temporal: boolean;
  lifecycle: EdgeLifecycle;
  cardinality_per_source?: number;
};

export const FACT_EDGE_PREDICATE_WILDCARD = "__fact_edge_wildcard__" as const;

export const EDGE_SEMANTICS_BY_TABLE = {
  logic_edges: {
    causal: {
      table: "logic_edges",
      layer: "narrative",
      endpointFamilies: ["event", "event"],
      truthBearing: true,
      heuristicOnly: false,
      temporal: false,
      lifecycle: "immutable",
    },
    contradict: {
      table: "logic_edges",
      layer: "narrative",
      endpointFamilies: ["event", "event"],
      truthBearing: true,
      heuristicOnly: false,
      temporal: false,
      lifecycle: "immutable",
    },
    reinforce: {
      table: "logic_edges",
      layer: "narrative",
      endpointFamilies: ["event", "event"],
      truthBearing: true,
      heuristicOnly: false,
      temporal: false,
      lifecycle: "immutable",
    },
    temporal_prev: {
      table: "logic_edges",
      layer: "narrative",
      endpointFamilies: ["event", "event"],
      truthBearing: true,
      heuristicOnly: false,
      temporal: false,
      lifecycle: "immutable",
      cardinality_per_source: 1,
    },
    temporal_next: {
      table: "logic_edges",
      layer: "narrative",
      endpointFamilies: ["event", "event"],
      truthBearing: true,
      heuristicOnly: false,
      temporal: false,
      lifecycle: "immutable",
      cardinality_per_source: 1,
    },
    same_episode: {
      table: "logic_edges",
      layer: "narrative",
      endpointFamilies: ["event", "event"],
      truthBearing: true,
      heuristicOnly: false,
      temporal: false,
      lifecycle: "immutable",
    },
  },
  memory_relations: {
    supports: {
      table: "memory_relations",
      layer: "cognitive",
      endpointFamilies: ["event", "assertion"],
      truthBearing: true,
      heuristicOnly: false,
      temporal: false,
      lifecycle: "immutable",
    },
    triggered: {
      table: "memory_relations",
      layer: "cognitive",
      endpointFamilies: ["event", "evaluation"],
      truthBearing: true,
      heuristicOnly: false,
      temporal: false,
      lifecycle: "immutable",
    },
    conflicts_with: {
      table: "memory_relations",
      layer: "cognitive",
      endpointFamilies: ["assertion", "assertion"],
      truthBearing: true,
      heuristicOnly: false,
      temporal: false,
      lifecycle: "immutable",
    },
    derived_from: {
      table: "memory_relations",
      layer: "cognitive",
      endpointFamilies: ["fact", "assertion"],
      truthBearing: true,
      heuristicOnly: false,
      temporal: false,
      lifecycle: "immutable",
    },
    supersedes: {
      table: "memory_relations",
      layer: "cognitive",
      endpointFamilies: ["assertion", "assertion"],
      truthBearing: true,
      heuristicOnly: false,
      temporal: false,
      lifecycle: "immutable",
    },
    surfaced_as: {
      table: "memory_relations",
      layer: "cognitive",
      endpointFamilies: ["assertion", "event"],
      truthBearing: true,
      heuristicOnly: false,
      temporal: false,
      lifecycle: "immutable",
    },
    published_as: {
      table: "memory_relations",
      layer: "cognitive",
      endpointFamilies: ["event", "entity"],
      truthBearing: true,
      heuristicOnly: false,
      temporal: false,
      lifecycle: "immutable",
    },
    resolved_by: {
      table: "memory_relations",
      layer: "cognitive",
      endpointFamilies: ["assertion", "fact"],
      truthBearing: false,
      heuristicOnly: true,
      temporal: false,
      lifecycle: "regenerable",
    },
    downgraded_by: {
      table: "memory_relations",
      layer: "cognitive",
      endpointFamilies: ["assertion", "evaluation"],
      truthBearing: false,
      heuristicOnly: true,
      temporal: false,
      lifecycle: "regenerable",
    },
  },
  semantic_edges: {
    semantic_similar: {
      table: "semantic_edges",
      layer: "latent",
      endpointFamilies: ["any", "any"],
      truthBearing: false,
      heuristicOnly: true,
      temporal: false,
      lifecycle: "regenerable",
      cardinality_per_source: 4,
    },
    conflict_or_update: {
      table: "semantic_edges",
      layer: "latent",
      endpointFamilies: ["any", "any"],
      truthBearing: false,
      heuristicOnly: true,
      temporal: false,
      lifecycle: "regenerable",
      cardinality_per_source: 2,
    },
    entity_bridge: {
      table: "semantic_edges",
      layer: "latent",
      endpointFamilies: ["any", "entity"],
      truthBearing: false,
      heuristicOnly: true,
      temporal: false,
      lifecycle: "regenerable",
      cardinality_per_source: 2,
    },
  },
  fact_edges: {
    [FACT_EDGE_PREDICATE_WILDCARD]: {
      table: "fact_edges",
      layer: "world_state",
      endpointFamilies: ["entity", "entity"],
      truthBearing: true,
      heuristicOnly: false,
      temporal: true,
      lifecycle: "supersedable",
    },
  },
} as const satisfies Record<EdgeSemanticsTable, Record<string, EdgeSemantics>>;

export const CONSENSUS_EDGE_SEMANTICS_MATRIX = {
  ...EDGE_SEMANTICS_BY_TABLE.logic_edges,
  ...EDGE_SEMANTICS_BY_TABLE.memory_relations,
  ...EDGE_SEMANTICS_BY_TABLE.semantic_edges,
  ...EDGE_SEMANTICS_BY_TABLE.fact_edges,
} as const satisfies Record<string, EdgeSemantics>;

function toEndpointFamily(family: EdgeSemanticsEndpointFamily): EndpointFamily {
  return family === "any" ? "unknown" : family;
}

function toRelationContract(semantics: EdgeSemantics): RelationContract {
  return {
    source_family: toEndpointFamily(semantics.endpointFamilies[0]),
    target_family: toEndpointFamily(semantics.endpointFamilies[1]),
    truth_bearing: semantics.truthBearing,
    heuristic_only: semantics.heuristicOnly,
    layer: semantics.layer,
    temporal: semantics.temporal,
    lifecycle: semantics.lifecycle,
    ...(semantics.cardinality_per_source !== undefined
      ? { cardinality_per_source: semantics.cardinality_per_source }
      : {}),
  };
}

export const LOGIC_EDGE_CONTRACTS: Record<string, RelationContract> = {
  causal: toRelationContract(EDGE_SEMANTICS_BY_TABLE.logic_edges.causal),
  // Narrative-layer matched pair: contradict/reinforce are explicit, author-
  // or DSL-declared relationships. They sit next to `causal` because both
  // endpoints are event nodes and the claim is truth-bearing (as opposed to
  // `semantic_similar` / `conflict_or_update` which are heuristic and
  // embedding-derived — see SEMANTIC_EDGE_TYPES).
  contradict: toRelationContract(EDGE_SEMANTICS_BY_TABLE.logic_edges.contradict),
  reinforce: toRelationContract(EDGE_SEMANTICS_BY_TABLE.logic_edges.reinforce),
  temporal_prev: toRelationContract(EDGE_SEMANTICS_BY_TABLE.logic_edges.temporal_prev),
  temporal_next: toRelationContract(EDGE_SEMANTICS_BY_TABLE.logic_edges.temporal_next),
  same_episode: toRelationContract(EDGE_SEMANTICS_BY_TABLE.logic_edges.same_episode),
  semantic_similar: toRelationContract(EDGE_SEMANTICS_BY_TABLE.semantic_edges.semantic_similar),
  conflict_or_update: toRelationContract(EDGE_SEMANTICS_BY_TABLE.semantic_edges.conflict_or_update),
  entity_bridge: toRelationContract(EDGE_SEMANTICS_BY_TABLE.semantic_edges.entity_bridge),
};

export const MEMORY_RELATION_CONTRACTS: Record<MemoryRelationType, RelationContract> = {
  supports: toRelationContract(EDGE_SEMANTICS_BY_TABLE.memory_relations.supports),
  triggered: toRelationContract(EDGE_SEMANTICS_BY_TABLE.memory_relations.triggered),
  conflicts_with: toRelationContract(EDGE_SEMANTICS_BY_TABLE.memory_relations.conflicts_with),
  derived_from: toRelationContract(EDGE_SEMANTICS_BY_TABLE.memory_relations.derived_from),
  supersedes: toRelationContract(EDGE_SEMANTICS_BY_TABLE.memory_relations.supersedes),
  surfaced_as: toRelationContract(EDGE_SEMANTICS_BY_TABLE.memory_relations.surfaced_as),
  published_as: toRelationContract(EDGE_SEMANTICS_BY_TABLE.memory_relations.published_as),
  resolved_by: toRelationContract(EDGE_SEMANTICS_BY_TABLE.memory_relations.resolved_by),
  downgraded_by: toRelationContract(EDGE_SEMANTICS_BY_TABLE.memory_relations.downgraded_by),
};

export const RELATION_CONTRACTS: Record<string, RelationContract> = {
  ...LOGIC_EDGE_CONTRACTS,
  ...MEMORY_RELATION_CONTRACTS,
};

export const KNOWN_NODE_KINDS = new Set<NodeRefKind>([
  "event",
  "entity",
  "fact",
  "assertion",
  "evaluation",
  "commitment",
]);

export const RESOLUTION_CHAIN_TYPES = ["conflicts_with", "resolved_by", "downgraded_by"] as const;
export type ResolutionChainType = (typeof RESOLUTION_CHAIN_TYPES)[number];

export function isKnownRelationType(relationType: string): boolean {
  return relationType in RELATION_CONTRACTS;
}

export function getRelationContract(relationType: string): RelationContract | undefined {
  return RELATION_CONTRACTS[relationType];
}

export function isTruthBearing(relationType: string): boolean {
  return RELATION_CONTRACTS[relationType]?.truth_bearing ?? false;
}

export function isHeuristicOnly(relationType: string): boolean {
  return RELATION_CONTRACTS[relationType]?.heuristic_only ?? false;
}

export function isResolutionChainType(relationType: string): relationType is ResolutionChainType {
  return (RESOLUTION_CHAIN_TYPES as readonly string[]).includes(relationType);
}
