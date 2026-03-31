import { describe, expect, test } from "bun:test";
import type { AppHostOptions } from "../../../src/app/host/types.js";
import { createAppHost } from "../../../src/app/host/create-app-host.js";
import type { RuntimeBootstrapResult } from "../../../src/bootstrap/types.js";
import { GatewayServer } from "../../../src/gateway/server.js";
import { JobDispatcher } from "../../../src/jobs/dispatcher.js";
import { JobScheduler } from "../../../src/jobs/scheduler.js";

function createMockRuntime(
	overrides: Partial<RuntimeBootstrapResult> = {},
): RuntimeBootstrapResult {
	return {
		backendType: "sqlite",
		healthChecks: { bootstrap: "ok" },
		traceStore: undefined,
		sessionService: {} as RuntimeBootstrapResult["sessionService"],
		turnService: {} as RuntimeBootstrapResult["turnService"],
		memoryTaskAgent: null,
		interactionRepo: {} as RuntimeBootstrapResult["interactionRepo"],
		agentRegistry: {
			getAll: () => [],
		} as unknown as RuntimeBootstrapResult["agentRegistry"],
		memoryPipelineReady: false,
		memoryPipelineStatus: "missing_embedding_model",
		effectiveOrganizerEmbeddingModelId: undefined,
		migrationStatus: {
			interaction: { succeeded: true, appliedMigrations: [] },
			memory: { succeeded: true },
			succeeded: true,
		},
		jobPersistence: {
			enqueue: async () => undefined,
			claim: async () => false,
			complete: async () => undefined,
			fail: async () => undefined,
			retry: async () => false,
			listPending: async () => [],
			listRetryable: async () => [],
			countByStatus: async () => 0,
		},
		shutdown: () => {},
		...overrides,
	} as unknown as RuntimeBootstrapResult;
}

function suppressLifecycleSideEffects(): () => void {
	const origGatewayStart = GatewayServer.prototype.start;
	const origGatewayStop = GatewayServer.prototype.stop;
	const origDispatcherStart = JobDispatcher.prototype.start;
	const origSchedulerStart = JobScheduler.prototype.start;
	const origSchedulerStop = JobScheduler.prototype.stop;

	GatewayServer.prototype.start = function () {};
	GatewayServer.prototype.stop = function () {};
	JobDispatcher.prototype.start = async function () {};
	JobScheduler.prototype.start = function () {};
	JobScheduler.prototype.stop = function () {};

	return () => {
		GatewayServer.prototype.start = origGatewayStart;
		GatewayServer.prototype.stop = origGatewayStop;
		JobDispatcher.prototype.start = origDispatcherStart;
		JobScheduler.prototype.start = origSchedulerStart;
		JobScheduler.prototype.stop = origSchedulerStop;
	};
}

