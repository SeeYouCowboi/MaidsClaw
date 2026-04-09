import { describe, expect, it } from "bun:test";
import { DeterministicQueryPlanBuilder } from "../../src/memory/query-plan-builder";
import { RuleBasedQueryRouter } from "../../src/memory/query-router";
import type { AliasService } from "../../src/memory/alias";
import type { AgentRole } from "../../src/agents/profile";
import type { QueryRoute, QuerySignals } from "../../src/memory/query-routing-types";

const ALIAS_MAP: Record<string, number> = {
  Alice: 1,
  alice: 1,
  Bob: 2,
  bob: 2,
  Carol: 3,
  carol: 3,
};

function makeAlias(): AliasService {
  return {
    async resolveAlias(alias: string): Promise<number | null> {
      return ALIAS_MAP[alias] ?? null;
    },
  } as unknown as AliasService;
}

function makeRouter(): RuleBasedQueryRouter {
  return new RuleBasedQueryRouter(makeAlias());
}

function makeBuilder(): DeterministicQueryPlanBuilder {
  return new DeterministicQueryPlanBuilder();
}

/** Build a synthetic route directly when we want fine-grained control. */
function syntheticRoute(overrides: Partial<QueryRoute> = {}): QueryRoute {
  const defaultSignals: QuerySignals = {
    needsEpisode: 0,
    needsConflict: 0,
    needsTimeline: 0,
    needsRelationship: 0,
    needsCognition: 0,
    needsEntityFocus: 0,
  };
  return {
    originalQuery: "synthetic",
    normalizedQuery: "synthetic",
    intents: [],
    primaryIntent: "event",
    routeConfidence: 0,
    resolvedEntityIds: [],
    entityHints: [],
    relationPairs: [],
    timeConstraint: null,
    timeSignals: [],
    locationHints: [],
    asksWhy: false,
    asksChange: false,
    asksComparison: false,
    signals: defaultSignals,
    rationale: "",
    matchedRules: [],
    classifierVersion: "rule-v1",
    ...overrides,
  };
}

async function routeQuery(query: string): Promise<QueryRoute> {
  return makeRouter().route({ query, viewerAgentId: "agent_test" });
}

describe("DeterministicQueryPlanBuilder — basic build", () => {
  it("primaryIntent matches route.primaryIntent", async () => {
    const route = await routeQuery("why did Alice leave");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.graphPlan.primaryIntent).toBe(route.primaryIntent);
    expect(plan.graphPlan.primaryIntent).toBe("why");
  });

  it("emits builderVersion deterministic-v1", async () => {
    const route = await routeQuery("test query");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.builderVersion).toBe("deterministic-v1");
  });

  it("multi-intent query exposes secondaryIntents sorted by confidence desc", async () => {
    const route = await routeQuery("为什么Alice和Bob的关系最近变了");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.graphPlan.primaryIntent).toBe("why");
    expect(plan.graphPlan.secondaryIntents.length).toBeGreaterThanOrEqual(1);
    expect(plan.graphPlan.secondaryIntents).toContain("relationship");
    // Sorted descending — for each adjacent pair, prev confidence >= next
    const intentMap = new Map(route.intents.map((i) => [i.type, i.confidence]));
    for (let i = 0; i < plan.graphPlan.secondaryIntents.length - 1; i++) {
      const a = intentMap.get(plan.graphPlan.secondaryIntents[i]) ?? 0;
      const b = intentMap.get(plan.graphPlan.secondaryIntents[i + 1]) ?? 0;
      expect(a).toBeGreaterThanOrEqual(b);
    }
  });
});

describe("DeterministicQueryPlanBuilder — role gating", () => {
  it("task_agent generates a plan with all surface weights = 0", async () => {
    const route = await routeQuery("why did Alice leave");
    const plan = makeBuilder().build({ route, role: "task_agent" });
    expect(plan.surfacePlans.narrative.weight).toBe(0);
    expect(plan.surfacePlans.cognition.weight).toBe(0);
    expect(plan.surfacePlans.episode.weight).toBe(0);
    expect(plan.surfacePlans.conflictNotes.weight).toBe(0);
    expect(plan.surfacePlans.narrative.enabledByRole).toBe(false);
    expect(plan.surfacePlans.cognition.enabledByRole).toBe(false);
    expect(plan.surfacePlans.episode.enabledByRole).toBe(false);
    expect(plan.surfacePlans.conflictNotes.enabledByRole).toBe(false);
  });

  it("maiden has cognition.weight = 0 and conflictNotes.weight = 0", async () => {
    const route = await routeQuery("why did Alice and Bob fight");
    const plan = makeBuilder().build({ route, role: "maiden" });
    expect(plan.surfacePlans.cognition.weight).toBe(0);
    expect(plan.surfacePlans.cognition.enabledByRole).toBe(false);
    expect(plan.surfacePlans.conflictNotes.weight).toBe(0);
    expect(plan.surfacePlans.conflictNotes.enabledByRole).toBe(false);
    expect(plan.surfacePlans.narrative.enabledByRole).toBe(true);
    expect(plan.surfacePlans.episode.enabledByRole).toBe(true);
  });

  it("rp_agent enables all surfaces", async () => {
    const route = await routeQuery("why did Alice leave");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.surfacePlans.narrative.enabledByRole).toBe(true);
    expect(plan.surfacePlans.cognition.enabledByRole).toBe(true);
    expect(plan.surfacePlans.episode.enabledByRole).toBe(true);
    expect(plan.surfacePlans.conflictNotes.enabledByRole).toBe(true);
  });
});

