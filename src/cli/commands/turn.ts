/**
 * CLI `turn send` command.
 *
 * Executes a single turn against a session using the Local Mode transport.
 * Returns a {@link TurnExecutionResult} in the JSON envelope.
 *
 * Silent-private turns (empty assistant_text + private commit) are treated
 * as successful outcomes, NOT failures.
 *
 * `--raw` includes `public_chunks` and `tool_events` in the response
 * but does NOT expose internal `submit_rp_turn` payloads.
 */

import { registerCommand } from "../parser.js";
import type { ParsedArgs } from "../parser.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT_USAGE, EXIT_RUNTIME } from "../errors.js";
import { writeJson, writeText } from "../output.js";

// ── Known flags ──────────────────────────────────────────────────────

const KNOWN_SEND_FLAGS = new Set([
  "session",
  "text",
  "agent",
  "mode",
  "raw",
  "save-trace",
  "json",
  "quiet",
  "cwd",
]);

// ── turn send ────────────────────────────────────────────────────────

async function handleTurnSend(
  ctx: CliContext,
  args: ParsedArgs,
): Promise<void> {
  // Validate flags
  for (const flag of Object.keys(args.flags)) {
    if (!KNOWN_SEND_FLAGS.has(flag)) {
      throw new CliError(
        "UNKNOWN_FLAGS",
        `Unknown flag(s) for "turn send": --${flag}`,
        EXIT_USAGE,
      );
    }
  }

  // Required: --session
  const sessionId = args.flags["session"];
  if (sessionId === undefined) {
    throw new CliError(
      "MISSING_ARGUMENT",
      "turn send requires --session",
      EXIT_USAGE,
    );
  }
  if (typeof sessionId !== "string") {
    throw new CliError(
      "MISSING_FLAG_VALUE",
      "--session requires a value",
      EXIT_USAGE,
    );
  }

  // Required: --text
  const text = args.flags["text"];
  if (text === undefined) {
    throw new CliError(
      "MISSING_ARGUMENT",
      "turn send requires --text",
      EXIT_USAGE,
    );
  }
  if (typeof text !== "string") {
    throw new CliError(
      "MISSING_FLAG_VALUE",
      "--text requires a value",
      EXIT_USAGE,
    );
  }

  // Optional: --agent (override agent from session)
  let agentIdOverride: string | undefined;
  if (args.flags["agent"] !== undefined) {
    if (typeof args.flags["agent"] !== "string") {
      throw new CliError(
        "MISSING_FLAG_VALUE",
        "--agent requires a value",
        EXIT_USAGE,
      );
    }
    agentIdOverride = args.flags["agent"];
  }

  // Optional: --mode (local|gateway) — only local supported for now
  if (args.flags["mode"] !== undefined) {
    if (typeof args.flags["mode"] !== "string") {
      throw new CliError(
        "MISSING_FLAG_VALUE",
        "--mode requires a value",
        EXIT_USAGE,
      );
    }
    if (args.flags["mode"] !== "local" && args.flags["mode"] !== "gateway") {
      throw new CliError(
        "INVALID_FLAG_VALUE",
        `Invalid mode: "${args.flags["mode"]}". Must be "local" or "gateway".`,
        EXIT_USAGE,
      );
    }
    if (args.flags["mode"] === "gateway") {
      throw new CliError(
        "NOT_IMPLEMENTED",
        "Gateway mode is not yet implemented. Use --mode local.",
        EXIT_RUNTIME,
      );
    }
  }

  // Optional: --raw (include public_chunks and tool_events)
  const raw = args.flags["raw"] === true;

  // Optional: --save-trace (enable trace capture)
  const saveTrace = args.flags["save-trace"] === true;

  // Bootstrap runtime
  const { bootstrapApp } = await import("../../bootstrap/app-bootstrap.js");

  let app: ReturnType<typeof bootstrapApp>;
  try {
    app = bootstrapApp({
      cwd: ctx.cwd,
      enableGateway: false,
      requireAllProviders: false,
    });
  } catch (err) {
    throw new CliError(
      "BOOTSTRAP_FAILED",
      `Failed to bootstrap runtime: ${err instanceof Error ? err.message : String(err)}`,
      EXIT_RUNTIME,
    );
  }

  try {
    // Validate session exists and is open
    const session = app.runtime.sessionService.getSession(sessionId);
    if (!session) {
      throw new CliError(
        "SESSION_NOT_FOUND",
        `Session not found: ${sessionId}`,
        EXIT_RUNTIME,
      );
    }

    if (session.closedAt !== undefined) {
      throw new CliError(
        "SESSION_CLOSED",
        `Session ${sessionId} is closed. Create a new session or recover this one.`,
        EXIT_RUNTIME,
      );
    }

    // Resolve agent ID: explicit flag > session's agent
    const agentId = agentIdOverride ?? session.agentId;

    // Create LocalRuntime and execute turn
    const { createLocalRuntime } = await import("../local-runtime.js");
    const localRuntime = createLocalRuntime(app.runtime);

    const result = await localRuntime.executeTurn({
      sessionId,
      agentId,
      text,
      saveTrace,
    });

    // Build response data — silent-private turns are OK (not failures)
    const responseData: Record<string, unknown> = {
      session_id: result.session_id,
      request_id: result.request_id,
      assistant_text: result.assistant_text,
      has_public_reply: result.has_public_reply,
      private_commit: result.private_commit,
      recovery_required: result.recovery_required,
    };

    // Include settlement_id when present (RP turns)
    if (result.settlement_id !== undefined) {
      responseData.settlement_id = result.settlement_id;
    }

    // --raw: include public_chunks and tool_events
    // Does NOT expose internal submit_rp_turn payloads
    if (raw) {
      responseData.public_chunks = result.public_chunks;
      responseData.tool_events = result.tool_events;
    }

    if (ctx.json) {
      writeJson({
        ok: true,
        command: "turn send",
        mode: ctx.mode,
        data: responseData,
      });
    } else if (!ctx.quiet) {
      // Text mode output
      if (result.assistant_text) {
        writeText(result.assistant_text);
      } else if (result.private_commit.present) {
        writeText("[silent turn — private commit only]");
      } else {
        writeText("[no output]");
      }

      if (result.recovery_required) {
        writeText("\n⚠ Session requires recovery.");
      }
    }
  } finally {
    app.shutdown();
  }
}

// ── Registration ─────────────────────────────────────────────────────

/**
 * Register `turn send` on the CLI router.
 */
export function registerTurnCommands(): void {
  registerCommand({
    namespace: "turn",
    subcommand: "send",
    handler: handleTurnSend,
  });
}
