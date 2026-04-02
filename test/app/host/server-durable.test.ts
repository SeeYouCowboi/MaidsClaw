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

describe("createAppHost server durable mode", () => {
	test("starts job consumer in addition to gateway when durable mode is enabled", async () => {
		const { runtime } = createInjectedRuntime();
		let sweeperStartCallCount = 0;
		let consumerStartCallCount = 0;
		let gatewayStartCallCount = 0;
		let consumerObserved = false;

		const originalSweeperStart = LeaseReclaimSweeper.prototype.start;
		const originalProcessNext = PgJobRunner.prototype.processNext;
		const originalGatewayStart = GatewayServer.prototype.start;

		LeaseReclaimSweeper.prototype.start = function patchedSweeperStart() {
			sweeperStartCallCount += 1;
		};
		PgJobRunner.prototype.processNext = async function patchedProcessNext() {
			if (!consumerObserved) {
				consumerObserved = true;
				consumerStartCallCount += 1;
			}
			return "none_ready";
		};
		GatewayServer.prototype.start = function patchedGatewayStart() {
			gatewayStartCallCount += 1;
		};

		try {
			const host = await createAppHost(
				{
					role: "server",
					enableDurableOrchestration: true,
				},
				runtime,
			);

			await host.start();

			expect(gatewayStartCallCount).toBe(1);
			expect(consumerStartCallCount).toBe(1);
			expect(sweeperStartCallCount).toBe(1);

			await host.shutdown();
		} finally {
			LeaseReclaimSweeper.prototype.start = originalSweeperStart;
			PgJobRunner.prototype.processNext = originalProcessNext;
			GatewayServer.prototype.start = originalGatewayStart;
		}
	});

	test("does not start job consumer for default server mode", async () => {
		const { runtime } = createInjectedRuntime();
		let sweeperStartCallCount = 0;
		let consumerStartCallCount = 0;
		let gatewayStartCallCount = 0;

		const originalSweeperStart = LeaseReclaimSweeper.prototype.start;
		const originalProcessNext = PgJobRunner.prototype.processNext;
		const originalGatewayStart = GatewayServer.prototype.start;

		LeaseReclaimSweeper.prototype.start = function patchedSweeperStart() {
			sweeperStartCallCount += 1;
		};
		PgJobRunner.prototype.processNext = async function patchedProcessNext() {
			consumerStartCallCount += 1;
			return "none_ready";
		};
		GatewayServer.prototype.start = function patchedGatewayStart() {
			gatewayStartCallCount += 1;
		};

		try {
			const host = await createAppHost(
				{ role: "server" },
				runtime,
			);

			await host.start();

			expect(gatewayStartCallCount).toBe(1);
			expect(consumerStartCallCount).toBe(0);
			expect(sweeperStartCallCount).toBe(0);
		} finally {
			LeaseReclaimSweeper.prototype.start = originalSweeperStart;
			PgJobRunner.prototype.processNext = originalProcessNext;
			GatewayServer.prototype.start = originalGatewayStart;
		}
	});

	test("stops both gateway and consumer on shutdown when durable mode is enabled", async () => {
		const { runtime, getShutdownCallCount } = createInjectedRuntime();
		let sweeperStopCallCount = 0;
		let gatewayStopCallCount = 0;

		const originalGatewayStart = GatewayServer.prototype.start;
		const originalGatewayStop = GatewayServer.prototype.stop;
		const originalProcessNext = PgJobRunner.prototype.processNext;
		const originalSweeperStart = LeaseReclaimSweeper.prototype.start;
		const originalSweeperStop = LeaseReclaimSweeper.prototype.stop;

		GatewayServer.prototype.start = function patchedGatewayStart() {
			return;
		};
		GatewayServer.prototype.stop = function patchedGatewayStop() {
			gatewayStopCallCount += 1;
		};
		PgJobRunner.prototype.processNext = async function patchedProcessNext() {
			return "none_ready";
		};
		LeaseReclaimSweeper.prototype.start = function patchedSweeperStart() {
			return;
		};
		LeaseReclaimSweeper.prototype.stop = function patchedSweeperStop() {
			sweeperStopCallCount += 1;
		};

		try {
			const host = await createAppHost(
				{
					role: "server",
					enableDurableOrchestration: true,
				},
				runtime,
			);

			await host.start();
			await host.shutdown();
			await host.shutdown();

			expect(gatewayStopCallCount).toBe(1);
			expect(sweeperStopCallCount).toBe(1);
			expect(getShutdownCallCount()).toBe(1);
		} finally {
			GatewayServer.prototype.start = originalGatewayStart;
			GatewayServer.prototype.stop = originalGatewayStop;
			PgJobRunner.prototype.processNext = originalProcessNext;
			LeaseReclaimSweeper.prototype.start = originalSweeperStart;
			LeaseReclaimSweeper.prototype.stop = originalSweeperStop;
		}
	});
});
