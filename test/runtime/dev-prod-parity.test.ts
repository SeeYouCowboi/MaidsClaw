import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";

const _savedBackend = process.env.MAIDSCLAW_BACKEND;
beforeAll(() => { process.env.MAIDSCLAW_BACKEND = "pg"; });
afterAll(() => {
  if (_savedBackend === undefined) delete process.env.MAIDSCLAW_BACKEND;
  else process.env.MAIDSCLAW_BACKEND = _savedBackend;
});
import { MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE } from "../../src/agents/presets.js";
import { DefaultModelServiceRegistry } from "../../src/core/models/registry.js";

function createTestRegistry(): DefaultModelServiceRegistry {
  return new DefaultModelServiceRegistry({
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
}

const REQUIRED_HEALTH_KEYS = ["storage", "models", "tools", "memory_pipeline"];

describe("dev/prod parity", () => {
	it("bootstrapRuntime returns createAgentLoop that resolves known agents", () => {
		const runtime = bootstrapRuntime({
			modelRegistry: createTestRegistry(),
			agentProfiles: [MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE],
		});

    try {
      expect(typeof runtime.createAgentLoop).toBe("function");
      expect(runtime.createAgentLoop(MAIDEN_PROFILE.id) !== null).toBe(true);
      expect(runtime.createAgentLoop(TASK_AGENT_PROFILE.id) !== null).toBe(true);
    } finally {
      runtime.shutdown();
    }
  });

	it("bootstrapRuntime returns createAgentLoop that returns null for unknown agents", () => {
		const runtime = bootstrapRuntime({
			modelRegistry: createTestRegistry(),
			agentProfiles: [MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE],
		});

    try {
      expect(runtime.createAgentLoop("nonexistent:agent")).toBeNull();
    } finally {
      runtime.shutdown();
    }
  });

	it("bootstrapRuntime returns a non-null turnService", () => {
		const runtime = bootstrapRuntime();

    try {
      expect(runtime.turnService).toBeDefined();
      expect(runtime.turnService !== null).toBe(true);
      expect(typeof runtime.turnService.run).toBe("function");
    } finally {
      runtime.shutdown();
    }
  });

	it("healthChecks include all required subsystem keys", () => {
		const runtime = bootstrapRuntime();

    try {
      for (const key of REQUIRED_HEALTH_KEYS) {
        expect(key in runtime.healthChecks).toBe(true);
        expect(["ok", "degraded", "error"]).toContain(runtime.healthChecks[key]);
      }
    } finally {
      runtime.shutdown();
    }
  });

	it("two independent bootstrapRuntime calls produce the same runtime shape", () => {
		const runtimeA = bootstrapRuntime();
		const runtimeB = bootstrapRuntime();

    try {
      const keysA = Object.keys(runtimeA).sort();
      const keysB = Object.keys(runtimeB).sort();
      expect(keysA).toEqual(keysB);

      expect(typeof runtimeA.createAgentLoop).toBe("function");
      expect(typeof runtimeB.createAgentLoop).toBe("function");
      expect(typeof runtimeA.turnService.run).toBe("function");
      expect(typeof runtimeB.turnService.run).toBe("function");

      const healthKeysA = Object.keys(runtimeA.healthChecks).sort();
      const healthKeysB = Object.keys(runtimeB.healthChecks).sort();
      expect(healthKeysA).toEqual(healthKeysB);
    } finally {
      runtimeA.shutdown();
      runtimeB.shutdown();
    }
  });

	it("health check statuses map cleanly to gateway SubsystemStatus values", () => {
		const runtime = bootstrapRuntime();

    try {
      for (const [name, status] of Object.entries(runtime.healthChecks)) {
        const mapped = status === "error" ? "unavailable" : status;
        expect(["ok", "degraded", "unavailable"]).toContain(mapped);
        expect(typeof name).toBe("string");
      }
    } finally {
      runtime.shutdown();
    }
  });
});
