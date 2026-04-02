/**
 * CLI agent sub-commands.
 *
 * Registers all `agent *` routes:
 *   list, show, create-rp, create-task, enable, disable, remove, validate
 *
 * File-source operations mutate `config/agents.json` through the shared file store.
 * Runtime-source operations boot runtime and inspect registered profiles.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerCommand } from "../parser.js";
import type { ParsedArgs } from "../parser.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT_CONFIG, EXIT_RUNTIME, EXIT_USAGE } from "../errors.js";
import { writeJson, writeText } from "../output.js";
import type { CliDiagnostic } from "../types.js";
import {
	readAgentFile,
	writeAgentFile,
	type AgentFileEntry,
} from "../../app/config/agents/agent-file-store.js";
import {
	validateAgentFile,
	type AgentDiagnostic,
} from "../../app/config/agents/agent-loader.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** Resolve path to config/agents.json from ctx.cwd */
function agentsFilePath(ctx: CliContext): string {
	return join(ctx.cwd, "config", "agents.json");
}

/** Resolve path to config/personas.json from ctx.cwd */
function personasFilePath(ctx: CliContext): string {
	return join(ctx.cwd, "config", "personas.json");
}

/** Read persona IDs from config/personas.json, returns empty array if file missing */
function readPersonaIds(ctx: CliContext): string[] {
	const filePath = personasFilePath(ctx);
	if (!existsSync(filePath)) return [];

	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];

		const ids: string[] = [];
		for (const entry of parsed) {
			if (
				entry &&
				typeof entry === "object" &&
				"id" in entry &&
				typeof (entry as Record<string, unknown>).id === "string"
			) {
				ids.push((entry as Record<string, unknown>).id as string);
			}
		}
		return ids;
	} catch {
		return [];
	}
}

/** Reject unknown flags given a set of known flag names */
function rejectUnknownFlags(
	commandName: string,
	args: ParsedArgs,
	known: ReadonlySet<string>,
): void {
	const unknown = Object.keys(args.flags).filter((f) => !known.has(f));
	if (unknown.length > 0) {
		throw new CliError(
			"UNKNOWN_FLAGS",
			`Unknown flag(s) for "${commandName}": ${unknown.map((f) => `--${f}`).join(", ")}`,
			EXIT_USAGE,
		);
	}
}

/** Convert an AgentFileEntry to a display row */
function entryToRow(entry: AgentFileEntry, source: string) {
	return {
		agent_id: entry.id,
		role: entry.role,
		model_id: entry.modelId ?? "(default)",
		persona_id: entry.personaId ?? "",
		enabled: entry.enabled !== false,
		source,
	};
}

// ── agent list ──────────────────────────────────────────────────────

const LIST_KNOWN_FLAGS = new Set(["source", "json"]);

async function handleAgentList(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	rejectUnknownFlags("agent list", args, LIST_KNOWN_FLAGS);

	const source = (args.flags["source"] as string) || "file";
	if (source !== "file" && source !== "runtime") {
		throw new CliError(
			"INVALID_FLAG_VALUE",
			`--source must be "file" or "runtime", got "${source}"`,
			EXIT_USAGE,
		);
	}

	if (source === "runtime") {
		// Runtime source: bootstrap and list registered agents
		let host: { shutdown(): Promise<void>; admin: { listRuntimeAgents(): Promise<unknown> } } | undefined;
		try {
			const { createAppHost } = await import(
				"../../app/host/index.js"
			);
			host = await createAppHost({
				role: "local",
				cwd: ctx.cwd,
				requireAllProviders: false,
			});

			const agents = await host.admin.listRuntimeAgents() as Array<{ id: string; role: string; modelId?: string; personaId?: string }>;
			const rows = agents.map((a) => ({
				agent_id: a.id,
				role: a.role,
				model_id: a.modelId ?? "(default)",
				persona_id: a.personaId ?? "",
				enabled: true, // runtime agents are always enabled
				source: "runtime",
			}));

			if (ctx.json) {
				writeJson({
					ok: true,
					command: "agent list",
					data: { agents: rows },
				});
			} else if (!ctx.quiet) {
				if (rows.length === 0) {
					writeText("No agents registered in runtime.");
				} else {
					writeText(
						formatTable(
							["agent_id", "role", "model_id", "persona_id", "enabled", "source"],
							rows,
						),
					);
				}
			}
		} finally {
			await host?.shutdown();
		}
		return;
	}

	// File source (default)
	const filePath = agentsFilePath(ctx);
	const entries = readAgentFile(filePath);
	const rows = entries.map((e) => entryToRow(e, "file"));

	if (ctx.json) {
		writeJson({
			ok: true,
			command: "agent list",
			data: { agents: rows },
		});
	} else if (!ctx.quiet) {
		if (rows.length === 0) {
			writeText("No agents found in config/agents.json.");
		} else {
			writeText(
				formatTable(
					["agent_id", "role", "model_id", "persona_id", "enabled", "source"],
					rows,
				),
			);
		}
	}
}

