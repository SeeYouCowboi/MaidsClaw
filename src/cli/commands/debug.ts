import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { bootstrapApp } from "../../bootstrap/app-bootstrap.js";
import type { CliContext } from "../context.js";
import { diagnose } from "../diagnostic-catalog.js";
import { CliError, EXIT_RUNTIME, EXIT_USAGE } from "../errors.js";
import { resolveContext } from "../inspect/context-resolver.js";
import { renderJson, renderText } from "../inspect/renderers.js";
import {
	loadChunksView,
	loadLogsView,
	loadMemoryView,
	loadPromptView,
	loadSummaryView,
	loadTraceView,
	loadTranscriptView,
} from "../inspect/view-models.js";
import { writeJson, writeText } from "../output.js";
import { type ParsedArgs, registerCommand } from "../parser.js";
import { TraceStore } from "../trace-store.js";

const KNOWN_SUMMARY_FLAGS = new Set(["request", "json", "quiet", "cwd"]);
const KNOWN_TRANSCRIPT_FLAGS = new Set(["session", "raw", "json", "quiet", "cwd"]);
const KNOWN_PROMPT_FLAGS = new Set(["request", "sections", "json", "quiet", "cwd"]);
const KNOWN_CHUNKS_FLAGS = new Set(["request", "json", "quiet", "cwd"]);

const KNOWN_LOGS_FLAGS = new Set([
	"request",
	"session",
	"agent",
	"json",
	"quiet",
	"cwd",
]);
const KNOWN_MEMORY_FLAGS = new Set([
	"session",
	"agent",
	"json",
	"quiet",
	"cwd",
]);
const KNOWN_TRACE_FLAGS = new Set([
	"request",
	"output",
	"out",
	"unsafe-raw",
	"json",
	"quiet",
	"cwd",
]);
const KNOWN_DIAGNOSE_FLAGS = new Set(["request", "json", "quiet", "cwd"]);

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

async function withRuntime<T>(
	ctx: CliContext,
	work: (app: ReturnType<typeof bootstrapApp>) => T,
): Promise<T> {
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
		return work(app);
	} finally {
		app.shutdown();
	}
}

// ── debug summary ───────────────────────────────────────────────────

async function handleDebugSummary(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	validateFlags(KNOWN_SUMMARY_FLAGS, args, "debug summary");
	const requestId = requireStringFlag(args, "request", "debug summary");

	const view = await withRuntime(ctx, (app) => {
		const traceStore =
			app.runtime.traceStore ??
			new TraceStore(resolve(ctx.cwd, "data", "debug", "traces"));
		return loadSummaryView({
			runtime: app.runtime,
			traceStore,
			context: { requestId },
		});
	});

	if (ctx.json) {
		writeJson({ ok: true, command: "debug summary", mode: ctx.mode, data: view });
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

	const view = await withRuntime(ctx, (app) => {
		const traceStore =
			app.runtime.traceStore ??
			new TraceStore(resolve(ctx.cwd, "data", "debug", "traces"));
		return loadTranscriptView({
			runtime: app.runtime,
			traceStore,
			context: { sessionId },
			raw,
			// unsafeRaw intentionally NOT exposed via CLI --raw
			// --raw shows tool/status records but NOT raw settlement payload
		});
	});

	if (ctx.json) {
		writeJson({ ok: true, command: "debug transcript", mode: ctx.mode, data: view });
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

	const view = await withRuntime(ctx, (app) => {
		const traceStore =
			app.runtime.traceStore ??
			new TraceStore(resolve(ctx.cwd, "data", "debug", "traces"));
		return loadPromptView({
			runtime: app.runtime,
			traceStore,
			context: { requestId },
		});
	});

	const outputView = sections
		? view
		: { ...view, sections: undefined };

	if (ctx.json) {
		writeJson({ ok: true, command: "debug prompt", mode: ctx.mode, data: outputView });
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

	const view = await withRuntime(ctx, (app) => {
		const traceStore =
			app.runtime.traceStore ??
			new TraceStore(resolve(ctx.cwd, "data", "debug", "traces"));
		return loadChunksView({
			runtime: app.runtime,
			traceStore,
			context: { requestId },
		});
	});

	if (ctx.json) {
		writeJson({ ok: true, command: "debug chunks", mode: ctx.mode, data: view });
	} else if (!ctx.quiet) {
		writeText(renderText(view));
	}
}

async function handleDebugLogs(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	validateFlags(KNOWN_LOGS_FLAGS, args, "debug logs");

	const view = await withRuntime(ctx, (app) => {
		const traceStore =
			app.runtime.traceStore ??
			new TraceStore(resolve(ctx.cwd, "data", "debug", "traces"));
		return loadLogsView({
			runtime: app.runtime,
			traceStore,
			context: resolveContext(ctx, args),
			mode: ctx.mode,
		});
	});

	if (ctx.json) {
		writeJson({ ok: true, command: "debug logs", mode: ctx.mode, data: view });
	} else if (!ctx.quiet) {
		writeText(renderText(view));
	}
}

async function handleDebugMemory(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	validateFlags(KNOWN_MEMORY_FLAGS, args, "debug memory");

	const view = await withRuntime(ctx, (app) => {
		const traceStore =
			app.runtime.traceStore ??
			new TraceStore(resolve(ctx.cwd, "data", "debug", "traces"));
		return loadMemoryView({
			runtime: app.runtime,
			traceStore,
			context: resolveContext(ctx, args),
			mode: ctx.mode,
		});
	});

	if (ctx.json) {
		writeJson({
			ok: true,
			command: "debug memory",
			mode: ctx.mode,
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

	const view = await withRuntime(ctx, (app) => {
		const traceStore =
			app.runtime.traceStore ??
			new TraceStore(resolve(ctx.cwd, "data", "debug", "traces"));
		return loadTraceView(
			{
				runtime: app.runtime,
				traceStore,
				context: { requestId },
				mode: ctx.mode,
			},
			unsafeRaw,
		);
	});

	if (output) {
		const outputPath = resolve(ctx.cwd, output);
		mkdirSync(dirname(outputPath), { recursive: true });
		writeFileSync(outputPath, `${renderJson(view.bundle)}\n`, "utf8");

		if (ctx.json) {
			writeJson({
				ok: true,
				command: "debug trace export",
				mode: ctx.mode,
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
			mode: ctx.mode,
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

	const entry = await withRuntime(ctx, (app) => {
		const traceStore =
			app.runtime.traceStore ??
			new TraceStore(resolve(ctx.cwd, "data", "debug", "traces"));
		return diagnose({
			runtime: app.runtime,
			traceStore,
			context: resolveContext(ctx, args),
		});
	});

	if (ctx.json) {
		writeJson({
			ok: true,
			command: "debug diagnose",
			mode: ctx.mode,
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
		handler: async (ctx, args) => {
			try {
				await handleDebugDiagnose(ctx, args);
			} catch (err) {
				throw toCliError(err);
			}
		},
	});
}
