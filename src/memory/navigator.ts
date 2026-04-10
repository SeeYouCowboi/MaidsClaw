import type {
  GraphNodeVisibilityRecord,
  GraphReadQueryRepo,
} from "../storage/domain-repos/contracts/graph-read-query-repo.js";

import { createLogger } from "../core/logger.js";
import type { AliasService } from "./alias.js";
import { parseGraphNodeRef } from "./contracts/graph-node-ref.js";
import { tokenizeQuery } from "./query-tokenizer.js";

const logger = createLogger({ name: "memory.navigator", level: "debug" });
import {
  WHY_KEYWORDS,
  TIMELINE_KEYWORDS,
  RELATIONSHIP_KEYWORDS,
  STATE_KEYWORDS,
  CONFLICT_KEYWORDS,
  TIME_CONSTRAINT_KEYWORDS,
} from "./query-routing-keywords.js";
import type { QueryRoute, QueryRouter } from "./query-routing-types.js";
import type { QueryPlan, QueryPlanBuilder } from "./query-plan-types.js";
import type { RetrievalService } from "./retrieval.js";
import { GraphEdgeView } from "./graph-edge-view.js";
import { RedactionPolicy, AuthorizationPolicy, type VisibilityDisposition } from "./redaction-policy.js";
import {
  filterEvidencePathsByTimeSlice,
  hasTimeSlice,
  summarizeTimeSlicedPaths,
  type TimeSliceQuery,
} from "./time-slice-query.js";
import { VisibilityPolicy } from "./visibility-policy.js";
import {
  MEMORY_RELATION_TYPES,
  type AuditProvenance,
  type BeamEdge,
  type BeamPath,
  type EdgeLayer,
  type EvidencePath,
  type ExplainDetailLevel,
  type ExploreMode,
  type MemoryExploreInput,
  type MemoryRelationType,
  type NavigatorEdgeKind,
  type NavigatorResult,
  type NodeRef,
  type NodeRefKind,
  type PathScore,
  type QueryType,
  type RedactedPlaceholder,
  type SeedCandidate,
  type ViewerContext,
} from "./types.js";

type ModelProviderClientLike = {
  rewriteQuery?: (query: string) => string;
  tieBreak?: (query: string, candidateA: string, candidateB: string) => number;
};

export type EmbedProviderLike = {
  embed(texts: string[], purpose: string, modelId: string): Promise<Float32Array[]>;
};

export type NarrativeSearchServiceLike = {
  searchNarrative(query: string, viewerContext: ViewerContext): Promise<Array<{ source_ref: string }>>;
};

export type CognitionSearchServiceLike = {
  searchCognition(params: {
    agentId: string;
    query?: string;
    activeOnly?: boolean;
    limit?: number;
  }): Array<{ source_ref: string }> | Promise<Array<{ source_ref: string }>>;
};

type QueryAnalysis = {
  normalized_query: string;
  query_type: QueryType;
  resolved_entity_ids: Set<number>;
  entity_hints: string[];
  has_time_constraint: boolean;
};

type InternalBeamEdge = BeamEdge & {
  canonical_fact_id: number | null;
  canonical_evidence: boolean;
};

type InternalBeamPath = {
  path: BeamPath;
  seed: SeedCandidate;
  internal_edges: InternalBeamEdge[];
};

type NodeSnapshot = {
  summary: string | null;
  timestamp: number | null;
};

export type NavigatorOptions = {
  seedCount?: number;
  beamWidth?: number;
  maxDepth?: number;
  maxCandidates?: number;
};

const DEFAULT_OPTIONS: Required<NavigatorOptions> = {
  seedCount: 10,
  beamWidth: 8,
  maxDepth: 2,
  maxCandidates: 12,
};

/**
 * Strategy for tuning graph retrieval beam search behavior.
 * Each strategy can boost/reduce specific memory relation types and adjust beam width.
 */
export type GraphRetrievalStrategy = {
  name: string;
  edgeWeights: Partial<Record<MemoryRelationType, number>>;
  beamWidthMultiplier: number;
};

export const GRAPH_RETRIEVAL_STRATEGIES = {
  default_retrieval: {
    name: "default_retrieval",
    edgeWeights: {},
    beamWidthMultiplier: 1.0,
  },
  deep_explain: {
    name: "deep_explain",
    edgeWeights: { supports: 1.2, derived_from: 1.2 },
    beamWidthMultiplier: 1.5,
  },
  time_slice_reconstruction: {
    name: "time_slice_reconstruction",
    edgeWeights: { surfaced_as: 1.3 },
    beamWidthMultiplier: 1.0,
  },
  conflict_exploration: {
    name: "conflict_exploration",
    edgeWeights: { conflicts_with: 2.0, downgraded_by: 1.5, resolved_by: 1.3 },
    beamWidthMultiplier: 1.2,
  },
} as const satisfies Record<string, GraphRetrievalStrategy>;

const QUERY_TYPE_PRIORITY = {
  entity: ["fact_relation", "participant", "fact_support", "semantic_similar"],
  event: ["same_episode", "temporal_prev", "temporal_next", "causal", "fact_support"],
  why: ["causal", "fact_support", "fact_relation", "temporal_prev"],
  relationship: ["fact_relation", "fact_support", "participant", "semantic_similar"],
  timeline: ["temporal_prev", "temporal_next", "same_episode", "causal", "fact_support"],
  state: ["fact_relation", "conflict_or_update", "fact_support", "temporal_next"],
  conflict: ["conflict_or_update", "fact_relation", "fact_support", "causal", "temporal_prev"],
} satisfies Record<QueryType, NavigatorEdgeKind[]>;

const KNOWN_NODE_KINDS = new Set<NodeRefKind>([
  "event",
  "entity",
  "fact",
  "assertion",
  "evaluation",
  "commitment",
]);

/**
 * GAP-4 §2 feature flag covering both Stage A and Stage B: when enabled,
 * the navigator consumes `plan.graphPlan.{seedBias, edgeBias, timeSlice,
 * primaryIntent, secondaryIntents}` to influence seed scoring and beam
 * search. When disabled, the navigator runs exactly as pre-Phase-4 —
 * plan/route are still computed and emitted to shadow logs + drilldown
 * for §10/§6, but they don't touch the search path.
 *
 * Rollout state: **default is ON**. Stage A + Stage B landed and the
 * §10 shadow gates (multi-intent ≥ 15%, edge_bias non-empty ≥ 10%,
 * sample ≥ 100, failure rate 0%) were all green on the 133-fixture
 * adversarial shadow run — flipping the default was the last step of
 * the GAP-4 Phase 4 navigator rollout. Set
 * `MAIDSCLAW_NAVIGATOR_USE_PLAN=off` for single-env-var instant
 * rollback if a regression appears in production. Any value other than
 * the exact string `"off"` leaves plan consumption enabled (unset,
 * `"on"`, `"yes"`, `"1"`, etc.).
 *
 * Disable semantics note: the inverse check (`!== "off"`) means future
 * deploys that forget to set the flag at all still get plan
 * consumption. That's the intended production default post-rollout.
 */
function isNavigatorPlanConsumptionEnabled(): boolean {
  return process.env.MAIDSCLAW_NAVIGATOR_USE_PLAN !== "off";
}

/**
 * GAP-4 §2 Stage A: combine the strategy edge weight with the optional
 * plan-supplied edge bias. Both default to 1.0 when missing. Used by
 * `compareNeighborEdges`, `preliminaryPathScore`, and `rerankPaths` —
 * three call sites that previously used `strategy?.edgeWeights[kind] ?? 1.0`
 * directly. Plan multiplier is sparse (`Partial<Record>`) so missing keys
 * fall through to the strategy alone, never overriding it.
 *
 * Exported (rather than file-private) so unit tests can verify the merge
 * semantics directly without constructing a full GraphNavigator.
 */
export function effectiveEdgeMultiplier(
  kind: NavigatorEdgeKind | MemoryRelationType,
  strategy: GraphRetrievalStrategy | undefined,
  plan: QueryPlan | null,
): number {
  const strategyMultiplier = strategy?.edgeWeights[kind as MemoryRelationType] ?? 1.0;
  if (plan == null || !isNavigatorPlanConsumptionEnabled()) return strategyMultiplier;
  const planMultiplier = plan.graphPlan.edgeBias?.[kind as string] ?? 1.0;
  return strategyMultiplier * planMultiplier;
}

/**
 * GAP-4 §2 Stage B: resolve the effective primary query intent. Returns
 * `plan.graphPlan.primaryIntent` when plan consumption is enabled AND a
 * plan is present; otherwise the legacy `analysis.query_type`. Exported
 * for unit tests (so we can check flag gating without a navigator).
 *
 * Why this exists: the router's §1 multi-intent classifier and §8
 * private-alias scan recover classifications the navigator's pre-Phase-4
 * `analyzeQuery` misses (shadow data shows ~5% of CJK queries with
 * private aliases are misclassified as `event`). Replacing
 * `analysis.query_type` at the five scoring call sites lets those
 * corrected intents drive beam expansion + seed scoring. The flag still
 * defaults OFF — flipping the default is a separate rollout step.
 */
export function resolveEffectivePrimaryIntent(
  analysis: { query_type: QueryType },
  plan: QueryPlan | null,
): QueryType {
  if (plan == null || !isNavigatorPlanConsumptionEnabled()) return analysis.query_type;
  return plan.graphPlan.primaryIntent;
}

/**
 * GAP-4 §2 Stage B: resolve the effective secondary intent list. Returns
 * `plan.graphPlan.secondaryIntents` (already sorted by descending
 * confidence in the deterministic builder) when plan consumption is
 * enabled; otherwise an empty array so the legacy priority list used at
 * edge scoring remains byte-identical to pre-Phase-4.
 */
