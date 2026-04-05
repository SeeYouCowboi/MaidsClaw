import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createPgPool } from "../../src/storage/pg-pool.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { PgGraphMutableStoreRepo } from "../../src/storage/domain-repos/pg/graph-mutable-store-repo.js";

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
    connection: { search_path: `${schemaName},public` },
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
 * import { skipPgTests } from "../helpers/pg-test-utils.js";
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
  const pool = createTestPgAppPool();
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
