import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CliContext } from "../context.js";
import {
	createAppClientRuntime,
	type AppClientRuntime,
} from "../app-client-runtime.js";
import { CliError, EXIT_RUNTIME, EXIT_USAGE } from "../errors.js";
import { resolveContext } from "../inspect/context-resolver.js";
import { renderJson, renderText } from "../inspect/renderers.js";
import { writeJson, writeText } from "../output.js";
import { type ParsedArgs, registerCommand } from "../parser.js";

const KNOWN_SUMMARY_FLAGS = new Set(["request", "mode", "base-url", "json", "quiet", "cwd"]);
const KNOWN_TRANSCRIPT_FLAGS = new Set(["session", "raw", "mode", "base-url", "json", "quiet", "cwd"]);
const KNOWN_PROMPT_FLAGS = new Set(["request", "sections", "mode", "base-url", "json", "quiet", "cwd"]);
const KNOWN_CHUNKS_FLAGS = new Set(["request", "mode", "base-url", "json", "quiet", "cwd"]);

const KNOWN_LOGS_FLAGS = new Set([
	"request",
	"session",
	"agent",
	"mode",
	"base-url",
	"json",
	"quiet",
	"cwd",
]);
const KNOWN_MEMORY_FLAGS = new Set([
	"session",
	"agent",
	"mode",
	"base-url",
	"json",
	"quiet",
	"cwd",
]);
const KNOWN_TRACE_FLAGS = new Set([
	"request",
	"output",
	"out",
	"unsafe-raw",
	"mode",
	"base-url",
	"json",
	"quiet",
	"cwd",
]);
const KNOWN_DIAGNOSE_FLAGS = new Set(["request", "mode", "base-url", "json", "quiet", "cwd"]);

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

