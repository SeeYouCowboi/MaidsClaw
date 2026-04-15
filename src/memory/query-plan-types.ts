/**
 * Phase 2 QueryPlan type definitions.
 *
 * QueryPlan is the executor-facing translation of a QueryRoute. It packages
 * surface-specific facets (per-surface weights, entity filters, time windows)
 * and a graph plan (per-kind seed bias, edge bias). Phase 2 builds plans in
 * shadow mode only — they are emitted to trace but never consumed by retrieval
 * or graph execution. Phase 3 will let RetrievalOrchestrator consume them;
 * Phase 4 will let GraphNavigator consume them.
 */

import type { AgentRole } from "../agents/profile.js";
import type { TimeSliceQuery } from "./time-slice-query.js";
import type { QueryRoute } from "./query-routing-types.js";
import type { QueryType } from "./types.js";

/**
 * Generic per-surface facets.
 *
 * Phase 2 was strictly metadata-only ("NEVER rewritten"). Phase 3+ allows an
 * optional `rewrittenQuery` — a deterministic enrichment of `baseQuery` with
 * router-resolved signals (entity hints + intent keywords) — which each
 * per-surface search is free to prefer over the raw text. When undefined,
 * callers fall back to `baseQuery`, so existing consumers stay correct.
 */
export type SurfaceFacets = {
  /** Always === route.normalizedQuery. */
  baseQuery: string;
  /**
   * Optional search-friendly rewrite of baseQuery. Phase 3 construction is
   * deterministic: intent keywords + entity hints + the normalized query,
   * joined with spaces. undefined when the rewrite would equal baseQuery.
   */
  rewrittenQuery?: string;
  /** Resolved entity IDs to filter on at the surface layer. */
  entityFilters: number[];
  /** Optional valid/committed time window. */
  timeWindow: TimeSliceQuery | null;
  /** 0..1 importance weight; 0 means "skip this surface". */
  weight: number;
  /** Whether the role's retrieval template enables this surface at all. */
  enabledByRole: boolean;
};

/** Cognition surface accepts additional kind/stance filters. */
export type CognitionFacets = SurfaceFacets & {
  kind?: "assertion" | "evaluation" | "commitment";
  stance?: "confirmed" | "contested" | "hypothetical";
};

export type GraphPlan = {
  primaryIntent: QueryType;
  /** Non-primary intents sorted by descending confidence. */
  secondaryIntents: QueryType[];
  /** Optional time slice — null in Phase 2 unless route.timeConstraint is set. */
  timeSlice: TimeSliceQuery | null;
  /** Continuous 0..1 bias per node kind. */
  seedBias: {
    entity: number;
    event: number;
    episode: number;
    assertion: number;
    evaluation: number;
    commitment: number;
  };
  /**
   * Sparse multiplier per memory relation type. Only set keys override
   * defaults; absence means "no plan-level override".
   */
  edgeBias: Partial<Record<string, number>>;
};

export type QueryPlan = {
  route: QueryRoute;
  surfacePlans: {
    narrative: SurfaceFacets;
    cognition: CognitionFacets;
    episode: SurfaceFacets;
    conflictNotes: SurfaceFacets;
  };
  graphPlan: GraphPlan;
  /** "deterministic-v1" or future variants. */
  builderVersion: string;
  /** Human-readable trace of major decisions. */
  rationale: string;
  /** Structured rule names for machine-readable trace. */
  matchedRules: string[];
};

export interface QueryPlanBuilder {
  build(input: { route: QueryRoute; role: AgentRole }): QueryPlan;
}
