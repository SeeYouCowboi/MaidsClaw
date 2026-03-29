import type { GraphStorageService } from "../../../memory/storage.js";
import type { NodeRef } from "../../../memory/types.js";
import type { Db } from "../../database.js";
import type { NodeScoreRepo } from "../contracts/node-score-repo.js";

export class SqliteNodeScoreRepoAdapter implements NodeScoreRepo {
  constructor(
    private readonly impl: GraphStorageService,
    private readonly db?: Db,
  ) {}

  async upsert(nodeRef: NodeRef, salience: number, centrality: number, bridgeScore: number): Promise<void> {
    return Promise.resolve(this.impl.upsertNodeScores(nodeRef, salience, centrality, bridgeScore));
  }

  async getByNodeRef(
    nodeRef: NodeRef,
  ): Promise<{ nodeRef: NodeRef; salience: number; centrality: number; bridgeScore: number; updatedAt: number } | null> {
    const db = this.resolveDb();
    const row = db.get<{
      node_ref: string;
      salience: number;
      centrality: number;
      bridge_score: number;
      updated_at: number;
    }>(
      `SELECT node_ref, salience, centrality, bridge_score, updated_at
       FROM node_scores
       WHERE node_ref = ?
       LIMIT 1`,
      [nodeRef],
    );
    if (!row) {
      return null;
    }
    return {
      nodeRef: row.node_ref as NodeRef,
      salience: row.salience,
      centrality: row.centrality,
      bridgeScore: row.bridge_score,
      updatedAt: row.updated_at,
    };
  }

  async getTopByField(
    field: "salience" | "centrality" | "bridge_score",
    limit: number,
  ): Promise<Array<{ nodeRef: NodeRef; salience: number; centrality: number; bridgeScore: number; updatedAt: number }>> {
    const db = this.resolveDb();
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
    const rows = db.query<{
      node_ref: string;
      salience: number;
      centrality: number;
      bridge_score: number;
      updated_at: number;
    }>(
      `SELECT node_ref, salience, centrality, bridge_score, updated_at
       FROM node_scores
       ORDER BY ${field} DESC, updated_at DESC
       LIMIT ?`,
      [safeLimit],
    );

    return rows.map((row) => ({
      nodeRef: row.node_ref as NodeRef,
      salience: row.salience,
      centrality: row.centrality,
      bridgeScore: row.bridge_score,
      updatedAt: row.updated_at,
    }));
  }

  async deleteForNodes(nodeRefs: NodeRef[]): Promise<number> {
    if (nodeRefs.length === 0) {
      return 0;
    }
    const db = this.resolveDb();
    const placeholders = nodeRefs.map(() => "?").join(",");
    const result = db.run(
      `DELETE FROM node_scores WHERE node_ref IN (${placeholders})`,
      nodeRefs,
    );
    return result.changes;
  }

  async getEmbeddingStatsByModel(): Promise<Array<{ model_id: string; count: number; dimension: number }>> {
    return Promise.resolve(this.impl.getEmbeddingStatsByModel());
  }

  private resolveDb(): Db {
    if (this.db) {
      return this.db;
    }
    const candidate = (this.impl as unknown as { db?: Db }).db;
    if (!candidate) {
      throw new Error("SqliteNodeScoreRepoAdapter requires Db instance");
    }
    return candidate;
  }
}
