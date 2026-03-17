/**
 * Slash command dispatcher for the interactive chat shell.
 *
 * Routes `/inspect`, `/transcript`, `/prompt`, `/chunks`, `/logs`,
 * `/memory`, `/diagnose`, `/trace`, `/raw`, `/recover`, `/close`,
 * `/mode`, `/exit`, `/quit`, and `/help` to the appropriate handlers.
 *
 * Inspect commands delegate to view models from T16, not shell-only data models.
 */

import type { RuntimeBootstrapResult } from "../../bootstrap/types.js";
import { diagnose } from "../diagnostic-catalog.js";
import type { InspectContext } from "../inspect/context-resolver.js";
import { renderJson, renderText } from "../inspect/renderers.js";
import {
	loadSummaryView,
	loadTranscriptView,
	loadPromptView,
	loadChunksView,
	loadLogsView,
	loadMemoryView,
	loadTraceView,
} from "../inspect/view-models.js";
import type { InspectViewLoadParams } from "../inspect/view-models.js";
import { writeText } from "../output.js";
import type { ShellState } from "./state.js";

// ── Types ─────────────────────────────────────────────────────────────

export type SlashDispatchResult = {
	/** If true, the shell should exit. */
	exit: boolean;
};

export type SlashDispatchContext = {
	state: ShellState;
	runtime: RuntimeBootstrapResult;
};

// ── Dispatcher ────────────────────────────────────────────────────────

/**
 * Dispatch a slash command.
 * @param line — the full input line starting with `/`
 * @returns result indicating whether the shell should exit
 */
export function dispatchSlashCommand(
	line: string,
	ctx: SlashDispatchContext,
): SlashDispatchResult {
	const trimmed = line.trim();
	const parts = trimmed.split(/\s+/);
	const command = parts[0].toLowerCase();
	const args = parts.slice(1);

	switch (command) {
		case "/inspect":
		case "/summary":
			return handleSummary(ctx, args);

		case "/transcript":
			return handleTranscript(ctx, args);

		case "/prompt":
			return handlePrompt(ctx, args);

		case "/chunks":
			return handleChunks(ctx, args);

		case "/logs":
			return handleLogs(ctx, args);

		case "/memory":
			return handleMemory(ctx, args);

		case "/diagnose":
			return handleDiagnose(ctx, args);

		case "/trace":
			return handleTrace(ctx, args);

		case "/raw":
			return handleRaw(ctx, args);

		case "/recover":
			return handleRecover(ctx);

		case "/close":
			return handleClose(ctx);

		case "/mode":
			return handleMode(ctx, args);

		case "/exit":
		case "/quit":
			return { exit: true };

		case "/help":
			return handleHelp();

		default:
			writeText(`Unknown slash command: ${command}. Type /help for available commands.`);
			return { exit: false };
	}
}

// ── Helpers ───────────────────────────────────────────────────────────

function buildInspectContext(state: ShellState, args: string[]): InspectContext {
	const ctx: InspectContext = {
		sessionId: state.sessionId,
		agentId: state.agentId,
	};

	// Allow explicit --request override from args
	const reqIdx = args.indexOf("--request");
	if (reqIdx !== -1 && reqIdx + 1 < args.length) {
		ctx.requestId = args[reqIdx + 1];
	} else if (state.lastRequestId) {
		ctx.requestId = state.lastRequestId;
	}

	return ctx;
}

function buildViewParams(ctx: SlashDispatchContext, args: string[]): InspectViewLoadParams {
	return {
		runtime: ctx.runtime,
		traceStore: ctx.runtime.traceStore,
		context: buildInspectContext(ctx.state, args),
		raw: ctx.state.rawMode,
		mode: ctx.state.mode,
	};
}

function requireLastRequestId(state: ShellState, commandName: string): boolean {
	if (!state.lastRequestId) {
		writeText(
			`No request context available for ${commandName}. ` +
			`Send a message first, or use ${commandName} --request <id>.`,
		);
		return false;
	}
	return true;
}

// ── Slash command handlers ────────────────────────────────────────────

