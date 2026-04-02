import { describe, it, expect } from "bun:test";
import { ToolExecutor } from "../../src/core/tools/tool-executor.js";
import { registerMemoryTools, type MemoryToolServices } from "../../src/memory/tools.js";
import { ALL_MEMORY_TOOL_NAMES, READ_ONLY_MEMORY_TOOL_NAMES } from "../../src/memory/tool-names.js";

function stubServices(): MemoryToolServices {
	return {
		coreMemory: {
			appendBlock: () => ({ success: true }),
			replaceBlock: () => ({ success: true }),
		} as unknown as MemoryToolServices["coreMemory"],
		retrieval: {
			readByEntity: () => ({ entity: null, facts: [], events: [], episodes: [] }),
			readByTopic: () => ({ topic: null, events: [], episodes: [] }),
			readByEventIds: () => [],
			readByFactIds: () => [],
			searchVisibleNarrative: async () => [],
		} as unknown as MemoryToolServices["retrieval"],
	};
}

function createExecutorWithMemoryTools(): ToolExecutor {
	const executor = new ToolExecutor();
	registerMemoryTools(
		{
			registerLocal(memTool) {
				executor.registerLocal({
					name: memTool.name,
					description: memTool.description,
					parameters: memTool.parameters,
					effectClass: memTool.effectClass,
					traceVisibility: memTool.traceVisibility,
					executionContract: memTool.executionContract,
					async execute(params, context) {
						const vc = context?.viewerContext;
						if (!vc) {
							throw new Error(
								`Memory tool '${memTool.name}' requires viewerContext`,
							);
						}
						return memTool.handler(
							params as Record<string, unknown>,
							vc,
						);
					},
				});
			},
		},
		stubServices(),
	);
	return executor;
}

describe("registerMemoryTools in ToolExecutor", () => {
	it("registers all 6 memory tools visible in getSchemas()", () => {
		const executor = createExecutorWithMemoryTools();
		const schemas = executor.getSchemas();
		const schemaNames = schemas.map((s) => s.name);

		for (const toolName of ALL_MEMORY_TOOL_NAMES) {
			expect(schemaNames).toContain(toolName);
		}
	});

	it("includes the 4 read-only tools: memory_read, narrative_search, cognition_search, memory_explore", () => {
		const executor = createExecutorWithMemoryTools();
		const schemas = executor.getSchemas();
		const schemaNames = new Set(schemas.map((s) => s.name));

		for (const toolName of READ_ONLY_MEMORY_TOOL_NAMES) {
			expect(schemaNames.has(toolName)).toBe(true);
		}
	});

	it("each registered schema has name, description, and parameters", () => {
		const executor = createExecutorWithMemoryTools();
		const schemas = executor.getSchemas();
		const memorySchemas = schemas.filter((s) =>
			(ALL_MEMORY_TOOL_NAMES as readonly string[]).includes(s.name),
		);

		expect(memorySchemas.length).toBe(ALL_MEMORY_TOOL_NAMES.length);

		for (const schema of memorySchemas) {
			expect(typeof schema.name).toBe("string");
			expect(typeof schema.description).toBe("string");
			expect(schema.parameters).toBeDefined();
		}
	});
});
