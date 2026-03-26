import { describe, expect, it } from "bun:test";
import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";
import { registerRuntimeTools } from "../../src/bootstrap/tools.js";
import { CoreMemoryService } from "../../src/memory/core-memory.js";
import { ALL_MEMORY_TOOL_NAMES, MEMORY_TOOL_NAMES } from "../../src/memory/tool-names.js";

describe("runtime tool registration", () => {
  it("registers all memory tools via adapter and executes through core executor", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      registerRuntimeTools(runtime.toolExecutor, runtime.runtimeServices);

      const schemaNames = runtime.toolExecutor.getSchemas().map((schema) => schema.name);
      for (const toolName of ALL_MEMORY_TOOL_NAMES) {
        expect(schemaNames).toContain(toolName);
      }

      const session = runtime.sessionService.createSession("rp:default");
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
