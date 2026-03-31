import { describe, expect, test } from "bun:test";
import type { RuntimeBootstrapResult } from "../../../src/bootstrap/types.js";
import { createAppHost } from "../../../src/app/host/create-app-host.js";
import { GatewayServer } from "../../../src/gateway/server.js";
import { JobDispatcher } from "../../../src/jobs/dispatcher.js";
import { JobScheduler } from "../../../src/jobs/scheduler.js";

function createInjectedRuntime(): {
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

describe("createAppHost server durable mode", () => {
	test("starts job consumer in addition to gateway when durable mode is enabled", async () => {
		const { runtime } = createInjectedRuntime();
		let schedulerStartCallCount = 0;
		let dispatcherStartCallCount = 0;
		let gatewayStartCallCount = 0;

		const originalSchedulerStart = JobScheduler.prototype.start;
		const originalDispatcherStart = JobDispatcher.prototype.start;
		const originalGatewayStart = GatewayServer.prototype.start;

		JobScheduler.prototype.start = function patchedSchedulerStart(...args) {
			schedulerStartCallCount += 1;
			return originalSchedulerStart.apply(this, args);
		};
		JobDispatcher.prototype.start = function patchedDispatcherStart(...args) {
			dispatcherStartCallCount += 1;
			return originalDispatcherStart.apply(this, args);
		};
		GatewayServer.prototype.start = function patchedGatewayStart() {
			gatewayStartCallCount += 1;
		};

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

			expect(gatewayStartCallCount).toBe(1);
			expect(dispatcherStartCallCount).toBe(1);
			expect(schedulerStartCallCount).toBe(1);
		} finally {
			JobScheduler.prototype.start = originalSchedulerStart;
			JobDispatcher.prototype.start = originalDispatcherStart;
			GatewayServer.prototype.start = originalGatewayStart;
		}
	});

	test("does not start job consumer for default server mode", async () => {
		const { runtime } = createInjectedRuntime();
		let schedulerStartCallCount = 0;
		let dispatcherStartCallCount = 0;
		let gatewayStartCallCount = 0;

		const originalSchedulerStart = JobScheduler.prototype.start;
		const originalDispatcherStart = JobDispatcher.prototype.start;
		const originalGatewayStart = GatewayServer.prototype.start;

		JobScheduler.prototype.start = function patchedSchedulerStart(...args) {
			schedulerStartCallCount += 1;
			return originalSchedulerStart.apply(this, args);
		};
		JobDispatcher.prototype.start = function patchedDispatcherStart(...args) {
			dispatcherStartCallCount += 1;
			return originalDispatcherStart.apply(this, args);
		};
		GatewayServer.prototype.start = function patchedGatewayStart() {
			gatewayStartCallCount += 1;
		};

		try {
			const host = await createAppHost(
				{ role: "server", databasePath: ":memory:" },
				runtime,
			);

			await host.start();

			expect(gatewayStartCallCount).toBe(1);
			expect(dispatcherStartCallCount).toBe(0);
			expect(schedulerStartCallCount).toBe(0);
		} finally {
			JobScheduler.prototype.start = originalSchedulerStart;
			JobDispatcher.prototype.start = originalDispatcherStart;
			GatewayServer.prototype.start = originalGatewayStart;
		}
	});

	test("stops both gateway and consumer on shutdown when durable mode is enabled", async () => {
		const { runtime, getShutdownCallCount } = createInjectedRuntime();
		let schedulerStopCallCount = 0;
		let gatewayStopCallCount = 0;

		const originalGatewayStart = GatewayServer.prototype.start;
		const originalGatewayStop = GatewayServer.prototype.stop;
		const originalSchedulerStop = JobScheduler.prototype.stop;

		GatewayServer.prototype.start = function patchedGatewayStart() {
			return;
		};
		GatewayServer.prototype.stop = function patchedGatewayStop() {
			gatewayStopCallCount += 1;
		};
		JobScheduler.prototype.stop = function patchedSchedulerStop(...args) {
			schedulerStopCallCount += 1;
			return originalSchedulerStop.apply(this, args);
		};

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
			await host.shutdown();
			await host.shutdown();

			expect(gatewayStopCallCount).toBe(1);
			expect(schedulerStopCallCount).toBe(1);
			expect(getShutdownCallCount()).toBe(1);
		} finally {
			GatewayServer.prototype.start = originalGatewayStart;
			GatewayServer.prototype.stop = originalGatewayStop;
			JobScheduler.prototype.stop = originalSchedulerStop;
		}
	});
});
