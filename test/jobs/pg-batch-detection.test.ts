import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import type { EnqueueJobInput, PgJobCurrentRow } from "../../src/jobs/durable-store.js";
import { bootstrapPgJobsSchema } from "../../src/jobs/pg-schema.js";
import { PgJobStore } from "../../src/jobs/pg-store.js";
import { createTestPg, ensureTestDb, resetSchema, skipPgTests, teardown } from "../helpers/pg-test-utils.js";

function buildThinkerEnqueueInput(params: {
	sessionId: string;
	agentId: string;
	settlementId: string;
	talkerTurnVersion: number;
	nowMs: number;
	nextAttemptAt?: number;
}): EnqueueJobInput<"cognition.thinker"> {
	return {
		job_key: `cognition.thinker:${params.sessionId}:${params.agentId}:${params.settlementId}`,
		job_type: "cognition.thinker",
		execution_class: "background.cognition_thinker",
		concurrency_key: `cognition.thinker:session:${params.sessionId}`,
		payload_schema_version: 1,
		payload_json: {
			sessionId: params.sessionId,
			agentId: params.agentId,
			settlementId: params.settlementId,
			talkerTurnVersion: params.talkerTurnVersion,
		},
		max_attempts: 3,
		now_ms: params.nowMs,
		next_attempt_at: params.nextAttemptAt ?? params.nowMs,
	};
}

function talkerTurnVersionOf(row: PgJobCurrentRow): number {
	const payload = typeof row.payload_json === "string"
		? JSON.parse(row.payload_json) as Record<string, unknown>
		: row.payload_json as Record<string, unknown>;
	return Number(payload.talkerTurnVersion);
}

