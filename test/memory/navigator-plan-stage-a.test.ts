import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  GRAPH_RETRIEVAL_STRATEGIES,
  effectiveEdgeMultiplier,
  type GraphRetrievalStrategy,
} from "../../src/memory/navigator";
import type { QueryPlan } from "../../src/memory/query-plan-types";

/**
 * GAP-4 §2 Stage A — unit tests for the navigator helper functions that
 * fold `plan.graphPlan.edgeBias` into beam search scoring.
 *
 * Stage A is intentionally narrow:
 *   - Mechanical changes only (4 functions take an extra `plan` argument)
 *   - Covers the merge semantics of `effectiveEdgeMultiplier` — the
 *     helper that replaces three identical `strategy?.edgeWeights[kind]
 *     ?? 1.0` sites in the navigator
 *
 * Post-rollout state: `MAIDSCLAW_NAVIGATOR_USE_PLAN` now defaults to ON
 * in production. The `beforeEach` below explicitly sets it to `"off"`
 * so any "flag explicitly OFF" test in this file still measures the
 * legacy path; individual tests that want flag-on must set `"on"` in
 * their own setup. The saved/restored pattern guarantees flag state
 * never leaks between tests (bun runs tests within a file sequentially).
 *
 * These tests run without a real GraphReadRepo because
 * `effectiveEdgeMultiplier` is module-level and depends only on the
 * strategy object + plan.graphPlan.edgeBias.
 */

function makePlan(edgeBias: Record<string, number>): QueryPlan {
  return {
    route: {
      originalQuery: "test",
      normalizedQuery: "test",
      intents: [],
      primaryIntent: "event",
      routeConfidence: 0.5,
      resolvedEntityIds: [],
      entityHints: [],
      relationPairs: [],
      timeConstraint: null,
      timeSignals: [],
      locationHints: [],
      asksWhy: false,
      asksChange: false,
      asksComparison: false,
      signals: {
        needsEpisode: 0,
        needsConflict: 0,
        needsTimeline: 0,
        needsRelationship: 0,
        needsCognition: 0,
        needsEntityFocus: 0,
      },
      rationale: "",
      matchedRules: [],
      classifierVersion: "rule-v1",
    },
    surfacePlans: {
      narrative: { baseQuery: "test", entityFilters: [], timeWindow: null, weight: 0.5, enabledByRole: true },
      cognition: { baseQuery: "test", entityFilters: [], timeWindow: null, weight: 0.5, enabledByRole: true },
      episode: { baseQuery: "test", entityFilters: [], timeWindow: null, weight: 0.3, enabledByRole: true },
      conflictNotes: { baseQuery: "test", entityFilters: [], timeWindow: null, weight: 0, enabledByRole: true },
    },
    graphPlan: {
      primaryIntent: "event",
      secondaryIntents: [],
      timeSlice: null,
      seedBias: { entity: 0, event: 0, episode: 0, assertion: 0, evaluation: 0, commitment: 0 },
      edgeBias,
    },
    builderVersion: "deterministic-v1",
    rationale: "",
    matchedRules: [],
  };
}

let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN;
  // Post-rollout default is ON — explicitly set "off" so each test
  // starts from a known legacy baseline. Tests that want flag-on must
  // override in their own beforeEach or `it` body.
  process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "off";
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN;
  else process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = savedFlag;
});

describe("effectiveEdgeMultiplier (GAP-4 §2 Stage A)", () => {
  describe("with flag explicitly OFF", () => {
    it("returns strategy multiplier alone when plan is present", () => {
      process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "off";
      const strategy: GraphRetrievalStrategy = GRAPH_RETRIEVAL_STRATEGIES.deep_explain;
      const plan = makePlan({ supports: 5.0 });
      // strategy.edgeWeights.supports = 1.2; flag off → ignore plan multiplier
      expect(effectiveEdgeMultiplier("supports", strategy, plan)).toBeCloseTo(1.2, 5);
    });

    it("returns 1.0 when neither strategy nor plan defines the kind", () => {
      const strategy: GraphRetrievalStrategy = GRAPH_RETRIEVAL_STRATEGIES.default_retrieval;
      expect(effectiveEdgeMultiplier("temporal_prev", strategy, null)).toBeCloseTo(1.0, 5);
    });

    it("returns strategy multiplier alone when plan is null", () => {
      const strategy: GraphRetrievalStrategy = GRAPH_RETRIEVAL_STRATEGIES.conflict_exploration;
      // strategy.edgeWeights.conflicts_with = 2.0
      expect(effectiveEdgeMultiplier("conflicts_with", strategy, null)).toBeCloseTo(2.0, 5);
    });
  });

  describe("with flag ON", () => {
    beforeEach(() => {
      process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "on";
    });

    it("multiplies strategy by plan edgeBias when both define the kind", () => {
      const strategy: GraphRetrievalStrategy = GRAPH_RETRIEVAL_STRATEGIES.deep_explain;
      const plan = makePlan({ supports: 1.5 });
      // 1.2 * 1.5 = 1.8
      expect(effectiveEdgeMultiplier("supports", strategy, plan)).toBeCloseTo(1.8, 5);
    });

    it("uses strategy alone (multiplier 1.0) when plan does NOT define the kind", () => {
      const strategy: GraphRetrievalStrategy = GRAPH_RETRIEVAL_STRATEGIES.deep_explain;
      const plan = makePlan({ causal: 2.0 });
      // strategy.edgeWeights.derived_from = 1.2; plan has no derived_from key → fall back to 1.0
      expect(effectiveEdgeMultiplier("derived_from", strategy, plan)).toBeCloseTo(1.2, 5);
    });

    it("uses plan alone (over default 1.0) when strategy does not define the kind", () => {
      const strategy: GraphRetrievalStrategy = GRAPH_RETRIEVAL_STRATEGIES.default_retrieval;
      const plan = makePlan({ temporal_next: 3.0 });
      // default_retrieval.edgeWeights = {}; plan supplies 3.0
      expect(effectiveEdgeMultiplier("temporal_next", strategy, plan)).toBeCloseTo(3.0, 5);
    });

    it("returns 1.0 * 1.0 when neither defines the kind", () => {
      const strategy: GraphRetrievalStrategy = GRAPH_RETRIEVAL_STRATEGIES.default_retrieval;
      const plan = makePlan({});
      expect(effectiveEdgeMultiplier("conflict_or_update", strategy, plan)).toBeCloseTo(1.0, 5);
    });

    it("plan edgeBias never overrides strategy when key is missing — sparse merge semantics", () => {
      const strategy: GraphRetrievalStrategy = GRAPH_RETRIEVAL_STRATEGIES.conflict_exploration;
      // strategy: { conflicts_with: 2.0, downgraded_by: 1.5, resolved_by: 1.3 }
      const plan = makePlan({ conflicts_with: 0.5 }); // sparse — only this one
      // Other strategy keys MUST be untouched
      expect(effectiveEdgeMultiplier("conflicts_with", strategy, plan)).toBeCloseTo(1.0, 5);
      expect(effectiveEdgeMultiplier("downgraded_by", strategy, plan)).toBeCloseTo(1.5, 5);
      expect(effectiveEdgeMultiplier("resolved_by", strategy, plan)).toBeCloseTo(1.3, 5);
    });
  });
});
