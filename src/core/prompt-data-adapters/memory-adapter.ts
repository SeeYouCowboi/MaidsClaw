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

export const WEAK_MEMORY_INTERPRETATION_GUIDANCE = [
  "Cognition entries may be prefixed with [basis=X provenance=Y verification=Z].",
  "Treat the entry as low-confidence, fragmentary memory when verification is unverified, or when basis is belief or unknown, or when basis is inference and verification is not strong_verified.",
  "Do not use provenance alone as a low-confidence trigger once basis and verification have already been normalized.",
  "Use uncertain language when relying on low-confidence entries, do not repeat the bracketed metadata verbatim, and do not present them as quoted evidence.",
  "Strong verification can rescue user-stated or other weak-at-write-time entries once post-verification normalization has upgraded their trust state; do not keep them permanently low-confidence solely because their write-time provenance was weak.",
  "Entries without the prefix, or entries whose final basis/verification state no longer satisfies the low-confidence rule, may be treated as grounded memory.",
].join("\n");

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
    const raw = await getRecentCognitionAsync(viewerContext.viewer_agent_id, viewerContext.session_id, this.repos);
    return appendGuidanceIfPresent(raw);
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
    const raw = await getTypedRetrievalSurfaceAsync(
      userMessage,
      viewerContext,
      this.repos,
      this.retrievalService,
      mergedOptions,
      this.episodeRepo,
    );
    return appendGuidanceIfPresent(raw);
  }
}

function appendGuidanceIfPresent(content: string): string {
  if (!content || content.trim().length === 0) return content;
  return `${content}\n\n${WEAK_MEMORY_INTERPRETATION_GUIDANCE}`;
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
