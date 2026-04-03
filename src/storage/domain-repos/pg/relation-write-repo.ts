import type postgres from "postgres";
import type { MemoryRelationType } from "../../../memory/types.js";
import type {
  MemoryRelationRow,
  RelationWriteRepo,
  UpsertRelationParams,
} from "../contracts/relation-write-repo.js";

type MemoryRelationDbRow = {
  source_node_ref: string;
  target_node_ref: string;
  relation_type: string;
  source_kind: string;
  source_ref: string;
  strength: number | string;
  directness: string;
  created_at: number | string;
  updated_at: number | string;
};

export class PgRelationWriteRepo implements RelationWriteRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async upsertRelation(params: UpsertRelationParams): Promise<void> {
    await this.sql`
      INSERT INTO memory_relations
        (source_node_ref, target_node_ref, relation_type, source_kind, source_ref, strength, directness, created_at, updated_at)
      VALUES
        (
          ${params.sourceNodeRef},
          ${params.targetNodeRef},
          ${params.relationType},
          ${params.sourceKind},
          ${params.sourceRef},
          ${params.strength},
          ${params.directness},
          ${params.createdAt},
          ${params.updatedAt}
        )
      ON CONFLICT(source_node_ref, target_node_ref, relation_type, source_kind, source_ref)
      DO UPDATE SET
        strength = EXCLUDED.strength,
        directness = EXCLUDED.directness,
        updated_at = EXCLUDED.updated_at
    `;
  }

  async getRelationsBySource(sourceNodeRef: string, relationType?: MemoryRelationType): Promise<MemoryRelationRow[]> {
    const rows = relationType
      ? await this.sql<MemoryRelationDbRow[]>`
          SELECT source_node_ref, target_node_ref, relation_type, source_kind, source_ref, strength, directness, created_at, updated_at
          FROM memory_relations
          WHERE source_node_ref = ${sourceNodeRef}
            AND relation_type = ${relationType}
        `
      : await this.sql<MemoryRelationDbRow[]>`
          SELECT source_node_ref, target_node_ref, relation_type, source_kind, source_ref, strength, directness, created_at, updated_at
          FROM memory_relations
          WHERE source_node_ref = ${sourceNodeRef}
        `;

    return rows.map(normalizeMemoryRelationRow);
  }

  async getRelationsForNode(nodeRef: string, relationTypes: readonly MemoryRelationType[]): Promise<MemoryRelationRow[]> {
    const rows = await this.sql.unsafe<MemoryRelationDbRow[]>(
      `SELECT source_node_ref, target_node_ref, relation_type, source_kind, source_ref, strength, directness, created_at, updated_at
       FROM memory_relations
       WHERE (source_node_ref = $1 OR target_node_ref = $1)
         AND relation_type = ANY($2::text[])`,
      [nodeRef, relationTypes],
    );

    return rows.map(normalizeMemoryRelationRow);
  }
}

function normalizeMemoryRelationRow(row: MemoryRelationDbRow): MemoryRelationRow {
  return {
    source_node_ref: row.source_node_ref,
    target_node_ref: row.target_node_ref,
    relation_type: row.relation_type as MemoryRelationType,
    source_kind: row.source_kind as MemoryRelationRow["source_kind"],
    source_ref: row.source_ref,
    strength: Number(row.strength),
    directness: row.directness as MemoryRelationRow["directness"],
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}
