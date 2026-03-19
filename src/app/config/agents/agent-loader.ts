// Agent loader — validates file entries, loads into AgentProfile[], exposes reusable diagnostics

import type { AgentProfile, AgentRole, ToolPermission } from "../../../agents/profile.js";
import { normalizeModelRef } from "../../../core/models/registry.js";
import { type AgentFileEntry, readAgentFile } from "./agent-file-store.js";

// ─── Diagnostic types ────────────────────────────────────────

export type AgentDiagnosticCode =
	| "config.invalid_agent_role"
	| "config.duplicate_agent_id"
	| "config.agent_persona_not_found"
	| "config.rp_missing_submit_rp_turn_permission";

export type AgentDiagnostic = {
	code: AgentDiagnosticCode;
	message: string;
	agentId?: string;
	locator?: string;
};

// ─── Constants ───────────────────────────────────────────────

const VALID_ROLES: ReadonlySet<string> = new Set<AgentRole>([
	"maiden",
	"rp_agent",
	"task_agent",
]);

const RP_REQUIRED_TOOL = "submit_rp_turn";

// ─── Role defaults ───────────────────────────────────────────

type RoleDefaults = Pick<
	AgentProfile,
	| "lifecycle"
	| "userFacing"
	| "outputMode"
	| "maxOutputTokens"
	| "maxDelegationDepth"
	| "lorebookEnabled"
	| "narrativeContextEnabled"
	| "modelId"
	| "toolPermissions"
>;

const ROLE_DEFAULTS: Record<AgentRole, RoleDefaults> = {
	maiden: {
		lifecycle: "persistent",
		userFacing: true,
		outputMode: "freeform",
		modelId: "anthropic/claude-3-5-sonnet-20241022",
		maxOutputTokens: 8192,
		toolPermissions: [],
		maxDelegationDepth: 3,
		lorebookEnabled: true,
		narrativeContextEnabled: true,
	},
	rp_agent: {
		lifecycle: "persistent",
		userFacing: true,
		outputMode: "freeform",
		modelId: "anthropic/claude-3-5-sonnet-20241022",
		maxOutputTokens: 4096,
		toolPermissions: [],
		maxDelegationDepth: 1,
		lorebookEnabled: true,
		narrativeContextEnabled: true,
	},
	task_agent: {
		lifecycle: "ephemeral",
		userFacing: false,
		outputMode: "structured",
		modelId: "anthropic/claude-3-5-haiku-20241022",
		maxOutputTokens: 2048,
		toolPermissions: [],
		maxDelegationDepth: 0,
		lorebookEnabled: false,
		narrativeContextEnabled: false,
	},
};

// ─── Validation ──────────────────────────────────────────────

/**
 * Validate an array of AgentFileEntry objects.
 *
 * This is the ONE reusable validation function for agent config.
 * Used by: config validate, config doctor, agent validate, and runtime bootstrap.
 *
 * @param entries  — parsed agent file entries
 * @param personaIds — optional set of known persona IDs for reference checking
 * @returns diagnostics array (empty = valid)
 */
