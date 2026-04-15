/**
 * Phase 2 deterministic QueryPlanBuilder.
 *
 * Translates a QueryRoute into a QueryPlan: surface-specific facets +
 * graph plan with seed/edge biases. Pure function (no IO, no clock — the
 * impure clock call lives in query-router.ts).
 *
 * Phase 2 is shadow-only: plans are emitted to trace via navigator's
 * emitQueryRouteAndPlanShadow but never consumed by retrieval or graph
 * execution paths.
 */

import type { AgentRole } from "../agents/profile.js";
import { getDefaultTemplate } from "./contracts/retrieval-template.js";
import type {
  CognitionFacets,
  GraphPlan,
  QueryPlan,
  QueryPlanBuilder,
  SurfaceFacets,
} from "./query-plan-types.js";
import type { QueryRoute } from "./query-routing-types.js";
import type { QueryType } from "./types.js";

const BUILDER_VERSION = "deterministic-v1";

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export class DeterministicQueryPlanBuilder implements QueryPlanBuilder {
  static readonly VERSION = BUILDER_VERSION;

  build(input: { route: QueryRoute; role: AgentRole }): QueryPlan {
    const { route, role } = input;
    const template = getDefaultTemplate(role);

    const hasIntent = (type: QueryType): boolean =>
      route.intents.some((i) => i.type === type);

    const hasConflictIntent = hasIntent("conflict");
    const hasWhyIntent = route.asksWhy || hasIntent("why");
    const hasTimelineIntent = hasIntent("timeline");
    const hasStateIntent = hasIntent("state");

    // === Search-friendly rewrite ===
    // Inject the router-resolved signals (entity hints + intent keywords) in
    // front of the normalized query. This gives pg_trgm / CJK bigram ILIKE
    // prefilters a higher-information seed than the raw user text — queries
    // like "你还记得我们一开始在聊什么吗？" whose tokens are all common
    // Chinese function words get supplemented with the resolved entities
    // from recent routing context. Deterministic and pure: same route in,
    // same rewrite out. undefined if the rewrite adds nothing new.
    const rewrittenQuery = this.buildRewrittenQuery(route);

    // === Surface facets ===
    // Weight = 0 if role disables the surface; otherwise derived from signals.
    const narrative: SurfaceFacets = {
      baseQuery: route.normalizedQuery,
      rewrittenQuery,
      entityFilters: [...route.resolvedEntityIds],
      timeWindow: route.timeConstraint,
      weight: template.narrativeEnabled
        ? clamp01(0.5 + route.signals.needsEntityFocus * 0.5)
        : 0,
      enabledByRole: template.narrativeEnabled,
    };

    const cognition: CognitionFacets = {
      baseQuery: route.normalizedQuery,
      rewrittenQuery,
      entityFilters: [...route.resolvedEntityIds],
      timeWindow: route.timeConstraint,
      weight: template.cognitionEnabled
        ? clamp01(0.4 + route.signals.needsCognition * 0.6)
        : 0,
      enabledByRole: template.cognitionEnabled,
      kind: hasWhyIntent ? "evaluation" : undefined,
      stance: hasConflictIntent ? "contested" : undefined,
    };

    const episode: SurfaceFacets = {
      baseQuery: route.normalizedQuery,
      rewrittenQuery,
      entityFilters: [...route.resolvedEntityIds],
      timeWindow: route.timeConstraint,
      weight: template.episodeEnabled
        ? clamp01(0.3 + route.signals.needsEpisode * 0.7)
        : 0,
      enabledByRole: template.episodeEnabled,
    };

    const conflictNotes: SurfaceFacets = {
      baseQuery: route.normalizedQuery,
      rewrittenQuery,
      entityFilters: [...route.resolvedEntityIds],
      timeWindow: route.timeConstraint,
      weight: template.conflictNotesEnabled
        ? clamp01(route.signals.needsConflict)
        : 0,
      enabledByRole: template.conflictNotesEnabled,
    };

    // === Graph plan ===
    const secondaryIntents = route.intents
      .filter((i) => i.type !== route.primaryIntent)
      .sort((a, b) => b.confidence - a.confidence)
      .map((i) => i.type);

    const graphPlan: GraphPlan = {
      primaryIntent: route.primaryIntent,
      secondaryIntents,
      timeSlice: route.timeConstraint,
      seedBias: {
        entity: clamp01(0.5 + route.signals.needsEntityFocus * 0.5),
        event: clamp01(0.5 + route.signals.needsTimeline * 0.3),
        episode: clamp01(0.3 + route.signals.needsEpisode * 0.7),
        assertion: clamp01(0.4 + route.signals.needsCognition * 0.4),
        evaluation: clamp01(
          route.signals.needsCognition * 0.6 + (hasWhyIntent ? 0.2 : 0),
        ),
        commitment: clamp01(0.3 + (hasStateIntent ? 0.3 : 0)),
      },
      edgeBias: this.deriveEdgeBias({
        hasConflictIntent,
        hasWhyIntent,
        hasTimelineIntent,
      }),
    };

    // === Trace ===
    const matchedRules: string[] = [
      `builder=${BUILDER_VERSION}`,
      `role=${role}`,
    ];
    if (route.intents.length > 1) matchedRules.push("multi_intent");
    if (route.timeConstraint) matchedRules.push("time_constrained");
    if (route.resolvedEntityIds.length >= 2) matchedRules.push("multi_entity");

    return {
      route,
      surfacePlans: { narrative, cognition, episode, conflictNotes },
      graphPlan,
      builderVersion: BUILDER_VERSION,
      rationale: this.buildRationale(route, role, graphPlan),
      matchedRules,
    };
  }

  /**
   * Deterministic query rewrite: prepend entity hints and intent type
   * keywords in front of the normalized query. Returns `undefined` if the
   * rewrite would be identical to the input (nothing to add).
   *
   * Token ordering: [intent types] + [entity hints] + [normalizedQuery].
   * Duplicates are removed so a repeated mention doesn't dominate the
   * rewritten string. This is intentionally NOT called an "expansion" —
   * it's a prefix enrichment, not a synonym rewrite.
   */
  private buildRewrittenQuery(route: QueryRoute): string | undefined {
    const parts: string[] = [];
    const seen = new Set<string>();

    const push = (value: string | undefined | null): void => {
      if (!value) return;
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      parts.push(trimmed);
    };

    // Intent types as keyword markers (e.g. "why", "timeline", "conflict").
    // Low cardinality (≤ QueryType count); dedup guard prevents repeats.
    for (const intent of route.intents) {
      push(intent.type);
    }

    // Entity hints — the tokens the user typed that resolved to known entities
    for (const hint of route.entityHints) {
      push(hint);
    }

    if (parts.length === 0) {
      return undefined;
    }

    // Always suffix the original normalized query so the raw text dominates
    // when there are very few enrichment tokens.
    parts.push(route.normalizedQuery);

    const rewritten = parts.join(" ").trim();
    if (rewritten === route.normalizedQuery.trim()) {
      return undefined;
    }
    return rewritten;
  }

  private deriveEdgeBias(flags: {
    hasConflictIntent: boolean;
    hasWhyIntent: boolean;
    hasTimelineIntent: boolean;
  }): Partial<Record<string, number>> {
    const bias: Record<string, number> = {};
    if (flags.hasConflictIntent) {
      bias.conflicts_with = 1.5;
      bias.downgraded_by = 1.3;
    }
    if (flags.hasWhyIntent) {
      bias.causal = 1.3;
      bias.supports = 1.2;
    }
    if (flags.hasTimelineIntent) {
      bias.temporal_prev = 1.3;
      bias.temporal_next = 1.3;
      bias.surfaced_as = 1.2;
    }
    return bias;
  }

  private buildRationale(
    route: QueryRoute,
    role: AgentRole,
    graphPlan: GraphPlan,
  ): string {
    const parts: string[] = [`role=${role}`, `primary=${graphPlan.primaryIntent}`];
    if (graphPlan.secondaryIntents.length > 0) {
      parts.push(`secondary=[${graphPlan.secondaryIntents.join(",")}]`);
    }
    if (graphPlan.timeSlice) parts.push("time_slice");
    if (route.resolvedEntityIds.length >= 2) parts.push("multi_entity");
    return parts.join(" | ");
  }
}
