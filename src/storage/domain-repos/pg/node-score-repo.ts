import type postgres from "postgres";
import type { NodeRef } from "../../../memory/types.js";
import type { NodeScoreRepo } from "../contracts/node-score-repo.js";

type NodeScoreRow = {
  node_ref: string;
  salience: number | string;
  centrality: number | string;
  bridge_score: number | string;
  updated_at: number | string;
};

type StatsRow = {
  model_id: string;
  count: number | string;
  dimension: number | string;
};

export class PgNodeScoreRepo implements NodeScoreRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async upsert(nodeRef: NodeRef, salience: number, centrality: number, bridgeScore: number): Promise<void> {
    const now = Date.now();
    await this.sql`
      INSERT INTO node_scores
        (node_ref, salience, centrality, bridge_score, updated_at)
      VALUES
        (${nodeRef}, ${salience}, ${centrality}, ${bridgeScore}, ${now})
      ON CONFLICT (node_ref)
      DO UPDATE SET
        salience = EXCLUDED.salience,
        centrality = EXCLUDED.centrality,
        bridge_score = EXCLUDED.bridge_score,
        updated_at = EXCLUDED.updated_at
    `;
  }

  async getEmbeddingStatsByModel(): Promise<Array<{ model_id: string; count: number; dimension: number }>> {
    const rows = await this.sql<StatsRow[]>`
      SELECT model_id, COUNT(*)::int AS count, vector_dims(embedding)::int AS dimension
      FROM node_embeddings
      GROUP BY model_id, vector_dims(embedding)
      ORDER BY COUNT(*) DESC
    `;

    return rows.map((row) => ({
      model_id: row.model_id,
      count: Number(row.count),
      dimension: Number(row.dimension),
    }));
  }

  async getByNodeRef(
    nodeRef: NodeRef,
  ): Promise<{ nodeRef: NodeRef; salience: number; centrality: number; bridgeScore: number; updatedAt: number } | null> {
    const rows = await this.sql<NodeScoreRow[]>`
      SELECT node_ref, salience, centrality, bridge_score, updated_at
      FROM node_scores
      WHERE node_ref = ${nodeRef}
      LIMIT 1
    `;

    if (rows.length === 0) {
      return null;
    }

    return {
      nodeRef: rows[0].node_ref as NodeRef,
      salience: Number(rows[0].salience),
      centrality: Number(rows[0].centrality),
      bridgeScore: Number(rows[0].bridge_score),
      updatedAt: Number(rows[0].updated_at),
    };
  }

  async getTopByField(
    field: "salience" | "centrality" | "bridge_score",
    limit: number,
  ): Promise<Array<{ nodeRef: NodeRef; salience: number; centrality: number; bridgeScore: number; updatedAt: number }>> {
    const safeField = field;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;

    const rows = await this.sql.unsafe(
      `SELECT node_ref, salience, centrality, bridge_score, updated_at
       FROM node_scores
       ORDER BY ${safeField} DESC, updated_at DESC
       LIMIT $1`,
      [safeLimit],
    ) as NodeScoreRow[];

    return rows.map((row) => ({
      nodeRef: row.node_ref as NodeRef,
      salience: Number(row.salience),
      centrality: Number(row.centrality),
      bridgeScore: Number(row.bridge_score),
      updatedAt: Number(row.updated_at),
    }));
  }

  async deleteForNodes(nodeRefs: NodeRef[]): Promise<number> {
    if (nodeRefs.length === 0) {
      return 0;
    }

    const result = await this.sql`
      DELETE FROM node_scores
      WHERE node_ref IN ${this.sql(nodeRefs)}
    `;
    return result.count;
  }
}
