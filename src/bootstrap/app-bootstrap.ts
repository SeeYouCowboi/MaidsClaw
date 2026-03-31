import { isAbsolute, join, resolve } from "node:path";
import { createAppHost } from "../app/host/index.js";
import { loadConfig } from "../core/config.js";
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
 * @deprecated Transitional shim — use {@link createAppHost} for new code.
 * Delegates facade/server/lifecycle construction to createAppHost() internally.
 */
export async function bootstrapApp(
	options: AppBootstrapOptions = {},
): Promise<AppBootstrapResult> {
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

	// Delegate facade/server/lifecycle construction to createAppHost(),
	// injecting the already-bootstrapped runtime to avoid double initialization.
	const appHost = await createAppHost(
		{
			role: options.enableGateway ? "server" : "local",
			cwd: options.cwd,
			port,
			host,
			databasePath,
			dataDir,
			busyTimeoutMs: options.busyTimeoutMs,
			memoryMigrationModelId,
			memoryEmbeddingModelId,
			memoryOrganizerEmbeddingModelId,
			traceCaptureEnabled: options.traceCaptureEnabled,
			requireAllProviders: options.requireAllProviders,
		},
		runtime,
	);

	const healthChecks = Object.fromEntries(
		Object.entries(runtime.healthChecks).map(([name, status]) => [
			name,
			() => (status === "error" ? "unavailable" : status),
		]),
	);

	return {
		runtime,
		healthChecks,
		configResult,
		shutdown: () => void appHost.shutdown(),
	};
}
