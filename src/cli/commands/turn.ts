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
import type { ObservationEvent } from "../../app/contracts/execution.js";
import { createAppClientRuntime, type AppClientRuntime } from "../app-client-runtime.js";

// ── Known flags ──────────────────────────────────────────────────────

const KNOWN_SEND_FLAGS = new Set([
  "session",
  "text",
  "agent",
  "mode",
  "base-url",
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

  let mode: "local" | "gateway" = "local";
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
    mode = args.flags["mode"];
  }

  let baseUrl = "http://localhost:3000";
  if (args.flags["base-url"] !== undefined) {
    if (typeof args.flags["base-url"] !== "string") {
      throw new CliError(
        "MISSING_FLAG_VALUE",
        "--base-url requires a value",
        EXIT_USAGE,
      );
    }
    baseUrl = args.flags["base-url"];
  }

  // Optional: --raw (include public_chunks and tool_events)
  const raw = args.flags["raw"] === true;

  // Optional: --save-trace (enable trace capture)
  const saveTrace = args.flags["save-trace"] === true;

  let runtime: AppClientRuntime;
  try {
    runtime = createAppClientRuntime({ mode, cwd: ctx.cwd, baseUrl });
  } catch (err) {
    throw new CliError(
      "BOOTSTRAP_FAILED",
      `Failed to bootstrap runtime: ${err instanceof Error ? err.message : String(err)}`,
      EXIT_RUNTIME,
    );
  }

  try {
    const session = await runtime.clients.session.getSession(sessionId);
    if (!session) {
      throw new CliError(
        "SESSION_NOT_FOUND",
        `Session not found: ${sessionId}`,
        EXIT_RUNTIME,
      );
    }

    if (session.closed_at !== undefined) {
      throw new CliError(
        "SESSION_CLOSED",
        `Session ${sessionId} is closed. Create a new session or recover this one.`,
        EXIT_RUNTIME,
      );
    }

    const requestId = crypto.randomUUID();
    const assistantParts: string[] = [];
    const publicChunks: ObservationEvent[] = [];
    const toolEvents: ObservationEvent[] = [];
    let turnError: string | undefined;

    for await (const event of runtime.clients.turn.streamTurn({
      sessionId,
      text,
      ...(agentIdOverride ?? session.agent_id ? { agentId: agentIdOverride ?? session.agent_id } : {}),
      requestId,
      saveTrace,
    })) {
      publicChunks.push(event);
      if (event.type === "text_delta") {
        assistantParts.push(event.text);
      }
      if (isToolEvent(event)) {
        toolEvents.push(event);
      }
      if (event.type === "error") {
        turnError = event.message;
      }
    }

    if (turnError) {
      throw new CliError("TURN_STREAM_FAILED", turnError, EXIT_RUNTIME);
    }

    const summary = await runtime.clients.inspect.getSummary(requestId);
    const responseData: Record<string, unknown> = {
      session_id: summary.session_id ?? sessionId,
      request_id: requestId,
      assistant_text: assistantParts.join(""),
      has_public_reply: summary.has_public_reply,
      private_commit: {
        present: summary.private_commit_count > 0,
        op_count: summary.private_commit_count,
        kinds: summary.settlement.private_commit_kinds ?? [],
      },
      recovery_required: summary.recovery_required,
      ...(summary.settlement.settlement_id
        ? { settlement_id: summary.settlement.settlement_id }
        : {}),
    };

    if (raw) {
      responseData.public_chunks = publicChunks;
      responseData.tool_events = toolEvents;
    }

    if (ctx.json) {
      writeJson({
        ok: true,
        command: "turn send",
        mode,
        data: responseData,
      });
    } else if (!ctx.quiet) {
      const assistantText = typeof responseData.assistant_text === "string"
        ? responseData.assistant_text
        : "";
      const privateCommit = responseData.private_commit as {
        present: boolean;
      };
      if (assistantText) {
        writeText(assistantText);
      } else if (privateCommit.present) {
        writeText("[silent turn — private commit only]");
      } else {
        writeText("[no output]");
      }
      if (summary.recovery_required) {
        writeText("\n⚠ Session requires recovery.");
      }
    }
  } finally {
    runtime.shutdown();
  }
}

function isToolEvent(event: ObservationEvent): boolean {
  return (
    event.type === "tool_use_start"
    || event.type === "tool_use_delta"
    || event.type === "tool_use_end"
    || event.type === "tool_execution_result"
    || event.type === "tool_call"
    || event.type === "tool_result"
  );
}

// ── Registration ─────────────────────────────────────────────────────

/**
 * Register `turn send` on the CLI router.
 */
export function registerTurnCommands(): void {
  registerCommand({
    namespace: "turn",
    subcommand: "send",
    description: "Send a user message and get a response",
    handler: handleTurnSend,
  });
}
