import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RetrievalOrchestrator } from "../../src/memory/retrieval/retrieval-orchestrator";
import { getTypedRetrievalSurfaceAsync, type PromptDataRepos } from "../../src/memory/prompt-data";
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
  CognitionCurrentRow,
  CognitionSearchParams,
} from "../../src/memory/cognition/cognition-search";
import type { TimeSliceQuery } from "../../src/memory/time-slice-query";
import type { MemoryHint } from "../../src/memory/types";
import type { RetrievalService } from "../../src/memory/retrieval";
import type { SceneSearchService } from "../../src/memory/scene/scene-search";

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
  extras?: {
    currentProjectionReader?: {
      getCurrent: (agentId: string, cognitionKey: string) => Promise<CognitionCurrentRow | null>;
      getAllCurrent: (agentId: string) => Promise<CognitionCurrentRow[]>;
      getAllCurrentByKind: (agentId: string, kind: "assertion" | "evaluation" | "commitment") => Promise<CognitionCurrentRow[]>;
      getActiveCurrent: (agentId: string) => Promise<CognitionCurrentRow[]>;
    } | null;
    sceneSearchService?: SceneSearchService | null;
  },
): RetrievalOrchestrator {
  return new RetrievalOrchestrator({
    narrativeService: narrative,
    cognitionService: cognition,
    currentProjectionReader: extras?.currentProjectionReader ?? null,
    sceneSearchService: extras?.sceneSearchService ?? null,
    episodeRepository: null,
    episodeSearchFn: null,
  });
}

