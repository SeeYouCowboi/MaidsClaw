/**
 * @file Stress tests for V3 tool capability enforcement.
 * Covers capability_requirements gating, cardinality enforcement (once, at_most_once, multiple),
 * and full CAPABILITY_MAP validation against AgentPermissions fields.
 */
import { describe, it, expect } from "bun:test";
import {
	canExecuteTool,
	CAPABILITY_MAP,
	type ToolExecutionContext,
} from "../core/tools/tool-access-policy.js";
import type { AgentProfile, ToolPermission } from "../agents/profile.js";
import type { AgentPermissions } from "./contracts/agent-permissions.js";
import type { ToolSchema, ToolExecutionContract } from "../core/tools/tool-definition.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
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

function makePermissions(overrides: Partial<AgentPermissions> = {}): AgentPermissions {
	return {
		agentId: "test-agent",
		canAccessCognition: false,
		canWriteCognition: false,
		canReadAdminOnly: false,
		canReadPrivateMemory: false,
		canReadRedactedMemory: false,
		canWriteAuthoritatively: false,
		canProposePinnedSummary: false,
		canCommitPinnedSummary: false,
		canReadSharedBlocks: false,
		canMutateSharedBlocks: false,
		canMutateAdminRules: false,
		...overrides,
	};
}

function makeSchema(
	name: string,
	contract?: Partial<ToolExecutionContract>,
): ToolSchema {
	return {
		name,
		description: `Test tool: ${name}`,
		parameters: { type: "object" },
		executionContract: contract
			? {
					effect_type: "read_only",
					turn_phase: "in_turn",
					cardinality: "multiple",
					trace_visibility: "public",
					...contract,
				}
			: undefined,
	};
}

function makeContext(
	schema: ToolSchema,
	permissions: AgentPermissions,
	turnToolsUsed?: Set<string>,
): ToolExecutionContext {
	return {
		schema,
		permissions,
		turnToolsUsed: turnToolsUsed ?? new Set<string>(),
	};
}

// ── capability_requirements gate ────────────────────────────────────────────

describe("stress: capability_requirements gate", () => {
	it("tool with cognition_write requirement rejected for read-only agent", () => {
		const profile = makeProfile(); // empty toolPermissions = allow-all
		const schema = makeSchema("write-cognition", {
			capability_requirements: ["cognition_write"],
		});
		const permissions = makePermissions({ canWriteCognition: false });
		const ctx = makeContext(schema, permissions);

		expect(canExecuteTool(profile, "write-cognition", ctx)).toBe(false);
	});

	it("tool with cognition_write requirement allowed for agent with canWriteCognition", () => {
		const profile = makeProfile();
		const schema = makeSchema("write-cognition", {
			capability_requirements: ["cognition_write"],
		});
		const permissions = makePermissions({ canWriteCognition: true });
		const ctx = makeContext(schema, permissions);

		expect(canExecuteTool(profile, "write-cognition", ctx)).toBe(true);
	});

	it("tool with multiple capability_requirements fails if ANY requirement is unmet", () => {
		const profile = makeProfile();
		const schema = makeSchema("multi-cap", {
			capability_requirements: ["cognition_read", "cognition_write"],
		});
		// Has read but not write
		const permissions = makePermissions({ canAccessCognition: true, canWriteCognition: false });
		const ctx = makeContext(schema, permissions);

		expect(canExecuteTool(profile, "multi-cap", ctx)).toBe(false);
	});

	it("tool with multiple capability_requirements succeeds when all are met", () => {
		const profile = makeProfile();
		const schema = makeSchema("multi-cap", {
			capability_requirements: ["cognition_read", "cognition_write"],
		});
		const permissions = makePermissions({ canAccessCognition: true, canWriteCognition: true });
		const ctx = makeContext(schema, permissions);

		expect(canExecuteTool(profile, "multi-cap", ctx)).toBe(true);
	});

	it("tool with no capability_requirements passes capability check regardless of permissions", () => {
		const profile = makeProfile();
		const schema = makeSchema("no-caps", { capability_requirements: [] });
		const permissions = makePermissions(); // all false
		const ctx = makeContext(schema, permissions);

		expect(canExecuteTool(profile, "no-caps", ctx)).toBe(true);
	});
});

// ── cardinality: once ───────────────────────────────────────────────────────

describe("stress: cardinality once", () => {
	it("first call to once-cardinality tool is allowed", () => {
		const profile = makeProfile();
		const schema = makeSchema("once-tool", { cardinality: "once" });
		const permissions = makePermissions();
		const turnToolsUsed = new Set<string>();
		const ctx = makeContext(schema, permissions, turnToolsUsed);

		expect(canExecuteTool(profile, "once-tool", ctx)).toBe(true);
		expect(turnToolsUsed.has("once-tool")).toBe(true);
	});

	it("second call to once-cardinality tool is blocked", () => {
		const profile = makeProfile();
		const schema = makeSchema("once-tool", { cardinality: "once" });
		const permissions = makePermissions();
		const turnToolsUsed = new Set<string>();

		// First call
		const ctx1 = makeContext(schema, permissions, turnToolsUsed);
		expect(canExecuteTool(profile, "once-tool", ctx1)).toBe(true);

		// Second call — same turnToolsUsed set
		const ctx2 = makeContext(schema, permissions, turnToolsUsed);
		expect(canExecuteTool(profile, "once-tool", ctx2)).toBe(false);
	});

	it("once-cardinality does not block different tool names", () => {
		const profile = makeProfile();
		const schemaA = makeSchema("once-A", { cardinality: "once" });
		const schemaB = makeSchema("once-B", { cardinality: "once" });
		const permissions = makePermissions();
		const turnToolsUsed = new Set<string>();

		const ctxA = makeContext(schemaA, permissions, turnToolsUsed);
		expect(canExecuteTool(profile, "once-A", ctxA)).toBe(true);

		const ctxB = makeContext(schemaB, permissions, turnToolsUsed);
		expect(canExecuteTool(profile, "once-B", ctxB)).toBe(true);
	});
});