export function resolveEffectiveSecondaryIntents(
  plan: QueryPlan | null,
): readonly QueryType[] {
  if (plan == null || !isNavigatorPlanConsumptionEnabled()) return [];
  // Defensive copy: the returned array is typed `readonly` but the
  // source (`plan.graphPlan.secondaryIntents`) is a mutable `QueryType[]`.
  // A future caller widening the type could mutate the plan in place; a
  // copy is O(n≤7) and rules that out. Chaos test §7 asserts
  // `mergedEdgePriority` never mutates its input, but defense in depth
  // here is effectively free.
  return [...plan.graphPlan.secondaryIntents];
}

/**
 * GAP-4 §2 Stage B: build the merged edge-kind priority list used by
 * `edgePriorityScore` when secondary intents are present. The primary
 * intent's priority list comes first (preserving its ranking exactly),
 * then each secondary intent's list is appended with duplicates removed.
 *
 * Example: primary=why (`[causal, fact_support, fact_relation,
 * temporal_prev]`), secondary=[timeline] (`[temporal_prev, temporal_next,
 * same_episode, causal, fact_support]`) → merged `[causal, fact_support,
 * fact_relation, temporal_prev, temporal_next, same_episode]`.
 *
 * Exported so unit tests can verify the concat/dedup semantics directly.
 */
export function mergedEdgePriority(
  primary: QueryType,
  secondaries: readonly QueryType[],
): readonly NavigatorEdgeKind[] {
  const seen = new Set<NavigatorEdgeKind>();
  const out: NavigatorEdgeKind[] = [];
  for (const kind of QUERY_TYPE_PRIORITY[primary]) {
    if (!seen.has(kind)) {
      seen.add(kind);
      out.push(kind);
    }
  }
  for (const sec of secondaries) {
    for (const kind of QUERY_TYPE_PRIORITY[sec]) {
      if (!seen.has(kind)) {
        seen.add(kind);
        out.push(kind);
      }
    }
  }
  return out;
}

export class GraphNavigator {
  private readonly readRepo: GraphReadQueryRepo;
  private readonly visibilityPolicy: VisibilityPolicy;
  private readonly redactionPolicy: RedactionPolicy;
  private readonly edgeView: GraphEdgeView;
  private readonly privateNodeOwnerCache = new Map<NodeRef, string | null>();
  private readonly visibilityRecordCache = new Map<NodeRef, GraphNodeVisibilityRecord | null>();

  constructor(
    readRepo: GraphReadQueryRepo,
    private readonly retrieval: RetrievalService,
    private readonly alias: AliasService,
    _modelProvider?: ModelProviderClientLike,
    private readonly narrativeSearch?: NarrativeSearchServiceLike,
    private readonly cognitionSearch?: CognitionSearchServiceLike,
    visibilityPolicy?: VisibilityPolicy,
    redactionPolicy?: RedactionPolicy,
    authorizationPolicy?: AuthorizationPolicy,
    private readonly embedProvider?: EmbedProviderLike,
    private readonly embeddingModelId?: string,
    private readonly queryRouter?: QueryRouter,
    private readonly queryPlanBuilder?: QueryPlanBuilder,
  ) {
    const effectiveAuthorization = authorizationPolicy ?? new AuthorizationPolicy();
    this.visibilityPolicy = visibilityPolicy ?? new VisibilityPolicy(effectiveAuthorization);
    this.redactionPolicy = redactionPolicy ?? new RedactionPolicy();
    this.readRepo = this.coerceReadRepo(readRepo);
    this.edgeView = new GraphEdgeView(this.readRepo);
  }

  async explore(
    query: string,
    viewerContext: ViewerContext,
    optionsOrInput?: NavigatorOptions | MemoryExploreInput,
    strategy?: GraphRetrievalStrategy,
  ): Promise<NavigatorResult> {
    if (!viewerContext || !viewerContext.viewer_agent_id) {
      throw new Error("viewerContext is required");
    }
    this.privateNodeOwnerCache.clear();
    this.visibilityRecordCache.clear();

    const effectiveStrategy = strategy ?? GRAPH_RETRIEVAL_STRATEGIES.default_retrieval;
    const opts = this.normalizeOptions(this.asNavigatorOptions(optionsOrInput));
    const input = this.asExploreInput(query, optionsOrInput);
    const analysis = await this.analyzeQuery(query, viewerContext, input.mode);
    const planContext = await this.emitQueryRouteAndPlanShadow(query, viewerContext, input.mode, analysis.query_type);
    // GAP-4 §2: only consume the plan when the flag is on. Stage A
    // (edge/seed bias, time slice) and Stage B (primaryIntent +
    // secondaryIntents) both gate on `activePlan != null` downstream.
    // Flag default is OFF — flipping to ON is a separate rollout commit
    // gated on §10 production shadow data.
    const consumePlan = isNavigatorPlanConsumptionEnabled();
    const activePlan = consumePlan ? planContext.plan : null;

    let queryEmbedding: Float32Array | undefined;
    if (this.embedProvider && this.embeddingModelId) {
      const [embedding] = await this.embedProvider.embed([query], "query_expansion", this.embeddingModelId);
      queryEmbedding = embedding;
    }

    const rawSeeds = await this.retrieval.localizeSeedsHybrid(query, viewerContext, opts.seedCount, queryEmbedding, this.embeddingModelId);
    const supplementalSeeds = await this.collectSupplementalSeeds(query, viewerContext, rawSeeds);
    const mergedSeeds = this.mergeSeeds(rawSeeds, supplementalSeeds);
    const fallbackSeeds = this.fallbackSeedsFromAnalysis(mergedSeeds, analysis);
    const focusedSeeds = this.injectFocusSeed(fallbackSeeds, input.focusRef);
    const visibleSeedRefs = await this.filterVisibleNodeRefs(
      focusedSeeds.map((seed) => seed.node_ref),
      viewerContext,
    );
    const visibleSeeds = focusedSeeds.filter((seed) => visibleSeedRefs.has(seed.node_ref));

    if (visibleSeeds.length === 0) {
      return {
        query,
        query_type: analysis.query_type,
        summary: `No explain evidence found for '${query}'`,
        evidence_paths: [],
        drilldown: this.buildDrilldown(input, undefined, planContext, analysis.query_type),
      };
    }

    // GAP-4 §2 Stage B: resolve effective primary + secondary intents
    // from plan (when consumption flag is on) before threading them into
    // seed scoring, beam expansion, and reranking. When the flag is off
    // `effectivePrimary === analysis.query_type` and `effectiveSecondaries`
    // is `[]`, so the five call sites below are byte-equal to pre-Phase-4.
    const effectivePrimary = resolveEffectivePrimaryIntent(analysis, activePlan);
    const effectiveSecondaries = resolveEffectiveSecondaryIntents(activePlan);

    const seedScores = await this.computeSeedScores(visibleSeeds, analysis, activePlan, effectivePrimary);
    const expandedPaths = await this.expandTypedBeam(visibleSeeds, seedScores, effectivePrimary, viewerContext, opts, input, effectiveStrategy, activePlan, effectiveSecondaries);
    const rerankedPaths = await this.rerankPaths(expandedPaths, seedScores, effectivePrimary, opts.maxDepth, effectiveStrategy, activePlan, effectiveSecondaries);
    const effectiveMaxCandidates = input.detailLevel === "audit" ? rerankedPaths.length : opts.maxCandidates;
    const assembled = await this.assembleEvidence(rerankedPaths, viewerContext, effectiveMaxCandidates);
    // GAP-4 §2 Stage A: prefer plan.graphPlan.timeSlice over the legacy
    // input.asOf* time slice when present and the flag is on. Falls back
    // to `input` exactly as before when no plan or flag off.
    const planTimeSlice = activePlan?.graphPlan.timeSlice;
    const effectiveTimeSlice = planTimeSlice != null ? planTimeSlice : input;
    const sliced = filterEvidencePathsByTimeSlice(assembled, effectiveTimeSlice);
    const seedsByRef = new Map(visibleSeeds.map((s) => [s.node_ref, s]));
    const levelFiltered = this.applyDetailLevel(sliced, input.detailLevel, seedsByRef);
    const pathSummaries = hasTimeSlice(input) ? summarizeTimeSlicedPaths(assembled, input) : undefined;

    const result: NavigatorResult = {
      query,
      query_type: analysis.query_type,
      summary: this.summarizeResult(query, analysis.query_type, levelFiltered),
      drilldown: this.buildDrilldown(input, pathSummaries, planContext, analysis.query_type),
      evidence_paths: levelFiltered,
    };

    if (input.detailLevel === "audit") {
      result.audit_summary = this.buildAuditSummary(levelFiltered);
    }

    return result;
  }

  private asNavigatorOptions(optionsOrInput?: NavigatorOptions | MemoryExploreInput): NavigatorOptions | undefined {
    if (!optionsOrInput) {
      return undefined;
    }
    const maybeOptions = optionsOrInput as NavigatorOptions;
    const hasOptionKeys =
      maybeOptions.seedCount != null ||
      maybeOptions.beamWidth != null ||
      maybeOptions.maxDepth != null ||
      maybeOptions.maxCandidates != null;
    return hasOptionKeys ? maybeOptions : undefined;
  }

  private asExploreInput(query: string, optionsOrInput?: NavigatorOptions | MemoryExploreInput): MemoryExploreInput {
    const maybeInput = optionsOrInput as MemoryExploreInput | undefined;
    if (!maybeInput) {
      return { query };
    }
    if (maybeInput.query != null || maybeInput.mode != null || maybeInput.focusRef != null || maybeInput.focusCognitionKey != null || maybeInput.asOfValidTime != null || maybeInput.asOfCommittedTime != null || maybeInput.detailLevel != null) {
      return {
        query,
        mode: maybeInput.mode,
        focusRef: maybeInput.focusRef,
        focusCognitionKey: maybeInput.focusCognitionKey,
        asOfValidTime: maybeInput.asOfValidTime,
        asOfCommittedTime: maybeInput.asOfCommittedTime,
        detailLevel: maybeInput.detailLevel,
      };
    }
    return { query };
  }