describe("admin orchestration introspection", () => {
	test("server role (durable) reports orchestration.enabled === true", async () => {
		const restore = suppressLifecycleSideEffects();
		try {
			const host = await createAppHost(
				{ role: "server", enableDurableOrchestration: true, databasePath: ":memory:" },
				createMockRuntime(),
			);
			const status = await host.admin.getHostStatus();
			expect(status.orchestration).toBeDefined();
			expect(status.orchestration!.enabled).toBe(true);
			expect(status.orchestration!.role).toBe("server");
			expect(status.orchestration!.durableMode).toBe(true);
			await host.shutdown();
		} finally {
			restore();
		}
	});

	test("server role (non-durable) reports orchestration.enabled === false", async () => {
		const restore = suppressLifecycleSideEffects();
		try {
			const host = await createAppHost(
				{ role: "server", databasePath: ":memory:" },
				createMockRuntime(),
			);
			const status = await host.admin.getHostStatus();
			expect(status.orchestration).toBeDefined();
			expect(status.orchestration!.enabled).toBe(false);
			expect(status.orchestration!.role).toBe("server");
			expect(status.orchestration!.durableMode).toBe(false);
			await host.shutdown();
		} finally {
			restore();
		}
	});

	test("worker role reports orchestration.enabled === true", async () => {
		const restore = suppressLifecycleSideEffects();
		try {
			const host = await createAppHost(
				{ role: "worker", databasePath: ":memory:" },
				createMockRuntime(),
			);
			const status = await host.admin.getHostStatus();
			expect(status.orchestration).toBeDefined();
			expect(status.orchestration!.enabled).toBe(true);
			expect(status.orchestration!.role).toBe("worker");
			await host.shutdown();
		} finally {
			restore();
		}
	});

	test("local role reports orchestration.enabled === false", async () => {
		const restore = suppressLifecycleSideEffects();
		try {
			const host = await createAppHost(
				{ role: "local", databasePath: ":memory:" },
				createMockRuntime(),
			);
			const status = await host.admin.getHostStatus();
			expect(status.orchestration).toBeDefined();
			expect(status.orchestration!.enabled).toBe(false);
			expect(status.orchestration!.role).toBe("local");
			await host.shutdown();
		} finally {
			restore();
		}
	});

	test("leaseReclaimActive is true only when orchestrated + pg backend", async () => {
		const restore = suppressLifecycleSideEffects();
		try {
			const sqliteHost = await createAppHost(
				{ role: "worker", databasePath: ":memory:" },
				createMockRuntime({ backendType: "sqlite" }),
			);
			const sqliteStatus = await sqliteHost.admin.getHostStatus();
			expect(sqliteStatus.orchestration!.leaseReclaimActive).toBe(false);
			await sqliteHost.shutdown();

			const pgHost = await createAppHost(
				{ role: "worker", databasePath: ":memory:" },
				createMockRuntime({
					backendType: "pg",
					pgFactory: {
						type: "pg",
						initialize: async () => {},
						close: async () => {},
						getPool: () => null,
						pool: null,
						store: {
							enqueue: async () => undefined,
							claim: async () => null,
							complete: async () => undefined,
							fail: async () => undefined,
							heartbeat: async () => undefined,
							listPending: async () => [],
							reclaimExpiredLeases: async () => 0,
						},
					},
				} as unknown as Partial<RuntimeBootstrapResult>),
			);
			const pgStatus = await pgHost.admin.getHostStatus();
			expect(pgStatus.orchestration!.leaseReclaimActive).toBe(true);
			await pgHost.shutdown();

			const pgLocalHost = await createAppHost(
				{ role: "local", databasePath: ":memory:" },
				createMockRuntime({ backendType: "pg" }),
			);
			const pgLocalStatus = await pgLocalHost.admin.getHostStatus();
			expect(pgLocalStatus.orchestration!.leaseReclaimActive).toBe(false);
			await pgLocalHost.shutdown();
		} finally {
			restore();
		}
	});

	test("getCapabilities() returns orchestration capability flags", async () => {
		const restore = suppressLifecycleSideEffects();
		try {
			const serverHost = await createAppHost(
				{ role: "server", databasePath: ":memory:" },
				createMockRuntime(),
			);
			const serverCaps = await serverHost.admin.getCapabilities() as {
				orchestration: {
					durableJobProcessing: boolean;
					leaseReclaim: boolean;
					maintenanceFacade: boolean;
				};
			};
			expect(serverCaps.orchestration).toBeDefined();
			expect(serverCaps.orchestration.durableJobProcessing).toBe(true);
			expect(serverCaps.orchestration.leaseReclaim).toBe(false);
			expect(serverCaps.orchestration.maintenanceFacade).toBe(false);
			await serverHost.shutdown();

			const workerHost = await createAppHost(
				{ role: "worker", databasePath: ":memory:" },
				createMockRuntime(),
			);
			const workerCaps = await workerHost.admin.getCapabilities() as {
				orchestration: {
					durableJobProcessing: boolean;
					leaseReclaim: boolean;
					maintenanceFacade: boolean;
				};
			};
			expect(workerCaps.orchestration.durableJobProcessing).toBe(true);
			await workerHost.shutdown();

			const localHost = await createAppHost(
				{ role: "local", databasePath: ":memory:" },
				createMockRuntime(),
			);
			const localCaps = await localHost.admin.getCapabilities() as {
				orchestration: {
					durableJobProcessing: boolean;
					leaseReclaim: boolean;
					maintenanceFacade: boolean;
				};
			};
			expect(localCaps.orchestration.durableJobProcessing).toBe(false);
			await localHost.shutdown();
		} finally {
			restore();
		}
	});

	test("maintenance role has maintenanceFacade capability", async () => {
		const restore = suppressLifecycleSideEffects();
		try {
			const host = await createAppHost(
				{ role: "maintenance", databasePath: ":memory:" },
				createMockRuntime(),
			);
			const caps = await host.admin.getCapabilities() as {
				orchestration: {
					durableJobProcessing: boolean;
					leaseReclaim: boolean;
					maintenanceFacade: boolean;
				};
			};
			expect(caps.orchestration.maintenanceFacade).toBe(true);
			await host.shutdown();
		} finally {
			restore();
		}
	});
});
