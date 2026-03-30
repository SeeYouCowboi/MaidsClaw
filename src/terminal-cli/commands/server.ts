/**
 * CLI `server start` command.
 *
 * Uses `createAppHost({ role: "server" })` for full lifecycle management.
 */

import { registerCommand } from "../parser.js";
import type { ParsedArgs } from "../parser.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT_USAGE, EXIT_RUNTIME } from "../errors.js";
import { writeJson, writeText } from "../output.js";

// ── Known flags ──────────────────────────────────────────────────────

const KNOWN_START_FLAGS = new Set(["host", "port", "debug-capture", "json", "quiet", "cwd"]);

// ── server start handler ─────────────────────────────────────────────

async function handleServerStart(
  ctx: CliContext,
  args: ParsedArgs,
): Promise<void> {
  // Validate flags
  for (const flag of Object.keys(args.flags)) {
    if (!KNOWN_START_FLAGS.has(flag)) {
      throw new CliError(
        "UNKNOWN_FLAGS",
        `Unknown flag(s) for "server start": --${flag}`,
        EXIT_USAGE,
      );
    }
  }

  // Parse --port
  let port: number | undefined;
  if (args.flags["port"] !== undefined && args.flags["port"] !== true) {
    const parsed = Number(args.flags["port"]);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
      throw new CliError(
        "INVALID_FLAG_VALUE",
        `Invalid port: ${String(args.flags["port"])}. Must be 1-65535.`,
        EXIT_USAGE,
      );
    }
    port = parsed;
  } else if (args.flags["port"] === true) {
    throw new CliError(
      "MISSING_FLAG_VALUE",
      "--port requires a numeric value",
      EXIT_USAGE,
    );
  }

  // Parse --host
  let host: string | undefined;
  if (typeof args.flags["host"] === "string") {
    host = args.flags["host"];
  } else if (args.flags["host"] === true) {
    throw new CliError(
      "MISSING_FLAG_VALUE",
      "--host requires a value",
      EXIT_USAGE,
    );
  }

  // Parse --debug-capture (stub for now — trace capture is T15)
  const debugCapture = args.flags["debug-capture"] === true;

  const { createAppHost } = await import("../../app/host/index.js");

  let appHost: Awaited<ReturnType<typeof createAppHost>>;
  try {
    appHost = await createAppHost({
      role: "server",
      cwd: ctx.cwd,
      ...(port !== undefined ? { port } : {}),
      ...(host !== undefined ? { host } : {}),
      traceCaptureEnabled: debugCapture,
    });
  } catch (err) {
    throw new CliError(
      "SERVER_START_FAILED",
      `Failed to start server: ${err instanceof Error ? err.message : String(err)}`,
      EXIT_RUNTIME,
    );
  }

  try {
    await appHost.start();
  } catch (err) {
    await appHost.shutdown();
    throw new CliError(
      "SERVER_START_FAILED",
      `Failed to bind server: ${err instanceof Error ? err.message : String(err)}`,
      EXIT_RUNTIME,
    );
  }

  const boundPort = appHost.getBoundPort!();
  const boundHost = host ?? "localhost";
  const boundAddress = `http://${boundHost}:${boundPort}`;

  const healthStatus = await appHost.user!.health.checkHealth();
  const healthSummary: Record<string, string> = {};
  for (const [key, value] of Object.entries(healthStatus.readyz)) {
    if (value !== undefined) {
      healthSummary[key] = value;
    }
  }

  const pipelineStatus = await appHost.admin.getPipelineStatus();
  const memoryPipelineStatus = pipelineStatus.memoryPipelineStatus;
  const sweeperEnabled = pipelineStatus.memoryPipelineReady;

  const handleSignal = () => {
    if (!ctx.quiet) {
      writeText("\nShutting down...");
    }
    void appHost.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  if (ctx.json) {
    writeJson({
      ok: true,
      command: "server start",
      data: {
        address: boundAddress,
        port: boundPort,
        host: boundHost,
        health: healthSummary,
        memory_pipeline: memoryPipelineStatus,
        sweeper_enabled: sweeperEnabled,
        debug_capture: debugCapture,
      },
    });
  } else if (!ctx.quiet) {
    writeText(`Server listening on ${boundAddress}`);
    writeText("");
    writeText("Health:");
    for (const [name, status] of Object.entries(healthSummary)) {
      writeText(`  ${name}: ${status}`);
    }
    writeText("");
    writeText(`memory_pipeline: ${memoryPipelineStatus}`);
    writeText(`sweeper: ${sweeperEnabled ? "enabled" : "disabled"}`);
    if (debugCapture) {
      writeText("debug_capture: enabled (stub — trace capture not yet implemented)");
    }
  }

  // Keep the process alive — the Bun HTTP server runs in the background.
  // The process will stay alive as long as the server is listening.
  // SIGINT/SIGTERM handlers above will cleanly shut down.
}

// ── Registration ─────────────────────────────────────────────────────

/**
 * Register the `server start` command on the CLI router.
 */
export function registerServerCommands(): void {
  registerCommand({
    namespace: "server",
    subcommand: "start",
    description: "Start the gateway HTTP server",
    handler: handleServerStart,
  });
}
