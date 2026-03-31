import type { Db } from "../../database.js";
import type { EmbeddingRepo } from "../contracts/embedding-repo.js";
import type { EmbeddingViewType, NodeRef, NodeRefKind } from "../../../memory/types.js";

export class SqliteEmbeddingRepoAdapter implements EmbeddingRepo {
  constructor(private readonly db: Db) {}

  upsert(
    nodeRef: NodeRef,
    nodeKind: NodeRefKind,
    viewType: EmbeddingViewType,
    modelId: string,
    embedding: Float32Array,
  ): void {
    if (embedding.length === 0) {
      throw new Error(`Embedding dimension is 0 for node ${nodeRef} (model: ${modelId})`);
    }

    const dimensionOk = this.dimensionCheck(modelId, embedding.length);
    if (!dimensionOk) {
      throw new Error(
        `Embedding dimension mismatch for model "${modelId}": expected existing model dimension, got ${embedding.length} (node: ${nodeRef})`,
      );
    }

    const now = Date.now();
    this.db
      .prepare(
        "INSERT OR REPLACE INTO node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        nodeRef,
        nodeKind,
        viewType,
        modelId,
        this.serializeEmbedding(embedding),
        now,
      );

  }

  query(
    queryEmbedding: Float32Array,
    options: {
      nodeKind?: string;
      agentId: string | null;
      modelId?: string;
      limit?: number;
    },
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

    const privateBeliefOwnerStmt = this.db.prepare("SELECT agent_id FROM private_cognition_current WHERE id=?");

    const candidates: Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }> = [];
    for (const row of rows) {
      const nodeRef = row.node_ref as NodeRef;
      if (!this.isNodeVisibleForAgent(nodeRef, row.node_kind, options.agentId, privateBeliefOwnerStmt)) {
        continue;
      }

      const vector = this.deserializeEmbedding(Buffer.from(row.embedding));
      const similarity = this.cosineSimilarity(queryEmbedding, vector);
      candidates.push({ nodeRef, similarity, nodeKind: row.node_kind });
    }

    return candidates.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  dimensionCheck(modelId: string, expectedDimension: number): boolean {
    const row = this.db.get<{ dim: number }>(
      "SELECT LENGTH(embedding) / 4 AS dim FROM node_embeddings WHERE model_id = ? LIMIT 1",
      [modelId],
    );
    return row ? row.dim === expectedDimension : true;
  }

  deleteByModel(modelId: string): number {
    const result = this.db.run("DELETE FROM node_embeddings WHERE model_id = ?", [modelId]);
    return result.changes;
  }

  cosineSearch(
    queryEmbedding: Float32Array,
    options: {
      nodeKind?: string;
      agentId: string | null;
      modelId?: string;
      limit?: number;
    },
  ): Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }> {
    return this.query(queryEmbedding, options);
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
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

  private deserializeEmbedding(blob: Buffer): Float32Array {
    const bytes = Buffer.from(blob);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Float32Array(arrayBuffer);
  }

  private serializeEmbedding(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }

  private isNodeVisibleForAgent(
    nodeRef: NodeRef,
    nodeKind: string,
    agentId: string | null,
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