/** Format a simple text table from an array of row objects */
function formatTable(
	columns: string[],
	rows: Record<string, unknown>[],
): string {
	const widths = columns.map((col) =>
		Math.max(col.length, ...rows.map((r) => String(r[col] ?? "").length)),
	);
	const header = columns.map((c, i) => c.padEnd(widths[i]!)).join("  ");
	const sep = widths.map((w) => "-".repeat(w)).join("  ");
	const body = rows
		.map((r) =>
			columns.map((c, i) => String(r[c] ?? "").padEnd(widths[i]!)).join("  "),
		)
		.join("\n");
	return `${header}\n${sep}\n${body}`;
}

// ── agent show ──────────────────────────────────────────────────────

const SHOW_KNOWN_FLAGS = new Set(["source", "json"]);

async function handleAgentShow(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	rejectUnknownFlags("agent show", args, SHOW_KNOWN_FLAGS);

	const agentId = args.positional[0];
	if (!agentId) {
		throw new CliError(
			"MISSING_ARGUMENT",
			'agent show requires <agent_id>',
			EXIT_USAGE,
		);
	}

	const source = (args.flags["source"] as string) || "file";
	if (source !== "file" && source !== "runtime") {
		throw new CliError(
			"INVALID_FLAG_VALUE",
			`--source must be "file" or "runtime", got "${source}"`,
			EXIT_USAGE,
		);
	}

	if (source === "runtime") {
		let host: { shutdown(): Promise<void>; admin: { listRuntimeAgents(): Promise<unknown> } } | undefined;
		try {
			const { createAppHost } = await import(
				"../../app/host/index.js"
			);
			host = await createAppHost({
				role: "local",
				cwd: ctx.cwd,
				requireAllProviders: false,
			});

			const agents = await host.admin.listRuntimeAgents() as Array<{ id: string; toolPermissions: Array<{ toolName: string; allowed: boolean }>;  [key: string]: unknown }>;
			const profile = agents.find(a => a.id === agentId);
			if (!profile) {
				throw new CliError(
					"AGENT_NOT_FOUND",
					`Agent "${agentId}" not found in runtime`,
					EXIT_CONFIG,
				);
			}

			const data = {
				...profile,
				source: "runtime",
				toolPermissions_summary: profile.toolPermissions.length === 0
					? "all tools allowed"
					: profile.toolPermissions.map((tp) => `${tp.toolName}:${tp.allowed ? "allow" : "deny"}`).join(", "),
			};

			if (ctx.json) {
				writeJson({
					ok: true,
					command: "agent show",
					data,
				});
			} else if (!ctx.quiet) {
				writeText(formatAgentDetail(data, "runtime"));
			}
		} finally {
			await host?.shutdown();
		}
		return;
	}

	// File source
	const filePath = agentsFilePath(ctx);
	const entries = readAgentFile(filePath);
	const entry = entries.find((e) => e.id === agentId);

	if (!entry) {
		throw new CliError(
			"AGENT_NOT_FOUND",
			`Agent "${agentId}" not found in config/agents.json`,
			EXIT_CONFIG,
		);
	}

	// Load persona summary if personaId is set
	let personaSummary: string | undefined;
	if (entry.personaId) {
		const personaIds = readPersonaIds(ctx);
		if (personaIds.includes(entry.personaId)) {
			personaSummary = `persona "${entry.personaId}" found`;
		} else {
			personaSummary = `persona "${entry.personaId}" NOT found in personas.json`;
		}
	}

	const toolSummary =
		!entry.toolPermissions || entry.toolPermissions.length === 0
			? "all tools allowed"
			: entry.toolPermissions.join(", ");

	const data = {
		...entry,
		source: "file",
		enabled: entry.enabled !== false,
		persona_summary: personaSummary,
		tool_summary: toolSummary,
	};

	if (ctx.json) {
		writeJson({
			ok: true,
			command: "agent show",
			data,
		});
	} else if (!ctx.quiet) {
		writeText(formatAgentDetail(data, "file"));
	}
}

