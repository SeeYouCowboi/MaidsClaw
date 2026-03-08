import { describe, expect, it, beforeEach } from "bun:test";
import type { AgentProfile } from "../../../src/agents/profile.js";
import { AgentRegistry } from "../../../src/agents/registry.js";
import { AgentLifecycleManager } from "../../../src/agents/lifecycle.js";
import { TASK_AGENT_PROFILE } from "../../../src/agents/presets.js";
import {
  createTaskProfile,
  spawnFromConfig,
} from "../../../src/agents/task/profile.js";
import {
  TaskOutputValidator,
  resolveDetachPolicy,
} from "../../../src/agents/task/output-schema.js";
import type {
  TaskOutputSchema,
  ValidationResult,
} from "../../../src/agents/task/output-schema.js";

// ─── createTaskProfile ──────────────────────────────────────

describe("createTaskProfile", () => {
  it("creates a profile with task:{taskId} id and default TASK_AGENT_PROFILE fields", () => {
    const profile = createTaskProfile("my-task");

    expect(profile.id).toBe("task:my-task");
    expect(profile.lifecycle).toBe("ephemeral");
    expect(profile.userFacing).toBe(false);
    expect(profile.outputMode).toBe("structured");
    expect(profile.lorebookEnabled).toBe(false);
    expect(profile.narrativeContextEnabled).toBe(false);
    expect(profile.role).toBe("task_agent");
  });

  it("applies overrides on top of defaults", () => {
    const profile = createTaskProfile("custom", {
      modelId: "custom-model",
      maxOutputTokens: 4096,
    });

    expect(profile.id).toBe("task:custom");
    expect(profile.modelId).toBe("custom-model");
    expect(profile.maxOutputTokens).toBe(4096);
    // Non-overridden fields remain default
    expect(profile.lifecycle).toBe("ephemeral");
  });
});

// ─── spawnFromConfig ────────────────────────────────────────

describe("spawnFromConfig", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it("resolves base profile from registry and applies overrides", () => {
    // Register a custom base profile
    const customBase: AgentProfile = {
      ...TASK_AGENT_PROFILE,
      id: "task:custom-base",
      modelId: "custom-base-model",
      narrativeContextEnabled: false,
    };
    registry.register(customBase);

    const profile = spawnFromConfig(
      "t2",
      {
        baseProfileId: "task:custom-base",
        overrides: { narrativeContextEnabled: true },
      },
      registry,
    );

    expect(profile.id).toBe("task:t2");
    expect(profile.narrativeContextEnabled).toBe(true);
    expect(profile.lifecycle).toBe("ephemeral");
    expect(profile.userFacing).toBe(false);
    expect(profile.modelId).toBe("custom-base-model");
  });

  it("falls back to TASK_AGENT_PROFILE when baseProfileId not found", () => {
    const profile = spawnFromConfig(
      "fallback",
      { baseProfileId: "nonexistent:id" },
      registry,
    );

    expect(profile.id).toBe("task:fallback");
    expect(profile.modelId).toBe(TASK_AGENT_PROFILE.modelId);
    expect(profile.lifecycle).toBe("ephemeral");
  });

  it("uses TASK_AGENT_PROFILE when no baseProfileId provided", () => {
    const profile = spawnFromConfig(
      "no-base",
      { baseProfileId: "" },
      registry,
    );

    expect(profile.id).toBe("task:no-base");
    expect(profile.lifecycle).toBe("ephemeral");
  });
});

// ─── TaskOutputValidator ────────────────────────────────────

