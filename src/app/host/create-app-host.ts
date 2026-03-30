import { isAbsolute, join, resolve } from "node:path";
import { bootstrapRuntime } from "../../bootstrap/runtime.js";
import { loadConfig } from "../../core/config.js";
import { GatewayServer } from "../../gateway/server.js";
import { TraceStore } from "../diagnostics/trace-store.js";
import { createLocalAppClients } from "../clients/app-clients.js";
import type {
	AppHost,
	AppHostAdmin,
	AppHostOptions,
	AppMaintenanceFacade,
} from "./types.js";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "localhost";

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

export async function createAppHost(options: AppHostOptions): Promise<AppHost> {
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

	const runtime = bootstrapRuntime({
		cwd: options.cwd,
		databasePath,
		dataDir,
		busyTimeoutMs: options.busyTimeoutMs,
		memoryMigrationModelId,
		memoryEmbeddingModelId,
		memoryOrganizerEmbeddingModelId,
		traceCaptureEnabled: options.traceCaptureEnabled,
	});

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
			? createLocalAppClients(runtime, { inspectTraceStore })
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

	let started = false;
	let stopped = false;

	const start = async (): Promise<void> => {
		if (options.role === "server") {
			server?.start();
			started = true;
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
