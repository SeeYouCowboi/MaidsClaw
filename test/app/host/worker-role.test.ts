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
		backendType: "pg",
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
		shutdown: () => {
			shutdownCallCount += 1;
		},
	} as unknown as RuntimeBootstrapResult;

	return {
		runtime,
		getShutdownCallCount: () => shutdownCallCount,
	};
}

describe("createAppHost worker role", () => {
	test("starts durable consumer on start and stops it on shutdown", async () => {
		const { runtime, getShutdownCallCount } = createInjectedRuntime();
		let schedulerStartCallCount = 0;
		let schedulerStopCallCount = 0;
		let dispatcherStartCallCount = 0;
		let gatewayStartCallCount = 0;

		const originalSchedulerStart = JobScheduler.prototype.start;
		const originalSchedulerStop = JobScheduler.prototype.stop;
		const originalDispatcherStart = JobDispatcher.prototype.start;
		const originalGatewayStart = GatewayServer.prototype.start;

		JobScheduler.prototype.start = function patchedSchedulerStart(...args) {
			schedulerStartCallCount += 1;
			return originalSchedulerStart.apply(this, args);
		};
		JobScheduler.prototype.stop = function patchedSchedulerStop(...args) {
			schedulerStopCallCount += 1;
			return originalSchedulerStop.apply(this, args);
		};
		JobDispatcher.prototype.start = function patchedDispatcherStart(...args) {
			dispatcherStartCallCount += 1;
			return originalDispatcherStart.apply(this, args);
		};
		GatewayServer.prototype.start = function patchedGatewayStart(...args) {
			gatewayStartCallCount += 1;
			return originalGatewayStart.apply(this, args);
		};

		try {
			const host = await createAppHost(
				{ role: "worker" },
				runtime,
			);

			expect(host.user).toBeUndefined();
			const getBoundPort = host.getBoundPort;
			expect(getBoundPort).toBeDefined();
			if (!getBoundPort) {
				throw new Error("Expected app host to expose getBoundPort");
			}
			expect(() => getBoundPort()).toThrow(
				"getBoundPort is only available for server role",
			);

			await host.start();

			expect(dispatcherStartCallCount).toBe(1);
			expect(schedulerStartCallCount).toBe(1);
			expect(gatewayStartCallCount).toBe(0);

			await host.shutdown();
			await host.shutdown();

			expect(schedulerStopCallCount).toBe(1);
			expect(getShutdownCallCount()).toBe(1);
		} finally {
			JobScheduler.prototype.start = originalSchedulerStart;
			JobScheduler.prototype.stop = originalSchedulerStop;
			JobDispatcher.prototype.start = originalDispatcherStart;
			GatewayServer.prototype.start = originalGatewayStart;
		}
	});
});