describe("DeterministicQueryPlanBuilder — facets do not rewrite query", () => {
  it("baseQuery equals route.normalizedQuery for all surfaces", async () => {
    const queries = [
      "why did Alice leave",
      "@Alice 和 @Bob 的关系",
      "为什么Alice和Bob的关系最近变了",
      "请告诉我昨天@爱丽丝 和 @管家 之间的冲突",
    ];
    for (const q of queries) {
      const route = await routeQuery(q);
      const plan = makeBuilder().build({ route, role: "rp_agent" });
      expect(plan.surfacePlans.narrative.baseQuery).toBe(route.normalizedQuery);
      expect(plan.surfacePlans.cognition.baseQuery).toBe(route.normalizedQuery);
      expect(plan.surfacePlans.episode.baseQuery).toBe(route.normalizedQuery);
      expect(plan.surfacePlans.conflictNotes.baseQuery).toBe(route.normalizedQuery);
    }
  });

  it("entityFilters match route.resolvedEntityIds", async () => {
    const route = await routeQuery("relationship between Alice and Bob");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.surfacePlans.narrative.entityFilters).toEqual(route.resolvedEntityIds);
    expect(plan.surfacePlans.cognition.entityFilters).toEqual(route.resolvedEntityIds);
    expect(plan.surfacePlans.episode.entityFilters).toEqual(route.resolvedEntityIds);
  });
});

describe("DeterministicQueryPlanBuilder — seedBias formulas", () => {
  it("zero signals produce baseline values", () => {
    const route = syntheticRoute();
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.graphPlan.seedBias.entity).toBe(0.5);
    expect(plan.graphPlan.seedBias.event).toBe(0.5);
    expect(plan.graphPlan.seedBias.episode).toBe(0.3);
    expect(plan.graphPlan.seedBias.assertion).toBe(0.4);
    expect(plan.graphPlan.seedBias.evaluation).toBe(0);
    expect(plan.graphPlan.seedBias.commitment).toBe(0.3);
  });

  it("all-one signals saturate to 1", () => {
    const route = syntheticRoute({
      asksWhy: true,
      intents: [{ type: "state", confidence: 0.8, evidence: ["state"] }],
      primaryIntent: "state",
      signals: {
        needsEpisode: 1,
        needsConflict: 1,
        needsTimeline: 1,
        needsRelationship: 1,
        needsCognition: 1,
        needsEntityFocus: 1,
      },
    });
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.graphPlan.seedBias.entity).toBe(1);
    expect(plan.graphPlan.seedBias.episode).toBe(1);
    expect(plan.graphPlan.seedBias.evaluation).toBe(0.8); // 0.6 + 0.2
    // event: 0.5 + 0.3 = 0.8
    expect(plan.graphPlan.seedBias.event).toBe(0.8);
    // commitment: 0.3 + 0.3 = 0.6 (state intent active)
    expect(plan.graphPlan.seedBias.commitment).toBe(0.6);
  });

  it("needsEntityFocus=0.5 → entity=0.75", () => {
    const route = syntheticRoute({
      signals: {
        needsEpisode: 0,
        needsConflict: 0,
        needsTimeline: 0,
        needsRelationship: 0,
        needsCognition: 0,
        needsEntityFocus: 0.5,
      },
    });
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.graphPlan.seedBias.entity).toBe(0.75);
  });

  it("asksWhy=true raises evaluation above asksWhy=false baseline", () => {
    const baseSignals: QuerySignals = {
      needsEpisode: 0,
      needsConflict: 0,
      needsTimeline: 0,
      needsRelationship: 0,
      needsCognition: 0.5,
      needsEntityFocus: 0,
    };
    const withWhy = syntheticRoute({ asksWhy: true, signals: baseSignals });
    const withoutWhy = syntheticRoute({ asksWhy: false, signals: baseSignals });
    const planA = makeBuilder().build({ route: withWhy, role: "rp_agent" });
    const planB = makeBuilder().build({ route: withoutWhy, role: "rp_agent" });
    expect(planA.graphPlan.seedBias.evaluation).toBeGreaterThan(
      planB.graphPlan.seedBias.evaluation,
    );
  });

  it("all seedBias values stay clamped 0..1", () => {
    const route = syntheticRoute({
      asksWhy: true,
      signals: {
        needsEpisode: 1,
        needsConflict: 1,
        needsTimeline: 1,
        needsRelationship: 1,
        needsCognition: 1,
        needsEntityFocus: 1,
      },
    });
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    for (const v of Object.values(plan.graphPlan.seedBias)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("DeterministicQueryPlanBuilder — edgeBias derivation", () => {
  it("conflict intent sets conflicts_with and downgraded_by", async () => {
    const route = await routeQuery("Alice and Bob have a conflict");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.graphPlan.edgeBias.conflicts_with).toBe(1.5);
    expect(plan.graphPlan.edgeBias.downgraded_by).toBe(1.3);
  });

  it("why intent sets causal and supports", async () => {
    const route = await routeQuery("why did this happen");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.graphPlan.edgeBias.causal).toBe(1.3);
    expect(plan.graphPlan.edgeBias.supports).toBe(1.2);
  });

  it("timeline intent sets temporal_prev/next and surfaced_as", async () => {
    const route = await routeQuery("timeline of the events");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.graphPlan.edgeBias.temporal_prev).toBe(1.3);
    expect(plan.graphPlan.edgeBias.temporal_next).toBe(1.3);
    expect(plan.graphPlan.edgeBias.surfaced_as).toBe(1.2);
  });

  it("opaque query yields empty edgeBias", async () => {
    const route = await routeQuery("lorem ipsum");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(Object.keys(plan.graphPlan.edgeBias).length).toBe(0);
  });
});

