#!/usr/bin/env bun
import { createAppHost } from "../src/app/host/create-app-host.js";
import { VERSION } from "../src/index.js";
import { startWithPortCheck } from "../src/utils/port-check.js";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "localhost";

async function main(): Promise<void> {
  const port = parseInt(process.env.MAIDSCLAW_PORT ?? String(DEFAULT_PORT), 10);
  const host = process.env.MAIDSCLAW_HOST ?? DEFAULT_HOST;

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${process.env.MAIDSCLAW_PORT}`);
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[WARN] ANTHROPIC_API_KEY not set. Some features may not work.");
  }
  if (!process.env.OPENAI_API_KEY) {
    console.warn("[WARN] OPENAI_API_KEY not set. Some features may not work.");
  }

  const appHost = await createAppHost({
    role: "server",
    requireAllProviders: false,
    port,
    host,
  });

  await startWithPortCheck(port, () => appHost.start());

  console.log(`MaidsClaw v${VERSION} [dev] started on port ${appHost.getBoundPort!()}`);

  const healthStatus = await appHost.user!.health.checkHealth();
  for (const [name, value] of Object.entries(healthStatus.readyz)) {
    if (name === "status") continue;
    const icon = value === "ok" ? "[OK]" : value === "degraded" ? "[WARN]" : "[ERR]";
    console.log(`   ${icon} ${name}: ${value}`);
  }

  const shutdown = (): void => {
    console.log("\nShutting down gracefully...");
    void appHost.shutdown();
    console.log("Goodbye!");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
