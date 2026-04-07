import type {
  NarrativeSearchHit,
  NarrativeSearchRepo,
} from "../../storage/domain-repos/contracts/narrative-search-repo.js";
import type { EmbeddingRepo } from "../../storage/domain-repos/contracts/embedding-repo.js";
import type { MemoryTaskModelProvider } from "../task-agent.js";
import type { MemoryHint, NodeRef, ViewerContext } from "../types.js";

type NarrativeSearchResult = {
  source_ref: NodeRef;
  doc_type: string;
  content: string;
  scope: "area" | "world";
  score: number;
};

export type EmbeddingFallbackConfig = {
  embeddingRepo: EmbeddingRepo;
  modelProvider: Pick<MemoryTaskModelProvider, "embed">;
  embeddingModelId: string;
  /** Minimum number of pg_trgm hits before skipping embedding fallback (default: 1) */
  minTextHits?: number;
};

/**
 * Narrative-only search — queries ONLY `search_docs_area` + `search_docs_world`.
 * Never reads `search_docs_private` (cognition layer, T12).
 * Visibility: `viewer_agent_id` + `current_area_id`, NOT `viewer_role`.
 *
 * When an optional `embeddingFallback` is configured, the service will
 * fall back to embedding cosine similarity when pg_trgm text search
 * returns fewer than `minTextHits` results.
 */
export class NarrativeSearchService {
  private readonly repo: NarrativeSearchRepo;
  private embeddingFallback: EmbeddingFallbackConfig | null = null;

  constructor(repo: NarrativeSearchRepo) {
    this.repo = repo;
  }

  setEmbeddingFallback(config: EmbeddingFallbackConfig): void {
    this.embeddingFallback = config;
  }

  async searchNarrative(query: string, viewerContext: ViewerContext): Promise<NarrativeSearchResult[]> {
    const hits = await this.repo.searchNarrative({ text: query }, viewerContext);
    const textResults = hits.map((hit) => this.mapHit(hit));

    if (!this.embeddingFallback) {
      return textResults;
    }

    // Hybrid search: RRF (Reciprocal Rank Fusion) of pg_trgm + embedding results
    return this.rrfMerge(query, textResults);
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

  /**
   * Reciprocal Rank Fusion: merge text (pg_trgm) and embedding (cosine)
   * results using RRF scoring: score(d) = Σ 1/(k + rank_i(d))
   *
   * Both retrieval signals contribute; a document that scores well in
   * both methods is boosted to the top.
   */
  private async rrfMerge(
    query: string,
    textResults: NarrativeSearchResult[],
  ): Promise<NarrativeSearchResult[]> {
    const fb = this.embeddingFallback!;
    const RRF_K = 60;

    let embeddingResults: NarrativeSearchResult[] = [];
    try {
      const [queryVector] = await fb.modelProvider.embed(
        [query],
        "query_expansion",
        fb.embeddingModelId,
      );
      if (queryVector && queryVector.length > 0) {
        const neighbors = await fb.embeddingRepo.query(queryVector, {
          agentId: null,
          modelId: fb.embeddingModelId,
          limit: 20,
        });
        for (const neighbor of neighbors) {
          const content = await this.resolveContentForRef(neighbor.nodeRef);
          if (!content) continue;
          embeddingResults.push({
            source_ref: neighbor.nodeRef,
            doc_type: neighbor.nodeKind,
            content,
            scope: "world",
            score: neighbor.similarity,
          });
        }
      }
    } catch {
      // Embedding unavailable — return text-only results
      return textResults;
    }

    // Build RRF score map
    const rrfScores = new Map<string, { result: NarrativeSearchResult; score: number }>();

    for (const [rank, result] of textResults.entries()) {
      const key = result.source_ref;
      const entry = rrfScores.get(key) ?? { result, score: 0 };
      entry.score += 1 / (RRF_K + rank + 1);
      rrfScores.set(key, entry);
    }

    for (const [rank, result] of embeddingResults.entries()) {
      const key = result.source_ref;
      const existing = rrfScores.get(key);
      if (existing) {
        existing.score += 1 / (RRF_K + rank + 1);
      } else {
        rrfScores.set(key, { result, score: 1 / (RRF_K + rank + 1) });
      }
    }

    return Array.from(rrfScores.values())
      .sort((a, b) => b.score - a.score)
      .map((entry) => ({ ...entry.result, score: entry.score }));
  }

  private async resolveContentForRef(nodeRef: NodeRef): Promise<string | null> {
    const fb = this.embeddingFallback;
    if (!fb) return null;

    // Try search_docs_world first
    const repo = this.repo as unknown as { sql?: import("postgres").Sql };
    if (!repo.sql) return null;

    const rows = await repo.sql<Array<{ content: string }>>`
      SELECT content FROM search_docs_world
      WHERE source_ref = ${nodeRef}
      LIMIT 1
    `;
    if (rows.length > 0 && rows[0].content) return rows[0].content;

    // Try search_docs_cognition
    const cogRows = await repo.sql<Array<{ content: string }>>`
      SELECT content FROM search_docs_cognition
      WHERE source_ref = ${nodeRef}
      LIMIT 1
    `;
    if (cogRows.length > 0 && cogRows[0].content) return cogRows[0].content;

    // Try entity display name
    const [kindRaw] = nodeRef.split(":");
    if (kindRaw === "entity") {
      const entityRows = await repo.sql<Array<{ display_name: string; pointer_key: string }>>`
        SELECT display_name, pointer_key FROM entity_nodes
        WHERE id = ${Number(nodeRef.split(":")[1])}
        LIMIT 1
      `;
      if (entityRows.length > 0) {
        return `${entityRows[0].display_name} (${entityRows[0].pointer_key})`;
      }
    }

    return null;
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