function formatAgentDetail(data: Record<string, unknown>, source: string): string {
	const lines: string[] = [];
	lines.push(`Agent: ${data.id}`);
	lines.push(`  Role:      ${data.role}`);
	lines.push(`  Source:    ${source}`);
	lines.push(`  Model:     ${data.modelId ?? "(default)"}`);
	lines.push(`  Enabled:   ${data.enabled !== false}`);
	if (data.personaId) {
		lines.push(`  Persona:   ${data.personaId}`);
	}
	if (data.persona_summary) {
		lines.push(`  Persona Status: ${data.persona_summary}`);
	}
	if (data.tool_summary) {
		lines.push(`  Tools:     ${data.tool_summary}`);
	}
	if (data.toolPermissions_summary) {
		lines.push(`  Tools:     ${data.toolPermissions_summary}`);
	}
	if (data.lifecycle) {
		lines.push(`  Lifecycle: ${data.lifecycle}`);
	}
	return lines.join("\n");
}

// ── agent create-rp ─────────────────────────────────────────────────

const CREATE_RP_KNOWN_FLAGS = new Set(["persona", "model", "json"]);

async function handleAgentCreateRp(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	rejectUnknownFlags("agent create-rp", args, CREATE_RP_KNOWN_FLAGS);

	const agentId = args.positional[0];
	if (!agentId) {
		throw new CliError(
			"MISSING_ARGUMENT",
			'agent create-rp requires <agent_id>',
			EXIT_USAGE,
		);
	}

	const personaFlag = args.flags["persona"];
	if (!personaFlag || typeof personaFlag !== "string") {
		throw new CliError(
			"MISSING_ARGUMENT",
			'agent create-rp requires --persona <persona_id>',
			EXIT_USAGE,
		);
	}
	const personaId: string = personaFlag;

	// Validate persona exists
	const personaIds = readPersonaIds(ctx);
	if (!personaIds.includes(personaId)) {
		throw new CliError(
			"PERSONA_NOT_FOUND",
			`Persona "${personaId}" not found in config/personas.json`,
			EXIT_CONFIG,
		);
	}

	const modelId = (args.flags["model"] as string) || undefined;

	// Read existing agents
	const filePath = agentsFilePath(ctx);
	const entries = readAgentFile(filePath);

	// Check for duplicate agent_id
	if (entries.some((e) => e.id === agentId)) {
		throw new CliError(
			"AGENT_ALREADY_EXISTS",
			`Agent "${agentId}" already exists in config/agents.json`,
			EXIT_CONFIG,
		);
	}

	// Clone RP preset defaults
	const newEntry: AgentFileEntry = {
		id: agentId,
		role: "rp_agent",
		personaId,
		modelId: modelId ?? "claude-3-5-sonnet-20241022",
		enabled: true,
		lifecycle: "persistent",
		userFacing: true,
		outputMode: "freeform",
		maxOutputTokens: 4096,
		toolPermissions: ["submit_rp_turn"],
		maxDelegationDepth: 1,
		lorebookEnabled: true,
		narrativeContextEnabled: true,
	};

	entries.push(newEntry);
	writeAgentFile(filePath, entries);

	if (ctx.json) {
		writeJson({
			ok: true,
			command: "agent create-rp",
			data: { agent: newEntry },
		});
	} else if (!ctx.quiet) {
		writeText(`Created RP agent "${agentId}" with persona "${personaId}".`);
	}
}

// ── agent create-task ───────────────────────────────────────────────

const CREATE_TASK_KNOWN_FLAGS = new Set(["model", "json"]);

