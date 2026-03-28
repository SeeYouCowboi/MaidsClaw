import postgres from "postgres";

const ADMIN_URL = "postgres://maidsclaw:maidsclaw@127.0.0.1:55432/postgres";
const TEST_DB = "maidsclaw_jobs_test";
const TEST_URL = `postgres://maidsclaw:maidsclaw@127.0.0.1:55432/${TEST_DB}`;

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

export function createTestPg(): postgres.Sql {
	return postgres(TEST_URL, { max: 3 });
}

export async function resetSchema(sql: postgres.Sql): Promise<void> {
	await sql`DROP SCHEMA IF EXISTS public CASCADE`;
	await sql`CREATE SCHEMA public`;
}

export async function teardown(sql: postgres.Sql): Promise<void> {
	await sql.end();
}
