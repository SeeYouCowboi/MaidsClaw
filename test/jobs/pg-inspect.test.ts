import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { ensureTestDb, createTestPg, resetSchema, teardown } from "../helpers/pg-test-utils.js";
import { bootstrapPgJobsSchema } from "../../src/jobs/pg-schema.js";
import { PgJobStore } from "../../src/jobs/pg-store.js";
import { buildOrganizeEnqueueInput, buildSearchRebuildEnqueueInput } from "../../src/jobs/pg-job-builders.js";
import { inspectPgJobs } from "../../src/jobs/pg-diagnostics.js";

describe("pg-inspect diagnostics", () => {
	let sql: postgres.Sql;
	let store: PgJobStore;

	beforeAll(async () => {
		await ensureTestDb();
		sql = createTestPg();
	});

	beforeEach(async () => {
		await resetSchema(sql);
		await bootstrapPgJobsSchema(sql);
		store = new PgJobStore(sql);
	});

	afterAll(async () => {
		await teardown(sql);
	});

	it("inspect reports current PG queue state", async () => {
		const org1 = buildOrganizeEnqueueInput({
			settlementId: "settle-1",
			agentId: "agent-a",
			chunkOrdinal: "001",
			chunkNodeRefs: ["ref1"],
			embeddingModelId: "model-1",
		});
		const org2 = buildOrganizeEnqueueInput({
			settlementId: "settle-2",
			agentId: "agent-b",
			chunkOrdinal: "002",
			chunkNodeRefs: ["ref2"],
			embeddingModelId: "model-1",
		});
		const sr = buildSearchRebuildEnqueueInput({
			scope: "area",
			triggerSource: "manual_cli",
			triggerReason: "full_rebuild",
		});

		await store.enqueue(org1);
		await store.enqueue(org2);
		await store.enqueue(sr);

		const report = await inspectPgJobs(store);

		expect(report.countsByStatus.pending).toBe(3);
		expect(report.activeRows.length).toBe(3);
		expect(report.expiredLeaseRows.length).toBe(0);
	});

	it("lease health: surfaces expired running rows", async () => {
		const org = buildOrganizeEnqueueInput({
			settlementId: "settle-expire",
			agentId: "agent-x",
			chunkOrdinal: "001",
			chunkNodeRefs: ["ref1"],
			embeddingModelId: "model-1",
		});
		await store.enqueue(org);

		const nowMs = Date.now();
		const claimResult = await store.claimNext({
			worker_id: "inspect-test-worker",
			now_ms: nowMs,
			lease_duration_ms: 1,
		});

		expect(claimResult.outcome).toBe("claimed");

		await Bun.sleep(10);

		const expired = await store.listExpiredLeases(Date.now());
		expect(expired.length).toBeGreaterThanOrEqual(1);
		expect(expired[0].job_key).toBe(org.job_key);
	});
});
