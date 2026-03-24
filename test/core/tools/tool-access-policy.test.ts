import { describe, expect, it } from "bun:test";

import type { AgentProfile } from "../../../src/agents/profile.js";
import type { AgentPermissions } from "../../../src/memory/contracts/agent-permissions.js";
import type { ToolExecutionContract, ToolSchema } from "../../../src/core/tools/tool-definition.js";
import { canExecuteTool, type ToolExecutionContext } from "../../../src/core/tools/tool-access-policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makePermissions(overrides?: Partial<AgentPermissions>): AgentPermissions {
  return {
    agentId: "test-agent",
    canAccessCognition: false,
    canWriteCognition: false,
    canReadAdminOnly: false,
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

// ---------------------------------------------------------------------------
// Tests: existing allowlist behavior (backward compatibility)
// ---------------------------------------------------------------------------

describe("canExecuteTool — allowlist (backward compat)", () => {
  it("allows all tools when toolPermissions is empty", () => {
    const profile = makeProfile({ toolPermissions: [] });
    expect(canExecuteTool(profile, "any_tool")).toBe(true);
  });

  it("rejects tools not in explicit allowlist", () => {
    const profile = makeProfile({
      toolPermissions: [{ toolName: "allowed_tool", allowed: true }],
    });
    expect(canExecuteTool(profile, "forbidden_tool")).toBe(false);
  });

  it("allows tool that is in explicit allowlist", () => {
    const profile = makeProfile({
      toolPermissions: [{ toolName: "allowed_tool", allowed: true }],
    });
    expect(canExecuteTool(profile, "allowed_tool")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: capability_requirements enforcement
// ---------------------------------------------------------------------------

describe("canExecuteTool — capability_requirements", () => {
  it("rejects when agent lacks required cognition_read capability", () => {
    const profile = makeProfile();
    const schema = makeSchema("cognition_search", {
      capability_requirements: ["cognition_read"],
    });
    const permissions = makePermissions({ canAccessCognition: false });

    const ctx: ToolExecutionContext = { schema, permissions };
    expect(canExecuteTool(profile, "cognition_search", ctx)).toBe(false);
  });

  it("allows when agent has required cognition_read capability", () => {
    const profile = makeProfile();
    const schema = makeSchema("cognition_search", {
      capability_requirements: ["cognition_read"],
    });
    const permissions = makePermissions({ canAccessCognition: true });

    const ctx: ToolExecutionContext = { schema, permissions };
    expect(canExecuteTool(profile, "cognition_search", ctx)).toBe(true);
  });

  it("rejects when agent lacks cognition_write capability", () => {
    const profile = makeProfile();
    const schema = makeSchema("cognition_write_tool", {
      capability_requirements: ["cognition_write"],
    });
    const permissions = makePermissions({ canWriteCognition: false });

    const ctx: ToolExecutionContext = { schema, permissions };
    expect(canExecuteTool(profile, "cognition_write_tool", ctx)).toBe(false);
  });

  it("rejects when agent lacks admin_read capability", () => {
    const profile = makeProfile();
    const schema = makeSchema("admin_tool", {
      capability_requirements: ["admin_read"],
    });
    const permissions = makePermissions({ canReadAdminOnly: false });

    const ctx: ToolExecutionContext = { schema, permissions };
    expect(canExecuteTool(profile, "admin_tool", ctx)).toBe(false);
  });

  it("allows when agent has admin_read capability", () => {
    const profile = makeProfile();
    const schema = makeSchema("admin_tool", {
      capability_requirements: ["admin_read"],
    });
    const permissions = makePermissions({ canReadAdminOnly: true });

    const ctx: ToolExecutionContext = { schema, permissions };
    expect(canExecuteTool(profile, "admin_tool", ctx)).toBe(true);
  });

  it("rejects when any one of multiple capabilities is missing", () => {
    const profile = makeProfile();
    const schema = makeSchema("multi_cap_tool", {
      capability_requirements: ["cognition_read", "admin_read"],
    });
    // has cognition but not admin
    const permissions = makePermissions({ canAccessCognition: true, canReadAdminOnly: false });

    const ctx: ToolExecutionContext = { schema, permissions };
    expect(canExecuteTool(profile, "multi_cap_tool", ctx)).toBe(false);
  });

  it("allows when all multiple capabilities are present", () => {
    const profile = makeProfile();
    const schema = makeSchema("multi_cap_tool", {
      capability_requirements: ["cognition_read", "admin_read"],
    });
    const permissions = makePermissions({ canAccessCognition: true, canReadAdminOnly: true });

    const ctx: ToolExecutionContext = { schema, permissions };
    expect(canExecuteTool(profile, "multi_cap_tool", ctx)).toBe(true);
  });

  it("skips capability check when no executionContract on schema", () => {
    const profile = makeProfile();
    const schema = makeSchema("plain_tool"); // no contract
    const permissions = makePermissions({ canAccessCognition: false });

    const ctx: ToolExecutionContext = { schema, permissions };
    expect(canExecuteTool(profile, "plain_tool", ctx)).toBe(true);
  });

  it("skips capability check when capability_requirements is empty", () => {
    const profile = makeProfile();
    const schema = makeSchema("safe_tool", {
      capability_requirements: [],
    });
    const permissions = makePermissions({ canAccessCognition: false });

    const ctx: ToolExecutionContext = { schema, permissions };
    expect(canExecuteTool(profile, "safe_tool", ctx)).toBe(true);
  });

  it("rejects unknown capability string", () => {
    const profile = makeProfile();
    const schema = makeSchema("weird_tool", {
      capability_requirements: ["unknown_cap"],
    });
    const permissions = makePermissions({ canAccessCognition: true, canWriteCognition: true, canReadAdminOnly: true });

    const ctx: ToolExecutionContext = { schema, permissions };
    // Unknown capability → not satisfied → reject
    expect(canExecuteTool(profile, "weird_tool", ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: cardinality enforcement
// ---------------------------------------------------------------------------

describe("canExecuteTool — cardinality", () => {
  it("cardinality 'once': allows first call, rejects second call in same turn", () => {
    const profile = makeProfile();
    const schema = makeSchema("settle_tool", { cardinality: "once" });
    const turnToolsUsed = new Set<string>();
    const ctx: ToolExecutionContext = { schema, turnToolsUsed };

    // First call: allowed
    expect(canExecuteTool(profile, "settle_tool", ctx)).toBe(true);
    // turnToolsUsed should now contain "settle_tool"
    expect(turnToolsUsed.has("settle_tool")).toBe(true);

    // Second call: rejected
    expect(canExecuteTool(profile, "settle_tool", ctx)).toBe(false);
  });

  it("cardinality 'at_most_once': allows first call, rejects second call in same turn", () => {
    const profile = makeProfile();
    const schema = makeSchema("optional_tool", { cardinality: "at_most_once" });
    const turnToolsUsed = new Set<string>();
    const ctx: ToolExecutionContext = { schema, turnToolsUsed };

    expect(canExecuteTool(profile, "optional_tool", ctx)).toBe(true);
    expect(turnToolsUsed.has("optional_tool")).toBe(true);
    expect(canExecuteTool(profile, "optional_tool", ctx)).toBe(false);
  });

  it("cardinality 'multiple': allows repeated calls in same turn", () => {
    const profile = makeProfile();
    const schema = makeSchema("search_tool", { cardinality: "multiple" });
    const turnToolsUsed = new Set<string>();
    const ctx: ToolExecutionContext = { schema, turnToolsUsed };

    expect(canExecuteTool(profile, "search_tool", ctx)).toBe(true);
    expect(canExecuteTool(profile, "search_tool", ctx)).toBe(true);
    expect(canExecuteTool(profile, "search_tool", ctx)).toBe(true);
  });

  it("cardinality enforcement is per-tool: once tool A rejected does not affect tool B", () => {
    const profile = makeProfile();
    const schemaA = makeSchema("tool_a", { cardinality: "once" });
    const schemaB = makeSchema("tool_b", { cardinality: "once" });
    const turnToolsUsed = new Set<string>();

    expect(canExecuteTool(profile, "tool_a", { schema: schemaA, turnToolsUsed })).toBe(true);
    expect(canExecuteTool(profile, "tool_a", { schema: schemaA, turnToolsUsed })).toBe(false);
    // tool_b still works
    expect(canExecuteTool(profile, "tool_b", { schema: schemaB, turnToolsUsed })).toBe(true);
  });

  it("no turnToolsUsed set → cardinality not enforced (backward compat)", () => {
    const profile = makeProfile();
    const schema = makeSchema("once_tool", { cardinality: "once" });
    const ctx: ToolExecutionContext = { schema }; // no turnToolsUsed

    expect(canExecuteTool(profile, "once_tool", ctx)).toBe(true);
    expect(canExecuteTool(profile, "once_tool", ctx)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: combined capability + cardinality
// ---------------------------------------------------------------------------

describe("canExecuteTool — combined checks", () => {
  it("capability failure takes precedence over cardinality", () => {
    const profile = makeProfile();
    const schema = makeSchema("cognition_once", {
      capability_requirements: ["cognition_read"],
      cardinality: "once",
    });
    const permissions = makePermissions({ canAccessCognition: false });
    const turnToolsUsed = new Set<string>();
    const ctx: ToolExecutionContext = { schema, permissions, turnToolsUsed };

    // Should fail on capability, not record into turnToolsUsed
    expect(canExecuteTool(profile, "cognition_once", ctx)).toBe(false);
    expect(turnToolsUsed.has("cognition_once")).toBe(false);
  });

  it("passes both capability and cardinality on first call", () => {
    const profile = makeProfile();
    const schema = makeSchema("cognition_once", {
      capability_requirements: ["cognition_read"],
      cardinality: "once",
    });
    const permissions = makePermissions({ canAccessCognition: true });
    const turnToolsUsed = new Set<string>();
    const ctx: ToolExecutionContext = { schema, permissions, turnToolsUsed };

    expect(canExecuteTool(profile, "cognition_once", ctx)).toBe(true);
    // Second call: capability OK but cardinality blocks
    expect(canExecuteTool(profile, "cognition_once", ctx)).toBe(false);
  });
});
