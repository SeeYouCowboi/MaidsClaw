import { afterEach, describe, expect, it } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";
import type { GatewayContext } from "../../src/gateway/context.js";

const ALLOWED_FIELDS = new Set([
	"id",
	"display_name",
	"role",
	"lifecycle",
	"user_facing",
	"output_mode",
	"model_id",
	"persona_id",
	"max_output_tokens",
	"tool_permissions",
	"context_budget",
	"lorebook_enabled",
	"narrative_context_enabled",
]);

const FORBIDDEN_FIELDS = [
	"authorizationPolicy",
	"authorization_policy",
	"canReadAgentIds",
	"can_read_agent_ids",
	"maxDelegationDepth",
	"max_delegation_depth",
	"detachable",
	"conversationHistoryMode",
	"conversation_history_mode",
	"retrievalTemplate",
	"retrieval_template",
	"writeTemplate",
	"write_template",
];

function makeFullAgent() {
	return {
		id: "maid-shape-test",
		role: "rp_agent",
		lifecycle: "persistent",
		userFacing: true,
		outputMode: "freeform",
		modelId: "anthropic/claude-3-5-sonnet",
		personaId: "persona-shape",
		maxOutputTokens: 4096,
		toolPermissions: [
			{ toolName: "web_search", allowed: true },
			{ toolName: "code_exec", allowed: false },
		],
		maxDelegationDepth: 3,
		lorebookEnabled: true,
		narrativeContextEnabled: false,
		contextBudget: { maxTokens: 8000, reservedForCoordination: 500 },
		authorizationPolicy: { canReadAgentIds: ["maid-a", "maid-b"] },
		detachable: true,
		conversationHistoryMode: "full",
		retrievalTemplate: { kind: "default" },
		writeTemplate: { kind: "default" },
	};
}

describe("GET /v1/agents — response shape allowlist", () => {
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

	it("response contains only allowlisted fields", async () => {
		startServer({
			listRuntimeAgents: async () => [makeFullAgent()],
			personaAdmin: {
				listPersonas: async () => [],
				getPersona: async () => ({
					id: "persona-shape",
					name: "ShapeTest",
					description: "",
					persona: "",
				}),
				createPersona: async () => ({}),
				updatePersona: async () => ({}),
				deletePersona: async () => ({}),
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as { agents: Record<string, unknown>[] };
		expect(body.agents).toHaveLength(1);

		const agent = body.agents[0];
		const actualKeys = new Set(Object.keys(agent));

		for (const key of actualKeys) {
			expect(ALLOWED_FIELDS.has(key)).toBe(true);
		}
	});

	it("does not include internal authorization fields", async () => {
		startServer({
			listRuntimeAgents: async () => [makeFullAgent()],
		});

		const res = await fetch(`${baseUrl}/v1/agents`);
		const body = (await res.json()) as { agents: Record<string, unknown>[] };
		const agent = body.agents[0];

		for (const field of FORBIDDEN_FIELDS) {
			expect(agent[field]).toBeUndefined();
		}
	});

	it("tool_permissions is array of { tool_name, allowed }", async () => {
		startServer({
			listRuntimeAgents: async () => [makeFullAgent()],
		});

		const res = await fetch(`${baseUrl}/v1/agents`);
		const body = (await res.json()) as {
			agents: Array<{
				tool_permissions: Array<{ tool_name: string; allowed: boolean }>;
			}>;
		};

		const perms = body.agents[0].tool_permissions;
		expect(Array.isArray(perms)).toBe(true);
		expect(perms).toHaveLength(2);

		expect(perms[0]).toEqual({ tool_name: "web_search", allowed: true });
		expect(perms[1]).toEqual({ tool_name: "code_exec", allowed: false });
	});

	it("context_budget uses snake_case fields", async () => {
		startServer({
			listRuntimeAgents: async () => [makeFullAgent()],
		});

		const res = await fetch(`${baseUrl}/v1/agents`);
		const body = (await res.json()) as {
			agents: Array<{
				context_budget?: {
					max_tokens: number;
					reserved_for_coordination?: number;
				};
			}>;
		};

		const budget = body.agents[0].context_budget;
		expect(budget).toBeDefined();
		expect(budget!.max_tokens).toBe(8000);
		expect(budget!.reserved_for_coordination).toBe(500);
	});

	it("optional fields are omitted when undefined on agent", async () => {
		const minimalAgent = {
			id: "minimal-agent",
			role: "task_agent",
			lifecycle: "ephemeral",
			userFacing: false,
			outputMode: "structured",
			modelId: "openai/gpt-4o",
			toolPermissions: [],
			maxDelegationDepth: 1,
			lorebookEnabled: false,
			narrativeContextEnabled: false,
		};

		startServer({
			listRuntimeAgents: async () => [minimalAgent],
		});

		const res = await fetch(`${baseUrl}/v1/agents`);
		const body = (await res.json()) as { agents: Record<string, unknown>[] };
		const agent = body.agents[0];

		expect(agent.persona_id).toBeUndefined();
		expect(agent.max_output_tokens).toBeUndefined();
		expect(agent.context_budget).toBeUndefined();
	});

	it("top-level response is { agents: [...] }", async () => {
		startServer({
			listRuntimeAgents: async () => [],
		});

		const res = await fetch(`${baseUrl}/v1/agents`);
		const body = (await res.json()) as Record<string, unknown>;

		expect(Object.keys(body)).toEqual(["agents"]);
		expect(Array.isArray(body.agents)).toBe(true);
	});
});
