import { bootstrapApp } from "./bootstrap/app-bootstrap.js";

export const VERSION = "0.1.0";

export function version(): string {
  return VERSION;
}

async function main(): Promise<void> {
  const app = bootstrapApp({
    enableGateway: true,
    requireAllProviders: false,
  });
  if (!app.server) {
    throw new Error("Gateway server was not initialized");
  }

  app.server.start();

  console.log(`MaidsClaw v${VERSION} started on port ${app.server.getPort()}`);

  const shutdown = (): void => {
    console.log("Shutting down...");
    app.shutdown();
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
