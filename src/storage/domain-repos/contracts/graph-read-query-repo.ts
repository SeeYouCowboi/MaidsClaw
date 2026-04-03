import type { TimeSliceQuery } from "../../../memory/time-slice-query.js";
import type { EdgeLayer, MemoryRelationType, NodeRef, NodeRefKind, ViewerContext } from "../../../memory/types.js";

export type GraphReadEdgeFamily = "logic_edges" | "memory_relations" | "semantic_edges";

export type GraphReadEdgeRecord = {
  family: GraphReadEdgeFamily;
  layer: EdgeLayer;
  relationType: string;
  sourceRef: NodeRef;
  targetRef: NodeRef;
  weight: number;
  strength: number | null;
  sourceKind: string | null;
  provenanceRef: string | null;
  timestamp: number | null;
  validTime: number | null;
  committedTime: number | null;
  truthBearing: boolean;
  heuristicOnly: boolean;
  endpointContract: {
    sourceFamily: NodeRefKind | "unknown";
    targetFamily: NodeRefKind | "unknown";
    declared: boolean;
  };
};

export type NodeSalienceRecord = {
  nodeRef: NodeRef;
  salience: number;
};

export type EventParticipantContext = {
  eventRef: NodeRef;
  summary: string | null;
  timestamp: number;
  participantEntityRefs: NodeRef[];
  primaryActorEntityRef: NodeRef | null;
};

export type FactTraversalRecord = {
  factRef: NodeRef;
  sourceEntityRef: NodeRef;
  targetEntityRef: NodeRef;
  predicate: string;
  validTime: number;
  sourceEventRef: NodeRef | null;
};

export type AssertionTraversalRecord = {
  assertionRef: NodeRef;
  summary: string | null;
  predicate: string | null;
  sourceEntityRef: NodeRef | null;
  targetEntityRef: NodeRef | null;
  sourceEventRef: NodeRef | null;
  updatedAt: number;
};

export type GraphNodeSnapshot = {
  nodeRef: NodeRef;
  kind: NodeRefKind;
  summary: string | null;
  timestamp: number | null;
};

export type GraphNodeVisibilityRecord =
  | {
    nodeRef: NodeRef;
    kind: "entity";
    memoryScope: "shared_public" | "private_overlay";
    ownerAgentId: string | null;
  }
  | {
    nodeRef: NodeRef;
    kind: "event";
    visibilityScope: "area_visible" | "world_public";
    locationEntityId: number;
    ownerAgentId: string | null;
  }
  | {
    nodeRef: NodeRef;
    kind: "assertion" | "evaluation" | "commitment";
    agentId: string;
  }
  | {
    nodeRef: NodeRef;
    kind: "fact";
    active: boolean;
  };

export interface GraphReadQueryRepo {
  getEntitiesForContext(agentId: string, limit?: number): Promise<Array<{
    id: number;
    pointer_key: string;
    display_name: string;
    entity_type: string;
    memory_scope: "shared_public" | "private_overlay";
    owner_agent_id: string | null;
  }>>;

  getEventsByIds(ids: number[]): Promise<Array<{
    id: number;
    session_id: string;
    topic_id: number | null;
    timestamp: number;
  }>>;

  /**
   * Loads current salience values for a seed set used by navigator beam scoring.
   * Missing rows should be omitted instead of synthesized.
   */
  getNodeSalience(nodeRefs: readonly NodeRef[]): Promise<NodeSalienceRecord[]>;

  /**
   * Reads directed logic edges touching an event frontier and already filtered by
   * visibility/time-slice semantics for the requesting viewer.
   */
  readLogicEdges(
    frontierEventRefs: readonly NodeRef[],
    viewerContext: ViewerContext,
    timeSlice?: TimeSliceQuery,
  ): Promise<GraphReadEdgeRecord[]>;

  /**
   * Reads memory relation edges (`supports`, `derived_from`, etc.) touching the frontier,
   * preserving relation metadata required for evidence scoring and explanation.
   */
  readMemoryRelationEdges(
    frontierNodeRefs: readonly NodeRef[],
    viewerContext: ViewerContext,
    timeSlice?: TimeSliceQuery,
  ): Promise<GraphReadEdgeRecord[]>;

  /**
   * Reads heuristic semantic edges touching the frontier with viewer/time filtering applied.
   */
  readSemanticEdges(
    frontierNodeRefs: readonly NodeRef[],
    viewerContext: ViewerContext,
    timeSlice?: TimeSliceQuery,
  ): Promise<GraphReadEdgeRecord[]>;

  /**
   * Reads event->fact support links for state reconstruction from the active fact graph.
   */
  readStateFactEdges(
    frontierEventRefs: readonly NodeRef[],
    viewerContext: ViewerContext,
    timeSlice?: TimeSliceQuery,
  ): Promise<GraphReadEdgeRecord[]>;

  /**
   * Returns participant context for visible events in the frontier so navigator can build
   * event<->entity traversal steps without parsing event rows directly.
   */
  readEventParticipantContexts(
    frontierEventRefs: readonly NodeRef[],
    viewerContext: ViewerContext,
  ): Promise<EventParticipantContext[]>;

  /**
   * Returns active fact rows connected to the given entity frontier.
   * Implementations must only include currently-valid facts.
   */
  readActiveFactsForEntityFrontier(entityRefs: readonly NodeRef[]): Promise<FactTraversalRecord[]>;

  /**
   * Returns visible events that mention/anchor any entity in the frontier, used for
   * entity->event participant traversal.
   */
  readVisibleEventsForEntityFrontier(
    entityRefs: readonly NodeRef[],
    viewerContext: ViewerContext,
  ): Promise<EventParticipantContext[]>;

  /**
   * Returns active private assertions for one agent that are linked to any entity in the
   * frontier (via source/target entity references inside the assertion record).
   */
  readAgentAssertionsLinkedToEntities(
    agentId: string,
    entityRefs: readonly NodeRef[],
  ): Promise<AssertionTraversalRecord[]>;

  /**
   * Returns assertion details for a specific assertion frontier with optional committed-time
   * cut, enabling time-sliced belief expansion.
   */
  readAgentAssertionDetails(
    agentId: string,
    assertionRefs: readonly NodeRef[],
    asOfCommittedTime?: number,
  ): Promise<AssertionTraversalRecord[]>;

  /**
   * Resolves an entity pointer key to the best visible entity ref for a viewer.
   * Implementations should prefer private-overlay ownership before shared-public fallback.
   */
  resolveEntityRefByPointerKey(pointerKey: string, viewerAgentId: string): Promise<NodeRef | null>;

  /**
   * Loads compact snapshots used during path reranking (summary + recency timestamp).
   */
  getNodeSnapshots(nodeRefs: readonly NodeRef[]): Promise<GraphNodeSnapshot[]>;

  /**
   * Loads visibility envelopes for node-level authorization checks performed during
   * post-filter safety redaction.
   */
  getNodeVisibility(nodeRefs: readonly NodeRef[]): Promise<GraphNodeVisibilityRecord[]>;

  /**
   * Returns ownership metadata for private cognition node refs when the caller only needs
   * the owning agent for compatibility checks.
   */
  getPrivateNodeOwners(nodeRefs: readonly NodeRef[]): Promise<Array<{ nodeRef: NodeRef; agentId: string }>>;

  /**
   * Returns all relation labels currently present for the given frontier.
   * Useful for explainability telemetry and strategy debugging.
   */
  listRelationTypesForFrontier(frontierRefs: readonly NodeRef[]): Promise<MemoryRelationType[]>;
}
