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
  /**
   * PG strategy: keep this service interface stable while decoupling sqlite internals.
   *
   * In PostgreSQL mode this service receives `PgTransactionBatcher` (no-op) and will delegate
   * all persistence/query work to `EmbeddingRepo` methods instead of direct `db.prepare(...)`
   * calls during Task 14 wiring.
   */
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
   * SQLite path today: performs `INSERT OR REPLACE` writes inside `batcher.runInTransaction`.
   *
   * PG plan (T14): route these writes through `EmbeddingRepo.upsert(...)` and retain
   * transaction compatibility by injecting `PgTransactionBatcher` as a no-op wrapper.
   */
  batchStoreEmbeddings(entries: EmbeddingEntry[]): void {
    if (entries.length === 0) {
      return;
    }

    this.batcher.runInTransaction(() => {
      for (const entry of entries) {
        this.resolveNow(
          this.embeddingRepo.upsert(
            entry.nodeRef,
            entry.nodeKind,
            entry.viewType,
            entry.modelId,
            entry.embedding,
          ),
        );
      }
    });
  }

  /**
   * SQLite path today: scans `node_embeddings` and applies private-cognition visibility checks
   * with sqlite statements.
   *
   * PG plan (T14): replace this with `EmbeddingRepo.query(...)` / `EmbeddingRepo.cosineSearch(...)`
   * so filtering and nearest-neighbor scoring run in Postgres (`pgvector` + SQL visibility logic).
   */
  queryNearestNeighbors(
    queryEmbedding: Float32Array,
    options: NeighborQueryOptions,
  ): Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }> {
    return this.resolveNow(this.embeddingRepo.query(queryEmbedding, options));
  }

  deserializeEmbedding(blob: Buffer): Float32Array {
    const bytes = Buffer.from(blob);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Float32Array(arrayBuffer);
  }

  serializeEmbedding(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }

  private resolveNow<T>(value: Promise<T> | T): T {
    if (!(value instanceof Promise)) {
      return value;
    }

    const settledValue = Bun.peek(value);
    if (settledValue instanceof Promise) {
      throw new Error(
        "EmbeddingService sync API received unresolved async repo result. "
          + "Inject adapter-style repos that resolve immediately for this call path.",
      );
    }
    return settledValue as T;
  }
}
