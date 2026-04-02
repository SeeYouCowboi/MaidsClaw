import { describe, expect, test } from "bun:test";
import type { AppHostOptions } from "../../../src/app/host/types.js";
import { createAppHost } from "../../../src/app/host/create-app-host.js";
import type { RuntimeBootstrapResult } from "../../../src/bootstrap/types.js";
import { GatewayServer } from "../../../src/gateway/server.js";
import { LeaseReclaimSweeper } from "../../../src/jobs/lease-reclaim-sweeper.js";
import { PgJobRunner } from "../../../src/jobs/pg-runner.js";

function createMockRuntime(): {
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

function patchLifecycleSpies(): {
	getGatewayStartCallCount: () => number;
	getGatewayStopCallCount: () => number;
	getConsumerStartCallCount: () => number;
	getSweeperStartCallCount: () => number;
	getSweeperStopCallCount: () => number;
	restore: () => void;
} {
	let gatewayStartCallCount = 0;
	let gatewayStopCallCount = 0;
	let consumerStartCallCount = 0;
	let sweeperStartCallCount = 0;
	let sweeperStopCallCount = 0;
	let consumerObserved = false;

	const originalGatewayStart = GatewayServer.prototype.start;
	const originalGatewayStop = GatewayServer.prototype.stop;
	const originalConsumerProcessNext = PgJobRunner.prototype.processNext;
	const originalSweeperStart = LeaseReclaimSweeper.prototype.start;
	const originalSweeperStop = LeaseReclaimSweeper.prototype.stop;

	GatewayServer.prototype.start = function patchedGatewayStart() {
		gatewayStartCallCount += 1;
	};
	GatewayServer.prototype.stop = function patchedGatewayStop() {
		gatewayStopCallCount += 1;
	};
	PgJobRunner.prototype.processNext = async function patchedProcessNext() {
		if (!consumerObserved) {
			consumerObserved = true;
			consumerStartCallCount += 1;
		}
		return "none_ready";
	};
	LeaseReclaimSweeper.prototype.start = function patchedSweeperStart() {
		sweeperStartCallCount += 1;
	};
	LeaseReclaimSweeper.prototype.stop = function patchedSweeperStop() {
		sweeperStopCallCount += 1;
	};

	return {
		getGatewayStartCallCount: () => gatewayStartCallCount,
		getGatewayStopCallCount: () => gatewayStopCallCount,
		getConsumerStartCallCount: () => consumerStartCallCount,
		getSweeperStartCallCount: () => sweeperStartCallCount,
		getSweeperStopCallCount: () => sweeperStopCallCount,
		restore: () => {
			GatewayServer.prototype.start = originalGatewayStart;
			GatewayServer.prototype.stop = originalGatewayStop;
			PgJobRunner.prototype.processNext = originalConsumerProcessNext;
			LeaseReclaimSweeper.prototype.start = originalSweeperStart;
			LeaseReclaimSweeper.prototype.stop = originalSweeperStop;
		},
	};
}

describe("createAppHost role boundaries", () => {
	test("server role (non-durable) exposes user facade and gateway only", async () => {
		const { runtime } = createMockRuntime();
		const spies = patchLifecycleSpies();

		try {
			const host = await createAppHost(
				{ role: "server" },
				runtime,
			);

			expect(host.user).toBeDefined();
			expect(host.getBoundPort).toBeDefined();

			await host.start();

			expect(spies.getGatewayStartCallCount()).toBe(1);
			expect(spies.getConsumerStartCallCount()).toBe(0);
			expect(spies.getSweeperStartCallCount()).toBe(0);

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
				},
				runtime,
			);

			await host.start();

			expect(spies.getGatewayStartCallCount()).toBe(1);
			expect(spies.getConsumerStartCallCount()).toBe(1);
			expect(spies.getSweeperStartCallCount()).toBe(1);

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
				{ role: "worker" },
				runtime,
			);

			expect(host.user).toBeUndefined();

			await host.start();

			expect(spies.getConsumerStartCallCount()).toBe(1);
			expect(spies.getSweeperStartCallCount()).toBe(1);
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
				{ role: "local" },
				runtime,
			);

			expect(host.user).toBeDefined();

			await host.start();

			expect(spies.getGatewayStartCallCount()).toBe(0);
			expect(spies.getConsumerStartCallCount()).toBe(0);
			expect(spies.getSweeperStartCallCount()).toBe(0);

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
				{ role: "maintenance" },
				runtime,
			);

			expect(host.maintenance).toBeDefined();

			await host.start();

			expect(spies.getGatewayStartCallCount()).toBe(0);
			expect(spies.getConsumerStartCallCount()).toBe(0);
			expect(spies.getSweeperStartCallCount()).toBe(1);

			await host.shutdown();
		} finally {
			spies.restore();
		}
	});

	test("shutdown is idempotent for all roles", async () => {
		const roleCases: Array<{ name: string; options: AppHostOptions }> = [
			{ name: "server", options: { role: "server" } },
			{
				name: "server durable",
				options: {
					role: "server",
					enableDurableOrchestration: true,
				},
			},
			{ name: "worker", options: { role: "worker" } },
			{ name: "local", options: { role: "local" } },
			{
				name: "maintenance",
				options: { role: "maintenance" },
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
			expect(spies.getSweeperStopCallCount()).toBe(3);
		} finally {
			spies.restore();
		}
	});
});
