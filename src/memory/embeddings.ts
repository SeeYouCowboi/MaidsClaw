import type { Db } from "../storage/database.js";
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
  agentId: string | null;
  modelId?: string;
  limit?: number;
};

export class EmbeddingService {
  constructor(
    private readonly db: Db,
    private readonly batcher: TransactionBatcher,
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
    options: NeighborQueryOptions,
  ): Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }> {
    const limit = options.limit ?? 20;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.nodeKind) {
      conditions.push("node_kind = ?");
      params.push(options.nodeKind);
    }
    if (options.modelId) {
      conditions.push("model_id = ?");
      params.push(options.modelId);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT node_ref, node_kind, embedding FROM node_embeddings${whereClause}`)
      .all(...params) as Array<{ node_ref: string; node_kind: string; embedding: Buffer | Uint8Array }>;

    const privateEventOwnerStmt = this.db.prepare("SELECT agent_id FROM private_episode_events WHERE id=?");
    const privateBeliefOwnerStmt = this.db.prepare("SELECT agent_id FROM private_cognition_current WHERE id=?");

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
    agentId: string | null,
    _privateEventOwnerStmt: ReturnType<Db["prepare"]>,
    privateBeliefOwnerStmt: ReturnType<Db["prepare"]>,
  ): boolean {
    if (nodeKind !== "assertion" && nodeKind !== "evaluation" && nodeKind !== "commitment") {
      return true;
    }

    if (agentId === null) {
      return false;
    }

    const id = this.parseNodeRefId(nodeRef);
    if (!id) {
      return false;
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
