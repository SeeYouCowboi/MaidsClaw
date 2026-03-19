import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentFileEntry } from "../../src/app/config/agents/agent-file-store.js";
import {
	loadFileAgents,
	validateAgentFile,
	type AgentDiagnostic,
} from "../../src/app/config/agents/agent-loader.js";

// ─── Temp directory helpers ──────────────────────────────────

const tempRoots: string[] = [];

function createTempDir(): string {
	const tempRoot = join(
		import.meta.dir,
		`../../.tmp-agent-loader-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	const configDir = join(tempRoot, "config");
	mkdirSync(configDir, { recursive: true });
	tempRoots.push(tempRoot);
	return tempRoot;
}

afterEach(() => {
	for (const tempRoot of tempRoots.splice(0, tempRoots.length)) {
		try {
			rmSync(tempRoot, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	}
});

// ─── Helper: write agents file ───────────────────────────────

function writeAgents(tmpRoot: string, entries: AgentFileEntry[]): string {
	const filePath = join(tmpRoot, "config", "agents.json");
	writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
	return filePath;
}

// ─── validateAgentFile ───────────────────────────────────────

describe("validateAgentFile", () => {
	it("valid RP agent with submit_rp_turn passes", () => {
		const entries: AgentFileEntry[] = [
			{
				id: "rp:alice",
				role: "rp_agent",
				modelId: "claude-3-5-sonnet-20241022",
				personaId: "alice",
				toolPermissions: [
					"memory_read",
					"memory_search",
					"submit_rp_turn",
				],
			},
		];

		const diagnostics = validateAgentFile(entries, ["alice"]);
		expect(diagnostics).toHaveLength(0);
	});

	it("RP agent with empty toolPermissions passes (allow-all semantics)", () => {
		const entries: AgentFileEntry[] = [
			{
				id: "rp:bob",
				role: "rp_agent",
				modelId: "claude-3-5-sonnet-20241022",
				toolPermissions: [],
			},
		];

		const diagnostics = validateAgentFile(entries);
		expect(diagnostics).toHaveLength(0);
	});

	it("RP agent missing submit_rp_turn fails with config.rp_missing_submit_rp_turn_permission", () => {
		const entries: AgentFileEntry[] = [
			{
				id: "rp:bad",
				role: "rp_agent",
				toolPermissions: ["memory_read", "memory_search"],
			},
		];

		const diagnostics = validateAgentFile(entries);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]!.code).toBe(
			"config.rp_missing_submit_rp_turn_permission",
		);
		expect(diagnostics[0]!.agentId).toBe("rp:bad");
	});

	it("duplicate agent IDs fail with config.duplicate_agent_id", () => {
		const entries: AgentFileEntry[] = [
			{ id: "rp:dup", role: "rp_agent" },
			{ id: "rp:dup", role: "rp_agent" },
		];

		const diagnostics = validateAgentFile(entries);
		const dupDiags = diagnostics.filter(
			(d) => d.code === "config.duplicate_agent_id",
		);
		expect(dupDiags).toHaveLength(1);
		expect(dupDiags[0]!.agentId).toBe("rp:dup");
	});

	it("invalid role fails with config.invalid_agent_role", () => {
		const entries: AgentFileEntry[] = [
			{ id: "bad:role", role: "unknown_role" },
		];

		const diagnostics = validateAgentFile(entries);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]!.code).toBe("config.invalid_agent_role");
		expect(diagnostics[0]!.agentId).toBe("bad:role");
	});

	it("missing persona ref fails with config.agent_persona_not_found", () => {
		const entries: AgentFileEntry[] = [
			{
				id: "rp:ref",
				role: "rp_agent",
				personaId: "nonexistent_persona",
			},
		];

		const diagnostics = validateAgentFile(entries, ["alice", "bob"]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]!.code).toBe("config.agent_persona_not_found");
	});

	it("persona ref check is skipped when personaIds is not provided", () => {
		const entries: AgentFileEntry[] = [
			{
				id: "rp:ref",
				role: "rp_agent",
				personaId: "nonexistent_persona",
			},
		];

		const diagnostics = validateAgentFile(entries);
		expect(diagnostics).toHaveLength(0);
	});

	it("multiple errors reported together", () => {
		const entries: AgentFileEntry[] = [
			{ id: "bad:role", role: "wizard" },
			{ id: "dup:1", role: "maiden" },
			{ id: "dup:1", role: "maiden" },
			{
				id: "rp:no-submit",
				role: "rp_agent",
				toolPermissions: ["memory_read"],
			},
		];

		const diagnostics = validateAgentFile(entries);
		expect(diagnostics.length).toBeGreaterThanOrEqual(3);

		const codes = diagnostics.map((d) => d.code);
		expect(codes).toContain("config.invalid_agent_role");
		expect(codes).toContain("config.duplicate_agent_id");
		expect(codes).toContain("config.rp_missing_submit_rp_turn_permission");
	});
});

// ─── loadFileAgents ──────────────────────────────────────────

describe("loadFileAgents", () => {
	it("returns empty arrays when file does not exist", () => {
		const result = loadFileAgents("/nonexistent/path/agents.json");
		expect(result.agents).toHaveLength(0);
		expect(result.diagnostics).toHaveLength(0);
	});

	it("loads valid agents and normalizes modelId", () => {
		const tmpRoot = createTempDir();
		const filePath = writeAgents(tmpRoot, [
			{
				id: "rp:test",
				role: "rp_agent",
				modelId: "claude-3-5-sonnet-20241022",
				personaId: "alice",
			},
		]);

		const result = loadFileAgents(filePath);
		expect(result.agents).toHaveLength(1);
		expect(result.diagnostics).toHaveLength(0);
		// modelId should be normalized with anthropic/ prefix
		expect(result.agents[0]!.modelId).toBe(
			"anthropic/claude-3-5-sonnet-20241022",
		);
	});

	it("treats missing enabled as true", () => {
		const tmpRoot = createTempDir();
		const filePath = writeAgents(tmpRoot, [
			{ id: "rp:enabled-default", role: "rp_agent" },
		]);

		const result = loadFileAgents(filePath);
		expect(result.agents).toHaveLength(1);
	});

	it("skips disabled agents", () => {
		const tmpRoot = createTempDir();
		const filePath = writeAgents(tmpRoot, [
			{ id: "rp:disabled", role: "rp_agent", enabled: false },
			{ id: "rp:enabled", role: "rp_agent", enabled: true },
		]);

		const result = loadFileAgents(filePath);
		expect(result.agents).toHaveLength(1);
		expect(result.agents[0]!.id).toBe("rp:enabled");
	});

	it("skips agents with fatal validation errors but still reports diagnostics", () => {
		const tmpRoot = createTempDir();
		const filePath = writeAgents(tmpRoot, [
			{ id: "bad:role", role: "wizard" },
			{ id: "rp:good", role: "rp_agent" },
		]);

		const result = loadFileAgents(filePath);
		expect(result.agents).toHaveLength(1);
		expect(result.agents[0]!.id).toBe("rp:good");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]!.code).toBe("config.invalid_agent_role");
	});

	it("applies role defaults for missing fields", () => {
		const tmpRoot = createTempDir();
		const filePath = writeAgents(tmpRoot, [
			{ id: "task:minimal", role: "task_agent" },
		]);

		const result = loadFileAgents(filePath);
		expect(result.agents).toHaveLength(1);
		const profile = result.agents[0]!;
		expect(profile.lifecycle).toBe("ephemeral");
		expect(profile.userFacing).toBe(false);
		expect(profile.outputMode).toBe("structured");
		expect(profile.maxDelegationDepth).toBe(0);
		expect(profile.lorebookEnabled).toBe(false);
		expect(profile.narrativeContextEnabled).toBe(false);
	});
});
