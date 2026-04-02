import type { NodeRef, NodeRefKind } from "../../../memory/types.js";

export type NodeRenderingPayload = {
  nodeRef: NodeRef;
  nodeKind: NodeRefKind;
  content: string;
};

export type SemanticNeighborWeight = {
  nodeRef: NodeRef;
  neighborRef: NodeRef;
  weight: number;
};

export type GraphNodeShadowRegistration = {
  nodeRef: NodeRef;
  nodeKind: NodeRefKind;
  nodeId: number;
  registeredAt: number;
};

export type SearchProjectionMaterial =
  | {
    nodeRef: NodeRef;
    scope: "area" | "world";
    content: string;
    locationEntityId?: number;
    removeExisting: false;
  }
  | {
    nodeRef: NodeRef;
    scope: "private";
    content: string;
    agentId: string;
    removeExisting: false;
  }
  | {
    nodeRef: NodeRef;
    scope: "private";
    removeExisting: true;
    reason: "retracted" | "rejected" | "abandoned";
  };

export interface NodeScoringQueryRepo {
  /**
   * Builds indexable text content for a node for embedding/index updates.
   * Returns null when the node no longer exists or should not be indexed.
   */
  getNodeRenderingPayload(nodeRef: NodeRef): Promise<NodeRenderingPayload | null>;

  /**
   * Returns the latest stored embedding vector for a node so organizer logic can
   * perform cross-node similarity checks without inspecting storage tables directly.
   */
  getLatestNodeEmbedding(nodeRef: NodeRef): Promise<Float32Array | null>;

  /**
   * Registers or refreshes graph-node shadow rows for organizer-managed nodes.
   * Implementations must preserve idempotency when called repeatedly.
   */
  registerGraphNodeShadows(nodes: NodeRef[], registeredAt?: number): Promise<void>;

  /**
   * Lists all semantic one-hop neighbors and edge weights for a node.
   */
  listSemanticNeighborWeights(nodeRef: NodeRef): Promise<SemanticNeighborWeight[]>;

  /**
   * Returns whether node scoring history already exists for a node.
   */
  hasNodeScore(nodeRef: NodeRef): Promise<boolean>;

  /**
   * Returns the canonical recency timestamp used by salience scoring for this node,
   * normalized across node kinds.
   */
  getNodeRecencyTimestamp(nodeRef: NodeRef): Promise<number | null>;

  /**
   * Returns event-graph logic degree for an event node.
   * Non-event refs should resolve to zero.
   */
  getEventLogicDegree(nodeRef: NodeRef): Promise<number>;

  /**
   * Returns the topic/cluster identity associated with a node for bridge-score
   * computation. Returns null when no cluster mapping exists.
   */
  getNodeTopicCluster(nodeRef: NodeRef): Promise<number | null>;

  /**
   * Returns scope + content payload used to sync search projections for a node.
   * removeExisting=true indicates callers should delete existing search projection docs.
   */
  getSearchProjectionMaterial(nodeRef: NodeRef, fallbackAgentId: string): Promise<SearchProjectionMaterial | null>;
}
