import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  ensureTestPgAppDb,
  createTestPgAppPool,
  withTestAppSchema,
  teardownAppPool,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("pgvector-available", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    sql = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(sql);
  });

  it("pgvector extension is installed", async () => {
    const [row] = await sql`
      SELECT 1 AS installed FROM pg_extension WHERE extname = 'vector'
    `;
    expect(row).toBeDefined();
    expect(row.installed).toBe(1);
  });

  it("can create a table with vector column", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await pool`CREATE EXTENSION IF NOT EXISTS vector`;
      await pool`
        CREATE TABLE IF NOT EXISTS test_vectors (
          id SERIAL PRIMARY KEY,
          embedding VECTOR(1536)
        )
      `;

      const [row] = await pool`
        SELECT 1 AS created FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'test_vectors'
      `;
      expect(row?.created).toBe(1);
    });
  });

  it("can insert and query vectors", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await pool`CREATE EXTENSION IF NOT EXISTS vector`;
      await pool`
        CREATE TABLE IF NOT EXISTS test_vectors (
          id SERIAL PRIMARY KEY,
          embedding VECTOR(3)
        )
      `;

      await pool`
        INSERT INTO test_vectors (embedding) VALUES (${`[1,2,3]`}::vector)
      `;

      const [row] = await pool`
        SELECT id, embedding::text AS embedding_str FROM test_vectors LIMIT 1
      `;
      expect(row).toBeDefined();
      expect(row.id).toBeDefined();
      expect(row.embedding_str).toBe("[1,2,3]");
    });
  });
});
