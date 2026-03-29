import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";

const describeWithSkipIf = describe as typeof describe & {
  skipIf: (condition: boolean) => (name: string, fn: () => void) => void;
};

describeWithSkipIf.skipIf(!process.env.PG_APP_TEST_URL)("pg-derived-schema bootstrap", () => {
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
      const now = Date.now();

      const [row] = await pool`
        INSERT INTO node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at)
        VALUES ('event:1', 'event', 'primary', 'text-embedding-3-large', ${embedding}::vector, ${now})
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
