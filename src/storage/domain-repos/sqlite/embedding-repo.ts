import { EmbeddingService } from "../../../memory/embeddings.js";
import { GraphStorageService } from "../../../memory/storage.js";
import type { Db } from "../../database.js";
import type { EmbeddingRepo } from "../contracts/embedding-repo.js";
import type { EmbeddingViewType, NodeRef, NodeRefKind } from "../../../memory/types.js";

export class SqliteEmbeddingRepoAdapter implements EmbeddingRepo {
  constructor(
    private readonly impl: GraphStorageService,
    private readonly embeddingService: EmbeddingService,
    private readonly db: Db,
  ) {}

  async upsert(
    nodeRef: NodeRef,
    nodeKind: NodeRefKind,
    viewType: EmbeddingViewType,
    modelId: string,
    embedding: Float32Array,
  ): Promise<void> {
    return Promise.resolve(this.impl.upsertNodeEmbedding(nodeRef, nodeKind, viewType, modelId, embedding));
  }

  async query(
    queryEmbedding: Float32Array,
    options: {
      nodeKind?: string;
      agentId: string | null;
      modelId?: string;
      limit?: number;
    },
  ): Promise<Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }>> {
    return Promise.resolve(this.embeddingService.queryNearestNeighbors(queryEmbedding, options));
  }

  async dimensionCheck(modelId: string, expectedDimension: number): Promise<boolean> {
    const row = this.db.get<{ dim: number }>(
      "SELECT LENGTH(embedding) / 4 AS dim FROM node_embeddings WHERE model_id = ? LIMIT 1",
      [modelId],
    );
    return Promise.resolve(row ? row.dim === expectedDimension : true);
  }

  async deleteByModel(modelId: string): Promise<number> {
    const result = this.db.run("DELETE FROM node_embeddings WHERE model_id = ?", [modelId]);
    return Promise.resolve(result.changes);
  }

  async cosineSearch(
    queryEmbedding: Float32Array,
    options: {
      nodeKind?: string;
      agentId: string | null;
      modelId?: string;
      limit?: number;
    },
  ): Promise<Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }>> {
    return Promise.resolve(this.embeddingService.queryNearestNeighbors(queryEmbedding, options));
  }
}
