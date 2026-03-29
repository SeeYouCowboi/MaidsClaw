import type { GraphStorageService } from "../../../memory/storage.js";
import type { NodeRef, SemanticEdgeType } from "../../../memory/types.js";
import type { Db } from "../../database.js";
import type { SemanticEdgeRepo } from "../contracts/semantic-edge-repo.js";

export class SqliteSemanticEdgeRepoAdapter implements SemanticEdgeRepo {
  constructor(
    private readonly impl: GraphStorageService,
    private readonly db?: Db,
  ) {}

  async upsert(sourceRef: NodeRef, targetRef: NodeRef, relationType: SemanticEdgeType, weight: number): Promise<void> {
    return Promise.resolve(this.impl.upsertSemanticEdge(sourceRef, targetRef, relationType, weight));
  }

  async queryBySource(
    sourceNodeRef: NodeRef,
    relationType?: SemanticEdgeType,
  ): Promise<Array<{ sourceRef: NodeRef; targetRef: NodeRef; relationType: SemanticEdgeType; weight: number }>> {
    const db = this.resolveDb();
    const rows = relationType
      ? db.query<{
          source_node_ref: string;
          target_node_ref: string;
          relation_type: string;
          weight: number;
        }>(
          `SELECT source_node_ref, target_node_ref, relation_type, weight
           FROM semantic_edges
           WHERE source_node_ref = ? AND relation_type = ?
           ORDER BY weight DESC, updated_at DESC`,
          [sourceNodeRef, relationType],
        )
      : db.query<{
          source_node_ref: string;
          target_node_ref: string;
          relation_type: string;
          weight: number;
        }>(
          `SELECT source_node_ref, target_node_ref, relation_type, weight
           FROM semantic_edges
           WHERE source_node_ref = ?
           ORDER BY weight DESC, updated_at DESC`,
          [sourceNodeRef],
        );

    return rows.map((row) => ({
      sourceRef: row.source_node_ref as NodeRef,
      targetRef: row.target_node_ref as NodeRef,
      relationType: row.relation_type as SemanticEdgeType,
      weight: row.weight,
    }));
  }

  async queryByTarget(
    targetNodeRef: NodeRef,
    relationType?: SemanticEdgeType,
  ): Promise<Array<{ sourceRef: NodeRef; targetRef: NodeRef; relationType: SemanticEdgeType; weight: number }>> {
    const db = this.resolveDb();
    const rows = relationType
      ? db.query<{
          source_node_ref: string;
          target_node_ref: string;
          relation_type: string;
          weight: number;
        }>(
          `SELECT source_node_ref, target_node_ref, relation_type, weight
           FROM semantic_edges
           WHERE target_node_ref = ? AND relation_type = ?
           ORDER BY weight DESC, updated_at DESC`,
          [targetNodeRef, relationType],
        )
      : db.query<{
          source_node_ref: string;
          target_node_ref: string;
          relation_type: string;
          weight: number;
        }>(
          `SELECT source_node_ref, target_node_ref, relation_type, weight
           FROM semantic_edges
           WHERE target_node_ref = ?
           ORDER BY weight DESC, updated_at DESC`,
          [targetNodeRef],
        );

    return rows.map((row) => ({
      sourceRef: row.source_node_ref as NodeRef,
      targetRef: row.target_node_ref as NodeRef,
      relationType: row.relation_type as SemanticEdgeType,
      weight: row.weight,
    }));
  }

  async deleteForNodes(nodeRefs: NodeRef[]): Promise<number> {
    if (nodeRefs.length === 0) {
      return 0;
    }
    const db = this.resolveDb();
    const placeholders = nodeRefs.map(() => "?").join(",");
    const result = db.run(
      `DELETE FROM semantic_edges
       WHERE source_node_ref IN (${placeholders})
          OR target_node_ref IN (${placeholders})`,
      [...nodeRefs, ...nodeRefs],
    );
    return result.changes;
  }

  private resolveDb(): Db {
    if (this.db) {
      return this.db;
    }
    const candidate = (this.impl as unknown as { db?: Db }).db;
    if (!candidate) {
      throw new Error("SqliteSemanticEdgeRepoAdapter requires Db instance");
    }
    return candidate;
  }
}
