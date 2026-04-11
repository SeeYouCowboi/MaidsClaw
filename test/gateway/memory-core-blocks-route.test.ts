import { afterEach, describe, expect, it } from "bun:test";
import type { GatewayContext } from "../../src/gateway/context.js";
import { GatewayServer } from "../../src/gateway/server.js";

type CoreBlock = {
	id: number;
	agent_id: string;
	label: "user" | "index" | "pinned_summary" | "pinned_index" | "persona";
	description: string | null;
	value: string;
	char_limit: number;
	read_only: number;
	updated_at: number;
	chars_current: number;
	chars_limit?: number;
};

describe("memory core-block routes", () => {
	let server: GatewayServer;
	let baseUrl = "";

	function startServer(ctx: GatewayContext): void {
		server = new GatewayServer({
			port: 0,
			host: "localhost",
			context: ctx,
		});
		server.start();
		baseUrl = `http://localhost:${server.getPort()}`;
	}

	afterEach(() => {
		server?.stop();
	});

	it("returns 501 when coreMemory service is unavailable", async () => {
		startServer({});

		const res = await fetch(`${baseUrl}/v1/agents/agent-a/memory/core-blocks`);
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		expect(body.error.message).toContain("coreMemory");
	});

	it("lists core blocks with snake_case fields and content", async () => {
		const blocks: CoreBlock[] = [
			{
				id: 1,
				agent_id: "agent-a",
				label: "persona",
				description: null,
				value: "quiet but attentive maid",
				char_limit: 4000,
				read_only: 0,
				updated_at: 1700000000001,
				chars_current: 24,
			},
			{
				id: 2,
				agent_id: "agent-a",
				label: "index",
				description: null,
				value: "idx entries",
				char_limit: 1500,
				read_only: 1,
				updated_at: 1700000000002,
				chars_current: 11,
			},
		];

		startServer({
			coreMemory: {
				initializeBlocks: async () => undefined,
				getAllBlocks: async () => blocks,
				getBlock: async () => {
					throw new Error("not needed");
				},
				appendBlock: async () => ({ success: true, chars_current: 0, chars_limit: 1 }),
				replaceBlock: async () => ({ success: true, chars_current: 0 }),
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents/agent-a/memory/core-blocks`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			blocks: Array<{
				label: string;
				content: string;
				chars_current: number;
				chars_limit: number;
				read_only: boolean;
				updated_at: number;
			}>;
		};

		expect(body.blocks).toHaveLength(2);
		expect(body.blocks[0]).toEqual({
			label: "persona",
			content: "quiet but attentive maid",
			chars_current: 24,
			chars_limit: 4000,
			read_only: false,
			updated_at: 1700000000001,
		});
		expect(body.blocks[1].read_only).toBe(true);
	});

	it("returns empty list when no core blocks exist", async () => {
		startServer({
			coreMemory: {
				initializeBlocks: async () => undefined,
				getAllBlocks: async () => [],
				getBlock: async () => {
					throw new Error("not needed");
				},
				appendBlock: async () => ({ success: true, chars_current: 0, chars_limit: 1 }),
				replaceBlock: async () => ({ success: true, chars_current: 0 }),
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents/agent-empty/memory/core-blocks`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { blocks: unknown[] };
		expect(body.blocks).toEqual([]);
	});

	it("returns one core block detail", async () => {
		const detail: CoreBlock = {
			id: 10,
			agent_id: "agent-a",
			label: "pinned_summary",
			description: null,
			value: "summary text",
			char_limit: 4000,
			read_only: 0,
			updated_at: 1700000000100,
			chars_current: 12,
			chars_limit: 4000,
		};

		startServer({
			coreMemory: {
				initializeBlocks: async () => undefined,
				getAllBlocks: async () => [],
				getBlock: async () => detail,
				appendBlock: async () => ({ success: true, chars_current: 0, chars_limit: 1 }),
				replaceBlock: async () => ({ success: true, chars_current: 0 }),
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents/agent-a/memory/core-blocks/pinned_summary`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			label: string;
			content: string;
			chars_current: number;
			chars_limit: number;
			read_only: boolean;
			updated_at: number;
		};

		expect(body).toEqual({
			label: "pinned_summary",
			content: "summary text",
			chars_current: 12,
			chars_limit: 4000,
			read_only: false,
			updated_at: 1700000000100,
		});
	});

	it("returns 404 NOT_FOUND when requested core block does not exist", async () => {
		startServer({
			coreMemory: {
				initializeBlocks: async () => undefined,
				getAllBlocks: async () => [],
				getBlock: async () => {
					throw new Error("Block not found: agent-a/persona");
				},
				appendBlock: async () => ({ success: true, chars_current: 0, chars_limit: 1 }),
				replaceBlock: async () => ({ success: true, chars_current: 0 }),
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents/agent-a/memory/core-blocks/persona`);
		expect(res.status).toBe(404);

		const body = (await res.json()) as {
			error: { code: string; message: string; retriable: boolean };
		};
		expect(body.error.code).toBe("NOT_FOUND");
		expect(body.error.retriable).toBe(false);
		expect(body.error.message).toContain("Core memory block not found");
	});

	it("returns pinned summaries from current visible core blocks", async () => {
		const blocks: CoreBlock[] = [
			{
				id: 1,
				agent_id: "agent-z",
				label: "pinned_summary",
				description: null,
				value: "pinned summary value",
				char_limit: 4000,
				read_only: 0,
				updated_at: 1700000000200,
				chars_current: 20,
			},
			{
				id: 2,
				agent_id: "agent-z",
				label: "persona",
				description: null,
				value: "persona snippet",
				char_limit: 4000,
				read_only: 0,
				updated_at: 1700000000300,
				chars_current: 15,
			},
			{
				id: 3,
				agent_id: "agent-z",
				label: "pinned_index",
				description: null,
				value: "should not appear",
				char_limit: 1500,
				read_only: 1,
				updated_at: 1700000000400,
				chars_current: 17,
			},
		];

		startServer({
			coreMemory: {
				initializeBlocks: async () => undefined,
				getAllBlocks: async () => blocks,
				getBlock: async () => {
					throw new Error("not needed");
				},
				appendBlock: async () => ({ success: true, chars_current: 0, chars_limit: 1 }),
				replaceBlock: async () => ({ success: true, chars_current: 0 }),
			},
		});

		const res = await fetch(`${baseUrl}/v1/agents/agent-z/memory/pinned-summaries`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			agent_id: string;
			summaries: Array<{
				label: string;
				content: string;
				chars_current: number;
				updated_at: number;
			}>;
		};

		expect(body.agent_id).toBe("agent-z");
		expect(body.summaries).toEqual([
			{
				label: "pinned_summary",
				content: "pinned summary value",
				chars_current: 20,
				updated_at: 1700000000200,
			},
			{
				label: "persona",
				content: "persona snippet",
				chars_current: 15,
				updated_at: 1700000000300,
			},
		]);
	});
});
