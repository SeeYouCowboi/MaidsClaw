/**
 * CLI `health` command.
 *
 * Fetches `/healthz` and `/readyz` from a running MaidsClaw server
 * and displays subsystem status.
 */

import { registerCommand } from "../parser.js";
import type { ParsedArgs } from "../parser.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT_USAGE, EXIT_RUNTIME } from "../errors.js";
import { writeJson, writeText } from "../output.js";

// ── Types ────────────────────────────────────────────────────────────

type HealthzResponse = {
  status: string;
};

type ReadyzResponse = {
  status: string;
  storage?: string;
  models?: string;
  tools?: string;
  memory_pipeline?: string;
  [key: string]: string | undefined;
};

// ── Known flags ──────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "http://localhost:3000";
const KNOWN_HEALTH_FLAGS = new Set(["base-url", "json", "quiet", "cwd"]);

// ── health handler ───────────────────────────────────────────────────

async function handleHealth(
  ctx: CliContext,
  args: ParsedArgs,
): Promise<void> {
  // Validate flags
  for (const flag of Object.keys(args.flags)) {
    if (!KNOWN_HEALTH_FLAGS.has(flag)) {
      throw new CliError(
        "UNKNOWN_FLAGS",
        `Unknown flag(s) for "health": --${flag}`,
        EXIT_USAGE,
      );
    }
  }

  // Parse --base-url
  let baseUrl = DEFAULT_BASE_URL;
  if (typeof args.flags["base-url"] === "string") {
    baseUrl = args.flags["base-url"];
  } else if (args.flags["base-url"] === true) {
    throw new CliError(
      "MISSING_FLAG_VALUE",
      "--base-url requires a URL value",
      EXIT_USAGE,
    );
  }

  // Strip trailing slash
  baseUrl = baseUrl.replace(/\/+$/, "");

  // Fetch both endpoints
  let healthzBody: HealthzResponse;
  let readyzBody: ReadyzResponse;

  try {
    const [healthzRes, readyzRes] = await Promise.all([
      fetch(`${baseUrl}/healthz`),
      fetch(`${baseUrl}/readyz`),
    ]);

    healthzBody = (await healthzRes.json()) as HealthzResponse;
    readyzBody = (await readyzRes.json()) as ReadyzResponse;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    throw new CliError(
      "CONNECTION_FAILED",
      `Failed to connect to server at ${baseUrl}: ${message}`,
      EXIT_RUNTIME,
    );
  }

  // Output
  if (ctx.json) {
    writeJson({
      ok: true,
      command: "health",
      data: {
        healthz: healthzBody,
        readyz: readyzBody,
      },
    });
  } else if (!ctx.quiet) {
    // Healthz overall status
    writeText(`healthz: ${healthzBody.status}`);
    writeText("");

    // Readyz per-subsystem
    writeText(`readyz: ${readyzBody.status}`);

    // Print each known subsystem separately
    const knownSubsystems = ["storage", "models", "tools", "memory_pipeline"];
    for (const key of knownSubsystems) {
      if (readyzBody[key] !== undefined) {
        writeText(`  ${key}: ${readyzBody[key]}`);
      }
    }

    // Print any additional subsystems not in the known list
    for (const [key, value] of Object.entries(readyzBody)) {
      if (key === "status") continue;
      if (knownSubsystems.includes(key)) continue;
      writeText(`  ${key}: ${value}`);
    }
  }
}

// ── Registration ─────────────────────────────────────────────────────

/**
 * Register the `health` command on the CLI router.
 */
export function registerHealthCommand(): void {
  registerCommand({
    namespace: "health",
    description: "Check runtime health status",
    handler: handleHealth,
  });
}
