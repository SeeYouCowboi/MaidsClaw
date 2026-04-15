import type postgres from "postgres";
import type { ViewerContext } from "../../../memory/types.js";
import type {
  NarrativeSearchHit,
  NarrativeSearchQuery,
  NarrativeSearchRepo,
} from "../contracts/narrative-search-repo.js";
import { isCjkQuery, decomposeCjk, type CjkDecomposition } from "./cjk-search-utils.js";

type PgNarrativeSearchRow = {
  source_ref: string;
  doc_type: string;
  content: string;
  score: number | string;
};

const DEFAULT_LIMIT = 20;
const DEFAULT_MIN_SCORE = 0.2;

function toNumber(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

export class PgNarrativeSearchRepo implements NarrativeSearchRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async searchNarrative(
    query: NarrativeSearchQuery,
    viewerContext: ViewerContext,
  ): Promise<NarrativeSearchHit[]> {
    const trimmed = query.text.trim();
    if (trimmed.length < 2) {
      return [];
    }

    const includeArea = query.includeArea ?? true;
    const includeWorld = query.includeWorld ?? true;
    const includeEpisode = query.includeEpisode ?? false;
    if (!includeArea && !includeWorld && !includeEpisode) {
      return [];
    }

    const limit = Math.max(1, query.limit ?? DEFAULT_LIMIT);
    const minScore = query.minScore ?? DEFAULT_MIN_SCORE;

    // GAP-4 §1: only honor non-empty entity id lists. Empty == no filter.
    const entityIds = query.entityIds && query.entityIds.length > 0 ? query.entityIds : undefined;
    const asOfCommittedTime = query.timeWindow?.asOfCommittedTime;

    if (isCjkQuery(trimmed)) {
      return this.searchCjk(trimmed, viewerContext, includeArea, includeWorld, includeEpisode, limit, minScore, entityIds, asOfCommittedTime);
    }

    return this.searchLatin(trimmed, viewerContext, includeArea, includeWorld, includeEpisode, limit, minScore, entityIds, asOfCommittedTime);
  }

  private async searchCjk(
    trimmed: string,
    viewerContext: ViewerContext,
    includeArea: boolean,
    includeWorld: boolean,
    includeEpisode: boolean,
    limit: number,
    minScore: number,
    entityIds: number[] | undefined,
    asOfCommittedTime: number | undefined,
  ): Promise<NarrativeSearchHit[]> {
    const decomp = decomposeCjk(trimmed);
    const results: NarrativeSearchHit[] = [];

    // Build ILIKE patterns for WHERE and scoring.
    // Uses tagged templates (not sql.unsafe) to preserve search_path in bun test.
    const exactPattern = `%${decomp.original}%`;
    const bigramPatterns = decomp.bigrams.map((bg) => `%${bg}%`);
    const unigramPatterns = decomp.unigrams.map((ug) => `%${ug}%`);

    // P2-A: prefer bigrams over the first 3 unigrams — they carry far
    // more information per pattern. Falls back to unigrams for single-char
    // queries. Capped so the ILIKE ANY expression stays bounded.
    const CJK_NARRATIVE_PATTERN_CAP = 20;
    const filterPatterns: string[] = [exactPattern];
    const grams = bigramPatterns.length > 0 ? bigramPatterns : unigramPatterns;
    for (const p of grams) {
      if (filterPatterns.length >= CJK_NARRATIVE_PATTERN_CAP) break;
      filterPatterns.push(p);
    }

    if (includeArea && viewerContext.current_area_id != null) {
      // GAP-4 §1: extra entity_ids filter — search_docs_area only stores
      // location_entity_id, so we narrow by that column. Plan-supplied
      // entityIds are interpreted as "the location must be one of these".
      const areaRows = await this.sql<PgNarrativeSearchRow[]>`
        SELECT d.source_ref, d.doc_type, d.content, 0::real AS score
        FROM search_docs_area d
        WHERE d.location_entity_id = ${viewerContext.current_area_id}
          AND lower(d.content) ILIKE ANY(${filterPatterns})
          ${entityIds ? this.sql`AND d.location_entity_id = ANY(${entityIds})` : this.sql``}
          ${asOfCommittedTime != null ? this.sql`AND d.created_at <= ${asOfCommittedTime}` : this.sql``}
        LIMIT ${limit * 2}
      `;
      results.push(...areaRows.map((row) => this.mapRow(row, "area")));
    }

    if (includeWorld) {
      // GAP-4 §1: search_docs_world has no entity column. entityIds is
      // wired through the contract but cannot be honored here without a
      // schema migration; document the gap and proceed without filter.
      const worldRows = await this.sql<PgNarrativeSearchRow[]>`
        SELECT d.source_ref, d.doc_type, d.content, 0::real AS score
        FROM search_docs_world d
        WHERE lower(d.content) ILIKE ANY(${filterPatterns})
          ${asOfCommittedTime != null ? this.sql`AND d.created_at <= ${asOfCommittedTime}` : this.sql``}
        LIMIT ${limit * 2}
      `;
      results.push(...worldRows.map((row) => this.mapRow(row, "world")));
    }

    // P2-B: private episode projection, strictly agent-scoped. Cross-agent
    // read is not permitted at this layer — the agent_id gate is mandatory.
    if (includeEpisode) {
      const agentId = viewerContext.viewer_agent_id;
      const episodeRows = await this.sql<PgNarrativeSearchRow[]>`
        SELECT d.source_ref, d.doc_type, d.content, 0::real AS score
        FROM search_docs_episode d
        WHERE d.agent_id = ${agentId}
          AND lower(d.content) ILIKE ANY(${filterPatterns})
          ${asOfCommittedTime != null ? this.sql`AND d.committed_at <= ${asOfCommittedTime}` : this.sql``}
        LIMIT ${limit * 2}
      `;
      results.push(...episodeRows.map((row) => this.mapRow(row, "episode")));
    }

    // Compute CJK bigram scores in application code
    for (const hit of results) {
      hit.score = this.computeCjkScore(hit.content, decomp);
    }

    return this.dedup(results, limit, minScore);
  }

  private computeCjkScore(content: string, decomp: CjkDecomposition): number {
    const lower = content.toLowerCase();
    let raw = 0;
    if (lower.includes(decomp.original.toLowerCase())) raw += 5;
    for (const bg of decomp.bigrams) {
      if (lower.includes(bg)) raw += 3;
    }
    for (const ug of decomp.unigrams) {
      if (lower.includes(ug)) raw += 1;
    }
    return decomp.maxScore > 0 ? raw / decomp.maxScore : 0;
  }

  private async searchLatin(
    trimmed: string,
    viewerContext: ViewerContext,
    includeArea: boolean,
    includeWorld: boolean,
    includeEpisode: boolean,
    limit: number,
    minScore: number,
    entityIds: number[] | undefined,
    asOfCommittedTime: number | undefined,
  ): Promise<NarrativeSearchHit[]> {
    const normalizedQuery = trimmed.toLowerCase();
    const pattern = `%${trimmed}%`;
    const results: NarrativeSearchHit[] = [];

    if (includeArea && viewerContext.current_area_id != null) {
      const areaRows = await this.sql<PgNarrativeSearchRow[]>`
        SELECT d.source_ref,
               d.doc_type,
               d.content,
               GREATEST(
                 similarity(lower(d.content), ${normalizedQuery}),
                 word_similarity(lower(d.content), ${normalizedQuery}),
                 CASE WHEN lower(d.content) ILIKE ${pattern} THEN ${minScore}::real ELSE 0::real END
               ) AS score
        FROM search_docs_area d
        WHERE d.location_entity_id = ${viewerContext.current_area_id}
          AND (
            lower(d.content) % ${normalizedQuery}
            OR lower(d.content) ILIKE ${pattern}
            OR word_similarity(lower(d.content), ${normalizedQuery}) >= ${minScore}
          )
          ${entityIds ? this.sql`AND d.location_entity_id = ANY(${entityIds})` : this.sql``}
          ${asOfCommittedTime != null ? this.sql`AND d.created_at <= ${asOfCommittedTime}` : this.sql``}
        ORDER BY score DESC, d.created_at DESC
        LIMIT ${limit}
      `;
      results.push(...areaRows.map((row) => this.mapRow(row, "area")));
    }

    if (includeWorld) {
      const worldRows = await this.sql<PgNarrativeSearchRow[]>`
        SELECT d.source_ref,
               d.doc_type,
               d.content,
               GREATEST(
                 similarity(lower(d.content), ${normalizedQuery}),
                 word_similarity(lower(d.content), ${normalizedQuery}),
                 CASE WHEN lower(d.content) ILIKE ${pattern} THEN ${minScore}::real ELSE 0::real END
               ) AS score
        FROM search_docs_world d
        WHERE (
          lower(d.content) % ${normalizedQuery}
          OR lower(d.content) ILIKE ${pattern}
          OR word_similarity(lower(d.content), ${normalizedQuery}) >= ${minScore}
        )
          ${asOfCommittedTime != null ? this.sql`AND d.created_at <= ${asOfCommittedTime}` : this.sql``}
        ORDER BY score DESC, d.created_at DESC
        LIMIT ${limit}
      `;
      results.push(...worldRows.map((row) => this.mapRow(row, "world")));
    }

    // P2-B: private episode projection, strictly agent-scoped.
    if (includeEpisode) {
      const agentId = viewerContext.viewer_agent_id;
      const episodeRows = await this.sql<PgNarrativeSearchRow[]>`
        SELECT d.source_ref,
               d.doc_type,
               d.content,
               GREATEST(
                 similarity(lower(d.content), ${normalizedQuery}),
                 word_similarity(lower(d.content), ${normalizedQuery}),
                 CASE WHEN lower(d.content) ILIKE ${pattern} THEN ${minScore}::real ELSE 0::real END
               ) AS score
        FROM search_docs_episode d
        WHERE d.agent_id = ${agentId}
          AND (
            lower(d.content) % ${normalizedQuery}
            OR lower(d.content) ILIKE ${pattern}
            OR word_similarity(lower(d.content), ${normalizedQuery}) >= ${minScore}
          )
          ${asOfCommittedTime != null ? this.sql`AND d.committed_at <= ${asOfCommittedTime}` : this.sql``}
        ORDER BY score DESC, d.committed_at DESC
        LIMIT ${limit}
      `;
      results.push(...episodeRows.map((row) => this.mapRow(row, "episode")));
    }

    return this.dedup(results, limit, minScore);
  }

  private dedup(results: NarrativeSearchHit[], limit: number, minScore: number): NarrativeSearchHit[] {
    const deduped = new Map<string, NarrativeSearchHit>();
    for (const result of results) {
      if (result.score < minScore) {
        continue;
      }
      const key = `${result.sourceRef}|${result.docType}`;
      const existing = deduped.get(key);
      if (!existing || result.score > existing.score) {
        deduped.set(key, result);
      }
    }

    return Array.from(deduped.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private mapRow(
    row: PgNarrativeSearchRow,
    scope: "area" | "world" | "episode",
  ): NarrativeSearchHit {
    return {
      sourceRef: row.source_ref as NarrativeSearchHit["sourceRef"],
      docType: row.doc_type,
      content: row.content,
      scope,
      score: toNumber(row.score),
    };
  }
}
