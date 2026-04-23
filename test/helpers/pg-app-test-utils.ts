import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createPgPool } from "../../src/storage/pg-pool.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { PgGraphMutableStoreRepo } from "../../src/storage/domain-repos/pg/graph-mutable-store-repo.js";

const DEFAULT_HOST_PORT = "127.0.0.1:55433";
const DEFAULT_TEST_DB = "maidsclaw_app_test";
const INT8_OID = 20;
const MAX_PG_IDENTIFIER_LENGTH = 63;
const BENIGN_TEST_NOTICE_CODES = new Set([
  "00000", // generic NOTICE, such as DROP SCHEMA CASCADE details
  "42P07", // relation already exists
  "42710", // extension already exists
  "42701", // column already exists
]);

const safeInt8AsNumber = {
  to: INT8_OID,
  from: [INT8_OID],
  serialize(value: number | bigint | string): string {
    return value.toString();
  },
  parse(raw: string): number {
    return Number(raw);
  },
} satisfies postgres.PostgresType<number>;

function quotePgIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function deriveInvocationSchemaName(baseSchemaName: string): string {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  const separator = "_";
  const maxBaseLength = MAX_PG_IDENTIFIER_LENGTH - separator.length - suffix.length;
  const truncatedBase = baseSchemaName.slice(0, Math.max(1, maxBaseLength));
  return `${truncatedBase}${separator}${suffix}`;
}

export function computeSkipPgTests(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !env.PG_TEST_URL && !env.PG_APP_TEST_URL;
}

export const skipPgTests = computeSkipPgTests();

export function deriveAppTestUrlFromPgTestUrl(
  pgTestUrl: string,
  dbName = DEFAULT_TEST_DB,
): string | null {
  try {
    const parsed = new URL(pgTestUrl);
    parsed.pathname = `/${dbName}`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function resolvePgAppTestUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env.PG_APP_TEST_URL;
  if (url) {
    return url;
  }
  const pgTestUrl = env.PG_TEST_URL;
  if (pgTestUrl) {
    const derived = deriveAppTestUrlFromPgTestUrl(pgTestUrl);
    if (derived) {
      return derived;
    }
  }
  return `postgres://maidsclaw:maidsclaw@${DEFAULT_HOST_PORT}/${DEFAULT_TEST_DB}`;
}

export function resolvePgAppTestDbName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  try {
    const parsed = new URL(resolvePgAppTestUrl(env));
    const dbName = parsed.pathname.replace(/^\/+/, "").trim();
    return dbName.length > 0 ? dbName : DEFAULT_TEST_DB;
  } catch {
    return DEFAULT_TEST_DB;
  }
}

export function resolvePgAppAdminUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  try {
    const parsed = new URL(resolvePgAppTestUrl(env));
    parsed.pathname = "/postgres";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const testUrl = resolvePgAppTestUrl(env);
    return testUrl.replace(/\/[^/]+$/, "/postgres");
  }
}

export function resolvePgParadeDbTestUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.PARADEDB_TEST_URL ?? "postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app";
}

export function computeSkipParadeDbTests(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return false;
}

export const skipParadeDbTests = computeSkipParadeDbTests();

export function installResolvedPgAppUrl(
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const originalUrl = env.PG_APP_URL;
  env.PG_APP_URL = resolvePgAppTestUrl(env);

  return () => {
    if (originalUrl === undefined) {
      delete env.PG_APP_URL;
    } else {
      env.PG_APP_URL = originalUrl;
    }
  };
}

function getTestUrl(): string {
  return resolvePgAppTestUrl();
}

function getAdminUrl(): string {
  return resolvePgAppAdminUrl();
}

const schemaRegistry = new Map<postgres.Sql, string>();

export async function ensureTestPgAppDb(): Promise<void> {
  const admin = postgres(getAdminUrl(), { max: 1 });
  try {
    const dbName = resolvePgAppTestDbName();
    const rows = await admin`
      SELECT 1 FROM pg_database WHERE datname = ${dbName}
    `;
    if (rows.length === 0) {
      await admin.unsafe(`CREATE DATABASE ${quotePgIdentifier(dbName)}`);
    }
  } finally {
    await admin.end();
  }
}

