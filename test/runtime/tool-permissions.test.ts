import { describe, expect, it } from "bun:test";
import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";
import { registerRuntimeTools } from "../../src/bootstrap/tools.js";
import { CoreMemoryService } from "../../src/memory/core-memory.js";

describe("runtime tool registration", () => {
  it("registers all memory tools via adapter and executes through core executor", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      registerRuntimeTools(runtime.toolExecutor, runtime.runtimeServices);

      const schemaNames = runtime.toolExecutor.getSchemas().map((schema) => schema.name);
      expect(schemaNames).toContain("core_memory_append");
      expect(schemaNames).toContain("core_memory_replace");
      expect(schemaNames).toContain("memory_read");
      expect(schemaNames).toContain("narrative_search");
      expect(schemaNames).toContain("cognition_search");
      expect(schemaNames).toContain("memory_search");
      expect(schemaNames).toContain("memory_explore");

      const session = runtime.sessionService.createSession("rp:default");
      const coreMemory = new CoreMemoryService(runtime.db);
      coreMemory.initializeBlocks("rp:default");

      const result = await runtime.toolExecutor.execute(
        "core_memory_append",
        { label: "character", content: "Adapter path works." },
        { sessionId: session.sessionId },
      ) as { success: boolean };

      expect(result.success).toBe(true);
      expect(coreMemory.getBlock("rp:default", "character").value).toContain("Adapter path works.");
    } finally {
      runtime.shutdown();
    }
  });
});
