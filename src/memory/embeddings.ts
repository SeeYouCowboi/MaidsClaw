import type { EmbeddingRepo } from "../storage/domain-repos/contracts/embedding-repo.js";
import type { ITransactionBatcher } from "./transaction-batcher.js";
import type { EmbeddingViewType, NodeRef, NodeRefKind } from "./types.js";

type EmbeddingEntry = {
  nodeRef: NodeRef;
  nodeKind: NodeRefKind;
  viewType: EmbeddingViewType;
  modelId: string;
  embedding: Float32Array;
};

type NeighborQueryOptions = {
  nodeKind?: string;
  agentId: string | null;
  modelId?: string;
  limit?: number;
};

export class EmbeddingService {
	constructor(
		private readonly embeddingRepo: EmbeddingRepo,
		private readonly batcher: ITransactionBatcher,
	) {}

  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      console.warn(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length}), returning 0`);
      return 0;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) {
      return 0;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Stores embeddings individually (PgTransactionBatcher is a no-op passthrough).
   * Each upsert runs independently — partial failures do NOT roll back prior writes.
   * This is acceptable because upserts are idempotent (ON CONFLICT DO UPDATE) and
   * the caller (GraphOrganizer) validates vector count before calling.
   */
  async batchStoreEmbeddings(entries: EmbeddingEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const pendingWrites: Promise<void>[] = [];
    this.batcher.runInTransaction(() => {
      for (const entry of entries) {
        const result = this.embeddingRepo.upsert(
          entry.nodeRef,
          entry.nodeKind,
          entry.viewType,
          entry.modelId,
          entry.embedding,
        );
        if (result && typeof (result as Promise<void>).then === "function") {
          pendingWrites.push(result as Promise<void>);
        }
      }
    });
    await Promise.all(pendingWrites);
  }

  async queryNearestNeighbors(
    queryEmbedding: Float32Array,
    options: NeighborQueryOptions,
  ): Promise<Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }>> {
    return this.embeddingRepo.query(queryEmbedding, options);
  }

  deserializeEmbedding(blob: Buffer): Float32Array {
    const bytes = Buffer.from(blob);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Float32Array(arrayBuffer);
  }

  serializeEmbedding(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }
}
