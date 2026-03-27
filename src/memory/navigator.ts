import type { Database } from "bun:sqlite";
import type { AliasService } from "./alias.js";
import { parseGraphNodeRef } from "./contracts/graph-node-ref.js";
import type { RetrievalService } from "./retrieval.js";
import { MAX_INTEGER } from "./schema.js";
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
  type BeamEdge,
  type BeamPath,
  type EvidencePath,
  type ExplainDetailLevel,
  type ExploreMode,
  type MemoryExploreInput,
  type MemoryRelationType,
  type NavigatorEdgeKind,
  type NavigatorResult,
  type EventNode,
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

const WHY_KEYWORDS = ["why", "because", "reason", "cause"];
const TIMELINE_KEYWORDS = ["when", "timeline", "before", "after", "sequence"];
const RELATIONSHIP_KEYWORDS = ["relationship", "between", "connected", "related"];
const STATE_KEYWORDS = ["state", "status", "current", "now", "is"];
const CONFLICT_KEYWORDS = ["conflict", "contradict", "dispute", "contested", "inconsistent"];
const TIME_CONSTRAINT_KEYWORDS = [
  "yesterday",
  "today",
  "last week",
  "last month",
  "earlier",
  "recent",
  "recently",
  "ago",
  "before",
  "after",
];

const KNOWN_NODE_KINDS = new Set<NodeRefKind>([
  "event",
  "entity",
  "fact",
  "assertion",
  "evaluation",
  "commitment",
]);

export class GraphNavigator {
  private readonly visibilityPolicy: VisibilityPolicy;
  private readonly redactionPolicy: RedactionPolicy;
  private readonly edgeView: GraphEdgeView;

