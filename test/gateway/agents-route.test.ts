import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";
import type { GatewayContext } from "../../src/gateway/context.js";

type AgentResponseItem = {
	id: string;
	display_name: string;
	role: string;
	lifecycle: string;
	user_facing: boolean;
	output_mode: string;
	model_id: string;
	persona_id?: string;
	max_output_tokens?: number;
	tool_permissions: Array<{ tool_name: string; allowed: boolean }>;
	context_budget?: { max_tokens: number; reserved_for_coordination?: number };
	lorebook_enabled: boolean;
	narrative_context_enabled: boolean;
};

function makeAgent(overrides: Partial<{
	id: string;
	role: string;
	lifecycle: string;
	userFacing: boolean;
	outputMode: string;
	modelId: string;
	personaId: string;
	maxOutputTokens: number;
	toolPermissions: Array<{ toolName: string; allowed: boolean }>;
	maxDelegationDepth: number;
	lorebookEnabled: boolean;
	narrativeContextEnabled: boolean;
	contextBudget: { maxTokens: number; reservedForCoordination?: number };
}> = {}) {
	return {
		id: overrides.id ?? "agent-1",
		role: overrides.role ?? "rp_agent",
		lifecycle: overrides.lifecycle ?? "persistent",
		userFacing: overrides.userFacing ?? true,
		outputMode: overrides.outputMode ?? "freeform",
		modelId: overrides.modelId ?? "anthropic/claude-3-5-sonnet",
		personaId: overrides.personaId,
		maxOutputTokens: overrides.maxOutputTokens,
		toolPermissions: overrides.toolPermissions ?? [
			{ toolName: "web_search", allowed: true },
		],
		maxDelegationDepth: overrides.maxDelegationDepth ?? 2,
		lorebookEnabled: overrides.lorebookEnabled ?? true,
		narrativeContextEnabled: overrides.narrativeContextEnabled ?? true,
		contextBudget: overrides.contextBudget,
		authorizationPolicy: { canReadAgentIds: [] },
	};
}

describe("GET /v1/agents", () => {
	let server: GatewayServer;
	let baseUrl: string;

	function startServer(ctx: GatewayContext) {
		server = new GatewayServer({ port: 0, host: "localhost", context: ctx });
		server.start();
		baseUrl = `http://localhost:${server.getPort()}`;
	}

	afterEach(() => {
		server?.stop();
	});

	it("returns 501 when listRuntimeAgents is unavailable", async () => {
		startServer({});

		const res = await fetch(`${baseUrl}/v1/agents`);
		expect(res.status).toBe(501);

		const body = (await res.json()) as {
			error: { code: string; retriable: boolean; message: string };
		};
		expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		expect(body.error.retriable).toBe(false);
		expect(body.error.message).toContain("listRuntimeAgents");
	});

	it("resolves display_name from persona when available", async () => {
		const agent = makeAgent({ id: "maid-sakura", personaId: "persona-sakura" });

		startServer({
			listRuntimeAgents: async () => [agent],
			personaAdmin: {
				listPersonas: async () => [],
				getPersona: async (id: string) => {
					if (id === "persona-sakura") {
						return { id: "persona-sakura", name: "Sakura", description: "", persona: "" };
					}
					return null;
				},
				createPersona: async () => ({}),
				updatePersona: async () => ({}),
				deletePersona: async () => ({}),
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as { agents: AgentResponseItem[] };
		expect(body.agents).toHaveLength(1);
		expect(body.agents[0].display_name).toBe("Sakura");
		expect(body.agents[0].persona_id).toBe("persona-sakura");
	});

	it("falls back to agent.id when persona is missing", async () => {
		const agent = makeAgent({ id: "maid-luna", personaId: "persona-missing" });

		startServer({
			listRuntimeAgents: async () => [agent],
			personaAdmin: {
				listPersonas: async () => [],
				getPersona: async () => null,
				createPersona: async () => ({}),
				updatePersona: async () => ({}),
				deletePersona: async () => ({}),
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as { agents: AgentResponseItem[] };
		expect(body.agents[0].display_name).toBe("maid-luna");
	});

	it("falls back to agent.id when persona lookup throws", async () => {
		const agent = makeAgent({ id: "maid-error", personaId: "persona-boom" });

		startServer({
			listRuntimeAgents: async () => [agent],
			personaAdmin: {
				listPersonas: async () => [],
				getPersona: async () => {
					throw new Error("persona store offline");
				},
				createPersona: async () => ({}),
				updatePersona: async () => ({}),
				deletePersona: async () => ({}),
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as { agents: AgentResponseItem[] };
		expect(body.agents[0].display_name).toBe("maid-error");
	});

	it("uses agent.id as display_name when no personaId set", async () => {
		const agent = makeAgent({ id: "task-worker-1" });

		startServer({
			listRuntimeAgents: async () => [agent],
		});

		const res = await fetch(`${baseUrl}/v1/agents`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as { agents: AgentResponseItem[] };
		expect(body.agents[0].display_name).toBe("task-worker-1");
		expect(body.agents[0].persona_id).toBeUndefined();
	});

	it("uses agent.id as display_name when personaAdmin is absent", async () => {
		const agent = makeAgent({ id: "maid-no-admin", personaId: "persona-x" });

		startServer({
			listRuntimeAgents: async () => [agent],
		});

		const res = await fetch(`${baseUrl}/v1/agents`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as { agents: AgentResponseItem[] };
		expect(body.agents[0].display_name).toBe("maid-no-admin");
	});

	it("returns multiple agents with mixed persona resolution", async () => {
		const agents = [
			makeAgent({ id: "maid-a", personaId: "p-a" }),
			makeAgent({ id: "maid-b" }),
			makeAgent({ id: "maid-c", personaId: "p-c" }),
		];

		startServer({
			listRuntimeAgents: async () => agents,
			personaAdmin: {
				listPersonas: async () => [],
				getPersona: async (id: string) => {
					if (id === "p-a") return { id: "p-a", name: "Alice", description: "", persona: "" };
					if (id === "p-c") return { id: "p-c", name: "Carol", description: "", persona: "" };
					return null;
				},
				createPersona: async () => ({}),
				updatePersona: async () => ({}),
				deletePersona: async () => ({}),
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as { agents: AgentResponseItem[] };
		expect(body.agents).toHaveLength(3);
		expect(body.agents[0].display_name).toBe("Alice");
		expect(body.agents[1].display_name).toBe("maid-b");
		expect(body.agents[2].display_name).toBe("Carol");
	});
});
