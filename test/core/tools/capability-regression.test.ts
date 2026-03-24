import { describe, expect, it } from "bun:test";

import type { AgentProfile } from "../../../src/agents/profile.js";
import type { AgentPermissions } from "../../../src/memory/contracts/agent-permissions.js";
import { getDefaultPermissions } from "../../../src/memory/contracts/agent-permissions.js";
import type { ToolExecutionContract, ToolSchema } from "../../../src/core/tools/tool-definition.js";
import { canExecuteTool, type ToolExecutionContext } from "../../../src/core/tools/tool-access-policy.js";

function makeProfile(overrides?: Partial<AgentProfile>): AgentProfile {
	return {
		id: "test-agent",
		role: "rp_agent",
		lifecycle: "persistent",
		userFacing: true,
		outputMode: "freeform",
		modelId: "test-model",
		toolPermissions: [],
		maxDelegationDepth: 0,
		lorebookEnabled: false,
		narrativeContextEnabled: false,
		...overrides,
	};
}

function makeSchema(name: string, contract?: Partial<ToolExecutionContract>): ToolSchema {
	return {
		name,
		description: `Test tool ${name}`,
		parameters: { type: "object" },
		executionContract: contract
			? {
					effect_type: "read_only",
					turn_phase: "any",
					cardinality: "multiple",
					trace_visibility: "public",
					...contract,
				}
			: undefined,
	};
}

describe("V3 capability regression — rp_agent shared block gate", () => {
	it("rp_agent cannot mutate shared blocks", () => {
		const profile = makeProfile({ role: "rp_agent" });
		const schema = makeSchema("shared_block_edit", {
			capability_requirements: ["shared.block.mutate"],
		});
		const permissions = getDefaultPermissions("rp-1", "rp_agent");
		const ctx: ToolExecutionContext = { schema, permissions };

		expect(permissions.canMutateSharedBlocks).toBe(false);
		expect(canExecuteTool(profile, "shared_block_edit", ctx)).toBe(false);
	});

	it("maiden can mutate shared blocks", () => {
		const profile = makeProfile({ role: "maiden" });
		const schema = makeSchema("shared_block_edit", {
			capability_requirements: ["shared.block.mutate"],
		});
		const permissions = getDefaultPermissions("maiden-1", "maiden");
		const ctx: ToolExecutionContext = { schema, permissions };

		expect(permissions.canMutateSharedBlocks).toBe(true);
		expect(canExecuteTool(profile, "shared_block_edit", ctx)).toBe(true);
	});

	it("task_agent has no capabilities — all 11 fields are false", () => {
		const perms = getDefaultPermissions("task-1", "task_agent");

		const capabilityFields: (keyof AgentPermissions)[] = [
			"canAccessCognition",
			"canWriteCognition",
			"canReadAdminOnly",
			"canReadPrivateMemory",
			"canReadRedactedMemory",
			"canWriteAuthoritatively",
			"canProposePinnedSummary",
			"canCommitPinnedSummary",
			"canReadSharedBlocks",
			"canMutateSharedBlocks",
			"canMutateAdminRules",
		];

		for (const field of capabilityFields) {
			expect(perms[field]).toBe(false);
		}
	});

	it("rp_agent shared.block.read allowed but shared.block.mutate denied", () => {
		const profile = makeProfile({ role: "rp_agent" });
		const permissions = getDefaultPermissions("rp-1", "rp_agent");

		const readSchema = makeSchema("shared_block_read", {
			capability_requirements: ["shared.block.read"],
		});
		const mutateSchema = makeSchema("shared_block_edit", {
			capability_requirements: ["shared.block.mutate"],
		});

		expect(canExecuteTool(profile, "shared_block_read", { schema: readSchema, permissions })).toBe(true);
		expect(canExecuteTool(profile, "shared_block_edit", { schema: mutateSchema, permissions })).toBe(false);
	});
});