  constructor(
    private readonly db: Database,
    private readonly retrieval: RetrievalService,
    private readonly alias: AliasService,
    _modelProvider?: ModelProviderClientLike,
    private readonly narrativeSearch?: NarrativeSearchServiceLike,
    private readonly cognitionSearch?: CognitionSearchServiceLike,
    visibilityPolicy?: VisibilityPolicy,
    redactionPolicy?: RedactionPolicy,
    authorizationPolicy?: AuthorizationPolicy,
  ) {
    const effectiveAuthorization = authorizationPolicy ?? new AuthorizationPolicy();
    this.visibilityPolicy = visibilityPolicy ?? new VisibilityPolicy(effectiveAuthorization);
    this.redactionPolicy = redactionPolicy ?? new RedactionPolicy();
    this.edgeView = new GraphEdgeView(this.db, this.visibilityPolicy);
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

    const effectiveStrategy = strategy ?? GRAPH_RETRIEVAL_STRATEGIES.default_retrieval;
    const opts = this.normalizeOptions(this.asNavigatorOptions(optionsOrInput));
    const input = this.asExploreInput(query, optionsOrInput);
    const analysis = this.analyzeQuery(query, viewerContext, input.mode);

    const rawSeeds = await this.retrieval.localizeSeedsHybrid(query, viewerContext, opts.seedCount);
    const supplementalSeeds = await this.collectSupplementalSeeds(query, viewerContext, rawSeeds);
    const mergedSeeds = this.mergeSeeds(rawSeeds, supplementalSeeds);
    const fallbackSeeds = this.fallbackSeedsFromAnalysis(mergedSeeds, analysis);
    const focusedSeeds = this.injectFocusSeed(fallbackSeeds, input.focusRef);
    const visibleSeeds = focusedSeeds.filter((seed) => this.isNodeVisible(seed.node_ref, viewerContext));

    if (visibleSeeds.length === 0) {
      return {
        query,
        query_type: analysis.query_type,
        summary: `No explain evidence found for '${query}'`,
        evidence_paths: [],
      };
    }

    const seedScores = this.computeSeedScores(visibleSeeds, analysis);
    const expandedPaths = this.expandTypedBeam(visibleSeeds, seedScores, analysis.query_type, viewerContext, opts, input, effectiveStrategy);
    const rerankedPaths = this.rerankPaths(expandedPaths, seedScores, analysis.query_type, opts.maxDepth, effectiveStrategy);
    const effectiveMaxCandidates = input.detailLevel === "audit" ? rerankedPaths.length : opts.maxCandidates;
    const assembled = this.assembleEvidence(rerankedPaths, viewerContext, effectiveMaxCandidates);
    const sliced = filterEvidencePathsByTimeSlice(assembled, input);
    const levelFiltered = this.applyDetailLevel(sliced, input.detailLevel);
    const pathSummaries = hasTimeSlice(input) ? summarizeTimeSlicedPaths(assembled, input) : undefined;

    return {
      query,
      query_type: analysis.query_type,
      summary: this.summarizeResult(query, analysis.query_type, levelFiltered),
      drilldown: {
        mode: input.mode,
        focus_ref: input.focusRef,
        "focus_cognition_key": input.focusCognitionKey,
        as_of_valid_time: input.asOfValidTime,
        as_of_committed_time: input.asOfCommittedTime,
        time_sliced_paths: pathSummaries,
      },
      evidence_paths: levelFiltered,
    };
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

  private analyzeQuery(query: string, viewerContext: ViewerContext, mode?: ExploreMode): QueryAnalysis {
    const normalized = query.trim().toLowerCase();
    const tokens = query
      .split(/[^a-zA-Z0-9_@:-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1);

    const resolvedEntityIds = new Set<number>();
    const entityHints = new Set<string>();
    for (const token of tokens) {
      const aliasToken = token.startsWith("@") ? token.slice(1) : token;
      if (aliasToken.length < 2) {
        continue;
      }
      const entityId = this.alias.resolveAlias(aliasToken, viewerContext.viewer_agent_id);
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
        console.debug("[navigator] supplemental narrative search unavailable", {
          error: err instanceof Error ? err.message : String(err),
          query: query.slice(0, 100),
          agentId: viewerContext.viewer_agent_id,
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
        console.debug("[navigator] supplemental cognition search unavailable", {
          error: err instanceof Error ? err.message : String(err),
          query: query.slice(0, 100),
          agentId: viewerContext.viewer_agent_id,
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

  private computeSeedScores(seeds: SeedCandidate[], analysis: QueryAnalysis): Map<NodeRef, number> {
    const salienceByRef = this.loadSalienceForRefs(seeds.map((seed) => seed.node_ref));
    const scores = new Map<NodeRef, number>();

    for (const seed of seeds) {
      const aliasBonus = this.isAliasMatchedSeed(seed, analysis) ? 1 : 0;
      const parsedSeed = this.parseNodeRef(seed.node_ref);
      const nodeTypePrior = parsedSeed ? this.nodeTypePrior(analysis.query_type, parsedSeed.kind) : 0.2;
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

  private loadSalienceForRefs(refs: NodeRef[]): Map<NodeRef, number> {
    const unique = Array.from(new Set(refs));
    if (unique.length === 0) {
      return new Map();
    }

    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT node_ref, salience FROM node_scores WHERE node_ref IN (${placeholders})`)
      .all(...unique) as Array<{ node_ref: string; salience: number }>;

    const map = new Map<NodeRef, number>();
    for (const row of rows) {
      map.set(row.node_ref as NodeRef, this.clamp01(row.salience));
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
      entity: { entity: 1, fact: 0.75, event: 0.4, assertion: 0.7, evaluation: 0.4, commitment: 0.4 },
      event: { event: 1, fact: 0.7, entity: 0.55, assertion: 0.45, evaluation: 0.8, commitment: 0.6 },
      why: { event: 1, fact: 0.85, entity: 0.5, assertion: 0.65, evaluation: 0.85, commitment: 0.75 },
      relationship: { entity: 1, fact: 0.9, event: 0.45, assertion: 0.7, evaluation: 0.45, commitment: 0.5 },
      timeline: { event: 1, fact: 0.5, entity: 0.3, assertion: 0.45, evaluation: 0.85, commitment: 0.7 },
      state: { fact: 1, entity: 0.85, event: 0.5, assertion: 0.8, evaluation: 0.5, commitment: 0.75 },
      conflict: { assertion: 1, fact: 0.9, event: 0.7, evaluation: 0.75, commitment: 0.6, entity: 0.6 },
    } satisfies Record<QueryType, Record<NodeRefKind, number>>;

    return (priors[queryType] as Record<string, number>)[nodeKind] ?? 0.2;
  }

  private expandTypedBeam(
    seeds: SeedCandidate[],
    seedScores: Map<NodeRef, number>,
    queryType: QueryType,
    viewerContext: ViewerContext,
    options: Required<NavigatorOptions>,
    input: TimeSliceQuery,
    strategy: GraphRetrievalStrategy,
  ): InternalBeamPath[] {
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
      const neighborMap = this.fetchNeighborsByFrontier(frontier, viewerContext, input);

      const nextCandidates: InternalBeamPath[] = [];
      for (const pathItem of currentLayer) {
        const tail = pathItem.path.nodes[pathItem.path.nodes.length - 1];
        const neighbors = [...(neighborMap.get(tail) ?? [])];
        neighbors.sort((a, b) => this.compareNeighborEdges(a, b, queryType, strategy));

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
      unique.sort((a, b) => this.preliminaryPathScore(b, seedScores, queryType, strategy) - this.preliminaryPathScore(a, seedScores, queryType, strategy));
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

  private fetchNeighborsByFrontier(
    frontier: Map<NodeRefKind, Set<NodeRef>>,
    viewerContext: ViewerContext,
    timeSlice: TimeSliceQuery,
  ): Map<NodeRef, InternalBeamEdge[]> {
    const map = new Map<NodeRef, InternalBeamEdge[]>();

    this.expandEventFrontier(frontier.get("event"), viewerContext, map, timeSlice);
    this.expandEntityFrontier(frontier.get("entity"), viewerContext, map, timeSlice);
    this.expandFactFrontier(frontier.get("fact"), viewerContext, map, timeSlice);
    const privateEventFrontier = new Set<NodeRef>([
      ...(frontier.get("evaluation") ?? []),
      ...(frontier.get("commitment") ?? []),
    ]);
    this.expandPrivateEventFrontier(privateEventFrontier.size > 0 ? privateEventFrontier : undefined, viewerContext, map, timeSlice);

    const privateBeliefFrontier = new Set<NodeRef>([
      ...(frontier.get("assertion") ?? []),
    ]);
    this.expandPrivateBeliefFrontier(privateBeliefFrontier.size > 0 ? privateBeliefFrontier : undefined, viewerContext, map, timeSlice);
    this.expandRelationEdges(frontier, viewerContext, map, timeSlice);

    return map;
  }

  private expandEventFrontier(
    frontier: Set<NodeRef> | undefined,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    timeSlice: TimeSliceQuery,
  ): void {
    if (!frontier || frontier.size === 0) {
      return;
    }

    const ids = this.extractIdsFromRefs(frontier, "event");
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(",");

    const logicEdges = this.edgeView.readLogicEdges(frontier, viewerContext, timeSlice);
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

    const stateSupportEdges = this.edgeView.readStateFactEdges(frontier, viewerContext, timeSlice);
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

    const eventVisibilityPredicate = this.visibilityPolicy.eventVisibilityPredicate(viewerContext);
    const eventRows = this.db
      .prepare(
        `SELECT id, participants, primary_actor_entity_id, timestamp, summary
         FROM event_nodes
         WHERE id IN (${placeholders})
           AND ${eventVisibilityPredicate}`,
      )
      .all(...ids) as Array<{
      id: number;
      participants: string | null;
      primary_actor_entity_id: number | null;
      timestamp: number;
      summary: string | null;
    }>;

    for (const row of eventRows) {
      const srcRef = `event:${row.id}` as NodeRef;
      const entityIds = new Set<number>();
      const participants = this.alias.resolveParticipants(row.participants);
      for (const participant of participants) {
        if (participant.entityId !== null) {
          entityIds.add(participant.entityId);
        }
      }
      if (row.primary_actor_entity_id !== null) {
        entityIds.add(row.primary_actor_entity_id);
      }

      for (const entityId of entityIds) {
        const target = `entity:${entityId}` as NodeRef;
        if (!this.isNodeVisible(target, viewerContext)) {
          continue;
        }
        this.pushEdge(map, srcRef, {
          from: srcRef,
          to: target,
          kind: "participant",
          weight: 0.85,
          timestamp: row.timestamp,
          summary: row.summary,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }
    }

    this.expandSemanticEdges(frontier, viewerContext, map, timeSlice);
  }

  private expandEntityFrontier(
    frontier: Set<NodeRef> | undefined,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    timeSlice: TimeSliceQuery,
  ): void {
    if (!frontier || frontier.size === 0) {
      return;
    }

    const ids = this.extractIdsFromRefs(frontier, "entity");
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(",");

    const factRows = this.db
      .prepare(
        `SELECT id, source_entity_id, target_entity_id, predicate, t_valid
         FROM fact_edges
         WHERE t_invalid = ? AND (source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders}))`,
      )
      .all(MAX_INTEGER, ...ids, ...ids) as Array<{
      id: number;
      source_entity_id: number;
      target_entity_id: number;
      predicate: string;
      t_valid: number;
    }>;

    for (const row of factRows) {
      const sourceRef = `entity:${row.source_entity_id}` as NodeRef;
      const targetRef = `entity:${row.target_entity_id}` as NodeRef;

      if (frontier.has(sourceRef) && this.isNodeVisible(targetRef, viewerContext)) {
        this.pushEdge(map, sourceRef, {
          from: sourceRef,
          to: targetRef,
          kind: "fact_relation",
          weight: 1,
          timestamp: row.t_valid,
          summary: row.predicate,
          canonical_fact_id: row.id,
          canonical_evidence: true,
        });
      }

      if (frontier.has(targetRef) && this.isNodeVisible(sourceRef, viewerContext)) {
        this.pushEdge(map, targetRef, {
          from: targetRef,
          to: sourceRef,
          kind: "fact_relation",
          weight: 1,
          timestamp: row.t_valid,
          summary: row.predicate,
          canonical_fact_id: row.id,
          canonical_evidence: true,
        });
      }
    }

    const participantConditions = ids.map(() => "participants LIKE ?").join(" OR ");
    const eventVisibilityPredicate = this.visibilityPolicy.eventVisibilityPredicate(viewerContext);
    const participantSql =
      `SELECT id, participants, primary_actor_entity_id, timestamp, summary
       FROM event_nodes
       WHERE (
          primary_actor_entity_id IN (${placeholders})` +
      (participantConditions.length > 0 ? ` OR ${participantConditions}` : "") +
      `)
       AND ${eventVisibilityPredicate}`;

    const participantBindings = [
      ...ids,
      ...ids.map((id) => `%entity:${id}%`),
    ];
    const participantRows = this.db.prepare(participantSql).all(
      ...participantBindings,
    ) as Array<{
      id: number;
      participants: string | null;
      primary_actor_entity_id: number | null;
      timestamp: number;
      summary: string | null;
    }>;

    for (const row of participantRows) {
      const eventRef = `event:${row.id}` as NodeRef;
      if (!this.isNodeVisible(eventRef, viewerContext)) {
        continue;
      }
      const participants = this.alias.resolveParticipants(row.participants);
      const eventEntityIds = new Set<number>();
      if (row.primary_actor_entity_id !== null) {
        eventEntityIds.add(row.primary_actor_entity_id);
      }
      for (const participant of participants) {
        if (participant.entityId !== null) {
          eventEntityIds.add(participant.entityId);
        }
      }

      for (const entityId of eventEntityIds) {
        const entityRef = `entity:${entityId}` as NodeRef;
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

    const idSet = new Set<number>(ids);
    const beliefRows = this.db
      .prepare(
        `SELECT id, summary_text, record_json, updated_at
         FROM private_cognition_current
         WHERE agent_id = ? AND kind = 'assertion'`,
      )
      .all(viewerContext.viewer_agent_id) as Array<{
      id: number;
      summary_text: string | null;
      record_json: string | null;
      updated_at: number;
    }>;

    for (const row of beliefRows) {
      const parsedRecord = this.parseAssertionRecord(row.record_json);
      const sourceEntityId = parsedRecord.sourceEntityId;
      const targetEntityId = parsedRecord.targetEntityId;
      if (sourceEntityId === null && targetEntityId === null) {
        continue;
      }

      const sourceMatches = sourceEntityId !== null && idSet.has(sourceEntityId);
      const targetMatches = targetEntityId !== null && idSet.has(targetEntityId);
      if (!sourceMatches && !targetMatches) {
        continue;
      }

      const beliefRef = `assertion:${row.id}` as NodeRef;
      if (!this.isNodeVisible(beliefRef, viewerContext)) {
        continue;
      }

      const sourceRef = sourceEntityId !== null ? (`entity:${sourceEntityId}` as NodeRef) : null;
      const targetRef = targetEntityId !== null ? (`entity:${targetEntityId}` as NodeRef) : null;
      const summary = parsedRecord.predicate ?? row.summary_text;

      if (sourceRef && frontier.has(sourceRef)) {
        this.pushEdge(map, sourceRef, {
          from: sourceRef,
          to: beliefRef,
          kind: "fact_relation",
          weight: 0.7,
          timestamp: row.updated_at,
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
          timestamp: row.updated_at,
          summary,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }
    }

    this.expandSemanticEdges(frontier, viewerContext, map, timeSlice);
  }

  private expandFactFrontier(
    frontier: Set<NodeRef> | undefined,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    timeSlice: TimeSliceQuery,
  ): void {
    if (!frontier || frontier.size === 0) {
      return;
    }
    const ids = this.extractIdsFromRefs(frontier, "fact");
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(",");

    const factRows = this.db
      .prepare(
        `SELECT id, source_entity_id, target_entity_id, predicate, source_event_id, t_valid
         FROM fact_edges
         WHERE t_invalid = ? AND id IN (${placeholders})`,
      )
      .all(MAX_INTEGER, ...ids) as Array<{
      id: number;
      source_entity_id: number;
      target_entity_id: number;
      predicate: string;
      source_event_id: number | null;
      t_valid: number;
    }>;

    for (const row of factRows) {
      const factRef = `fact:${row.id}` as NodeRef;
      const sourceRef = `entity:${row.source_entity_id}` as NodeRef;
      const targetRef = `entity:${row.target_entity_id}` as NodeRef;

      if (this.isNodeVisible(sourceRef, viewerContext)) {
        this.pushEdge(map, factRef, {
          from: factRef,
          to: sourceRef,
          kind: "fact_relation",
          weight: 0.95,
          timestamp: row.t_valid,
          summary: row.predicate,
          canonical_fact_id: row.id,
          canonical_evidence: true,
        });
      }

      if (this.isNodeVisible(targetRef, viewerContext)) {
        this.pushEdge(map, factRef, {
          from: factRef,
          to: targetRef,
          kind: "fact_relation",
          weight: 0.95,
          timestamp: row.t_valid,
          summary: row.predicate,
          canonical_fact_id: row.id,
          canonical_evidence: true,
        });
      }

      if (row.source_event_id !== null) {
        const eventRef = `event:${row.source_event_id}` as NodeRef;
        if (this.isNodeVisible(eventRef, viewerContext)) {
          this.pushEdge(map, factRef, {
            from: factRef,
            to: eventRef,
            kind: "fact_support",
            weight: 0.9,
            timestamp: row.t_valid,
            summary: row.predicate,
            canonical_fact_id: row.id,
            canonical_evidence: true,
          });
        }
      }
    }

    this.expandSemanticEdges(frontier, viewerContext, map, timeSlice);
  }

  private expandPrivateEventFrontier(
    frontier: Set<NodeRef> | undefined,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    timeSlice: TimeSliceQuery,
  ): void {
    if (!frontier || frontier.size === 0) {
      return;
    }

    this.expandSemanticEdges(frontier, viewerContext, map, timeSlice, true);
  }

  private expandPrivateBeliefFrontier(
    frontier: Set<NodeRef> | undefined,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    timeSlice: TimeSliceQuery,
  ): void {
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
    const ids = [...idToRef.keys()];
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(",");

    const pointerRefCache = new Map<string, NodeRef | null>();
    const resolveEntityRef = (pointerKey: string | null): NodeRef | null => {
      if (!pointerKey) {
        return null;
      }
      const cacheKey = pointerKey.normalize("NFC");
      if (pointerRefCache.has(cacheKey)) {
        return pointerRefCache.get(cacheKey) ?? null;
      }
      const resolved = this.resolveEntityRefFromPointerKey(cacheKey, viewerContext.viewer_agent_id);
      pointerRefCache.set(cacheKey, resolved);
      return resolved;
    };

    const committedCutoffClause = timeSlice.asOfCommittedTime != null ? " AND updated_at <= ?" : "";
    const currentRows = this.db
      .prepare(
        `SELECT id, summary_text, record_json, updated_at
         FROM private_cognition_current
         WHERE agent_id = ? AND kind = 'assertion' AND id IN (${placeholders})${committedCutoffClause}`,
      )
      .all(
        viewerContext.viewer_agent_id,
        ...ids,
        ...(timeSlice.asOfCommittedTime != null ? [timeSlice.asOfCommittedTime] : []),
      ) as Array<{
      id: number;
      summary_text: string | null;
      record_json: string;
      updated_at: number;
    }>;

    for (const row of currentRows) {
      const beliefRef = (idToRef.get(row.id) ?? `assertion:${row.id}`) as NodeRef;
      const parsedRecord = this.parseAssertionRecord(row.record_json);
      const summary = parsedRecord.predicate ?? row.summary_text;
      const sourceRef =
        resolveEntityRef(parsedRecord.sourcePointerKey)
        ?? (parsedRecord.sourceEntityId !== null ? (`entity:${parsedRecord.sourceEntityId}` as NodeRef) : null);
      const targetRef =
        resolveEntityRef(parsedRecord.targetPointerKey)
        ?? (parsedRecord.targetEntityId !== null ? (`entity:${parsedRecord.targetEntityId}` as NodeRef) : null);

      if (sourceRef && this.isNodeVisible(sourceRef, viewerContext)) {
        this.pushEdge(map, beliefRef, {
          from: beliefRef,
          to: sourceRef,
          kind: "fact_relation",
          weight: 0.75,
          timestamp: row.updated_at,
          summary,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }

      if (targetRef && this.isNodeVisible(targetRef, viewerContext)) {
        this.pushEdge(map, beliefRef, {
          from: beliefRef,
          to: targetRef,
          kind: "fact_relation",
          weight: 0.75,
          timestamp: row.updated_at,
          summary,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }

      if (parsedRecord.sourceEventRef && this.isNodeVisible(parsedRecord.sourceEventRef, viewerContext)) {
        this.pushEdge(map, beliefRef, {
          from: beliefRef,
          to: parsedRecord.sourceEventRef,
          kind: "fact_support",
          weight: 0.7,
          timestamp: row.updated_at,
          summary,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }
    }

    this.expandSemanticEdges(frontier, viewerContext, map, timeSlice, true);
  }

  private expandRelationEdges(
    frontier: Map<NodeRefKind, Set<NodeRef>>,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    timeSlice: TimeSliceQuery,
  ): void {
    const allRefs: NodeRef[] = [];
    for (const refs of frontier.values()) {
      for (const ref of refs) allRefs.push(ref);
    }
    if (allRefs.length === 0) return;

    const edges = this.edgeView.readMemoryRelations(new Set(allRefs), viewerContext, timeSlice);
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

  private expandSemanticEdges(
    frontier: Set<NodeRef>,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    timeSlice: TimeSliceQuery,
    privateFrontier = false,
  ): void {
    const edges = this.edgeView.readSemanticEdges(frontier, viewerContext, timeSlice);
    for (const edge of edges) {
      if (privateFrontier && !this.isSameAgentPrivateCompatibility(edge.source_ref, edge.target_ref, viewerContext.viewer_agent_id)) {
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

  private isSameAgentPrivateCompatibility(from: NodeRef, to: NodeRef, viewerAgentId: string): boolean {
    const fromKind = this.parseNodeRef(from)?.kind;
    const toKind = this.parseNodeRef(to)?.kind;
    const fromPrivate = fromKind === "assertion" || fromKind === "evaluation" || fromKind === "commitment";
    const toPrivate = toKind === "assertion" || toKind === "evaluation" || toKind === "commitment";

    if (!fromPrivate && !toPrivate) {
      return true;
    }

    if (fromPrivate && this.getPrivateNodeAgentId(from) !== viewerAgentId) {
      return false;
    }
    if (toPrivate && this.getPrivateNodeAgentId(to) !== viewerAgentId) {
      return false;
    }

    if (fromPrivate && toPrivate) {
      return this.getPrivateNodeAgentId(from) === this.getPrivateNodeAgentId(to);
    }

    return true;
  }

  private getPrivateNodeAgentId(nodeRef: NodeRef): string | null {
    const parsed = this.parseNodeRef(nodeRef);
    if (!parsed) {
      return null;
    }
    if (parsed.kind === "evaluation" || parsed.kind === "commitment") {
      const row = this.db
        .prepare("SELECT agent_id FROM private_cognition_current WHERE id=?")
        .get(parsed.id) as { agent_id: string } | undefined;
      return row?.agent_id ?? null;
    }
    if (parsed.kind === "assertion") {
      const row = this.db
        .prepare("SELECT agent_id FROM private_cognition_current WHERE id=?")
        .get(parsed.id) as { agent_id: string } | undefined;
      return row?.agent_id ?? null;
    }
    return null;
  }

  private compareNeighborEdges(a: InternalBeamEdge, b: InternalBeamEdge, queryType: QueryType, strategy?: GraphRetrievalStrategy): number {
    const scoreA = this.edgePriorityScore(a.kind, queryType);
    const scoreB = this.edgePriorityScore(b.kind, queryType);
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    const weightA = a.weight * (strategy?.edgeWeights[a.kind as MemoryRelationType] ?? 1.0);
    const weightB = b.weight * (strategy?.edgeWeights[b.kind as MemoryRelationType] ?? 1.0);
    if (weightA !== weightB) {
      return weightB - weightA;
    }
    return (b.timestamp ?? 0) - (a.timestamp ?? 0);
  }

  private parseAssertionRecord(recordJson: string | null): {
    sourcePointerKey: string | null;
    targetPointerKey: string | null;
    predicate: string | null;
    sourceEventRef: NodeRef | null;
    sourceEntityId: number | null;
    targetEntityId: number | null;
  } {
    if (!recordJson) {
      return {
        sourcePointerKey: null,
        targetPointerKey: null,
        predicate: null,
        sourceEventRef: null,
        sourceEntityId: null,
        targetEntityId: null,
      };
    }

    try {
      const parsed = JSON.parse(recordJson) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object") {
        return {
          sourcePointerKey: null,
          targetPointerKey: null,
          predicate: null,
          sourceEventRef: null,
          sourceEntityId: null,
          targetEntityId: null,
        };
      }

      const sourcePointerKey =
        typeof parsed.sourcePointerKey === "string" && parsed.sourcePointerKey.trim().length > 0
          ? parsed.sourcePointerKey.trim()
          : null;
      const targetPointerKey =
        typeof parsed.targetPointerKey === "string" && parsed.targetPointerKey.trim().length > 0
          ? parsed.targetPointerKey.trim()
          : null;
      const predicate =
        typeof parsed.predicate === "string" && parsed.predicate.trim().length > 0
          ? parsed.predicate.trim()
          : null;

      const sourceEventRaw =
        typeof parsed.sourceEventRef === "string"
          ? parsed.sourceEventRef
          : typeof parsed.source_event_ref === "string"
            ? parsed.source_event_ref
            : null;
      const sourceEventCandidate = sourceEventRaw?.trim();
      const sourceEventRef =
        sourceEventCandidate && this.parseNodeRef(sourceEventCandidate as NodeRef)
          ? (sourceEventCandidate as NodeRef)
          : null;

      const sourceEntityRaw = parsed.sourceEntityId ?? parsed.source_entity_id;
      const sourceEntityId =
        typeof sourceEntityRaw === "number" && Number.isInteger(sourceEntityRaw) && sourceEntityRaw > 0
          ? sourceEntityRaw
          : null;

      const targetEntityRaw = parsed.targetEntityId ?? parsed.target_entity_id;
      const targetEntityId =
        typeof targetEntityRaw === "number" && Number.isInteger(targetEntityRaw) && targetEntityRaw > 0
          ? targetEntityRaw
          : null;

      return {
        sourcePointerKey,
        targetPointerKey,
        predicate,
        sourceEventRef,
        sourceEntityId,
        targetEntityId,
      };
    } catch {
      return {
        sourcePointerKey: null,
        targetPointerKey: null,
        predicate: null,
        sourceEventRef: null,
        sourceEntityId: null,
        targetEntityId: null,
      };
    }
  }

  private resolveEntityRefFromPointerKey(pointerKey: string, viewerAgentId: string): NodeRef | null {
    const normalized = pointerKey.trim();
    if (normalized.length === 0) {
      return null;
    }

    const row = this.db
      .prepare(
        `SELECT id
         FROM entity_nodes
         WHERE pointer_key = ?
           AND (
             (memory_scope = 'private_overlay' AND owner_agent_id = ?)
             OR memory_scope = 'shared_public'
           )
         ORDER BY CASE WHEN memory_scope = 'private_overlay' THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(normalized, viewerAgentId) as { id: number } | undefined;

    return row ? (`entity:${row.id}` as NodeRef) : null;
  }

  private edgePriorityScore(kind: NavigatorEdgeKind | MemoryRelationType, queryType: QueryType): number {
    const ordered = QUERY_TYPE_PRIORITY[queryType];
    const index = (ordered as readonly string[]).indexOf(kind);
    if (index !== -1) {
      return 1 - index / Math.max(ordered.length, 1);
    }
    // Memory relation edges get a non-floor base score (0.3) rather than the default 0.1
    if ((MEMORY_RELATION_TYPES as readonly string[]).includes(kind)) {
      return 0.3;
    }
    return 0.1;
  }

  private preliminaryPathScore(path: InternalBeamPath, seedScores: Map<NodeRef, number>, queryType: QueryType, strategy?: GraphRetrievalStrategy): number {
    const seed = seedScores.get(path.path.seed) ?? 0;
    const edgeScore = path.internal_edges.length === 0
      ? 0
      : path.internal_edges.reduce((acc, edge) => {
          const base = this.edgePriorityScore(edge.kind, queryType);
          const multiplier = strategy?.edgeWeights[edge.kind as MemoryRelationType] ?? 1.0;
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

  private rerankPaths(
    paths: InternalBeamPath[],
    seedScores: Map<NodeRef, number>,
    queryType: QueryType,
    maxDepth: number,
    strategy?: GraphRetrievalStrategy,
  ): Array<{ path: InternalBeamPath; score: PathScore }> {
    const snapshots = this.loadNodeSnapshots(paths.flatMap((p) => p.path.nodes));

    const scored = paths.map((path) => {
      const seedScore = seedScores.get(path.path.seed) ?? 0;
      const edgeTypeScore = this.average(path.internal_edges.map((edge) => {
        const base = this.edgePriorityScore(edge.kind, queryType);
        const multiplier = strategy?.edgeWeights[edge.kind as MemoryRelationType] ?? 1.0;
        return base * multiplier;
      }));
      const temporalConsistency = this.calculateTemporalConsistency(path.internal_edges);
      const queryIntentMatch = this.calculateQueryIntentMatch(path.internal_edges, queryType);
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

  private loadNodeSnapshots(refs: NodeRef[]): Map<NodeRef, NodeSnapshot> {
    const unique = Array.from(new Set(refs));
    const byKind = new Map<NodeRefKind, number[]>();
    for (const ref of unique) {
      const parsed = this.parseNodeRef(ref);
      if (!parsed) {
        continue;
      }
      const list = byKind.get(parsed.kind) ?? [];
      list.push(parsed.id);
      byKind.set(parsed.kind, list);
    }

    const map = new Map<NodeRef, NodeSnapshot>();

    this.populateSnapshots(map, "event", byKind.get("event"), "event_nodes", "summary", "timestamp");
    this.populateSnapshots(map, "entity", byKind.get("entity"), "entity_nodes", "summary", "updated_at");
    this.populateSnapshots(map, "fact", byKind.get("fact"), "fact_edges", "predicate", "t_valid");
    this.populateSnapshots(map, "evaluation", byKind.get("evaluation"), "private_cognition_current", "summary_text", "updated_at");
    this.populateSnapshots(map, "commitment", byKind.get("commitment"), "private_cognition_current", "summary_text", "updated_at");
    this.populateSnapshots(map, "assertion", byKind.get("assertion"), "private_cognition_current", "summary_text", "updated_at");

    return map;
  }

  private populateSnapshots(
    map: Map<NodeRef, NodeSnapshot>,
    kind: NodeRefKind,
    ids: number[] | undefined,
    table: string,
    summaryColumn: string,
    tsColumn: string,
  ): void {
    if (!ids || ids.length === 0) {
      return;
    }

    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT id, ${summaryColumn} AS summary, ${tsColumn} AS ts FROM ${table} WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: number; summary: string | null; ts: number | null }>;

    for (const row of rows) {
      map.set(`${kind}:${row.id}` as NodeRef, {
        summary: row.summary,
        timestamp: row.ts,
      });
    }
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

  private calculateQueryIntentMatch(edges: InternalBeamEdge[], queryType: QueryType): number {
    if (edges.length === 0) {
      return 0.4;
    }
    const topKinds = new Set<NavigatorEdgeKind | MemoryRelationType>(QUERY_TYPE_PRIORITY[queryType].slice(0, 2));
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

  private assembleEvidence(
    scored: Array<{ path: InternalBeamPath; score: PathScore }>,
    viewerContext: ViewerContext,
    maxCandidates: number,
  ): EvidencePath[] {
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

      const safe = this.applyPostFilterSafetyNet(evidence, viewerContext);
      if (safe) {
        result.push(safe);
      }
    }
    return result;
  }

  private applyDetailLevel(paths: EvidencePath[], detailLevel?: ExplainDetailLevel): EvidencePath[] {
    if (!detailLevel || detailLevel === "standard") {
      return paths;
    }
    if (detailLevel === "concise") {
      return paths.slice(0, 3);
    }
    return paths;
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

  private applyPostFilterSafetyNet(evidencePath: EvidencePath, viewerContext: ViewerContext): EvidencePath | null {
    const visibleNodes: NodeRef[] = [];
    const redactedPlaceholders: RedactedPlaceholder[] = [];
    for (const node of evidencePath.path.nodes) {
      const disposition = this.getNodeDisposition(node, viewerContext);
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

  private isNodeVisible(nodeRef: NodeRef, viewerContext: ViewerContext): boolean {
    return this.getNodeDisposition(nodeRef, viewerContext) === "visible";
  }

  private getNodeDisposition(nodeRef: NodeRef, viewerContext: ViewerContext): VisibilityDisposition {
    const nodeData = this.loadNodeVisibilityData(nodeRef);
    if (!nodeData) {
      return "hidden";
    }
    return this.visibilityPolicy.getNodeDisposition(viewerContext, nodeRef, nodeData);
  }

  private loadNodeVisibilityData(nodeRef: NodeRef): Record<string, unknown> | null {
    const parsed = this.parseNodeRef(nodeRef);
    if (!parsed) {
      return null;
    }

    if (parsed.kind === "entity") {
      const row = this.db
        .prepare("SELECT memory_scope, owner_agent_id FROM entity_nodes WHERE id = ?")
        .get(parsed.id) as { memory_scope: "shared_public" | "private_overlay"; owner_agent_id: string | null } | undefined;
      return row ? { memory_scope: row.memory_scope, owner_agent_id: row.owner_agent_id } : null;
    }

    if (parsed.kind === "evaluation" || parsed.kind === "commitment") {
      const row = this.db
        .prepare("SELECT agent_id FROM private_cognition_current WHERE id = ?")
        .get(parsed.id) as { agent_id: string } | undefined;
      return row ? { agent_id: row.agent_id } : null;
    }

    if (parsed.kind === "assertion") {
      const row = this.db
        .prepare("SELECT agent_id FROM private_cognition_current WHERE id = ?")
        .get(parsed.id) as { agent_id: string } | undefined;
      return row ? { agent_id: row.agent_id } : null;
    }

    if (parsed.kind === "event") {
      const row = this.db
        .prepare("SELECT * FROM event_nodes WHERE id = ?")
        .get(parsed.id) as EventNode | undefined;
      return row ? row as unknown as Record<string, unknown> : null;
    }

    if (parsed.kind === "fact") {
      const row = this.db
        .prepare("SELECT id FROM fact_edges WHERE id = ? AND t_invalid = ?")
        .get(parsed.id, MAX_INTEGER) as { id: number } | undefined;
      return row ? { id: row.id } : null;
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
}
