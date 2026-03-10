import { describe, expect, it } from "bun:test";
import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";

describe("bootstrapRuntime", () => {
  it("returns runtime service bundle with health and migration status", () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      expect(runtime.db).toBeDefined();
      expect(runtime.rawDb).toBe(runtime.db.raw);
      expect(runtime.sessionService).toBeDefined();
      expect(runtime.blackboard).toBeDefined();
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
});
