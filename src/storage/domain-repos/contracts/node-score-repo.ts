import type { NodeRef } from "../../../memory/types.js";

export interface NodeScoreRepo {
  upsert(nodeRef: NodeRef, salience: number, centrality: number, bridgeScore: number): Promise<void>;
  getByNodeRef(
    nodeRef: NodeRef,
  ): Promise<{ nodeRef: NodeRef; salience: number; centrality: number; bridgeScore: number; updatedAt: number } | null>;
  getTopByField(
    field: "salience" | "centrality" | "bridge_score",
    limit: number,
  ): Promise<Array<{ nodeRef: NodeRef; salience: number; centrality: number; bridgeScore: number; updatedAt: number }>>;
  deleteForNodes(nodeRefs: NodeRef[]): Promise<number>;
  getEmbeddingStatsByModel(): Promise<Array<{ model_id: string; count: number; dimension: number }>>;
}
