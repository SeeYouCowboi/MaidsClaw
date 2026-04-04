import { afterEach, describe, expect, it, jest } from "bun:test";
import type postgres from "postgres";
import type { FlushSelector } from "../../src/interaction/flush-selector.js";
import type { InteractionStore } from "../../src/interaction/store.js";
import type { JobEntry, JobPersistence } from "../../src/jobs/persistence.js";
import { PendingSettlementSweeper } from "../../src/memory/pending-settlement-sweeper.js";
import type { SettlementLedger } from "../../src/memory/settlement-ledger.js";
import type { MemoryTaskAgent } from "../../src/memory/task-agent.js";
import type { PendingFlushRecoveryRepo } from "../../src/storage/domain-repos/contracts/pending-flush-recovery-repo.js";

type QueryQueues = {
	recent?: unknown[][];
	settlements?: unknown[][];
	existingJobs?: unknown[][];
};

function createSqlMock(queues: QueryQueues): {
	sql: postgres.Sql;
	calls: Array<{ query: string; values: unknown[] }>;
} {
	let recentIndex = 0;
	let settlementIndex = 0;
	let existingIndex = 0;
	const calls: Array<{ query: string; values: unknown[] }> = [];

	const sql = (async (
		strings: TemplateStringsArray,
		...values: unknown[]
	): Promise<unknown[]> => {
		const query = strings.join(" ").replace(/\s+/g, " ").trim();
		calls.push({ query, values });
		if (query.includes("FROM recent_cognition_slots")) {
			return queues.recent?.[recentIndex++] ?? [];
		}
		if (query.includes("FROM interaction_records")) {
			return queues.settlements?.[settlementIndex++] ?? [];
		}
		if (query.includes("FROM jobs_current")) {
			return queues.existingJobs?.[existingIndex++] ?? [];
		}
		throw new Error(`Unexpected SQL query: ${query}`);
	}) as unknown as postgres.Sql;

	return { sql, calls };
}

function createJobPersistenceMock(): {
	jobPersistence: JobPersistence;
	enqueues: Array<Omit<JobEntry, "attemptCount" | "createdAt" | "updatedAt">>;
} {
	const enqueues: Array<
		Omit<JobEntry, "attemptCount" | "createdAt" | "updatedAt">
	> = [];
	const jobPersistence: JobPersistence = {
		async enqueue(entry) {
			enqueues.push(entry);
		},
		async claim() {
			return false;
		},
		async complete() {},
		async fail() {},
		async retry() {
			return false;
		},
		async listPending() {
			return [];
		},
		async listRetryable() {
			return [];
		},
		async countByStatus() {
			return 0;
		},
	};

	return { jobPersistence, enqueues };
}

function createPendingFlushRepo(): PendingFlushRecoveryRepo {
	return {
		async recordPending() {},
		async markAttempted() {},
		async markResolved() {},
		async queryActive() {
			return [];
		},
		async markHardFail() {},
		async getBySession() {
			return null;
		},
		async trySweepLock() {
			return true;
		},
		async releaseSweepLock() {},
	};
}

function createSweeper(params: {
	now: () => number;
	thinkerRecoveryIntervalMs?: number;
	sql: postgres.Sql;
	jobPersistence: JobPersistence;
	settlementLedger?: SettlementLedger;
	listStaleSessions?: InteractionStore["listStalePendingSettlementSessions"];
}): PendingSettlementSweeper {
	const interactionStore = {
		listStalePendingSettlementSessions:
			params.listStaleSessions ?? (() => []),
		getUnprocessedRangeForSession: () => null,
		getByRange: () => [],
		markProcessed: () => {},
	} as unknown as InteractionStore;

	const flushSelector = {
		buildSessionCloseFlush: () => null,
	} as unknown as FlushSelector;

	return new PendingSettlementSweeper(
		createPendingFlushRepo(),
		interactionStore,
		flushSelector,
		{} as MemoryTaskAgent,
		{
			now: params.now,
			thinkerRecoveryIntervalMs: params.thinkerRecoveryIntervalMs,
		},
		{
			sql: params.sql,
			jobPersistence: params.jobPersistence,
			settlementLedger: params.settlementLedger,
		},
	);
}

function activateSweeper(sweeper: PendingSettlementSweeper): void {
	(sweeper as unknown as { stopped: boolean }).stopped = false;
}

function createActiveSweeper(params: {
	now: () => number;
	thinkerRecoveryIntervalMs?: number;
	sql: postgres.Sql;
	jobPersistence: JobPersistence;
	settlementLedger?: SettlementLedger;
	listStaleSessions?: InteractionStore["listStalePendingSettlementSessions"];
}): PendingSettlementSweeper {
	const sweeper = createSweeper(params);
	activateSweeper(sweeper);
	return sweeper;
}

