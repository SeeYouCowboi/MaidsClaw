import { describe, expect, it, beforeEach } from "bun:test";
import type { AgentProfile } from "../../src/agents/profile.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { AgentLifecycleManager } from "../../src/agents/lifecycle.js";
import type { AgentLifecycleState } from "../../src/agents/lifecycle.js";
import { AgentPermissions } from "../../src/agents/permissions.js";
import {
  MAIDEN_PROFILE,
  RP_AGENT_PROFILE,
  TASK_AGENT_PROFILE,
  PRESET_PROFILES,
} from "../../src/agents/presets.js";
import { MaidsClawError } from "../../src/core/errors.js";

// Helper: create a minimal AgentProfile for testing
function makeProfile(overrides: Partial<AgentProfile> & { id: string }): AgentProfile {
  return {
    role: "task_agent",
    lifecycle: "ephemeral",
    userFacing: false,
    outputMode: "structured",
    modelId: "test-model",
    maxOutputTokens: 1024,
    toolPermissions: [],
    maxDelegationDepth: 0,
    lorebookEnabled: false,
    narrativeContextEnabled: false,
    ...overrides,
  };
}

// ─── AgentRegistry ───────────────────────────────────────────

describe("AgentRegistry", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it("register + get returns the profile", () => {
    const profile = makeProfile({ id: "test:1" });
    registry.register(profile);
    expect(registry.get("test:1")).toBe(profile);
  });

  it("has() returns true for registered, false for unregistered", () => {
    const profile = makeProfile({ id: "test:1" });
    registry.register(profile);
    expect(registry.has("test:1")).toBe(true);
    expect(registry.has("test:2")).toBe(false);
  });

  it("getAll() returns all registered profiles", () => {
    const p1 = makeProfile({ id: "test:1" });
    const p2 = makeProfile({ id: "test:2" });
    registry.register(p1);
    registry.register(p2);
    const all = registry.getAll();
    expect(all.length).toBe(2);
    expect(all).toContain(p1);
    expect(all).toContain(p2);
  });

  it("unregister removes an agent", () => {
    const profile = makeProfile({ id: "test:1" });
    registry.register(profile);
    registry.unregister("test:1");
    expect(registry.has("test:1")).toBe(false);
    expect(registry.get("test:1")).toBeUndefined();
  });

  it("register throws AGENT_ALREADY_REGISTERED on duplicate id", () => {
    const profile = makeProfile({ id: "test:dup" });
    registry.register(profile);
    try {
      registry.register(makeProfile({ id: "test:dup" }));
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err instanceof MaidsClawError).toBe(true);
      expect((err as MaidsClawError).code).toBe("AGENT_ALREADY_REGISTERED");
    }
  });

  it("unregister throws AGENT_NOT_FOUND for unknown id", () => {
    try {
      registry.unregister("nonexistent");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err instanceof MaidsClawError).toBe(true);
      expect((err as MaidsClawError).code).toBe("AGENT_NOT_FOUND");
    }
  });

  it("get() returns undefined for unregistered agent", () => {
    expect(registry.get("ghost")).toBeUndefined();
  });
});

// ─── AgentLifecycleManager ───────────────────────────────────

