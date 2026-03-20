import type { AgentProfile } from "../../agents/profile.js";
import type { ViewerContext } from "../../core/contracts/viewer-context.js";
import type { MemoryHint } from "../types.js";
import type { NarrativeSearchService } from "../narrative/narrative-search.js";
import type { CognitionSearchService, CognitionHit } from "../cognition/cognition-search.js";
import { resolveTemplate } from "../contracts/retrieval-template.js";

export type RetrievalResult = {
  narrativeHints: MemoryHint[];
  cognitionHits: CognitionHit[];
};

export class RetrievalOrchestrator {
  constructor(
    private readonly narrativeService: NarrativeSearchService,
    private readonly cognitionService: CognitionSearchService,
  ) {}

  async search(
    query: string,
    viewerContext: ViewerContext,
    agentProfile: AgentProfile,
  ): Promise<RetrievalResult> {
    const template = resolveTemplate(agentProfile.role, agentProfile.retrievalTemplate);

    const narrativeHints: MemoryHint[] =
      template.narrativeEnabled && template.maxNarrativeHits > 0
        ? await this.narrativeService.generateMemoryHints(query, viewerContext, template.maxNarrativeHits)
        : [];

    const cognitionHits: CognitionHit[] =
      template.cognitionEnabled && template.maxCognitionHits > 0
        ? this.cognitionService.searchCognition({
            agentId: viewerContext.viewer_agent_id,
            query,
            activeOnly: true,
            limit: template.maxCognitionHits,
          })
        : [];

    return { narrativeHints, cognitionHits };
  }
}
