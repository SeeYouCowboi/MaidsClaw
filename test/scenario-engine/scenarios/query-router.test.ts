import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AliasService } from "../../../src/memory/alias.js";
import { getDefaultTemplate } from "../../../src/memory/contracts/retrieval-template.js";
import { allocateBudget } from "../../../src/memory/retrieval/budget-allocator.js";
import type { QueryPlan } from "../../../src/memory/query-plan-types.js";
import type { QueryRoute } from "../../../src/memory/query-routing-types.js";
import { PgAliasRepo } from "../../../src/storage/domain-repos/pg/alias-repo.js";
import { skipPgTests } from "../../helpers/pg-test-utils.js";
import { SCENARIO_DEFAULT_AGENT_ID } from "../constants.js";
import { runScenario, type ScenarioHandleExtended } from "../runner/orchestrator.js";
import { queryRouterCases, queryRouterStory } from "../stories/query-router.js";

function getCase(id: string) {
  const found = queryRouterCases.find((item) => item.id === id);
  if (!found) {
    throw new Error(`queryRouterCases missing case: ${id}`);
  }
  return found;
}

function requireEntityId(handle: ScenarioHandleExtended, pointerKey: string): number {
  const id = handle.infra.entityIdMap.get(pointerKey);
  if (id === undefined) {
    throw new Error(`Missing entity id for pointerKey: ${pointerKey}`);
  }
  return id;
}

function normalizePlanAndBudget(route: QueryRoute, plan: QueryPlan) {
  const allocated = allocateBudget(getDefaultTemplate("rp_agent"), route.signals);
  return {
    primaryIntent: plan.graphPlan.primaryIntent,
    intents: route.intents.map((intent) => ({
      type: intent.type,
      confidence: intent.confidence,
      evidence: [...intent.evidence],
    })),
    surfaces: {
      narrativeWeight: plan.surfacePlans.narrative.weight,
      cognitionWeight: plan.surfacePlans.cognition.weight,
      episodeWeight: plan.surfacePlans.episode.weight,
      conflictNotesWeight: plan.surfacePlans.conflictNotes.weight,
      narrativeBudget: allocated.narrativeBudget,
      cognitionBudget: allocated.cognitionBudget,
      episodeBudget: allocated.episodeBudget,
      conflictNotesBudget: allocated.conflictNotesBudget,
    },
  };
}

describe.skipIf(skipPgTests)("Query Router Scenario Integration", () => {
  let handle!: ScenarioHandleExtended;

  beforeAll(async () => {
    handle = await runScenario(queryRouterStory, {
      writePath: "settlement",
      phase: "full",
      keepSchema: false,
    });

    const aliasBootstrap = new AliasService(new PgAliasRepo(handle.infra.sql));
    await aliasBootstrap.syncSharedAliasesToSegmenter();
  }, 10 * 60 * 1000);

  afterAll(async () => {
    if (handle) {
      await handle.infra._testDb.cleanup();
    }
  });

  it("CJK alias substring scan resolves expected entity and negative control does not", async () => {
    const cjkAliasCase = getCase("cjk-alias-scan");
    const expectedEntityIds = (cjkAliasCase.expectedEntityIds ?? []).map((pointerKey) =>
      requireEntityId(handle, pointerKey),
    );

    const route = await handle.infra.services.queryRouter.route({
      query: cjkAliasCase.query,
      viewerAgentId: SCENARIO_DEFAULT_AGENT_ID,
    });

    expect(route.resolvedEntityIds).toEqual(expectedEntityIds);

    const negativeRoute = await handle.infra.services.queryRouter.route({
      query: "请说明并不存在人物的情况",
      viewerAgentId: SCENARIO_DEFAULT_AGENT_ID,
    });

    expect(negativeRoute.resolvedEntityIds).not.toContain(expectedEntityIds[0]);
    expect(negativeRoute.resolvedEntityIds).toHaveLength(0);
  });

  it("multi-intent routing returns expected primary/secondary intents, rules, and signals", async () => {
    const multiIntentCase = getCase("multi-intent-routing");

    const route = await handle.infra.services.queryRouter.route({
      query: multiIntentCase.query,
      viewerAgentId: SCENARIO_DEFAULT_AGENT_ID,
    });

    const plan = handle.infra.services.queryPlanBuilder.build({
      route,
      role: "rp_agent",
    });

    expect(route.primaryIntent).toBe(multiIntentCase.expectedPrimaryIntent);
    expect(plan.graphPlan.secondaryIntents).toEqual(
      multiIntentCase.expectedSecondaryIntents,
    );

    expect(route.matchedRules).toContain("relationship_keywords");
    expect(route.matchedRules).toContain("state_keywords");
    expect(route.matchedRules.some((rule) => rule.startsWith("entities_resolved:"))).toBe(
      true,
    );
    expect(route.matchedRules.some((rule) => rule.startsWith("relation_pairs:"))).toBe(
      true,
    );

    expect(route.signals.needsRelationship).toBeCloseTo(0.9, 5);
    expect(route.signals.needsEntityFocus).toBeGreaterThanOrEqual(0.8);
    expect(route.signals.needsCognition).toBeGreaterThan(0);
  });

  it("same query twice yields byte-stable normalized plan and budget objects", async () => {
    const determinismCase = getCase("plan-determinism");

    const routeA = await handle.infra.services.queryRouter.route({
      query: determinismCase.query,
      viewerAgentId: SCENARIO_DEFAULT_AGENT_ID,
    });
    const planA = handle.infra.services.queryPlanBuilder.build({
      route: routeA,
      role: "rp_agent",
    });

    const routeB = await handle.infra.services.queryRouter.route({
      query: determinismCase.query,
      viewerAgentId: SCENARIO_DEFAULT_AGENT_ID,
    });
    const planB = handle.infra.services.queryPlanBuilder.build({
      route: routeB,
      role: "rp_agent",
    });

    const normalizedA = normalizePlanAndBudget(routeA, planA);
    const normalizedB = normalizePlanAndBudget(routeB, planB);

    expect(Object.keys(normalizedA)).toEqual(determinismCase.normalizationFields);
    expect(JSON.stringify(normalizedA)).toBe(JSON.stringify(normalizedB));
  });
});
