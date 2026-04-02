import { describe, expect, test } from "bun:test";
import type { RuntimeBootstrapResult } from "../../../src/bootstrap/types.js";
import { createAppHost } from "../../../src/app/host/create-app-host.js";
import { GatewayServer } from "../../../src/gateway/server.js";
import { LeaseReclaimSweeper } from "../../../src/jobs/lease-reclaim-sweeper.js";
import { PgJobRunner } from "../../../src/jobs/pg-runner.js";

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
				claimNext: async () => ({ outcome: "none_ready" as const }),
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
		let sweeperStartCallCount = 0;
		let sweeperStopCallCount = 0;
		let consumerStartCallCount = 0;
		let gatewayStartCallCount = 0;
		let consumerObserved = false;

		const originalSweeperStart = LeaseReclaimSweeper.prototype.start;
		const originalSweeperStop = LeaseReclaimSweeper.prototype.stop;
		const originalProcessNext = PgJobRunner.prototype.processNext;
		const originalGatewayStart = GatewayServer.prototype.start;

		LeaseReclaimSweeper.prototype.start = function patchedSweeperStart() {
			sweeperStartCallCount += 1;
		};
		LeaseReclaimSweeper.prototype.stop = function patchedSweeperStop() {
			sweeperStopCallCount += 1;
		};
		PgJobRunner.prototype.processNext = async function patchedProcessNext() {
			if (!consumerObserved) {
				consumerObserved = true;
				consumerStartCallCount += 1;
			}
			return "none_ready";
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

			expect(consumerStartCallCount).toBe(1);
			expect(sweeperStartCallCount).toBe(1);
			expect(gatewayStartCallCount).toBe(0);

			await host.shutdown();
			await host.shutdown();

			expect(sweeperStopCallCount).toBe(1);
			expect(getShutdownCallCount()).toBe(1);
		} finally {
			LeaseReclaimSweeper.prototype.start = originalSweeperStart;
			LeaseReclaimSweeper.prototype.stop = originalSweeperStop;
			PgJobRunner.prototype.processNext = originalProcessNext;
			GatewayServer.prototype.start = originalGatewayStart;
		}
	});
});
