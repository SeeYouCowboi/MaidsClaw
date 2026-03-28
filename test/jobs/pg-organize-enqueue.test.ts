import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { ensureTestDb, createTestPg, resetSchema, teardown } from "../helpers/pg-test-utils.js";
import { bootstrapPgJobsSchema } from "../../src/jobs/pg-schema.js";
import { PgJobStore } from "../../src/jobs/pg-store.js";
import {
	buildOrganizeEnqueueInput,
	buildSearchRebuildEnqueueInput,
} from "../../src/jobs/pg-job-builders.js";

describe("pg enqueue", () => {
	let sql: postgres.Sql;
	let store: PgJobStore;

	beforeAll(async () => {
		await ensureTestDb();
		sql = createTestPg();
		await resetSchema(sql);
		await bootstrapPgJobsSchema(sql);
		store = new PgJobStore(sql);
	});

	afterAll(async () => {
		await teardown(sql);
	});

	describe("idempotent: enqueue organize job twice yields one row", () => {
		const input = buildOrganizeEnqueueInput({
			settlementId: "settle-idem-1",
			agentId: "agent-1",
			chunkOrdinal: "001",
			chunkNodeRefs: ["ref-a", "ref-b"],
			embeddingModelId: "text-embedding-3-small",
		});

		let firstResult: Awaited<ReturnType<typeof store.enqueue>>;
		let secondResult: Awaited<ReturnType<typeof store.enqueue>>;

		it("first enqueue returns created", async () => {
			firstResult = await store.enqueue(input);
			expect(firstResult.outcome).toBe("created");
			expect(firstResult.job_key).toBe(input.job_key);
		});

		it("second enqueue returns duplicate", async () => {
			secondResult = await store.enqueue(input);
			expect(secondResult.outcome).toBe("duplicate");
			expect(secondResult.job_key).toBe(input.job_key);
		});

		it("only one row exists in jobs_current", async () => {
			const rows = await sql`
				SELECT * FROM jobs_current WHERE job_key = ${input.job_key}
			`;
			expect(rows.length).toBe(1);
		});
	});

	describe("fields: enqueue stores correct initial state", () => {
		const input = buildOrganizeEnqueueInput({
			settlementId: "settle-fields-1",
			agentId: "agent-2",
			chunkOrdinal: "002",
			chunkNodeRefs: ["ref-c"],
			embeddingModelId: "text-embedding-3-small",
		});

		it("stores all expected initial field values", async () => {
			const result = await store.enqueue(input);
			expect(result.outcome).toBe("created");

			const rows = await sql`
				SELECT * FROM jobs_current WHERE job_key = ${input.job_key}
			`;
			expect(rows.length).toBe(1);

			const row = rows[0];
			expect(row.status).toBe("pending");
			expect(Number(row.claim_version)).toBe(0);
			expect(Number(row.attempt_count)).toBe(0);
			expect(Number(row.next_attempt_at)).toBe(input.now_ms);
			expect(row.job_type).toBe("memory.organize");
			expect(row.execution_class).toBe(input.execution_class);
			expect(row.concurrency_key).toBe(input.concurrency_key);
			expect(Number(row.max_attempts)).toBe(input.max_attempts);
			expect(Number(row.created_at)).toBe(input.now_ms);
			expect(Number(row.updated_at)).toBe(input.now_ms);

			const payload = typeof row.payload_json === "string"
				? JSON.parse(row.payload_json)
				: row.payload_json;
			expect(payload.settlementId).toBe("settle-fields-1");
			expect(payload.agentId).toBe("agent-2");
			expect(payload.chunkOrdinal).toBe("002");
			expect(payload.chunkNodeRefs).toEqual(["ref-c"]);
		});
	});

	describe("search.rebuild same job_key retry does not trigger family coalescing", () => {
		const input = buildSearchRebuildEnqueueInput({
			scope: "private",
			targetAgentId: "agent-rebuild-1",
			triggerSource: "fts_sync_failure",
			triggerReason: "fts_repair",
		});

		it("first enqueue returns created", async () => {
			const result = await store.enqueue(input);
			expect(result.outcome).toBe("created");
			expect(result.job_key).toBe(input.job_key);
		});

		it("second enqueue with same job_key returns duplicate", async () => {
			const result = await store.enqueue(input);
			expect(result.outcome).toBe("duplicate");
		});

		it("family_state_json is unchanged after duplicate enqueue", async () => {
			const rows = await sql`
				SELECT family_state_json FROM jobs_current WHERE job_key = ${input.job_key}
			`;
			expect(rows.length).toBe(1);

			const familyState = typeof rows[0].family_state_json === "string"
				? JSON.parse(rows[0].family_state_json)
				: rows[0].family_state_json;
			expect(familyState.rerunRequested).toBe(false);
			expect(familyState.coalescedRequestCount).toBe(0);
		});

		it("only one row exists for this job_key", async () => {
			const rows = await sql`
				SELECT * FROM jobs_current WHERE job_key = ${input.job_key}
			`;
			expect(rows.length).toBe(1);
		});
	});
});
