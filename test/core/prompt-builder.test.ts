import { describe, expect, it } from "bun:test";

import type { AgentProfile } from "../../src/agents/profile.js";
import { AreaStateResolver } from "../../src/core/area-state-resolver.js";
import { MaidsClawError } from "../../src/core/errors.js";
import type { ChatMessage } from "../../src/core/models/chat-provider.js";
import { PromptBuilder } from "../../src/core/prompt-builder.js";
import type {
	LoreDataSource,
	MemoryDataSource,
	OperationalDataSource,
	PersonaDataSource,
	ViewerContext,
} from "../../src/core/prompt-data-sources.js";
import { PromptSectionSlot } from "../../src/core/prompt-template.js";
import type { TokenBudget } from "../../src/core/token-budget.js";

const BASE_BUDGET: TokenBudget = {
	maxContextTokens: 8000,
	maxOutputTokens: 1000,
	coordinationReserve: 0,
	inputBudget: 6000,
	role: "rp_agent",
};

const BASE_VIEWER_CONTEXT: ViewerContext = {
	viewer_agent_id: "agent.alpha",
	viewer_role: "rp_agent",
	current_area_id: 101,
	session_id: "session-1",
};

const CONVERSATION: ChatMessage[] = [
	{ role: "user", content: "hello" },
	{ role: "assistant", content: "hi" },
];

function makeProfile(overrides?: Partial<AgentProfile>): AgentProfile {
	return {
		id: "agent.alpha",
		role: "rp_agent",
		lifecycle: "persistent",
		userFacing: true,
		outputMode: "freeform",
		modelId: "test-model",
		toolPermissions: [],
		maxDelegationDepth: 1,
		lorebookEnabled: false,
		narrativeContextEnabled: false,
		...overrides,
	};
}

function makeDataSources(): {
	persona: PersonaDataSource;
	lore: LoreDataSource;
	memory: MemoryDataSource;
	operational: OperationalDataSource;
} {
	return {
		persona: {
			getSystemPrompt: (personaId: string) => `Persona ${personaId}`,
		},
		lore: {
			getMatchingEntries: (_text: string) => [
				{ title: "Lore Trigger", content: "Triggered lore content." },
			],
			getWorldRules: () => [
				{ title: "World Rule", content: "No breaking canon." },
			],
		},
		memory: {
			getCoreMemoryBlocks: (agentId: string) =>
				`<core_memory>${agentId}</core_memory>`,
			getMemoryHints: async (userMessage: string) => `hint for ${userMessage}`,
		},
		operational: {
			getExcerpt: (_keys: string[]) => ({
				"session.phase": "active",
				"delegation.depth": 1,
			}),
		},
	};
}

function getSectionContent(
	sections: Array<{ slot: PromptSectionSlot; content: string }>,
	slot: PromptSectionSlot,
): string | undefined {
	const section = sections.find((item) => item.slot === slot);
	return section?.content;
}

