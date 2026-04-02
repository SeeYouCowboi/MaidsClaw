import { describe, expect, test } from "bun:test";
import { MaintenanceOrchestrationService } from "../../../src/app/host/maintenance-orchestration-service.js";
import type { JobPersistence } from "../../../src/jobs/persistence.js";
import { JOB_MAX_ATTEMPTS } from "../../../src/jobs/types.js";

type EnqueueInput = Parameters<JobPersistence["enqueue"]>[0];

function createPersistenceSpy(): {
	jobPersistence: JobPersistence;
	enqueued: EnqueueInput[];
} {
	const enqueued: EnqueueInput[] = [];

	const jobPersistence: JobPersistence = {
		enqueue: async (entry) => {
			enqueued.push(entry);
		},
		claim: async () => false,
		complete: async () => undefined,
		fail: async () => undefined,
		retry: async () => false,
		listPending: async () => [],
		listRetryable: async () => [],
		countByStatus: async () => 0,
	};

	return { jobPersistence, enqueued };
}

describe("MaintenanceOrchestrationService", () => {
	test("searchRebuild dispatches search.rebuild job", async () => {
		const { jobPersistence, enqueued } = createPersistenceSpy();
		const service = new MaintenanceOrchestrationService(jobPersistence, "pg");
		const originalNow = Date.now;
		Date.now = () => 1_700_000_000_000;

		try {
			await service.searchRebuild("agent-01", "all");
		} finally {
			Date.now = originalNow;
		}

		expect(enqueued).toHaveLength(1);
		expect(enqueued[0]).toEqual({
			id: "search.rebuild:all:agent-01:1700000000000",
			jobType: "search.rebuild",
			payload: { agentId: "agent-01", scope: "all" },
			status: "pending",
			maxAttempts: JOB_MAX_ATTEMPTS["search.rebuild"],
		});
	});

	test("replayProjection dispatches maintenance.replay_projection job", async () => {
		const { jobPersistence, enqueued } = createPersistenceSpy();
		const service = new MaintenanceOrchestrationService(jobPersistence, "pg");
		const originalNow = Date.now;
		Date.now = () => 1_700_000_000_100;

		try {
			await service.replayProjection("world");
		} finally {
			Date.now = originalNow;
		}

		expect(enqueued).toHaveLength(1);
		expect(enqueued[0]).toEqual({
			id: "maintenance.replay_projection:world:1700000000100",
			jobType: "maintenance.replay_projection",
			payload: { surface: "world" },
			status: "pending",
			maxAttempts: JOB_MAX_ATTEMPTS["maintenance.replay_projection"],
		});
	});

	test("rebuildDerived dispatches maintenance.rebuild_derived job", async () => {
		const { jobPersistence, enqueued } = createPersistenceSpy();
		const service = new MaintenanceOrchestrationService(jobPersistence, "pg");
		const originalNow = Date.now;
		Date.now = () => 1_700_000_000_200;

		try {
			await service.rebuildDerived("agent-02", { dryRun: true, reEmbed: true });
		} finally {
			Date.now = originalNow;
		}

		expect(enqueued).toHaveLength(1);
		expect(enqueued[0]).toEqual({
			id: "maintenance.rebuild_derived:agent-02:1700000000200",
			jobType: "maintenance.rebuild_derived",
			payload: { agentId: "agent-02", dryRun: true, reEmbed: true },
			status: "pending",
			maxAttempts: JOB_MAX_ATTEMPTS["maintenance.rebuild_derived"],
		});
	});

	test("runFullMaintenance dispatches maintenance.full job", async () => {
		const { jobPersistence, enqueued } = createPersistenceSpy();
		const service = new MaintenanceOrchestrationService(jobPersistence, "pg");
		const originalNow = Date.now;
		Date.now = () => 1_700_000_000_300;

		try {
			await service.runFullMaintenance();
		} finally {
			Date.now = originalNow;
		}

		expect(enqueued).toHaveLength(1);
		expect(enqueued[0]).toEqual({
			id: "maintenance.full:1700000000300",
			jobType: "maintenance.full",
			payload: { backendType: "pg" },
			status: "pending",
			maxAttempts: JOB_MAX_ATTEMPTS["maintenance.full"],
		});
	});
});
