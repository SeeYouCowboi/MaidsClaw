/**
 * CLI `chat` command — interactive Local Mode REPL + Inspect session shell.
 *
 * `maidsclaw chat --agent <agent_id> [--session <session_id>] [--mode local|gateway] [--base-url <url>] [--save-trace]`
 *
 * This is the ONLY interactive command. It MUST NOT support `--json`.
 * If no `--session` is provided, a new session is auto-created.
 */

import { createGatewayAppClients } from "../../app/clients/app-clients.js";
import { createAppHost } from "../../app/host/index.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT_RUNTIME, EXIT_USAGE } from "../errors.js";
import { GatewayClient } from "../gateway-client.js";
import { writeText } from "../output.js";
import { type ParsedArgs, registerCommand } from "../parser.js";
import { SessionShell } from "../shell/session-shell.js";
import { createShellState } from "../shell/state.js";

// ── Known flags ──────────────────────────────────────────────────────

const KNOWN_CHAT_FLAGS = new Set([
	"agent",
	"session",
	"mode",
	"base-url",
	"save-trace",
	// Global flags that may appear
	"json",
	"quiet",
	"cwd",
]);

// ── chat handler ─────────────────────────────────────────────────────

async function handleChat(ctx: CliContext, args: ParsedArgs): Promise<void> {
	// chat MUST NOT support --json
	if (ctx.json) {
		throw new CliError(
			"INVALID_FLAG",
			"chat command does not support --json mode",
			EXIT_USAGE,
		);
	}

	// Validate flags
	for (const flag of Object.keys(args.flags)) {
		if (!KNOWN_CHAT_FLAGS.has(flag)) {
			throw new CliError(
				"UNKNOWN_FLAGS",
				`Unknown flag(s) for "chat": --${flag}`,
				EXIT_USAGE,
			);
		}
	}

	// Required: --agent
	const agentId = args.flags.agent;
	if (agentId === undefined) {
		throw new CliError(
			"MISSING_ARGUMENT",
			"chat requires --agent <agent_id>",
			EXIT_USAGE,
		);
	}
	if (typeof agentId !== "string") {
		throw new CliError(
			"MISSING_FLAG_VALUE",
			"--agent requires a value",
			EXIT_USAGE,
		);
	}

	// Optional: --session
	let sessionId: string | undefined;
	if (args.flags.session !== undefined) {
		if (typeof args.flags.session !== "string") {
			throw new CliError(
				"MISSING_FLAG_VALUE",
				"--session requires a value",
				EXIT_USAGE,
			);
		}
		sessionId = args.flags.session;
	}

	// Optional: --mode
	let mode: "local" | "gateway" = "local";
	if (args.flags.mode !== undefined) {
		if (typeof args.flags.mode !== "string") {
			throw new CliError(
				"MISSING_FLAG_VALUE",
				"--mode requires a value",
				EXIT_USAGE,
			);
		}
		if (args.flags.mode !== "local" && args.flags.mode !== "gateway") {
			throw new CliError(
				"INVALID_FLAG_VALUE",
				`Invalid mode: "${args.flags.mode}". Must be "local" or "gateway".`,
				EXIT_USAGE,
			);
		}
		mode = args.flags.mode as "local" | "gateway";
	}

	// Optional: --base-url
	let baseUrl: string | undefined;
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

	// Optional: --save-trace
	const saveTrace = args.flags["save-trace"] === true;

	if (mode === "gateway") {
		const gatewayBaseUrl = baseUrl ?? "http://localhost:3000";
		const client = new GatewayClient(gatewayBaseUrl);
		const facade = createGatewayAppClients(gatewayBaseUrl);
		if (!sessionId) {
			const created = await client.createSession(agentId);
			sessionId = created.session_id;
		}

		if (!ctx.quiet) {
			writeText(`MaidsClaw Chat — session ${sessionId} — agent ${agentId}`);
			writeText("Type a message to chat, or /help for slash commands.\n");
		}

		const state = createShellState({
			sessionId,
			agentId,
			mode,
			baseUrl,
		});

		const shell = new SessionShell(state, facade, {
			saveTrace,
			gatewayClient: client,
		});
		await shell.run();

		if (!ctx.quiet) {
			writeText("\nGoodbye.");
		}
		return;
	}

	const host = await createAppHost({
		role: "local",
		cwd: ctx.cwd,
		requireAllProviders: false,
	});
	if (!host.user) {
		throw new CliError(
			"BOOTSTRAP_FAILED",
			"Failed to create local app user facade",
			EXIT_RUNTIME,
		);
	}

	try {
		// Auto-create session if not provided
		if (!sessionId) {
			const record = await host.user.session.createSession(agentId);
			sessionId = record.session_id;
		} else {
			// Validate provided session exists
			const session = await host.user.session.getSession(sessionId);
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
		}

		// Welcome message
		if (!ctx.quiet) {
			writeText(`MaidsClaw Chat — session ${sessionId} — agent ${agentId}`);
			writeText("Type a message to chat, or /help for slash commands.\n");
		}

		// Create shell state and start REPL
		const state = createShellState({
			sessionId,
			agentId,
			mode,
			baseUrl,
		});

		const shell = new SessionShell(state, host.user, { saveTrace });
		await shell.run();

		if (!ctx.quiet) {
			writeText("\nGoodbye.");
		}
	} finally {
		await host.shutdown();
	}
}

// ── Registration ─────────────────────────────────────────────────────

/**
 * Register `chat` on the CLI router.
 */
export function registerChatCommand(): void {
	registerCommand({
		namespace: "chat",
		description: "Start an interactive chat session",
		handler: handleChat,
	});
}
