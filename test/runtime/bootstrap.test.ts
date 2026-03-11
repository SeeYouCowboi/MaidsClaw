import { describe, expect, it } from "bun:test";
import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";
import { MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE } from "../../src/agents/presets.js";
import { DefaultModelServiceRegistry } from "../../src/core/models/registry.js";

describe("bootstrapRuntime", () => {
  it("returns runtime service bundle with health and migration status", () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      expect(runtime.db).toBeDefined();
      expect(runtime.rawDb).toBe(runtime.db.raw);
      expect(runtime.sessionService).toBeDefined();
      expect(runtime.blackboard).toBeDefined();
      expect(runtime.agentRegistry).toBeDefined();
      expect(runtime.modelRegistry).toBeDefined();
      expect(runtime.toolExecutor).toBeDefined();
      expect(runtime.runtimeServices).toBeDefined();

      expect(runtime.migrationStatus.succeeded).toBe(true);
      expect(runtime.migrationStatus.interaction.succeeded).toBe(true);
      expect(runtime.migrationStatus.memory.succeeded).toBe(true);

      expect(runtime.healthChecks.storage).toBe("ok");
      expect(runtime.healthChecks.models).toBeDefined();
      expect(runtime.healthChecks.tools).toBeDefined();
      expect(["ok", "degraded", "error"]).toContain(runtime.healthChecks.models);
      expect(["ok", "degraded", "error"]).toContain(runtime.healthChecks.tools);

      const row = runtime.db.get<{ one: number }>("SELECT 1 AS one");
      expect(row?.one).toBe(1);
    } finally {
      runtime.shutdown();
    }
  });

  it("shutdown closes the database without throwing", () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    let firstThrow = false;
    try {
      runtime.shutdown();
    } catch {
      firstThrow = true;
    }

    let secondThrow = false;
    try {
      runtime.shutdown();
    } catch {
      secondThrow = true;
    }

    expect(firstThrow).toBe(false);
    expect(secondThrow).toBe(false);
  });

  it("creates agent loops from registry profiles and returns null for unknown agent ids", () => {
    const modelRegistry = new DefaultModelServiceRegistry({
      chatPrefixes: [
        {
          prefix: "anthropic/",
          provider: {
            async *chatCompletion() {
              yield { type: "message_end", stopReason: "end_turn" };
            },
          },
        },
      ],
    });

    const runtime = bootstrapRuntime({
      databasePath: ":memory:",
      modelRegistry,
    });

    try {
      expect(runtime.agentRegistry.has(MAIDEN_PROFILE.id)).toBe(true);
      expect(runtime.agentRegistry.has(RP_AGENT_PROFILE.id)).toBe(true);
      expect(runtime.agentRegistry.has(TASK_AGENT_PROFILE.id)).toBe(true);

      expect(runtime.createAgentLoop(MAIDEN_PROFILE.id) !== null).toBe(true);
      expect(runtime.createAgentLoop(RP_AGENT_PROFILE.id) !== null).toBe(true);
      expect(runtime.createAgentLoop(TASK_AGENT_PROFILE.id) !== null).toBe(true);
      expect(runtime.createAgentLoop("rp:unregistered")).toBeNull();
    } finally {
      runtime.shutdown();
    }
  });

  it("passes memoryOrganizerEmbeddingModelId through to bootstrap options", () => {
    const runtime = bootstrapRuntime({
      databasePath: ":memory:",
      memoryOrganizerEmbeddingModelId: "openai/custom-embed",
    });

    try {
      // The model won't resolve but the option is accepted and stored
      expect(runtime.effectiveOrganizerEmbeddingModelId).toBe("openai/custom-embed");
    } finally {
      runtime.shutdown();
    }
  });
});
