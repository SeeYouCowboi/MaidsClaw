import { randomUUID } from "node:crypto";
import postgres from "postgres";

/**
 * Shared PG test helpers for the durable-jobs data plane.
 *
 * Prefer explicit jobs-side URLs when available. If the repository still has
 * an old docker-default `PG_TEST_URL` but the developer is running a single
 * local PostgreSQL instance for both app + jobs databases, derive the jobs
 * test DB from the app-side URL instead of forcing the stale docker port.
 */
const DEFAULT_HOST_PORT = "127.0.0.1:55432";
const DEFAULT_TEST_DB = "maidsclaw_jobs_test";
const DEFAULT_TEST_URL = `postgres://maidsclaw:maidsclaw@${DEFAULT_HOST_PORT}/${DEFAULT_TEST_DB}`;

function quotePgIdentifier(identifier: string): string {
	return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function rewriteDbName(url: string, dbName: string): string | null {
	try {
		const parsed = new URL(url);
		parsed.pathname = `/${dbName}`;
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return null;
	}
}

function isStaleDockerJobsTestUrl(url: string | undefined): boolean {
	return url === DEFAULT_TEST_URL;
}

export function computeSkipPgTests(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return !env.PG_TEST_URL && !env.JOBS_PG_URL && !env.PG_APP_URL && !env.PG_APP_TEST_URL;
}

export const skipPgTests = computeSkipPgTests();

export function resolveJobsTestUrl(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const explicitTestUrl = env.PG_TEST_URL?.trim();
	if (explicitTestUrl && !isStaleDockerJobsTestUrl(explicitTestUrl)) {
		return explicitTestUrl;
	}

	const jobsBaseUrl = env.JOBS_PG_URL?.trim();
	if (jobsBaseUrl) {
		const derived = rewriteDbName(jobsBaseUrl, DEFAULT_TEST_DB);
		if (derived) {
			return derived;
		}
	}

	const appBaseUrl = env.PG_APP_TEST_URL?.trim() ?? env.PG_APP_URL?.trim();
	if (appBaseUrl) {
		const derived = rewriteDbName(appBaseUrl, DEFAULT_TEST_DB);
		if (derived) {
			return derived;
		}
	}

	if (explicitTestUrl) {
		return explicitTestUrl;
	}

	return DEFAULT_TEST_URL;
}

export function resolveJobsTestDbName(
	env: NodeJS.ProcessEnv = process.env,
): string {
	try {
		const parsed = new URL(resolveJobsTestUrl(env));
		const dbName = parsed.pathname.replace(/^\/+/, "").trim();
		return dbName.length > 0 ? dbName : DEFAULT_TEST_DB;
	} catch {
		return DEFAULT_TEST_DB;
	}
}

export function resolveJobsAdminUrl(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const jobsBaseUrl = env.JOBS_PG_URL?.trim();
	if (jobsBaseUrl) {
		const derived = rewriteDbName(jobsBaseUrl, "postgres");
		if (derived) {
			return derived;
		}
	}

	const testUrl = resolveJobsTestUrl(env);
	const derivedFromTest = rewriteDbName(testUrl, "postgres");
	if (derivedFromTest) {
		return derivedFromTest;
	}

	return `postgres://maidsclaw:maidsclaw@${DEFAULT_HOST_PORT}/postgres`;
}

/**
 * Registry mapping each postgres.Sql pool to its unique test schema name.
 * Enables per-suite schema isolation without changing call-site signatures.
 */
const schemaRegistry = new Map<postgres.Sql, string>();

export async function ensureTestDb(): Promise<void> {
	const admin = postgres(resolveJobsAdminUrl(), { max: 1 });
	try {
		const dbName = resolveJobsTestDbName();
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

/**
 * Creates a connection pool bound to a unique per-suite schema.
 * The `connection.search_path` parameter ensures EVERY connection in the pool
 * resolves unqualified table names to the isolated schema — safe for concurrent
 * test execution across multiple suites.
 */
export function createTestPg(): postgres.Sql {
	const schemaName = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const sql = postgres(resolveJobsTestUrl(), {
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