async function handleAgentCreateTask(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	rejectUnknownFlags("agent create-task", args, CREATE_TASK_KNOWN_FLAGS);

	const agentId = args.positional[0];
	if (!agentId) {
		throw new CliError(
			"MISSING_ARGUMENT",
			'agent create-task requires <agent_id>',
			EXIT_USAGE,
		);
	}

	const modelId = (args.flags["model"] as string) || undefined;

	// Read existing agents
	const filePath = agentsFilePath(ctx);
	const entries = readAgentFile(filePath);

	// Check for duplicate agent_id
	if (entries.some((e) => e.id === agentId)) {
		throw new CliError(
			"AGENT_ALREADY_EXISTS",
			`Agent "${agentId}" already exists in config/agents.json`,
			EXIT_CONFIG,
		);
	}

	// Clone task agent preset defaults
	const newEntry: AgentFileEntry = {
		id: agentId,
		role: "task_agent",
		modelId: modelId ?? "claude-3-5-haiku-20241022",
		enabled: true,
		lifecycle: "ephemeral",
		userFacing: false,
		outputMode: "structured",
		maxOutputTokens: 2048,
		toolPermissions: [],
		maxDelegationDepth: 0,
		lorebookEnabled: false,
		narrativeContextEnabled: false,
	};

	entries.push(newEntry);
	writeAgentFile(filePath, entries);

	if (ctx.json) {
		writeJson({
			ok: true,
			command: "agent create-task",
			data: { agent: newEntry },
		});
	} else if (!ctx.quiet) {
		writeText(`Created task agent "${agentId}".`);
	}
}

// ── agent enable ────────────────────────────────────────────────────

const ENABLE_KNOWN_FLAGS = new Set(["json"]);

async function handleAgentEnable(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	rejectUnknownFlags("agent enable", args, ENABLE_KNOWN_FLAGS);

	const agentId = args.positional[0];
	if (!agentId) {
		throw new CliError(
			"MISSING_ARGUMENT",
			'agent enable requires <agent_id>',
			EXIT_USAGE,
		);
	}

	const filePath = agentsFilePath(ctx);
	const entries = readAgentFile(filePath);

	const entry = entries.find((e) => e.id === agentId);
	if (!entry) {
		throw new CliError(
			"AGENT_NOT_FOUND",
			`Agent "${agentId}" not found in config/agents.json`,
			EXIT_CONFIG,
		);
	}

	// Set enabled: true — preserve all other fields
	entry.enabled = true;
	writeAgentFile(filePath, entries);

	if (ctx.json) {
		writeJson({
			ok: true,
			command: "agent enable",
			data: { agent_id: agentId, enabled: true },
		});
	} else if (!ctx.quiet) {
		writeText(`Agent "${agentId}" enabled.`);
	}
}

// ── agent disable ───────────────────────────────────────────────────

const DISABLE_KNOWN_FLAGS = new Set(["json"]);

async function handleAgentDisable(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	rejectUnknownFlags("agent disable", args, DISABLE_KNOWN_FLAGS);

	const agentId = args.positional[0];
	if (!agentId) {
		throw new CliError(
			"MISSING_ARGUMENT",
			'agent disable requires <agent_id>',
			EXIT_USAGE,
		);
	}

	const filePath = agentsFilePath(ctx);
	const entries = readAgentFile(filePath);

	const entry = entries.find((e) => e.id === agentId);
	if (!entry) {
		throw new CliError(
			"AGENT_NOT_FOUND",
			`Agent "${agentId}" not found in config/agents.json`,
			EXIT_CONFIG,
		);
	}

	// Set enabled: false — preserve all other fields
	entry.enabled = false;
	writeAgentFile(filePath, entries);

	if (ctx.json) {
		writeJson({
			ok: true,
			command: "agent disable",
			data: { agent_id: agentId, enabled: false },
		});
	} else if (!ctx.quiet) {
		writeText(`Agent "${agentId}" disabled.`);
	}
}

// ── agent remove ────────────────────────────────────────────────────

const REMOVE_KNOWN_FLAGS = new Set(["force", "json"]);

