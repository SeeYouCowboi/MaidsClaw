/**
 * CLI `session` commands: create, close, recover.
 *
 * All commands bootstrap the local runtime, perform the session operation,
 * and shut down. JSON envelopes follow the standard {@link JsonEnvelope} shape.
 */

import { registerCommand } from "../parser.js";
import type { ParsedArgs } from "../parser.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT_USAGE, EXIT_RUNTIME } from "../errors.js";
import { writeJson, writeText } from "../output.js";

// ── Known flags ──────────────────────────────────────────────────────

const KNOWN_CREATE_FLAGS = new Set(["agent", "json", "quiet", "cwd"]);
const KNOWN_CLOSE_FLAGS = new Set(["session", "json", "quiet", "cwd"]);
const KNOWN_RECOVER_FLAGS = new Set(["session", "json", "quiet", "cwd"]);

// ── Flag validation helper ───────────────────────────────────────────

function validateFlags(
  knownFlags: Set<string>,
  args: ParsedArgs,
  commandName: string,
): void {
  for (const flag of Object.keys(args.flags)) {
    if (!knownFlags.has(flag)) {
      throw new CliError(
        "UNKNOWN_FLAGS",
        `Unknown flag(s) for "${commandName}": --${flag}`,
        EXIT_USAGE,
      );
    }
  }
}

// ── Required string flag helper ──────────────────────────────────────

function requireStringFlag(
  args: ParsedArgs,
  flagName: string,
  commandName: string,
): string {
  const value = args.flags[flagName];
  if (value === undefined) {
    throw new CliError(
      "MISSING_ARGUMENT",
      `${commandName} requires --${flagName}`,
      EXIT_USAGE,
    );
  }
  if (typeof value !== "string") {
    throw new CliError(
      "MISSING_FLAG_VALUE",
      `--${flagName} requires a value`,
      EXIT_USAGE,
    );
  }
  return value;
}

// ── session create ───────────────────────────────────────────────────

async function handleSessionCreate(
  ctx: CliContext,
  args: ParsedArgs,
): Promise<void> {
  validateFlags(KNOWN_CREATE_FLAGS, args, "session create");
  const agentId = requireStringFlag(args, "agent", "session create");

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
    const record = app.runtime.sessionService.createSession(agentId);

    if (ctx.json) {
      writeJson({
        ok: true,
        command: "session create",
        mode: ctx.mode,
        data: {
          session_id: record.sessionId,
          agent_id: record.agentId,
          created_at: record.createdAt,
        },
      });
    } else if (!ctx.quiet) {
      writeText(record.sessionId);
    }
  } finally {
    app.shutdown();
  }
}

// ── session close ────────────────────────────────────────────────────

async function handleSessionClose(
  ctx: CliContext,
  args: ParsedArgs,
): Promise<void> {
  validateFlags(KNOWN_CLOSE_FLAGS, args, "session close");
  const sessionId = requireStringFlag(args, "session", "session close");

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
        "SESSION_ALREADY_CLOSED",
        `Session already closed: ${sessionId}`,
        EXIT_RUNTIME,
      );
    }

    const closed = app.runtime.sessionService.closeSession(sessionId);

    // TODO: flush_ran will be determined by actual flush execution in later tasks
    const flushRan = false;

    if (ctx.json) {
      writeJson({
        ok: true,
        command: "session close",
        mode: ctx.mode,
        data: {
          session_id: closed.sessionId,
          closed_at: closed.closedAt,
          flush_ran: flushRan,
        },
      });
    } else if (!ctx.quiet) {
      writeText(`Session ${closed.sessionId} closed at ${closed.closedAt}`);
    }
  } finally {
    app.shutdown();
  }
}

// ── session recover ──────────────────────────────────────────────────

async function handleSessionRecover(
  ctx: CliContext,
  args: ParsedArgs,
): Promise<void> {
  validateFlags(KNOWN_RECOVER_FLAGS, args, "session recover");
  const sessionId = requireStringFlag(args, "session", "session recover");

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
    const session = app.runtime.sessionService.getSession(sessionId);
    if (!session) {
      throw new CliError(
        "SESSION_NOT_FOUND",
        `Session not found: ${sessionId}`,
        EXIT_RUNTIME,
      );
    }

    // MUST NOT silently no-op on non-recovery sessions
    if (!app.runtime.sessionService.requiresRecovery(sessionId)) {
      throw new CliError(
        "NOT_IN_RECOVERY",
        `Session ${sessionId} is not in recovery state. Recovery is only valid for sessions that encountered an error during turn execution.`,
        EXIT_RUNTIME,
      );
    }

    // Clear recovery flag — note: recovery does not canonize partial output
    app.runtime.sessionService.clearRecoveryRequired(sessionId);

    if (ctx.json) {
      writeJson({
        ok: true,
        command: "session recover",
        mode: ctx.mode,
        data: {
          session_id: sessionId,
          recovered: true,
          note: "recovery does not canonize partial output",
        },
      });
    } else if (!ctx.quiet) {
      writeText(`Session ${sessionId} recovered (partial output not canonized)`);
    }
  } finally {
    app.shutdown();
  }
}

// ── Registration ─────────────────────────────────────────────────────

/**
 * Register `session create`, `session close`, `session recover` on the CLI router.
 */
export function registerSessionCommands(): void {
  registerCommand({
    namespace: "session",
    subcommand: "create",
    handler: handleSessionCreate,
  });
  registerCommand({
    namespace: "session",
    subcommand: "close",
    handler: handleSessionClose,
  });
  registerCommand({
    namespace: "session",
    subcommand: "recover",
    handler: handleSessionRecover,
  });
}
