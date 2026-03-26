import type { Db } from "../../storage/database.js";
import {
  getAttachedSharedBlocks,
  getPinnedBlocks,
  getRecentCognition,
  getSharedBlocks,
  getTypedRetrievalSurface,
} from "../../memory/prompt-data.js";
import type { MemoryDataSource, ViewerContext } from "../prompt-data-sources.js";

export class MemoryAdapter implements MemoryDataSource {
  constructor(private readonly db: Db) {}

  getPinnedBlocks(agentId: string): string {
    return getPinnedBlocks(agentId, this.db);
  }

  getSharedBlocks(agentId: string): string {
    return getSharedBlocks(agentId, this.db);
  }

  getRecentCognition(viewerContext: ViewerContext): string {
    return getRecentCognition(viewerContext.viewer_agent_id, viewerContext.session_id, this.db);
  }

  getAttachedSharedBlocks(agentId: string): string {
    return getAttachedSharedBlocks(agentId, this.db);
  }

  async getTypedRetrievalSurface(userMessage: string, viewerContext: ViewerContext): Promise<string> {
    return getTypedRetrievalSurface(userMessage, viewerContext, this.db);
  }
}