async function handleAgentRemove(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	rejectUnknownFlags("agent remove", args, REMOVE_KNOWN_FLAGS);

	const agentId = args.positional[0];
	if (!agentId) {
		throw new CliError(
			"MISSING_ARGUMENT",
			'agent remove requires <agent_id>',
			EXIT_USAGE,
		);
	}

	// Require --force
	if (args.flags["force"] !== true) {
		throw new CliError(
			"FORCE_REQUIRED",
			'agent remove requires --force to confirm deletion',
			EXIT_USAGE,
		);
	}

	const filePath = agentsFilePath(ctx);
	const entries = readAgentFile(filePath);

	const index = entries.findIndex((e) => e.id === agentId);
	if (index === -1) {
		throw new CliError(
			"AGENT_NOT_FOUND",
			`Agent "${agentId}" not found in config/agents.json`,
			EXIT_CONFIG,
		);
	}

	entries.splice(index, 1);
	writeAgentFile(filePath, entries);

	if (ctx.json) {
		writeJson({
			ok: true,
			command: "agent remove",
			data: { agent_id: agentId, removed: true },
		});
	} else if (!ctx.quiet) {
		writeText(`Agent "${agentId}" removed.`);
	}
}

// ── agent validate ──────────────────────────────────────────────────

const VALIDATE_KNOWN_FLAGS = new Set(["json"]);

async function handleAgentValidate(
	ctx: CliContext,
	args: ParsedArgs,
): Promise<void> {
	rejectUnknownFlags("agent validate", args, VALIDATE_KNOWN_FLAGS);

	const agentId = args.positional[0]; // optional

	const filePath = agentsFilePath(ctx);
	const entries = readAgentFile(filePath);

	// If specific agent requested, filter to just that one
	let entriesToValidate: AgentFileEntry[];
	if (agentId) {
		const entry = entries.find((e) => e.id === agentId);
		if (!entry) {
			throw new CliError(
				"AGENT_NOT_FOUND",
				`Agent "${agentId}" not found in config/agents.json`,
				EXIT_CONFIG,
			);
		}
		entriesToValidate = [entry];
	} else {
		entriesToValidate = entries;
	}

	// Load persona IDs for cross-reference validation
	const personaIds = readPersonaIds(ctx);

	// Reuse validateAgentFile from T4
	const agentDiagnostics = validateAgentFile(entriesToValidate, personaIds);

	// Convert to CliDiagnostic[]
	const diagnostics: CliDiagnostic[] = agentDiagnostics.map((d) => ({
		code: d.code,
		message: d.message,
		locator: d.agentId ?? d.locator,
	}));

	if (ctx.json) {
		writeJson({
			ok: diagnostics.length === 0,
			command: "agent validate",
			data: { diagnostics },
		});
	} else if (!ctx.quiet) {
		if (diagnostics.length === 0) {
			writeText(
				agentId
					? `Agent "${agentId}" is valid.`
					: "All agents are valid.",
			);
		} else {
			writeText(
				`Found ${diagnostics.length} issue${diagnostics.length === 1 ? "" : "s"}:\n`,
			);
			for (const d of diagnostics) {
				const loc = d.locator ? ` (${d.locator})` : "";
				writeText(`  [${d.code}]${loc} ${d.message}`);
			}
		}
	}
}

// ── Registration ─────────────────────────────────────────────────────

/**
 * Register all `agent *` sub-commands on the CLI router.
 *
 * Call this from `scripts/cli.ts` instead of manually registering
 * individual agent command stubs.
 */
export function registerAgentCommands(): void {
	registerCommand({
		namespace: "agent",
		subcommand: "list",
		description: "List all registered agents",
		handler: handleAgentList,
	});

	registerCommand({
		namespace: "agent",
		subcommand: "show",
		description: "Show details of a specific agent",
		handler: handleAgentShow,
	});

	registerCommand({
		namespace: "agent",
		subcommand: "create-rp",
		description: "Create an RP agent from a persona",
		handler: handleAgentCreateRp,
	});

	registerCommand({
		namespace: "agent",
		subcommand: "create-task",
		description: "Create a task agent",
		handler: handleAgentCreateTask,
	});

	registerCommand({
		namespace: "agent",
		subcommand: "enable",
		description: "Enable a disabled agent",
		handler: handleAgentEnable,
	});

	registerCommand({
		namespace: "agent",
		subcommand: "disable",
		description: "Disable an agent",
		handler: handleAgentDisable,
	});

	registerCommand({
		namespace: "agent",
		subcommand: "remove",
		description: "Remove an agent from config",
		handler: handleAgentRemove,
	});

	registerCommand({
		namespace: "agent",
		subcommand: "validate",
		description: "Validate agent configuration",
		handler: handleAgentValidate,
	});
}
