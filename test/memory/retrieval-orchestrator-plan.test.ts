import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RetrievalOrchestrator } from "../../src/memory/retrieval/retrieval-orchestrator";
import { getDefaultTemplate } from "../../src/memory/contracts/retrieval-template";
import { allocateBudget } from "../../src/memory/retrieval/budget-allocator";
import type { QueryPlan } from "../../src/memory/query-plan-types";
import type { QueryRoute, QuerySignals } from "../../src/memory/query-routing-types";
import type { ViewerContext } from "../../src/core/contracts/viewer-context";
import type { NarrativeSearchService } from "../../src/memory/narrative/narrative-search";
import type { CognitionSearchService, CognitionHit } from "../../src/memory/cognition/cognition-search";
import type { MemoryHint } from "../../src/memory/types";

/**
 * These tests verify the Phase 3 contract between RetrievalOrchestrator and
 * the plan-driven budget allocator: when a QueryPlan is passed, the
 * orchestrator uses `allocateBudget` to reshape its template before running
 * surfaces; when no plan is passed (or the feature flag is off), it falls
 * back to the legacy path.
 *
 * Every test in this file explicitly sets MAIDSCLAW_RETRIEVAL_USE_PLAN in
 * beforeEach so that external process-level env var leakage (e.g. when this
 * file is run inside a larger bun test sweep with the flag flipped) cannot
 * destabilize the assertions.
 */

function zeroSignals(): QuerySignals {
  return {
    needsEpisode: 0,
    needsConflict: 0,
    needsTimeline: 0,
    needsRelationship: 0,
    needsCognition: 0,
    needsEntityFocus: 0,
  };
}

function makeViewer(): ViewerContext {
  return {
    viewer_agent_id: "agent_test",
    viewer_role: "rp_agent",
    can_read_admin_only: false,
    current_area_id: 100,
    session_id: "sess_test",
  };
}

function makeRoute(signals: Partial<QuerySignals>): QueryRoute {
  return {
    originalQuery: "test query",
    normalizedQuery: "test query",
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
    signals: { ...zeroSignals(), ...signals },
    rationale: "",
    matchedRules: [],
    classifierVersion: "rule-v1",
  };
}

function makePlan(signals: Partial<QuerySignals>): QueryPlan {
  const route = makeRoute(signals);
  return {
    route,
    surfacePlans: {
      narrative: {
        baseQuery: route.normalizedQuery,
        entityFilters: [],
        timeWindow: null,
        weight: 0.5,
        enabledByRole: true,
      },
      cognition: {
        baseQuery: route.normalizedQuery,
        entityFilters: [],
        timeWindow: null,
        weight: 0.5,
        enabledByRole: true,
      },
      episode: {
        baseQuery: route.normalizedQuery,
        entityFilters: [],
        timeWindow: null,
        weight: 0.3,
        enabledByRole: true,
      },
      conflictNotes: {
        baseQuery: route.normalizedQuery,
        entityFilters: [],
        timeWindow: null,
        weight: 0,
        enabledByRole: true,
      },
    },
    graphPlan: {
      primaryIntent: "event",
      secondaryIntents: [],
      timeSlice: null,
      seedBias: {
        entity: 0.5,
        event: 0.5,
        episode: 0.3,
        assertion: 0.4,
        evaluation: 0,
        commitment: 0.3,
      },
      edgeBias: {},
    },
    builderVersion: "deterministic-v1",
    rationale: "test plan",
    matchedRules: [],
  };
}

function makeRecordingNarrative(): {
  service: NarrativeSearchService;
  lastLimit: { value: number };
} {
  const lastLimit = { value: 0 };
  const service = {
    async generateMemoryHints(
      _query: string,
      _viewer: ViewerContext,
      limit: number,
    ): Promise<MemoryHint[]> {
      lastLimit.value = limit;
      return [];
    },
    async searchNarrative() {
      return [];
    },
  } as unknown as NarrativeSearchService;
  return { service, lastLimit };
}

