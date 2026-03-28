import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import type { PgJobCurrentRow } from "../../src/jobs/durable-store.js";
import {
	buildOrganizeEnqueueInput,
	buildSearchRebuildEnqueueInput,
} from "../../src/jobs/pg-job-builders.js";
import { PgJobRunner } from "../../src/jobs/pg-runner.js";
import { bootstrapPgJobsSchema } from "../../src/jobs/pg-schema.js";
import { PgJobStore } from "../../src/jobs/pg-store.js";
import { createTestPg, ensureTestDb, resetSchema, teardown } from "../helpers/pg-test-utils.js";

type CurrentJobRow = {
	job_key: string;
	status: string;
	attempt_count: number;
	claim_version: number;
	last_error_message: string | null;
};

type AttemptRow = {
	job_key: string;
	claim_version: number;
	attempt_no: number;
	worker_id: string;
	outcome: string;
	error_message: string | null;
};

const WORKER_ID = "test-worker-1";
const LEASE_MS = 30_000;

describe("PgJobRunner", () => {
	let sql: postgres.Sql;
	let store: PgJobStore;
	let runner: PgJobRunner;

	beforeAll(async () => {
		await ensureTestDb();
		sql = createTestPg();
		store = new PgJobStore(sql);
		runner = new PgJobRunner(store, { workerId: WORKER_ID, leaseDurationMs: LEASE_MS });
	});

	beforeEach(async () => {
		await resetSchema(sql);
		await bootstrapPgJobsSchema(sql);
		runner = new PgJobRunner(store, { workerId: WORKER_ID, leaseDurationMs: LEASE_MS });
	});

	afterAll(async () => {
		await teardown(sql);
	});

	it("memory.organize: runner claims and executes organizer job end-to-end", async () => {
		const baseNow = 1_700_020_000_000;
		const enqueueInput = {
			...buildOrganizeEnqueueInput({
				settlementId: "runner-settle-1",
				agentId: "agent-org",
				chunkOrdinal: "001",
				chunkNodeRefs: ["node-a", "node-b"],
				embeddingModelId: "text-embedding-3-small",
			}),
			now_ms: baseNow,
			next_attempt_at: baseNow,
		};

		const enq = await store.enqueue(enqueueInput);
		expect(enq.outcome).toBe("created");

		let workerCalled = false;
		let receivedJob: PgJobCurrentRow | null = null;

		runner.registerWorker("memory.organize", async (job) => {
			workerCalled = true;
			receivedJob = job;
			return { success: true };
		});

		const outcome = await runner.processNext();

		expect(outcome).toBe("processed");
		expect(workerCalled).toBe(true);
		expect(receivedJob).not.toBeNull();
		expect(receivedJob!.job_key).toBe(enqueueInput.job_key);
		expect(receivedJob!.job_type).toBe("memory.organize");
		expect(receivedJob!.status).toBe("running");

		const [row] = await sql<CurrentJobRow[]>`
			SELECT job_key, status, attempt_count, claim_version, last_error_message
			FROM jobs_current
			WHERE job_key = ${enqueueInput.job_key}
		`;
		expect(row.status).toBe("succeeded");
		expect(Number(row.claim_version)).toBe(1);
		expect(Number(row.attempt_count)).toBe(1);

		const attempts = await sql<AttemptRow[]>`
			SELECT job_key, claim_version, attempt_no, worker_id, outcome, error_message
			FROM job_attempts
			WHERE job_key = ${enqueueInput.job_key}
			ORDER BY attempt_id ASC
		`;
		expect(attempts.length).toBe(1);
		expect(attempts[0].outcome).toBe("succeeded");
		expect(attempts[0].worker_id).toBe(WORKER_ID);
		expect(Number(attempts[0].claim_version)).toBe(1);
	});

	it("search.rebuild: runner claims and executes rebuild job end-to-end", async () => {
		const baseNow = 1_700_020_100_000;
		const enqueueInput = {
			...buildSearchRebuildEnqueueInput({
				scope: "private" as const,
				targetAgentId: "agent-rebuild",
				triggerSource: "manual_cli",
				triggerReason: "full_rebuild",
			}),
			now_ms: baseNow,
			next_attempt_at: baseNow,
		};

		const enq = await store.enqueue(enqueueInput);
		expect(enq.outcome).toBe("created");

		let workerCalled = false;
		let receivedJob: PgJobCurrentRow | null = null;

		runner.registerWorker("search.rebuild", async (job) => {
			workerCalled = true;
			receivedJob = job;
			return { rebuilt: true, indexCount: 42 };
		});

		const outcome = await runner.processNext();

		expect(outcome).toBe("processed");
		expect(workerCalled).toBe(true);
		expect(receivedJob).not.toBeNull();
		expect(receivedJob!.job_key).toBe(enqueueInput.job_key);
		expect(receivedJob!.job_type).toBe("search.rebuild");
		expect(receivedJob!.status).toBe("running");

		const [row] = await sql<CurrentJobRow[]>`
			SELECT job_key, status, attempt_count, claim_version, last_error_message
			FROM jobs_current
			WHERE job_key = ${enqueueInput.job_key}
		`;
		expect(row.status).toBe("succeeded");
		expect(Number(row.claim_version)).toBe(1);
		expect(Number(row.attempt_count)).toBe(1);

		const attempts = await sql<AttemptRow[]>`
			SELECT job_key, claim_version, attempt_no, worker_id, outcome, error_message
			FROM job_attempts
			WHERE job_key = ${enqueueInput.job_key}
			ORDER BY attempt_id ASC
		`;
		expect(attempts.length).toBe(1);
		expect(attempts[0].outcome).toBe("succeeded");
		expect(attempts[0].worker_id).toBe(WORKER_ID);
		expect(Number(attempts[0].claim_version)).toBe(1);
	});

	it("no worker: unregistered job type fails gracefully", async () => {
		const baseNow = 1_700_020_200_000;
		const enqueueInput = {
			...buildOrganizeEnqueueInput({
				settlementId: "runner-no-worker",
				agentId: "agent-orphan",
				chunkOrdinal: "099",
				chunkNodeRefs: ["node-x"],
				embeddingModelId: "text-embedding-3-small",
			}),
			now_ms: baseNow,
			next_attempt_at: baseNow,
		};

		const enq = await store.enqueue(enqueueInput);
		expect(enq.outcome).toBe("created");

		const outcome = await runner.processNext();
		expect(outcome).toBe("processed");

		const [row] = await sql<CurrentJobRow[]>`
			SELECT job_key, status, attempt_count, claim_version, last_error_message
			FROM jobs_current
			WHERE job_key = ${enqueueInput.job_key}
		`;

		expect(row.last_error_message).toContain("No worker registered");
		expect(row.last_error_message).toContain("memory.organize");

		const attempts = await sql<AttemptRow[]>`
			SELECT job_key, claim_version, attempt_no, worker_id, outcome, error_message
			FROM job_attempts
			WHERE job_key = ${enqueueInput.job_key}
			ORDER BY attempt_id ASC
		`;
		expect(attempts.length).toBe(1);
		expect(attempts[0].error_message).toContain("No worker registered");

		// memory.organize has max_attempts=4, so first fail is retryable
		expect(attempts[0].outcome).toBe("failed_retryable");
		expect(row.status).toBe("pending");
	});
});
