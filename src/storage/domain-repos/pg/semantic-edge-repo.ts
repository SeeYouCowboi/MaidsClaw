import type postgres from "postgres";
import type { NodeRef, SemanticEdgeType } from "../../../memory/types.js";
import type { SemanticEdgeRepo } from "../contracts/semantic-edge-repo.js";

type SemanticEdgeRow = {
  source: string;
  target: string;
  relation_type: string;
  weight: number | string;
  created_at: number | string;
  updated_at: number | string;
};

export class PgSemanticEdgeRepo implements SemanticEdgeRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async upsert(sourceRef: NodeRef, targetRef: NodeRef, relationType: SemanticEdgeType, weight: number): Promise<void> {
    const now = Date.now();
    await this.sql`
      INSERT INTO semantic_edges
        (source, target, relation_type, weight, created_at, updated_at)
      VALUES
        (${sourceRef}, ${targetRef}, ${relationType}, ${weight}, ${now}, ${now})
      ON CONFLICT (source, target, relation_type)
      DO UPDATE SET
        weight = EXCLUDED.weight,
        updated_at = EXCLUDED.updated_at
    `;
  }

  async queryBySource(
    sourceNodeRef: NodeRef,
    relationType?: SemanticEdgeType,
  ): Promise<Array<{ sourceRef: NodeRef; targetRef: NodeRef; relationType: SemanticEdgeType; weight: number }>> {
    const rows = relationType
      ? await this.sql<SemanticEdgeRow[]>`
          SELECT source, target, relation_type, weight, created_at, updated_at
          FROM semantic_edges
          WHERE source = ${sourceNodeRef}
            AND relation_type = ${relationType}
          ORDER BY weight DESC, updated_at DESC
        `
      : await this.sql<SemanticEdgeRow[]>`
          SELECT source, target, relation_type, weight, created_at, updated_at
          FROM semantic_edges
          WHERE source = ${sourceNodeRef}
          ORDER BY weight DESC, updated_at DESC
        `;

    return rows.map((row) => ({
      sourceRef: row.source as NodeRef,
      targetRef: row.target as NodeRef,
      relationType: row.relation_type as SemanticEdgeType,
      weight: Number(row.weight),
    }));
  }

  async queryByTarget(
    targetNodeRef: NodeRef,
    relationType?: SemanticEdgeType,
  ): Promise<Array<{ sourceRef: NodeRef; targetRef: NodeRef; relationType: SemanticEdgeType; weight: number }>> {
    const rows = relationType
      ? await this.sql<SemanticEdgeRow[]>`
          SELECT source, target, relation_type, weight, created_at, updated_at
          FROM semantic_edges
          WHERE target = ${targetNodeRef}
            AND relation_type = ${relationType}
          ORDER BY weight DESC, updated_at DESC
        `
      : await this.sql<SemanticEdgeRow[]>`
          SELECT source, target, relation_type, weight, created_at, updated_at
          FROM semantic_edges
          WHERE target = ${targetNodeRef}
          ORDER BY weight DESC, updated_at DESC
        `;

    return rows.map((row) => ({
      sourceRef: row.source as NodeRef,
      targetRef: row.target as NodeRef,
      relationType: row.relation_type as SemanticEdgeType,
      weight: Number(row.weight),
    }));
  }

  async deleteForNodes(nodeRefs: NodeRef[]): Promise<number> {
    if (nodeRefs.length === 0) {
      return 0;
    }

    const result = await this.sql`
      DELETE FROM semantic_edges
      WHERE source IN ${this.sql(nodeRefs)}
         OR target IN ${this.sql(nodeRefs)}
    `;
    return result.count;
  }
}