describe("AgentLifecycleManager", () => {
  let registry: AgentRegistry;
  let lifecycle: AgentLifecycleManager;

  beforeEach(() => {
    registry = new AgentRegistry();
    lifecycle = new AgentLifecycleManager(registry);
  });

  it("startRun returns a run ID and sets state to running", () => {
    registry.register(makeProfile({ id: "a:1" }));
    const runId = lifecycle.startRun("a:1", "session-1");
    expect(typeof runId).toBe("string");
    expect(runId.startsWith("run_")).toBe(true);
    expect(lifecycle.getRunState(runId)).toBe("running");
  });

  it("completeRun sets state to completed", () => {
    const profile = makeProfile({ id: "a:persistent", lifecycle: "persistent" });
    registry.register(profile);
    const runId = lifecycle.startRun("a:persistent", "s1");
    lifecycle.completeRun(runId);
    expect(lifecycle.getRunState(runId)).toBe("completed");
  });

  it("failRun sets state to failed", () => {
    const profile = makeProfile({ id: "a:persistent", lifecycle: "persistent" });
    registry.register(profile);
    const runId = lifecycle.startRun("a:persistent", "s1");
    lifecycle.failRun(runId, new Error("boom"));
    expect(lifecycle.getRunState(runId)).toBe("failed");
  });

  it("startRun throws AGENT_NOT_FOUND for unregistered agent", () => {
    try {
      lifecycle.startRun("ghost", "s1");
      expect(true).toBe(false);
    } catch (err) {
      expect(err instanceof MaidsClawError).toBe(true);
      expect((err as MaidsClawError).code).toBe("AGENT_NOT_FOUND");
    }
  });

  it("completeRun throws for unknown runId", () => {
    try {
      lifecycle.completeRun("run_nonexistent");
      expect(true).toBe(false);
    } catch (err) {
      expect(err instanceof MaidsClawError).toBe(true);
      expect((err as MaidsClawError).code).toBe("AGENT_NOT_FOUND");
    }
  });

  it("getRunState returns undefined for unknown runId", () => {
    expect(lifecycle.getRunState("run_unknown")).toBeUndefined();
  });

  it("isEphemeral returns true for ephemeral agents", () => {
    registry.register(makeProfile({ id: "e:1", lifecycle: "ephemeral" }));
    expect(lifecycle.isEphemeral("e:1")).toBe(true);
  });

  it("isEphemeral returns false for persistent agents", () => {
    registry.register(makeProfile({ id: "p:1", lifecycle: "persistent" }));
    expect(lifecycle.isEphemeral("p:1")).toBe(false);
  });

  it("ephemeral agent auto-unregisters after completeRun", () => {
    const profile = makeProfile({ id: "eph:1", lifecycle: "ephemeral" });
    registry.register(profile);
    expect(registry.has("eph:1")).toBe(true);

    const runId = lifecycle.startRun("eph:1", "s1");
    lifecycle.completeRun(runId);

    // Ephemeral agent should be unregistered
    expect(registry.has("eph:1")).toBe(false);
  });

  it("ephemeral agent auto-unregisters after failRun", () => {
    const profile = makeProfile({ id: "eph:2", lifecycle: "ephemeral" });
    registry.register(profile);
    expect(registry.has("eph:2")).toBe(true);

    const runId = lifecycle.startRun("eph:2", "s1");
    lifecycle.failRun(runId, new Error("task failed"));

    // Ephemeral agent should be unregistered
    expect(registry.has("eph:2")).toBe(false);
  });

  it("persistent agent stays registered after completeRun", () => {
    const profile = makeProfile({ id: "pers:1", lifecycle: "persistent" });
    registry.register(profile);

    const runId = lifecycle.startRun("pers:1", "s1");
    lifecycle.completeRun(runId);

    // Persistent agent should still be registered
    expect(registry.has("pers:1")).toBe(true);
  });
});

// ─── AgentPermissions ────────────────────────────────────────

