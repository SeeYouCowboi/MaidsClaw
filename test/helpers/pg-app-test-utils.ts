import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createPgPool } from "../../src/storage/pg-pool.js";

const ADMIN_URL = "postgres://maidsclaw:maidsclaw@127.0.0.1:55433/postgres";
const TEST_DB = "maidsclaw_app_test";

function getTestUrl(): string {
  const url = process.env.PG_APP_TEST_URL;
  if (!url) {
    return `postgres://maidsclaw:maidsclaw@127.0.0.1:55433/${TEST_DB}`;
  }
  return url;
}

const schemaRegistry = new Map<postgres.Sql, string>();

export async function ensureTestPgAppDb(): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    const rows = await admin`
      SELECT 1 FROM pg_database WHERE datname = ${TEST_DB}
    `;
    if (rows.length === 0) {
      await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    }
  } finally {
    await admin.end();
  }
}

export function createTestPgAppPool(): postgres.Sql {
  const schemaName = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const sql = postgres(getTestUrl(), {
    max: 3,
    connection: { search_path: schemaName },
  });
  schemaRegistry.set(sql, schemaName);
  return sql;
}

export async function withTestAppSchema<T>(
  pool: postgres.Sql,
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const schemaName = schemaRegistry.get(pool);
  if (!schemaName) {
    throw new Error("No schema registered for this connection. Use createTestPgAppPool().");
  }

  await pool.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

  try {
    return await fn(pool);
  } finally {
    try {
      await pool.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } catch {}
  }
}

export async function resetAppSchema(sql: postgres.Sql): Promise<void> {
  const schemaName = schemaRegistry.get(sql);
  if (!schemaName) {
    throw new Error("No schema registered for this connection. Use createTestPgAppPool().");
  }
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
}

export async function teardownAppPool(sql: postgres.Sql): Promise<void> {
  const schemaName = schemaRegistry.get(sql);
  if (schemaName) {
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } catch {}
    schemaRegistry.delete(sql);
  }
  await sql.end();
}