  private normalizeOptions(options?: NavigatorOptions): Required<NavigatorOptions> {
    return {
      seedCount: Math.min(32, Math.max(1, options?.seedCount ?? DEFAULT_OPTIONS.seedCount)),
      beamWidth: Math.min(32, Math.max(1, options?.beamWidth ?? DEFAULT_OPTIONS.beamWidth)),
      maxDepth: Math.min(2, Math.max(1, options?.maxDepth ?? DEFAULT_OPTIONS.maxDepth)),
      maxCandidates: Math.min(64, Math.max(1, options?.maxCandidates ?? DEFAULT_OPTIONS.maxCandidates)),
    };
  }

  private async analyzeQuery(query: string, viewerContext: ViewerContext, mode?: ExploreMode): Promise<QueryAnalysis> {
    const normalized = query.trim().toLowerCase();
    const tokens = tokenizeQuery(query);

    const resolvedEntityIds = new Set<number>();
    const entityHints = new Set<string>();
    for (const token of tokens) {
      const aliasToken = token.startsWith("@") ? token.slice(1) : token;
      if (aliasToken.length < 2) {
        continue;
      }
      const entityId = await this.alias.resolveAlias(aliasToken, viewerContext.viewer_agent_id);
      if (entityId !== null) {
        resolvedEntityIds.add(entityId);
        entityHints.add(aliasToken);
      }
    }

    let queryType: QueryType = "event";
    if (mode) {
      queryType = mode;
    } else if (this.includesAny(normalized, WHY_KEYWORDS)) {
      queryType = "why";
    } else if (this.includesAny(normalized, CONFLICT_KEYWORDS)) {
      queryType = "conflict";
    } else if (this.includesAny(normalized, TIMELINE_KEYWORDS)) {
      queryType = "timeline";
    } else if (this.includesAny(normalized, RELATIONSHIP_KEYWORDS)) {
      queryType = "relationship";
    } else if (this.includesAny(normalized, STATE_KEYWORDS)) {
      queryType = "state";
    } else if (resolvedEntityIds.size > 0) {
      queryType = "entity";
    }

    return {
      normalized_query: normalized,
      query_type: queryType,
      resolved_entity_ids: resolvedEntityIds,
      entity_hints: Array.from(entityHints),
      has_time_constraint: this.includesAny(normalized, TIME_CONSTRAINT_KEYWORDS),
    };
  }

  private includesAny(haystack: string, needles: readonly string[]): boolean {
    return needles.some((needle) => haystack.includes(needle));
  }

  /**
   * Phase 1+2 shadow mode: invokes the optional QueryRouter and (if present)
   * the QueryPlanBuilder, emits two structured log lines for the §10
   * shadow parser:
   *   - "query_route_shadow" — Phase 1 router output
   *   - "query_plan_shadow"  — Phase 2 plan output (only if builder set)
   *
   * GAP-4 §2 Stage A: this method now ALSO returns the route + plan (via
   * an envelope object) so `explore()` can feed them into the navigator's
   * scoring path when `MAIDSCLAW_NAVIGATOR_USE_PLAN` is enabled. Failures
   * are still swallowed silently — the envelope's fields fall back to
   * `undefined` and the navigator runs the legacy path. The console.debug
   * shadow log channel is preserved as a side effect for §10 (the
   * drilldown-side fields populated in `explore()` are independent).
   */
  private async emitQueryRouteAndPlanShadow(
    query: string,
    viewerContext: ViewerContext,
    explicitMode: ExploreMode | undefined,
    legacyQueryType: QueryType,
  ): Promise<{ route: QueryRoute | null; plan: QueryPlan | null }> {
    if (!this.queryRouter) return { route: null, plan: null };
    let route: QueryRoute;
    try {
      route = await this.queryRouter.route({
        query,
        viewerAgentId: viewerContext.viewer_agent_id,
        explicitMode,
        currentAreaId: viewerContext.current_area_id ?? null,
      });
    } catch {
      return { route: null, plan: null };
    }
    try {
      const payload = {
        event: "query_route_shadow",
        classifier: route.classifierVersion,
        primary_intent: route.primaryIntent,
        legacy_query_type: legacyQueryType,
        agreed_with_legacy: route.primaryIntent === legacyQueryType,
        intents: route.intents.map((i) => ({
          type: i.type,
          confidence: Number(i.confidence.toFixed(3)),
          evidence_count: i.evidence.length,
        })),
        intent_count: route.intents.length,
        matched_rules: route.matchedRules,
        resolved_entity_count: route.resolvedEntityIds.length,
        time_signals: route.timeSignals,
        signals: route.signals,
        rationale: route.rationale,
      };
      logger.debug("query_route_shadow", payload);
    } catch {
      // never break execution on serialization errors
    }

    // Phase 2: emit plan shadow if builder is wired up.
    if (!this.queryPlanBuilder) return { route, plan: null };
    let plan: QueryPlan | null = null;
    try {
      plan = this.queryPlanBuilder.build({
        route,
        // ViewerRole and AgentRole share the same string union.
        role: viewerContext.viewer_role as unknown as Parameters<
          QueryPlanBuilder["build"]
        >[0]["role"],
      });
    } catch {
      return { route, plan: null };
    }
    try {
      const planPayload = {
        event: "query_plan_shadow",
        builder: plan.builderVersion,
        primary_intent: plan.graphPlan.primaryIntent,
        secondary_intents: plan.graphPlan.secondaryIntents,
        surface_weights: {
          narrative: Number(plan.surfacePlans.narrative.weight.toFixed(3)),
          cognition: Number(plan.surfacePlans.cognition.weight.toFixed(3)),
          episode: Number(plan.surfacePlans.episode.weight.toFixed(3)),
          conflict_notes: Number(plan.surfacePlans.conflictNotes.weight.toFixed(3)),
        },
        surface_enabled: {
          narrative: plan.surfacePlans.narrative.enabledByRole,
          cognition: plan.surfacePlans.cognition.enabledByRole,
          episode: plan.surfacePlans.episode.enabledByRole,
          conflict_notes: plan.surfacePlans.conflictNotes.enabledByRole,
        },
        cognition_kind: plan.surfacePlans.cognition.kind ?? null,
        cognition_stance: plan.surfacePlans.cognition.stance ?? null,
        seed_bias: plan.graphPlan.seedBias,
        edge_bias: plan.graphPlan.edgeBias,
        time_slice: plan.graphPlan.timeSlice,
        matched_rules: plan.matchedRules,
        rationale: plan.rationale,
      };
      logger.debug("query_plan_shadow", planPayload);
    } catch {
      // never break execution on serialization errors
    }

    return { route, plan };
  }

  /**
   * GAP-4 §6: assemble the drilldown payload from the explore inputs and
   * the (optional) router/plan shadow context. Always returns a
   * structured object so callers don't need to invent placeholder fields.
   */
  private buildDrilldown(
    input: MemoryExploreInput,
    pathSummaries:
      | (NavigatorResult["drilldown"] extends infer D
          ? D extends { time_sliced_paths?: infer P }
            ? P
            : never
          : never)
      | undefined,
    planContext: { route: QueryRoute | null; plan: QueryPlan | null },
    legacyQueryType: QueryType,
  ): NonNullable<NavigatorResult["drilldown"]> {
    const drilldown: NonNullable<NavigatorResult["drilldown"]> = {
      mode: input.mode,
      focus_ref: input.focusRef,
      focus_cognition_key: input.focusCognitionKey,
      as_of_valid_time: input.asOfValidTime,
      as_of_committed_time: input.asOfCommittedTime,
      time_sliced_paths: pathSummaries,
    };
    const route = planContext.route;
    if (route) {
      drilldown.query_route_shadow = {
        classifier_version: route.classifierVersion,
        primary_intent: route.primaryIntent,
        legacy_query_type: legacyQueryType,
        agreed_with_legacy: route.primaryIntent === legacyQueryType,
        intent_count: route.intents.length,
        matched_rules: route.matchedRules,
        resolved_entity_count: route.resolvedEntityIds.length,
        rationale: route.rationale,
      };
    }
    const plan = planContext.plan;
    if (plan) {
      drilldown.query_plan_shadow = {
        builder_version: plan.builderVersion,
        primary_intent: plan.graphPlan.primaryIntent,
        secondary_intents: plan.graphPlan.secondaryIntents,
        surface_weights: {
          narrative: Number(plan.surfacePlans.narrative.weight.toFixed(3)),
          cognition: Number(plan.surfacePlans.cognition.weight.toFixed(3)),
          episode: Number(plan.surfacePlans.episode.weight.toFixed(3)),
          conflict_notes: Number(plan.surfacePlans.conflictNotes.weight.toFixed(3)),
        },
        seed_bias: plan.graphPlan.seedBias as unknown as Record<string, number>,
        edge_bias: (plan.graphPlan.edgeBias ?? {}) as Record<string, number>,
        rationale: plan.rationale,
      };
    }
    return drilldown;
  }

  private injectFocusSeed(seeds: SeedCandidate[], focusRef?: NodeRef): SeedCandidate[] {
    if (!focusRef) {
      return seeds;
    }
    const hasFocus = seeds.some((seed) => seed.node_ref === focusRef);
    if (hasFocus) {
      return seeds;
    }
    const parsed = this.parseNodeRef(focusRef);
    if (!parsed) {
      return seeds;
    }
    return [
      {
        node_ref: focusRef,
        node_kind: parsed.kind,
        lexical_score: 0.98,
        semantic_score: 0,
        fused_score: 0.98,
        source_scope: "world",
      },
      ...seeds,
    ];
  }