function makeAssertionCurrentRow(
  cognitionKey: string,
  recordJson: string,
  status: string = "active",
): CognitionCurrentRow {
  return {
    id: 1,
    agent_id: "agent_test",
    cognition_key: cognitionKey,
    kind: "assertion",
    stance: "accepted",
    basis: "belief",
    status,
    pre_contested_stance: null,
    conflict_summary: null,
    conflict_factor_refs_json: null,
    summary_text: "summary",
    record_json: recordJson,
    source_event_id: 1,
    updated_at: 1,
  };
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

  it("default search path preserves contested enrichment and provenance/groundingVerificationLevel in typed result (Task 8)", async () => {
    const narrative = makeFacetRecordingNarrative();
    const cognitionCapture = makeFacetRecordingCognition();
    const contestedHit: CognitionHit = {
      kind: "assertion",
      basis: "first_hand",
      stance: "contested",
      cognitionKey: "ck:contested",
      source_ref: "assertion:50" as unknown as string,
      content: "contested claim from retrieval",
      updated_at: 500,
      provenance: "user_stated",
      groundingVerificationLevel: "context_verified",
      conflictEvidence: [{ targetRef: "assertion:51", strength: 0.9, sourceKind: "agent_op", sourceRef: "settlement:5" }],
      conflictSummary: "conflict detected",
      conflictFactorRefs: ["assertion:51" as unknown as string],
    };
    cognitionCapture.service = {
      async searchCognition(params: CognitionSearchParams): Promise<CognitionHit[]> {
        cognitionCapture.lastParams = params;
        cognitionCapture.callCount += 1;
        return [contestedHit];
      },
      createCurrentProjectionReader() {
        return null;
      },
    } as unknown as CognitionSearchService;

    const orchestrator = makeOrchestrator(narrative.service, cognitionCapture.service);
    const result = await orchestrator.search("contested", makeViewer(), "rp_agent");

    expect(result.typed.cognition).toHaveLength(1);
    const seg = result.typed.cognition[0];
    expect(seg.basis).toBe("first_hand");
    expect(seg.stance).toBe("contested");
    expect(seg.cognitionKey).toBe("ck:contested");
    expect(seg.provenance).toBe("user_stated");
    expect(seg.groundingVerificationLevel).toBe("context_verified");
  });

  it("default typed cognition facets exclude retracted items via activeOnly=true", async () => {
    const narrative = makeFacetRecordingNarrative();
    const cognitionCapture = makeFacetRecordingCognition();
    cognitionCapture.service = {
      async searchCognition(params: CognitionSearchParams): Promise<CognitionHit[]> {
        cognitionCapture.lastParams = params;
        cognitionCapture.callCount += 1;
        if (params.activeOnly) {
          return [
            {
              kind: "assertion",
              basis: "first_hand",
              stance: "accepted",
              cognitionKey: "active:key",
              source_ref: "assertion:80" as unknown as string,
              content: "active cognition only",
              updated_at: 800,
              provenance: "user_stated",
              groundingVerificationLevel: "strong_verified",
            },
          ];
        }
        return [
          {
            kind: "assertion",
            basis: "first_hand",
            stance: "accepted",
            cognitionKey: "active:key",
            source_ref: "assertion:80" as unknown as string,
            content: "active cognition only",
            updated_at: 800,
          },
          {
            kind: "assertion",
            basis: "belief",
            stance: "rejected",
            cognitionKey: "retracted:key",
            source_ref: "assertion:81" as unknown as string,
            content: "retracted cognition",
            updated_at: 700,
          },
        ];
      },
      createCurrentProjectionReader() {
        return null;
      },
    } as unknown as CognitionSearchService;

    const orchestrator = makeOrchestrator(narrative.service, cognitionCapture.service);
    const result = await orchestrator.search("test", makeViewer(), "rp_agent");

    expect(cognitionCapture.lastParams?.activeOnly).toBe(true);
    expect(result.typed.cognition).toHaveLength(1);
    expect(result.typed.cognition[0].cognitionKey).toBe("active:key");
    expect(result.typed.cognition[0].content).toBe("active cognition only");
  });

  it("adds divergence notes from sceneFactBinding while preserving contested conflict notes", async () => {
    const narrative = makeFacetRecordingNarrative();
    const cognitionCapture = makeFacetRecordingCognition();
    const contestedHit: CognitionHit = {
      kind: "assertion",
      basis: "first_hand",
      stance: "contested",
      cognitionKey: "ck:contested",
      source_ref: "assertion:50" as unknown as string,
      content: "contested claim from retrieval",
      updated_at: 500,
      provenance: "user_stated",
      groundingVerificationLevel: "context_verified",
      conflictEvidence: [{ targetRef: "assertion:51", strength: 0.9, sourceKind: "agent_op", sourceRef: "settlement:5" }],
      conflictSummary: "conflict detected",
      conflictFactorRefs: ["assertion:51" as unknown as string],
    };
    cognitionCapture.service = {
      async searchCognition(params: CognitionSearchParams): Promise<CognitionHit[]> {
        cognitionCapture.lastParams = params;
        cognitionCapture.callCount += 1;
        return [contestedHit];
      },
      createCurrentProjectionReader() {
        return null;
      },
    } as unknown as CognitionSearchService;

    const boundRecordJson = JSON.stringify({
      kind: "assertion",
      key: "assertion:watch_location",
      claim: "the watch is in the greenhouse",
      sceneFactBinding: {
        scope: "area",
        factKey: "location:watch",
        expectedValue: "greenhouse",
      },
    });
    const freeTextRecordJson = JSON.stringify({
      kind: "assertion",
      key: "assertion:free_text",
      claim: "I have a hunch",
    });
    const boundRow = makeAssertionCurrentRow("assertion:watch_location", boundRecordJson);
    const freeTextRow = makeAssertionCurrentRow("assertion:free_text", freeTextRecordJson);

    const currentProjectionReader = {
      async getCurrent(): Promise<CognitionCurrentRow | null> {
        return null;
      },
      async getAllCurrent(): Promise<CognitionCurrentRow[]> {
        return [boundRow, freeTextRow];
      },
      async getAllCurrentByKind(): Promise<CognitionCurrentRow[]> {
        return [boundRow, freeTextRow];
      },
      async getActiveCurrent(): Promise<CognitionCurrentRow[]> {
        return [boundRow, freeTextRow];
      },
    };

    const sceneSearchService = {
      async getVisibleAreaFacts() {
        return [{ factKey: "location:watch", value: "tea_room", sourceKind: "action_commitment" }];
      },
      async getVisibleWorldFacts() {
        return [];
      },
    } as unknown as SceneSearchService;

    const orchestrator = makeOrchestrator(narrative.service, cognitionCapture.service, {
      currentProjectionReader,
      sceneSearchService,
    });
    const result = await orchestrator.search("watch", makeViewer(), "rp_agent", {
      override: {
        sceneRetrieval: true,
        conflictNotesBudget: 4,
      },
    });

    const contestedNote = result.typed.conflict_notes.find((n) => n.source_ref.startsWith("conflict_note:"));
    expect(contestedNote).toBeDefined();

    const divergenceNote = result.typed.conflict_notes.find((n) => n.source_ref === "divergence_note:assertion:watch_location");
    expect(divergenceNote).toBeDefined();
    expect(divergenceNote?.content).toContain("location:watch");
    expect(divergenceNote?.content).toContain("tea_room");
    expect(divergenceNote?.content).toContain("greenhouse");
    expect(result.typed.conflict_notes.some((n) => n.source_ref.includes("free_text"))).toBe(false);

    // Divergence notes are read-only surfaces and do not mutate cognition rows.
    expect(boundRow.record_json).toBe(boundRecordJson);
    expect(freeTextRow.record_json).toBe(freeTextRecordJson);
  });

  it("does not emit divergence notes for world bindings when visible world facts are empty", async () => {
    const narrative = makeFacetRecordingNarrative();
    const cognitionCapture = makeFacetRecordingCognition();
    cognitionCapture.service = {
      async searchCognition(params: CognitionSearchParams): Promise<CognitionHit[]> {
        cognitionCapture.lastParams = params;
        cognitionCapture.callCount += 1;
        return [];
      },
      createCurrentProjectionReader() {
        return null;
      },
    } as unknown as CognitionSearchService;

    const hiddenBindingRow = makeAssertionCurrentRow(
      "assertion:hidden_world_status",
      JSON.stringify({
        kind: "assertion",
        key: "assertion:hidden_world_status",
        claim: "status:hidden_npc is alarmed",
        sceneFactBinding: {
          scope: "world",
          factKey: "status:hidden_npc",
          expectedValue: "alarmed",
        },
      }),
    );

    const currentProjectionReader = {
      async getCurrent(): Promise<CognitionCurrentRow | null> {
        return null;
      },
      async getAllCurrent(): Promise<CognitionCurrentRow[]> {
        return [hiddenBindingRow];
      },
      async getAllCurrentByKind(): Promise<CognitionCurrentRow[]> {
        return [hiddenBindingRow];
      },
      async getActiveCurrent(): Promise<CognitionCurrentRow[]> {
        return [hiddenBindingRow];
      },
    };

    const sceneSearchService = {
      async getVisibleAreaFacts() {
        return [];
      },
      async getVisibleWorldFacts() {
        // system_only world facts are filtered out upstream and never visible here
        return [];
      },
    } as unknown as SceneSearchService;

    const orchestrator = makeOrchestrator(narrative.service, cognitionCapture.service, {
      currentProjectionReader,
      sceneSearchService,
    });
    const result = await orchestrator.search("hidden", makeViewer(), "rp_agent", {
      override: {
        sceneRetrieval: true,
        conflictNotesBudget: 4,
      },
    });

    expect(result.typed.conflict_notes.some((note) => note.source_ref.startsWith("divergence_note:"))).toBe(false);
  });

  it("does not emit divergence notes for area bindings from a different areaId", async () => {
    const narrative = makeFacetRecordingNarrative();
    const cognitionCapture = makeFacetRecordingCognition();
    cognitionCapture.service = {
      async searchCognition(params: CognitionSearchParams): Promise<CognitionHit[]> {
        cognitionCapture.lastParams = params;
        cognitionCapture.callCount += 1;
        return [];
      },
      createCurrentProjectionReader() {
        return null;
      },
    } as unknown as CognitionSearchService;

    const mismatchedAreaBindingRow = makeAssertionCurrentRow(
      "assertion:watch_elsewhere",
      JSON.stringify({
        kind: "assertion",
        key: "assertion:watch_elsewhere",
        claim: "the watch is in the greenhouse",
        sceneFactBinding: {
          scope: "area",
          factKey: "location:watch",
          areaId: 7,
          expectedValue: "greenhouse",
        },
      }),
    );

    const currentProjectionReader = {
      async getCurrent(): Promise<CognitionCurrentRow | null> {
        return null;
      },
      async getAllCurrent(): Promise<CognitionCurrentRow[]> {
        return [mismatchedAreaBindingRow];
      },
      async getAllCurrentByKind(): Promise<CognitionCurrentRow[]> {
        return [mismatchedAreaBindingRow];
      },
      async getActiveCurrent(): Promise<CognitionCurrentRow[]> {
        return [mismatchedAreaBindingRow];
      },
    };

    const sceneSearchService = {
      async getVisibleAreaFacts() {
        return [{ factKey: "location:watch", value: "tea_room", sourceKind: "action_commitment" }];
      },
      async getVisibleWorldFacts() {
        return [];
      },
    } as unknown as SceneSearchService;

    const orchestrator = makeOrchestrator(narrative.service, cognitionCapture.service, {
      currentProjectionReader,
      sceneSearchService,
    });
    const result = await orchestrator.search("watch", makeViewer(), "rp_agent", {
      override: {
        sceneRetrieval: true,
        conflictNotesBudget: 4,
      },
    });

    expect(result.typed.conflict_notes.some((note) => note.source_ref.startsWith("divergence_note:"))).toBe(false);
  });

  it("weak labeled cognition remains below strong grounded entry in typed facets", async () => {
    const narrative = makeFacetRecordingNarrative();
    const cognitionCapture = makeFacetRecordingCognition();
    const strongThenWeak: CognitionHit[] = [
      {
        kind: "assertion",
        basis: "first_hand",
        stance: "accepted",
        cognitionKey: "strong:key",
        source_ref: "assertion:90" as unknown as string,
        content: "strong grounded claim",
        updated_at: 900,
        provenance: "user_stated",
        groundingVerificationLevel: "strong_verified",
      },
      {
        kind: "assertion",
        basis: "belief",
        stance: "accepted",
        cognitionKey: "weak:key",
        source_ref: "assertion:91" as unknown as string,
        content: "weak inferred claim",
        updated_at: 901,
        provenance: "talker_sketch_auto",
        groundingVerificationLevel: "unverified",
      },
    ];

    cognitionCapture.service = {
      async searchCognition(params: CognitionSearchParams): Promise<CognitionHit[]> {
        cognitionCapture.lastParams = params;
        cognitionCapture.callCount += 1;
        return strongThenWeak;
      },
      createCurrentProjectionReader() {
        return null;
      },
    } as unknown as CognitionSearchService;

    const orchestrator = makeOrchestrator(narrative.service, cognitionCapture.service);
    const result = await orchestrator.search("test", makeViewer(), "rp_agent");

    expect(result.typed.cognition).toHaveLength(2);
    expect(result.typed.cognition[0].cognitionKey).toBe("strong:key");
    expect(result.typed.cognition[1].cognitionKey).toBe("weak:key");
    expect(result.typed.cognition[0].groundingVerificationLevel).toBe("strong_verified");
    expect(result.typed.cognition[1].groundingVerificationLevel).toBe("unverified");
  });

  it("renders [scene_area] before [cognition] when both are present", async () => {
    const retrievalService = {
      async generateTypedRetrieval(
        _query: string,
        _viewerContext: ViewerContext,
        _dedupContext?: unknown,
        _retrievalTemplate?: unknown,
        _queryStrategy?: unknown,
        _contestedCount?: unknown,
        sceneRetrieval?: boolean,
      ) {
        return {
          scene_area: sceneRetrieval
            ? [{ factKey: "location:parlor", value: { lit: true }, sourceKind: "lore_seed" }]
            : [],
          scene_world: sceneRetrieval
            ? [{ factKey: "status:storm", value: "incoming", sourceKind: "system_event" }]
            : [],
          cognition: [
            {
              source_ref: "assertion:1",
              content: "the butler is nearby",
              score: 1,
              kind: "assertion",
              basis: "first_hand",
              stance: "accepted",
              cognitionKey: "butler:nearby",
            },
          ],
          narrative: [],
          conflict_notes: [],
          episode: [],
        };
      },
    } as unknown as RetrievalService;

    const repos: PromptDataRepos = {
      coreMemoryBlockRepo: {} as PromptDataRepos["coreMemoryBlockRepo"],
      recentCognitionSlotRepo: {
        async getSlotPayload() {
          return undefined;
        },
      } as unknown as PromptDataRepos["recentCognitionSlotRepo"],
      interactionRepo: {
        async getMessageRecords() {
          return [];
        },
      } as unknown as PromptDataRepos["interactionRepo"],
      sharedBlockRepo: {} as PromptDataRepos["sharedBlockRepo"],
    };

    const output = await getTypedRetrievalSurfaceAsync(
      "what's happening",
      makeViewer(),
      repos,
      retrievalService,
      { sceneRetrieval: true },
    );

    const sceneAreaIdx = output.indexOf("[scene_area]");
    const cognitionIdx = output.indexOf("[cognition]");
    expect(sceneAreaIdx).toBeGreaterThanOrEqual(0);
    expect(cognitionIdx).toBeGreaterThan(sceneAreaIdx);
  });

  it("sceneRetrieval=false omits [scene_area]/[scene_world] from rendered output", async () => {
    const retrievalService = {
      async generateTypedRetrieval(
        _query: string,
        _viewerContext: ViewerContext,
        _dedupContext?: unknown,
        _retrievalTemplate?: unknown,
        _queryStrategy?: unknown,
        _contestedCount?: unknown,
        sceneRetrieval?: boolean,
      ) {
        return {
          scene_area: sceneRetrieval
            ? [{ factKey: "location:parlor", value: { lit: true }, sourceKind: "lore_seed" }]
            : [],
          scene_world: sceneRetrieval
            ? [{ factKey: "status:storm", value: "incoming", sourceKind: "system_event" }]
            : [],
          cognition: [
            {
              source_ref: "assertion:1",
              content: "the butler is nearby",
              score: 1,
              kind: "assertion",
              basis: "first_hand",
              stance: "accepted",
              cognitionKey: "butler:nearby",
            },
          ],
          narrative: [],
          conflict_notes: [],
          episode: [],
        };
      },
    } as unknown as RetrievalService;

    const repos: PromptDataRepos = {
      coreMemoryBlockRepo: {} as PromptDataRepos["coreMemoryBlockRepo"],
      recentCognitionSlotRepo: {
        async getSlotPayload() {
          return undefined;
        },
      } as unknown as PromptDataRepos["recentCognitionSlotRepo"],
      interactionRepo: {
        async getMessageRecords() {
          return [];
        },
      } as unknown as PromptDataRepos["interactionRepo"],
      sharedBlockRepo: {} as PromptDataRepos["sharedBlockRepo"],
    };

    const output = await getTypedRetrievalSurfaceAsync(
      "what's happening",
      makeViewer(),
      repos,
      retrievalService,
      { sceneRetrieval: false },
    );

    expect(output).not.toContain("[scene_area]");
    expect(output).not.toContain("[scene_world]");
    expect(output).toContain("[cognition]");
  });
});
