import { isAbsolute, join, resolve } from "node:path";
import type postgres from "postgres";
import {
	bootstrapRuntime,
	buildGatewayRuntimeContextExtensions,
	initializePgBackendForRuntime,
} from "../../bootstrap/runtime.js";
import type { RuntimeBootstrapResult } from "../../bootstrap/types.js";
import { loadConfig } from "../../core/config.js";
import type { GatewayContext } from "../../gateway/context.js";
import { GatewayServer } from "../../gateway/server.js";
import type { DurableJobStore } from "../../jobs/durable-store.js";
import { LeaseReclaimSweeper } from "../../jobs/lease-reclaim-sweeper.js";
import { PgJobRunner } from "../../jobs/pg-runner.js";
import { createThinkerWorker } from "../../runtime/thinker-worker.js";
import { LocalHealthClient } from "../clients/local/local-health-client.js";
import { LocalInspectClient } from "../clients/local/local-inspect-client.js";
import { LocalSessionClient } from "../clients/local/local-session-client.js";
import { LocalTurnClient } from "../clients/local/local-turn-client.js";
import { TraceStore } from "../diagnostics/trace-store.js";
import { AppMaintenanceFacadeImpl } from "./maintenance-facade.js";
import { MaintenanceOrchestrationService } from "./maintenance-orchestration-service.js";
import type {
	AppHost,
	AppHostAdmin,
	AppHostOptions,
	AppMaintenanceFacade,
} from "./types.js";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "localhost";
const WORKER_POLL_INTERVAL_MS = 25;
const WORKER_LEASE_DURATION_MS = 30_000;

type JobConsumer = {
	start(): Promise<void>;
	stop(): Promise<void>;
};

function createPgJobConsumer(runtime: RuntimeBootstrapResult): JobConsumer {
	const store = (runtime.pgFactory as { store?: unknown } | null)?.store;
	if (!store) {
		throw new Error(
			"PG worker role requires pgFactory.store durable job store",
		);
	}

	const runner = new PgJobRunner(
		store as ConstructorParameters<typeof PgJobRunner>[0],
		{
			workerId: `worker-${process.pid}`,
			leaseDurationMs: WORKER_LEASE_DURATION_MS,
		},
	);

	runner.registerWorker("cognition.thinker", async (job) => {
		const sql = (
			runtime.pgFactory as { getPool?: () => postgres.Sql } | null
		)?.getPool?.();
		if (!sql) {
			throw new Error("T7: pgFactory.getPool() unavailable for Thinker worker");
		}

		const thinkerWorker = createThinkerWorker({
			sql,
			projectionManager: runtime.projectionManager,
			interactionRepo: runtime.interactionRepo,
			recentCognitionSlotRepo: runtime.recentCognitionSlotRepo,
			agentRegistry: runtime.agentRegistry,
			createAgentLoop: runtime.createAgentLoop,
			durableJobStore: store as DurableJobStore,
			jobPersistence: runtime.jobPersistence,
		});

		await thinkerWorker({
			payload: job.payload_json,
		});
	});

	let timer: ReturnType<typeof setInterval> | undefined;
	const MAX_CONCURRENT_TICKS = 4; // Match global thinker concurrency cap
	const activeTickPromises = new Set<Promise<unknown>>();

	const runTick = (): void => {
		if (activeTickPromises.size >= MAX_CONCURRENT_TICKS) {
			return;
		}

		const tickPromise = runner
			.processNext()
			.catch(() => undefined)
			.finally(() => {
				activeTickPromises.delete(tickPromise);
			});
		activeTickPromises.add(tickPromise);
	};

	return {
		async start(): Promise<void> {
			if (timer) {
				return;
			}

			timer = setInterval(runTick, WORKER_POLL_INTERVAL_MS);
			runTick();
		},
		async stop(): Promise<void> {
			if (!timer) {
				return;
			}

			clearInterval(timer);
			timer = undefined;
			if (activeTickPromises.size > 0) {
				await Promise.allSettled([...activeTickPromises]);
			}
		},
	};
}

function createJobConsumer(runtime: RuntimeBootstrapResult): JobConsumer {
	return createPgJobConsumer(runtime);
}

function resolveRootedPath(
	pathValue: string | undefined,
	cwd: string | undefined,
): string | undefined {
	if (!pathValue) {
		return undefined;
	}

	if (!cwd || isAbsolute(pathValue)) {
		return pathValue;
	}

	return resolve(cwd, pathValue);
}

function resolveConfigDir(options: AppHostOptions): string | undefined {
	if (options.configDir) {
		return resolveRootedPath(options.configDir, options.cwd);
	}

	if (options.cwd) {
		return join(resolve(options.cwd), "config");
	}

	return undefined;
}