export function createTestPgAppPool(explicitSchemaName?: string): postgres.Sql {
  const schemaName = explicitSchemaName ?? `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const sql = postgres(getTestUrl(), {
    // withTestAppSchema reserves one connection per running test case and
    // assigns a unique schema per invocation. Match Bun's default test
    // concurrency so queued tests don't burn their 5s timeout just waiting
    // for a connection slot.
    max: 20,
    connection: { search_path: `${schemaName},public` },
    types: { bigint: safeInt8AsNumber },
    onnotice(notice: postgres.Notice) {
      const code = (notice as Record<string, unknown>).code as string | undefined;
      if (code && BENIGN_TEST_NOTICE_CODES.has(code)) {
        return;
      }
      console.warn("[pg test notice]", notice);
    },
  });
  schemaRegistry.set(sql, schemaName);
  return sql;
}

export async function withTestAppSchema<T>(
  pool: postgres.Sql,
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const baseSchemaName = schemaRegistry.get(pool);
  if (!baseSchemaName) {
    throw new Error("No schema registered for this connection. Use createTestPgAppPool().");
  }

  const schemaName = deriveInvocationSchemaName(baseSchemaName);
  const reserved = await pool.reserve();
  const quotedSchemaName = quotePgIdentifier(schemaName);

  try {
    await reserved.unsafe(`CREATE SCHEMA ${quotedSchemaName}`);
    await reserved.unsafe(`SET search_path TO ${quotedSchemaName}, public`);
    return await fn(reserved);
  } finally {
    try {
      await reserved.unsafe(`SET search_path TO public`);
    } finally {
      try {
        await reserved.unsafe(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
      } finally {
        reserved.release();
      }
    }
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

/**
 * Execute a raw SQL statement using the simple query protocol.
 *
 * The `postgres` (porsager) library uses the extended query protocol by default,
 * which cannot propagate `RAISE EXCEPTION` errors from PG triggers — the promise
 * never settles and the connection enters a broken state.
 *
 * By prepending `SELECT 1;` we force multi-statement mode, which uses the simple
 * query protocol. In this mode trigger exceptions are correctly surfaced as
 * rejected promises, and the pool connection remains healthy afterward.
 */
export function simpleProtocol(sql: postgres.Sql, statement: string): Promise<unknown> {
  return sql.unsafe(`SELECT 1; ${statement}`);
}

/**
 * Assert that a SQL statement is rejected by a PG trigger with a message matching `pattern`.
 *
 * Bun's `expect().rejects.toThrow()` hangs with the postgres library's simple-protocol
 * error path, so this helper uses a manual try-catch instead.
 */
export async function expectTriggerReject(
  sql: postgres.Sql,
  statement: string,
  pattern: string,
): Promise<void> {
  let caught: Error | null = null;
  try {
    await simpleProtocol(sql, statement);
  } catch (e: any) {
    caught = e;
  }
  if (!caught) {
    throw new Error(`Expected statement to be rejected by trigger, but it resolved.\nSQL: ${statement}`);
  }
  if (!caught.message.includes(pattern)) {
    throw new Error(
      `Trigger error did not match.\n  Expected pattern: ${pattern}\n  Actual message:  ${caught.message}`,
    );
  }
}

/**
 * Standard seeded entity IDs returned by seedStandardPgEntities().
 */
export type SeededEntities = {
  selfId: number;
  userId: number;
  locationId: number;
  bobId: number;
};

/**
 * Seed standard test entities into the PostgreSQL database.
 *
 * Creates:
 * - "__self__" (Alice) - person entity
 * - "__user__" (User) - person entity
 * - "test-room" (Test Room) - location entity
 * - "bob" (Bob) - person entity
 */
export async function seedStandardPgEntities(sql: postgres.Sql): Promise<SeededEntities> {
  const storage = new PgGraphMutableStoreRepo(sql);

  const selfId = await storage.upsertEntity({
    pointerKey: "__self__",
    displayName: "Alice",
    entityType: "person",
    memoryScope: "shared_public",
  });
  const userId = await storage.upsertEntity({
    pointerKey: "__user__",
    displayName: "User",
    entityType: "person",
    memoryScope: "shared_public",
  });
  const locationId = await storage.upsertEntity({
    pointerKey: "test-room",
    displayName: "Test Room",
    entityType: "location",
    memoryScope: "shared_public",
  });
  const bobId = await storage.upsertEntity({
    pointerKey: "bob",
    displayName: "Bob",
    entityType: "person",
    memoryScope: "shared_public",
  });

  return { selfId, userId, locationId, bobId };
}

/**
 * Options for createPgTestDb() factory.
 */
export type CreatePgTestDbOptions = {
  /** Embedding dimension for pgvector (default: 1536) */
  embeddingDim?: number;
  /** Skip pgvector extension and node_embeddings table (for environments without pgvector) */
  skipVector?: boolean;
  /** Explicit schema name (default: random test_<uuid> name) */
  schemaName?: string;
};

/**
 * Result returned by createPgTestDb() factory.
 */
export type PgTestDb = {
  /** The postgres connection pool (with isolated schema as search_path) */
  pool: postgres.Sql;
  /** The isolated schema name for this test database */
  schemaName: string;
  /** IDs of the standard seeded entities */
  entities: SeededEntities;
  /** Clean up the test database (drops schema and closes pool) */
  cleanup: () => Promise<void>;
};

/**
 * One-stop factory to create a fully-bootstrapped PostgreSQL test database.
 *
 * This factory:
 * 1. Gets a connection pool via createTestPgAppPool()
 * 2. Creates an isolated test schema
 * 3. Runs truth schema bootstrap
 * 4. Runs ops schema bootstrap
 * 5. Runs derived schema bootstrap (with optional embedding dimension)
 * 6. Seeds standard test entities (equivalent to SQLite's seedStandardEntities())
 * 7. Returns pool, schema name, entity IDs, and a cleanup function
 *
 * Usage:
 * ```typescript
 * import { describe, beforeAll, afterAll } from "bun:test";
 * import { createPgTestDb } from "../helpers/pg-app-test-utils.js";
 * import { skipPgTests } from "../helpers/pg-app-test-utils.js";
 *
 * describe.skipIf(skipPgTests)("My PG Test", () => {
 *   let testDb: Awaited<ReturnType<typeof createPgTestDb>>;
 *
 *   beforeAll(async () => {
 *     testDb = await createPgTestDb();
 *   });
 *
 *   afterAll(async () => {
 *     await testDb.cleanup();
 *   });
 *
 *   it("uses the test database", async () => {
 *     // Use testDb.pool for queries
 *     // Access testDb.entities.selfId, userId, locationId, bobId
 *   });
 * });
 * ```
 */
export async function createPgTestDb(options: CreatePgTestDbOptions = {}): Promise<PgTestDb> {
  // Step 1: Ensure test database exists
  await ensureTestPgAppDb();

  // Step 2: Create connection pool with isolated schema
  const pool = createTestPgAppPool(options.schemaName);
  const schemaName = schemaRegistry.get(pool);
  if (!schemaName) {
    throw new Error("Failed to create test pool with registered schema");
  }

  // Step 3: Create the isolated schema
  await pool.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

  try {
    // Step 4: Bootstrap all three schema layers
    await bootstrapTruthSchema(pool);
    await bootstrapOpsSchema(pool);
    await bootstrapDerivedSchema(pool, { embeddingDim: options.embeddingDim, skipVector: options.skipVector });

    // Step 5: Seed standard entities
    const entities = await seedStandardPgEntities(pool);

    // Step 6: Return the test database context with cleanup
    return {
      pool,
      schemaName,
      entities,
      cleanup: async () => {
        await teardownAppPool(pool);
      },
    };
  } catch (error) {
    // Cleanup on bootstrap failure
    await teardownAppPool(pool);
    throw error;
  }
}
