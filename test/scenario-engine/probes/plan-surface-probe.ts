import type { ViewerContext, NavigatorResult } from "../../../src/memory/types.js";
import {
  SCENARIO_DEFAULT_AGENT_ID,
  SCENARIO_DEFAULT_SESSION_ID,
} from "../constants.js";
import type { Story, StoryPlanSurfaceProbe } from "../dsl/story-types.js";
import type { ScenarioHandle } from "../runner/infra.js";
import type { ScenarioHandleExtended } from "../runner/orchestrator.js";

type Drilldown = NonNullable<NavigatorResult["drilldown"]>;
type PlanShadow = NonNullable<Drilldown["query_plan_shadow"]>;
type RouteShadow = Drilldown["query_route_shadow"];

type AnyHandle = ScenarioHandle | ScenarioHandleExtended;

export type PlanSurfaceProbeResult = {
  probe: StoryPlanSurfaceProbe;
  passed: boolean;
  actual: {
    builderVersion?: string;
    primaryIntent?: string;
    secondaryIntents?: string[];
    surfaceWeights?: {
      narrative: number;
      cognition: number;
      episode: number;
      conflict_notes: number;
    };
    seedBias?: Record<string, number>;
    edgeBias?: Record<string, number>;
    routeAgreedWithLegacy?: boolean;
    rationale?: string;
  };
  violations: string[];
  /** true when navigator returned no drilldown.query_plan_shadow at all. */
  shadowMissing: boolean;
};

function buildViewerContext(handle: AnyHandle): ViewerContext {
  return {
    viewer_agent_id: SCENARIO_DEFAULT_AGENT_ID,
    viewer_role: "rp_agent",
    session_id: SCENARIO_DEFAULT_SESSION_ID,
    current_area_id: undefined,
  };
}

function checkPlanShadow(
  probe: StoryPlanSurfaceProbe,
  planShadow: PlanShadow,
  routeShadow: RouteShadow,
): string[] {
  const violations: string[] = [];
  const { expected } = probe;

  if (expected.builderVersion && planShadow.builder_version !== expected.builderVersion) {
    violations.push(
      `builderVersion: expected="${expected.builderVersion}" actual="${planShadow.builder_version}"`,
    );
  }

  if (expected.primaryIntent && planShadow.primary_intent !== expected.primaryIntent) {
    violations.push(
      `primaryIntent: expected="${expected.primaryIntent}" actual="${planShadow.primary_intent}"`,
    );
  }

  if (expected.secondaryIntents) {
    const actual = planShadow.secondary_intents ?? [];
    if (JSON.stringify(actual) !== JSON.stringify(expected.secondaryIntents)) {
      violations.push(
        `secondaryIntents: expected=${JSON.stringify(expected.secondaryIntents)} actual=${JSON.stringify(actual)}`,
      );
    }
  }

  if (expected.minSurfaceWeights) {
    for (const [surface, min] of Object.entries(expected.minSurfaceWeights)) {
      const actual =
        (planShadow.surface_weights as Record<string, number>)[surface] ?? 0;
      if (actual < min!) {
        violations.push(
          `surface_weights.${surface}: expected>=${min} actual=${actual.toFixed(3)}`,
        );
      }
    }
  }

  if (expected.minSeedBias) {
    for (const [kind, min] of Object.entries(expected.minSeedBias)) {
      const actual = planShadow.seed_bias[kind] ?? 0;
      if (actual < min!) {
        violations.push(
          `seed_bias.${kind}: expected>=${min} actual=${actual.toFixed(3)}`,
        );
      }
    }
  }

  if (expected.edgeBiasPresent) {
    for (const key of expected.edgeBiasPresent) {
      if (!(key in planShadow.edge_bias)) {
        violations.push(`edge_bias: expected key "${key}" missing`);
      }
    }
  }

  if (expected.expectRouteAgreedWithLegacy !== undefined) {
    const actual = routeShadow?.agreed_with_legacy ?? false;
    if (actual !== expected.expectRouteAgreedWithLegacy) {
      violations.push(
        `route.agreed_with_legacy: expected=${expected.expectRouteAgreedWithLegacy} actual=${actual}`,
      );
    }
  }

  return violations;
}

export async function executePlanSurfaceProbes(
  story: Story,
  handle: AnyHandle,
): Promise<PlanSurfaceProbeResult[]> {
  const probes = story.planSurfaceProbes ?? [];
  if (probes.length === 0) return [];

  const results: PlanSurfaceProbeResult[] = [];
  const viewerContext = buildViewerContext(handle);

  for (const probe of probes) {
    const entityId = handle.infra.entityIdMap.get(probe.viewerPerspective);
    if (entityId === undefined) {
      throw new Error(
        `PlanSurfaceProbe "${probe.id}": viewerPerspective "${probe.viewerPerspective}" not found in entityIdMap`,
      );
    }

    const navResult = await handle.infra.services.navigator.explore(
      probe.query,
      viewerContext,
    );

    const planShadow = navResult.drilldown?.query_plan_shadow;
    const routeShadow = navResult.drilldown?.query_route_shadow;

    if (!planShadow) {
      results.push({
        probe,
        passed: false,
        actual: {},
        violations: [
          "drilldown.query_plan_shadow missing — verify queryPlanBuilder is wired in runner/infra.ts buildServices()",
        ],
        shadowMissing: true,
      });
      continue;
    }

    const violations = checkPlanShadow(probe, planShadow, routeShadow);

    results.push({
      probe,
      passed: violations.length === 0,
      actual: {
        builderVersion: planShadow.builder_version,
        primaryIntent: planShadow.primary_intent,
        secondaryIntents: planShadow.secondary_intents,
        surfaceWeights: planShadow.surface_weights,
        seedBias: planShadow.seed_bias,
        edgeBias: planShadow.edge_bias,
        routeAgreedWithLegacy: routeShadow?.agreed_with_legacy,
        rationale: planShadow.rationale,
      },
      violations,
      shadowMissing: false,
    });
  }

  return results;
}
