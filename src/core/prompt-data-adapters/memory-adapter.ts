import type { Db } from "../../storage/database.js";
import {
  getAttachedSharedBlocks,
  getCoreMemoryBlocks,
  getMemoryHints,
  getRecentCognition,
} from "../../memory/prompt-data.js";
import type { MemoryDataSource, ViewerContext } from "../prompt-data-sources.js";

export class MemoryAdapter implements MemoryDataSource {
  constructor(private readonly db: Db) {}

  getCoreMemoryBlocks(agentId: string): string {
    return getCoreMemoryBlocks(agentId, this.db);
  }

  getRecentCognition(viewerContext: ViewerContext): string {
    return getRecentCognition(viewerContext.viewer_agent_id, viewerContext.session_id, this.db);
  }

  async getMemoryHints(
    userMessage: string,
    viewerContext: ViewerContext,
  ): Promise<string> {
    return getMemoryHints(userMessage, viewerContext, this.db);
  }

  getAttachedSharedBlocks(agentId: string): string {
    return getAttachedSharedBlocks(agentId, this.db);
  }
}
