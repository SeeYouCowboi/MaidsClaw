import { describe, expect, it, beforeEach } from "bun:test";
import { createShellState } from "../../src/terminal-cli/shell/state.js";
import type { ShellState } from "../../src/terminal-cli/shell/state.js";
import { dispatchSlashCommand } from "../../src/terminal-cli/shell/slash-dispatcher.js";
import type { SlashDispatchContext } from "../../src/terminal-cli/shell/slash-dispatcher.js";
import { registerCommand, dispatch, resetCommands } from "../../src/terminal-cli/parser.js";
import { registerChatCommand } from "../../src/terminal-cli/commands/chat.js";
import { CliError } from "../../src/terminal-cli/errors.js";

// ── ShellState tests ──────────────────────────────────────────────────

describe("ShellState", () => {
	it("initializes with required fields", () => {
		const state = createShellState({
			sessionId: "sess-001",
			agentId: "maid-01",
		});

		expect(state.sessionId).toBe("sess-001");
		expect(state.agentId).toBe("maid-01");
		expect(state.rawMode).toBe(false);
		expect(state.mode).toBe("local");
		expect(state.lastRequestId).toBeUndefined();
		expect(state.lastSettlementId).toBeUndefined();
		expect(state.baseUrl).toBeUndefined();
	});

	it("initializes with optional fields", () => {
		const state = createShellState({
			sessionId: "sess-002",
			agentId: "maid-02",
			mode: "gateway",
			baseUrl: "http://localhost:3000",
		});

		expect(state.mode).toBe("gateway");
		expect(state.baseUrl).toBe("http://localhost:3000");
	});

	it("allows mutation of mutable fields", () => {
		const state = createShellState({
			sessionId: "sess-003",
			agentId: "maid-03",
		});

		state.lastRequestId = "req-abc";
		state.lastSettlementId = "settle-xyz";
		state.rawMode = true;

		expect(state.lastRequestId).toBe("req-abc");
		expect(state.lastSettlementId).toBe("settle-xyz");
		expect(state.rawMode).toBe(true);
	});
});

// ── Slash dispatcher tests ────────────────────────────────────────────

describe("SlashDispatcher", () => {
	function makeContext(overrides?: Partial<ShellState>): SlashDispatchContext {
		const state = createShellState({
			sessionId: "test-sess",
			agentId: "test-agent",
		});
		Object.assign(state, overrides);

		// Minimal mock runtime — enough for slash commands that don't
		// need real DB access. Inspect commands will throw but we catch that.
		const mockRuntime = {
			sessionService: {
				requiresRecovery: () => false,
				clearRecoveryRequired: () => {},
				closeSession: (id: string) => ({ sessionId: id, closedAt: Date.now() }),
				getSession: () => null,
				createSession: () => ({ sessionId: "new-sess", agentId: "test-agent", createdAt: Date.now() }),
			},
			traceStore: undefined,
		} as unknown as SlashDispatchContext["runtime"];

		return { state, runtime: mockRuntime };
	}

	it("/help does not exit", async () => {
		const ctx = makeContext();
		const result = await dispatchSlashCommand("/help", ctx);
		expect(result.exit).toBe(false);
	});

	it("/exit signals exit", async () => {
		const ctx = makeContext();
		const result = await dispatchSlashCommand("/exit", ctx);
		expect(result.exit).toBe(true);
	});

	it("/quit signals exit", async () => {
		const ctx = makeContext();
		const result = await dispatchSlashCommand("/quit", ctx);
		expect(result.exit).toBe(true);
	});

	it("/summary without lastRequestId prints error (does not crash)", async () => {
		const ctx = makeContext({ lastRequestId: undefined });
		const result = await dispatchSlashCommand("/summary", ctx);
		expect(result.exit).toBe(false);
		// Should not crash — just print error about missing request context
	});

	it("/inspect without lastRequestId prints error (does not crash)", async () => {
		const ctx = makeContext({ lastRequestId: undefined });
		const result = await dispatchSlashCommand("/inspect", ctx);
		expect(result.exit).toBe(false);
	});

	it("/prompt without lastRequestId prints error (does not crash)", async () => {
		const ctx = makeContext({ lastRequestId: undefined });
		const result = await dispatchSlashCommand("/prompt", ctx);
		expect(result.exit).toBe(false);
	});

	it("/chunks without lastRequestId prints error (does not crash)", async () => {
		const ctx = makeContext({ lastRequestId: undefined });
		const result = await dispatchSlashCommand("/chunks", ctx);
		expect(result.exit).toBe(false);
	});

	it("/diagnose without lastRequestId prints error (does not crash)", async () => {
		const ctx = makeContext({ lastRequestId: undefined });
		const result = await dispatchSlashCommand("/diagnose", ctx);
		expect(result.exit).toBe(false);
	});

	it("/trace without lastRequestId prints error (does not crash)", async () => {
		const ctx = makeContext({ lastRequestId: undefined });
		const result = await dispatchSlashCommand("/trace", ctx);
		expect(result.exit).toBe(false);
	});

	it("/raw on toggles raw mode on", async () => {
		const ctx = makeContext();
		expect(ctx.state.rawMode).toBe(false);
		await dispatchSlashCommand("/raw on", ctx);
		expect(ctx.state.rawMode).toBe(true);
	});

	it("/raw off toggles raw mode off", async () => {
		const ctx = makeContext({ rawMode: true });
		await dispatchSlashCommand("/raw off", ctx);
		expect(ctx.state.rawMode).toBe(false);
	});

	it("/mode local sets mode", async () => {
		const ctx = makeContext({ mode: "gateway" });
		await dispatchSlashCommand("/mode local", ctx);
		expect(ctx.state.mode).toBe("local");
	});

	it("/mode gateway sets mode", async () => {
		const ctx = makeContext({ mode: "local" });
		await dispatchSlashCommand("/mode gateway", ctx);
		expect(ctx.state.mode).toBe("gateway");
	});

	it("unknown slash command does not crash", async () => {
		const ctx = makeContext();
		const result = await dispatchSlashCommand("/nonexistent", ctx);
		expect(result.exit).toBe(false);
	});
});

// ── chat --json rejection test ────────────────────────────────────────

describe("chat command", () => {
	beforeEach(() => {
		resetCommands();
	});

	it("rejects --json with exit code 2", async () => {
		registerChatCommand();

		try {
			await dispatch(["chat", "--json", "--agent", "maid-01"]);
			// Should not reach here
			expect(true).toBe(false);
		} catch (err) {
			expect(err instanceof CliError).toBe(true);
			const cliErr = err as CliError;
			expect(cliErr.exitCode).toBe(2);
			expect(cliErr.code).toBe("INVALID_FLAG");
		}
	});

	it("requires --agent flag", async () => {
		registerChatCommand();

		try {
			await dispatch(["chat"]);
			expect(true).toBe(false);
		} catch (err) {
			expect(err instanceof CliError).toBe(true);
			const cliErr = err as CliError;
			expect(cliErr.exitCode).toBe(2);
			expect(cliErr.code).toBe("MISSING_ARGUMENT");
		}
	});

	it("rejects unknown flags", async () => {
		registerChatCommand();

		try {
			await dispatch(["chat", "--agent", "maid-01", "--bogus"]);
			expect(true).toBe(false);
		} catch (err) {
			expect(err instanceof CliError).toBe(true);
			const cliErr = err as CliError;
			expect(cliErr.exitCode).toBe(2);
			expect(cliErr.code).toBe("UNKNOWN_FLAGS");
		}
	});
});
