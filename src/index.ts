import { bootstrapRuntime } from "./bootstrap/runtime.js";
import { loadConfig } from "./core/config.js";
import { GatewayServer } from "./gateway/server.js";

export const VERSION = "0.1.0";

export function version(): string {
  return VERSION;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "localhost";

async function main(): Promise<void> {
  // Load config permissively — does not require both providers
  const configResult = loadConfig({ requireAllProviders: false });

  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let databasePath: string | undefined;
  let dataDir: string | undefined;
  let memoryMigrationModelId: string | undefined;
  let memoryEmbeddingModelId: string | undefined;
  let memoryOrganizerEmbeddingModelId: string | undefined;

  if (configResult.ok) {
    const config = configResult.config;
    port = config.server.port;
    host = config.server.host;
    databasePath = config.storage.databasePath;
    dataDir = config.storage.dataDir;
    memoryMigrationModelId = config.memory?.migrationChatModelId;
    memoryEmbeddingModelId = config.memory?.embeddingModelId;
    memoryOrganizerEmbeddingModelId = config.memory?.organizerEmbeddingModelId;
  } else {
    console.warn("Config loading encountered errors, using defaults:", configResult.errors);
  }

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }

  const runtime = bootstrapRuntime({
    databasePath,
    dataDir,
    memoryMigrationModelId,
    memoryEmbeddingModelId,
    memoryOrganizerEmbeddingModelId,
  });

  const healthChecks = Object.fromEntries(
    Object.entries(runtime.healthChecks).map(([name, status]) => [
      name,
      () => (status === "error" ? "unavailable" : status),
    ])
  );

  const server = new GatewayServer({
    port,
    host,
    sessionService: runtime.sessionService,
    createAgentLoop: runtime.createAgentLoop,
    turnService: runtime.turnService,
    healthChecks,
  });

  server.start();

  console.log(`MaidsClaw v${VERSION} started on port ${server.getPort()}`);

  const shutdown = (): void => {
    console.log("Shutting down...");
    server.stop();
    runtime.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}
