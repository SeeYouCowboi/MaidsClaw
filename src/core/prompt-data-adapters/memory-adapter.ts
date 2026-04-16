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
    private readonly personaEntityHints?: string[],
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
    // Merge caller-provided persona hints with constructor-level hints
    const mergedOptions: TypedRetrievalSurfaceOptions = {
      ...options,
      personaEntityHints: mergeHints(
        this.personaEntityHints,
        options?.personaEntityHints,
      ),
    };
    return getTypedRetrievalSurfaceAsync(
      userMessage,
      viewerContext,
      this.repos,
      this.retrievalService,
      mergedOptions,
      this.episodeRepo,
    );
  }
}

function mergeHints(
  a: string[] | undefined,
  b: string[] | undefined,
): string[] | undefined {
  if (!a && !b) return undefined;
  const set = new Set<string>();
  if (a) for (const h of a) set.add(h);
  if (b) for (const h of b) set.add(h);
  return set.size > 0 ? [...set] : undefined;
}
