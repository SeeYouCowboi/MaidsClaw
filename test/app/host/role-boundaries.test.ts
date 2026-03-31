import { describe, expect, test } from "bun:test";
import type { AppHostOptions } from "../../../src/app/host/types.js";
import { createAppHost } from "../../../src/app/host/create-app-host.js";
import type { RuntimeBootstrapResult } from "../../../src/bootstrap/types.js";
import { GatewayServer } from "../../../src/gateway/server.js";
import { JobDispatcher } from "../../../src/jobs/dispatcher.js";
import { JobScheduler } from "../../../src/jobs/scheduler.js";

function createMockRuntime(): {
	runtime: RuntimeBootstrapResult;
	getShutdownCallCount: () => number;
} {
	let shutdownCallCount = 0;

	const runtime = {
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
		shutdown: () => {
			shutdownCallCount += 1;
		},
	} as unknown as RuntimeBootstrapResult;

	return {
		runtime,
		getShutdownCallCount: () => shutdownCallCount,
	};
}

function patchLifecycleSpies(): {
	getGatewayStartCallCount: () => number;
	getGatewayStopCallCount: () => number;
	getDispatcherStartCallCount: () => number;
	getSchedulerStartCallCount: () => number;
	getSchedulerStopCallCount: () => number;
	restore: () => void;
} {
	let gatewayStartCallCount = 0;
	let gatewayStopCallCount = 0;
	let dispatcherStartCallCount = 0;
	let schedulerStartCallCount = 0;
	let schedulerStopCallCount = 0;

	const originalGatewayStart = GatewayServer.prototype.start;
	const originalGatewayStop = GatewayServer.prototype.stop;
	const originalDispatcherStart = JobDispatcher.prototype.start;
	const originalSchedulerStart = JobScheduler.prototype.start;
	const originalSchedulerStop = JobScheduler.prototype.stop;

	GatewayServer.prototype.start = function patchedGatewayStart() {
		gatewayStartCallCount += 1;
	};
	GatewayServer.prototype.stop = function patchedGatewayStop() {
		gatewayStopCallCount += 1;
	};
	JobDispatcher.prototype.start = async function patchedDispatcherStart() {
		dispatcherStartCallCount += 1;
	};
	JobScheduler.prototype.start = function patchedSchedulerStart() {
		schedulerStartCallCount += 1;
	};
	JobScheduler.prototype.stop = function patchedSchedulerStop() {
		schedulerStopCallCount += 1;
	};

	return {
		getGatewayStartCallCount: () => gatewayStartCallCount,
		getGatewayStopCallCount: () => gatewayStopCallCount,
		getDispatcherStartCallCount: () => dispatcherStartCallCount,
		getSchedulerStartCallCount: () => schedulerStartCallCount,
		getSchedulerStopCallCount: () => schedulerStopCallCount,
		restore: () => {
			GatewayServer.prototype.start = originalGatewayStart;
			GatewayServer.prototype.stop = originalGatewayStop;
			JobDispatcher.prototype.start = originalDispatcherStart;
			JobScheduler.prototype.start = originalSchedulerStart;
			JobScheduler.prototype.stop = originalSchedulerStop;
		},
	};
}

describe("createAppHost role boundaries", () => {
	test("server role (non-durable) exposes user facade and gateway only", async () => {
		const { runtime } = createMockRuntime();
		const spies = patchLifecycleSpies();

		try {
			const host = await createAppHost(
				{ role: "server", databasePath: ":memory:" },
				runtime,
			);

			expect(host.user).toBeDefined();
			expect(host.getBoundPort).toBeDefined();

			await host.start();

			expect(spies.getGatewayStartCallCount()).toBe(1);
			expect(spies.getDispatcherStartCallCount()).toBe(0);
			expect(spies.getSchedulerStartCallCount()).toBe(0);

			await host.shutdown();
		} finally {
			spies.restore();
		}
	});

	test("server role (durable) starts gateway and consumer", async () => {
		const { runtime } = createMockRuntime();
		const spies = patchLifecycleSpies();

		try {
			const host = await createAppHost(
				{
					role: "server",
					enableDurableOrchestration: true,
					databasePath: ":memory:",
				},
				runtime,
			);

			await host.start();

			expect(spies.getGatewayStartCallCount()).toBe(1);
			expect(spies.getDispatcherStartCallCount()).toBe(1);
			expect(spies.getSchedulerStartCallCount()).toBe(1);

			await host.shutdown();
		} finally {
			spies.restore();
		}
	});

	test("worker role starts consumer only and does not expose user facade", async () => {
		const { runtime } = createMockRuntime();
		const spies = patchLifecycleSpies();

		try {
			const host = await createAppHost(
				{ role: "worker", databasePath: ":memory:" },
				runtime,
			);

			expect(host.user).toBeUndefined();

			await host.start();

			expect(spies.getDispatcherStartCallCount()).toBe(1);
			expect(spies.getSchedulerStartCallCount()).toBe(1);
			expect(spies.getGatewayStartCallCount()).toBe(0);

			await host.shutdown();
		} finally {
			spies.restore();
		}
	});

	test("local role exposes user facade and starts no consumer or gateway", async () => {
		const { runtime } = createMockRuntime();
		const spies = patchLifecycleSpies();

		try {
			const host = await createAppHost(
				{ role: "local", databasePath: ":memory:" },
				runtime,
			);

			expect(host.user).toBeDefined();

			await host.start();

			expect(spies.getGatewayStartCallCount()).toBe(0);
			expect(spies.getDispatcherStartCallCount()).toBe(0);
			expect(spies.getSchedulerStartCallCount()).toBe(0);

			await host.shutdown();
		} finally {
			spies.restore();
		}
	});

	test("maintenance role exposes maintenance facade and does not start gateway", async () => {
		const { runtime } = createMockRuntime();
		const spies = patchLifecycleSpies();

		try {
			const host = await createAppHost(
				{ role: "maintenance", databasePath: ":memory:" },
				runtime,
			);

			expect(host.maintenance).toBeDefined();

			await host.start();

			expect(spies.getGatewayStartCallCount()).toBe(0);
			expect(spies.getDispatcherStartCallCount()).toBe(0);
			expect(spies.getSchedulerStartCallCount()).toBe(0);

			await host.shutdown();
		} finally {
			spies.restore();
		}
	});

	test("shutdown is idempotent for all roles", async () => {
		const roleCases: Array<{ name: string; options: AppHostOptions }> = [
			{ name: "server", options: { role: "server", databasePath: ":memory:" } },
			{
				name: "server durable",
				options: {
					role: "server",
					enableDurableOrchestration: true,
					databasePath: ":memory:",
				},
			},
			{ name: "worker", options: { role: "worker", databasePath: ":memory:" } },
			{ name: "local", options: { role: "local", databasePath: ":memory:" } },
			{
				name: "maintenance",
				options: { role: "maintenance", databasePath: ":memory:" },
			},
		];

		const spies = patchLifecycleSpies();

		try {
			for (const roleCase of roleCases) {
				const { runtime, getShutdownCallCount } = createMockRuntime();
				const host = await createAppHost(roleCase.options, runtime);

				expect(host.role).toBe(roleCase.options.role);

				await host.start();
				await host.shutdown();
				await host.shutdown();

				expect(getShutdownCallCount()).toBe(1);
			}

			expect(spies.getGatewayStopCallCount()).toBe(2);
			expect(spies.getSchedulerStopCallCount()).toBe(2);
		} finally {
			spies.restore();
		}
	});
});