function shouldExposeMaintenance(options: AppHostOptions): boolean {
	if (options.role === "local") {
		return false;
	}

	if (options.role === "server") {
		return options.enableMaintenance === true;
	}

	return true;
}

/**
 * @param _injectedRuntime @internal Pre-bootstrapped runtime used by the
 *   deprecated {@link bootstrapApp} shim to avoid double-bootstrapping.
 */
export async function createAppHost(
	options: AppHostOptions,
	_injectedRuntime?: RuntimeBootstrapResult,
): Promise<AppHost> {
	const configResult = loadConfig({
		configDir: resolveConfigDir(options),
		cwd: options.cwd,
		requireAllProviders: options.requireAllProviders ?? false,
	});

	let port = DEFAULT_PORT;
	let host = DEFAULT_HOST;
	let dataDir = resolveRootedPath(options.dataDir, options.cwd);
	let memoryMigrationModelId = options.memoryMigrationModelId;
	let memoryEmbeddingModelId = options.memoryEmbeddingModelId;
	let memoryOrganizerEmbeddingModelId = options.memoryOrganizerEmbeddingModelId;

	if (configResult.ok) {
		port = configResult.config.server.port;
		host = configResult.config.server.host;

		if (!dataDir) {
			dataDir = configResult.config.storage.dataDir;
		}

		memoryMigrationModelId ??= configResult.config.memory?.migrationChatModelId;
		memoryEmbeddingModelId ??= configResult.config.memory?.embeddingModelId;
		memoryOrganizerEmbeddingModelId ??=
			configResult.config.memory?.organizerEmbeddingModelId;
	} else {
		console.warn(
			"Config loading encountered errors, using defaults:",
			configResult.errors,
		);
	}

	if (options.port !== undefined) {
		port = options.port;
	}
	if (options.host !== undefined) {
		host = options.host;
	}

	if (Number.isNaN(port) || port < 0 || port > 65535) {
		throw new Error(`Invalid port: ${port}`);
	}

	const strictDurableMode =
		options.role === "worker" || options.enableDurableOrchestration === true;

	const runtime =
		_injectedRuntime ??
		bootstrapRuntime({
			cwd: options.cwd,
			dataDir,
			memoryMigrationModelId,
			memoryEmbeddingModelId,
			memoryOrganizerEmbeddingModelId,
			traceCaptureEnabled: options.traceCaptureEnabled,
			strictDurableMode,
		});

	if (runtime.backendType === "pg") {
		if (options.pgUrl) {
			process.env.PG_APP_URL = options.pgUrl;
		}
		await initializePgBackendForRuntime(runtime);
	}

	const healthChecks = Object.fromEntries(
		Object.entries(runtime.healthChecks).map(([name, status]) => [
			name,
			() => (status === "error" ? "unavailable" : status),
		]),
	);

	const inspectTraceStore =
		runtime.traceStore ??
		(dataDir ? new TraceStore(join(dataDir, "debug", "traces")) : undefined);

	const user =
		options.role === "local" || options.role === "server"
			? {
					session: new LocalSessionClient({
						sessionService: runtime.sessionService,
						turnService: runtime.turnService,
						memoryTaskAgent: runtime.memoryTaskAgent,
					}),
					turn: new LocalTurnClient({
						sessionService: runtime.sessionService,
						turnService: runtime.turnService,
						interactionRepo: runtime.interactionRepo,
						traceStore: runtime.traceStore,
					}),
					inspect: new LocalInspectClient(runtime, inspectTraceStore),
					health: new LocalHealthClient({
						memoryPipelineReady: runtime.memoryPipelineReady,
						healthChecks: runtime.healthChecks,
					}),
				}
			: undefined;

	const isOrchestrated =
		options.role === "worker" ||
		(options.role === "server" && options.enableDurableOrchestration === true);

	const getHostStatus: AppHostAdmin["getHostStatus"] = async () => {
		return {
			backendType: runtime.backendType,
			memoryPipelineStatus: runtime.memoryPipelineStatus,
			migrationStatus: { succeeded: runtime.migrationStatus.succeeded },
			orchestration: {
				enabled: isOrchestrated,
				role: options.role,
				durableMode: options.enableDurableOrchestration ?? false,
				leaseReclaimActive: isOrchestrated && runtime.backendType === "pg",
			},
		};
	};

	const getPipelineStatus: AppHostAdmin["getPipelineStatus"] = async () => {
		return {
			memoryPipelineStatus: runtime.memoryPipelineStatus,
			memoryPipelineReady: runtime.memoryPipelineReady,
			effectiveOrganizerEmbeddingModelId:
				runtime.effectiveOrganizerEmbeddingModelId,
		};
	};

	const listRuntimeAgents: AppHostAdmin["listRuntimeAgents"] = async () => {
		return runtime.agentRegistry.getAll();
	};

	const gatewayContext: GatewayContext = {
		session: user?.session,
		turn: user?.turn,
		inspect: user?.inspect,
		health: user?.health,
		providerCatalog: runtime.providerCatalogService,
		traceStore: runtime.traceStore,
		healthChecks,
		hasAgent: (agentId: string) => runtime.agentRegistry.has(agentId),
		getHostStatus,
		getPipelineStatus,
		listRuntimeAgents,
		...buildGatewayRuntimeContextExtensions(runtime),
	};

	const server =
		options.role === "server"
			? new GatewayServer({
					port,
					host,
					context: gatewayContext,
					authConfigPath: join(resolveConfigDir(options) ?? "config", "auth.json"),
					dataDir,
				})
			: undefined;

	const orchestrationService = shouldExposeMaintenance(options)
		? new MaintenanceOrchestrationService(
				runtime.jobPersistence,
				runtime.backendType,
			)
		: undefined;

	const maintenanceFacade: AppMaintenanceFacade | undefined =
		orchestrationService
			? new AppMaintenanceFacadeImpl(
					orchestrationService,
					runtime.jobPersistence,
				)
			: undefined;

	const admin: AppHostAdmin = {
		getHostStatus,
		getPipelineStatus,
		listRuntimeAgents,
		async getCapabilities() {
			return {
				orchestration: {
					durableJobProcessing:
						options.role === "worker" || options.role === "server",
					leaseReclaim: runtime.backendType === "pg",
					maintenanceFacade: !!maintenance,
				},
			};
		},
	};

	const maintenance = shouldExposeMaintenance(options)
		? maintenanceFacade
		: undefined;
	const workerConsumer =
		options.role === "worker" ? createJobConsumer(runtime) : undefined;
	const serverDurableConsumer =
		options.role === "server" && options.enableDurableOrchestration
			? createJobConsumer(runtime)
			: undefined;
	// Local mode: start a job consumer when talkerThinker is enabled and PG store is available
	const localDurableConsumer = (() => {
		if (options.role !== "local") return undefined;
		const store = (runtime.pgFactory as { store?: DurableJobStore } | null)?.store;
		if (!store) return undefined;
		if (!runtime.talkerThinkerConfig?.enabled) return undefined;
		try {
			return createJobConsumer(runtime);
		} catch {
			return undefined;
		}
	})();
	const shouldRunLeaseReclaimSweeper =
		options.role === "worker" ||
		options.role === "maintenance" ||
		(options.role === "server" && options.enableDurableOrchestration === true);
	const pgStore = (runtime.pgFactory as { store?: DurableJobStore } | null)
		?.store;
	const leaseReclaimSweeper =
		runtime.backendType === "pg" && shouldRunLeaseReclaimSweeper && pgStore
			? new LeaseReclaimSweeper(pgStore)
			: undefined;

	let started = false;
	let stopped = false;

	const start = async (): Promise<void> => {
		if (options.role === "server") {
			server?.start();
			started = true;
			if (serverDurableConsumer) {
				await serverDurableConsumer.start();
				leaseReclaimSweeper?.start();
			}
		} else if (options.role === "worker") {
			await workerConsumer?.start();
			leaseReclaimSweeper?.start();
		} else if (options.role === "maintenance") {
			leaseReclaimSweeper?.start();
		} else if (options.role === "local" && localDurableConsumer) {
			await localDurableConsumer.start();
		}
	};

	const shutdown = async (): Promise<void> => {
		if (stopped) {
			return;
		}
		stopped = true;

		try {
			if (options.role === "server") {
				server?.stop();
				if (serverDurableConsumer) {
					leaseReclaimSweeper?.stop();
					await serverDurableConsumer.stop();
				}
			} else if (options.role === "worker") {
				leaseReclaimSweeper?.stop();
				await workerConsumer?.stop();
			} else if (options.role === "maintenance") {
				leaseReclaimSweeper?.stop();
			} else if (options.role === "local" && localDurableConsumer) {
				await localDurableConsumer.stop();
			}
		} finally {
			runtime.shutdown();
		}
	};

	const hostResult: AppHost = {
		role: options.role,
		user,
		admin,
		maintenance,
		start,
		shutdown,
		getBoundPort: (): number => {
			if (options.role !== "server" || !server) {
				throw new Error("getBoundPort is only available for server role");
			}
			if (!started) {
				throw new Error("Server has not been started");
			}
			return server.getPort();
		},
	};

	// Auto-start local job consumer for thinker-talker mode
	if (localDurableConsumer) {
		await localDurableConsumer.start();
	}

	return hostResult;
}
