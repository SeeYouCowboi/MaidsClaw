import type { Database } from "bun:sqlite";
import type { TransactionBatcher } from "./transaction-batcher.js";
import type { EmbeddingViewType, NodeRef } from "./types.js";

type EmbeddingEntry = {
  nodeRef: NodeRef;
  nodeKind: string;
  viewType: EmbeddingViewType;
  modelId: string;
  embedding: Float32Array;
};

type NeighborQueryOptions = {
  nodeKind?: string;
  agentId?: string;
  limit?: number;
};

export class EmbeddingService {
  constructor(
    private readonly db: Database,
    private readonly batcher: TransactionBatcher,
  ) {}

  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
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

  batchStoreEmbeddings(entries: EmbeddingEntry[]): void {
    if (entries.length === 0) {
      return;
    }

    const now = Date.now();
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at) VALUES (?,?,?,?,?,?)",
    );

    this.batcher.runInTransaction(() => {
      for (const entry of entries) {
        insert.run(
          entry.nodeRef,
          entry.nodeKind,
          entry.viewType,
          entry.modelId,
          this.serializeEmbedding(entry.embedding),
          now,
        );
      }
    });
  }

  queryNearestNeighbors(
    queryEmbedding: Float32Array,
    options: NeighborQueryOptions = {},
  ): Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }> {
    const limit = options.limit ?? 20;
    const rows = options.nodeKind
      ? (this.db
          .prepare("SELECT node_ref, node_kind, embedding FROM node_embeddings WHERE node_kind=?")
          .all(options.nodeKind) as Array<{ node_ref: string; node_kind: string; embedding: Buffer | Uint8Array }>)
      : (this.db.prepare("SELECT node_ref, node_kind, embedding FROM node_embeddings").all() as Array<{
          node_ref: string;
          node_kind: string;
          embedding: Buffer | Uint8Array;
        }>);

    const privateEventOwnerStmt = this.db.prepare("SELECT agent_id FROM agent_event_overlay WHERE id=?");
    const privateBeliefOwnerStmt = this.db.prepare("SELECT agent_id FROM agent_fact_overlay WHERE id=?");

    const candidates: Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }> = [];
    for (const row of rows) {
      const nodeRef = row.node_ref as NodeRef;
      if (!this.isNodeVisibleForAgent(nodeRef, row.node_kind, options.agentId, privateEventOwnerStmt, privateBeliefOwnerStmt)) {
        continue;
      }

      const vector = this.deserializeEmbedding(Buffer.from(row.embedding));
      const similarity = this.cosineSimilarity(queryEmbedding, vector);
      candidates.push({ nodeRef, similarity, nodeKind: row.node_kind });
    }

    return candidates.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  deserializeEmbedding(blob: Buffer): Float32Array {
    const bytes = Buffer.from(blob);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Float32Array(arrayBuffer);
  }

  serializeEmbedding(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }

  private isNodeVisibleForAgent(
    nodeRef: NodeRef,
    nodeKind: string,
    agentId: string | undefined,
    privateEventOwnerStmt: ReturnType<Database["prepare"]>,
    privateBeliefOwnerStmt: ReturnType<Database["prepare"]>,
  ): boolean {
    if (!agentId) {
      return true;
    }

    if (nodeKind !== "private_event" && nodeKind !== "private_belief") {
      return true;
    }

    const id = this.parseNodeRefId(nodeRef);
    if (!id) {
      return false;
    }

    if (nodeKind === "private_event") {
      const row = privateEventOwnerStmt.get(id) as { agent_id: string } | undefined;
      return row?.agent_id === agentId;
    }

    const row = privateBeliefOwnerStmt.get(id) as { agent_id: string } | undefined;
    return row?.agent_id === agentId;
  }

  private parseNodeRefId(nodeRef: NodeRef): number | undefined {
    const idPart = String(nodeRef).split(":")[1];
    const id = Number(idPart);
    if (!Number.isInteger(id) || id <= 0) {
      return undefined;
    }
    return id;
  }
}
