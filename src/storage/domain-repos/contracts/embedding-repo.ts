import type { EmbeddingViewType, NodeRef, NodeRefKind } from "../../../memory/types.js";

type MaybePromise<T> = T | Promise<T>;

export interface EmbeddingRepo {
  upsert(
    nodeRef: NodeRef,
    nodeKind: NodeRefKind,
    viewType: EmbeddingViewType,
    modelId: string,
    embedding: Float32Array,
  ): MaybePromise<void>;
  query(
    queryEmbedding: Float32Array,
    options: {
      nodeKind?: string;
      agentId: string | null;
      modelId?: string;
      limit?: number;
    },
  ): MaybePromise<Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }>>;
  dimensionCheck(modelId: string, expectedDimension: number): MaybePromise<boolean>;
  deleteByModel(modelId: string): MaybePromise<number>;
  cosineSearch(
    queryEmbedding: Float32Array,
    options: {
      nodeKind?: string;
      agentId: string | null;
      modelId?: string;
      limit?: number;
    },
  ): MaybePromise<Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }>>;
}
