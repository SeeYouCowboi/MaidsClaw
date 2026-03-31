import { describe, expect, test } from "bun:test";
import { AppMaintenanceFacadeImpl } from "../../../src/app/host/maintenance-facade.js";
import type { MaintenanceOrchestrationService } from "../../../src/app/host/maintenance-orchestration-service.js";
import type {
	JobPersistence,
	PersistentJobStatus,
} from "../../../src/jobs/persistence.js";

function createJobPersistenceSpy(statusCounts?:
	Partial<Record<PersistentJobStatus, number>>): {
	jobPersistence: JobPersistence;
	countByStatusCalls: PersistentJobStatus[];
} {
	const countByStatusCalls: PersistentJobStatus[] = [];

	const jobPersistence: JobPersistence = {
		enqueue: async () => undefined,
		claim: async () => false,
		complete: async () => undefined,
		fail: async () => undefined,
		retry: async () => false,
		listPending: async () => [],
		listRetryable: async () => [],
		countByStatus: async (status) => {
			countByStatusCalls.push(status);
			return statusCounts?.[status] ?? 0;
		},
	};

	return { jobPersistence, countByStatusCalls };
}

function createOrchestrationSpy(): {
	orchestrationService: MaintenanceOrchestrationService;
	getRunFullMaintenanceCallCount: () => number;
} {
	let runFullMaintenanceCallCount = 0;

	const orchestrationService = {
		runFullMaintenance: async () => {
			runFullMaintenanceCallCount += 1;
		},
		searchRebuild: async () => undefined,
		replayProjection: async () => undefined,
		rebuildDerived: async () => undefined,
	} as unknown as MaintenanceOrchestrationService;

	return {
		orchestrationService,
		getRunFullMaintenanceCallCount: () => runFullMaintenanceCallCount,
	};
}

describe("AppMaintenanceFacadeImpl", () => {
	test("runOnce delegates to orchestration runFullMaintenance", async () => {
		const { orchestrationService, getRunFullMaintenanceCallCount } =
			createOrchestrationSpy();
		const { jobPersistence } = createJobPersistenceSpy();
		const facade = new AppMaintenanceFacadeImpl(orchestrationService, jobPersistence);

		await facade.runOnce();

		expect(getRunFullMaintenanceCallCount()).toBe(1);
	});

	test("drain is idempotent", async () => {
		const { orchestrationService } = createOrchestrationSpy();
		const { jobPersistence } = createJobPersistenceSpy();
		const facade = new AppMaintenanceFacadeImpl(orchestrationService, jobPersistence);

		await facade.drain();
		await facade.drain();

		const status = await facade.getDrainStatus();
		expect(status.draining).toBe(true);
	});

	test("getDrainStatus reports active and pending job counts", async () => {
		const { orchestrationService } = createOrchestrationSpy();
		const { jobPersistence } = createJobPersistenceSpy({
			processing: 3,
			pending: 7,
		});
		const facade = new AppMaintenanceFacadeImpl(orchestrationService, jobPersistence);

		const status = await facade.getDrainStatus();

		expect(status).toEqual({
			draining: false,
			activeJobs: 3,
			pendingJobs: 7,
		});
	});

	test("getDrainStatus queries processing and pending statuses", async () => {
		const { orchestrationService } = createOrchestrationSpy();
		const { jobPersistence, countByStatusCalls } = createJobPersistenceSpy();
		const facade = new AppMaintenanceFacadeImpl(orchestrationService, jobPersistence);

		await facade.getDrainStatus();

		expect(countByStatusCalls).toEqual(["processing", "pending"]);
	});
});
