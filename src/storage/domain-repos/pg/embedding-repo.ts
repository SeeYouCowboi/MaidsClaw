import type postgres from "postgres";
import type { EmbeddingViewType, NodeRef, NodeRefKind } from "../../../memory/types.js";
import type { EmbeddingRepo } from "../contracts/embedding-repo.js";

type EmbeddingRow = {
  node_ref: string;
  node_kind: string;
  view_type: string;
  model_id: string;
  embedding: unknown;
  updated_at: string | number;
};

type CosineRow = {
  node_ref: string;
  node_kind: string;
  distance: string | number;
};

function float32ToVector(arr: Float32Array): string {
  return `[${Array.from(arr).join(",")}]`;
}

function parseVectorString(input: string): Float32Array {
  const text = input.trim();
  if (!text.startsWith("[") || !text.endsWith("]")) {
    return new Float32Array(0);
  }
  const payload = text.slice(1, -1).trim();
  if (payload.length === 0) {
    return new Float32Array(0);
  }
  const values = payload
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
  return new Float32Array(values);
}

function parseVector(value: unknown): Float32Array {
  if (value instanceof Float32Array) {
    return new Float32Array(value);
  }

  if (typeof value === "string") {
    return parseVectorString(value);
  }

  if (Array.isArray(value)) {
    return new Float32Array(value.map((item) => Number(item)));
  }

  if (value instanceof Uint8Array) {
    const arrayBuffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    return new Float32Array(arrayBuffer);
  }

  return new Float32Array(0);
}

export class PgEmbeddingRepo implements EmbeddingRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async upsert(
    nodeRef: NodeRef,
    nodeKind: NodeRefKind,
    viewType: EmbeddingViewType,
    modelId: string,
    embedding: Float32Array,
  ): Promise<void> {
    if (embedding.length === 0) {
      throw new Error(`Embedding dimension is 0 for node ${nodeRef} (model: ${modelId})`);
    }

    const dimensionOk = await this.dimensionCheck(modelId, embedding.length);
    if (!dimensionOk) {
      throw new Error(
        `Embedding dimension mismatch for model "${modelId}": expected existing model dimension, got ${embedding.length} (node: ${nodeRef})`,
      );
    }

    const now = Date.now();
    const vector = float32ToVector(embedding);

    await this.sql`
      INSERT INTO node_embeddings
        (node_ref, node_kind, view_type, model_id, embedding, updated_at)
      VALUES
        (${nodeRef}, ${nodeKind}, ${viewType}, ${modelId}, ${vector}::vector, ${now})
      ON CONFLICT (node_ref, view_type, model_id)
      DO UPDATE SET
        node_kind = EXCLUDED.node_kind,
        embedding = EXCLUDED.embedding,
        updated_at = EXCLUDED.updated_at
    `;
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
    return this.cosineSearch(queryEmbedding, options);
  }

  async dimensionCheck(modelId: string, expectedDimension: number): Promise<boolean> {
    const rows = await this.sql<{ dim: number | string }[]>`
      SELECT vector_dims(embedding) AS dim
      FROM node_embeddings
      WHERE model_id = ${modelId}
      LIMIT 1
    `;

    if (rows.length === 0 || rows[0].dim == null) {
      return true;
    }

    return Number(rows[0].dim) === expectedDimension;
  }

  async deleteByModel(modelId: string): Promise<number> {
    const result = await this.sql`
      DELETE FROM node_embeddings
      WHERE model_id = ${modelId}
    `;
    return result.count;
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
    const modelId = options.modelId;
    if (!modelId) {
      throw new Error("modelId is required for cosineSearch to enforce model epoch binding");
    }

    if (queryEmbedding.length === 0) {
      return [];
    }

    const vector = float32ToVector(queryEmbedding);
    const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : 20;

    const whereClauses: string[] = ["ne.model_id = $2"];
    const params: Array<string | number> = [vector, modelId];
    let paramIndex = 3;

    if (options.nodeKind) {
      whereClauses.push(`ne.node_kind = $${paramIndex}`);
      params.push(options.nodeKind);
      paramIndex += 1;
    }

    if (options.agentId == null) {
      // Without an agent context, exclude any kind that is per-agent private:
      // cognition overlays (assertion/evaluation/commitment) and episodes.
      whereClauses.push(
        "ne.node_kind NOT IN ('assertion', 'evaluation', 'commitment', 'episode')",
      );
    } else {
      // Allow public kinds (anything that is not a private per-agent kind)
      // OR allow cognition/episode rows that belong to this specific agent,
      // gated by an EXISTS against the authoritative source table.
      const agentIdx = paramIndex;
      whereClauses.push(`(
        ne.node_kind NOT IN ('assertion', 'evaluation', 'commitment', 'episode')
        OR (
          ne.node_kind IN ('assertion', 'evaluation', 'commitment')
          AND ne.node_ref ~ '^[^:]+:[0-9]+$'
          AND EXISTS (
            SELECT 1
            FROM private_cognition_current pcc
            WHERE pcc.id = split_part(ne.node_ref, ':', 2)::bigint
              AND pcc.agent_id = $${agentIdx}
          )
        )
        OR (
          ne.node_kind = 'episode'
          AND ne.node_ref ~ '^episode:[0-9]+$'
          AND EXISTS (
            SELECT 1
            FROM private_episode_events pee
            WHERE pee.id = split_part(ne.node_ref, ':', 2)::bigint
              AND pee.agent_id = $${agentIdx}
          )
        )
      )`);
      params.push(options.agentId);
      paramIndex += 1;
    }

    params.push(limit);
    const limitParam = paramIndex;

    const rows = await this.sql.unsafe(
      `SELECT
         ne.node_ref,
         ne.node_kind,
         (ne.embedding <=> $1::vector) AS distance
       FROM node_embeddings ne
       WHERE ${whereClauses.join(" AND ")}
       ORDER BY distance ASC
       LIMIT $${limitParam}`,
      params,
    ) as CosineRow[];

    return rows.map((row) => ({
      nodeRef: row.node_ref as NodeRef,
      similarity: 1 - Number(row.distance),
      nodeKind: row.node_kind,
    }));
  }

  async getByNodeRef(
    nodeRef: NodeRef,
    modelId: string,
  ): Promise<Array<{
    nodeRef: NodeRef;
    nodeKind: NodeRefKind;
    viewType: EmbeddingViewType;
    modelId: string;
    embedding: Float32Array;
    updatedAt: number;
  }>> {
    const rows = await this.sql<EmbeddingRow[]>`
      SELECT node_ref, node_kind, view_type, model_id, embedding, updated_at
      FROM node_embeddings
      WHERE node_ref = ${nodeRef}
        AND model_id = ${modelId}
      ORDER BY updated_at DESC
    `;

    return rows.map((row) => ({
      nodeRef: row.node_ref as NodeRef,
      nodeKind: row.node_kind as NodeRefKind,
      viewType: row.view_type as EmbeddingViewType,
      modelId: row.model_id,
      embedding: parseVector(row.embedding),
      updatedAt: Number(row.updated_at),
    }));
  }
}
