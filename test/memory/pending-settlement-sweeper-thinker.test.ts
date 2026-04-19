import { afterEach, describe, expect, it, jest } from "bun:test";
import type postgres from "postgres";
import type { FlushSelector } from "../../src/interaction/flush-selector.js";
import type { InteractionStore } from "../../src/interaction/store.js";
import type { JobEntry, JobPersistence } from "../../src/jobs/persistence.js";
import { PendingSettlementSweeper } from "../../src/memory/pending-settlement-sweeper.js";
import type { SettlementLedger } from "../../src/memory/settlement-ledger.js";
import type { MemoryTaskAgent } from "../../src/memory/task-agent.js";
import type { PendingFlushRecoveryRepo } from "../../src/storage/domain-repos/contracts/pending-flush-recovery-repo.js";
import { compactSlotEntries } from "../../src/storage/domain-repos/pg/recent-cognition-slot-repo.js";

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
		listStalePendingSettlementSessions: params.listStaleSessions ?? (() => []),
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

	it("recovery re-enqueue uses corrected turn payload and ignores stale hallucinated summary fields", async () => {
		const nowMs = 3_000_000;
		const { sql } = createSqlMock({
			recent: [
				[
					{
						session_id: "session-1",
						agent_id: "agent-1",
						thinker_committed_version: 4,
						talker_turn_counter: 5,
					},
				],
			],
			settlements: [
				[
					{
						payload: {
							settlementId: "stl:req-corrected-5",
							talkerTurnVersion: 5,
							cognitiveSketchSource: "explicit",
							hallucinatedSlotSummary: "stale value that must not be replayed",
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
		expect(enqueues[0].id).toBe("thinker:session-1:stl:req-corrected-5");
		expect(enqueues[0].payload).toEqual({
			sessionId: "session-1",
			agentId: "agent-1",
			settlementId: "stl:req-corrected-5",
			talkerTurnVersion: 5,
		});
		expect(
			"hallucinatedSlotSummary" in
				(enqueues[0].payload as Record<string, unknown>),
		).toBe(false);
	});

	it("recovery path keeps settlement identity for auto_fallback sketch source payloads", async () => {
		const nowMs = 4_000_000;
		const { sql } = createSqlMock({
			recent: [
				[
					{
						session_id: "session-2",
						agent_id: "agent-2",
						thinker_committed_version: 1,
						talker_turn_counter: 2,
					},
				],
			],
			settlements: [
				[
					{
						payload: {
							settlementId: "stl:req-auto-2",
							talkerTurnVersion: 2,
							cognitiveSketchSource: "auto_fallback",
						},
						committed_at: nowMs - 2_000,
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
		expect(enqueues[0].id).toBe("thinker:session-2:stl:req-auto-2");
		expect(enqueues[0].payload).toEqual({
			sessionId: "session-2",
			agentId: "agent-2",
			settlementId: "stl:req-auto-2",
			talkerTurnVersion: 2,
		});
	});

	it("re-enqueue remains idempotent across repeated sweeps for corrected canonical key settlement", async () => {
		const nowMs = 5_000_000;
		const { sql } = createSqlMock({
			recent: [
				[
					{
						session_id: "session-3",
						agent_id: "agent-3",
						thinker_committed_version: 2,
						talker_turn_counter: 3,
					},
				],
				[
					{
						session_id: "session-3",
						agent_id: "agent-3",
						thinker_committed_version: 2,
						talker_turn_counter: 3,
					},
				],
			],
			settlements: [
				[
					{
						payload: {
							settlementId: "stl:req-canonical-3",
							talkerTurnVersion: 3,
							correctedCanonicalKey: "belief:user-location",
						},
						committed_at: nowMs - 3_000,
					},
				],
				[
					{
						payload: {
							settlementId: "stl:req-canonical-3",
							talkerTurnVersion: 3,
							correctedCanonicalKey: "belief:user-location",
						},
						committed_at: nowMs - 3_000,
					},
				],
			],
			existingJobs: [
				[],
				[{ job_key: "thinker:session-3:stl:req-canonical-3" }],
			],
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
		await (
			sweeper as unknown as { sweepThinkerJobs: () => Promise<void> }
		).sweepThinkerJobs();

		expect(enqueues).toHaveLength(1);
		expect(enqueues[0].id).toBe("thinker:session-3:stl:req-canonical-3");
	});

	it("v1 recovery continuity: re-enqueue of stale v10 gap does not resurrect hallucinated summary over corrected v11", async () => {
		const nowMs = 6_000_000;
		const { sql } = createSqlMock({
			recent: [
				[
					{
						session_id: "session-4",
						agent_id: "agent-4",
						thinker_committed_version: 9,
						talker_turn_counter: 11,
					},
				],
			],
			settlements: [
				[
					{
						payload: {
							settlementId: "stl:req-10",
							talkerTurnVersion: 10,
							cognitiveSketchSource: "auto_fallback",
						},
						committed_at: nowMs - 3_000,
					},
					{
						payload: {
							settlementId: "stl:req-11",
							talkerTurnVersion: 11,
							cognitiveSketchSource: "explicit",
						},
						committed_at: nowMs - 1_000,
					},
				],
			],
			existingJobs: [[], [{ job_key: "thinker:session-4:stl:req-11" }]],
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
		expect(enqueues[0].id).toBe("thinker:session-4:stl:req-10");
		expect(enqueues[0].payload).toEqual({
			sessionId: "session-4",
			agentId: "agent-4",
			settlementId: "stl:req-10",
			talkerTurnVersion: 10,
		});

		const correctedV11Slot = [
			{
				settlementId: "stl:req-11",
				committedAt: 1_100,
				kind: "assertion",
				key: "belief:user-location",
				summary: "user location corrected to conservatory",
				status: "active",
				provenance: "user_stated",
				sourceTurnVersion: 11,
			},
		];
		const staleV10Replay = [
			{
				settlementId: "stl:req-10",
				committedAt: 9_999,
				kind: "assertion",
				key: "belief:user-location",
				summary: "hallucinated location in cellar",
				status: "active",
				provenance: "talker_sketch_auto",
				sourceTurnVersion: 10,
			},
		];

		const merged = compactSlotEntries([
			...correctedV11Slot,
			...staleV10Replay,
		]) as Array<{ key: string; summary: string; sourceTurnVersion?: number }>;

		expect(merged).toHaveLength(1);
		expect(merged[0].key).toBe("belief:user-location");
		expect(merged[0].summary).toBe("user location corrected to conservatory");
		expect(merged[0].summary).not.toBe("hallucinated location in cellar");
		expect(merged[0].sourceTurnVersion).toBe(11);
	});
});
