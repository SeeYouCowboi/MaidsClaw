import type { NodeRef } from "../../../memory/types.js";

export interface NodeScoreRepo {
  upsert(nodeRef: NodeRef, salience: number, centrality: number, bridgeScore: number): Promise<void>;
  getEmbeddingStatsByModel(): Promise<Array<{ model_id: string; count: number; dimension: number }>>;
}