describe("PendingSettlementSweeper thinker recovery", () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("version gap detected re-enqueues missing thinker job", async () => {
		const nowMs = 1_000_000;
		const { sql } = createSqlMock({
			recent: [
				[
					{
						session_id: "session-1",
						agent_id: "agent-1",
						thinker_committed_version: 3,
						talker_turn_counter: 4,
					},
				],
			],
			settlements: [
				[
					{
						payload: {
							settlementId: "stl:req-1",
							talkerTurnVersion: 4,
						},
						committed_at: nowMs - 1_000,
					},
				],
			],
			existingJobs: [[]],
		});
		const { jobPersistence, enqueues } = createJobPersistenceMock();
		const sweeper = createActiveSweeper({
			now: () => nowMs,
			sql,
			jobPersistence,
		});

		await (
			sweeper as unknown as { sweepThinkerJobs: () => Promise<void> }
		).sweepThinkerJobs();

		expect(enqueues).toHaveLength(1);
		expect(enqueues[0].id).toBe("thinker:session-1:stl:req-1");
		expect(enqueues[0].jobType).toBe("cognition.thinker");
		expect(enqueues[0].status).toBe("pending");
		expect(enqueues[0].payload).toEqual({
			sessionId: "session-1",
			agentId: "agent-1",
			settlementId: "stl:req-1",
			talkerTurnVersion: 4,
		});
	});

	it("existing pending/running thinker job skips re-enqueue", async () => {
		const nowMs = 1_000_000;
		const { sql } = createSqlMock({
			recent: [
				[
					{
						session_id: "session-1",
						agent_id: "agent-1",
						thinker_committed_version: 2,
						talker_turn_counter: 3,
					},
				],
			],
			settlements: [
				[
					{
						payload: {
							settlementId: "stl:req-2",
							talkerTurnVersion: 3,
						},
						committed_at: nowMs - 500,
					},
				],
			],
			existingJobs: [[{ job_key: "thinker:session-1:stl:req-2" }]],
		});
		const { jobPersistence, enqueues } = createJobPersistenceMock();
		const sweeper = createActiveSweeper({
			now: () => nowMs,
			sql,
			jobPersistence,
		});

		await (
			sweeper as unknown as { sweepThinkerJobs: () => Promise<void> }
		).sweepThinkerJobs();

		expect(enqueues).toHaveLength(0);
	});

	it("no version gap does nothing", async () => {
		const { sql } = createSqlMock({ recent: [[]] });
		const { jobPersistence, enqueues } = createJobPersistenceMock();
		const sweeper = createActiveSweeper({
			now: () => 1_000_000,
			sql,
			jobPersistence,
		});

		await (
			sweeper as unknown as { sweepThinkerJobs: () => Promise<void> }
		).sweepThinkerJobs();

		expect(enqueues).toHaveLength(0);
	});

	it("older-than-threshold gap logs critical and marks ledger failed", async () => {
		const nowMs = 2_000_000;
		const { sql } = createSqlMock({
			recent: [
				[
					{
						session_id: "session-1",
						agent_id: "agent-1",
						thinker_committed_version: 1,
						talker_turn_counter: 2,
					},
				],
			],
			settlements: [
				[
					{
						payload: {
							settlementId: "stl:req-3",
							talkerTurnVersion: 2,
						},
						committed_at: nowMs - 31 * 60_000,
					},
				],
			],
			existingJobs: [[]],
		});
		const { jobPersistence, enqueues } = createJobPersistenceMock();
		const markFailed = jest.fn(async () => {});
		const settlementLedger = {
			markFailed,
		} as unknown as SettlementLedger;
		const errorSpy = jest
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		const sweeper = createActiveSweeper({
			now: () => nowMs,
			sql,
			jobPersistence,
			settlementLedger,
		});

		await (
			sweeper as unknown as { sweepThinkerJobs: () => Promise<void> }
		).sweepThinkerJobs();

		expect(enqueues).toHaveLength(0);
		expect(markFailed).toHaveBeenCalledWith(
			"stl:req-3",
			"hard_fail: thinker job missing beyond threshold",
			false,
		);
		expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
		expect(String(errorSpy.mock.calls[0]?.[0] ?? "")).toContain("CRITICAL");
	});

	it("thinker recovery runs only on configured interval", async () => {
		let nowMs = 1_000_000;
		const { sql, calls } = createSqlMock({
			recent: [[], []],
		});
		const { jobPersistence, enqueues } = createJobPersistenceMock();
		const sweeper = createActiveSweeper({
			now: () => nowMs,
			thinkerRecoveryIntervalMs: 60_000,
			sql,
			jobPersistence,
		});
		const runSweep = (
			sweeper as unknown as {
				runSweep: (params: { includeAllPending: boolean }) => Promise<void>;
			}
		).runSweep.bind(sweeper);

		await runSweep({ includeAllPending: false });
		nowMs += 30_000;
		await runSweep({ includeAllPending: false });
		nowMs += 40_000;
		await runSweep({ includeAllPending: false });

		const recentCalls = calls.filter((call) =>
			call.query.includes("FROM recent_cognition_slots"),
		);
		expect(recentCalls).toHaveLength(2);
		expect(enqueues).toHaveLength(0);
	});
});
