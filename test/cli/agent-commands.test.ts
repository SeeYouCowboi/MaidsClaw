import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dispatch, resetCommands } from "../../src/cli/parser.js";
import { registerAgentCommands } from "../../src/cli/commands/agent.js";
import { CliError } from "../../src/cli/errors.js";
import type { JsonEnvelope } from "../../src/cli/types.js";
import type { AgentFileEntry } from "../../src/app/config/agents/agent-file-store.js";

// ── Helpers ──────────────────────────────────────────────────────────

async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = (chunk: string | Uint8Array): boolean => {
		chunks.push(
			typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
		);
		return true;
	};
	try {
		await fn();
	} finally {
		process.stdout.write = originalWrite;
	}
	return chunks.join("");
}

function parseJsonOutput(raw: string): JsonEnvelope {
	const line = raw.trim().split("\n")[0];
	return JSON.parse(line!) as JsonEnvelope;
}

/** Seed config/agents.json with sample agents */
function seedAgents(tempDir: string, entries: AgentFileEntry[]): void {
	const configDir = join(tempDir, "config");
	if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "agents.json"),
		JSON.stringify(entries, null, 2),
	);
}

/** Seed config/personas.json with sample personas */
function seedPersonas(
	tempDir: string,
	personas: { id: string; name: string }[],
): void {
	const configDir = join(tempDir, "config");
	if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "personas.json"),
		JSON.stringify(personas, null, 2),
	);
}

/** Read agents from file */
function readAgents(tempDir: string): AgentFileEntry[] {
	const filePath = join(tempDir, "config", "agents.json");
	return JSON.parse(readFileSync(filePath, "utf-8")) as AgentFileEntry[];
}

const SAMPLE_AGENTS: AgentFileEntry[] = [
	{
		id: "maid:main",
		role: "maiden",
		modelId: "claude-3-5-sonnet-20241022",
		enabled: true,
	},
	{
		id: "rp:alice",
		role: "rp_agent",
		personaId: "alice",
		modelId: "claude-3-5-sonnet-20241022",
		enabled: true,
		toolPermissions: ["submit_rp_turn"],
	},
	{
		id: "task:runner",
		role: "task_agent",
		modelId: "claude-3-haiku-20240307",
		enabled: false,
	},
];

const SAMPLE_PERSONAS = [
	{ id: "alice", name: "Alice" },
	{ id: "beth", name: "Beth" },
];

// ── Test suite ───────────────────────────────────────────────────────

