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
  viewerAgentId?: string;
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
