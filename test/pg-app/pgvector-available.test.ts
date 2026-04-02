import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  ensureTestPgAppDb,
  createTestPgAppPool,
  resetAppSchema,
  teardownAppPool,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("pgvector-available", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    sql = createTestPgAppPool();
    await resetAppSchema(sql);
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
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await sql`
      CREATE TABLE IF NOT EXISTS test_vectors (
        id SERIAL PRIMARY KEY,
        embedding VECTOR(1536)
      )
    `;

    const [row] = await sql`
      SELECT 1 AS created FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'test_vectors'
    `;
    expect(row?.created).toBe(1);

    await sql`DROP TABLE test_vectors`;
  });

  it("can insert and query vectors", async () => {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await sql`
      CREATE TABLE IF NOT EXISTS test_vectors (
        id SERIAL PRIMARY KEY,
        embedding VECTOR(3)
      )
    `;

    const embedding = [1.0, 2.0, 3.0];
    await sql`
      INSERT INTO test_vectors (embedding) VALUES (${embedding}::vector)
    `;

    const [row] = await sql`
      SELECT id, embedding::text AS embedding_str FROM test_vectors LIMIT 1
    `;
    expect(row).toBeDefined();
    expect(row.id).toBeDefined();

    await sql`DROP TABLE test_vectors`;
  });
});
