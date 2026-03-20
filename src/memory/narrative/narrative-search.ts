import type { Db } from "../../storage/database.js";
import type { MemoryHint, NodeRef, ViewerContext } from "../types.js";

type SearchRow = {
  source_ref: string;
  doc_type: string;
  content: string;
};

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
  constructor(private readonly db: Db) {}

  async searchNarrative(query: string, viewerContext: ViewerContext): Promise<NarrativeSearchResult[]> {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      return [];
    }

    const safeQuery = this.escapeFtsQuery(trimmed);
    const rawResults: NarrativeSearchResult[] = [];

    // Area-visible docs: gated on current_area_id presence (not viewer_role)
    if (viewerContext.current_area_id != null) {
      const areaRows = this.db
        .prepare(
          `SELECT d.source_ref, d.doc_type, d.content
           FROM search_docs_area d
           JOIN search_docs_area_fts f ON f.rowid = d.id
           WHERE f.content MATCH ? AND d.location_entity_id=?`,
        )
        .all(safeQuery, viewerContext.current_area_id) as SearchRow[];
      rawResults.push(...areaRows.map((row) => this.mapRow(row, "area", 0.9)));
    }

    const worldRows = this.db
      .prepare(
        `SELECT d.source_ref, d.doc_type, d.content
         FROM search_docs_world d
         JOIN search_docs_world_fts f ON f.rowid = d.id
         WHERE f.content MATCH ?`,
      )
      .all(safeQuery) as SearchRow[];
    rawResults.push(...worldRows.map((row) => this.mapRow(row, "world", 0.8)));

    const deduped = new Map<string, NarrativeSearchResult>();
    for (const result of rawResults) {
      const key = `${result.source_ref}|${result.doc_type}`;
      const existing = deduped.get(key);
      if (!existing || result.score > existing.score) {
        deduped.set(key, result);
      }
    }

    return Array.from(deduped.values()).sort((a, b) => b.score - a.score);
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

  private mapRow(row: SearchRow, scope: "area" | "world", score: number): NarrativeSearchResult {
    return {
      source_ref: row.source_ref as NodeRef,
      doc_type: row.doc_type,
      content: row.content,
      scope,
      score,
    };
  }
}
