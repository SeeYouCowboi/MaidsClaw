import type { Db } from "../../storage/database.js";
import {
  getCoreMemoryBlocks,
  getMemoryHints,
} from "../../memory/prompt-data.js";
import type { MemoryDataSource, ViewerContext } from "../prompt-data-sources.js";

export class MemoryAdapter implements MemoryDataSource {
  constructor(private readonly db: Db) {}

  getCoreMemoryBlocks(agentId: string): string {
    return getCoreMemoryBlocks(agentId, this.db);
  }

  async getMemoryHints(
    userMessage: string,
    viewerContext: ViewerContext,
  ): Promise<string> {
    return getMemoryHints(userMessage, viewerContext, this.db);
  }
}
