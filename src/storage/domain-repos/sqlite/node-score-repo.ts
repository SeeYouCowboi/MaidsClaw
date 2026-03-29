import { GraphStorageService } from "../../../memory/storage.js";
import type { NodeRef } from "../../../memory/types.js";
import type { NodeScoreRepo } from "../contracts/node-score-repo.js";

export class SqliteNodeScoreRepoAdapter implements NodeScoreRepo {
  constructor(private readonly impl: GraphStorageService) {}

  async upsert(nodeRef: NodeRef, salience: number, centrality: number, bridgeScore: number): Promise<void> {
    return Promise.resolve(this.impl.upsertNodeScores(nodeRef, salience, centrality, bridgeScore));
  }

  async getEmbeddingStatsByModel(): Promise<Array<{ model_id: string; count: number; dimension: number }>> {
    return Promise.resolve(this.impl.getEmbeddingStatsByModel());
  }
}
