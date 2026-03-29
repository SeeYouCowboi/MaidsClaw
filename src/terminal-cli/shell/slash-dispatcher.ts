import type { RuntimeBootstrapResult } from "../../bootstrap/types.js";
import { diagnose } from "../../app/diagnostics/diagnose-service.js";
import { GatewayClient } from "../gateway-client.js";
import type { InspectContext } from "../inspect/context-resolver.js";
import { renderJson, renderText } from "../inspect/renderers.js";
import {
	loadChunksView,
	loadLogsView,
	loadMemoryView,
	loadPromptView,
	loadSummaryView,
	loadTraceView,
	loadTranscriptView,
	type InspectViewLoadParams,
} from "../../app/inspect/view-models.js";
import { writeText } from "../output.js";
import type { ShellState } from "./state.js";

export type SlashDispatchResult = {
	exit: boolean;
};

export type SlashDispatchContext = {
	state: ShellState;
	runtime?: RuntimeBootstrapResult;
	gatewayClient?: GatewayClient;
};

export async function dispatchSlashCommand(
	line: string,
	ctx: SlashDispatchContext,
): Promise<SlashDispatchResult> {
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

function buildInspectContext(state: ShellState, args: string[]): InspectContext {
	const context: InspectContext = {
		sessionId: state.sessionId,
		agentId: state.agentId,
	};

	const reqIdx = args.indexOf("--request");
	if (reqIdx !== -1 && reqIdx + 1 < args.length) {
		context.requestId = args[reqIdx + 1];
	} else if (state.lastRequestId) {
		context.requestId = state.lastRequestId;
	}

	return context;
}

function buildViewParams(ctx: SlashDispatchContext, args: string[]): InspectViewLoadParams {
	if (!ctx.runtime) {
		throw new Error("Local runtime is unavailable");
	}

	return {
		runtime: ctx.runtime,
		traceStore: ctx.runtime.traceStore,
		context: buildInspectContext(ctx.state, args),
		raw: ctx.state.rawMode,
		mode: ctx.state.mode,
	};
}

function requireRequestId(state: ShellState, commandName: string): boolean {
	if (state.lastRequestId) {
		return true;
	}
	writeText(
		`No request context available for ${commandName}. Send a message first, or use ${commandName} --request <id>.`,
	);
	return false;
}

function requireGatewayClient(ctx: SlashDispatchContext): GatewayClient {
	if (!ctx.gatewayClient) {
		throw new Error("Gateway client is unavailable");
	}
	return ctx.gatewayClient;
}

function requireRuntime(ctx: SlashDispatchContext): RuntimeBootstrapResult {
	if (!ctx.runtime) {
		throw new Error("Local runtime is unavailable");
	}
	return ctx.runtime;
}

async function handleSummary(ctx: SlashDispatchContext, args: string[]): Promise<SlashDispatchResult> {
	const inspectCtx = buildInspectContext(ctx.state, args);
	if (!inspectCtx.requestId && !requireRequestId(ctx.state, "/summary")) {
		return { exit: false };
	}

	try {
		if (ctx.state.mode === "gateway") {
			const view = await requireGatewayClient(ctx).getSummary(inspectCtx.requestId!);
			writeText(renderText(view));
		} else {
			writeText(renderText(await loadSummaryView(buildViewParams(ctx, args))));
		}
	} catch (err) {
		writeText(`Error loading summary: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

async function handleTranscript(ctx: SlashDispatchContext, args: string[]): Promise<SlashDispatchResult> {
	try {
		if (ctx.state.mode === "gateway") {
			const view = await requireGatewayClient(ctx).getTranscript(ctx.state.sessionId, ctx.state.rawMode);
			writeText(renderText(view));
		} else {
			writeText(renderText(await loadTranscriptView(buildViewParams(ctx, args))));
		}
	} catch (err) {
		writeText(`Error loading transcript: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

async function handlePrompt(ctx: SlashDispatchContext, args: string[]): Promise<SlashDispatchResult> {
	const inspectCtx = buildInspectContext(ctx.state, args);
	if (!inspectCtx.requestId && !requireRequestId(ctx.state, "/prompt")) {
		return { exit: false };
	}

	try {
		if (ctx.state.mode === "gateway") {
			const view = await requireGatewayClient(ctx).getPrompt(inspectCtx.requestId!);
			writeText(renderText(view));
		} else {
			writeText(renderText(await loadPromptView(buildViewParams(ctx, args))));
		}
	} catch (err) {
		writeText(`Error loading prompt: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

async function handleChunks(ctx: SlashDispatchContext, args: string[]): Promise<SlashDispatchResult> {
	const inspectCtx = buildInspectContext(ctx.state, args);
	if (!inspectCtx.requestId && !requireRequestId(ctx.state, "/chunks")) {
		return { exit: false };
	}

	try {
		if (ctx.state.mode === "gateway") {
			const view = await requireGatewayClient(ctx).getChunks(inspectCtx.requestId!);
			writeText(renderText(view));
		} else {
			writeText(renderText(await loadChunksView(buildViewParams(ctx, args))));
		}
	} catch (err) {
		writeText(`Error loading chunks: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

async function handleLogs(ctx: SlashDispatchContext, args: string[]): Promise<SlashDispatchResult> {
	try {
		if (ctx.state.mode === "gateway") {
			const inspectCtx = buildInspectContext(ctx.state, args);
			const view = await requireGatewayClient(ctx).getLogs({
				requestId: inspectCtx.requestId,
				sessionId: inspectCtx.sessionId,
				agentId: inspectCtx.agentId,
			});
			writeText(renderText(view));
		} else {
			writeText(renderText(await loadLogsView(buildViewParams(ctx, args))));
		}
	} catch (err) {
		writeText(`Error loading logs: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

async function handleMemory(ctx: SlashDispatchContext, args: string[]): Promise<SlashDispatchResult> {
	try {
		if (ctx.state.mode === "gateway") {
			const inspectCtx = buildInspectContext(ctx.state, args);
			const view = await requireGatewayClient(ctx).getMemory(
				inspectCtx.sessionId ?? ctx.state.sessionId,
				inspectCtx.agentId,
			);
			writeText(renderText(view));
		} else {
			writeText(renderText(await loadMemoryView(buildViewParams(ctx, args))));
		}
	} catch (err) {
		writeText(`Error loading memory: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

async function handleDiagnose(ctx: SlashDispatchContext, args: string[]): Promise<SlashDispatchResult> {
	const inspectCtx = buildInspectContext(ctx.state, args);
	if (!inspectCtx.requestId && !requireRequestId(ctx.state, "/diagnose")) {
		return { exit: false };
	}

	try {
		if (ctx.state.mode === "gateway") {
			const entry = await requireGatewayClient(ctx).diagnose(inspectCtx.requestId!);
			writeText(renderText(entry));
		} else {
			const runtime = requireRuntime(ctx);
			const entry = await diagnose({
				runtime,
				traceStore: runtime.traceStore,
				context: inspectCtx,
			});
			writeText(renderText(entry));
		}
	} catch (err) {
		writeText(`Error running diagnose: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

async function handleTrace(ctx: SlashDispatchContext, args: string[]): Promise<SlashDispatchResult> {
	const inspectCtx = buildInspectContext(ctx.state, args);
	if (!inspectCtx.requestId && !requireRequestId(ctx.state, "/trace")) {
		return { exit: false };
	}

	try {
		if (ctx.state.mode === "gateway") {
			const view = await requireGatewayClient(ctx).getTrace(inspectCtx.requestId!);
			writeText(renderJson(view));
		} else {
			writeText(renderJson(await loadTraceView(buildViewParams(ctx, args), false)));
		}
	} catch (err) {
		writeText(`Error loading trace: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

async function handleRaw(ctx: SlashDispatchContext, args: string[]): Promise<SlashDispatchResult> {
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

async function handleRecover(ctx: SlashDispatchContext): Promise<SlashDispatchResult> {
	try {
		if (ctx.state.mode === "gateway") {
			await requireGatewayClient(ctx).recoverSession(ctx.state.sessionId);
			writeText(`Session ${ctx.state.sessionId} recovered (partial output not canonized).`);
		} else {
			const runtime = requireRuntime(ctx);
			if (!runtime.sessionService.requiresRecovery(ctx.state.sessionId)) {
				writeText(`Session ${ctx.state.sessionId} is not in recovery state.`);
				return { exit: false };
			}
			runtime.sessionService.clearRecoveryRequired(ctx.state.sessionId);
			writeText(`Session ${ctx.state.sessionId} recovered (partial output not canonized).`);
		}
	} catch (err) {
		writeText(`Error recovering session: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

async function handleClose(ctx: SlashDispatchContext): Promise<SlashDispatchResult> {
	try {
		if (ctx.state.mode === "gateway") {
			const closed = await requireGatewayClient(ctx).closeSession(ctx.state.sessionId);
			writeText(`Session ${closed.session_id} closed at ${closed.closed_at}.`);
		} else {
			const runtime = requireRuntime(ctx);
			const closed = runtime.sessionService.closeSession(ctx.state.sessionId);
			writeText(`Session ${closed.sessionId} closed at ${closed.closedAt}.`);
		}
		writeText("Exiting shell.");
		return { exit: true };
	} catch (err) {
		writeText(`Error closing session: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { exit: false };
}

async function handleMode(ctx: SlashDispatchContext, args: string[]): Promise<SlashDispatchResult> {
	const nextMode = args[0]?.toLowerCase();
	if (nextMode === "local") {
		ctx.state.mode = "local";
		writeText("Mode: local");
	} else if (nextMode === "gateway") {
		ctx.state.mode = "gateway";
		writeText("Mode: gateway");
	} else {
		writeText(`Current mode: ${ctx.state.mode}`);
		writeText("Usage: /mode local|gateway");
	}
	return { exit: false };
}

async function handleHelp(): Promise<SlashDispatchResult> {
	writeText([
		"Available slash commands:",
		"  /summary, /inspect    - View summary for last request",
		"  /transcript           - View session transcript",
		"  /prompt               - View prompt for last request",
		"  /chunks               - View public chunks for last request",
		"  /logs                 - View logs for session/request",
		"  /memory               - View memory state for session",
		"  /diagnose             - Run diagnostic for last request",
		"  /trace                - Export trace for last request",
		"  /raw on|off           - Toggle raw observation mode",
		"  /recover              - Recover current session",
		"  /close                - Close session and exit",
		"  /mode local|gateway   - Switch operating mode",
		"  /exit, /quit          - Exit shell",
		"  /help                 - Show this help",
		"",
		"Inspect commands accept --request <id> to override the implicit last request.",
	].join("\n"));
	return { exit: false };
}