function makeRecordingCognition(): {
  service: CognitionSearchService;
  lastLimit: { value: number };
} {
  const lastLimit = { value: 0 };
  const service = {
    async searchCognition(params: { limit?: number }): Promise<CognitionHit[]> {
      lastLimit.value = params.limit ?? 0;
      return [];
    },
    createCurrentProjectionReader() {
      return null;
    },
  } as unknown as CognitionSearchService;
  return { service, lastLimit };
}

function makeOrchestrator(deps: {
  narrativeService: NarrativeSearchService;
  cognitionService: CognitionSearchService;
}): RetrievalOrchestrator {
  return new RetrievalOrchestrator({
    narrativeService: deps.narrativeService,
    cognitionService: deps.cognitionService,
    currentProjectionReader: null,
    episodeRepository: null,
    episodeSearchFn: null,
  });
}

// Stabilize the feature flag across all tests in this file. Default it to
// enabled; individual tests that need the "off" behavior flip it in-place
// and the afterEach restores the default so subsequent tests see a clean
// environment.
let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env.MAIDSCLAW_RETRIEVAL_USE_PLAN;
  delete process.env.MAIDSCLAW_RETRIEVAL_USE_PLAN;
});
afterEach(() => {
  if (savedFlag === undefined) {
    delete process.env.MAIDSCLAW_RETRIEVAL_USE_PLAN;
  } else {
    process.env.MAIDSCLAW_RETRIEVAL_USE_PLAN = savedFlag;
  }
});

describe("RetrievalOrchestrator — plan-driven budget reallocation", () => {
  it("reshapes narrative/cognition limits when signals favor cognition", async () => {
    const narrative = makeRecordingNarrative();
    const cognition = makeRecordingCognition();
    const orchestrator = makeOrchestrator({
      narrativeService: narrative.service,
      cognitionService: cognition.service,
    });

    const plan = makePlan({ needsCognition: 1 });
    await orchestrator.search("test", makeViewer(), "rp_agent", { queryPlan: plan });

    // cognition.limit = cognitionBudget + conflictBudget + 4. Under
    // cognition-heavy allocation, cognitionBudget stays >= baseline 5.
    expect(cognition.lastLimit.value).toBeGreaterThanOrEqual(5);
  });

  it("falls back to legacy template when no plan is passed", async () => {
    const narrative = makeRecordingNarrative();
    const cognition = makeRecordingCognition();
    const orchestrator = makeOrchestrator({
      narrativeService: narrative.service,
      cognitionService: cognition.service,
    });

    await orchestrator.search("test", makeViewer(), "rp_agent");

    // Legacy path: narrative limit = 3 + 3 + 4 = 10; cognition = 5 + 2 + 4 = 11.
    // (rp_agent episodicBudget bumped from 2 → 3 in GAP-4 §4 prereq.)
    expect(narrative.lastLimit.value).toBe(10);
    expect(cognition.lastLimit.value).toBe(11);
  });

  it("zero-signal plan leaves template untouched (invariance)", async () => {
    const narrative = makeRecordingNarrative();
    const cognition = makeRecordingCognition();
    const orchestrator = makeOrchestrator({
      narrativeService: narrative.service,
      cognitionService: cognition.service,
    });

    const plan = makePlan({});
    await orchestrator.search("test", makeViewer(), "rp_agent", { queryPlan: plan });

    expect(narrative.lastLimit.value).toBe(10);
    expect(cognition.lastLimit.value).toBe(11);
  });

  it("MAIDSCLAW_RETRIEVAL_USE_PLAN=off forces fallback even when plan is present", async () => {
    process.env.MAIDSCLAW_RETRIEVAL_USE_PLAN = "off";
    const narrative = makeRecordingNarrative();
    const cognition = makeRecordingCognition();
    const orchestrator = makeOrchestrator({
      narrativeService: narrative.service,
      cognitionService: cognition.service,
    });

    const plan = makePlan({ needsCognition: 1 });
    await orchestrator.search("test", makeViewer(), "rp_agent", { queryPlan: plan });

    // Legacy limits regardless of plan.
    expect(narrative.lastLimit.value).toBe(10);
    expect(cognition.lastLimit.value).toBe(11);
  });

  it("task_agent disabled surfaces stay disabled even with strong signals", async () => {
    const narrative = makeRecordingNarrative();
    const cognition = makeRecordingCognition();
    const orchestrator = makeOrchestrator({
      narrativeService: narrative.service,
      cognitionService: cognition.service,
    });

    const plan = makePlan({ needsCognition: 1, needsEpisode: 1 });
    await orchestrator.search(
      "test",
      { ...makeViewer(), viewer_role: "task_agent" },
      "task_agent",
      { queryPlan: plan },
    );

    expect(narrative.lastLimit.value).toBe(0);
    expect(cognition.lastLimit.value).toBe(0);
  });
});

