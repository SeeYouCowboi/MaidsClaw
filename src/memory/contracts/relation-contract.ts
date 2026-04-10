/**
 * Centralized RelationContract registry — single source of truth for all
 * relation type definitions across the memory subsystem.
 *
 * @see docs/MEMORY_RELATION_CONTRACT.md
 */

import type { MemoryRelationType, NodeRefKind } from "../types.js";

export type EndpointFamily = NodeRefKind | "unknown";

export type RelationContract = {
  source_family: EndpointFamily;
  target_family: EndpointFamily;
  truth_bearing: boolean;
  heuristic_only: boolean;
};

export const LOGIC_EDGE_CONTRACTS: Record<string, RelationContract> = {
  causal:            { source_family: "event", target_family: "event", truth_bearing: true,  heuristic_only: false },
  // Narrative-layer matched pair: contradict/reinforce are explicit, author-
  // or DSL-declared relationships. They sit next to `causal` because both
  // endpoints are event nodes and the claim is truth-bearing (as opposed to
  // `semantic_similar` / `conflict_or_update` which are heuristic and
  // embedding-derived — see SEMANTIC_EDGE_TYPES).
  contradict:        { source_family: "event", target_family: "event", truth_bearing: true,  heuristic_only: false },
  reinforce:         { source_family: "event", target_family: "event", truth_bearing: true,  heuristic_only: false },
  temporal_prev:     { source_family: "event", target_family: "event", truth_bearing: true,  heuristic_only: false },
  temporal_next:     { source_family: "event", target_family: "event", truth_bearing: true,  heuristic_only: false },
  same_episode:      { source_family: "event", target_family: "event", truth_bearing: true,  heuristic_only: false },
  semantic_similar:  { source_family: "unknown", target_family: "unknown", truth_bearing: false, heuristic_only: true },
  conflict_or_update:{ source_family: "unknown", target_family: "unknown", truth_bearing: false, heuristic_only: true },
  entity_bridge:     { source_family: "unknown", target_family: "unknown", truth_bearing: false, heuristic_only: true },
};

export const MEMORY_RELATION_CONTRACTS: Record<MemoryRelationType, RelationContract> = {
  supports:       { source_family: "event",     target_family: "assertion",  truth_bearing: true,  heuristic_only: false },
  triggered:      { source_family: "event",     target_family: "evaluation", truth_bearing: true,  heuristic_only: false },
  conflicts_with: { source_family: "assertion", target_family: "assertion",  truth_bearing: true,  heuristic_only: false },
  derived_from:   { source_family: "fact",      target_family: "assertion",  truth_bearing: true,  heuristic_only: false },
  supersedes:     { source_family: "assertion", target_family: "assertion",  truth_bearing: true,  heuristic_only: false },
  surfaced_as:    { source_family: "assertion", target_family: "event",      truth_bearing: true,  heuristic_only: false },
  published_as:   { source_family: "event",     target_family: "entity",     truth_bearing: true,  heuristic_only: false },
  resolved_by:    { source_family: "assertion", target_family: "fact",       truth_bearing: false, heuristic_only: true },
  downgraded_by:  { source_family: "assertion", target_family: "evaluation", truth_bearing: false, heuristic_only: true },
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