// ── cardinality: at_most_once ───────────────────────────────────────────────

describe("stress: cardinality at_most_once", () => {
	it("at_most_once behaves same as once — first allowed, second blocked", () => {
		const profile = makeProfile();
		const schema = makeSchema("amo-tool", { cardinality: "at_most_once" });
		const permissions = makePermissions();
		const turnToolsUsed = new Set<string>();

		const ctx1 = makeContext(schema, permissions, turnToolsUsed);
		expect(canExecuteTool(profile, "amo-tool", ctx1)).toBe(true);

		const ctx2 = makeContext(schema, permissions, turnToolsUsed);
		expect(canExecuteTool(profile, "amo-tool", ctx2)).toBe(false);
	});

	it("at_most_once resets across turns (fresh turnToolsUsed set)", () => {
		const profile = makeProfile();
		const schema = makeSchema("amo-tool", { cardinality: "at_most_once" });
		const permissions = makePermissions();

		// Turn 1
		const turn1Used = new Set<string>();
		const ctx1 = makeContext(schema, permissions, turn1Used);
		expect(canExecuteTool(profile, "amo-tool", ctx1)).toBe(true);

		// Turn 2 — fresh set
		const turn2Used = new Set<string>();
		const ctx2 = makeContext(schema, permissions, turn2Used);
		expect(canExecuteTool(profile, "amo-tool", ctx2)).toBe(true);
	});
});

// ── cardinality: multiple ───────────────────────────────────────────────────

describe("stress: cardinality multiple", () => {
	it("multiple-cardinality tool allows repeated calls in same turn", () => {
		const profile = makeProfile();
		const schema = makeSchema("multi-tool", { cardinality: "multiple" });
		const permissions = makePermissions();
		const turnToolsUsed = new Set<string>();

		for (let i = 0; i < 5; i++) {
			const ctx = makeContext(schema, permissions, turnToolsUsed);
			expect(canExecuteTool(profile, "multi-tool", ctx)).toBe(true);
		}
	});

	it("tool without executionContract is always allowed (no context check)", () => {
		const profile = makeProfile();
		const schema: ToolSchema = {
			name: "bare-tool",
			description: "No contract",
			parameters: { type: "object" },
		};

		// No execution context at all
		expect(canExecuteTool(profile, "bare-tool")).toBe(true);

		// With context but no contract on schema
		expect(
			canExecuteTool(profile, "bare-tool", {
				schema,
				permissions: makePermissions(),
				turnToolsUsed: new Set<string>(),
			}),
		).toBe(true);
	});
});

// ── Full capability matrix ──────────────────────────────────────────────────

describe("stress: full CAPABILITY_MAP validation", () => {
	it("all CAPABILITY_MAP entries map to valid AgentPermissions fields", () => {
		const samplePermissions = makePermissions();
		const permissionKeys = new Set(Object.keys(samplePermissions));

		for (const [capabilityString, permField] of Object.entries(CAPABILITY_MAP)) {
			expect(permissionKeys.has(permField)).toBe(true);
			// Verify the field is a boolean (not string/number) in a default permissions object
			expect(typeof samplePermissions[permField]).toBe("boolean");
		}
	});

	it("CAPABILITY_MAP has at least 10 entries (comprehensive coverage)", () => {
		expect(Object.keys(CAPABILITY_MAP).length).toBeGreaterThanOrEqual(10);
	});

	it("each CAPABILITY_MAP entry correctly gates tool execution", () => {
		const profile = makeProfile();

		for (const [capReq, permField] of Object.entries(CAPABILITY_MAP)) {
			const schema = makeSchema(`tool-for-${capReq}`, {
				capability_requirements: [capReq],
			});

			// Denied when permission is false
			const deniedPerms = makePermissions({ [permField]: false });
			const deniedCtx = makeContext(schema, deniedPerms);
			expect(canExecuteTool(profile, `tool-for-${capReq}`, deniedCtx)).toBe(false);

			// Allowed when permission is true
			const allowedPerms = makePermissions({ [permField]: true });
			const allowedCtx = makeContext(schema, allowedPerms);
			expect(canExecuteTool(profile, `tool-for-${capReq}`, allowedCtx)).toBe(true);
		}
	});

	it("toolPermissions allowlist gate blocks unlisted tools", () => {
		const profile = makeProfile({
			toolPermissions: [{ toolName: "allowed-tool", allowed: true }] as ToolPermission[],
		});

		expect(canExecuteTool(profile, "allowed-tool")).toBe(true);
		expect(canExecuteTool(profile, "unlisted-tool")).toBe(false);
	});

	it("toolPermissions allowlist with allowed=false blocks even listed tools", () => {
		const profile = makeProfile({
			toolPermissions: [{ toolName: "blocked-tool", allowed: false }] as ToolPermission[],
		});

		expect(canExecuteTool(profile, "blocked-tool")).toBe(false);
	});
});
