import { bootstrapRuntime } from "./bootstrap/runtime.js";
import { GatewayServer } from "./gateway/server.js";

export const VERSION = "0.1.0";

export function version(): string {
  return VERSION;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "localhost";

async function main(): Promise<void> {
  const port = parseInt(process.env.MAIDSCLAW_PORT ?? String(DEFAULT_PORT), 10);
  const host = process.env.MAIDSCLAW_HOST ?? DEFAULT_HOST;

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${process.env.MAIDSCLAW_PORT}`);
    process.exit(1);
  }

  const runtime = bootstrapRuntime();
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
