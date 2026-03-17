// Agent file store — read/write config/agents.json as typed AgentFileEntry objects

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentRole, OutputMode, AgentLifecycle } from "../agents/profile.js";

/** Shape of a single agent entry in config/agents.json */
export type AgentFileEntry = {
	id: string;
	role: string;
	lifecycle?: AgentLifecycle;
	userFacing?: boolean;
	outputMode?: OutputMode;
	modelId?: string;
	personaId?: string;
	enabled?: boolean;
	maxOutputTokens?: number;
	toolPermissions?: string[];
	maxDelegationDepth?: number;
	detachable?: boolean;
	lorebookEnabled?: boolean;
	narrativeContextEnabled?: boolean;
	contextBudget?: {
		maxTokens: number;
		reservedForCoordination?: number;
	};
};

/**
 * Read agent entries from a JSON file.
 * Returns an empty array if the file does not exist.
 */
export function readAgentFile(filePath: string): AgentFileEntry[] {
	if (!existsSync(filePath)) {
		return [];
	}

	const raw = readFileSync(filePath, "utf-8");
	const parsed: unknown = JSON.parse(raw);

	if (!Array.isArray(parsed)) {
		throw new Error(
			`Agent config file must contain a JSON array, got ${typeof parsed}`,
		);
	}

	return parsed as AgentFileEntry[];
}

/**
 * Write agent entries back to a JSON file.
 */
export function writeAgentFile(
	filePath: string,
	entries: AgentFileEntry[],
): void {
	writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
}
