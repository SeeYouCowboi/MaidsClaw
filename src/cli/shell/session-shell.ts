/**
 * Interactive readline REPL for the `maidsclaw chat` command.
 *
 * Each line of user input is either:
 * - A slash command (dispatched to {@link dispatchSlashCommand})
 * - A turn message (sent to {@link LocalRuntime.executeTurn})
 *
 * After each turn, a compact status line is printed:
 *   [req:<request_id> | settle:<settlement_id|none> | reply:<yes|no> | recovery:<yes|no>]
 */

import readline from "readline";
import type { RuntimeBootstrapResult } from "../../bootstrap/types.js";
import { createLocalRuntime } from "../local-runtime.js";
import type { LocalRuntime } from "../local-runtime.js";
import { writeText } from "../output.js";
import { dispatchSlashCommand } from "./slash-dispatcher.js";
import type { ShellState } from "./state.js";

// ── SessionShell ──────────────────────────────────────────────────────

export class SessionShell {
	private readonly state: ShellState;
	private readonly runtime: RuntimeBootstrapResult;
	private readonly localRuntime: LocalRuntime;
	private readonly saveTrace: boolean;

	constructor(
		state: ShellState,
		runtime: RuntimeBootstrapResult,
		options?: { saveTrace?: boolean },
	) {
		this.state = state;
		this.runtime = runtime;
		this.localRuntime = createLocalRuntime(runtime);
		this.saveTrace = options?.saveTrace ?? false;
	}

	async run(): Promise<void> {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		rl.setPrompt("> ");
		rl.prompt();

		return new Promise<void>((resolve) => {
			rl.on("line", async (line: string) => {
				const trimmed = line.trim();

				// Empty input: no-op
				if (trimmed.length === 0) {
					rl.prompt();
					return;
				}

				// Slash command
				if (trimmed.startsWith("/")) {
					const result = dispatchSlashCommand(trimmed, {
						state: this.state,
						runtime: this.runtime,
					});
					if (result.exit) {
						rl.close();
						return;
					}
					rl.prompt();
					return;
				}

				// Regular turn message
				await this.executeTurnAndPrint(trimmed);
				rl.prompt();
			});

			rl.on("close", () => {
				resolve();
			});
		});
	}

	private async executeTurnAndPrint(text: string): Promise<void> {
		try {
			const result = await this.localRuntime.executeTurn({
				sessionId: this.state.sessionId,
				agentId: this.state.agentId,
				text,
				saveTrace: this.saveTrace,
			});

			// Update shell state
			this.state.lastRequestId = result.request_id;
			this.state.lastSettlementId = result.settlement_id;

			// Print assistant response
			if (result.assistant_text) {
				writeText(result.assistant_text);
			} else if (result.private_commit.present) {
				writeText("[silent turn — private commit only]");
			} else {
				writeText("[no output]");
			}

			// Compact status line
			const statusParts = [
				`req:${result.request_id}`,
				`settle:${result.settlement_id ?? "none"}`,
				`reply:${result.has_public_reply ? "yes" : "no"}`,
				`recovery:${result.recovery_required ? "yes" : "no"}`,
			];
			writeText(`[${statusParts.join(" | ")}]`);
		} catch (err) {
			writeText(`Turn error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