describe("TaskOutputValidator", () => {
  let validator: TaskOutputValidator;

  beforeEach(() => {
    validator = new TaskOutputValidator();
  });

  it("passes any output when no schema is provided", () => {
    const result = validator.validate({ anything: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as Record<string, boolean>).anything).toBe(true);
    }
  });

  it("validates a valid object against schema with required keys and property types", () => {
    const schema: TaskOutputSchema = {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
    };

    const result = validator.validate({ name: "Alice", age: 30 }, schema);
    expect(result.ok).toBe(true);
  });

  it("rejects non-object when schema.type is object", () => {
    const schema: TaskOutputSchema = { type: "object" };
    const result = validator.validate("not-object", schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.includes("expected object")).toBe(true);
    }
  });

  it("rejects null when schema.type is object", () => {
    const schema: TaskOutputSchema = { type: "object" };
    const result = validator.validate(null, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.includes("expected object")).toBe(true);
    }
  });

  it("rejects array when schema.type is object", () => {
    const schema: TaskOutputSchema = { type: "object" };
    const result = validator.validate([1, 2], schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.includes("expected object")).toBe(true);
    }
  });

  it("rejects object missing required keys", () => {
    const schema: TaskOutputSchema = {
      type: "object",
      required: ["name"],
    };
    const result = validator.validate({}, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.includes("missing required key")).toBe(true);
      expect(result.reason.includes("name")).toBe(true);
    }
  });

  it("rejects object with wrong property type", () => {
    const schema: TaskOutputSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    };
    const result = validator.validate({ name: 42 }, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.includes("wrong type for key")).toBe(true);
      expect(result.reason.includes("name")).toBe(true);
    }
  });

  it("skips absent optional properties without error", () => {
    const schema: TaskOutputSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
    };
    // Only name present, age absent but not required → ok
    const result = validator.validate({ name: "Bob" }, schema);
    expect(result.ok).toBe(true);
  });

  it("validates string type", () => {
    const schema: TaskOutputSchema = { type: "string" };
    expect(validator.validate("hello", schema).ok).toBe(true);
    const bad = validator.validate(42, schema);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason.includes("expected string")).toBe(true);
    }
  });

  it("validates number type", () => {
    const schema: TaskOutputSchema = { type: "number" };
    expect(validator.validate(42, schema).ok).toBe(true);
    const bad = validator.validate("hello", schema);
    expect(bad.ok).toBe(false);
  });

  it("validates boolean type", () => {
    const schema: TaskOutputSchema = { type: "boolean" };
    expect(validator.validate(true, schema).ok).toBe(true);
    const bad = validator.validate("true", schema);
    expect(bad.ok).toBe(false);
  });

  it("validates array type", () => {
    const schema: TaskOutputSchema = { type: "array" };
    expect(validator.validate([1, 2, 3], schema).ok).toBe(true);
    const bad = validator.validate({ length: 3 }, schema);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason.includes("expected array")).toBe(true);
    }
  });
});

// ─── resolveDetachPolicy ────────────────────────────────────

describe("resolveDetachPolicy", () => {
  it("returns 'detach' when profile.detachable is true", () => {
    const profile = createTaskProfile("d1", { detachable: true });
    expect(resolveDetachPolicy(profile)).toBe("detach");
  });

  it("returns 'wait' when profile.detachable is false", () => {
    const profile = createTaskProfile("d2", { detachable: false });
    expect(resolveDetachPolicy(profile)).toBe("wait");
  });

  it("returns 'wait' when profile.detachable is undefined", () => {
    const profile = createTaskProfile("d3");
    expect(resolveDetachPolicy(profile)).toBe("wait");
  });
});

// ─── Ephemeral lifecycle integration ────────────────────────

describe("Ephemeral task agent lifecycle", () => {
  let registry: AgentRegistry;
  let lifecycle: AgentLifecycleManager;

  beforeEach(() => {
    registry = new AgentRegistry();
    lifecycle = new AgentLifecycleManager(registry);
  });

  it("auto-unregisters ephemeral task agent after completeRun", () => {
    const profile = createTaskProfile("eph-complete");
    registry.register(profile);
    expect(registry.has("task:eph-complete")).toBe(true);

    const runId = lifecycle.startRun("task:eph-complete", "session-1");
    lifecycle.completeRun(runId);

    // Ephemeral agent should be unregistered after completion
    expect(registry.has("task:eph-complete")).toBe(false);
  });

  it("auto-unregisters ephemeral task agent after failRun", () => {
    const profile = createTaskProfile("eph-fail");
    registry.register(profile);

    const runId = lifecycle.startRun("task:eph-fail", "session-1");
    lifecycle.failRun(runId, new Error("task failed"));

    expect(registry.has("task:eph-fail")).toBe(false);
  });
});
