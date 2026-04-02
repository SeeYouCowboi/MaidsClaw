/**
 * Interactive readline REPL for the `maidsclaw chat` command.
 *
 * Each line of user input is either:
 * - A slash command (dispatched to {@link dispatchSlashCommand})
 * - A turn message (sent via {@link AppUserFacade.turn})
 *
 * After each turn, a compact status line is printed:
 *   [req:<request_id> | settle:<settlement_id|none> | reply:<yes|no> | recovery:<yes|no>]
 */

import readline from "node:readline";
import type { AppUserFacade } from "../../app/host/types.js";
import type { GatewayClient } from "../gateway-client.js";
import { writeText } from "../output.js";
import { dispatchSlashCommand } from "./slash-dispatcher.js";
import type { ShellState } from "./state.js";

// ── SessionShell ──────────────────────────────────────────────────────

export class SessionShell {
	private readonly state: ShellState;
	private readonly facade: AppUserFacade;
	private readonly gatewayClient?: GatewayClient;
	private readonly saveTrace: boolean;

	constructor(
		state: ShellState,
		facade: AppUserFacade,
		options?: { saveTrace?: boolean; gatewayClient?: GatewayClient },
	) {
		this.state = state;
		this.facade = facade;
		this.gatewayClient = options?.gatewayClient;
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
					const result = await dispatchSlashCommand(trimmed, {
						state: this.state,
						facade: this.facade,
						gatewayClient: this.gatewayClient,
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
			if (this.state.mode === "gateway") {
				if (!this.gatewayClient) {
					throw new Error("Gateway client is not initialized");
				}

				const streamed = await this.gatewayClient.streamTurn({
					sessionId: this.state.sessionId,
					agentId: this.state.agentId,
					text,
				});
				if (streamed.hadError) {
					throw new Error(streamed.errorMessage ?? "Gateway turn failed");
				}

				const summary = await this.gatewayClient.getSummary(streamed.requestId);
				this.state.lastRequestId = streamed.requestId;
				this.state.lastSettlementId = summary.settlement.settlement_id;

				if (streamed.assistantText) {
					writeText(streamed.assistantText);
				} else if (summary.private_cognition_count > 0) {
					writeText("[silent turn — private cognition only]");
				} else {
					writeText("[no output]");
				}

				const statusParts = [
					`req:${streamed.requestId}`,
					`settle:${summary.settlement.settlement_id ?? "none"}`,
					`reply:${summary.has_public_reply ? "yes" : "no"}`,
					`recovery:${summary.recovery_required ? "yes" : "no"}`,
				];
				writeText(`[${statusParts.join(" | ")}]`);
				return;
			}

			const requestId = crypto.randomUUID();
			let assistantText = "";
			let hadError = false;
			let errorMessage: string | undefined;

			for await (const event of this.facade.turn.streamTurn({
				sessionId: this.state.sessionId,
				agentId: this.state.agentId,
				text,
				requestId,
				saveTrace: this.saveTrace,
			})) {
				if (event.type === "text_delta") {
					assistantText += event.text;
				}
				if (event.type === "error") {
					hadError = true;
					errorMessage = event.message;
				}
			}

			if (hadError) {
				throw new Error(errorMessage ?? "Turn failed");
			}

			const summary = await this.facade.inspect.getSummary(requestId);

			// Update shell state
			this.state.lastRequestId = requestId;
			this.state.lastSettlementId = summary.settlement.settlement_id;

			// Print assistant response
			if (assistantText) {
				writeText(assistantText);
			} else if (summary.private_cognition_count > 0) {
				writeText("[silent turn — private cognition only]");
			} else {
				writeText("[no output]");
			}

			// Compact status line
			const statusParts = [
				`req:${requestId}`,
				`settle:${summary.settlement.settlement_id ?? "none"}`,
				`reply:${summary.has_public_reply ? "yes" : "no"}`,
				`recovery:${summary.recovery_required ? "yes" : "no"}`,
			];
			writeText(`[${statusParts.join(" | ")}]`);
		} catch (err) {
			writeText(
				`Turn error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
