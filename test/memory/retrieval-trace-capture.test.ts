import { describe, expect, it } from "bun:test";
import { RetrievalService } from "../../src/memory/retrieval.js";
import type { QueryPlan, QueryPlanBuilder } from "../../src/memory/query-plan-types.js";
import type { QueryRoute, QueryRouter } from "../../src/memory/query-routing-types.js";
import type { ViewerContext } from "../../src/memory/types.js";

const viewerContext: ViewerContext = {
  viewer_agent_id: "agent-1",
  viewer_role: "rp_agent",
  session_id: "session-1",
};

function makeQueryRoute(): QueryRoute {
  return {
    originalQuery: "what happened",
    normalizedQuery: "what happened",
    intents: [],
    primaryIntent: "event",
    routeConfidence: 0.8,
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
      needsCognition: 1,
      needsEntityFocus: 1,
    },
    rationale: "test",
    matchedRules: [],
    classifierVersion: "test-v1",
  };
}

function makeQueryPlan(route: QueryRoute): QueryPlan {
  return {
    route,
    surfacePlans: {
      narrative: {
        baseQuery: route.normalizedQuery,
        entityFilters: [7],
        timeWindow: { asOfCommittedTime: 1700000000000 },
        weight: 0.5,
        enabledByRole: true,
      },
      cognition: {
        baseQuery: route.normalizedQuery,
        entityFilters: [9],
        timeWindow: { asOfCommittedTime: 1700000000001 },
        weight: 0.5,
        enabledByRole: true,
        kind: "assertion",
        stance: "contested",
      },
      episode: {
        baseQuery: route.normalizedQuery,
        entityFilters: [],
        timeWindow: null,
        weight: 0.2,
        enabledByRole: true,
      },
      conflictNotes: {
        baseQuery: route.normalizedQuery,
        entityFilters: [],
        timeWindow: null,
        weight: 0.2,
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
        episode: 0.2,
        assertion: 0.4,
        evaluation: 0,
        commitment: 0.3,
      },
      edgeBias: {},
    },
    builderVersion: "test-plan-v1",
    rationale: "test",
    matchedRules: [],
  };
}

describe("retrieval trace capture", () => {
  it("captures query/strategy/facets/segment_count at retrieval boundary", async () => {
    const route = makeQueryRoute();
    const plan = makeQueryPlan(route);

    const queryRouter: QueryRouter = {
      route: async () => route,
    };

    const queryPlanBuilder: QueryPlanBuilder = {
      build: () => plan,
    };

    const retrievalService = new RetrievalService({
      retrievalRepo: {} as any,
      embeddingService: {} as any,
      narrativeSearch: {} as any,
      cognitionSearch: {} as any,
      orchestrator: {
        search: async () => ({
          typed: {
            narrative: [{ source_ref: "event:1", content: "n1", score: 1, doc_type: "event", scope: "area" }],
            cognition: [{ source_ref: "assertion:1", content: "c1", score: 1, kind: "assertion", basis: null, stance: "contested", cognitionKey: "k1" }],
            conflict_notes: [{ source_ref: "conflict_note:1", from_source_ref: "assertion:1", cognitionKey: "k1", content: "x", score: 1 }],
            episode: [{ source_ref: "episode:1", content: "e1", score: 1, doc_type: "episode_event", scope: "private" }],
          },
          narrativeHints: [],
          cognitionHits: [],
        }),
      } as any,
      queryRouter,
      queryPlanBuilder,
    });

    let capture: any;
    await retrievalService.generateTypedRetrieval(
      "what happened",
      viewerContext,
      undefined,
      undefined,
      "deep_explain",
      undefined,
      (c) => {
        capture = c;
      },
    );

    expect(capture).toEqual({
      query_string: "what happened",
      strategy: "deep_explain",
      narrative_facets_used: ["entity_filters", "time_window"],
      cognition_facets_used: ["entity_filters", "time_window", "kind", "stance"],
      segment_count: 4,
    });
  });

  it("does not fail retrieval when trace callback throws", async () => {
    const retrievalService = new RetrievalService({
      retrievalRepo: {} as any,
      embeddingService: {} as any,
      narrativeSearch: {} as any,
      cognitionSearch: {} as any,
      orchestrator: {
        search: async () => ({
          typed: {
            narrative: [{ source_ref: "event:1", content: "n1", score: 1, doc_type: "event", scope: "area" }],
            cognition: [],
            conflict_notes: [],
            episode: [],
          },
          narrativeHints: [],
          cognitionHits: [],
        }),
      } as any,
    });

    const typed = await retrievalService.generateTypedRetrieval(
      "hello",
      viewerContext,
      undefined,
      undefined,
      "default_retrieval",
      undefined,
      () => {
        throw new Error("capture failed");
      },
    );

    expect(typed.narrative).toHaveLength(1);
    expect(typed.narrative[0].content).toBe("n1");
  });
});
