import { isAbsolute, join, resolve } from "node:path";
import {
	bootstrapRuntime,
	initializePgBackendForRuntime,
} from "../../bootstrap/runtime.js";
import type { RuntimeBootstrapResult } from "../../bootstrap/types.js";
import { loadConfig } from "../../core/config.js";
import { GatewayServer } from "../../gateway/server.js";
import { JobDedupEngine } from "../../jobs/dedup.js";
import { JobDispatcher } from "../../jobs/dispatcher.js";
import { PgJobRunner } from "../../jobs/pg-runner.js";
import { JobQueue } from "../../jobs/queue.js";
import { JobScheduler } from "../../jobs/scheduler.js";
import { LocalHealthClient } from "../clients/local/local-health-client.js";
import { LocalInspectClient } from "../clients/local/local-inspect-client.js";
import { LocalSessionClient } from "../clients/local/local-session-client.js";
import { LocalTurnClient } from "../clients/local/local-turn-client.js";
import { TraceStore } from "../diagnostics/trace-store.js";
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

function createSqliteJobConsumer(runtime: RuntimeBootstrapResult): JobConsumer {
	const queue = new JobQueue(runtime.jobPersistence);
	const dedup = new JobDedupEngine();
	const dispatcher = new JobDispatcher({
		queue,
		dedup,
		persistence: runtime.jobPersistence,
	});
	const scheduler = new JobScheduler({
		dispatcher,
		intervalMs: WORKER_POLL_INTERVAL_MS,
	});
	let started = false;

	return {
		async start(): Promise<void> {
			if (started) {
				return;
			}
			await dispatcher.start();
			scheduler.start();
			started = true;
		},
		async stop(): Promise<void> {
			if (!started) {
				return;
			}
			scheduler.stop();
			started = false;
		},
	};
}

function createPgJobConsumer(runtime: RuntimeBootstrapResult): JobConsumer {
	const store = (runtime.pgFactory as { store?: unknown } | null)?.store;
	if (!store) {
		throw new Error("PG worker role requires pgFactory.store durable job store");
	}

	const runner = new PgJobRunner(
		store as ConstructorParameters<typeof PgJobRunner>[0],
		{
			workerId: `worker-${process.pid}`,
			leaseDurationMs: WORKER_LEASE_DURATION_MS,
		},
	);

	let timer: ReturnType<typeof setInterval> | undefined;
	let tickPromise: Promise<unknown> | undefined;

	const runTick = (): void => {
		if (tickPromise) {
			return;
		}

		tickPromise = runner
			.processNext()
			.catch(() => undefined)
			.finally(() => {
				tickPromise = undefined;
			});
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
			if (tickPromise) {
				await tickPromise;
			}
		},
	};
}

function createJobConsumer(runtime: RuntimeBootstrapResult): JobConsumer {
	if (runtime.backendType === "sqlite") {
		return createSqliteJobConsumer(runtime);
	}

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
	let databasePath = resolveRootedPath(options.databasePath, options.cwd);
	let dataDir = resolveRootedPath(options.dataDir, options.cwd);
	let memoryMigrationModelId = options.memoryMigrationModelId;
	let memoryEmbeddingModelId = options.memoryEmbeddingModelId;
	let memoryOrganizerEmbeddingModelId = options.memoryOrganizerEmbeddingModelId;

	if (configResult.ok) {
		port = configResult.config.server.port;
		host = configResult.config.server.host;

		if (!databasePath) {
			databasePath = configResult.config.storage.databasePath;
		}
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

	const runtime = _injectedRuntime ?? bootstrapRuntime({
		cwd: options.cwd,
		databasePath,
		dataDir,
		busyTimeoutMs: options.busyTimeoutMs,
		memoryMigrationModelId,
		memoryEmbeddingModelId,
		memoryOrganizerEmbeddingModelId,
		traceCaptureEnabled: options.traceCaptureEnabled,
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
		(dataDir
			? new TraceStore(join(dataDir, "debug", "traces"))
			: undefined);

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

	const server =
		options.role === "server"
			? new GatewayServer({
					port,
					host,
					userFacade: user,
					healthChecks,
					listRuntimeAgents: async () => runtime.agentRegistry.getAll(),
					traceStore: runtime.traceStore,
				})
			: undefined;

	const maintenanceFacade: AppMaintenanceFacade = {
		async runOnce() {
			throw new Error("not yet implemented");
		},
		async drain() {
			throw new Error("not yet implemented");
		},
		async getDrainStatus() {
			throw new Error("not yet implemented");
		},
	};

	const admin: AppHostAdmin = {
		async getHostStatus() {
			return {
				backendType: runtime.backendType,
				memoryPipelineStatus: runtime.memoryPipelineStatus,
				migrationStatus: { succeeded: runtime.migrationStatus.succeeded },
			};
		},
		async getPipelineStatus() {
			return {
				memoryPipelineStatus: runtime.memoryPipelineStatus,
				memoryPipelineReady: runtime.memoryPipelineReady,
				effectiveOrganizerEmbeddingModelId:
					runtime.effectiveOrganizerEmbeddingModelId,
			};
		},
		async listRuntimeAgents() {
			return runtime.agentRegistry.getAll();
		},
		async getCapabilities() {
			return {};
		},
	};

	const maintenance = shouldExposeMaintenance(options)
		? maintenanceFacade
		: undefined;
	const workerConsumer =
		options.role === "worker" ? createJobConsumer(runtime) : undefined;

	let started = false;
	let stopped = false;

	const start = async (): Promise<void> => {
		if (options.role === "server") {
			server?.start();
			started = true;
		} else if (options.role === "worker") {
			await workerConsumer?.start();
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
			} else if (options.role === "worker") {
				await workerConsumer?.stop();
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

	return hostResult;
}
