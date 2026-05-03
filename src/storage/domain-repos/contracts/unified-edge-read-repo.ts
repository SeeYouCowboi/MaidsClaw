export type UnifiedEdgeTable =
  | "logic_edges"
  | "memory_relations"
  | "semantic_edges"
  | "fact_edges";

export type UnifiedEdgeRecord = {
  id: number | string;
  table: UnifiedEdgeTable;
  sourceRef: string;
  targetRef: string;
  edgeKind: string;
  layer: string;
  truthBearing: boolean;
  heuristicOnly: boolean;
  lifecycle: string;
  weight?: number;
  tValid?: number;
  tInvalid?: number | null;
  factText?: string | null;
  sourceKind?: string | null;
  sourceRefOrigin?: string | null;
  createdAt?: number;
  ownerAgentId?: string | null;
};

export type UnifiedEdgeReadOptions = {
  asOf?: number;
  active?: boolean;
  /**
   * Viewer identity. When set, endpoint-visibility cascade is applied: an
   * edge is only returned if both its source and target nodes are visible
   * to this viewer. When unset, no cascade is applied (system-level caller).
   */
  viewerAgentId?: string;
  /**
   * Viewer's current area for area_visible event filtering. Required to
   * resolve area_visible events; without it, area_visible endpoints are
   * treated as not-visible during cascade.
   */
  viewerCurrentAreaId?: number;
  limit?: number;
};

export interface UnifiedEdgeReadRepo {
  edgesFrom(nodeRef: string, opts?: UnifiedEdgeReadOptions): Promise<UnifiedEdgeRecord[]>;
  edgesTo(nodeRef: string, opts?: UnifiedEdgeReadOptions): Promise<UnifiedEdgeRecord[]>;
  edgesAround(nodeRef: string, opts?: UnifiedEdgeReadOptions): Promise<UnifiedEdgeRecord[]>;

  worldStateOf(entityRef: string, opts?: UnifiedEdgeReadOptions): Promise<UnifiedEdgeRecord[]>;
  cognitiveContextOf(nodeRef: string, opts?: UnifiedEdgeReadOptions): Promise<UnifiedEdgeRecord[]>;
  narrativeChainOf(
    eventRef: string,
    opts?: UnifiedEdgeReadOptions & { maxDepth?: number; maxEdges?: number },
  ): Promise<UnifiedEdgeRecord[]>;
  semanticNeighborsOf(
    nodeRef: string,
    opts?: UnifiedEdgeReadOptions & { topK?: number },
  ): Promise<UnifiedEdgeRecord[]>;
  evidencePathTo(
    assertionRef: string,
    opts?: UnifiedEdgeReadOptions & { maxDepth?: number; maxEdges?: number },
  ): Promise<UnifiedEdgeRecord[]>;
}
