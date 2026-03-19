/**
 * Shell state management for the interactive `chat` REPL.
 *
 * Tracks session context, last request/settlement IDs, and display preferences.
 * The state is mutated in-place as turns execute and slash commands are processed.
 */

import type { CliMode } from "../../cli/types.js";

// ── ShellState ────────────────────────────────────────────────────────

export interface ShellState {
	sessionId: string;
	agentId: string;
	lastRequestId?: string;
	lastSettlementId?: string;
	rawMode: boolean;
	mode: CliMode;
	baseUrl?: string;
}

// ── Factory ───────────────────────────────────────────────────────────

export type CreateShellStateOptions = {
	sessionId: string;
	agentId: string;
	mode?: CliMode;
	baseUrl?: string;
};

export function createShellState(opts: CreateShellStateOptions): ShellState {
	return {
		sessionId: opts.sessionId,
		agentId: opts.agentId,
		rawMode: false,
		mode: opts.mode ?? "local",
		baseUrl: opts.baseUrl,
	};
}
