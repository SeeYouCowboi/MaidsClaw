import { describe, expect, it } from "bun:test";
import { AgentPermissions } from "../../../src/agents/permissions.js";
import { AgentRegistry } from "../../../src/agents/registry.js";
import { createRpProfile } from "../../../src/agents/rp/profile.js";
import { RpToolPolicy } from "../../../src/agents/rp/tool-policy.js";

describe("RP Agent profile", () => {
  it("createRpProfile assembles persona-aware defaults", () => {
    const profile = createRpProfile("myChar");

    expect(profile.id).toBe("rp:myChar");
    expect(profile.personaId).toBe("myChar");
    expect(profile.role).toBe("rp_agent");
    expect(profile.lorebookEnabled).toBe(true);
  });
});

describe("RpToolPolicy", () => {
  it("allows authorized tools and denies unknown tools", () => {
    const policy = new RpToolPolicy();

    expect(policy.isAllowed("memory_read")).toBe(true);
    expect(policy.isAllowed("admin_tool")).toBe(false);
  });

  it("toToolPermissions returns an allowlist for all authorized tools", () => {
    const policy = new RpToolPolicy();
    const permissions = policy.toToolPermissions();

    expect(permissions.length).toBe(8);
    expect(permissions.every((entry) => entry.allowed)).toBe(true);
  });
});

describe("RP Agent permission boundaries", () => {
  it("canUseTool allows all tools when toolPermissions is empty", () => {
    const registry = new AgentRegistry();
    registry.register(createRpProfile("open", { toolPermissions: [] }));
    const permissions = new AgentPermissions(registry);

    expect(permissions.canUseTool("rp:open", "memory_read")).toBe(true);
    expect(permissions.canUseTool("rp:open", "admin_tool")).toBe(true);
  });

  it("canUseTool enforces explicit allowlist when toolPermissions is present", () => {
    const registry = new AgentRegistry();
    const policy = new RpToolPolicy();
    registry.register(
      createRpProfile("locked", {
        toolPermissions: policy.toToolPermissions(),
      }),
    );
    const permissions = new AgentPermissions(registry);

    expect(permissions.canUseTool("rp:locked", "memory_read")).toBe(true);
    expect(permissions.canUseTool("rp:locked", "admin_tool")).toBe(false);
  });

  it("blocks cross-agent private memory access for rp agents", () => {
    const registry = new AgentRegistry();
    registry.register(createRpProfile("alice"));
    registry.register(createRpProfile("bob"));
    const permissions = new AgentPermissions(registry);

    expect(permissions.canAccessPrivateData("rp:alice", "rp:bob")).toBe(false);
  });

  it("allows self private memory access for rp agents", () => {
    const registry = new AgentRegistry();
    registry.register(createRpProfile("alice"));
    const permissions = new AgentPermissions(registry);

    expect(permissions.canAccessPrivateData("rp:alice", "rp:alice")).toBe(true);
  });
});
