import type { RetrievalService } from "../../memory/retrieval.js";
import {
  getAttachedSharedBlocksAsync,
  getPinnedBlocksAsync,
  getRecentCognitionAsync,
  getSharedBlocksAsync,
  getTypedRetrievalSurfaceAsync,
  type PromptDataRepos,
} from "../../memory/prompt-data.js";
import type { EpisodeRepo } from "../../storage/domain-repos/contracts/episode-repo.js";
import type {
  MemoryDataSource,
  TypedRetrievalSurfaceOptions,
  ViewerContext,
} from "../prompt-data-sources.js";

export class MemoryAdapter implements MemoryDataSource {
  constructor(
    private readonly repos: PromptDataRepos,
    private readonly retrievalService?: RetrievalService,
    private readonly episodeRepo?: EpisodeRepo,
  ) {}

  async getPinnedBlocks(agentId: string): Promise<string> {
    return getPinnedBlocksAsync(agentId, this.repos);
  }

  async getSharedBlocks(agentId: string): Promise<string> {
    return getSharedBlocksAsync(agentId, this.repos);
  }

  async getRecentCognition(viewerContext: ViewerContext): Promise<string> {
    return getRecentCognitionAsync(viewerContext.viewer_agent_id, viewerContext.session_id, this.repos);
  }

  async getAttachedSharedBlocks(agentId: string): Promise<string> {
    return getAttachedSharedBlocksAsync(agentId, this.repos);
  }

  async getTypedRetrievalSurface(
    userMessage: string,
    viewerContext: ViewerContext,
    options?: TypedRetrievalSurfaceOptions,
  ): Promise<string> {
    if (!this.retrievalService) {
      return "";
    }
    return getTypedRetrievalSurfaceAsync(
      userMessage,
      viewerContext,
      this.repos,
      this.retrievalService,
      options,
      this.episodeRepo,
    );
  }
}