describe("DeterministicQueryPlanBuilder — cognition kind/stance", () => {
  it("asksWhy → cognition.kind = evaluation", async () => {
    const route = await routeQuery("why did Alice leave");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.surfacePlans.cognition.kind).toBe("evaluation");
  });

  it("conflict intent → cognition.stance = contested", async () => {
    const route = await routeQuery("Alice and Bob have a conflict");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.surfacePlans.cognition.stance).toBe("contested");
  });

  it("plain entity query → no kind, no stance", async () => {
    const route = await routeQuery("Alice");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.surfacePlans.cognition.kind).toBeUndefined();
    expect(plan.surfacePlans.cognition.stance).toBeUndefined();
  });
});

describe("DeterministicQueryPlanBuilder — CJK + multi-intent", () => {
  it("为什么Alice和Bob的关系最近变了 → all rp_agent surfaces > 0", async () => {
    const route = await routeQuery("为什么Alice和Bob的关系最近变了");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.surfacePlans.narrative.weight).toBeGreaterThan(0);
    expect(plan.surfacePlans.cognition.weight).toBeGreaterThan(0);
    expect(plan.surfacePlans.episode.weight).toBeGreaterThan(0);
  });

  it("same query under maiden role → cognition.weight = 0", async () => {
    const route = await routeQuery("为什么Alice和Bob的关系最近变了");
    const plan = makeBuilder().build({ route, role: "maiden" });
    expect(plan.surfacePlans.cognition.weight).toBe(0);
    expect(plan.surfacePlans.narrative.weight).toBeGreaterThan(0);
  });
});

describe("DeterministicQueryPlanBuilder — observability", () => {
  it("multi-intent route → matchedRules contains multi_intent", async () => {
    const route = await routeQuery("为什么Alice和Bob的关系最近变了");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.matchedRules).toContain("multi_intent");
  });

  it("time-constrained route → matchedRules contains time_constrained", async () => {
    const route = await routeQuery("yesterday Alice left");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.matchedRules).toContain("time_constrained");
  });

  it("multi-entity route → matchedRules contains multi_entity", async () => {
    const route = await routeQuery("relationship between Alice and Bob");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.matchedRules).toContain("multi_entity");
  });

  it("rationale includes role= and primary= prefixes", async () => {
    const route = await routeQuery("why did Alice leave");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.rationale).toContain("role=rp_agent");
    expect(plan.rationale).toContain("primary=why");
  });

  it("matchedRules includes builder version and role tags", async () => {
    const route = await routeQuery("test");
    const plan = makeBuilder().build({ route, role: "rp_agent" });
    expect(plan.matchedRules).toContain("builder=deterministic-v1");
    expect(plan.matchedRules).toContain("role=rp_agent");
  });
});

describe("DeterministicQueryPlanBuilder — performance", () => {
  it("100 builds complete in under 10ms", async () => {
    const route = await routeQuery("为什么Alice和Bob的关系最近变了");
    const builder = makeBuilder();
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      builder.build({ route, role: "rp_agent" });
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(10);
  });
});
