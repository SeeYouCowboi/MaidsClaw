import type { NodeRef, ViewerContext } from "../../../memory/types.js";
import type { TimeSliceQuery } from "../../../memory/time-slice-query.js";

export type NarrativeSearchQuery = {
  text: string;
  limit?: number;
  minScore?: number;
  includeArea?: boolean;
  includeWorld?: boolean;
  /**
   * P2-B: when true, also search `search_docs_episode` for rows whose
   * `agent_id` matches `viewerContext.viewer_agent_id`. Strict single-agent
   * isolation — there is no cross-agent read path. When false/undefined,
   * behavior is identical to the pre-P2-B narrative-only shape.
   *
   * Safe to enable now that Commit A populates `search_docs_episode` on
   * every settlement; before Commit A the table was table-wide empty and
   * this flag would have been a no-op.
   */
  includeEpisode?: boolean;
  /**
   * GAP-4 §1: optional entity-id filter sourced from
   * `plan.surfacePlans.narrative.entityFilters`. An empty array is treated
   * the same as `undefined` (no filter); only a non-empty list narrows
   * results. NOTE: the current schema only stores
   * `search_docs_area.location_entity_id`, so this filter is honored ONLY
   * for area-scoped rows. World-scoped rows pass through unchanged. A
   * follow-up schema migration is required for full per-document
   * containment filtering.
   */
  entityIds?: number[];
  /**
   * GAP-4 §1: optional time window from
   * `plan.surfacePlans.narrative.timeWindow`. When `asOfCommittedTime` is
   * set, results are filtered to documents whose `created_at` is at or
   * before that timestamp. `asOfValidTime` is currently ignored at the
   * search-doc layer (the area/world tables don't store valid time).
   */
  timeWindow?: TimeSliceQuery;
};

export type NarrativeSearchHit = {
  sourceRef: NodeRef;
  docType: string;
  content: string;
  scope: "area" | "world" | "episode";
  score: number;
};

export interface NarrativeSearchRepo {
  /**
   * Executes full-text search across the caller's visible narrative surfaces.
   *
   * Default behavior (pre-P2-B): searches `search_docs_area` +
   * `search_docs_world` only. Never reads `search_docs_private` or
   * `search_docs_cognition` (those go through the cognition layer).
   *
   * P2-B extension: when `query.includeEpisode === true`, also reads
   * `search_docs_episode` gated by `viewerContext.viewer_agent_id`.
   */
  searchNarrative(query: NarrativeSearchQuery, viewerContext: ViewerContext): Promise<NarrativeSearchHit[]>;
}
