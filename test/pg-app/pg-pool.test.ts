import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  ensureTestPgAppDb,
  createTestPgAppPool,
  resetAppSchema,
  teardownAppPool,
} from "../helpers/pg-app-test-utils.js";
import { createPgPool, createAppPgPool, createAppTestPgPool } from "../../src/storage/pg-pool.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("pg-pool", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    sql = createTestPgAppPool();
    await resetAppSchema(sql);
  });

  afterAll(async () => {
    await teardownAppPool(sql);
  });

  describe("createPgPool", () => {
    it("creates a pool that can execute queries", async () => {
      const pool = createPgPool(process.env.PG_APP_TEST_URL!, { max: 2 });
      try {
        const [row] = await pool`SELECT 1 + 1 AS result`;
        expect(row.result).toBe(2);
      } finally {
        await pool.end();
      }
    });

    it("applies custom configuration options", async () => {
      const pool = createPgPool(process.env.PG_APP_TEST_URL!, {
        max: 5,
        connect_timeout: 60,
        idle_timeout: 600,
        max_lifetime: 7200,
      });
      try {
        const [row] = await pool`SELECT 1 AS connected`;
        expect(row.connected).toBe(1);
      } finally {
        await pool.end();
      }
    });
  });

  describe("createAppPgPool", () => {
    it("throws when PG_APP_URL is not set", () => {
      const originalUrl = process.env.PG_APP_URL;
      delete (process.env as Record<string, string | undefined>).PG_APP_URL;

      try {
        expect(() => createAppPgPool()).toThrow("PG_APP_URL environment variable is not set");
      } finally {
        process.env.PG_APP_URL = originalUrl;
      }
    });

    it("creates pool from PG_APP_URL when set", async () => {
      process.env.PG_APP_URL = process.env.PG_APP_TEST_URL;
      const pool = createAppPgPool();
      try {
        const [row] = await pool`SELECT 1 AS connected`;
        expect(row.connected).toBe(1);
      } finally {
        await pool.end();
      }
    });
  });

  describe("createAppTestPgPool", () => {
    it("throws when PG_APP_TEST_URL is not set", () => {
      const originalUrl = process.env.PG_APP_TEST_URL;
      delete (process.env as Record<string, string | undefined>).PG_APP_TEST_URL;

      try {
        expect(() => createAppTestPgPool()).toThrow("PG_APP_TEST_URL environment variable is not set");
      } finally {
        process.env.PG_APP_TEST_URL = originalUrl;
      }
    });

    it("creates pool from PG_APP_TEST_URL when set", async () => {
      const pool = createAppTestPgPool();
      try {
        const [row] = await pool`SELECT 1 AS connected`;
        expect(row.connected).toBe(1);
      } finally {
        await pool.end();
      }
    });
  });
});