describe.skipIf(skipPgTests)("pg listPendingByKindAndPayload", () => {
	let sql: postgres.Sql;
	let store: PgJobStore;

	beforeAll(async () => {
		await ensureTestDb();
		sql = createTestPg();
		store = new PgJobStore(sql);
	});

	beforeEach(async () => {
		await resetSchema(sql);
		await bootstrapPgJobsSchema(sql);
	});

	afterAll(async () => {
		await teardown(sql);
	});

	it("happy path: returns pending thinker jobs by session+agent ordered by talkerTurnVersion asc", async () => {
		const nowMs = 1_700_120_000_000;

		await store.enqueue(buildThinkerEnqueueInput({
			sessionId: "session-a",
			agentId: "agent-1",
			settlementId: "s3",
			talkerTurnVersion: 3,
			nowMs,
		}));
		await store.enqueue(buildThinkerEnqueueInput({
			sessionId: "session-a",
			agentId: "agent-1",
			settlementId: "s4",
			talkerTurnVersion: 4,
			nowMs: nowMs + 1,
		}));
		await store.enqueue(buildThinkerEnqueueInput({
			sessionId: "session-a",
			agentId: "agent-1",
			settlementId: "s5",
			talkerTurnVersion: 5,
			nowMs: nowMs + 2,
		}));

		const rows = await store.listPendingByKindAndPayload(
			"cognition.thinker",
			{ sessionId: "session-a", agentId: "agent-1" },
			nowMs + 10,
		);

		expect(rows).toHaveLength(3);
		expect(rows.map((row) => talkerTurnVersionOf(row))).toEqual([3, 4, 5]);
	});

	it("backoff filter: excludes pending rows whose next_attempt_at is in the future", async () => {
		const nowMs = 1_700_120_100_000;

		await store.enqueue(buildThinkerEnqueueInput({
			sessionId: "session-backoff",
			agentId: "agent-backoff",
			settlementId: "s3",
			talkerTurnVersion: 3,
			nowMs,
		}));
		await store.enqueue(buildThinkerEnqueueInput({
			sessionId: "session-backoff",
			agentId: "agent-backoff",
			settlementId: "s4",
			talkerTurnVersion: 4,
			nowMs: nowMs + 1,
			nextAttemptAt: nowMs + 60_000,
		}));
		await store.enqueue(buildThinkerEnqueueInput({
			sessionId: "session-backoff",
			agentId: "agent-backoff",
			settlementId: "s5",
			talkerTurnVersion: 5,
			nowMs: nowMs + 2,
			nextAttemptAt: nowMs,
		}));

		const rows = await store.listPendingByKindAndPayload(
			"cognition.thinker",
			{ sessionId: "session-backoff", agentId: "agent-backoff" },
			nowMs,
		);

		expect(rows).toHaveLength(2);
		expect(rows.map((row) => talkerTurnVersionOf(row))).toEqual([3, 5]);
	});

	it("cross-session isolation: query does not return rows from other sessions", async () => {
		const nowMs = 1_700_120_200_000;

		await store.enqueue(buildThinkerEnqueueInput({
			sessionId: "session-a",
			agentId: "agent-shared",
			settlementId: "sa-1",
			talkerTurnVersion: 1,
			nowMs,
		}));
		await store.enqueue(buildThinkerEnqueueInput({
			sessionId: "session-a",
			agentId: "agent-shared",
			settlementId: "sa-2",
			talkerTurnVersion: 2,
			nowMs: nowMs + 1,
		}));
		await store.enqueue(buildThinkerEnqueueInput({
			sessionId: "session-b",
			agentId: "agent-shared",
			settlementId: "sb-1",
			talkerTurnVersion: 99,
			nowMs: nowMs + 2,
		}));

		const rows = await store.listPendingByKindAndPayload(
			"cognition.thinker",
			{ sessionId: "session-a", agentId: "agent-shared" },
			nowMs + 10,
		);

		expect(rows).toHaveLength(2);
		expect(rows.map((row) => talkerTurnVersionOf(row))).toEqual([1, 2]);
	});

	it("cross-agent isolation: query does not return rows from other agents in same session", async () => {
		const nowMs = 1_700_120_300_000;

		await store.enqueue(buildThinkerEnqueueInput({
			sessionId: "session-shared",
			agentId: "agent-a",
			settlementId: "a-1",
			talkerTurnVersion: 1,
			nowMs,
		}));
		await store.enqueue(buildThinkerEnqueueInput({
			sessionId: "session-shared",
			agentId: "agent-a",
			settlementId: "a-2",
			talkerTurnVersion: 2,
			nowMs: nowMs + 1,
		}));
		await store.enqueue(buildThinkerEnqueueInput({
			sessionId: "session-shared",
			agentId: "agent-b",
			settlementId: "b-1",
			talkerTurnVersion: 3,
			nowMs: nowMs + 2,
		}));

		const rows = await store.listPendingByKindAndPayload(
			"cognition.thinker",
			{ sessionId: "session-shared", agentId: "agent-a" },
			nowMs + 10,
		);

		expect(rows).toHaveLength(2);
		expect(rows.map((row) => talkerTurnVersionOf(row))).toEqual([1, 2]);
	});

	it("empty result: returns [] when no matching pending rows exist", async () => {
		const nowMs = 1_700_120_400_000;

		const rows = await store.listPendingByKindAndPayload(
			"cognition.thinker",
			{ sessionId: "session-missing", agentId: "agent-missing" },
			nowMs,
		);

		expect(rows).toEqual([]);
	});

	it("ordering: returned rows are strictly ascending by talkerTurnVersion", async () => {
		const nowMs = 1_700_120_500_000;

		await store.enqueue(buildThinkerEnqueueInput({
			sessionId: "session-order",
			agentId: "agent-order",
			settlementId: "s9",
			talkerTurnVersion: 9,
			nowMs,
		}));
		await store.enqueue(buildThinkerEnqueueInput({
			sessionId: "session-order",
			agentId: "agent-order",
			settlementId: "s7",
			talkerTurnVersion: 7,
			nowMs: nowMs + 1,
		}));

		const rows = await store.listPendingByKindAndPayload(
			"cognition.thinker",
			{ sessionId: "session-order", agentId: "agent-order" },
			nowMs + 10,
		);

		expect(rows).toHaveLength(2);
		expect(talkerTurnVersionOf(rows[0])).toBeLessThan(talkerTurnVersionOf(rows[1]));
		expect(rows.map((row) => talkerTurnVersionOf(row))).toEqual([7, 9]);
	});
});