function handleSummary(ctx: SlashDispatchContext, args: string[]): SlashDispatchResult {
	const inspectCtx = buildInspectContext(ctx.state, args);
	if (!inspectCtx.requestId) {
		if (!requireLastRequestId(ctx.state, "/summary")) return { exit: false };
	}

	try {
		const view = loadSummaryView(buildViewParams(ctx, args));
		writeText(renderText(view));
	} catch (err) {
		writeText(`Error loading summary: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

function handleTranscript(ctx: SlashDispatchContext, _args: string[]): SlashDispatchResult {
	try {
		const view = loadTranscriptView(buildViewParams(ctx, _args));
		writeText(renderText(view));
	} catch (err) {
		writeText(`Error loading transcript: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

function handlePrompt(ctx: SlashDispatchContext, args: string[]): SlashDispatchResult {
	const inspectCtx = buildInspectContext(ctx.state, args);
	if (!inspectCtx.requestId) {
		if (!requireLastRequestId(ctx.state, "/prompt")) return { exit: false };
	}

	try {
		const view = loadPromptView(buildViewParams(ctx, args));
		writeText(renderText(view));
	} catch (err) {
		writeText(`Error loading prompt: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

function handleChunks(ctx: SlashDispatchContext, args: string[]): SlashDispatchResult {
	const inspectCtx = buildInspectContext(ctx.state, args);
	if (!inspectCtx.requestId) {
		if (!requireLastRequestId(ctx.state, "/chunks")) return { exit: false };
	}

	try {
		const view = loadChunksView(buildViewParams(ctx, args));
		writeText(renderText(view));
	} catch (err) {
		writeText(`Error loading chunks: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

function handleLogs(ctx: SlashDispatchContext, args: string[]): SlashDispatchResult {
	try {
		const view = loadLogsView(buildViewParams(ctx, args));
		writeText(renderText(view));
	} catch (err) {
		writeText(`Error loading logs: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

function handleMemory(ctx: SlashDispatchContext, args: string[]): SlashDispatchResult {
	try {
		const view = loadMemoryView(buildViewParams(ctx, args));
		writeText(renderText(view));
	} catch (err) {
		writeText(`Error loading memory: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

function handleDiagnose(ctx: SlashDispatchContext, args: string[]): SlashDispatchResult {
	const inspectCtx = buildInspectContext(ctx.state, args);
	if (!inspectCtx.requestId) {
		if (!requireLastRequestId(ctx.state, "/diagnose")) return { exit: false };
	}

	try {
		const entry = diagnose({
			runtime: ctx.runtime,
			traceStore: ctx.runtime.traceStore,
			context: inspectCtx,
		});
		writeText(renderText(entry));
	} catch (err) {
		writeText(`Error running diagnose: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

function handleTrace(ctx: SlashDispatchContext, args: string[]): SlashDispatchResult {
	const inspectCtx = buildInspectContext(ctx.state, args);
	if (!inspectCtx.requestId) {
		if (!requireLastRequestId(ctx.state, "/trace")) return { exit: false };
	}

	try {
		const view = loadTraceView(buildViewParams(ctx, args), false);
		writeText(renderJson(view));
	} catch (err) {
		writeText(`Error loading trace: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

function handleRaw(ctx: SlashDispatchContext, args: string[]): SlashDispatchResult {
	const toggle = args[0]?.toLowerCase();
	if (toggle === "on") {
		ctx.state.rawMode = true;
		writeText("Raw observation mode: ON");
	} else if (toggle === "off") {
		ctx.state.rawMode = false;
		writeText("Raw observation mode: OFF");
	} else {
		writeText(`Raw observation mode: ${ctx.state.rawMode ? "ON" : "OFF"}`);
		writeText("Usage: /raw on|off");
	}
	return { exit: false };
}

function handleRecover(ctx: SlashDispatchContext): SlashDispatchResult {
	try {
		if (!ctx.runtime.sessionService.requiresRecovery(ctx.state.sessionId)) {
			writeText(`Session ${ctx.state.sessionId} is not in recovery state.`);
			return { exit: false };
		}
		ctx.runtime.sessionService.clearRecoveryRequired(ctx.state.sessionId);
		writeText(`Session ${ctx.state.sessionId} recovered (partial output not canonized).`);
	} catch (err) {
		writeText(`Error recovering session: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

function handleClose(ctx: SlashDispatchContext): SlashDispatchResult {
	try {
		const closed = ctx.runtime.sessionService.closeSession(ctx.state.sessionId);
		writeText(`Session ${closed.sessionId} closed at ${closed.closedAt}.`);
		writeText("Exiting shell.");
		return { exit: true };
	} catch (err) {
		writeText(`Error closing session: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

function handleMode(ctx: SlashDispatchContext, args: string[]): SlashDispatchResult {
	const newMode = args[0]?.toLowerCase();
	if (newMode === "local") {
		ctx.state.mode = "local";
		writeText("Mode: local");
	} else if (newMode === "gateway") {
		ctx.state.mode = "gateway";
		writeText("Mode: gateway");
		writeText("Warning: Gateway mode is not yet fully implemented.");
	} else {
		writeText(`Current mode: ${ctx.state.mode}`);
		writeText("Usage: /mode local|gateway");
	}
	return { exit: false };
}

function handleHelp(): SlashDispatchResult {
	const lines = [
		"Available slash commands:",
		"  /summary, /inspect    — View summary for last request",
		"  /transcript           — View session transcript",
		"  /prompt               — View prompt for last request",
		"  /chunks               — View public chunks for last request",
		"  /logs                 — View logs for session/request",
		"  /memory               — View memory state for session",
		"  /diagnose             — Run diagnostic for last request",
		"  /trace                — Export trace for last request",
		"  /raw on|off           — Toggle raw observation mode",
		"  /recover              — Recover current session",
		"  /close                — Close session and exit",
		"  /mode local|gateway   — Switch operating mode",
		"  /exit, /quit          — Exit shell",
		"  /help                 — Show this help",
		"",
		"Inspect commands accept --request <id> to override the implicit last request.",
	];
	writeText(lines.join("\n"));
	return { exit: false };
}
