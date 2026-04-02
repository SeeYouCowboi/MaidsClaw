import type postgres from "postgres";
import type { ViewerContext } from "../../../memory/types.js";
import type {
  NarrativeSearchHit,
  NarrativeSearchQuery,
  NarrativeSearchRepo,
} from "../contracts/narrative-search-repo.js";

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
    if (trimmed.length < 3) {
      return [];
    }

    const includeArea = query.includeArea ?? true;
    const includeWorld = query.includeWorld ?? true;
    if (!includeArea && !includeWorld) {
      return [];
    }

    const limit = Math.max(1, query.limit ?? DEFAULT_LIMIT);
    const minScore = query.minScore ?? DEFAULT_MIN_SCORE;
    const normalizedQuery = trimmed.toLowerCase();
    const pattern = `%${trimmed}%`;
    const results: NarrativeSearchHit[] = [];

    if (includeArea && viewerContext.current_area_id != null) {
      const areaRows = await this.sql<PgNarrativeSearchRow[]>`
        SELECT d.source_ref,
               d.doc_type,
               d.content,
               GREATEST(similarity(lower(d.content), ${normalizedQuery}), word_similarity(lower(d.content), ${normalizedQuery})) AS score
        FROM search_docs_area d
        WHERE d.location_entity_id = ${viewerContext.current_area_id}
          AND (
            lower(d.content) % ${normalizedQuery}
            OR lower(d.content) ILIKE ${pattern}
            OR word_similarity(lower(d.content), ${normalizedQuery}) >= ${minScore}
          )
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
               GREATEST(similarity(lower(d.content), ${normalizedQuery}), word_similarity(lower(d.content), ${normalizedQuery})) AS score
        FROM search_docs_world d
        WHERE (
          lower(d.content) % ${normalizedQuery}
          OR lower(d.content) ILIKE ${pattern}
          OR word_similarity(lower(d.content), ${normalizedQuery}) >= ${minScore}
        )
        ORDER BY score DESC, d.created_at DESC
        LIMIT ${limit}
      `;
      results.push(...worldRows.map((row) => this.mapRow(row, "world")));
    }

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

  private mapRow(row: PgNarrativeSearchRow, scope: "area" | "world"): NarrativeSearchHit {
    return {
      sourceRef: row.source_ref as NarrativeSearchHit["sourceRef"],
      docType: row.doc_type,
      content: row.content,
      scope,
      score: toNumber(row.score),
    };
  }
}