export function validateAgentFile(
	entries: AgentFileEntry[],
	personaIds?: string[],
): AgentDiagnostic[] {
	const diagnostics: AgentDiagnostic[] = [];
	const seenIds = new Set<string>();
	const knownPersonaIds = personaIds ? new Set(personaIds) : undefined;

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		const locator = `agents[${i}]`;

		// 1. Check valid role
		if (!VALID_ROLES.has(entry.role)) {
			diagnostics.push({
				code: "config.invalid_agent_role",
				message: `Agent "${entry.id}" has invalid role "${entry.role}". Expected one of: maiden, rp_agent, task_agent`,
				agentId: entry.id,
				locator,
			});
		}

		// 2. Check duplicate IDs
		if (seenIds.has(entry.id)) {
			diagnostics.push({
				code: "config.duplicate_agent_id",
				message: `Duplicate agent ID "${entry.id}" found at ${locator}`,
				agentId: entry.id,
				locator,
			});
		}
		seenIds.add(entry.id);

		// 3. Check persona reference
		if (
			entry.personaId &&
			knownPersonaIds &&
			!knownPersonaIds.has(entry.personaId)
		) {
			diagnostics.push({
				code: "config.agent_persona_not_found",
				message: `Agent "${entry.id}" references persona "${entry.personaId}" which does not exist`,
				agentId: entry.id,
				locator,
			});
		}

		// 4. RP agents with non-empty toolPermissions must include submit_rp_turn
		if (
			entry.role === "rp_agent" &&
			entry.toolPermissions &&
			entry.toolPermissions.length > 0 &&
			!entry.toolPermissions.includes(RP_REQUIRED_TOOL)
		) {
			diagnostics.push({
				code: "config.rp_missing_submit_rp_turn_permission",
				message: `RP agent "${entry.id}" has explicit tool permissions but is missing required "${RP_REQUIRED_TOOL}"`,
				agentId: entry.id,
				locator,
			});
		}
	}

	return diagnostics;
}

// ─── Loader ──────────────────────────────────────────────────

function toAgentProfile(entry: AgentFileEntry): AgentProfile {
	const role = entry.role as AgentRole;
	const defaults = ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS.task_agent;

	const toolPermissions: ToolPermission[] = entry.toolPermissions
		? entry.toolPermissions.map((toolName) => ({ toolName, allowed: true }))
		: [...defaults.toolPermissions];

	const modelId = entry.modelId
		? normalizeModelRef(entry.modelId)
		: defaults.modelId;

	return {
		id: entry.id,
		role,
		lifecycle: entry.lifecycle ?? defaults.lifecycle,
		userFacing: entry.userFacing ?? defaults.userFacing,
		outputMode: entry.outputMode ?? defaults.outputMode,
		modelId,
		maxOutputTokens: entry.maxOutputTokens ?? defaults.maxOutputTokens,
		personaId: entry.personaId,
		toolPermissions,
		maxDelegationDepth:
			entry.maxDelegationDepth ?? defaults.maxDelegationDepth,
		lorebookEnabled: entry.lorebookEnabled ?? defaults.lorebookEnabled,
		narrativeContextEnabled:
			entry.narrativeContextEnabled ?? defaults.narrativeContextEnabled,
		contextBudget: entry.contextBudget,
	};
}

export type LoadFileAgentsResult = {
	agents: AgentProfile[];
	diagnostics: AgentDiagnostic[];
};

/**
 * Load agents from a config file, validate, normalize, and return profiles + diagnostics.
 *
 * - Missing file → zero agents, zero diagnostics (file is optional)
 * - Missing `enabled` field → treated as true
 * - Invalid entries produce diagnostics but do NOT prevent valid entries from loading
 */
export function loadFileAgents(
	filePath: string,
	personaIds?: string[],
): LoadFileAgentsResult {
	const entries = readAgentFile(filePath);

	if (entries.length === 0) {
		return { agents: [], diagnostics: [] };
	}

	const diagnostics = validateAgentFile(entries, personaIds);

	const fatalIds = new Set<string>();
	for (const d of diagnostics) {
		if (
			d.code === "config.invalid_agent_role" ||
			d.code === "config.duplicate_agent_id"
		) {
			if (d.agentId) {
				fatalIds.add(d.agentId);
			}
		}
	}

	const agents: AgentProfile[] = [];
	const processedIds = new Set<string>();

	for (const entry of entries) {
		if (entry.enabled === false) {
			continue;
		}

		if (fatalIds.has(entry.id)) {
			continue;
		}

		if (processedIds.has(entry.id)) {
			continue;
		}
		processedIds.add(entry.id);

		agents.push(toAgentProfile(entry));
	}

	return { agents, diagnostics };
}
