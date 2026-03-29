import type { EmbeddingViewType, NodeRef, NodeRefKind } from "../../../memory/types.js";

export interface EmbeddingRepo {
  upsert(
    nodeRef: NodeRef,
    nodeKind: NodeRefKind,
    viewType: EmbeddingViewType,
    modelId: string,
    embedding: Float32Array,
  ): Promise<void>;
  query(
    queryEmbedding: Float32Array,
    options: {
      nodeKind?: string;
      agentId: string | null;
      modelId?: string;
      limit?: number;
    },
  ): Promise<Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }>>;
  dimensionCheck(modelId: string, expectedDimension: number): Promise<boolean>;
  deleteByModel(modelId: string): Promise<number>;
  cosineSearch(
    queryEmbedding: Float32Array,
    options: {
      nodeKind?: string;
      agentId: string | null;
      modelId?: string;
      limit?: number;
    },
  ): Promise<Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }>>;
}
