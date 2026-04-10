import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mergedEdgePriority,
  resolveEffectivePrimaryIntent,
  resolveEffectiveSecondaryIntents,
} from "../../src/memory/navigator";
import type { QueryPlan } from "../../src/memory/query-plan-types";
import type { NavigatorEdgeKind, QueryType } from "../../src/memory/types";

/**
 * GAP-4 §2 Stage B — unit tests for the navigator helpers that fold
 * plan-driven `primaryIntent` and `secondaryIntents` into beam search
 * scoring.
 *
 * Stage B adds three module-level exports:
 *   1. `resolveEffectivePrimaryIntent(analysis, plan)`  — flag-gated primary
 *      intent replacement (plan → fallback to analysis.query_type)
 *   2. `resolveEffectiveSecondaryIntents(plan)`         — flag-gated secondary
 *      intent list (empty when flag off / no plan)
 *   3. `mergedEdgePriority(primary, secondaries)`       — concat+dedup of the
 *      `QUERY_TYPE_PRIORITY` lists used by `edgePriorityScore`
 *
 * These helpers are what `explore()` calls once per query and threads
 * through `computeSeedScores` / `expandTypedBeam` / `rerankPaths` etc.
 *
 * Flag default is now ON (MAIDSCLAW_NAVIGATOR_USE_PLAN). Stage B shipped
 * the plumbing and the §10 shadow gates were green on 133 adversarial
 * fixtures — production flip is complete. This file's `beforeEach`
 * explicitly sets the flag to `"off"` so legacy-path tests still measure
 * the pre-rollout behavior; a separate `production default (unset)`
 * describe block below pins the new default to ON by clearing the env
 * var and asserting plan consumption fires.
 *
 * The 20+ parity fixtures below are the §2 doc's "20+ navigator fixture"
 * requirement, executed against the pure helpers (no GraphReadRepo or
 * RetrievalService wiring). Each fixture asserts both flag-off legacy
 * parity AND flag-on plan consumption.
 */

function makePlan(overrides: {
  primaryIntent: QueryType;
  secondaryIntents?: QueryType[];
  edgeBias?: Record<string, number>;
  seedBias?: {
    entity?: number;
    event?: number;
    episode?: number;
    assertion?: number;
    evaluation?: number;
    commitment?: number;
  };
}): QueryPlan {
  return {
    route: {
      originalQuery: "test",
      normalizedQuery: "test",
      intents: [],
      primaryIntent: overrides.primaryIntent,
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
      primaryIntent: overrides.primaryIntent,
      secondaryIntents: overrides.secondaryIntents ?? [],
      timeSlice: null,
      seedBias: {
        entity: overrides.seedBias?.entity ?? 0,
        event: overrides.seedBias?.event ?? 0,
        episode: overrides.seedBias?.episode ?? 0,
        assertion: overrides.seedBias?.assertion ?? 0,
        evaluation: overrides.seedBias?.evaluation ?? 0,
        commitment: overrides.seedBias?.commitment ?? 0,
      },
      edgeBias: overrides.edgeBias ?? {},
    },
    builderVersion: "deterministic-v1",
    rationale: "",
    matchedRules: [],
  };
}

let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN;
  // Post-rollout: production default is ON, so tests that want to
  // verify the legacy path must explicitly set "off". Each individual
  // test still overrides to "on"/"off" as needed.
  process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "off";
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN;
  else process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = savedFlag;
});

