import { isAbsolute, join, resolve } from "node:path";
import { LocalHealthClient } from "../app/clients/local/local-health-client.js";
import { LocalInspectClient } from "../app/clients/local/local-inspect-client.js";
import { LocalSessionClient } from "../app/clients/local/local-session-client.js";
import { LocalTurnClient } from "../app/clients/local/local-turn-client.js";
import { TraceStore } from "../app/diagnostics/trace-store.js";
import { loadConfig } from "../core/config.js";
import { GatewayServer } from "../gateway/server.js";
import { bootstrapRuntime } from "./runtime.js";
import type { AppBootstrapOptions, AppBootstrapResult } from "./types.js";

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

function resolveConfigDir(options: AppBootstrapOptions): string | undefined {
	if (options.configDir) {
		return resolveRootedPath(options.configDir, options.cwd);
	}

	if (options.cwd) {
		return join(resolve(options.cwd), "config");
	}

	return undefined;
}

/**
 * @deprecated Transitional shim while bootstrap callers migrate to createAppHost().
 * createAppHost() is the canonical host factory and should be preferred for new code.
 */
export function bootstrapApp(
	options: AppBootstrapOptions = {},
): AppBootstrapResult {
	// TODO: Replace direct call with createAppHost() delegation — T5 shim
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

	const userFacade = {
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
	};

	const server = options.enableGateway
		? new GatewayServer({
				port,
				host,
				userFacade,
				healthChecks,
				listRuntimeAgents: async () => runtime.agentRegistry.getAll(),
				traceStore: runtime.traceStore,
			})
		: undefined;

	const shutdown = (): void => {
		server?.stop();
		runtime.shutdown();
	};

	return {
		runtime,
		server,
		healthChecks,
		configResult,
		shutdown,
	};
}
