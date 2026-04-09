import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RetrievalOrchestrator } from "../../src/memory/retrieval/retrieval-orchestrator";
import type { QueryPlan } from "../../src/memory/query-plan-types";
import type { QueryRoute, QuerySignals } from "../../src/memory/query-routing-types";
import type { ViewerContext } from "../../src/core/contracts/viewer-context";
import type {
  NarrativeSearchService,
  NarrativeSearchFilters,
} from "../../src/memory/narrative/narrative-search";
import type {
  CognitionSearchService,
  CognitionHit,
  CognitionSearchParams,
} from "../../src/memory/cognition/cognition-search";
import type { TimeSliceQuery } from "../../src/memory/time-slice-query";
import type { MemoryHint } from "../../src/memory/types";

/**
 * GAP-4 §1 — surface facets consumption tests.
 *
 * Verifies that `RetrievalOrchestrator.search` extracts the
 * `entityFilters`, `timeWindow`, `kind`, and `stance` fields from
 * `queryPlan.surfacePlans.{narrative,cognition}` and forwards them to
 * the narrative/cognition services. Also verifies that empty
 * `entityFilters` arrays are normalized to `undefined` (no filter,
 * not "match nothing").
 *
 * Uses recording stubs at the service boundary so the test does not
 * touch the PG repos. The PG-side SQL changes (added in the same
 * commit) are validated separately by integration tests when
 * postgres is available.
 */

// ----- Helpers ------------------------------------------------------------

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

function makeRoute(): QueryRoute {
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
    signals: zeroSignals(),
    rationale: "",
    matchedRules: [],
    classifierVersion: "rule-v1",
  };
}

type PlanOverrides = {
  narrativeEntityFilters?: number[];
  narrativeTimeWindow?: TimeSliceQuery | null;
  cognitionEntityFilters?: number[];
  cognitionTimeWindow?: TimeSliceQuery | null;
  cognitionKind?: "assertion" | "evaluation" | "commitment";
  cognitionStance?: "confirmed" | "contested" | "hypothetical";
};

