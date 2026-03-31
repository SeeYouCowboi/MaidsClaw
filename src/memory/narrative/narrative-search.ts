import type { Db } from "../../storage/database.js";
import type {
  NarrativeSearchHit,
  NarrativeSearchRepo,
} from "../../storage/domain-repos/contracts/narrative-search-repo.js";
import { SqliteNarrativeSearchRepo } from "../../storage/domain-repos/sqlite/narrative-search-repo.js";
import type { MemoryHint, NodeRef, ViewerContext } from "../types.js";

type NarrativeSearchResult = {
  source_ref: NodeRef;
  doc_type: string;
  content: string;
  scope: "area" | "world";
  score: number;
};

/**
 * Narrative-only search — queries ONLY `search_docs_area` + `search_docs_world`.
 * Never reads `search_docs_private` (cognition layer, T12).
 * Visibility: `viewer_agent_id` + `current_area_id`, NOT `viewer_role`.
 */
export class NarrativeSearchService {
  private readonly repo: NarrativeSearchRepo;

  constructor(repoOrDb: NarrativeSearchRepo | Db) {
    this.repo = this.isNarrativeSearchRepo(repoOrDb)
      ? repoOrDb
      : new SqliteNarrativeSearchRepo(repoOrDb);
  }

  async searchNarrative(query: string, viewerContext: ViewerContext): Promise<NarrativeSearchResult[]> {
    const hits = await this.repo.searchNarrative({ text: query }, viewerContext);
    return hits.map((hit) => this.mapHit(hit));
  }

  async generateMemoryHints(
    userMessage: string,
    viewerContext: ViewerContext,
    limit = 5,
  ): Promise<MemoryHint[]> {
    if (userMessage.trim().length < 3) {
      return [];
    }

    const results = await this.searchNarrative(userMessage, viewerContext);
    return results.slice(0, limit).map((result) => ({
      source_ref: result.source_ref,
      scope: result.scope,
      doc_type: result.doc_type,
      content: result.content,
      score: result.score,
    }));
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private isNarrativeSearchRepo(value: NarrativeSearchRepo | Db): value is NarrativeSearchRepo {
    return typeof (value as NarrativeSearchRepo).searchNarrative === "function";
  }

  private mapHit(hit: NarrativeSearchHit): NarrativeSearchResult {
    return {
      source_ref: hit.sourceRef,
      doc_type: hit.docType,
      content: hit.content,
      scope: hit.scope,
      score: hit.score,
    };
  }
}
