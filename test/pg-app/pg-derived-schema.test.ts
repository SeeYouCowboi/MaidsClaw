import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("pg-derived-schema bootstrap", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    sql = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(sql);
  });

  it("is idempotent", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapDerivedSchema(pool);
      await bootstrapDerivedSchema(pool);
    });
  });

  it("supports pg_trgm-backed search_docs_private content queries", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapDerivedSchema(pool);

      const now = Date.now();
      await pool`
        INSERT INTO search_docs_private (doc_type, source_ref, agent_id, content, created_at)
        VALUES ('assertion', 'ref-1', 'agent-1', 'hello world from projection search', ${now})
      `;

      const rows = await pool`
        SELECT id
        FROM search_docs_private
        WHERE content ILIKE '%hello%'
      `;
      expect(rows.length).toBe(1);
    });
  });

  it("stores and reads vector embeddings in node_embeddings", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapDerivedSchema(pool, { embeddingDim: 1536 });

      const embedding = Array.from({ length: 1536 }, (_, i) => (i % 7) / 7);
      const embeddingLiteral = `[${embedding.join(",")}]`;
      const now = Date.now();

      const [row] = await pool`
        INSERT INTO node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at)
        VALUES ('event:1', 'event', 'primary', 'text-embedding-3-large', ${embeddingLiteral}::vector, ${now})
        RETURNING id
      `;
      expect(Number(row.id)).toBeGreaterThan(0);

      const [found] = await pool`
        SELECT id
        FROM node_embeddings
        WHERE node_ref = 'event:1'
      `;
      expect(Number(found.id)).toBeGreaterThan(0);
    });
  });

  it("creates graph_nodes and supports insert/query round-trip", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapDerivedSchema(pool);

      const now = Date.now();
      await pool`
        INSERT INTO graph_nodes (node_kind, node_id, node_ref, created_at, updated_at)
        VALUES ('event', '42', 'event:42', ${now}, ${now})
      `;

      const rows = await pool`
        SELECT node_kind, node_id, node_ref
        FROM graph_nodes
        WHERE node_ref = 'event:42'
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].node_kind).toBe("event");
      expect(rows[0].node_id).toBe("42");
      expect(rows[0].node_ref).toBe("event:42");

      const later = now + 1000;
      await pool`
        INSERT INTO graph_nodes (node_kind, node_id, node_ref, created_at, updated_at)
        VALUES ('event', '42', 'event:42', ${later}, ${later})
        ON CONFLICT (node_kind, node_id)
        DO UPDATE SET updated_at = EXCLUDED.updated_at
      `;

      const afterUpsert = await pool`
        SELECT COUNT(*) as cnt FROM graph_nodes WHERE node_ref = 'event:42'
      `;
      expect(Number(afterUpsert[0].cnt)).toBe(1);
    });
  });

  it("does not create any *_fts sidecar tables", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapDerivedSchema(pool);

      const rows = await pool`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name LIKE '%\_fts' ESCAPE '\\'
      `;
      expect(rows.length).toBe(0);
    });
  });
});
