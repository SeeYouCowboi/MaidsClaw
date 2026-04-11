import { describe, expect, it } from "bun:test";
import { getPinnedBlocksAsync, type PromptDataRepos } from "../../src/memory/prompt-data.js";

describe("prompt-data core blocks regression", () => {
	it("renders pinned_summary and persona blocks for prompt consumers", async () => {
		const repos = {
			coreMemoryBlockRepo: {
				getAllBlocks: async () => [
					{
						id: 1,
						agent_id: "agent-1",
						label: "pinned_summary",
						description: null,
						value: "Pinned summary content",
						char_limit: 4000,
						read_only: 0,
						updated_at: 1700000000001,
						chars_current: 22,
					},
					{
						id: 2,
						agent_id: "agent-1",
						label: "persona",
						description: null,
						value: "Persona content",
						char_limit: 4000,
						read_only: 0,
						updated_at: 1700000000002,
						chars_current: 15,
					},
					{
						id: 3,
						agent_id: "agent-1",
						label: "index",
						description: null,
						value: "Should not be rendered",
						char_limit: 1500,
						read_only: 1,
						updated_at: 1700000000003,
						chars_current: 20,
					},
				],
			} as PromptDataRepos["coreMemoryBlockRepo"],
			recentCognitionSlotRepo: {} as PromptDataRepos["recentCognitionSlotRepo"],
			interactionRepo: {} as PromptDataRepos["interactionRepo"],
			sharedBlockRepo: {} as PromptDataRepos["sharedBlockRepo"],
		} as PromptDataRepos;

		const output = await getPinnedBlocksAsync("agent-1", repos);

		expect(output).toContain('<pinned_block label="pinned_summary" chars_current="22" chars_limit="4000">Pinned summary content</pinned_block>');
		expect(output).toContain('<pinned_block label="persona" chars_current="15" chars_limit="4000">Persona content</pinned_block>');
		expect(output).not.toContain("Should not be rendered");
	});

	it("returns empty string when no pinned blocks exist", async () => {
		const repos = {
			coreMemoryBlockRepo: {
				getAllBlocks: async () => [
					{
						id: 1,
						agent_id: "agent-1",
						label: "index",
						description: null,
						value: "Index only",
						char_limit: 1500,
						read_only: 1,
						updated_at: 1700000000001,
						chars_current: 10,
					},
				],
			} as PromptDataRepos["coreMemoryBlockRepo"],
			recentCognitionSlotRepo: {} as PromptDataRepos["recentCognitionSlotRepo"],
			interactionRepo: {} as PromptDataRepos["interactionRepo"],
			sharedBlockRepo: {} as PromptDataRepos["sharedBlockRepo"],
		} as PromptDataRepos;

		const output = await getPinnedBlocksAsync("agent-1", repos);
		expect(output).toBe("");
	});
});