function getOptionalStringFlag(
	args: ParsedArgs,
	flagName: string,
): string | undefined {
	const value = args.flags[flagName];
	if (value === undefined) {
		return undefined;
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

function requireStringFlag(
	args: ParsedArgs,
	flagName: string,
	commandName: string,
): string {
	const value = getOptionalStringFlag(args, flagName);
	if (!value) {
		throw new CliError(
			"MISSING_ARGUMENT",
			`${commandName} requires --${flagName}`,
			EXIT_USAGE,
		);
	}
	return value;
}

function resolveModeAndBaseUrl(
	ctx: CliContext,
	args: ParsedArgs,
): { mode: "local" | "gateway"; baseUrl: string } {
	const modeRaw = args.flags["mode"];
	let mode: "local" | "gateway" = ctx.mode;
	if (modeRaw !== undefined) {
		if (typeof modeRaw !== "string") {
			throw new CliError("MISSING_FLAG_VALUE", "--mode requires a value", EXIT_USAGE);
		}
		if (modeRaw !== "local" && modeRaw !== "gateway") {
			throw new CliError(
				"INVALID_FLAG_VALUE",
				`Invalid mode: "${modeRaw}". Must be "local" or "gateway".`,
				EXIT_USAGE,
			);
		}
		mode = modeRaw;
	}

	const baseUrlRaw = args.flags["base-url"];
	if (baseUrlRaw === true) {
		throw new CliError("MISSING_FLAG_VALUE", "--base-url requires a value", EXIT_USAGE);
	}

	return {
		mode,
		baseUrl: typeof baseUrlRaw === "string" ? baseUrlRaw : "http://localhost:3000",
	};
}

function toCliError(err: unknown): CliError {
	if (err instanceof CliError) {
		return err;
	}

	if (err instanceof Error) {
		if (err.message === "INSPECT_REQUEST_ID_REQUIRED") {
			return new CliError(
				"MISSING_ARGUMENT",
				"This command requires --request <request_id>",
				EXIT_USAGE,
			);
		}
		if (err.message === "INSPECT_SESSION_ID_REQUIRED") {
			return new CliError(
				"MISSING_ARGUMENT",
				"This command requires --session <session_id>",
				EXIT_USAGE,
			);
		}
		if (err.message === "INSPECT_UNSAFE_RAW_LOCAL_ONLY") {
			return new CliError(
				"UNSAFE_RAW_LOCAL_ONLY",
				"--unsafe-raw is only allowed in local mode",
				EXIT_USAGE,
			);
		}

		return new CliError("DEBUG_COMMAND_FAILED", err.message, EXIT_RUNTIME);
	}

	return new CliError("DEBUG_COMMAND_FAILED", String(err), EXIT_RUNTIME);
}

async function openClientRuntime(
	ctx: CliContext,
	mode: "local" | "gateway",
	baseUrl: string,
): Promise<AppClientRuntime> {
	try {
		return await createAppClientRuntime({
			mode,
			cwd: ctx.cwd,
			baseUrl,
		});
	} catch (err) {
		throw new CliError(
			"BOOTSTRAP_FAILED",
			`Failed to bootstrap runtime: ${err instanceof Error ? err.message : String(err)}`,
			EXIT_RUNTIME,
		);
	}
}

async function withClientRuntime<T>(
	ctx: CliContext,
	mode: "local" | "gateway",
	baseUrl: string,
	work: (runtime: AppClientRuntime) => Promise<T>,
): Promise<T> {
	const runtime = await openClientRuntime(ctx, mode, baseUrl);
	try {
		return await work(runtime);
	} finally {
		runtime.shutdown();
	}
}

// ── debug summary ───────────────────────────────────────────────────

async function handleDebugSummary(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	validateFlags(KNOWN_SUMMARY_FLAGS, args, "debug summary");
	const requestId = requireStringFlag(args, "request", "debug summary");
	const { mode, baseUrl } = resolveModeAndBaseUrl(ctx, args);
	const view = await withClientRuntime(ctx, mode, baseUrl, (runtime) =>
		runtime.clients.inspect.getSummary(requestId));

	if (ctx.json) {
		writeJson({ ok: true, command: "debug summary", mode, data: view });
	} else if (!ctx.quiet) {
		writeText(renderText(view));
	}
}

// ── debug transcript ────────────────────────────────────────────────

async function handleDebugTranscript(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	validateFlags(KNOWN_TRANSCRIPT_FLAGS, args, "debug transcript");
	const sessionId = requireStringFlag(args, "session", "debug transcript");
	const raw = args.flags["raw"] === true;
	const { mode, baseUrl } = resolveModeAndBaseUrl(ctx, args);
	const view = await withClientRuntime(ctx, mode, baseUrl, (runtime) =>
		runtime.clients.inspect.getTranscript(sessionId, raw));

	if (ctx.json) {
		writeJson({ ok: true, command: "debug transcript", mode, data: view });
	} else if (!ctx.quiet) {
		writeText(renderText(view));
	}
}

// ── debug prompt ────────────────────────────────────────────────────

async function handleDebugPrompt(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	validateFlags(KNOWN_PROMPT_FLAGS, args, "debug prompt");
	const requestId = requireStringFlag(args, "request", "debug prompt");
	const sections = args.flags["sections"] === true;
	const { mode, baseUrl } = resolveModeAndBaseUrl(ctx, args);
	const view = await withClientRuntime(ctx, mode, baseUrl, (runtime) =>
		runtime.clients.inspect.getPrompt(requestId));

	const outputView = sections
		? view
		: { ...view, sections: undefined };

	if (ctx.json) {
		writeJson({ ok: true, command: "debug prompt", mode, data: outputView });
	} else if (!ctx.quiet) {
		writeText(renderText(view));
	}
}

// ── debug chunks ────────────────────────────────────────────────────

async function handleDebugChunks(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	validateFlags(KNOWN_CHUNKS_FLAGS, args, "debug chunks");
	const requestId = requireStringFlag(args, "request", "debug chunks");
	const { mode, baseUrl } = resolveModeAndBaseUrl(ctx, args);
	const view = await withClientRuntime(ctx, mode, baseUrl, (runtime) =>
		runtime.clients.inspect.getChunks(requestId));

	if (ctx.json) {
		writeJson({ ok: true, command: "debug chunks", mode, data: view });
	} else if (!ctx.quiet) {
		writeText(renderText(view));
	}
}

async function handleDebugLogs(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	validateFlags(KNOWN_LOGS_FLAGS, args, "debug logs");
	const { mode, baseUrl } = resolveModeAndBaseUrl(ctx, args);
	const resolved = resolveContext(ctx, args);
	const view = await withClientRuntime(ctx, mode, baseUrl, (runtime) =>
		runtime.clients.inspect.getLogs({
			requestId: resolved.requestId,
			sessionId: resolved.sessionId,
			agentId: resolved.agentId,
		}));

	if (ctx.json) {
		writeJson({ ok: true, command: "debug logs", mode, data: view });
	} else if (!ctx.quiet) {
		writeText(renderText(view));
	}
}

async function handleDebugMemory(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	validateFlags(KNOWN_MEMORY_FLAGS, args, "debug memory");
	const { mode, baseUrl } = resolveModeAndBaseUrl(ctx, args);
	const resolved = resolveContext(ctx, args);
	if (!resolved.sessionId) {
		throw new Error("INSPECT_SESSION_ID_REQUIRED");
	}
	const view = await withClientRuntime(ctx, mode, baseUrl, (runtime) =>
		runtime.clients.inspect.getMemory(
			resolved.sessionId!,
			resolved.agentId,
		));

	if (ctx.json) {
		writeJson({
			ok: true,
			command: "debug memory",
			mode,
			data: view,
		});
	} else if (!ctx.quiet) {
		writeText(renderText(view));
	}
}

async function handleDebugTrace(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	if (args.positional[0] !== "export") {
		throw new CliError(
			"UNKNOWN_SUBCOMMAND",
			"debug trace requires subcommand 'export'",
			EXIT_USAGE,
		);
	}

	const childArgs: ParsedArgs = {
		positional: args.positional.slice(1),
		flags: args.flags,
	};
	validateFlags(KNOWN_TRACE_FLAGS, childArgs, "debug trace export");

	const requestId = requireStringFlag(
		childArgs,
		"request",
		"debug trace export",
	);
	const output =
		getOptionalStringFlag(childArgs, "output") ??
		getOptionalStringFlag(childArgs, "out");
	const unsafeRaw = childArgs.flags["unsafe-raw"] === true;
	const { mode, baseUrl } = resolveModeAndBaseUrl(ctx, childArgs);
	const view = await withClientRuntime(ctx, mode, baseUrl, (runtime) =>
		runtime.clients.inspect.getTrace(requestId, { unsafeRaw }));

	if (output) {
		const outputPath = resolve(ctx.cwd, output);
		mkdirSync(dirname(outputPath), { recursive: true });
		writeFileSync(outputPath, `${renderJson(view.bundle)}\n`, "utf8");

		if (ctx.json) {
			writeJson({
				ok: true,
				command: "debug trace export",
				mode,
				data: {
					request_id: requestId,
					unsafe_raw_settlement_mode: view.unsafe_raw_settlement_mode,
					output: outputPath,
				},
			});
		} else if (!ctx.quiet) {
			writeText(outputPath);
		}
		return;
	}

	if (ctx.json) {
		writeJson({
			ok: true,
			command: "debug trace export",
			mode,
			data: view.bundle,
		});
	} else if (!ctx.quiet) {
		writeText(renderJson(view.bundle));
	}
}

async function handleDebugDiagnose(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	validateFlags(KNOWN_DIAGNOSE_FLAGS, args, "debug diagnose");
	const { mode, baseUrl } = resolveModeAndBaseUrl(ctx, args);
	const requestId = requireStringFlag(args, "request", "debug diagnose");
	const entry = await withClientRuntime(ctx, mode, baseUrl, (runtime) =>
		runtime.clients.inspect.diagnose(requestId));

	if (ctx.json) {
		writeJson({
			ok: true,
			command: "debug diagnose",
			mode,
			data: entry,
		});
	} else if (!ctx.quiet) {
		writeText(renderText(entry));
	}
}

export function registerDebugCommands(): void {
	registerCommand({
		namespace: "debug",
		subcommand: "summary",
		description: "Show turn summary for a session",
		handler: async (ctx, args) => {
			try {
				await handleDebugSummary(ctx, args);
			} catch (err) {
				throw toCliError(err);
			}
		},
	});

	registerCommand({
		namespace: "debug",
		subcommand: "transcript",
		description: "Show full transcript for a session",
		handler: async (ctx, args) => {
			try {
				await handleDebugTranscript(ctx, args);
			} catch (err) {
				throw toCliError(err);
			}
		},
	});

	registerCommand({
		namespace: "debug",
		subcommand: "prompt",
		description: "Show rendered prompt for a turn",
		handler: async (ctx, args) => {
			try {
				await handleDebugPrompt(ctx, args);
			} catch (err) {
				throw toCliError(err);
			}
		},
	});

	registerCommand({
		namespace: "debug",
		subcommand: "chunks",
		description: "Show raw model chunks for a turn",
		handler: async (ctx, args) => {
			try {
				await handleDebugChunks(ctx, args);
			} catch (err) {
				throw toCliError(err);
			}
		},
	});

	registerCommand({
		namespace: "debug",
		subcommand: "logs",
		description: "Show diagnostic logs",
		handler: async (ctx, args) => {
			try {
				await handleDebugLogs(ctx, args);
			} catch (err) {
				throw toCliError(err);
			}
		},
	});

	registerCommand({
		namespace: "debug",
		subcommand: "memory",
		description: "Inspect memory graph data",
		handler: async (ctx, args) => {
			try {
				await handleDebugMemory(ctx, args);
			} catch (err) {
				throw toCliError(err);
			}
		},
	});

	registerCommand({
		namespace: "debug",
		subcommand: "trace",
		description: "Show execution trace for a turn",
		handler: async (ctx, args) => {
			try {
				await handleDebugTrace(ctx, args);
			} catch (err) {
				throw toCliError(err);
			}
		},
	});

	registerCommand({
		namespace: "debug",
		subcommand: "diagnose",
		description: "Run diagnostic catalog checks",
		handler: async (ctx, args) => {
			try {
				await handleDebugDiagnose(ctx, args);
			} catch (err) {
				throw toCliError(err);
			}
		},
	});
}
