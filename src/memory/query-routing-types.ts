/**
 * QueryRouter Phase 1 type definitions.
 *
 * QueryRoute is a structured, multi-intent representation of a user query
 * shared between GraphNavigator and RetrievalOrchestrator. Phase 1 only emits
 * QueryRoute to trace (shadow mode); execution paths still consume the legacy
 * QueryAnalysis from GraphNavigator.analyzeQuery.
 */

import type { QueryType } from "./types.js";
import type { TimeSliceQuery } from "./time-slice-query.js";

export type RoutedIntent = {
  type: QueryType;
  /** Confidence in 0..1, derived from evidence count and rule weight. */
  confidence: number;
  /** Keywords or rule names that triggered this intent. */
  evidence: string[];
};

/**
 * Continuous resource-allocation signals in 0..1.
 * Phase 1 only emits these; Phase 2/3 will let orchestrator consume them.
 */
export type QuerySignals = {
  needsEpisode: number;
  needsConflict: number;
  needsTimeline: number;
  needsRelationship: number;
  needsCognition: number;
  needsEntityFocus: number;
};

export type QueryRoute = {
  // Input snapshot
  originalQuery: string;
  normalizedQuery: string;

  // Multi-intent classification
  intents: RoutedIntent[];
  /** Highest-confidence intent; matches legacy analyzeQuery for parity. */
  primaryIntent: QueryType;
  /** Max confidence across all intents. */
  routeConfidence: number;

  // Entities and relations
  resolvedEntityIds: number[];
  entityHints: string[];
  /** Phase 1: always empty. Reserved for Phase 2 syntax-aware extraction. */
  relationPairs: Array<[number, number]>;

  // Time and location
  /** Phase 1: always null. Reserved for Phase 2 keyword→TimeSliceQuery mapping. */
  timeConstraint: TimeSliceQuery | null;
  timeSignals: string[];
  /** Phase 1: always empty. Reserved for Phase 2 location vocabulary. */
  locationHints: string[];

  // High-level signals
  asksWhy: boolean;
  asksChange: boolean;
  asksComparison: boolean;

  // Resource-allocation signals
  signals: QuerySignals;

  // Observability
  rationale: string;
  matchedRules: string[];
  classifierVersion: string;
};

export interface QueryRouter {
  route(input: {
    query: string;
    viewerAgentId: string;
    explicitMode?: QueryType;
    /**
     * Caller's current area entity id, when applicable. Enables the
     * needsEpisode signal to fold in scene-vocabulary hits the same way
     * resolveEpisodeBudget did with `viewerContext.current_area_id`.
     */
    currentAreaId?: number | null;
  }): Promise<QueryRoute>;
}
