#!/usr/bin/env bun
/**
 * MaidsClaw V1 — Development Startup Script
 *
 * Starts the GatewayServer with configuration from environment variables.
 * Gracefully handles missing API keys for development purposes.
 */

import { GatewayServer } from "../src/gateway/server.js";
import { SessionService } from "../src/session/service.js";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "localhost";

async function main(): Promise<void> {
  // Load configuration from environment with fallbacks
  const port = parseInt(process.env.MAIDSCLAW_PORT ?? String(DEFAULT_PORT), 10);
  const host = process.env.MAIDSCLAW_HOST ?? DEFAULT_HOST;

  // Validate port
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${process.env.MAIDSCLAW_PORT}`);
    process.exit(1);
  }

  // Warn about missing API keys (but don't crash in dev mode)
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠️  ANTHROPIC_API_KEY not set. Some features may not work.");
  }
  if (!process.env.OPENAI_API_KEY) {
    console.warn("⚠️  OPENAI_API_KEY not set. Some features may not work.");
  }

  // Create session service
  const sessionService = new SessionService();

  // Create and start the gateway server
  const server = new GatewayServer({
    port,
    host,
    sessionService,
  });

  server.start();

  console.log(`✅ MaidsClaw V1 server started on port ${server.getPort()}`);

  // Graceful shutdown handlers
  const shutdown = (): void => {
    console.log("\n🛑 Shutting down gracefully...");
    server.stop();
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