  private fallbackSeedsFromAnalysis(seeds: SeedCandidate[], analysis: QueryAnalysis): SeedCandidate[] {
    if (seeds.length > 0) {
      return seeds;
    }

    if (analysis.resolved_entity_ids.size === 0) {
      return [];
    }

    const fallback: SeedCandidate[] = [];
    for (const id of analysis.resolved_entity_ids) {
      fallback.push({
        node_ref: `entity:${id}` as NodeRef,
        node_kind: "entity",
        lexical_score: 0.01,
        semantic_score: 0,
        fused_score: 0.01,
        source_scope: "world",
      });
    }
    return fallback;
  }

  private async collectSupplementalSeeds(
    query: string,
    viewerContext: ViewerContext,
    existingSeeds: SeedCandidate[],
  ): Promise<SeedCandidate[]> {
    const existingRefs = new Set(existingSeeds.map((s) => s.node_ref as string));
    const supplemental: SeedCandidate[] = [];

    if (this.narrativeSearch) {
      try {
        const hits = await this.narrativeSearch.searchNarrative(query, viewerContext);
        for (const hit of hits) {
          if (existingRefs.has(hit.source_ref)) continue;
          const parsed = this.parseNodeRef(hit.source_ref as NodeRef);
          if (!parsed) continue;
          existingRefs.add(hit.source_ref);
          supplemental.push({
            node_ref: hit.source_ref as NodeRef,
            node_kind: parsed.kind,
            lexical_score: 0.7,
            semantic_score: 0,
            fused_score: 0.7,
            source_scope: "world",
          });
        }
      } catch (err) {
        logger.debug("supplemental_narrative_search_unavailable", {
          event: "supplemental_narrative_search_unavailable",
          error: err instanceof Error ? err.message : String(err),
          query: query.slice(0, 100),
          agent_id: viewerContext.viewer_agent_id,
        });
      }
    }

    if (this.cognitionSearch) {
      try {
        const hits = await this.cognitionSearch.searchCognition({
          agentId: viewerContext.viewer_agent_id,
          query,
          activeOnly: true,
          limit: 10,
        });
        for (const hit of hits) {
          if (existingRefs.has(hit.source_ref)) continue;
          const parsed = this.parseNodeRef(hit.source_ref as NodeRef);
          if (!parsed) continue;
          existingRefs.add(hit.source_ref);
          supplemental.push({
            node_ref: hit.source_ref as NodeRef,
            node_kind: parsed.kind,
            lexical_score: 0.6,
            semantic_score: 0,
            fused_score: 0.6,
            source_scope: "private",
          });
        }
      } catch (err) {
        logger.debug("supplemental_cognition_search_unavailable", {
          event: "supplemental_cognition_search_unavailable",
          error: err instanceof Error ? err.message : String(err),
          query: query.slice(0, 100),
          agent_id: viewerContext.viewer_agent_id,
        });
      }
    }

    return supplemental;
  }

  private mergeSeeds(primary: SeedCandidate[], supplemental: SeedCandidate[]): SeedCandidate[] {
    if (supplemental.length === 0) return primary;
    const seen = new Set(primary.map((s) => s.node_ref as string));
    const merged = [...primary];
    for (const seed of supplemental) {
      if (!seen.has(seed.node_ref as string)) {
        seen.add(seed.node_ref as string);
        merged.push(seed);
      }
    }
    return merged;
  }

  private async computeSeedScores(
    seeds: SeedCandidate[],
    analysis: QueryAnalysis,
    plan: QueryPlan | null = null,
    effectivePrimary: QueryType = analysis.query_type,
  ): Promise<Map<NodeRef, number>> {
    const salienceByRef = await this.loadSalienceForRefs(seeds.map((seed) => seed.node_ref));
    const scores = new Map<NodeRef, number>();

    for (const seed of seeds) {
      const aliasBonus = this.isAliasMatchedSeed(seed, analysis) ? 1 : 0;
      const parsedSeed = this.parseNodeRef(seed.node_ref);
      // GAP-4 §2 Stage B: use effectivePrimary (plan-driven when flag on)
      // to look up the nodeTypePrior matrix. Default arg = analysis.query_type
      // preserves pre-Stage-B behavior for any direct/test caller.
      const baseNodeTypePrior = parsedSeed ? this.nodeTypePrior(effectivePrimary, parsedSeed.kind) : 0.2;
      // GAP-4 §2 Stage A: when a plan is supplied, multiply (not replace)
      // the hand-tuned `nodeTypePrior` matrix by `(1 + planBias)` for the
      // matching kind. Plan bias is sparse: only six kinds are listed
      // (entity/event/episode/assertion/evaluation/commitment); `fact` and
      // any other kind fall back to baseNodeTypePrior alone. The multiply
      // semantics let plan-driven scoring degrade gracefully when the plan
      // is wrong: a 0 bias falls back to the matrix exactly, a 1 bias
      // doubles it.
      const planBiasMap = plan?.graphPlan.seedBias as Record<string, number> | undefined;
      const planSeedBias = parsedSeed && planBiasMap ? (planBiasMap[parsedSeed.kind] ?? 0) : 0;
      const nodeTypePrior = baseNodeTypePrior * (1 + planSeedBias);
      const salience = salienceByRef.get(seed.node_ref) ?? 0;
      const seedScore =
        0.35 * seed.lexical_score +
        0.3 * seed.semantic_score +
        0.1 * aliasBonus +
        0.1 * nodeTypePrior +
        0.15 * salience;
      scores.set(seed.node_ref, this.clamp01(seedScore));
    }

    return scores;
  }

  private async loadSalienceForRefs(refs: NodeRef[]): Promise<Map<NodeRef, number>> {
    const unique = Array.from(new Set(refs));
    if (unique.length === 0) {
      return new Map();
    }

    const rows = await this.readRepo.getNodeSalience(unique);
    const map = new Map<NodeRef, number>();
    for (const row of rows) {
      map.set(row.nodeRef, this.clamp01(row.salience));
    }
    return map;
  }

  private isAliasMatchedSeed(seed: SeedCandidate, analysis: QueryAnalysis): boolean {
    if (seed.node_kind !== "entity") {
      return false;
    }
    const parsed = this.parseNodeRef(seed.node_ref);
    if (!parsed) {
      return false;
    }
    return analysis.resolved_entity_ids.has(parsed.id);
  }

  private nodeTypePrior(queryType: QueryType, nodeKind: NodeRefKind): number {
    const priors = {
      entity: { entity: 1, fact: 0.75, event: 0.4, assertion: 0.7, evaluation: 0.4, commitment: 0.4, episode: 0.35 },
      event: { event: 1, fact: 0.7, entity: 0.55, assertion: 0.45, evaluation: 0.8, commitment: 0.6, episode: 0.85 },
      why: { event: 1, fact: 0.85, entity: 0.5, assertion: 0.65, evaluation: 0.85, commitment: 0.75, episode: 0.8 },
      relationship: { entity: 1, fact: 0.9, event: 0.45, assertion: 0.7, evaluation: 0.45, commitment: 0.5, episode: 0.3 },
      timeline: { event: 1, fact: 0.5, entity: 0.3, assertion: 0.45, evaluation: 0.85, commitment: 0.7, episode: 0.9 },
      state: { fact: 1, entity: 0.85, event: 0.5, assertion: 0.8, evaluation: 0.5, commitment: 0.75, episode: 0.4 },
      conflict: { assertion: 1, fact: 0.9, event: 0.7, evaluation: 0.75, commitment: 0.6, entity: 0.6, episode: 0.65 },
    } satisfies Record<QueryType, Record<NodeRefKind, number>>;

    return (priors[queryType] as Record<string, number>)[nodeKind] ?? 0.2;
  }

  private async expandTypedBeam(
    seeds: SeedCandidate[],
    seedScores: Map<NodeRef, number>,
    queryType: QueryType,
    viewerContext: ViewerContext,
    options: Required<NavigatorOptions>,
    input: TimeSliceQuery,
    strategy: GraphRetrievalStrategy,
    plan: QueryPlan | null = null,
    secondaries: readonly QueryType[] = [],
  ): Promise<InternalBeamPath[]> {
    const effectiveBeamWidth = Math.min(32, Math.max(1, Math.ceil(options.beamWidth * strategy.beamWidthMultiplier)));
    const sortedSeeds = [...seeds].sort((a, b) => (seedScores.get(b.node_ref) ?? 0) - (seedScores.get(a.node_ref) ?? 0));
    let currentLayer: InternalBeamPath[] = sortedSeeds.slice(0, effectiveBeamWidth).map((seed) => ({
      seed,
      path: {
        seed: seed.node_ref,
        nodes: [seed.node_ref],
        edges: [],
        depth: 0,
      },
      internal_edges: [],
    }));

    const allPaths: InternalBeamPath[] = [...currentLayer];

    for (let depth = 1; depth <= options.maxDepth; depth += 1) {
      const frontier = this.groupFrontierByKind(currentLayer);
      const neighborMap = await this.fetchNeighborsByFrontier(frontier, viewerContext, input);

      const nextCandidates: InternalBeamPath[] = [];
      for (const pathItem of currentLayer) {
        const tail = pathItem.path.nodes[pathItem.path.nodes.length - 1];
        const neighbors = [...(neighborMap.get(tail) ?? [])];
        neighbors.sort((a, b) => this.compareNeighborEdges(a, b, queryType, strategy, plan, secondaries));

        for (const edge of neighbors) {
          if (pathItem.path.nodes.includes(edge.to)) {
            continue;
          }
          const nextPath: InternalBeamPath = {
            seed: pathItem.seed,
            path: {
              seed: pathItem.path.seed,
              nodes: [...pathItem.path.nodes, edge.to],
              edges: [...pathItem.path.edges, edge],
              depth,
            },
            internal_edges: [...pathItem.internal_edges, edge],
          };
          nextCandidates.push(nextPath);
        }
      }

      if (nextCandidates.length === 0) {
        break;
      }

      const unique = this.deduplicatePaths(nextCandidates);
      unique.sort((a, b) => this.preliminaryPathScore(b, seedScores, queryType, strategy, plan, secondaries) - this.preliminaryPathScore(a, seedScores, queryType, strategy, plan, secondaries));
      currentLayer = unique.slice(0, effectiveBeamWidth);
      allPaths.push(...currentLayer);
    }

    return allPaths;
  }