// ---------------------------------------------------------------------------
// resolveEffectivePrimaryIntent — flag gating + fallback
// ---------------------------------------------------------------------------
describe("resolveEffectivePrimaryIntent (GAP-4 §2 Stage B)", () => {
  it("returns analysis.query_type when flag is explicitly off even if plan is present", () => {
    const analysis = { query_type: "event" as QueryType };
    const plan = makePlan({ primaryIntent: "entity" });
    expect(resolveEffectivePrimaryIntent(analysis, plan)).toBe("event");
  });

  it("returns analysis.query_type when plan is null (regardless of flag)", () => {
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "on";
    const analysis = { query_type: "timeline" as QueryType };
    expect(resolveEffectivePrimaryIntent(analysis, null)).toBe("timeline");
  });

  it("returns plan.graphPlan.primaryIntent when flag is on AND plan is present", () => {
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "on";
    const analysis = { query_type: "event" as QueryType };
    const plan = makePlan({ primaryIntent: "entity" });
    expect(resolveEffectivePrimaryIntent(analysis, plan)).toBe("entity");
  });

  it("never swallows plan value silently: explicit 'off' keeps legacy", () => {
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "off";
    const analysis = { query_type: "event" as QueryType };
    const plan = makePlan({ primaryIntent: "why" });
    expect(resolveEffectivePrimaryIntent(analysis, plan)).toBe("event");
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveSecondaryIntents — flag gating
// ---------------------------------------------------------------------------
describe("resolveEffectiveSecondaryIntents (GAP-4 §2 Stage B)", () => {
  it("returns [] when flag is explicitly off, even if plan lists secondaries", () => {
    const plan = makePlan({ primaryIntent: "why", secondaryIntents: ["conflict", "timeline"] });
    expect(resolveEffectiveSecondaryIntents(plan)).toEqual([]);
  });

  it("returns [] when plan is null", () => {
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "on";
    expect(resolveEffectiveSecondaryIntents(null)).toEqual([]);
  });

  it("returns plan.graphPlan.secondaryIntents when flag is on", () => {
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "on";
    const plan = makePlan({ primaryIntent: "why", secondaryIntents: ["conflict", "timeline"] });
    expect(resolveEffectiveSecondaryIntents(plan)).toEqual(["conflict", "timeline"]);
  });

  it("returns [] when plan has no secondaries (flag on)", () => {
    process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "on";
    const plan = makePlan({ primaryIntent: "entity" });
    expect(resolveEffectiveSecondaryIntents(plan)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergedEdgePriority — concat/dedup semantics
// ---------------------------------------------------------------------------
describe("mergedEdgePriority (GAP-4 §2 Stage B)", () => {
  it("empty secondaries returns the primary priority list exactly", () => {
    const list = mergedEdgePriority("entity", []);
    expect(list).toEqual(["fact_relation", "participant", "fact_support", "semantic_similar"]);
  });

  it("primary=why, secondary=[timeline] concatenates and dedups", () => {
    const list = mergedEdgePriority("why", ["timeline"]);
    // why:      [causal, fact_support, fact_relation, temporal_prev]
    // timeline: [temporal_prev, temporal_next, same_episode, causal, fact_support]
    // merged:   [causal, fact_support, fact_relation, temporal_prev, temporal_next, same_episode]
    expect(list).toEqual([
      "causal",
      "fact_support",
      "fact_relation",
      "temporal_prev",
      "temporal_next",
      "same_episode",
    ]);
  });

  it("preserves primary-first ordering (secondary doesn't reorder primary)", () => {
    const list = mergedEdgePriority("conflict", ["why"]);
    // conflict starts with `conflict_or_update`, must come first
    expect(list[0]).toBe("conflict_or_update");
    // `causal` is in both lists → appears in primary's position (index 4)
    expect(list).toContain("causal");
    expect(list.indexOf("conflict_or_update")).toBeLessThan(list.indexOf("causal"));
  });

  it("multiple secondaries appended in order", () => {
    const list = mergedEdgePriority("entity", ["timeline", "conflict"]);
    // entity:   [fact_relation, participant, fact_support, semantic_similar]
    // timeline: [temporal_prev, temporal_next, same_episode, causal, fact_support]
    // conflict: [conflict_or_update, fact_relation, fact_support, causal, temporal_prev]
    expect(list[0]).toBe("fact_relation");
    expect(list).toContain("temporal_prev");
    expect(list).toContain("conflict_or_update");
    // dedup: temporal_prev appears exactly once
    expect(list.filter((k) => k === "temporal_prev").length).toBe(1);
    // dedup: causal appears exactly once
    expect(list.filter((k) => k === "causal").length).toBe(1);
  });

  it("identical primary and secondary yields just the primary list", () => {
    const list = mergedEdgePriority("why", ["why"]);
    expect(list).toEqual(["causal", "fact_support", "fact_relation", "temporal_prev"]);
  });
});

// ---------------------------------------------------------------------------
// 20+ navigator fixture parity — (query_type, plan_primary, plan_secondaries)
// triples that exercise every intent combination shadow data surfaced.
// The test asserts both flag-off byte-identity AND flag-on plan
// consumption using the pure helpers (no GraphReadRepo wiring needed).
// ---------------------------------------------------------------------------

type Fixture = {
  name: string;
  analysisQueryType: QueryType;
  planPrimary: QueryType;
  planSecondaries: QueryType[];
  expectedMergedFirst: NavigatorEdgeKind; // first element of merged list when flag on
};

const FIXTURES: Fixture[] = [
  // Agreement cases — primary matches analysis.query_type (flag-on/off same primary).
  { name: "why agreement", analysisQueryType: "why", planPrimary: "why", planSecondaries: [], expectedMergedFirst: "causal" },
  { name: "why + conflict secondary", analysisQueryType: "why", planPrimary: "why", planSecondaries: ["conflict"], expectedMergedFirst: "causal" },
  { name: "why + timeline secondary", analysisQueryType: "why", planPrimary: "why", planSecondaries: ["timeline"], expectedMergedFirst: "causal" },
  { name: "why + relationship secondary", analysisQueryType: "why", planPrimary: "why", planSecondaries: ["relationship"], expectedMergedFirst: "causal" },
  { name: "why multi-secondary", analysisQueryType: "why", planPrimary: "why", planSecondaries: ["conflict", "timeline"], expectedMergedFirst: "causal" },

  { name: "entity agreement", analysisQueryType: "entity", planPrimary: "entity", planSecondaries: [], expectedMergedFirst: "fact_relation" },
  { name: "entity + relationship secondary", analysisQueryType: "entity", planPrimary: "entity", planSecondaries: ["relationship"], expectedMergedFirst: "fact_relation" },
  { name: "entity + timeline secondary", analysisQueryType: "entity", planPrimary: "entity", planSecondaries: ["timeline"], expectedMergedFirst: "fact_relation" },

  { name: "conflict agreement", analysisQueryType: "conflict", planPrimary: "conflict", planSecondaries: [], expectedMergedFirst: "conflict_or_update" },
  { name: "conflict + why secondary", analysisQueryType: "conflict", planPrimary: "conflict", planSecondaries: ["why"], expectedMergedFirst: "conflict_or_update" },
  { name: "conflict + timeline secondary", analysisQueryType: "conflict", planPrimary: "conflict", planSecondaries: ["timeline"], expectedMergedFirst: "conflict_or_update" },

  { name: "timeline agreement", analysisQueryType: "timeline", planPrimary: "timeline", planSecondaries: [], expectedMergedFirst: "temporal_prev" },
  { name: "timeline + why secondary", analysisQueryType: "timeline", planPrimary: "timeline", planSecondaries: ["why"], expectedMergedFirst: "temporal_prev" },
  { name: "timeline + conflict secondary", analysisQueryType: "timeline", planPrimary: "timeline", planSecondaries: ["conflict"], expectedMergedFirst: "temporal_prev" },

  { name: "relationship agreement", analysisQueryType: "relationship", planPrimary: "relationship", planSecondaries: [], expectedMergedFirst: "fact_relation" },
  { name: "relationship + entity secondary", analysisQueryType: "relationship", planPrimary: "relationship", planSecondaries: ["entity"], expectedMergedFirst: "fact_relation" },

  { name: "state agreement", analysisQueryType: "state", planPrimary: "state", planSecondaries: [], expectedMergedFirst: "fact_relation" },
  { name: "state + why secondary", analysisQueryType: "state", planPrimary: "state", planSecondaries: ["why"], expectedMergedFirst: "fact_relation" },

  { name: "event agreement", analysisQueryType: "event", planPrimary: "event", planSecondaries: [], expectedMergedFirst: "same_episode" },
  { name: "event + timeline secondary", analysisQueryType: "event", planPrimary: "event", planSecondaries: ["timeline"], expectedMergedFirst: "same_episode" },

  // Disagreement cases — primary differs from analysis.query_type. These
  // mirror the §8 private-alias recovery wins the shadow run captured:
  // legacy analyzeQuery saw no entities and fell back to `event`, but the
  // router's substring scan found CJK private aliases → `entity`.
  { name: "legacy=event, plan=entity (§8 CJK recovery)", analysisQueryType: "event", planPrimary: "entity", planSecondaries: [], expectedMergedFirst: "fact_relation" },
  { name: "legacy=event, plan=entity + relationship", analysisQueryType: "event", planPrimary: "entity", planSecondaries: ["relationship"], expectedMergedFirst: "fact_relation" },
  { name: "legacy=entity, plan=relationship", analysisQueryType: "entity", planPrimary: "relationship", planSecondaries: [], expectedMergedFirst: "fact_relation" },
  { name: "legacy=entity, plan=state (current X)", analysisQueryType: "entity", planPrimary: "state", planSecondaries: [], expectedMergedFirst: "fact_relation" },
];

describe("GAP-4 §2 Stage B — 20+ navigator fixture parity", () => {
  it(`has at least 20 fixtures (doc §2 requirement): found ${FIXTURES.length}`, () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(20);
  });

  describe("with flag explicitly OFF (rollback path): legacy byte-identity", () => {
    for (const fx of FIXTURES) {
      it(`${fx.name}: primary = analysis.query_type`, () => {
        const analysis = { query_type: fx.analysisQueryType };
        const plan = makePlan({ primaryIntent: fx.planPrimary, secondaryIntents: fx.planSecondaries });
        // Flag off → always analysis.query_type, regardless of plan.
        expect(resolveEffectivePrimaryIntent(analysis, plan)).toBe(fx.analysisQueryType);
        // Flag off → secondaries always empty.
        expect(resolveEffectiveSecondaryIntents(plan)).toEqual([]);
      });
    }
  });

  describe("with flag ON: plan consumption", () => {
    beforeEach(() => {
      process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "on";
    });

    for (const fx of FIXTURES) {
      it(`${fx.name}: primary = plan.graphPlan.primaryIntent, merged list head = ${fx.expectedMergedFirst}`, () => {
        const analysis = { query_type: fx.analysisQueryType };
        const plan = makePlan({ primaryIntent: fx.planPrimary, secondaryIntents: fx.planSecondaries });
        const effectivePrimary = resolveEffectivePrimaryIntent(analysis, plan);
        const effectiveSecondaries = resolveEffectiveSecondaryIntents(plan);
        expect(effectivePrimary).toBe(fx.planPrimary);
        expect(effectiveSecondaries).toEqual(fx.planSecondaries);
        const merged = mergedEdgePriority(effectivePrimary, effectiveSecondaries);
        expect(merged.length).toBeGreaterThan(0);
        expect(merged[0]).toBe(fx.expectedMergedFirst);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Post-rollout: production default is ON (unset env var consumes plan).
  // These tests pin the new default so any future revert to "unset = off"
  // would fail immediately, and any production deploy that forgets to set
  // the env var still gets plan consumption.
  // -------------------------------------------------------------------------
  describe("production default (unset env var) — new ON default", () => {
    beforeEach(() => {
      // Override the outer beforeEach which set "off" — unset the flag
      // entirely so we exercise the production default path.
      delete process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN;
    });

    it("unset flag → resolveEffectivePrimaryIntent uses plan.graphPlan.primaryIntent", () => {
      const analysis = { query_type: "event" as QueryType };
      const plan = makePlan({ primaryIntent: "entity" });
      expect(resolveEffectivePrimaryIntent(analysis, plan)).toBe("entity");
    });

    it("unset flag → resolveEffectiveSecondaryIntents returns plan's secondaries", () => {
      const plan = makePlan({ primaryIntent: "why", secondaryIntents: ["conflict", "timeline"] });
      expect(resolveEffectiveSecondaryIntents(plan)).toEqual(["conflict", "timeline"]);
    });

    it("unset flag + null plan → still falls back to legacy (null plan always wins)", () => {
      const analysis = { query_type: "timeline" as QueryType };
      expect(resolveEffectivePrimaryIntent(analysis, null)).toBe("timeline");
      expect(resolveEffectiveSecondaryIntents(null)).toEqual([]);
    });

    it("explicit 'off' string is the only way to disable plan consumption", () => {
      process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = "off";
      const analysis = { query_type: "event" as QueryType };
      const plan = makePlan({ primaryIntent: "why" });
      expect(resolveEffectivePrimaryIntent(analysis, plan)).toBe("event");
    });

    it("any other string value keeps plan consumption enabled", () => {
      const analysis = { query_type: "event" as QueryType };
      const plan = makePlan({ primaryIntent: "why" });
      for (const val of ["on", "yes", "1", "true", "ON", " off", "off ", "disabled"]) {
        process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN = val;
        // Only exact 'off' disables; anything else (including typo
        // " off") leaves the default-ON behavior intact.
        expect(resolveEffectivePrimaryIntent(analysis, plan)).toBe("why");
      }
    });
  });
});
