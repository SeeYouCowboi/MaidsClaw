import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import type { MemoryRelationType } from "../../src/memory/types.js";
import { PgRelationWriteRepo } from "../../src/storage/domain-repos/pg/relation-write-repo.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

async function bootstrapRelationSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS memory_relations (
      id              BIGSERIAL PRIMARY KEY,
      source_node_ref TEXT NOT NULL,
      target_node_ref TEXT NOT NULL,
      relation_type   TEXT NOT NULL,
      strength        REAL NOT NULL,
      directness      TEXT NOT NULL,
      source_kind     TEXT NOT NULL,
      source_ref      TEXT NOT NULL,
      created_at      BIGINT NOT NULL,
      updated_at      BIGINT NOT NULL,
      UNIQUE(source_node_ref, target_node_ref, relation_type, source_kind, source_ref)
    )
  `);
}

describe.skipIf(skipPgTests)("PgRelationWriteRepo", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("Upsert relation creates new and updates existing", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapRelationSchema(sql);
      const repo = new PgRelationWriteRepo(sql);

      await repo.upsertRelation({
        sourceNodeRef: "assertion:1",
        targetNodeRef: "assertion:2",
        relationType: "conflicts_with",
        sourceKind: "turn",
        sourceRef: "turn:1",
        strength: 0.4,
        directness: "direct",
        createdAt: 1000,
        updatedAt: 1000,
      });

      const initialRows = await sql`
        SELECT source_node_ref, target_node_ref, relation_type, source_kind, source_ref, strength, directness, created_at, updated_at
        FROM memory_relations
      `;
      expect(initialRows).toHaveLength(1);
      expect(Number(initialRows[0].strength)).toBe(0.4);
      expect(initialRows[0].directness).toBe("direct");
      expect(Number(initialRows[0].created_at)).toBe(1000);

      await repo.upsertRelation({
        sourceNodeRef: "assertion:1",
        targetNodeRef: "assertion:2",
        relationType: "conflicts_with",
        sourceKind: "turn",
        sourceRef: "turn:1",
        strength: 0.9,
        directness: "inferred",
        createdAt: 2000,
        updatedAt: 3000,
      });

      const rows = await sql`
        SELECT source_node_ref, target_node_ref, relation_type, source_kind, source_ref, strength, directness, created_at, updated_at
        FROM memory_relations
      `;

      expect(rows).toHaveLength(1);
      expect(Number(rows[0].strength)).toBe(0.9);
      expect(rows[0].directness).toBe("inferred");
      expect(Number(rows[0].created_at)).toBe(1000);
      expect(Number(rows[0].updated_at)).toBe(3000);
    });
  });

  it("Query by source and type filters correctly", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapRelationSchema(sql);
      const repo = new PgRelationWriteRepo(sql);

      const rows: Array<{ target: string; type: MemoryRelationType }> = [
        { target: "assertion:2", type: "supports" },
        { target: "assertion:3", type: "conflicts_with" },
        { target: "assertion:4", type: "resolved_by" },
      ];

      for (const [index, row] of rows.entries()) {
        await repo.upsertRelation({
          sourceNodeRef: "assertion:1",
          targetNodeRef: row.target,
          relationType: row.type,
          sourceKind: "job",
          sourceRef: `job:${index + 1}`,
          strength: 0.5 + index * 0.1,
          directness: "direct",
          createdAt: 1000 + index,
          updatedAt: 1000 + index,
        });
      }

      const supportsRows = await repo.getRelationsBySource("assertion:1", "supports");
      expect(supportsRows).toHaveLength(1);
      expect(supportsRows[0].relation_type).toBe("supports");

      const allRows = await repo.getRelationsBySource("assertion:1");
      expect(allRows).toHaveLength(3);

      const nodeRows = await repo.getRelationsForNode("assertion:3", ["supports", "conflicts_with"]);
      expect(nodeRows).toHaveLength(1);
      expect(nodeRows[0].source_node_ref).toBe("assertion:1");
      expect(nodeRows[0].target_node_ref).toBe("assertion:3");
      expect(nodeRows[0].relation_type).toBe("conflicts_with");
    });
  });
});
