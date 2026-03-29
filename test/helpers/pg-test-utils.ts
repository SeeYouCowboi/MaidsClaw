import { randomUUID } from "node:crypto";
import postgres from "postgres";

const ADMIN_URL = "postgres://maidsclaw:maidsclaw@127.0.0.1:55432/postgres";
const TEST_DB = "maidsclaw_jobs_test";
const TEST_URL = `postgres://maidsclaw:maidsclaw@127.0.0.1:55432/${TEST_DB}`;

/**
 * Registry mapping each postgres.Sql pool to its unique test schema name.
 * Enables per-suite schema isolation without changing call-site signatures.
 */
const schemaRegistry = new Map<postgres.Sql, string>();

export async function ensureTestDb(): Promise<void> {
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

/**
 * Creates a connection pool bound to a unique per-suite schema.
 * The `connection.search_path` parameter ensures EVERY connection in the pool
 * resolves unqualified table names to the isolated schema — safe for concurrent
 * test execution across multiple suites.
 */
export function createTestPg(): postgres.Sql {
	const schemaName = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const sql = postgres(TEST_URL, {
		max: 3,
		connection: { search_path: schemaName },
	});
	schemaRegistry.set(sql, schemaName);
	return sql;
}

export async function resetSchema(sql: postgres.Sql): Promise<void> {
	const schemaName = schemaRegistry.get(sql);
	if (!schemaName) {
		throw new Error("No schema registered for this connection. Use createTestPg().");
	}
	await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
	await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
}

export async function teardown(sql: postgres.Sql): Promise<void> {
	const schemaName = schemaRegistry.get(sql);
	if (schemaName) {
		try {
			await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
		} catch {
			// Best-effort cleanup — schema may already be dropped
		}
		schemaRegistry.delete(sql);
	}
	await sql.end();
}
