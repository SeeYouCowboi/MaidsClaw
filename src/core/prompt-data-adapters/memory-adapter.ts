import type { RetrievalService } from "../../memory/retrieval.js";
import {
  getAttachedSharedBlocksAsync,
  getKnownEntitiesForWritingAsync,
  getPinnedBlocksAsync,
  getRecentCognitionAsync,
  getSharedBlocksAsync,
  getTypedRetrievalSurfaceAsync,
  type PromptDataRepos,
} from "../../memory/prompt-data.js";
import type { EpisodeRepo } from "../../storage/domain-repos/contracts/episode-repo.js";
import type {
  KnownEntityPromptOptions,
  MemoryDataSource,
  TypedRetrievalSurfaceOptions,
  ViewerContext,
} from "../prompt-data-sources.js";

type EntityReconciliationRunner = {
  runSweep(input: {
    agentId: string;
    sessionId?: string;
    dryRun?: boolean;
    maxCandidatesPerKey?: number;
    scope?: "shared_public" | "private_overlay";
  }): Promise<{ skipped_due_lock: boolean }>;
};

export const WEAK_MEMORY_INTERPRETATION_GUIDANCE = [
  "Cognition entries may be prefixed with [basis=X provenance=Y verification=Z].",
  "Treat the entry as low-confidence, fragmentary memory when verification is unverified, or when basis is belief or unknown, or when basis is inference and verification is not strong_verified.",
  "Do not use provenance alone as a low-confidence trigger once basis and verification have already been normalized.",
  "Use uncertain language when relying on low-confidence entries, do not repeat the bracketed metadata verbatim, and do not present them as quoted evidence.",
  "Strong verification can rescue user-stated or other weak-at-write-time entries once post-verification normalization has upgraded their trust state; do not keep them permanently low-confidence solely because their write-time provenance was weak.",
  "Entries without the prefix, or entries whose final basis/verification state no longer satisfies the low-confidence rule, may be treated as grounded memory.",
].join("\n");

export class MemoryAdapter implements MemoryDataSource {
  private readonly entitySyncInflight = new Map<string, Promise<void>>();
  private readonly entitySyncLastAttemptAt = new Map<string, number>();

  constructor(
    private readonly repos: PromptDataRepos,
    private readonly retrievalService?: RetrievalService,
    private readonly episodeRepo?: EpisodeRepo,
    private readonly sceneRetrieval?: boolean,
    private readonly entityReconciliation?: EntityReconciliationRunner,
  ) {}

  async getPinnedBlocks(agentId: string): Promise<string> {
    return getPinnedBlocksAsync(agentId, this.repos);
  }

  async getSharedBlocks(agentId: string): Promise<string> {
    return getSharedBlocksAsync(agentId, this.repos);
  }

  async getRecentCognition(viewerContext: ViewerContext): Promise<string> {
    const raw = await getRecentCognitionAsync(
      viewerContext,
      this.repos,
      this.episodeRepo,
    );
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
    this.scheduleRecentEntitiesSync(viewerContext);
    const mergedOptions: TypedRetrievalSurfaceOptions = {
      ...options,
      sceneRetrieval: options?.sceneRetrieval ?? this.sceneRetrieval,
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

  async getKnownEntitiesForWriting(
    viewerContext: ViewerContext,
    options?: KnownEntityPromptOptions,
  ): Promise<string> {
    this.scheduleRecentEntitiesSync(viewerContext);
    return getKnownEntitiesForWritingAsync(
      viewerContext,
      this.repos,
      this.episodeRepo,
      options,
    );
  }

  private scheduleRecentEntitiesSync(
    viewerContext: ViewerContext,
  ): void {
    if (!this.entityReconciliation) {
      return;
    }

    const key = `${viewerContext.viewer_agent_id}:${viewerContext.session_id}`;
    const inflight = this.entitySyncInflight.get(key);
    if (inflight) {
      return;
    }

    const now = Date.now();
    const lastAttemptAt = this.entitySyncLastAttemptAt.get(key);
    if (lastAttemptAt !== undefined && now - lastAttemptAt < 1500) {
      return;
    }
    this.entitySyncLastAttemptAt.set(key, now);

    const run = (async () => {
      try {
        // Entity reconciliation can call LLMs/embeddings. It must not sit on
        // the prompt-build critical path; retrieval can use the current index
        // and pick up canonicalization on a later turn.
        await this.entityReconciliation?.runSweep({
          agentId: viewerContext.viewer_agent_id,
          sessionId: viewerContext.session_id,
          dryRun: false,
          maxCandidatesPerKey: 6,
          scope: "private_overlay",
        });
      } catch {
        // Prompt building should degrade gracefully when entity sync fails.
      } finally {
        this.entitySyncLastAttemptAt.set(key, Date.now());
        this.entitySyncInflight.delete(key);
      }
    })();
    this.entitySyncInflight.set(key, run);
    void run;
  }
}

function appendGuidanceIfPresent(content: string): string {
  if (!content || content.trim().length === 0) return content;
  return `${content}\n\n${WEAK_MEMORY_INTERPRETATION_GUIDANCE}`;
}