describe("agent commands", () => {
	let tempDir: string;

	beforeEach(() => {
		resetCommands();
		registerAgentCommands();
		tempDir = join(
			tmpdir(),
			`maidsclaw-test-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// ── agent list ──────────────────────────────────────────────────

	describe("agent list", () => {
		it("lists file-backed agents in JSON mode", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			const raw = await captureStdout(async () => {
				await dispatch(["--json", "--cwd", tempDir, "agent", "list"]);
			});

			const envelope = parseJsonOutput(raw);
			expect(envelope.ok).toBe(true);
			expect(envelope.command).toBe("agent list");
			const agents = (envelope.data as { agents: unknown[] }).agents;
			expect(agents).toHaveLength(3);

			// Check first agent
			const first = agents[0] as Record<string, unknown>;
			expect(first.agent_id).toBe("maid:main");
			expect(first.role).toBe("maiden");
			expect(first.source).toBe("file");
		});

		it("returns empty list when no agents.json", async () => {
			const raw = await captureStdout(async () => {
				await dispatch(["--json", "--cwd", tempDir, "agent", "list"]);
			});

			const envelope = parseJsonOutput(raw);
			expect(envelope.ok).toBe(true);
			const agents = (envelope.data as { agents: unknown[] }).agents;
			expect(agents).toHaveLength(0);
		});

		it("shows enabled status correctly", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			const raw = await captureStdout(async () => {
				await dispatch(["--json", "--cwd", tempDir, "agent", "list"]);
			});

			const envelope = parseJsonOutput(raw);
			const agents = (envelope.data as { agents: Record<string, unknown>[] }).agents;

			// task:runner has enabled: false
			const taskRunner = agents.find(
				(a) => a.agent_id === "task:runner",
			);
			expect(taskRunner?.enabled).toBe(false);

			// maid:main has enabled: true
			const maiden = agents.find((a) => a.agent_id === "maid:main");
			expect(maiden?.enabled).toBe(true);
		});

		it("rejects invalid --source value", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			let caught: CliError | undefined;
			try {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"list",
					"--source",
					"invalid",
				]);
			} catch (err) {
				if (err instanceof CliError) caught = err;
			}
			expect(caught).toBeDefined();
			expect(caught!.code).toBe("INVALID_FLAG_VALUE");
		});
	});

	// ── agent show ──────────────────────────────────────────────────

	describe("agent show", () => {
		it("shows agent details in JSON mode", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);
			seedPersonas(tempDir, SAMPLE_PERSONAS);

			const raw = await captureStdout(async () => {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"show",
					"rp:alice",
				]);
			});

			const envelope = parseJsonOutput(raw);
			expect(envelope.ok).toBe(true);
			expect(envelope.command).toBe("agent show");

			const data = envelope.data as Record<string, unknown>;
			expect(data.id).toBe("rp:alice");
			expect(data.role).toBe("rp_agent");
			expect(data.source).toBe("file");
			expect(data.personaId).toBe("alice");
			expect(data.persona_summary).toBe('persona "alice" found');
			expect(data.tool_summary).toBe("submit_rp_turn");
		});

		it("fails if agent not found", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			let caught: CliError | undefined;
			try {
				await captureStdout(async () => {
					await dispatch([
						"--json",
						"--cwd",
						tempDir,
						"agent",
						"show",
						"nonexistent",
					]);
				});
			} catch (err) {
				if (err instanceof CliError) caught = err;
			}
			expect(caught).toBeDefined();
			expect(caught!.code).toBe("AGENT_NOT_FOUND");
		});

		it("requires agent_id argument", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			let caught: CliError | undefined;
			try {
				await captureStdout(async () => {
					await dispatch([
						"--json",
						"--cwd",
						tempDir,
						"agent",
						"show",
					]);
				});
			} catch (err) {
				if (err instanceof CliError) caught = err;
			}
			expect(caught).toBeDefined();
			expect(caught!.code).toBe("MISSING_ARGUMENT");
		});
	});

	// ── agent create-rp ─────────────────────────────────────────────

	describe("agent create-rp", () => {
		it("creates valid RP agent with submit_rp_turn", async () => {
			seedAgents(tempDir, []);
			seedPersonas(tempDir, SAMPLE_PERSONAS);

			const raw = await captureStdout(async () => {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"create-rp",
					"rp:beth",
					"--persona",
					"beth",
				]);
			});

			const envelope = parseJsonOutput(raw);
			expect(envelope.ok).toBe(true);
			expect(envelope.command).toBe("agent create-rp");

			const agent = (envelope.data as { agent: AgentFileEntry }).agent;
			expect(agent.id).toBe("rp:beth");
			expect(agent.role).toBe("rp_agent");
			expect(agent.personaId).toBe("beth");
			expect(agent.enabled).toBe(true);
			expect(agent.toolPermissions).toContain("submit_rp_turn");

			// Verify file was written
			const agents = readAgents(tempDir);
			expect(agents).toHaveLength(1);
			expect(agents[0]!.id).toBe("rp:beth");
			expect(agents[0]!.toolPermissions).toContain("submit_rp_turn");
		});

		it("rejects duplicate agent_id", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);
			seedPersonas(tempDir, SAMPLE_PERSONAS);

			let caught: CliError | undefined;
			try {
				await captureStdout(async () => {
					await dispatch([
						"--json",
						"--cwd",
						tempDir,
						"agent",
						"create-rp",
						"rp:alice",
						"--persona",
						"alice",
					]);
				});
			} catch (err) {
				if (err instanceof CliError) caught = err;
			}
			expect(caught).toBeDefined();
			expect(caught!.code).toBe("AGENT_ALREADY_EXISTS");
		});

		it("rejects missing persona", async () => {
			seedAgents(tempDir, []);
			seedPersonas(tempDir, SAMPLE_PERSONAS);

			let caught: CliError | undefined;
			try {
				await captureStdout(async () => {
					await dispatch([
						"--json",
						"--cwd",
						tempDir,
						"agent",
						"create-rp",
						"rp:carol",
						"--persona",
						"carol",
					]);
				});
			} catch (err) {
				if (err instanceof CliError) caught = err;
			}
			expect(caught).toBeDefined();
			expect(caught!.code).toBe("PERSONA_NOT_FOUND");
		});

		it("requires --persona flag", async () => {
			seedAgents(tempDir, []);

			let caught: CliError | undefined;
			try {
				await captureStdout(async () => {
					await dispatch([
						"--json",
						"--cwd",
						tempDir,
						"agent",
						"create-rp",
						"rp:test",
					]);
				});
			} catch (err) {
				if (err instanceof CliError) caught = err;
			}
			expect(caught).toBeDefined();
			expect(caught!.code).toBe("MISSING_ARGUMENT");
		});

		it("uses custom model when provided", async () => {
			seedAgents(tempDir, []);
			seedPersonas(tempDir, SAMPLE_PERSONAS);

			const raw = await captureStdout(async () => {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"create-rp",
					"rp:beth",
					"--persona",
					"beth",
					"--model",
					"claude-opus-4-5",
				]);
			});

			const envelope = parseJsonOutput(raw);
			const agent = (envelope.data as { agent: AgentFileEntry }).agent;
			expect(agent.modelId).toBe("claude-opus-4-5");
		});
	});

	// ── agent create-task ───────────────────────────────────────────

	describe("agent create-task", () => {
		it("creates task agent with defaults", async () => {
			seedAgents(tempDir, []);

			const raw = await captureStdout(async () => {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"create-task",
					"task:worker",
				]);
			});

			const envelope = parseJsonOutput(raw);
			expect(envelope.ok).toBe(true);
			expect(envelope.command).toBe("agent create-task");

			const agent = (envelope.data as { agent: AgentFileEntry }).agent;
			expect(agent.id).toBe("task:worker");
			expect(agent.role).toBe("task_agent");
			expect(agent.lifecycle).toBe("ephemeral");
			expect(agent.userFacing).toBe(false);
			expect(agent.enabled).toBe(true);

			// Verify file was written
			const agents = readAgents(tempDir);
			expect(agents).toHaveLength(1);
			expect(agents[0]!.role).toBe("task_agent");
		});

		it("rejects duplicate agent_id", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			let caught: CliError | undefined;
			try {
				await captureStdout(async () => {
					await dispatch([
						"--json",
						"--cwd",
						tempDir,
						"agent",
						"create-task",
						"task:runner",
					]);
				});
			} catch (err) {
				if (err instanceof CliError) caught = err;
			}
			expect(caught).toBeDefined();
			expect(caught!.code).toBe("AGENT_ALREADY_EXISTS");
		});
	});

	// ── agent enable / disable ──────────────────────────────────────

	describe("agent enable", () => {
		it("enables a disabled agent", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			const raw = await captureStdout(async () => {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"enable",
					"task:runner",
				]);
			});

			const envelope = parseJsonOutput(raw);
			expect(envelope.ok).toBe(true);

			const data = envelope.data as { agent_id: string; enabled: boolean };
			expect(data.agent_id).toBe("task:runner");
			expect(data.enabled).toBe(true);

			// Verify file updated
			const agents = readAgents(tempDir);
			const taskRunner = agents.find((a) => a.id === "task:runner");
			expect(taskRunner?.enabled).toBe(true);
		});

		it("preserves other fields when enabling", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			await captureStdout(async () => {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"enable",
					"task:runner",
				]);
			});

			const agents = readAgents(tempDir);
			const taskRunner = agents.find((a) => a.id === "task:runner");
			expect(taskRunner?.modelId).toBe("claude-3-haiku-20240307");
			expect(taskRunner?.role).toBe("task_agent");
		});

		it("fails if agent not found", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			let caught: CliError | undefined;
			try {
				await captureStdout(async () => {
					await dispatch([
						"--json",
						"--cwd",
						tempDir,
						"agent",
						"enable",
						"nonexistent",
					]);
				});
			} catch (err) {
				if (err instanceof CliError) caught = err;
			}
			expect(caught).toBeDefined();
			expect(caught!.code).toBe("AGENT_NOT_FOUND");
		});
	});

	describe("agent disable", () => {
		it("disables an enabled agent", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			const raw = await captureStdout(async () => {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"disable",
					"maid:main",
				]);
			});

			const envelope = parseJsonOutput(raw);
			expect(envelope.ok).toBe(true);

			const data = envelope.data as { agent_id: string; enabled: boolean };
			expect(data.agent_id).toBe("maid:main");
			expect(data.enabled).toBe(false);

			const agents = readAgents(tempDir);
			const maiden = agents.find((a) => a.id === "maid:main");
			expect(maiden?.enabled).toBe(false);
		});

		it("preserves other fields when disabling", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			await captureStdout(async () => {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"disable",
					"rp:alice",
				]);
			});

			const agents = readAgents(tempDir);
			const alice = agents.find((a) => a.id === "rp:alice");
			expect(alice?.enabled).toBe(false);
			// Must preserve these fields
			expect(alice?.personaId).toBe("alice");
			expect(alice?.role).toBe("rp_agent");
			expect(alice?.toolPermissions).toContain("submit_rp_turn");
		});
	});

	// ── agent remove ────────────────────────────────────────────────

	describe("agent remove", () => {
		it("removes agent with --force", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			const raw = await captureStdout(async () => {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"remove",
					"task:runner",
					"--force",
				]);
			});

			const envelope = parseJsonOutput(raw);
			expect(envelope.ok).toBe(true);

			const data = envelope.data as { agent_id: string; removed: boolean };
			expect(data.agent_id).toBe("task:runner");
			expect(data.removed).toBe(true);

			const agents = readAgents(tempDir);
			expect(agents).toHaveLength(2);
			expect(agents.find((a) => a.id === "task:runner")).toBeUndefined();
		});

		it("rejects without --force", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			let caught: CliError | undefined;
			try {
				await captureStdout(async () => {
					await dispatch([
						"--json",
						"--cwd",
						tempDir,
						"agent",
						"remove",
						"task:runner",
					]);
				});
			} catch (err) {
				if (err instanceof CliError) caught = err;
			}
			expect(caught).toBeDefined();
			expect(caught!.code).toBe("FORCE_REQUIRED");
		});

		it("fails if agent not found", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			let caught: CliError | undefined;
			try {
				await captureStdout(async () => {
					await dispatch([
						"--json",
						"--cwd",
						tempDir,
						"agent",
						"remove",
						"nonexistent",
						"--force",
					]);
				});
			} catch (err) {
				if (err instanceof CliError) caught = err;
			}
			expect(caught).toBeDefined();
			expect(caught!.code).toBe("AGENT_NOT_FOUND");
		});
	});

	// ── agent validate ──────────────────────────────────────────────

	describe("agent validate", () => {
		it("validates all agents successfully", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);
			seedPersonas(tempDir, SAMPLE_PERSONAS);

			const raw = await captureStdout(async () => {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"validate",
				]);
			});

			const envelope = parseJsonOutput(raw);
			expect(envelope.ok).toBe(true);
			expect(envelope.command).toBe("agent validate");

			const diagnostics = (envelope.data as { diagnostics: unknown[] })
				.diagnostics;
			expect(diagnostics).toHaveLength(0);
		});

		it("surfaces RP tool-policy violation", async () => {
			// RP agent with toolPermissions but missing submit_rp_turn
			const agents: AgentFileEntry[] = [
				{
					id: "rp:bad",
					role: "rp_agent",
					personaId: "alice",
					enabled: true,
					toolPermissions: ["some_other_tool"],
				},
			];
			seedAgents(tempDir, agents);
			seedPersonas(tempDir, SAMPLE_PERSONAS);

			const raw = await captureStdout(async () => {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"validate",
				]);
			});

			const envelope = parseJsonOutput(raw);
			expect(envelope.ok).toBe(false);

			const diagnostics = (
				envelope.data as { diagnostics: { code: string }[] }
			).diagnostics;
			expect(diagnostics.length).toBeGreaterThan(0);
			expect(
				diagnostics.some(
					(d) =>
						d.code ===
						"config.rp_missing_submit_rp_turn_permission",
				),
			).toBe(true);
		});

		it("validates a specific agent by id", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);
			seedPersonas(tempDir, SAMPLE_PERSONAS);

			const raw = await captureStdout(async () => {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"validate",
					"rp:alice",
				]);
			});

			const envelope = parseJsonOutput(raw);
			expect(envelope.ok).toBe(true);
			const diagnostics = (envelope.data as { diagnostics: unknown[] })
				.diagnostics;
			expect(diagnostics).toHaveLength(0);
		});

		it("fails if specific agent not found", async () => {
			seedAgents(tempDir, SAMPLE_AGENTS);

			let caught: CliError | undefined;
			try {
				await captureStdout(async () => {
					await dispatch([
						"--json",
						"--cwd",
						tempDir,
						"agent",
						"validate",
						"nonexistent",
					]);
				});
			} catch (err) {
				if (err instanceof CliError) caught = err;
			}
			expect(caught).toBeDefined();
			expect(caught!.code).toBe("AGENT_NOT_FOUND");
		});

		it("detects invalid role", async () => {
			const agents: AgentFileEntry[] = [
				{
					id: "bad:role",
					role: "invalid_role",
					enabled: true,
				},
			];
			seedAgents(tempDir, agents);

			const raw = await captureStdout(async () => {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"validate",
				]);
			});

			const envelope = parseJsonOutput(raw);
			expect(envelope.ok).toBe(false);

			const diagnostics = (
				envelope.data as { diagnostics: { code: string }[] }
			).diagnostics;
			expect(
				diagnostics.some(
					(d) => d.code === "config.invalid_agent_role",
				),
			).toBe(true);
		});

		it("detects missing persona reference", async () => {
			const agents: AgentFileEntry[] = [
				{
					id: "rp:ghost",
					role: "rp_agent",
					personaId: "nonexistent_persona",
					enabled: true,
				},
			];
			seedAgents(tempDir, agents);
			seedPersonas(tempDir, SAMPLE_PERSONAS);

			const raw = await captureStdout(async () => {
				await dispatch([
					"--json",
					"--cwd",
					tempDir,
					"agent",
					"validate",
				]);
			});

			const envelope = parseJsonOutput(raw);
			expect(envelope.ok).toBe(false);

			const diagnostics = (
				envelope.data as { diagnostics: { code: string }[] }
			).diagnostics;
			expect(
				diagnostics.some(
					(d) => d.code === "config.agent_persona_not_found",
				),
			).toBe(true);
		});
	});
});