describe("AgentPermissions", () => {
  let registry: AgentRegistry;
  let permissions: AgentPermissions;

  beforeEach(() => {
    registry = new AgentRegistry();
    permissions = new AgentPermissions(registry);

    // Register preset profiles for permission tests
    registry.register({ ...MAIDEN_PROFILE });
    registry.register({ ...RP_AGENT_PROFILE });
    registry.register({ ...TASK_AGENT_PROFILE });
  });

  describe("canDelegate", () => {
    it("maiden can delegate to rp_agent", () => {
      expect(permissions.canDelegate("maid:main", "rp:default")).toBe(true);
    });

    it("maiden can delegate to task_agent", () => {
      expect(permissions.canDelegate("maid:main", "task:default")).toBe(true);
    });

    it("rp_agent can delegate to task_agent", () => {
      expect(permissions.canDelegate("rp:default", "task:default")).toBe(true);
    });

    it("rp_agent cannot delegate to maiden", () => {
      expect(permissions.canDelegate("rp:default", "maid:main")).toBe(false);
    });

    it("rp_agent cannot delegate to another rp_agent", () => {
      const rp2 = makeProfile({ id: "rp:other", role: "rp_agent" });
      registry.register(rp2);
      expect(permissions.canDelegate("rp:default", "rp:other")).toBe(false);
    });

    it("task_agent cannot delegate to anyone", () => {
      expect(permissions.canDelegate("task:default", "maid:main")).toBe(false);
      expect(permissions.canDelegate("task:default", "rp:default")).toBe(false);
    });

    it("returns false for unregistered source agent", () => {
      expect(permissions.canDelegate("ghost", "maid:main")).toBe(false);
    });

    it("returns false for unregistered target agent", () => {
      expect(permissions.canDelegate("maid:main", "ghost")).toBe(false);
    });
  });

  describe("canUseTool", () => {
    it("allows all tools when toolPermissions is empty", () => {
      expect(permissions.canUseTool("maid:main", "any_tool")).toBe(true);
      expect(permissions.canUseTool("maid:main", "another_tool")).toBe(true);
    });

    it("allows explicitly permitted tools", () => {
      const restricted = makeProfile({
        id: "restricted:1",
        toolPermissions: [
          { toolName: "read_file", allowed: true },
          { toolName: "write_file", allowed: false },
        ],
      });
      registry.register(restricted);

      expect(permissions.canUseTool("restricted:1", "read_file")).toBe(true);
    });

    it("denies explicitly denied tools", () => {
      const restricted = makeProfile({
        id: "restricted:2",
        toolPermissions: [
          { toolName: "read_file", allowed: true },
          { toolName: "write_file", allowed: false },
        ],
      });
      registry.register(restricted);

      expect(permissions.canUseTool("restricted:2", "write_file")).toBe(false);
    });

    it("denies tools not in permission list (when list is non-empty)", () => {
      const restricted = makeProfile({
        id: "restricted:3",
        toolPermissions: [{ toolName: "read_file", allowed: true }],
      });
      registry.register(restricted);

      expect(permissions.canUseTool("restricted:3", "unknown_tool")).toBe(false);
    });

    it("returns false for unregistered agent", () => {
      expect(permissions.canUseTool("ghost", "any_tool")).toBe(false);
    });
  });

  describe("canAccessPrivateData", () => {
    it("maiden can access other agents' private data", () => {
      expect(permissions.canAccessPrivateData("maid:main", "rp:default")).toBe(true);
      expect(permissions.canAccessPrivateData("maid:main", "task:default")).toBe(true);
    });

    it("rp_agent cannot access other agents' private data", () => {
      expect(permissions.canAccessPrivateData("rp:default", "maid:main")).toBe(false);
      expect(permissions.canAccessPrivateData("rp:default", "task:default")).toBe(false);
    });

    it("task_agent cannot access other agents' private data", () => {
      expect(permissions.canAccessPrivateData("task:default", "maid:main")).toBe(false);
    });

    it("any agent can access its own private data", () => {
      expect(permissions.canAccessPrivateData("maid:main", "maid:main")).toBe(true);
      expect(permissions.canAccessPrivateData("rp:default", "rp:default")).toBe(true);
      expect(permissions.canAccessPrivateData("task:default", "task:default")).toBe(true);
    });

    it("returns false for unregistered requesting agent", () => {
      expect(permissions.canAccessPrivateData("ghost", "maid:main")).toBe(false);
    });
  });
});

// ─── Preset Profiles ─────────────────────────────────────────

describe("Preset Profiles", () => {
  it("MAIDEN_PROFILE has correct shape", () => {
    expect(MAIDEN_PROFILE.id).toBe("maid:main");
    expect(MAIDEN_PROFILE.role).toBe("maiden");
    expect(MAIDEN_PROFILE.lifecycle).toBe("persistent");
    expect(MAIDEN_PROFILE.userFacing).toBe(true);
    expect(MAIDEN_PROFILE.outputMode).toBe("freeform");
    expect(MAIDEN_PROFILE.maxOutputTokens).toBe(8192);
  });

  it("RP_AGENT_PROFILE has correct shape", () => {
    expect(RP_AGENT_PROFILE.id).toBe("rp:default");
    expect(RP_AGENT_PROFILE.role).toBe("rp_agent");
    expect(RP_AGENT_PROFILE.lifecycle).toBe("persistent");
    expect(RP_AGENT_PROFILE.userFacing).toBe(true);
    expect(RP_AGENT_PROFILE.maxOutputTokens).toBe(4096);
  });

  it("TASK_AGENT_PROFILE has correct shape", () => {
    expect(TASK_AGENT_PROFILE.id).toBe("task:default");
    expect(TASK_AGENT_PROFILE.role).toBe("task_agent");
    expect(TASK_AGENT_PROFILE.lifecycle).toBe("ephemeral");
    expect(TASK_AGENT_PROFILE.userFacing).toBe(false);
    expect(TASK_AGENT_PROFILE.outputMode).toBe("structured");
    expect(TASK_AGENT_PROFILE.maxOutputTokens).toBe(2048);
  });

  it("PRESET_PROFILES contains all 3 presets", () => {
    expect(PRESET_PROFILES.length).toBe(3);
    expect(PRESET_PROFILES.includes(MAIDEN_PROFILE)).toBe(true);
    expect(PRESET_PROFILES.includes(RP_AGENT_PROFILE)).toBe(true);
    expect(PRESET_PROFILES.includes(TASK_AGENT_PROFILE)).toBe(true);
  });

  it("all presets can be registered in a fresh registry", () => {
    const registry = new AgentRegistry();
    let threw = false;
    try {
      for (const profile of PRESET_PROFILES) {
        registry.register({ ...profile });
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(registry.getAll().length).toBe(3);
  });
});
