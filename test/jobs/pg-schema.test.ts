import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { bootstrapPgJobsSchema } from "../../src/jobs/pg-schema.js";
import { createTestPg, ensureTestDb, resetSchema, skipPgTests, teardown } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("pg-schema bootstrap", () => {
	let sql: postgres.Sql;

	beforeAll(async () => {
		await ensureTestDb();
		sql = createTestPg();
		await resetSchema(sql);
	});

	afterAll(async () => {
		await teardown(sql);
	});

	it("creates tables on first run", async () => {
		await bootstrapPgJobsSchema(sql);

		const tables = await sql`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public'
			  AND table_name IN ('jobs_current', 'job_attempts')
			ORDER BY table_name
		`;
		expect(tables.map((r) => r.table_name)).toEqual(["job_attempts", "jobs_current"]);
	});

	it("is idempotent — second call succeeds without error", async () => {
		await bootstrapPgJobsSchema(sql);
		await bootstrapPgJobsSchema(sql);
	});

	describe("jobs_current columns", () => {
		const EXPECTED_COLUMNS = [
			"job_key",
			"job_type",
			"job_family_key",
			"execution_class",
			"concurrency_key",
			"status",
			"payload_schema_version",
			"payload_json",
			"family_state_json",
			"claim_version",
			"claimed_by",
			"claimed_at",
			"lease_expires_at",
			"last_heartbeat_at",
			"attempt_count",
			"max_attempts",
			"next_attempt_at",
			"last_error_code",
			"last_error_message",
			"last_error_at",
			"created_at",
			"updated_at",
			"terminal_at",
		];

		it("has all required columns", async () => {
			const cols = await sql`
				SELECT column_name FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'jobs_current'
			`;
			const colNames = cols.map((r) => r.column_name);
			for (const expected of EXPECTED_COLUMNS) {
				expect(colNames).toContain(expected);
			}
		});
	});

	describe("job_attempts columns", () => {
		const EXPECTED_COLUMNS = [
			"attempt_id",
			"job_key",
			"job_type",
			"job_family_key",
			"execution_class",
			"concurrency_key",
			"claim_version",
			"attempt_no",
			"worker_id",
			"outcome",
			"payload_schema_version",
			"payload_snapshot_json",
			"family_state_snapshot_json",
			"started_at",
			"last_heartbeat_at",
			"lease_expires_at",
			"finished_at",
			"error_code",
			"error_message",
			"backoff_until",
		];

		it("has all required columns", async () => {
			const cols = await sql`
				SELECT column_name FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'job_attempts'
			`;
			const colNames = cols.map((r) => r.column_name);
			for (const expected of EXPECTED_COLUMNS) {
				expect(colNames).toContain(expected);
			}
		});
	});

	describe("constraints", () => {
		it("has PK on jobs_current.job_key", async () => {
			const pk = await sql`
				SELECT c.constraint_name
				FROM information_schema.table_constraints c
				WHERE c.table_schema = 'public'
				  AND c.table_name = 'jobs_current'
				  AND c.constraint_type = 'PRIMARY KEY'
			`;
			expect(pk.length).toBe(1);

			const cols = await sql`
				SELECT kcu.column_name
				FROM information_schema.key_column_usage kcu
				WHERE kcu.constraint_name = ${pk[0].constraint_name}
				  AND kcu.table_schema = 'public'
			`;
			expect(cols.map((r) => r.column_name)).toEqual(["job_key"]);
		});

		it("has unique (job_key, claim_version) on job_attempts", async () => {
			const idx = await sql`
				SELECT indexname, indexdef FROM pg_indexes
				WHERE schemaname = 'public'
				  AND tablename = 'job_attempts'
				  AND indexname = 'ux_job_attempts_job_key_claim_version'
			`;
			expect(idx.length).toBe(1);
			expect(idx[0].indexdef).toContain("UNIQUE");
			expect(idx[0].indexdef).toContain("job_key");
			expect(idx[0].indexdef).toContain("claim_version");
		});

		it("has active-family unique partial index on jobs_current", async () => {
			const idx = await sql`
				SELECT indexname, indexdef FROM pg_indexes
				WHERE schemaname = 'public'
				  AND tablename = 'jobs_current'
				  AND indexname = 'idx_jobs_current_family_active'
			`;
			expect(idx.length).toBe(1);
			expect(idx[0].indexdef).toContain("UNIQUE");
			expect(idx[0].indexdef).toContain("job_family_key");
			expect(idx[0].indexdef).toContain("pending");
			expect(idx[0].indexdef).toContain("running");
		});

		it("has claim scanning index", async () => {
			const idx = await sql`
				SELECT indexname FROM pg_indexes
				WHERE schemaname = 'public'
				  AND tablename = 'jobs_current'
				  AND indexname = 'idx_jobs_current_status_next_attempt'
			`;
			expect(idx.length).toBe(1);
		});

		it("has concurrency running index", async () => {
			const idx = await sql`
				SELECT indexname FROM pg_indexes
				WHERE schemaname = 'public'
				  AND tablename = 'jobs_current'
				  AND indexname = 'idx_jobs_current_concurrency_running'
			`;
			expect(idx.length).toBe(1);
		});

		it("has pending thinker payload composite index", async () => {
			const idx = await sql`
				SELECT indexname, indexdef FROM pg_indexes
				WHERE schemaname = current_schema()
				  AND tablename = 'jobs_current'
				  AND indexname = 'idx_jobs_pending_thinker_session'
			`;
			expect(idx.length).toBe(1);
			expect(idx[0].indexdef).toContain("job_type");
			expect(idx[0].indexdef).toContain("status");
			expect(idx[0].indexdef).toContain("sessionId");
			expect(idx[0].indexdef).toContain("agentId");
			expect(idx[0].indexdef).toContain("pending");
		});

		it("has lease expiry index", async () => {
			const idx = await sql`
				SELECT indexname FROM pg_indexes
				WHERE schemaname = 'public'
				  AND tablename = 'jobs_current'
				  AND indexname = 'idx_jobs_current_lease_expiry'
			`;
			expect(idx.length).toBe(1);
		});

		it("has terminal retention index", async () => {
			const idx = await sql`
				SELECT indexname FROM pg_indexes
				WHERE schemaname = 'public'
				  AND tablename = 'jobs_current'
				  AND indexname = 'idx_jobs_current_terminal'
			`;
			expect(idx.length).toBe(1);
		});

		it("has job_attempts history index", async () => {
			const idx = await sql`
				SELECT indexname FROM pg_indexes
				WHERE schemaname = 'public'
				  AND tablename = 'job_attempts'
				  AND indexname = 'idx_job_attempts_job_key'
			`;
			expect(idx.length).toBe(1);
		});
	});

	describe("CHECK constraints", () => {
		it("rejects invalid status on jobs_current", async () => {
			const now = Date.now();
			try {
				await sql`
					INSERT INTO jobs_current (
						job_key, job_type, execution_class, concurrency_key,
						status, payload_json, max_attempts, next_attempt_at,
						created_at, updated_at
					) VALUES (
						'test-bad-status', 'test', 'background.memory_organize', 'test:global',
						'INVALID_STATUS', '{}', 3, ${now},
						${now}, ${now}
					)
				`;
				expect(true).toBe(false);
			} catch (err: unknown) {
				expect((err as Error).message).toMatch(/check|constraint|violat/i);
			}
		});

		it("accepts all valid status values", async () => {
			const now = Date.now();
			const validStatuses = ["pending", "running", "succeeded", "failed_terminal", "cancelled"];

			for (const status of validStatuses) {
				const key = `test-valid-status-${status}`;
				await sql`
					INSERT INTO jobs_current (
						job_key, job_type, execution_class, concurrency_key,
						status, payload_json, max_attempts, next_attempt_at,
						created_at, updated_at
						${status === "succeeded" || status === "failed_terminal" || status === "cancelled" ? sql`, terminal_at` : sql``}
					) VALUES (
						${key}, 'test', 'background.memory_organize', 'test:global',
						${status}, '{}', 3, ${now},
						${now}, ${now}
						${status === "succeeded" || status === "failed_terminal" || status === "cancelled" ? sql`, ${now}` : sql``}
					)
				`;
			}

			const count = await sql`
				SELECT COUNT(*)::int AS cnt FROM jobs_current
				WHERE job_key LIKE 'test-valid-status-%'
			`;
			expect(count[0].cnt).toBe(validStatuses.length);
		});

		it("rejects invalid outcome on job_attempts", async () => {
			const now = Date.now();
			try {
				await sql`
					INSERT INTO job_attempts (
						job_key, job_type, execution_class, concurrency_key,
						claim_version, attempt_no, worker_id,
						outcome, payload_schema_version,
						payload_snapshot_json, started_at, lease_expires_at
					) VALUES (
						'test-bad-outcome', 'test', 'background.memory_organize', 'test:global',
						1, 1, 'worker-1',
						'INVALID_OUTCOME', 1,
						'{}', ${now}, ${now + 60000}
					)
				`;
				expect(true).toBe(false);
			} catch (err: unknown) {
				expect((err as Error).message).toMatch(/check|constraint|violat/i);
			}
		});
	});

	describe("family active uniqueness enforcement", () => {
		it("rejects two active rows with same job_family_key", async () => {
			const now = Date.now();
			await sql`
				INSERT INTO jobs_current (
					job_key, job_type, job_family_key, execution_class, concurrency_key,
					status, payload_json, max_attempts, next_attempt_at,
					created_at, updated_at
				) VALUES (
					'family-test-1', 'search.rebuild', 'family:rebuild:global', 'background.search_rebuild', 'search.rebuild:global',
					'pending', '{"version":1}', 3, ${now},
					${now}, ${now}
				)
			`;

			try {
				await sql`
					INSERT INTO jobs_current (
						job_key, job_type, job_family_key, execution_class, concurrency_key,
						status, payload_json, max_attempts, next_attempt_at,
						created_at, updated_at
					) VALUES (
						'family-test-2', 'search.rebuild', 'family:rebuild:global', 'background.search_rebuild', 'search.rebuild:global',
						'pending', '{"version":1}', 3, ${now},
						${now}, ${now}
					)
				`;
				expect(true).toBe(false);
			} catch (err: unknown) {
				expect((err as Error).message).toMatch(/unique|duplicate/i);
			}
		});
	});
});
