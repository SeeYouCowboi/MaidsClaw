import { createAppHost } from "./app/host/index.js";

export const VERSION = "0.1.0";

export function version(): string {
  return VERSION;
}

async function main(): Promise<void> {
  const host = await createAppHost({
    role: "server",
    requireAllProviders: false,
  });

  await host.start();

  console.log(`MaidsClaw v${VERSION} started on port ${host.getBoundPort!()}`);

  const shutdown = (): void => {
    console.log("Shutting down...");
    void host.shutdown();
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