function makePlan(overrides: PlanOverrides = {}): QueryPlan {
  const route = makeRoute();
  return {
    route,
    surfacePlans: {
      narrative: {
        baseQuery: route.normalizedQuery,
        entityFilters: overrides.narrativeEntityFilters ?? [],
        timeWindow: overrides.narrativeTimeWindow ?? null,
        weight: 0.5,
        enabledByRole: true,
      },
      cognition: {
        baseQuery: route.normalizedQuery,
        entityFilters: overrides.cognitionEntityFilters ?? [],
        timeWindow: overrides.cognitionTimeWindow ?? null,
        weight: 0.5,
        enabledByRole: true,
        kind: overrides.cognitionKind,
        stance: overrides.cognitionStance,
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

type NarrativeFacetCapture = {
  service: NarrativeSearchService;
  lastFilters: NarrativeSearchFilters | undefined;
  callCount: number;
};

function makeFacetRecordingNarrative(): NarrativeFacetCapture {
  const capture: NarrativeFacetCapture = {
    service: undefined as unknown as NarrativeSearchService,
    lastFilters: undefined,
    callCount: 0,
  };
  capture.service = {
    async generateMemoryHints(
      _query: string,
      _viewer: ViewerContext,
      _limit: number,
      filters?: NarrativeSearchFilters,
    ): Promise<MemoryHint[]> {
      capture.lastFilters = filters;
      capture.callCount += 1;
      return [];
    },
    async searchNarrative() {
      return [];
    },
  } as unknown as NarrativeSearchService;
  return capture;
}

type CognitionFacetCapture = {
  service: CognitionSearchService;
  lastParams: CognitionSearchParams | undefined;
  callCount: number;
};

function makeFacetRecordingCognition(): CognitionFacetCapture {
  const capture: CognitionFacetCapture = {
    service: undefined as unknown as CognitionSearchService,
    lastParams: undefined,
    callCount: 0,
  };
  capture.service = {
    async searchCognition(params: CognitionSearchParams): Promise<CognitionHit[]> {
      capture.lastParams = params;
      capture.callCount += 1;
      return [];
    },
    createCurrentProjectionReader() {
      return null;
    },
  } as unknown as CognitionSearchService;
  return capture;
}

function makeOrchestrator(
  narrative: NarrativeSearchService,
  cognition: CognitionSearchService,
): RetrievalOrchestrator {
  return new RetrievalOrchestrator({
    narrativeService: narrative,
    cognitionService: cognition,
    currentProjectionReader: null,
    episodeRepository: null,
    episodeSearchFn: null,
  });
}

// ----- Flag stabilization -------------------------------------------------

let savedPlanFlag: string | undefined;
let savedFacetFlag: string | undefined;

beforeEach(() => {
  savedPlanFlag = process.env.MAIDSCLAW_RETRIEVAL_USE_PLAN;
  savedFacetFlag = process.env.MAIDSCLAW_RETRIEVAL_USE_FACETS;
  delete process.env.MAIDSCLAW_RETRIEVAL_USE_PLAN;
  delete process.env.MAIDSCLAW_RETRIEVAL_USE_FACETS;
});

afterEach(() => {
  if (savedPlanFlag === undefined) delete process.env.MAIDSCLAW_RETRIEVAL_USE_PLAN;
  else process.env.MAIDSCLAW_RETRIEVAL_USE_PLAN = savedPlanFlag;
  if (savedFacetFlag === undefined) delete process.env.MAIDSCLAW_RETRIEVAL_USE_FACETS;
  else process.env.MAIDSCLAW_RETRIEVAL_USE_FACETS = savedFacetFlag;
});

// ----- Tests --------------------------------------------------------------

describe("RetrievalOrchestrator surface facets consumption (GAP-4 §1)", () => {
  it("forwards narrative entityFilters from plan to NarrativeSearchService", async () => {
    const narrative = makeFacetRecordingNarrative();
    const cognition = makeFacetRecordingCognition();
    const orchestrator = makeOrchestrator(narrative.service, cognition.service);

    const plan = makePlan({ narrativeEntityFilters: [1, 2, 3] });
    await orchestrator.search("test", makeViewer(), "rp_agent", { queryPlan: plan });

    expect(narrative.callCount).toBe(1);
    expect(narrative.lastFilters?.entityIds).toEqual([1, 2, 3]);
  });

  it("forwards narrative timeWindow from plan", async () => {
    const narrative = makeFacetRecordingNarrative();
    const cognition = makeFacetRecordingCognition();
    const orchestrator = makeOrchestrator(narrative.service, cognition.service);

    const plan = makePlan({
      narrativeTimeWindow: { asOfCommittedTime: 1700000000000 },
    });
    await orchestrator.search("test", makeViewer(), "rp_agent", { queryPlan: plan });

    expect(narrative.lastFilters?.timeWindow?.asOfCommittedTime).toBe(1700000000000);
  });

  it("forwards cognition kind, stance, entityFilters, timeWindow", async () => {
    const narrative = makeFacetRecordingNarrative();
    const cognition = makeFacetRecordingCognition();
    const orchestrator = makeOrchestrator(narrative.service, cognition.service);

    const plan = makePlan({
      cognitionKind: "evaluation",
      cognitionStance: "contested",
      cognitionEntityFilters: [42],
      cognitionTimeWindow: { asOfCommittedTime: 1699913600000 },
    });
    await orchestrator.search("test", makeViewer(), "rp_agent", { queryPlan: plan });

    expect(cognition.lastParams?.kind).toBe("evaluation");
    expect(cognition.lastParams?.stance).toBe("contested");
    expect(cognition.lastParams?.entityIds).toEqual([42]);
    expect(cognition.lastParams?.timeWindow?.asOfCommittedTime).toBe(1699913600000);
  });

  it("normalizes empty entityFilters array to undefined (not 'match nothing')", async () => {
    const narrative = makeFacetRecordingNarrative();
    const cognition = makeFacetRecordingCognition();
    const orchestrator = makeOrchestrator(narrative.service, cognition.service);

    const plan = makePlan({
      narrativeEntityFilters: [],
      cognitionEntityFilters: [],
    });
    await orchestrator.search("test", makeViewer(), "rp_agent", { queryPlan: plan });

    expect(narrative.lastFilters?.entityIds).toBeUndefined();
    expect(cognition.lastParams?.entityIds).toBeUndefined();
  });

  it("passes undefined facets when no plan is supplied", async () => {
    const narrative = makeFacetRecordingNarrative();
    const cognition = makeFacetRecordingCognition();
    const orchestrator = makeOrchestrator(narrative.service, cognition.service);

    await orchestrator.search("test", makeViewer(), "rp_agent");

    expect(narrative.lastFilters).toBeUndefined();
    expect(cognition.lastParams?.kind).toBeUndefined();
    expect(cognition.lastParams?.stance).toBeUndefined();
    expect(cognition.lastParams?.entityIds).toBeUndefined();
    expect(cognition.lastParams?.timeWindow).toBeUndefined();
  });

  it("passes undefined facets when MAIDSCLAW_RETRIEVAL_USE_FACETS=off even with a plan", async () => {
    process.env.MAIDSCLAW_RETRIEVAL_USE_FACETS = "off";
    const narrative = makeFacetRecordingNarrative();
    const cognition = makeFacetRecordingCognition();
    const orchestrator = makeOrchestrator(narrative.service, cognition.service);

    const plan = makePlan({
      narrativeEntityFilters: [1, 2, 3],
      cognitionKind: "evaluation",
      cognitionStance: "contested",
    });
    await orchestrator.search("test", makeViewer(), "rp_agent", { queryPlan: plan });

    expect(narrative.lastFilters).toBeUndefined();
    expect(cognition.lastParams?.kind).toBeUndefined();
    expect(cognition.lastParams?.stance).toBeUndefined();
  });

  it("preserves cognition kind from plan even when stance is unset", async () => {
    const narrative = makeFacetRecordingNarrative();
    const cognition = makeFacetRecordingCognition();
    const orchestrator = makeOrchestrator(narrative.service, cognition.service);

    const plan = makePlan({ cognitionKind: "evaluation" });
    await orchestrator.search("test", makeViewer(), "rp_agent", { queryPlan: plan });

    expect(cognition.lastParams?.kind).toBe("evaluation");
    expect(cognition.lastParams?.stance).toBeUndefined();
  });
});