  private groupFrontierByKind(paths: InternalBeamPath[]): Map<NodeRefKind, Set<NodeRef>> {
    const grouped = new Map<NodeRefKind, Set<NodeRef>>();
    for (const path of paths) {
      const tail = path.path.nodes[path.path.nodes.length - 1];
      const parsed = this.parseNodeRef(tail);
      if (!parsed) {
        continue;
      }
      const set = grouped.get(parsed.kind) ?? new Set<NodeRef>();
      set.add(tail);
      grouped.set(parsed.kind, set);
    }
    return grouped;
  }

  private async fetchNeighborsByFrontier(
    frontier: Map<NodeRefKind, Set<NodeRef>>,
    viewerContext: ViewerContext,
    timeSlice: TimeSliceQuery,
  ): Promise<Map<NodeRef, InternalBeamEdge[]>> {
    const map = new Map<NodeRef, InternalBeamEdge[]>();

    await this.expandEventFrontier(frontier.get("event"), viewerContext, map, timeSlice);
    await this.expandEntityFrontier(frontier.get("entity"), viewerContext, map, timeSlice);
    await this.expandFactFrontier(frontier.get("fact"), viewerContext, map, timeSlice);
    const privateEventFrontier = new Set<NodeRef>([
      ...(frontier.get("evaluation") ?? []),
      ...(frontier.get("commitment") ?? []),
    ]);
    await this.expandPrivateEventFrontier(privateEventFrontier.size > 0 ? privateEventFrontier : undefined, viewerContext, map, timeSlice);

    const privateBeliefFrontier = new Set<NodeRef>([
      ...(frontier.get("assertion") ?? []),
    ]);
    await this.expandPrivateBeliefFrontier(privateBeliefFrontier.size > 0 ? privateBeliefFrontier : undefined, viewerContext, map, timeSlice);
    await this.expandRelationEdges(frontier, viewerContext, map, timeSlice);

    return map;
  }

