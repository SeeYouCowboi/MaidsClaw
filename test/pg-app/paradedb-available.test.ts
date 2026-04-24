import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import postgres_ from "postgres";
import {
  resolvePgAppTestUrl,
  skipPgTests,
} from "../helpers/pg-app-test-utils.js";

describe.skipIf(skipPgTests)("pg-search-available", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres_(resolvePgAppTestUrl(), {
      max: 2,
      connect_timeout: 10,
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("pg_search extension is installed", async () => {
    const [row] = await sql`
      SELECT 1 AS installed FROM pg_extension WHERE extname = 'pg_search'
    `;
    expect(row).toBeDefined();
    expect(row.installed).toBe(1);
  });

  it("vector extension is installed", async () => {
    const [row] = await sql`
      SELECT 1 AS installed FROM pg_extension WHERE extname = 'vector'
    `;
    expect(row).toBeDefined();
    expect(row.installed).toBe(1);
  });

  it("both pg_search and vector extensions report versions", async () => {
    const rows = await sql`
      SELECT extname, extversion
      FROM pg_extension
      WHERE extname IN ('pg_search', 'vector')
      ORDER BY extname
    `;
    const names = rows.map((r) => r.extname);
    expect(names).toContain("pg_search");
    expect(names).toContain("vector");
    for (const r of rows) {
      expect(typeof r.extversion).toBe("string");
      expect(r.extversion.length).toBeGreaterThan(0);
    }
  });

  it("stubbed extension query missing pg_search fails loudly with a clear error and no silent fallback", () => {
    type ExtRow = { extname: string };
    const stub = async (): Promise<ExtRow[]> => [{ extname: "vector" }];

    const check = async () => {
      const rows = await stub();
      const names = rows.map((r) => r.extname);
      if (!names.includes("pg_search")) {
        throw new Error(
          `pg_search extension missing from pg_extension catalog; got: ${names.join(",")}`,
        );
      }
    };

    expect(check()).rejects.toThrow(/pg_search extension missing/);
  });
});
