/**
 * PG embedding rebuild — model epoch contract: all writes scoped to a single `modelId`.
 * No cross-model writes occur during a rebuild cycle.
 */

import type postgres from "postgres";
import type { EmbeddingViewType, NodeRef, NodeRefKind } from "./types.js";
import { PgEmbeddingRepo } from "../storage/domain-repos/pg/embedding-repo.js";
import { PgSemanticEdgeRepo } from "../storage/domain-repos/pg/semantic-edge-repo.js";
import { PgNodeScoreRepo } from "../storage/domain-repos/pg/node-score-repo.js";

const DEFAULT_SIMILARITY_THRESHOLD = 0.7;

export type EmbeddingInput = {
  nodeRef: NodeRef;
  nodeKind: NodeRefKind;
  viewType: EmbeddingViewType;
  vector: Float32Array;
};

export type NodeScoreInput = {
  nodeRef: NodeRef;
  salience: number;
  centrality: number;
  bridge: number;
};

export type RebuildEmbeddingsResult = {
  inserted: number;
};

export type RebuildSemanticEdgesResult = {
  inserted: number;
};

export type RebuildNodeScoresResult = {
  updated: number;
};

export type RebuildAllResult = {
  embeddings: number;
  edges: number;
};

export class PgEmbeddingRebuilder {
  private readonly embeddingRepo: PgEmbeddingRepo;
  private readonly edgeRepo: PgSemanticEdgeRepo;
  private readonly scoreRepo: PgNodeScoreRepo;

  constructor(private readonly sql: postgres.Sql) {
    this.embeddingRepo = new PgEmbeddingRepo(sql);
    this.edgeRepo = new PgSemanticEdgeRepo(sql);
    this.scoreRepo = new PgNodeScoreRepo(sql);
  }

  async rebuildEmbeddings(
    modelId: string,
    embeddings: EmbeddingInput[],
    options?: { clearFirst?: boolean },
  ): Promise<RebuildEmbeddingsResult> {
    const clearFirst = options?.clearFirst ?? true;

    if (clearFirst) {
      await this.embeddingRepo.deleteByModel(modelId);
    }

    let inserted = 0;
    for (const entry of embeddings) {
      await this.embeddingRepo.upsert(
        entry.nodeRef,
        entry.nodeKind,
        entry.viewType,
        modelId,
        entry.vector,
      );
      inserted += 1;
    }

    return { inserted };
  }

  async rebuildSemanticEdges(
    modelId: string,
    options?: { similarityThreshold?: number },
  ): Promise<RebuildSemanticEdgesResult> {
    const threshold = options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;

    const rows = await this.sql<{ node_ref: string; node_kind: string; embedding: unknown }[]>`
      SELECT node_ref, node_kind, embedding
      FROM node_embeddings
      WHERE model_id = ${modelId}
        AND view_type = 'primary'
      ORDER BY node_ref
    `;

    if (rows.length === 0) {
      return { inserted: 0 };
    }

    const nodeRefs = rows.map((r) => r.node_ref as NodeRef);
    await this.edgeRepo.deleteForNodes(nodeRefs);

    let inserted = 0;
    const processed = new Set<string>();

    for (const row of rows) {
      const sourceRef = row.node_ref as NodeRef;
      processed.add(sourceRef);

      const similar = await this.embeddingRepo.cosineSearch(
        this.parseEmbedding(row.embedding),
        {
          agentId: null,
          modelId,
          limit: rows.length,
        },
      );

      for (const match of similar) {
        if (match.nodeRef === sourceRef) continue;
        if (processed.has(match.nodeRef)) continue;
        if (match.similarity < threshold) continue;

        await this.edgeRepo.upsert(
          sourceRef,
          match.nodeRef,
          "semantic_similar",
          match.similarity,
        );
        inserted += 1;
      }
    }

    return { inserted };
  }

  async rebuildNodeScores(
    updates: NodeScoreInput[],
  ): Promise<RebuildNodeScoresResult> {
    let updated = 0;
    for (const entry of updates) {
      await this.scoreRepo.upsert(
        entry.nodeRef,
        entry.salience,
        entry.centrality,
        entry.bridge,
      );
      updated += 1;
    }
    return { updated };
  }

  async rebuildAll(
    modelId: string,
    embeddings: EmbeddingInput[],
    options?: { similarityThreshold?: number },
  ): Promise<RebuildAllResult> {
    const embResult = await this.rebuildEmbeddings(modelId, embeddings, { clearFirst: true });
    const edgeResult = await this.rebuildSemanticEdges(modelId, {
      similarityThreshold: options?.similarityThreshold,
    });

    return {
      embeddings: embResult.inserted,
      edges: edgeResult.inserted,
    };
  }

  private parseEmbedding(value: unknown): Float32Array {
    if (value instanceof Float32Array) {
      return value;
    }
    if (typeof value === "string") {
      const text = value.trim();
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
        .filter((v) => Number.isFinite(v));
      return new Float32Array(values);
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
}
