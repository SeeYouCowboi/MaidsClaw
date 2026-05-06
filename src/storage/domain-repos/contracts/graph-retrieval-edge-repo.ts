export type DerivedEdgeKind =
  | "mention_episode_entity"
  | "mention_cognition_entity"
  | "cooccurrence_associative"
  | "cooccurrence_contrastive"
  | "fact_relation"
  | "semantic_projection";

export type GraphRetrievalEdgeInsert = {
  runId: string;
  algorithmVersion: string;
  edgeKind: DerivedEdgeKind;
  sourceRef: string;
  sourceKind: string;
  targetRef: string;
  targetKind: string;
  weight: number;
  visibilityScope: string;
  ownerAgentId?: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  sourcePassageRefs?: string[];
  sourceFactEdgeIds?: number[];
  sourceSemanticEdgeRefs?: string[];
  sourceHash?: string;
};

export type GraphRetrievalEdgeRow = GraphRetrievalEdgeInsert & {
  id: number;
  active: boolean;
  createdAt: number;
};

export interface GraphRetrievalEdgeRepo {
  insertBatch(edges: GraphRetrievalEdgeInsert[]): Promise<void>;
  activateRun(runId: string): Promise<void>;
  deactivateOtherRuns(runId: string): Promise<void>;
  atomicSwapRun(runId: string): Promise<void>;
  loadActiveEdges(opts: {
    ownerAgentId?: string;
    visibilityScope?: string[];
    limit?: number;
  }): Promise<GraphRetrievalEdgeRow[]>;
  countActiveEdgesByKind(): Promise<Record<string, number>>;
  deleteRun(runId: string): Promise<void>;
}