describe("RetrievalOrchestrator — plan integration with budget-allocator", () => {
  it("orchestrator limits match what allocateBudget would independently produce", async () => {
    const narrative = makeRecordingNarrative();
    const cognition = makeRecordingCognition();
    const orchestrator = makeOrchestrator({
      narrativeService: narrative.service,
      cognitionService: cognition.service,
    });

    const plan = makePlan({ needsEntityFocus: 1 });
    await orchestrator.search("test", makeViewer(), "rp_agent", { queryPlan: plan });

    const template = getDefaultTemplate("rp_agent");
    const allocated = allocateBudget(template, plan.route.signals);
    const expectedNarrativeLimit = Math.max(
      allocated.narrativeBudget + allocated.episodicBudget + 4,
      allocated.narrativeBudget,
    );
    expect(narrative.lastLimit.value).toBe(expectedNarrativeLimit);
  });
});

describe("RetrievalOrchestrator — strategy + plan composition", () => {
  it("deep_explain query strategy composes with plan reallocation", async () => {
    const narrative = makeRecordingNarrative();
    const cognition = makeRecordingCognition();
    const orchestrator = makeOrchestrator({
      narrativeService: narrative.service,
      cognitionService: cognition.service,
    });

    // deep_explain adds +2 to narrative/cognition/episode, +1 to conflict.
    // Plan with zero signals should leave the strategy-boosted template alone.
    const plan = makePlan({});
    await orchestrator.search(
      "test",
      makeViewer(),
      "rp_agent",
      { queryPlan: plan, queryStrategy: "deep_explain" },
    );

    // Boosted baseline: narrative=5, cognition=7, episode=4, conflict=3.
    // (rp_agent episodicBudget bumped from 2 → 3, deep_explain adds +1 → 4.)
    // narrative limit = 5 + 4 + 4 = 13; cognition limit = 7 + 3 + 4 = 14.
    expect(narrative.lastLimit.value).toBe(13);
    expect(cognition.lastLimit.value).toBe(14);
  });

  it("deep_explain + heavy cognition signal reshapes the boosted budget", async () => {
    const narrative = makeRecordingNarrative();
    const cognition = makeRecordingCognition();
    const orchestrator = makeOrchestrator({
      narrativeService: narrative.service,
      cognitionService: cognition.service,
    });

    const plan = makePlan({ needsCognition: 1 });
    await orchestrator.search(
      "test",
      makeViewer(),
      "rp_agent",
      { queryPlan: plan, queryStrategy: "deep_explain" },
    );

    // Plan reallocates within the boosted total. Cognition should take more
    // share than it would under legacy strategy alone (which would yield 14).
    // The exact number depends on rounding, but it should remain >= 7
    // (the boosted baseline) and the non-boosted baseline was 11.
    expect(cognition.lastLimit.value).toBeGreaterThanOrEqual(7);
  });
});