  private async expandEventFrontier(
    frontier: Set<NodeRef> | undefined,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    timeSlice: TimeSliceQuery,
  ): Promise<void> {
    if (!frontier || frontier.size === 0) {
      return;
    }

    const eventRefs = Array.from(frontier);
    if (eventRefs.length === 0) {
      return;
    }

    const logicEdges = await this.edgeView.readLogicEdges(frontier, viewerContext, timeSlice);
    for (const edge of logicEdges) {
      this.pushEdge(map, edge.source_ref, {
        from: edge.source_ref,
        to: edge.target_ref,
        kind: edge.relation_type as NavigatorEdgeKind,
        layer: edge.layer,
        weight: edge.weight,
        timestamp: edge.timestamp,
        summary: edge.relation_type,
        canonical_fact_id: null,
        canonical_evidence: edge.truth_bearing,
      });
    }

    const stateSupportEdges = await this.edgeView.readStateFactEdges(frontier, viewerContext, timeSlice);
    for (const edge of stateSupportEdges) {
      const parsedFact = this.parseNodeRef(edge.target_ref);
      this.pushEdge(map, edge.source_ref, {
        from: edge.source_ref,
        to: edge.target_ref,
        kind: "fact_support",
        layer: edge.layer,
        weight: edge.weight,
        timestamp: edge.timestamp,
        summary: edge.relation_type,
        canonical_fact_id: parsedFact?.kind === "fact" ? parsedFact.id : null,
        canonical_evidence: true,
      });
    }

    const contexts = await this.readRepo.readEventParticipantContexts(eventRefs, viewerContext);
    const candidateEntityRefs = new Set<NodeRef>();
    for (const context of contexts) {
      for (const participantRef of context.participantEntityRefs) {
        candidateEntityRefs.add(participantRef);
      }
    }
    const visibleEntityRefs = await this.filterVisibleNodeRefs(Array.from(candidateEntityRefs), viewerContext);

    for (const context of contexts) {
      const srcRef = context.eventRef;
      for (const target of context.participantEntityRefs) {
        if (!visibleEntityRefs.has(target)) {
          continue;
        }
        this.pushEdge(map, srcRef, {
          from: srcRef,
          to: target,
          kind: "participant",
          weight: 0.85,
          timestamp: context.timestamp,
          summary: context.summary,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }
    }

    await this.expandSemanticEdges(frontier, viewerContext, map, timeSlice);
  }

  private async expandEntityFrontier(
    frontier: Set<NodeRef> | undefined,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    timeSlice: TimeSliceQuery,
  ): Promise<void> {
    if (!frontier || frontier.size === 0) {
      return;
    }

    const frontierRefs = Array.from(frontier);
    const ids = this.extractIdsFromRefs(frontier, "entity");
    if (ids.length === 0 || frontierRefs.length === 0) {
      return;
    }

    const factRows = await this.readRepo.readActiveFactsForEntityFrontier(frontierRefs);
    const factEntityCandidates: NodeRef[] = [];
    for (const row of factRows) {
      factEntityCandidates.push(row.sourceEntityRef, row.targetEntityRef);
    }
    const visibleFactEntities = await this.filterVisibleNodeRefs(factEntityCandidates, viewerContext);

    for (const row of factRows) {
      const sourceRef = row.sourceEntityRef;
      const targetRef = row.targetEntityRef;
      const parsedFact = this.parseNodeRef(row.factRef);
      const factId = parsedFact?.kind === "fact" ? parsedFact.id : null;

      if (frontier.has(sourceRef) && visibleFactEntities.has(targetRef)) {
        this.pushEdge(map, sourceRef, {
          from: sourceRef,
          to: targetRef,
          kind: "fact_relation",
          weight: 1,
          timestamp: row.validTime,
          summary: row.predicate,
          canonical_fact_id: factId,
          canonical_evidence: true,
        });
      }

      if (frontier.has(targetRef) && visibleFactEntities.has(sourceRef)) {
        this.pushEdge(map, targetRef, {
          from: targetRef,
          to: sourceRef,
          kind: "fact_relation",
          weight: 1,
          timestamp: row.validTime,
          summary: row.predicate,
          canonical_fact_id: factId,
          canonical_evidence: true,
        });
      }
    }

    const participantRows = await this.readRepo.readVisibleEventsForEntityFrontier(frontierRefs, viewerContext);
    for (const row of participantRows) {
      const eventRef = row.eventRef;
      for (const entityRef of row.participantEntityRefs) {
        if (!frontier.has(entityRef)) {
          continue;
        }
        this.pushEdge(map, entityRef, {
          from: entityRef,
          to: eventRef,
          kind: "participant",
          weight: 0.85,
          timestamp: row.timestamp,
          summary: row.summary,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }
    }

    const beliefRows = await this.readRepo.readAgentAssertionsLinkedToEntities(
      viewerContext.viewer_agent_id,
      frontierRefs,
    );
    const visibleBeliefs = await this.filterVisibleNodeRefs(
      beliefRows.map((row) => row.assertionRef),
      viewerContext,
    );

    for (const row of beliefRows) {
      const beliefRef = row.assertionRef;
      if (!visibleBeliefs.has(beliefRef)) {
        continue;
      }

      const sourceRef = row.sourceEntityRef;
      const targetRef = row.targetEntityRef;
      const summary = row.predicate ?? row.summary;

      if (sourceRef && frontier.has(sourceRef)) {
        this.pushEdge(map, sourceRef, {
          from: sourceRef,
          to: beliefRef,
          kind: "fact_relation",
          weight: 0.7,
          timestamp: row.updatedAt,
          summary,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }
      if (targetRef && frontier.has(targetRef)) {
        this.pushEdge(map, targetRef, {
          from: targetRef,
          to: beliefRef,
          kind: "fact_relation",
          weight: 0.7,
          timestamp: row.updatedAt,
          summary,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }
    }

    await this.expandSemanticEdges(frontier, viewerContext, map, timeSlice);
  }

  private async expandFactFrontier(
    frontier: Set<NodeRef> | undefined,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    timeSlice: TimeSliceQuery,
  ): Promise<void> {
    if (!frontier || frontier.size === 0) {
      return;
    }
    const factRefs = Array.from(frontier);
    if (factRefs.length === 0) {
      return;
    }

    const factRows = await this.readRepo.readActiveFactsForEntityFrontier(factRefs);
    const candidateRefs: NodeRef[] = [];
    for (const row of factRows) {
      candidateRefs.push(row.sourceEntityRef, row.targetEntityRef);
      if (row.sourceEventRef) {
        candidateRefs.push(row.sourceEventRef);
      }
    }
    const visibleRefs = await this.filterVisibleNodeRefs(candidateRefs, viewerContext);

    for (const row of factRows) {
      const factRef = row.factRef;
      const sourceRef = row.sourceEntityRef;
      const targetRef = row.targetEntityRef;
      const parsedFact = this.parseNodeRef(factRef);
      const factId = parsedFact?.kind === "fact" ? parsedFact.id : null;

      if (visibleRefs.has(sourceRef)) {
        this.pushEdge(map, factRef, {
          from: factRef,
          to: sourceRef,
          kind: "fact_relation",
          weight: 0.95,
          timestamp: row.validTime,
          summary: row.predicate,
          canonical_fact_id: factId,
          canonical_evidence: true,
        });
      }

      if (visibleRefs.has(targetRef)) {
        this.pushEdge(map, factRef, {
          from: factRef,
          to: targetRef,
          kind: "fact_relation",
          weight: 0.95,
          timestamp: row.validTime,
          summary: row.predicate,
          canonical_fact_id: factId,
          canonical_evidence: true,
        });
      }

      if (row.sourceEventRef && visibleRefs.has(row.sourceEventRef)) {
        this.pushEdge(map, factRef, {
          from: factRef,
          to: row.sourceEventRef,
          kind: "fact_support",
          weight: 0.9,
          timestamp: row.validTime,
          summary: row.predicate,
          canonical_fact_id: factId,
          canonical_evidence: true,
        });
      }
    }

    await this.expandSemanticEdges(frontier, viewerContext, map, timeSlice);
  }

  private async expandPrivateEventFrontier(
    frontier: Set<NodeRef> | undefined,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    timeSlice: TimeSliceQuery,
  ): Promise<void> {
    if (!frontier || frontier.size === 0) {
      return;
    }

    await this.expandSemanticEdges(frontier, viewerContext, map, timeSlice, true);
  }

  private async expandPrivateBeliefFrontier(
    frontier: Set<NodeRef> | undefined,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    timeSlice: TimeSliceQuery,
  ): Promise<void> {
    if (!frontier || frontier.size === 0) {
      return;
    }

    const idToRef = new Map<number, NodeRef>();
    for (const ref of frontier) {
      const parsed = this.parseNodeRef(ref);
      if (parsed) {
        idToRef.set(parsed.id, ref);
      }
    }
    if (idToRef.size === 0) {
      return;
    }

    const details = await this.readRepo.readAgentAssertionDetails(
      viewerContext.viewer_agent_id,
      Array.from(frontier),
      timeSlice.asOfCommittedTime,
    );

    const candidateRefs: NodeRef[] = [];
    for (const detail of details) {
      candidateRefs.push(detail.assertionRef);
      if (detail.sourceEntityRef) {
        candidateRefs.push(detail.sourceEntityRef);
      }
      if (detail.targetEntityRef) {
        candidateRefs.push(detail.targetEntityRef);
      }
      if (detail.sourceEventRef) {
        candidateRefs.push(detail.sourceEventRef);
      }
    }
    const visibleRefs = await this.filterVisibleNodeRefs(candidateRefs, viewerContext);

    for (const detail of details) {
      const beliefRef = detail.assertionRef;
      if (!visibleRefs.has(beliefRef)) {
        continue;
      }
      const parsedBelief = this.parseNodeRef(beliefRef);
      const beliefId = parsedBelief?.kind === "assertion" ? parsedBelief.id : null;
      const canonicalBeliefRef = beliefId != null ? (idToRef.get(beliefId) ?? beliefRef) : beliefRef;
      const summary = detail.predicate ?? detail.summary;

      const sourceRef = detail.sourceEntityRef;
      const targetRef = detail.targetEntityRef;

      if (sourceRef && visibleRefs.has(sourceRef)) {
        this.pushEdge(map, canonicalBeliefRef, {
          from: canonicalBeliefRef,
          to: sourceRef,
          kind: "fact_relation",
          weight: 0.75,
          timestamp: detail.updatedAt,
          summary,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }

      if (targetRef && visibleRefs.has(targetRef)) {
        this.pushEdge(map, canonicalBeliefRef, {
          from: canonicalBeliefRef,
          to: targetRef,
          kind: "fact_relation",
          weight: 0.75,
          timestamp: detail.updatedAt,
          summary,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }

      if (detail.sourceEventRef && visibleRefs.has(detail.sourceEventRef)) {
        this.pushEdge(map, canonicalBeliefRef, {
          from: canonicalBeliefRef,
          to: detail.sourceEventRef,
          kind: "fact_support",
          weight: 0.7,
          timestamp: detail.updatedAt,
          summary,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }
    }

    await this.expandSemanticEdges(frontier, viewerContext, map, timeSlice, true);
  }

  private async expandRelationEdges(
    frontier: Map<NodeRefKind, Set<NodeRef>>,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    timeSlice: TimeSliceQuery,
  ): Promise<void> {
    const allRefs: NodeRef[] = [];
    for (const refs of frontier.values()) {
      for (const ref of refs) allRefs.push(ref);
    }
    if (allRefs.length === 0) return;

    const edges = await this.edgeView.readMemoryRelations(new Set(allRefs), viewerContext, timeSlice);
    for (const edge of edges) {
      this.pushEdge(map, edge.source_ref, {
        from: edge.source_ref,
        to: edge.target_ref,
        kind: edge.relation_type as MemoryRelationType,
        layer: edge.layer,
        weight: edge.weight,
        timestamp: edge.timestamp,
        summary: edge.relation_type,
        canonical_fact_id: null,
        canonical_evidence: edge.truth_bearing,
      });
    }
  }

  private async expandSemanticEdges(
    frontier: Set<NodeRef>,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    timeSlice: TimeSliceQuery,
    privateFrontier = false,
  ): Promise<void> {
    const edges = await this.edgeView.readSemanticEdges(frontier, viewerContext, timeSlice);
    for (const edge of edges) {
      if (privateFrontier && !(await this.isSameAgentPrivateCompatibility(edge.source_ref, edge.target_ref, viewerContext.viewer_agent_id))) {
        continue;
      }
      this.pushEdge(map, edge.source_ref, {
        from: edge.source_ref,
        to: edge.target_ref,
        kind: edge.relation_type as NavigatorEdgeKind,
        layer: edge.layer,
        weight: this.clamp01(edge.weight),
        timestamp: edge.timestamp,
        summary: edge.relation_type,
        canonical_fact_id: null,
        canonical_evidence: false,
      });
    }
  }

  private async isSameAgentPrivateCompatibility(from: NodeRef, to: NodeRef, viewerAgentId: string): Promise<boolean> {
    const fromKind = this.parseNodeRef(from)?.kind;
    const toKind = this.parseNodeRef(to)?.kind;
    const fromPrivate = fromKind === "assertion" || fromKind === "evaluation" || fromKind === "commitment" || fromKind === "episode";
    const toPrivate = toKind === "assertion" || toKind === "evaluation" || toKind === "commitment" || toKind === "episode";

    if (!fromPrivate && !toPrivate) {
      return true;
    }

    if (fromPrivate && (await this.getPrivateNodeAgentId(from)) !== viewerAgentId) {
      return false;
    }
    if (toPrivate && (await this.getPrivateNodeAgentId(to)) !== viewerAgentId) {
      return false;
    }

    if (fromPrivate && toPrivate) {
      return (await this.getPrivateNodeAgentId(from)) === (await this.getPrivateNodeAgentId(to));
    }

    return true;
  }

  private async getPrivateNodeAgentId(nodeRef: NodeRef): Promise<string | null> {
    const cached = this.privateNodeOwnerCache.get(nodeRef);
    if (cached !== undefined) {
      return cached;
    }
    const parsed = this.parseNodeRef(nodeRef);
    if (!parsed) {
      this.privateNodeOwnerCache.set(nodeRef, null);
      return null;
    }
    if (parsed.kind === "assertion" || parsed.kind === "evaluation" || parsed.kind === "commitment" || parsed.kind === "episode") {
      const owners = await this.readRepo.getPrivateNodeOwners([nodeRef]);
      const owner = owners[0]?.agentId ?? null;
      this.privateNodeOwnerCache.set(nodeRef, owner);
      return owner;
    }
    this.privateNodeOwnerCache.set(nodeRef, null);
    return null;
  }

  private compareNeighborEdges(
    a: InternalBeamEdge,
    b: InternalBeamEdge,
    queryType: QueryType,
    strategy?: GraphRetrievalStrategy,
    plan: QueryPlan | null = null,
    secondaries: readonly QueryType[] = [],
  ): number {
    const scoreA = this.edgePriorityScore(a.kind, queryType, secondaries);
    const scoreB = this.edgePriorityScore(b.kind, queryType, secondaries);
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    // GAP-4 §2 Stage A: edge multiplier folds plan.graphPlan.edgeBias on
    // top of strategy.edgeWeights when plan consumption is enabled.
    const weightA = a.weight * effectiveEdgeMultiplier(a.kind, strategy, plan);
    const weightB = b.weight * effectiveEdgeMultiplier(b.kind, strategy, plan);
    if (weightA !== weightB) {
      return weightB - weightA;
    }
    return (b.timestamp ?? 0) - (a.timestamp ?? 0);
  }


  private edgePriorityScore(
    kind: NavigatorEdgeKind | MemoryRelationType,
    queryType: QueryType,
    secondaries: readonly QueryType[] = [],
  ): number {
    // GAP-4 §2 Stage B: when plan-driven secondary intents are present,
    // extend the priority list with each secondary's edge kinds (dedup).
    // When secondaries is empty (flag off OR no plan OR no secondaries),
    // use the original single-intent priority list — byte-equal to
    // pre-Stage-B behavior.
    const ordered = secondaries.length === 0
      ? QUERY_TYPE_PRIORITY[queryType]
      : mergedEdgePriority(queryType, secondaries);
    const index = (ordered as readonly string[]).indexOf(kind);
    if (index !== -1) {
      // Normalization side effect (documented for future readers):
      // when secondaries extend `ordered` from e.g. 4 → 8 kinds, the
      // primary-head kind at index 0 still scores 1.0, but primary
      // MID/TAIL kinds RISE (not fall) because the denominator grows.
      // E.g. why's `temporal_prev` at index 3 goes 1 - 3/4 = 0.25
      // (primary only) to 1 - 3/6 = 0.5 (with a timeline secondary).
      // This is the intended Stage B effect: secondary intents raise
      // all primary kinds' floors slightly so paths that would have
      // fallen off the beam gain another chance. The trade-off is that
      // secondary-appended kinds land around 0.5, above the 0.3
      // MEMORY_RELATION_TYPES floor but below the primary head —
      // which is exactly the "promoted over unknowns, capped below
      // primary head" semantics the doc calls for.
      return 1 - index / Math.max(ordered.length, 1);
    }
    // Memory relation edges get a non-floor base score (0.3) rather than the default 0.1
    if ((MEMORY_RELATION_TYPES as readonly string[]).includes(kind)) {
      return 0.3;
    }
    return 0.1;
  }

  private preliminaryPathScore(
    path: InternalBeamPath,
    seedScores: Map<NodeRef, number>,
    queryType: QueryType,
    strategy?: GraphRetrievalStrategy,
    plan: QueryPlan | null = null,
    secondaries: readonly QueryType[] = [],
  ): number {
    const seed = seedScores.get(path.path.seed) ?? 0;
    const edgeScore = path.internal_edges.length === 0
      ? 0
      : path.internal_edges.reduce((acc, edge) => {
          const base = this.edgePriorityScore(edge.kind, queryType, secondaries);
          const multiplier = effectiveEdgeMultiplier(edge.kind, strategy, plan);
          return acc + base * multiplier;
        }, 0) / path.internal_edges.length;
    const hopPenalty = path.path.depth / 2;
    return 0.55 * seed + 0.45 * edgeScore - 0.1 * hopPenalty;
  }

  private deduplicatePaths(paths: InternalBeamPath[]): InternalBeamPath[] {
    const bySignature = new Map<string, InternalBeamPath>();
    for (const path of paths) {
      const signature = `${path.path.seed}|${path.path.nodes.join(">")}`;
      if (!bySignature.has(signature)) {
        bySignature.set(signature, path);
      }
    }
    return Array.from(bySignature.values());
  }

  private async rerankPaths(
    paths: InternalBeamPath[],
    seedScores: Map<NodeRef, number>,
    queryType: QueryType,
    maxDepth: number,
    strategy?: GraphRetrievalStrategy,
    plan: QueryPlan | null = null,
    secondaries: readonly QueryType[] = [],
  ): Promise<Array<{ path: InternalBeamPath; score: PathScore }>> {
    const snapshots = await this.loadNodeSnapshots(paths.flatMap((p) => p.path.nodes));

    const scored = paths.map((path) => {
      const seedScore = seedScores.get(path.path.seed) ?? 0;
      const edgeTypeScore = this.average(path.internal_edges.map((edge) => {
        const base = this.edgePriorityScore(edge.kind, queryType, secondaries);
        const multiplier = effectiveEdgeMultiplier(edge.kind, strategy, plan);
        return base * multiplier;
      }));
      const temporalConsistency = this.calculateTemporalConsistency(path.internal_edges);
      const queryIntentMatch = this.calculateQueryIntentMatch(path.internal_edges, queryType, secondaries);
      const supportScore = this.calculateSupportScore(path);
      const recencyScore = this.calculateRecencyScore(path, snapshots);
      const hopPenalty = path.path.depth / Math.max(1, maxDepth);
      const redundancyPenalty = this.calculateRedundancyPenalty(path.path.nodes);

      const finalScore =
        0.3 * seedScore +
        0.25 * edgeTypeScore +
        0.15 * temporalConsistency +
        0.1 * queryIntentMatch +
        0.1 * supportScore +
        0.1 * recencyScore -
        0.1 * hopPenalty -
        0.1 * redundancyPenalty;

      const score: PathScore = {
        seed_score: this.clamp01(seedScore),
        edge_type_score: this.clamp01(edgeTypeScore),
        temporal_consistency: this.clamp01(temporalConsistency),
        query_intent_match: this.clamp01(queryIntentMatch),
        support_score: this.clamp01(supportScore),
        recency_score: this.clamp01(recencyScore),
        hop_penalty: this.clamp01(hopPenalty),
        redundancy_penalty: this.clamp01(redundancyPenalty),
        path_score: finalScore,
      };

      return { path, score };
    });

    scored.sort((a, b) => b.score.path_score - a.score.path_score);
    return scored;
  }

  private async loadNodeSnapshots(refs: NodeRef[]): Promise<Map<NodeRef, NodeSnapshot>> {
    const unique = Array.from(new Set(refs));
    const rows = await this.readRepo.getNodeSnapshots(unique);
    const map = new Map<NodeRef, NodeSnapshot>();
    for (const row of rows) {
      map.set(row.nodeRef, {
        summary: row.summary,
        timestamp: row.timestamp,
      });
    }
    return map;
  }

  private calculateTemporalConsistency(edges: InternalBeamEdge[]): number {
    const times = edges.map((edge) => edge.timestamp).filter((timestamp): timestamp is number => timestamp !== null);
    if (times.length <= 1) {
      return 1;
    }

    let nonDecreasing = 0;
    for (let index = 1; index < times.length; index += 1) {
      if (times[index] >= times[index - 1]) {
        nonDecreasing += 1;
      }
    }
    return nonDecreasing / (times.length - 1);
  }

  private calculateQueryIntentMatch(
    edges: InternalBeamEdge[],
    queryType: QueryType,
    secondaries: readonly QueryType[] = [],
  ): number {
    if (edges.length === 0) {
      return 0.4;
    }
    // GAP-4 §2 Stage B: when secondaries are present, widen the "top
    // kinds" window proportionally so secondary intents actually
    // influence the match score. Without widening, `mergedEdgePriority`
    // always places primary kinds first, so `slice(0, 2)` would never
    // see a secondary kind and the score would be primary-only —
    // contradicting the doc's "secondaryIntents 为 beam expansion 提供额外
    // 的边类型优先级" requirement. The widening is +1 top kind per
    // secondary intent, capped at 4 so a large secondary list can't
    // reduce the signal to a meaningless "any match counts" floor.
    const orderedForIntents = secondaries.length === 0
      ? QUERY_TYPE_PRIORITY[queryType]
      : mergedEdgePriority(queryType, secondaries);
    const sliceWidth = Math.min(2 + secondaries.length, 4);
    const topKinds = new Set<NavigatorEdgeKind | MemoryRelationType>(
      (orderedForIntents as readonly (NavigatorEdgeKind | MemoryRelationType)[]).slice(0, sliceWidth),
    );
    const matched = edges.filter((edge) => topKinds.has(edge.kind)).length;
    return matched / edges.length;
  }

  private calculateSupportScore(path: InternalBeamPath): number {
    const corroborating = new Set<string>();
    for (const edge of path.internal_edges) {
      if (edge.kind === "semantic_similar" || edge.kind === "entity_bridge" || edge.kind === "conflict_or_update") {
        continue;
      }

      if (edge.kind === "fact_support" && edge.canonical_evidence) {
        corroborating.add(`fact_support:${edge.from}->${edge.to}`);
      }

      if (edge.canonical_fact_id !== null) {
        corroborating.add(`fact:${edge.canonical_fact_id}`);
      }

      if (
        edge.kind === "causal" ||
        edge.kind === "temporal_prev" ||
        edge.kind === "temporal_next" ||
        edge.kind === "same_episode"
      ) {
        corroborating.add(`logic:${edge.from}->${edge.to}:${edge.kind}`);
      }
    }

    return Math.min(1, corroborating.size / 3);
  }

  private calculateRecencyScore(path: InternalBeamPath, snapshots: Map<NodeRef, NodeSnapshot>): number {
    const latest = path.path.nodes
      .map((node) => snapshots.get(node)?.timestamp ?? null)
      .filter((timestamp): timestamp is number => timestamp !== null)
      .sort((a, b) => b - a)[0];

    if (!latest) {
      return 0.5;
    }

    const ageMs = Math.max(0, Date.now() - latest);
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return this.clamp01(1 / (1 + ageDays / 7));
  }

  private calculateRedundancyPenalty(nodes: NodeRef[]): number {
    const unique = new Set(nodes);
    if (nodes.length <= 1) {
      return 0;
    }
    return 1 - unique.size / nodes.length;
  }

  private average(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  private async assembleEvidence(
    scored: Array<{ path: InternalBeamPath; score: PathScore }>,
    viewerContext: ViewerContext,
    maxCandidates: number,
  ): Promise<EvidencePath[]> {
    const result: EvidencePath[] = [];
    for (const candidate of scored) {
      if (result.length >= maxCandidates) {
        break;
      }

      const evidence: EvidencePath = {
        path: candidate.path.path,
        score: candidate.score,
        supporting_nodes: this.collectSupportingNodes(candidate.path.path),
        supporting_facts: this.collectSupportingFacts(candidate.path.internal_edges),
      };

      const safe = await this.applyPostFilterSafetyNet(evidence, viewerContext);
      if (safe) {
        result.push(safe);
      }
    }
    return result;
  }

  private applyDetailLevel(paths: EvidencePath[], detailLevel?: ExplainDetailLevel, seedsByRef?: Map<NodeRef, SeedCandidate>): EvidencePath[] {
    if (!detailLevel || detailLevel === "standard") {
      return paths;
    }
    if (detailLevel === "concise") {
      return paths.slice(0, 3);
    }
    if (detailLevel === "audit") {
      return paths.map((p) => this.enrichWithProvenance(p, seedsByRef));
    }
    return paths;
  }

  private enrichWithProvenance(evidencePath: EvidencePath, seedsByRef?: Map<NodeRef, SeedCandidate>): EvidencePath {
    const seed = seedsByRef?.get(evidencePath.path.seed);
    const sourceSurface = seed?.source_scope ?? "unknown";

    const edgeTimestamps = evidencePath.path.edges
      .map((e) => e.timestamp)
      .filter((t): t is number => t !== null);
    const committedTime = edgeTimestamps.length > 0 ? Math.max(...edgeTimestamps) : null;

    const confidenceScore = this.clamp01(evidencePath.score.path_score);

    const conflictRefs: NodeRef[] = [];
    for (const edge of evidencePath.path.edges) {
      if (edge.kind === "conflict_or_update") {
        conflictRefs.push(edge.from, edge.to);
      }
    }
    const uniqueConflictRefs = Array.from(new Set(conflictRefs));

    const edgeLayers = Array.from(new Set(
      evidencePath.path.edges
        .map((e) => e.layer)
        .filter((l): l is EdgeLayer => l !== undefined),
    ));

    const provenance: AuditProvenance = {
      source_surface: sourceSurface,
      committed_time: committedTime,
      confidence_score: confidenceScore,
      conflict_refs: uniqueConflictRefs,
      edge_layers: edgeLayers,
    };

    return { ...evidencePath, provenance };
  }

  private buildAuditSummary(paths: EvidencePath[]): NavigatorResult["audit_summary"] {
    const surfaces = new Set<string>();
    let earliest: number | null = null;
    let latest: number | null = null;
    let conflictCount = 0;

    for (const p of paths) {
      if (p.provenance) {
        surfaces.add(p.provenance.source_surface);
        if (p.provenance.committed_time !== null) {
          if (earliest === null || p.provenance.committed_time < earliest) {
            earliest = p.provenance.committed_time;
          }
          if (latest === null || p.provenance.committed_time > latest) {
            latest = p.provenance.committed_time;
          }
        }
        conflictCount += p.provenance.conflict_refs.length > 0 ? 1 : 0;
      }
    }

    return {
      total_paths: paths.length,
      surfaces_used: Array.from(surfaces),
      earliest_committed_time: earliest,
      latest_committed_time: latest,
      conflict_count: conflictCount,
    };
  }

  private collectSupportingNodes(path: BeamPath): NodeRef[] {
    return Array.from(new Set(path.nodes.filter((node) => node !== path.seed)));
  }

  private collectSupportingFacts(edges: InternalBeamEdge[]): number[] {
    const facts = new Set<number>();
    for (const edge of edges) {
      if (edge.canonical_fact_id !== null) {
        facts.add(edge.canonical_fact_id);
      }
    }
    return Array.from(facts).sort((a, b) => a - b);
  }

  private applyPostFilterSafetyNet(evidencePath: EvidencePath, viewerContext: ViewerContext): Promise<EvidencePath | null> {
    return this.applyPostFilterSafetyNetAsync(evidencePath, viewerContext);
  }

  private async applyPostFilterSafetyNetAsync(evidencePath: EvidencePath, viewerContext: ViewerContext): Promise<EvidencePath | null> {
    const visibleNodes: NodeRef[] = [];
    const redactedPlaceholders: RedactedPlaceholder[] = [];
    await this.primeVisibilityRecords(evidencePath.path.nodes);
    for (const node of evidencePath.path.nodes) {
      const disposition = await this.getNodeDisposition(node, viewerContext);
      if (disposition === "visible") {
        visibleNodes.push(node);
      } else {
        redactedPlaceholders.push(this.redactionPolicy.toPlaceholder(node, disposition));
      }
    }

    if (visibleNodes.length === 0) {
      return null;
    }

    const visibleSet = new Set<NodeRef>(visibleNodes);
    const filteredEdges = evidencePath.path.edges.filter(
      (edge) => visibleSet.has(edge.from) && visibleSet.has(edge.to),
    );
    const filteredSupportingNodes = evidencePath.supporting_nodes.filter((node) => visibleSet.has(node));

    const filtered: EvidencePath = {
      path: {
        seed: visibleSet.has(evidencePath.path.seed) ? evidencePath.path.seed : visibleNodes[0],
        nodes: visibleNodes,
        edges: filteredEdges,
        depth: Math.min(evidencePath.path.depth, filteredEdges.length),
      },
      score: evidencePath.score,
      supporting_nodes: filteredSupportingNodes,
      supporting_facts: evidencePath.supporting_facts,
      ...(redactedPlaceholders.length > 0 ? { redacted_placeholders: redactedPlaceholders } : {}),
    };

    filtered.summary = this.summarizeEvidencePath(filtered);

    if (filtered.path.nodes.length === 0) {
      return null;
    }
    return filtered;
  }

  private async filterVisibleNodeRefs(nodeRefs: NodeRef[], viewerContext: ViewerContext): Promise<Set<NodeRef>> {
    const unique = Array.from(new Set(nodeRefs));
    await this.primeVisibilityRecords(unique);
    const visible = new Set<NodeRef>();
    for (const nodeRef of unique) {
      const disposition = await this.getNodeDisposition(nodeRef, viewerContext);
      if (disposition === "visible") {
        visible.add(nodeRef);
      }
    }
    return visible;
  }

  private async getNodeDisposition(nodeRef: NodeRef, viewerContext: ViewerContext): Promise<VisibilityDisposition> {
    await this.primeVisibilityRecords([nodeRef]);
    const record = this.visibilityRecordCache.get(nodeRef) ?? null;
    if (!record) {
      return "hidden";
    }
    const nodeData = this.toVisibilityNodeData(record);
    if (!nodeData) {
      return "hidden";
    }
    return this.visibilityPolicy.getNodeDisposition(viewerContext, nodeRef, nodeData);
  }

  private async primeVisibilityRecords(nodeRefs: NodeRef[]): Promise<void> {
    const missing = nodeRefs.filter((nodeRef) => !this.visibilityRecordCache.has(nodeRef));
    if (missing.length === 0) {
      return;
    }
    const rows = await this.readRepo.getNodeVisibility(missing);
    const byRef = new Map(rows.map((row) => [row.nodeRef, row] as const));
    for (const nodeRef of missing) {
      this.visibilityRecordCache.set(nodeRef, byRef.get(nodeRef) ?? null);
    }
  }

  private toVisibilityNodeData(record: GraphNodeVisibilityRecord): Record<string, unknown> | null {
    if (record.kind === "entity") {
      return {
        memory_scope: record.memoryScope,
        owner_agent_id: record.ownerAgentId,
      };
    }
    if (record.kind === "event") {
      return {
        visibility_scope: record.visibilityScope,
        location_entity_id: record.locationEntityId,
        owner_agent_id: record.ownerAgentId,
      };
    }
    if (record.kind === "assertion" || record.kind === "evaluation" || record.kind === "commitment") {
      return { agent_id: record.agentId };
    }
    if (record.kind === "episode") {
      return { agent_id: record.ownerAgentId };
    }
    if (record.kind === "fact") {
      return record.active ? { id: 1 } : null;
    }
    return null;
  }

  private summarizeEvidencePath(path: EvidencePath): string {
    const stepCount = path.path.nodes.length;
    const redactedCount = path.redacted_placeholders?.length ?? 0;
    const facts = path.supporting_facts.length;
    const confidence = Number.isFinite(path.score.path_score) ? path.score.path_score.toFixed(2) : "0.00";
    return `${stepCount} visible step${stepCount === 1 ? "" : "s"}, ${facts} supporting fact${facts === 1 ? "" : "s"}, score ${confidence}${redactedCount > 0 ? `, ${redactedCount} redacted` : ""}`;
  }

  private summarizeResult(query: string, queryType: QueryType, evidencePaths: EvidencePath[]): string {
    if (evidencePaths.length === 0) {
      return `No explain evidence found for '${query}'`;
    }
    const redacted = evidencePaths.reduce((count, path) => count + (path.redacted_placeholders?.length ?? 0), 0);
    return `Explain ${queryType}: ${evidencePaths.length} evidence path${evidencePaths.length === 1 ? "" : "s"}${redacted > 0 ? ` (${redacted} redacted placeholder${redacted === 1 ? "" : "s"})` : ""}`;
  }

  private pushEdge(
    map: Map<NodeRef, InternalBeamEdge[]>,
    from: NodeRef,
    edge: Omit<InternalBeamEdge, "layer"> & { layer?: InternalBeamEdge["layer"] },
  ): void {
    const list = map.get(from) ?? [];
    list.push({
      ...edge,
      layer: edge.layer ?? this.inferEdgeLayer(edge.kind),
    });
    map.set(from, list);
  }

  private inferEdgeLayer(kind: NavigatorEdgeKind | MemoryRelationType): InternalBeamEdge["layer"] {
    if (kind === "semantic_similar" || kind === "entity_bridge" || kind === "conflict_or_update") {
      return "heuristic";
    }
    if (kind === "causal" || kind === "temporal_prev" || kind === "temporal_next" || kind === "same_episode") {
      return "symbolic";
    }
    return "state";
  }

  private parseNodeRef(ref: NodeRef): { kind: NodeRefKind; id: number } | null {
    try {
      const parsed = parseGraphNodeRef(String(ref));
      const kind = parsed.kind as NodeRefKind;
      if (!KNOWN_NODE_KINDS.has(kind)) {
        return null;
      }
      const id = Number(parsed.id);
      if (!Number.isInteger(id) || id <= 0) {
        return null;
      }
      return { kind, id };
    } catch {
      return null;
    }
  }

  private extractIdsFromRefs(refs: Set<NodeRef>, kind: NodeRefKind): number[] {
    const ids: number[] = [];
    for (const ref of refs) {
      const parsed = this.parseNodeRef(ref);
      if (parsed && parsed.kind === kind) {
        ids.push(parsed.id);
      }
    }
    return ids;
  }

  private clamp01(value: number): number {
    if (value < 0) {
      return 0;
    }
    if (value > 1) {
      return 1;
    }
    return value;
  }

  private coerceReadRepo(readRepo: GraphReadQueryRepo): GraphReadQueryRepo {
    return readRepo;
  }
}
