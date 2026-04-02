import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	skipPgTests,
	ensureTestDb,
	createTestPg,
	resetSchema,
	teardown,
} from "../helpers/pg-test-utils.js";
import type postgres from "postgres";

describe.skipIf(skipPgTests)("pg-connection", () => {
	let sql: postgres.Sql;

	beforeAll(async () => {
		await ensureTestDb();
		sql = createTestPg();
		await resetSchema(sql);
	});

	afterAll(async () => {
		await teardown(sql);
	});

	it("connects and runs a trivial query", async () => {
		const [row] = await sql`SELECT 1 + 1 AS result`;
		expect(row.result).toBe(2);
	});

	it("can create and query a temporary table", async () => {
		await sql`CREATE TABLE IF NOT EXISTS _ping (id SERIAL PRIMARY KEY, ts BIGINT NOT NULL)`;
		await sql`INSERT INTO _ping (ts) VALUES (${Date.now()})`;
		const [row] = await sql`SELECT COUNT(*)::int AS cnt FROM _ping`;
		expect(row.cnt).toBeGreaterThanOrEqual(1);
		await sql`DROP TABLE _ping`;
	});
});
