import type { NodeRef, ViewerContext } from "../../../memory/types.js";
import type { TimeSliceQuery } from "../../../memory/time-slice-query.js";

export type NarrativeSearchQuery = {
  text: string;
  limit?: number;
  minScore?: number;
  includeArea?: boolean;
  includeWorld?: boolean;
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
  scope: "area" | "world";
  score: number;
};

export interface NarrativeSearchRepo {
  /**
   * Executes narrative-only full-text search for the caller's visibility context.
   * Implementations must search only narrative surfaces (area/world), never private cognition.
   */
  searchNarrative(query: NarrativeSearchQuery, viewerContext: ViewerContext): Promise<NarrativeSearchHit[]>;
}
