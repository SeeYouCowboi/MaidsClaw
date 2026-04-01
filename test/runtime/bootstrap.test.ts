import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";

const _savedBackend = process.env.MAIDSCLAW_BACKEND;
beforeAll(() => { process.env.MAIDSCLAW_BACKEND = "sqlite"; });
afterAll(() => {
  if (_savedBackend === undefined) delete process.env.MAIDSCLAW_BACKEND;
  else process.env.MAIDSCLAW_BACKEND = _savedBackend;
});
import { MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE } from "../../src/agents/presets.js";
import { DefaultModelServiceRegistry } from "../../src/core/models/registry.js";
import type { AgentProfile } from "../../src/agents/profile.js";
import { registerRuntimeTools } from "../../src/bootstrap/tools.js";
import { CoreMemoryService } from "../../src/memory/core-memory.js";
import { ALL_MEMORY_TOOL_NAMES, MEMORY_TOOL_NAMES } from "../../src/memory/tool-names.js";

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
      agentProfiles: [MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE],
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
      expect(runtime.effectiveOrganizerEmbeddingModelId).toBe("openai/custom-embed");
    } finally {
      runtime.shutdown();
    }
  });

  it("preset profile merge preserves retrievalTemplate and writeTemplate fields", () => {
    const rpWithTemplates: AgentProfile = {
      ...RP_AGENT_PROFILE,
      id: "rp:with-templates",
      retrievalTemplate: { cognitionEnabled: false, maxCognitionHits: 0 },
      writeTemplate: { allowPublications: false },
    };

    const runtime = bootstrapRuntime({
      databasePath: ":memory:",
      agentProfiles: [MAIDEN_PROFILE, rpWithTemplates, TASK_AGENT_PROFILE],
    });

    try {
      const profile = runtime.agentRegistry.get("rp:with-templates");
      expect(profile).toBeDefined();
      expect(profile!.retrievalTemplate).toEqual({ cognitionEnabled: false, maxCognitionHits: 0 });
      expect(profile!.writeTemplate).toEqual({ allowPublications: false });
    } finally {
      runtime.shutdown();
    }
  });
});

describe("runtime tool registration", () => {
  it("registers all memory tools via adapter and executes through core executor", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      registerRuntimeTools(runtime.toolExecutor, runtime.runtimeServices);

      const schemaNames = runtime.toolExecutor.getSchemas().map((schema) => schema.name);
      for (const toolName of ALL_MEMORY_TOOL_NAMES) {
        expect(schemaNames).toContain(toolName);
      }

      const session = await runtime.sessionService.createSession("rp:default");
      const coreMemory = new CoreMemoryService(runtime.db);
      coreMemory.initializeBlocks("rp:default");

      const result = await runtime.toolExecutor.execute(
        MEMORY_TOOL_NAMES.coreMemoryAppend,
        { label: "persona", content: "Adapter path works." },
        { sessionId: session.sessionId },
      ) as { success: boolean };

      expect(result.success).toBe(true);
      expect(coreMemory.getBlock("rp:default", "persona").value).toContain("Adapter path works.");
    } finally {
      runtime.shutdown();
    }
  });
});
