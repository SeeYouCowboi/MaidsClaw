import { GraphNavigator } from "../memory/navigator.js";
import { AliasService } from "../memory/alias.js";
import { CoreMemoryService } from "../memory/core-memory.js";
import { NarrativeSearchService } from "../memory/narrative/narrative-search.js";
import { CognitionSearchService } from "../memory/cognition/cognition-search.js";
import { RetrievalService } from "../memory/retrieval.js";
import { buildMemoryTools } from "../memory/tools.js";
import { adaptMemoryTool } from "../memory/tool-adapter.js";
import type { ToolExecutor } from "../core/tools/tool-executor.js";
import type { RuntimeServices } from "./types.js";

export function registerRuntimeTools(toolExecutor: ToolExecutor, services: RuntimeServices): void {
  const coreMemory = new CoreMemoryService(services.db);
  const retrieval = new RetrievalService(services.db);
  const alias = new AliasService(services.rawDb);
  const navigator = new GraphNavigator(services.rawDb, retrieval, alias);
  const narrativeSearch = new NarrativeSearchService(services.db);
  const cognitionSearch = new CognitionSearchService(services.db);

  const memoryTools = buildMemoryTools({
    coreMemory,
    retrieval,
    navigator,
    narrativeSearch,
    cognitionSearch,
  });

  for (const memoryTool of memoryTools) {
    toolExecutor.registerLocal(adaptMemoryTool(memoryTool, services));
  }
}
