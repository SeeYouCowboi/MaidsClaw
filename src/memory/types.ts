import { VIEWER_ROLES, type ViewerContext, type ViewerRole } from "../core/contracts/viewer-context.js";

export { VIEWER_ROLES };
export type { ViewerContext, ViewerRole };

export const MAX_INTEGER = Number.MAX_SAFE_INTEGER;

export const VISIBILITY_SCOPES = ["system_only", "owner_private", "area_visible", "world_public"] as const;
export type VisibilityScope = (typeof VISIBILITY_SCOPES)[number];

export const MEMORY_SCOPES = ["shared_public", "private_overlay"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const EVENT_ORIGINS = ["runtime_projection", "delayed_materialization", "promotion"] as const;
export type EventOrigin = (typeof EVENT_ORIGINS)[number];

export const PUBLIC_EVENT_CATEGORIES = ["speech", "action", "observation", "state_change"] as const;
export type PublicEventCategory = (typeof PUBLIC_EVENT_CATEGORIES)[number];

export const PRIVATE_EVENT_CATEGORIES = ["speech", "action", "thought", "observation", "state_change"] as const;
export type PrivateEventCategory = (typeof PRIVATE_EVENT_CATEGORIES)[number];

export const LOGIC_EDGE_TYPES = ["causal", "temporal_prev", "temporal_next", "same_episode"] as const;
export type LogicEdgeType = (typeof LOGIC_EDGE_TYPES)[number];

export const SEMANTIC_EDGE_TYPES = ["semantic_similar", "conflict_or_update", "entity_bridge"] as const;
export type SemanticEdgeType = (typeof SEMANTIC_EDGE_TYPES)[number];

export const EMBEDDING_VIEW_TYPES = ["primary", "keywords", "context"] as const;
export type EmbeddingViewType = (typeof EMBEDDING_VIEW_TYPES)[number];

export const QUERY_TYPES = ["entity", "event", "why", "relationship", "timeline", "state", "conflict"] as const;
export type QueryType = (typeof QUERY_TYPES)[number];

export const EDGE_LAYERS = ["state", "symbolic", "heuristic"] as const;
export type EdgeLayer = (typeof EDGE_LAYERS)[number];

export const EXPLORE_MODES = ["why", "timeline", "relationship", "state", "conflict"] as const;
export type ExploreMode = (typeof EXPLORE_MODES)[number];

export const EXPLAIN_DETAIL_LEVELS = ["concise", "standard", "audit"] as const;
export type ExplainDetailLevel = (typeof EXPLAIN_DETAIL_LEVELS)[number];

export const REDACTION_REASONS = ["hidden", "private", "admin_only"] as const;
export type RedactionReason = (typeof REDACTION_REASONS)[number];

export type RedactedPlaceholder = {
  type: "redacted";
  reason: RedactionReason;
  node_ref: string;
};

export const NAVIGATOR_EDGE_KINDS = [
  "causal",
  "temporal_prev",
  "temporal_next",
  "same_episode",
  "fact_relation",
  "fact_support",
  "participant",
  "semantic_similar",
  "conflict_or_update",
  "entity_bridge",
] as const;
export type NavigatorEdgeKind = (typeof NAVIGATOR_EDGE_KINDS)[number];

export const PROMOTION_ACTIONS = ["reuse", "promote_full", "promote_placeholder", "block"] as const;
export type PromotionAction = (typeof PROMOTION_ACTIONS)[number];

export const PROJECTION_CLASSES = ["none", "area_candidate"] as const;
export type ProjectionClass = (typeof PROJECTION_CLASSES)[number];

export const PROMOTION_CLASSES = ["none", "world_candidate"] as const;
export type PromotionClass = (typeof PROMOTION_CLASSES)[number];

/**
 * All valid core memory block labels.
 * - `persona`: canonical writable label for agent identity (T21 forward)
 * - `pinned_summary` / `pinned_index`: canonical labels (T7 forward)
 * - `character` / `user`: legacy labels, read-only compat aliases
 * - `index`: compat alias for pinned_index, read-only
 */
export const CORE_MEMORY_LABELS = ["character", "user", "index", "pinned_summary", "pinned_index", "persona"] as const;
export type CoreMemoryLabel = (typeof CORE_MEMORY_LABELS)[number];

/** Canonical labels introduced by T7 — the preferred write targets. */
export const CANONICAL_PINNED_LABELS = ["pinned_summary", "pinned_index"] as const;
export type CanonicalPinnedLabel = (typeof CANONICAL_PINNED_LABELS)[number];

/** Compat aliases — still readable, map to canonical counterparts. */
export const COMPAT_ALIAS_MAP: Readonly<Record<string, CanonicalPinnedLabel>> = {
  character: "pinned_summary",
  index: "pinned_index",
} as const;

/** Labels that have no RP direct-write path (includes legacy character/user). */
export const READ_ONLY_LABELS: readonly CoreMemoryLabel[] = ["index", "pinned_index", "character", "user"] as const;

export const CANONICAL_NODE_KINDS = ["event", "entity", "fact", "assertion", "evaluation", "commitment"] as const;
export type CanonicalNodeRefKind = (typeof CANONICAL_NODE_KINDS)[number];

export const NODE_REF_KINDS = [...CANONICAL_NODE_KINDS] as const;
export type NodeRefKind = (typeof NODE_REF_KINDS)[number];

export const CANONICAL_NODE_REF_KINDS = CANONICAL_NODE_KINDS;

type Brand<T, Name extends string> = T & { readonly __brand: Name };
type NodeRefLiteral = `${NodeRefKind}:${number}`;
export type NodeRef = Brand<NodeRefLiteral, "NodeRef">;

export type MemoryMigration = {
  migration_id: string;
  description: string;
  applied_at: number;
};

export type MemoryRuntimeState = {
  key: string;
  value: string;
  updated_at: number;
};

export type MemoryMaintenanceJob = {
  id: number;
  job_type: string;
  status: string;
  payload: string | null;
  created_at: number;
  updated_at: number;
};

export type EventNode = {
  id: number;
  session_id: string;
  raw_text: string | null;
  summary: string | null;
  timestamp: number;
  created_at: number;
  // participants must be JSON array of resolved entity refs, never free-text names.
  participants: string | null;
  emotion: string | null;
  topic_id: number | null;
  visibility_scope: "area_visible" | "world_public";
  location_entity_id: number;
  event_category: PublicEventCategory;
  primary_actor_entity_id: number | null;
  promotion_class: PromotionClass;
  source_record_id: string | null;
  event_origin: EventOrigin;
};

export type LogicEdge = {
  id: number;
  source_event_id: number;
  target_event_id: number;
  relation_type: LogicEdgeType;
  created_at: number;
};

export type Topic = {
  id: number;
  name: string;
  description: string | null;
  created_at: number;
};

export type FactEdge = {
  id: number;
  source_entity_id: number;
  target_entity_id: number;
  predicate: string;
  t_valid: number;
  t_invalid: number;
  t_created: number;
  t_expired: number;
  source_event_id: number | null;
};

export type EntityNode = {
  id: number;
  pointer_key: string;
  display_name: string;
  entity_type: string;
  memory_scope: MemoryScope;
  owner_agent_id: string | null;
  canonical_entity_id: number | null;
  summary: string | null;
  created_at: number;
  updated_at: number;
};

export type EntityAlias = {
  id: number;
  canonical_id: number;
  alias: string;
  alias_type: string | null;
  owner_agent_id: string | null;
};

export type PointerRedirect = {
  id: number;
  old_name: string;
  new_name: string;
  redirect_type: string | null;
  owner_agent_id: string | null;
  created_at: number;
};

export type AgentFactOverlay = {
  id: number;
  agent_id: string;
  source_entity_id: number;
  target_entity_id: number;
  predicate: string;
  provenance: string | null;
  source_event_ref: NodeRef | null;
  created_at: number;
  updated_at: number;
};

// Memory relation types - extracted from schema.ts CHECK constraints
export const MEMORY_RELATION_TYPES = ["supports", "triggered", "conflicts_with", "derived_from", "supersedes", "surfaced_as", "published_as", "resolved_by", "downgraded_by"] as const;
export type MemoryRelationType = (typeof MEMORY_RELATION_TYPES)[number];

export const RELATION_DIRECTNESS_VALUES = ["direct", "inferred", "indirect"] as const;
export type RelationDirectness = (typeof RELATION_DIRECTNESS_VALUES)[number];

export const RELATION_SOURCE_KINDS = ["turn", "job", "agent_op", "system"] as const;
export type RelationSourceKind = (typeof RELATION_SOURCE_KINDS)[number];

export type MemoryRelationRecord = {
  id: number;
  source_node_ref: string;
  target_node_ref: string;
  relation_type: MemoryRelationType;
  strength: number;
  directness: RelationDirectness;
  source_kind: RelationSourceKind;
  source_ref: string;
  created_at: number;
  updated_at: number;
};

export type CoreMemoryBlock = {
  id: number;
  agent_id: string;
  label: CoreMemoryLabel;
  description: string | null;
  value: string;
  char_limit: number;
  read_only: number;
  updated_at: number;
};

export type AppendResult =
  | { success: true; chars_current: number; chars_limit: number }
  | { success: false; remaining: number; limit: number; current: number };

export type ReplaceResult =
  | { success: true; chars_current: number }
  | { success: false; reason: string };

export type NodeEmbedding = {
  id: number;
  node_ref: NodeRef;
  node_kind: NodeRefKind;
  view_type: EmbeddingViewType;
  model_id: string;
  embedding: Uint8Array;
  updated_at: number;
};

export type SemanticEdge = {
  id: number;
  source_node_ref: NodeRef;
  target_node_ref: NodeRef;
  relation_type: SemanticEdgeType;
  weight: number;
  created_at: number;
  updated_at: number;
};

export type NodeScores = {
  node_ref: NodeRef;
  salience: number;
  centrality: number;
  bridge_score: number;
  updated_at: number;
};

export type SearchDocPrivate = {
  id: number;
  doc_type: string;
  source_ref: NodeRef;
  agent_id: string;
  content: string;
  created_at: number;
};

export type SearchDocArea = {
  id: number;
  doc_type: string;
  source_ref: NodeRef;
  location_entity_id: number;
  content: string;
  created_at: number;
};

export type SearchDocWorld = {
  id: number;
  doc_type: string;
  source_ref: NodeRef;
  content: string;
  created_at: number;
};

export type SeedCandidate = {
  node_ref: NodeRef;
  node_kind: NodeRefKind;
  lexical_score: number;
  semantic_score: number;
  fused_score: number;
  source_scope: "private" | "area" | "world";
};

export type BeamEdge = {
  from: NodeRef;
  to: NodeRef;
  kind: NavigatorEdgeKind;
  layer: EdgeLayer;
  weight: number;
  timestamp: number | null;
  summary: string | null;
};

export type BeamPath = {
  seed: NodeRef;
  nodes: NodeRef[];
  edges: BeamEdge[];
  depth: number;
};

export type PathScore = {
  seed_score: number;
  edge_type_score: number;
  temporal_consistency: number;
  query_intent_match: number;
  support_score: number;
  recency_score: number;
  hop_penalty: number;
  redundancy_penalty: number;
  path_score: number;
};

export type EvidencePath = {
  path: BeamPath;
  score: PathScore;
  supporting_nodes: NodeRef[];
  supporting_facts: number[];
  redacted_placeholders?: RedactedPlaceholder[];
  summary?: string;
};

export type NavigatorResult = {
  query: string;
  query_type: QueryType;
  summary?: string;
  drilldown?: {
    mode?: ExploreMode;
    focus_ref?: NodeRef;
    focus_cognition_key?: string;
    as_of_valid_time?: number;
    as_of_committed_time?: number;
    time_sliced_paths?: Array<{
      seed: NodeRef;
      depth: number;
      edge_count: number;
      omitted_edges: number;
      has_valid_cut: boolean;
      has_committed_cut: boolean;
    }>;
  };
  evidence_paths: EvidencePath[];
};

export type MemoryHint = {
  scope: "private" | "area" | "world";
  source_ref: NodeRef;
  doc_type: string;
  content: string;
  score: number;
};

export type CoreMemoryAppendInput = {
  label: "character" | "user" | "pinned_summary";
  content: string;
};

export type CoreMemoryReplaceInput = {
  label: "character" | "user" | "pinned_summary";
  old_content: string;
  new_content: string;
};

export type MemoryReadInput = {
  entity?: string;
  topic?: string;
  event_ids?: number[];
  fact_ids?: number[];
};

export type MemorySearchInput = {
  query: string;
};

export type MemoryExploreInput = {
  query: string;
  mode?: ExploreMode;
  focusRef?: NodeRef;
  focusCognitionKey?: string;
  asOfValidTime?: number;
  asOfCommittedTime?: number;
  detailLevel?: ExplainDetailLevel;
};

export type ExtractionBatch = {
  batch_id: string;
  owner_agent_id: string;
  session_id: string;
  range_start: number;
  range_end: number;
};

type PrivateEventIdsKey = `private_${"event"}_ids`;
type PrivateBeliefIdsKey = `private_${"belief"}_ids`;
export type MigrationResult = {
  batch_id: string;
  entity_ids: number[];
  fact_ids: number[];
} & Record<PrivateEventIdsKey, number[]> & Record<PrivateBeliefIdsKey, number[]>;

export type GraphOrganizerResult = {
  updated_embedding_refs: NodeRef[];
  updated_semantic_edge_count: number;
  updated_score_refs: NodeRef[];
};

export type PromotionCandidate = {
  source_ref: NodeRef;
  target_scope: "area_visible" | "world_public";
  summary: string;
  entity_refs: NodeRef[];
};

export type ReferenceResolution = {
  source_ref: NodeRef;
  action: PromotionAction;
  resolved_entity_id?: number;
  placeholder_pointer_key?: string;
  reason?: string;
};

export type ProjectedWrite = {
  target_scope: "area_visible" | "world_public";
  source_ref: NodeRef;
  created_ref: NodeRef;
};

export interface IMemoryStorage {
  createProjectedEvent(input: {
    session_id: string;
    summary: string;
    timestamp: number;
    participants: string;
    location_entity_id: number;
    event_category: PublicEventCategory;
    primary_actor_entity_id?: number;
    source_record_id?: string;
    event_origin: "runtime_projection" | "delayed_materialization";
  }): number;
  createPromotedEvent(input: {
    session_id: string;
    summary: string;
    timestamp: number;
    participants: string;
    event_category: PublicEventCategory;
    source_record_id?: string;
  }): number;
}

export interface IMemoryRetrieval {
  searchVisibleNarrative(query: string, viewerContext: ViewerContext): MemoryHint[];
  generateMemoryHints(userMessage: string, viewerContext: ViewerContext, limit?: number): MemoryHint[];
}

export interface ICoreMemory {
  getBlock(agentId: string, label: CoreMemoryLabel): CoreMemoryBlock | undefined;
  getAllBlocks(agentId: string): CoreMemoryBlock[];
}

export interface IGraphNavigator {
  explore(query: string, viewerContext: ViewerContext): NavigatorResult;
}

export interface IMaterializationService {
  materializeDelayed(privateEvents: unknown[], agentId: string): number[];
}

export interface IPromotionService {
  resolveReferences(candidate: PromotionCandidate): ReferenceResolution[];
  executeProjectedWrite(candidate: PromotionCandidate, resolutions: ReferenceResolution[]): ProjectedWrite | undefined;
}

export interface IVisibilityPolicy {
  isEventVisible(event: EventNode, viewerContext: ViewerContext): boolean;
  isEntityVisible(entity: EntityNode, viewerContext: ViewerContext): boolean;
  isFactVisible(fact: FactEdge, viewerContext: ViewerContext): boolean;
  isNodeVisible(nodeRef: NodeRef, viewerContext: ViewerContext): boolean;
}

export interface IAuthorizationResolver {
  canAccess(viewerAgentId: string, targetAgentId: string, scope: "owner_private"): boolean;
}