describe("PromptBuilder", () => {
	it("builds maiden prompt with world/lore/operational and without core-memory/memory-hints", async () => {
		const dataSources = makeDataSources();
		const builder = new PromptBuilder(dataSources);

		const output = await builder.build({
			profile: makeProfile({ role: "maiden", personaId: "maiden-card" }),
			viewerContext: { ...BASE_VIEWER_CONTEXT, viewer_role: "maiden" },
			userMessage: "what is happening",
			conversationMessages: CONVERSATION,
			budget: { ...BASE_BUDGET, role: "maiden" },
		});

		const slots = output.sections.map((section) => section.slot);
		expect(slots.includes(PromptSectionSlot.WORLD_RULES)).toBe(true);
		expect(slots.includes(PromptSectionSlot.LORE_ENTRIES)).toBe(true);
		expect(slots.includes(PromptSectionSlot.OPERATIONAL_STATE)).toBe(true);
		expect(slots.includes(PromptSectionSlot.CORE_MEMORY)).toBe(false);
		expect(slots.includes(PromptSectionSlot.MEMORY_HINTS)).toBe(false);

		const operational =
			getSectionContent(output.sections, PromptSectionSlot.OPERATIONAL_STATE) ??
			"";
		expect(operational.length > 0).toBe(true);
	});

	it("builds rp-agent prompt with core-memory/memory-hints/world/lore and without operational-state", async () => {
		const dataSources = makeDataSources();
		const builder = new PromptBuilder(dataSources);

		const output = await builder.build({
			profile: makeProfile({ role: "rp_agent", personaId: "hero-card" }),
			viewerContext: BASE_VIEWER_CONTEXT,
			userMessage: "remember this",
			conversationMessages: CONVERSATION,
			budget: BASE_BUDGET,
		});

		const slots = output.sections.map((section) => section.slot);
		expect(slots.includes(PromptSectionSlot.CORE_MEMORY)).toBe(true);
		expect(slots.includes(PromptSectionSlot.MEMORY_HINTS)).toBe(true);
		expect(slots.includes(PromptSectionSlot.WORLD_RULES)).toBe(true);
		expect(slots.includes(PromptSectionSlot.LORE_ENTRIES)).toBe(true);
		expect(slots.includes(PromptSectionSlot.OPERATIONAL_STATE)).toBe(false);
	});

	it("builds task-agent prompt with lorebook disabled using only preamble and conversation", async () => {
		const dataSources = makeDataSources();
		const builder = new PromptBuilder(dataSources);

		const output = await builder.build({
			profile: makeProfile({
				role: "task_agent",
				lorebookEnabled: false,
				narrativeContextEnabled: false,
			}),
			viewerContext: { ...BASE_VIEWER_CONTEXT, viewer_role: "task_agent" },
			userMessage: "execute task",
			conversationMessages: CONVERSATION,
			budget: { ...BASE_BUDGET, role: "task_agent" },
		});

		const slots = output.sections.map((section) => section.slot);
		expect(slots.length).toBe(2);
		expect(slots.includes(PromptSectionSlot.SYSTEM_PREAMBLE)).toBe(true);
		expect(slots.includes(PromptSectionSlot.CONVERSATION)).toBe(true);
	});

	it("builds task-agent prompt with lorebook+narrative context enabled", async () => {
		const dataSources = makeDataSources();
		const builder = new PromptBuilder(dataSources);

		const output = await builder.build({
			profile: makeProfile({
				role: "task_agent",
				lorebookEnabled: true,
				narrativeContextEnabled: true,
			}),
			viewerContext: { ...BASE_VIEWER_CONTEXT, viewer_role: "task_agent" },
			userMessage: "check lore",
			conversationMessages: CONVERSATION,
			budget: { ...BASE_BUDGET, role: "task_agent" },
		});

		const slots = output.sections.map((section) => section.slot);
		expect(slots.includes(PromptSectionSlot.WORLD_RULES)).toBe(true);
		expect(slots.includes(PromptSectionSlot.LORE_ENTRIES)).toBe(true);
	});

	it("throws PROMPT_BUILDER_DATA_SOURCE_ERROR when rp-agent persona is required but missing", async () => {
		const dataSources = makeDataSources();
		dataSources.persona.getSystemPrompt = (_personaId: string) => undefined;
		const builder = new PromptBuilder(dataSources);

		let threw = false;
		try {
			await builder.build({
				profile: makeProfile({ role: "rp_agent", personaId: "missing-card" }),
				viewerContext: BASE_VIEWER_CONTEXT,
				userMessage: "hello",
				conversationMessages: CONVERSATION,
				budget: BASE_BUDGET,
			});
		} catch (err) {
			threw = true;
			expect(err instanceof MaidsClawError).toBe(true);
			const mcErr = err as MaidsClawError;
			expect(mcErr.code).toBe("PROMPT_BUILDER_DATA_SOURCE_ERROR");
		}

		expect(threw).toBe(true);
	});

	it("wraps data-source throw as PROMPT_BUILDER_DATA_SOURCE_ERROR", async () => {
		const dataSources = makeDataSources();
		dataSources.lore.getMatchingEntries = (_text: string) => {
			throw new Error("lore source failed");
		};
		const builder = new PromptBuilder(dataSources);

		let threw = false;
		try {
			await builder.build({
				profile: makeProfile({ role: "rp_agent" }),
				viewerContext: BASE_VIEWER_CONTEXT,
				userMessage: "hello",
				conversationMessages: CONVERSATION,
				budget: BASE_BUDGET,
			});
		} catch (err) {
			threw = true;
			expect(err instanceof MaidsClawError).toBe(true);
			const mcErr = err as MaidsClawError;
			expect(mcErr.code).toBe("PROMPT_BUILDER_DATA_SOURCE_ERROR");
		}

		expect(threw).toBe(true);
	});
});

describe("AreaStateResolver", () => {
	it("classifies event origins into prompt-safe classes", () => {
		const resolver = new AreaStateResolver();

		const runtime = resolver.resolve({
			eventId: "e1",
			content: "runtime",
			eventOrigin: "runtime_projection",
		});
		const delayed = resolver.resolve({
			eventId: "e2",
			content: "delayed",
			eventOrigin: "delayed_materialization",
		});
		const promoted = resolver.resolve({
			eventId: "e3",
			content: "promoted",
			eventOrigin: "promotion",
		});

		expect(runtime.classification).toBe("live_perception");
		expect(delayed.classification).toBe("historical_recall");
		expect(promoted.classification).toBe("promoted");
	});

	it("formats classified events into non-empty prompt output", () => {
		const resolver = new AreaStateResolver();
		const resolved = resolver.resolveMany([
			{
				eventId: "e1",
				content: "A door opens",
				eventOrigin: "runtime_projection",
			},
			{
				eventId: "e2",
				content: "Someone entered before",
				eventOrigin: "delayed_materialization",
			},
		]);

		const output = resolver.formatForPrompt(resolved);
		expect(output.length > 0).toBe(true);
		expect(output.includes("live_perception")).toBe(true);
		expect(output.includes("historical_recall")).toBe(true);
	});
});
