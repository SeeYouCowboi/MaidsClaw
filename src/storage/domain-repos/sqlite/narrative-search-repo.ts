import type { Db } from "../../database.js";
import type {
  NarrativeSearchHit,
  NarrativeSearchQuery,
  NarrativeSearchRepo,
} from "../contracts/narrative-search-repo.js";
import type { ViewerContext } from "../../../memory/types.js";

type SearchRow = {
  source_ref: string;
  doc_type: string;
  content: string;
};

const DEFAULT_LIMIT = 20;

export class SqliteNarrativeSearchRepo implements NarrativeSearchRepo {
  constructor(private readonly db: Db) {}

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
    const minScore = query.minScore ?? Number.NEGATIVE_INFINITY;
    const safeQuery = this.escapeFtsQuery(trimmed);
    const rawResults: NarrativeSearchHit[] = [];

    if (includeArea && viewerContext.current_area_id != null) {
      const areaRows = this.db
        .prepare(
          `SELECT d.source_ref, d.doc_type, d.content
           FROM search_docs_area d
           JOIN search_docs_area_fts f ON f.rowid = d.id
           WHERE f.content MATCH ? AND d.location_entity_id = ?
           LIMIT ?`,
        )
        .all(safeQuery, viewerContext.current_area_id, limit) as SearchRow[];
      rawResults.push(...areaRows.map((row) => this.mapRow(row, "area", 0.9)));
    }

    if (includeWorld) {
      const worldRows = this.db
        .prepare(
          `SELECT d.source_ref, d.doc_type, d.content
           FROM search_docs_world d
           JOIN search_docs_world_fts f ON f.rowid = d.id
           WHERE f.content MATCH ?
           LIMIT ?`,
        )
        .all(safeQuery, limit) as SearchRow[];
      rawResults.push(...worldRows.map((row) => this.mapRow(row, "world", 0.8)));
    }

    const deduped = new Map<string, NarrativeSearchHit>();
    for (const result of rawResults) {
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

  private escapeFtsQuery(input: string): string {
    const tokens = input
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .map((token) => token.replaceAll('"', '""'));

    if (tokens.length === 0) {
      return `"${input.replaceAll('"', '""')}"`;
    }

    if (tokens.length === 1) {
      return `"${tokens[0]}"`;
    }

    return tokens.map((token) => `"${token}"`).join(" OR ");
  }

  private mapRow(row: SearchRow, scope: "area" | "world", score: number): NarrativeSearchHit {
    return {
      sourceRef: row.source_ref as NarrativeSearchHit["sourceRef"],
      docType: row.doc_type,
      content: row.content,
      scope,
      score,
    };
  }
}
