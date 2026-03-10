#!/usr/bin/env bun
/**
 * MaidsClaw V1 — Development Startup Script
 *
 * Thin wrapper around bootstrapRuntime() with dev-specific defaults.
 * Uses the same functional path as production (src/index.ts).
 */

import { bootstrapRuntime } from "../src/bootstrap/runtime.js";
import { GatewayServer } from "../src/gateway/server.js";
import { VERSION } from "../src/index.js";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "localhost";

async function main(): Promise<void> {
  const port = parseInt(process.env.MAIDSCLAW_PORT ?? String(DEFAULT_PORT), 10);
  const host = process.env.MAIDSCLAW_HOST ?? DEFAULT_HOST;

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${process.env.MAIDSCLAW_PORT}`);
    process.exit(1);
  }

  // Dev-mode warnings for missing API keys
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠️  ANTHROPIC_API_KEY not set. Some features may not work.");
  }
  if (!process.env.OPENAI_API_KEY) {
    console.warn("⚠️  OPENAI_API_KEY not set. Some features may not work.");
  }

  const runtime = bootstrapRuntime();
  const healthChecks = Object.fromEntries(
    Object.entries(runtime.healthChecks).map(([name, status]) => [
      name,
      () => (status === "error" ? "unavailable" : status) as "ok" | "degraded" | "unavailable",
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

  console.log(`✅ MaidsClaw v${VERSION} [dev] started on port ${server.getPort()}`);

  for (const [name, status] of Object.entries(runtime.healthChecks)) {
    const icon = status === "ok" ? "✅" : status === "degraded" ? "⚠️" : "❌";
    console.log(`   ${icon} ${name}: ${status}`);
  }

  const shutdown = (): void => {
    console.log("\n🛑 Shutting down gracefully...");
    server.stop();
    runtime.shutdown();
    console.log("👋 Goodbye!");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
