import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import postgres_ from "postgres";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  resolvePgAppTestUrl,
  skipPgTests,
} from "../helpers/pg-app-test-utils.js";

const TABLES = [
  "search_docs_episode",
  "search_docs_cognition",
  "search_docs_area",
  "search_docs_world",
] as const;

const EXPECTED_BM25_INDEXES = [
  "idx_search_docs_episode_bm25",
  "idx_search_docs_cognition_bm25",
  "idx_search_docs_area_bm25",
  "idx_search_docs_world_bm25",
] as const;

describe.skipIf(skipPgTests)("pg-search-bm25-schema", () => {
  let sql: postgres.Sql;
  let schemaName: string;

  beforeAll(async () => {
    sql = postgres_(resolvePgAppTestUrl(), {
      max: 2,
      connect_timeout: 10,
      onnotice() {},
    });
    schemaName = `bm25_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await sql.unsafe(`SET search_path TO "${schemaName}", public`);
    await bootstrapTruthSchema(sql);
    await bootstrapOpsSchema(sql);
    await bootstrapDerivedSchema(sql);
  });

  afterAll(async () => {
    try {
      await sql.unsafe(`SET search_path TO public`);
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await sql.end();
    }
  });

  it("each search_docs table has the three BM25 helper columns", async () => {
    for (const table of TABLES) {
      const rows = await sql<{ column_name: string }[]>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = ${schemaName}
          AND table_name = ${table}
          AND column_name IN ('content_search_text', 'content_ngram_text', 'alias_text')
        ORDER BY column_name
      `;
      const cols = rows.map((r) => r.column_name);
      expect(cols).toContain("alias_text");
      expect(cols).toContain("content_ngram_text");
      expect(cols).toContain("content_search_text");
    }
  });

  it("each table has exactly one BM25 index with the expected name", async () => {
    for (const expected of EXPECTED_BM25_INDEXES) {
      const rows = await sql<{ indexname: string }[]>`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = ${schemaName}
          AND indexname = ${expected}
      `;
      expect(rows.length).toBe(1);
    }
  });

	it("search_docs trigram indexes are removed after cutover", async () => {
		const rows = await sql<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = ${schemaName}
        AND indexname LIKE 'idx_search_docs%trgm%'
    `;
		expect(rows.length).toBe(0);
	});

  it("BM25 indexes use bm25 access method", async () => {
    const rows = await sql<{ indexname: string; amname: string }[]>`
      SELECT i.relname AS indexname, am.amname
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_namespace n ON n.oid = i.relnamespace
      JOIN pg_am am ON am.oid = i.relam
      WHERE n.nspname = ${schemaName}
        AND i.relname = ANY(${[...EXPECTED_BM25_INDEXES]})
    `;
    expect(rows.length).toBe(EXPECTED_BM25_INDEXES.length);
    for (const r of rows) {
      expect(r.amname).toBe("bm25");
    }
  });
});
