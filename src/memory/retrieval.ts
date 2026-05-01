import { createLogger } from "../core/logger.js";
import type { RetrievalReadRepo } from "../storage/domain-repos/contracts/retrieval-read-repo.js";
import { parseGraphNodeRef } from "./contracts/graph-node-ref.js";

const logger = createLogger({ name: "memory.retrieval", level: "debug" });
import type { EmbeddingService } from "./embeddings.js";
import type { CognitionSearchService } from "./cognition/cognition-search.js";
import type { RetrievalTemplate } from "./contracts/retrieval-template.js";
import type { NarrativeSearchService } from "./narrative/narrative-search.js";
import type {
  RetrievalOrchestrator,
  RetrievalDedupContext,
  RetrievalQueryStrategy,
  TypedRetrievalResult,
} from "./retrieval/retrieval-orchestrator.js";
import type { EpisodeRow } from "./episode/episode-repo.js";
import type { QueryPlan, QueryPlanBuilder } from "./query-plan-types.js";
import type { QueryRoute, QueryRouter } from "./query-routing-types.js";
import type {
  EntityNode,
  EventNode,
  FactEdge,
  MemoryHint,
  NodeRef,
  NodeRefKind,
  SeedCandidate,
  Topic,
  ViewerContext,
} from "./types.js";

type SearchResult = {
  source_ref: NodeRef;
  doc_type: string;
  content: string;
  scope: "private" | "area" | "world";
  score: number;
};

const RELATED_ENTITY_REFERENCE_PATTERN =
  /(?:那边的人|这边的人|哪边的人|哪位|这位|那位|哪个人|这人|那人|谁|who|person|someone)/i;

const MAX_ANCHOR_POOL_SIZE = 3;

/**
 * Builds the anchor candidate pool for graph-based reference expansion.
 * Current-turn hints take priority; prior-turn hints fill any remaining
 * slots as a phase-1 fallback for pronominal/locative references whose
 * anchor was established in a previous turn.
 *
 * Returns `{ anchors, priorTurnAnchorsUsed }` so callers can attribute
 * the expansion in trace/rationale.
 */
export function buildAnchorPool(
  currentTurnHints: ReadonlyArray<string>,
  priorTurnHints: ReadonlyArray<string>,
): { anchors: string[]; priorTurnAnchorsUsed: number } {
  const anchors: string[] = [];
  const seen = new Set<string>();
  const push = (hint: string): boolean => {
    if (anchors.length >= MAX_ANCHOR_POOL_SIZE) return false;
    const key = hint.toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    anchors.push(hint);
    return true;
  };
  for (const hint of currentTurnHints) push(hint);
  let priorTurnAnchorsUsed = 0;
  for (const hint of priorTurnHints) {
    if (push(hint)) priorTurnAnchorsUsed += 1;
  }
  return { anchors, priorTurnAnchorsUsed };
}

/** Exported only so tests can verify the pattern coverage without
 *  reaching into the private RetrievalService instance. */
export function matchesRelatedEntityReferencePattern(text: string): boolean {
  return RELATED_ENTITY_REFERENCE_PATTERN.test(text);
}

type EntityReadResult = {
  entity: EntityNode | null;
  facts: FactEdge[];
  events: EventNode[];
  episodes: EpisodeRow[];
};

type TopicReadResult = {
  topic: Topic | null;
  events: EventNode[];
  episodes: EpisodeRow[];
};

type RetrievalServiceDeps = {
  retrievalRepo: RetrievalReadRepo;
  embeddingService?: EmbeddingService;
  narrativeSearch?: NarrativeSearchService;
  cognitionSearch?: CognitionSearchService;
  orchestrator?: RetrievalOrchestrator;
  /**
   * Phase 3 (plan-driven retrieval): optional router + builder. When both
   * are provided, `generateTypedRetrieval` builds a QueryPlan per call and
   * passes it to the orchestrator for signal-weighted budget reallocation.
   * When either is missing, retrieval runs on the legacy template path.
   */
  queryRouter?: QueryRouter;
  queryPlanBuilder?: QueryPlanBuilder;
};

export type RetrievalTraceCaptureHook = (capture: {
  query_string: string;
  strategy: RetrievalQueryStrategy;
  narrative_facets_used: string[];
  cognition_facets_used: string[];
  segment_count: number;
  segments?: Array<{
    source: string;
    content: string;
    score?: number;
  }>;
  navigator?: {
    seeds: string[];
    steps: Array<{
      depth: number;
      visited_ref: string;
      via_ref?: string;
      via_relation?: string;
      score?: number;
      pruned?: string | null;
    }>;
    final_selection: string[];
  };
}) => void;

export class RetrievalService {
  private readonly retrievalRepo: RetrievalReadRepo;
  private readonly embeddingService: EmbeddingService;
  private readonly narrativeSearch: NarrativeSearchService;
  private readonly cognitionSearch: CognitionSearchService;
  private readonly orchestrator: RetrievalOrchestrator;
  private readonly queryRouter: QueryRouter | null;
  private readonly queryPlanBuilder: QueryPlanBuilder | null;

  constructor(deps: RetrievalServiceDeps) {
    this.retrievalRepo = deps.retrievalRepo;
    this.embeddingService =
      deps.embeddingService ??
      (() => {
        throw new Error("embeddingService is required");
      })();
    this.narrativeSearch =
      deps.narrativeSearch ??
      (() => {
        throw new Error("narrativeSearch is required");
      })();
    this.cognitionSearch =
      deps.cognitionSearch ??
      (() => {
        throw new Error("cognitionSearch is required");
      })();
    this.orchestrator =
      deps.orchestrator ??
      (() => {
        throw new Error("orchestrator is required");
      })();
    this.queryRouter = deps.queryRouter ?? null;
    this.queryPlanBuilder = deps.queryPlanBuilder ?? null;
  }

  async readByEntity(
    pointerKey: string,
    viewerContext: ViewerContext,
  ): Promise<EntityReadResult> {
    return this.retrievalRepo.readByEntity(pointerKey, viewerContext);
  }

  async readByTopic(
    name: string,
    viewerContext: ViewerContext,
  ): Promise<TopicReadResult> {
    return this.retrievalRepo.readByTopic(name, viewerContext);
  }

  async readByEventIds(
    ids: number[],
    viewerContext: ViewerContext,
  ): Promise<EventNode[]> {
    return this.retrievalRepo.readByEventIds(ids, viewerContext);
  }

  async readByFactIds(
    ids: number[],
    viewerContext: ViewerContext,
  ): Promise<FactEdge[]> {
    return this.retrievalRepo.readByFactIds(ids, viewerContext);
  }

  async searchVisibleNarrative(
    query: string,
    viewerContext: ViewerContext,
  ): Promise<SearchResult[]> {
    const narrativeResults = await this.narrativeSearch.searchNarrative(
      query,
      viewerContext,
    );
    return narrativeResults.map((r) => ({
      source_ref: r.source_ref,
      doc_type: r.doc_type,
      content: r.content,
      scope: r.scope,
      score: r.score,
    }));
  }

  async generateMemoryHints(
    userMessage: string,
    viewerContext: ViewerContext,
    limit = 5,
  ): Promise<MemoryHint[]> {
    const typed = await this.generateTypedRetrieval(
      userMessage,
      viewerContext,
      undefined,
      {
        narrativeEnabled: true,
        cognitionEnabled: false,
        conflictNotesEnabled: false,
        episodeEnabled: false,
        narrativeBudget: limit,
      },
    );
    return typed.narrative.map((segment) => ({
      source_ref: segment.source_ref as MemoryHint["source_ref"],
      doc_type: segment.doc_type,
      content: segment.content,
      scope: segment.scope,
      score: segment.score,
    }));
  }

  async generateTypedRetrieval(
    query: string,
    viewerContext: ViewerContext,
    dedupContext?: RetrievalDedupContext,
    retrievalTemplate?: RetrievalTemplate,
    queryStrategy: RetrievalQueryStrategy = "default_retrieval",
    contestedCount?: number,
    sceneRetrieval?: boolean,
    onTraceCapture?: RetrievalTraceCaptureHook,
  ): Promise<TypedRetrievalResult> {
    // Phase 3: build a QueryPlan per call when router + builder are wired.
    // Failures fall back to undefined — orchestrator then runs the legacy
    // template path without plan-driven budget reallocation.
    const queryPlan = await this.buildPlanForQuery(query, viewerContext, dedupContext?.recentEntityHints);
    const overrideTemplate =
      sceneRetrieval === undefined
        ? retrievalTemplate
        : {
            ...retrievalTemplate,
            sceneRetrieval,
          };

    const result = await this.orchestrator.search(
      query,
      viewerContext,
      viewerContext.viewer_role,
      {
        override: overrideTemplate,
        dedupContext,
        queryStrategy,
        contestedCount,
        queryPlan,
      },
    );
    const typed = result.typed;
    const conflictNotesBudget = retrievalTemplate?.conflictNotesBudget ?? 0;

    if (conflictNotesBudget > 0 && typed.conflict_notes.length === 0) {
      for (const hit of result.cognitionHits) {
        if (typed.conflict_notes.length >= conflictNotesBudget) {
          break;
        }
        if (hit.stance !== "contested") {
          continue;
        }
        const content = hit.conflictSummary?.trim() || "contested cognition";
        typed.conflict_notes.push({
          source_ref: `conflict_note:${String(hit.source_ref)}`,
          from_source_ref: String(hit.source_ref),
          cognitionKey: hit.cognitionKey ?? null,
          content,
          score: hit.updated_at,
        });
      }
    }

    if (onTraceCapture) {
      try {
        const narrativeFacetsUsed: string[] = [];
        const cognitionFacetsUsed: string[] = [];
        if ((queryPlan?.surfacePlans.narrative.entityFilters.length ?? 0) > 0) {
          narrativeFacetsUsed.push("entity_filters");
        }
        if (queryPlan?.surfacePlans.narrative.timeWindow) {
          narrativeFacetsUsed.push("time_window");
        }
        if ((queryPlan?.surfacePlans.cognition.entityFilters.length ?? 0) > 0) {
          cognitionFacetsUsed.push("entity_filters");
        }
        if (queryPlan?.surfacePlans.cognition.timeWindow) {
          cognitionFacetsUsed.push("time_window");
        }
        if (queryPlan?.surfacePlans.cognition.kind) {
          cognitionFacetsUsed.push("kind");
        }
        if (queryPlan?.surfacePlans.cognition.stance) {
          cognitionFacetsUsed.push("stance");
        }

        onTraceCapture({
          query_string: query,
          strategy: queryStrategy,
          narrative_facets_used: narrativeFacetsUsed,
          cognition_facets_used: cognitionFacetsUsed,
          segment_count:
            typed.scene_area.length +
            typed.scene_world.length +
            typed.narrative.length +
            typed.cognition.length +
            typed.conflict_notes.length +
            typed.episode.length,
          segments: [
            ...typed.scene_area.map((segment) => ({
              source: `scene_area:${segment.factKey}`,
              content: JSON.stringify(segment.value),
            })),
            ...typed.scene_world.map((segment) => ({
              source: `scene_world:${segment.factKey}`,
              content: JSON.stringify(segment.value),
            })),
            ...typed.narrative.map((segment) => ({
              source: String(segment.source_ref),
              content: segment.content,
              ...(typeof segment.score === "number"
                ? { score: segment.score }
                : {}),
            })),
            ...typed.cognition.map((segment) => ({
              source: String(segment.source_ref),
              content: segment.content,
              ...(typeof segment.score === "number"
                ? { score: segment.score }
                : {}),
            })),
            ...typed.conflict_notes.map((segment) => ({
              source: String(segment.source_ref),
              content: segment.content,
              ...(typeof segment.score === "number"
                ? { score: segment.score }
                : {}),
            })),
            ...typed.episode.map((segment) => ({
              source: String(segment.source_ref),
              content: segment.content,
              ...(typeof segment.score === "number"
                ? { score: segment.score }
                : {}),
            })),
          ],
        });
      } catch {
        // Non-fatal diagnostics path: retrieval output must still return.
      }
    }

    return typed;
  }

  /**
   * Build a QueryPlan for the current query, routed through the injected
   * QueryRouter + QueryPlanBuilder. Returns undefined when either dependency
   * is missing or when either step throws — the orchestrator then runs the
   * legacy template path (no plan-driven budget reallocation).
   *
   * Failures are logged via the structured logger (same pattern as Phase 1/2
   * shadow logs) so operators and shadow-data analysis can detect repeated
   * fallback without breaking the legacy path.
   */
  private async buildPlanForQuery(
    query: string,
    viewerContext: ViewerContext,
    recentEntityHints?: string[],
  ): Promise<QueryPlan | undefined> {
    if (!this.queryRouter || !this.queryPlanBuilder) return undefined;
    try {
      const route = await this.queryRouter.route({
        query,
        viewerAgentId: viewerContext.viewer_agent_id,
        currentAreaId: viewerContext.current_area_id ?? null,
        recentEntityHints,
      });
      const expandedRoute = await this.expandResolvedEntitiesViaGraph(
        route,
        viewerContext,
        recentEntityHints,
      );
      return this.queryPlanBuilder.build({
        route: expandedRoute,
        role: viewerContext.viewer_role,
      });
    } catch (err) {
      logger.debug("retrieval_plan_build_failed", {
        event: "retrieval_plan_build_failed",
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      return undefined;
    }
  }

  private async expandResolvedEntitiesViaGraph(
    route: QueryRoute,
    viewerContext: ViewerContext,
    recentEntityHints: string[] = [],
  ): Promise<QueryRoute> {
    if (!RELATED_ENTITY_REFERENCE_PATTERN.test(route.originalQuery)) {
      return route;
    }

    // Anchor pool: current-turn entityHints first (highest signal), then
    // prior-turn entities as a phase-1 fallback so a pronominal/locative
    // query whose anchor was set in a previous turn ("那边的人" two turns
    // after "Alice 进了花房") can still expand against the right anchor.
    const { anchors: anchorPool, priorTurnAnchorsUsed } = buildAnchorPool(
      route.entityHints,
      recentEntityHints,
    );

    if (anchorPool.length === 0) {
      return route;
    }

    const expandedIds = [...route.resolvedEntityIds];
    const seenIds = new Set(expandedIds);
    let added = 0;

    for (const hint of anchorPool) {
      const graphContext = await this.retrievalRepo.readByEntity(
        hint,
        viewerContext,
      );
      const anchor = graphContext.entity;
      if (!anchor) {
        continue;
      }
      // The anchor itself must be in resolvedEntityIds for downstream
      // surface scoring — current-turn hints already are, prior-turn
      // hints might not be, so add defensively.
      if (!seenIds.has(anchor.id)) {
        seenIds.add(anchor.id);
        expandedIds.push(anchor.id);
      }
      const relatedIds = await this.collectRelatedEntityIdsFromGraphContext(
        graphContext,
        anchor.id,
        viewerContext,
      );
      for (const relatedId of relatedIds) {
        if (seenIds.has(relatedId)) {
          continue;
        }
        seenIds.add(relatedId);
        expandedIds.push(relatedId);
        added += 1;
        if (expandedIds.length >= 4) {
          break;
        }
      }
      if (expandedIds.length >= 4) {
        break;
      }
    }

    if (added === 0 && expandedIds.length === route.resolvedEntityIds.length) {
      return route;
    }

    const matchedRules = [
      ...route.matchedRules,
      `graph_related_entity_expand:${added}`,
    ];
    if (priorTurnAnchorsUsed > 0) {
      matchedRules.push(`prior_turn_anchor_fallback:${priorTurnAnchorsUsed}`);
    }
    return {
      ...route,
      resolvedEntityIds: expandedIds,
      matchedRules,
      rationale:
        priorTurnAnchorsUsed > 0
          ? `${route.rationale}; graph_related_entity_expand=${added}; prior_turn_anchors=${priorTurnAnchorsUsed}`
          : `${route.rationale}; graph_related_entity_expand=${added}`,
    };
  }

  private async collectRelatedEntityIdsFromGraphContext(
    context: EntityReadResult,
    anchorEntityId: number,
    viewerContext: ViewerContext,
  ): Promise<number[]> {
    const relatedIds = new Set<number>();

    for (const fact of context.facts) {
      if (
        fact.source_entity_id === anchorEntityId &&
        fact.target_entity_id !== anchorEntityId
      ) {
        relatedIds.add(fact.target_entity_id);
      }
      if (
        fact.target_entity_id === anchorEntityId &&
        fact.source_entity_id !== anchorEntityId
      ) {
        relatedIds.add(fact.source_entity_id);
      }
    }

    for (const event of context.events) {
      if (
        event.primary_actor_entity_id != null &&
        event.primary_actor_entity_id !== anchorEntityId
      ) {
        relatedIds.add(event.primary_actor_entity_id);
      }
      for (const participantId of extractParticipantEntityIds(event.participants)) {
        if (participantId !== anchorEntityId) {
          relatedIds.add(participantId);
        }
      }
    }

    const pointerKeys = new Set<string>();
    for (const episode of context.episodes) {
      for (const pointerKey of episode.entity_pointer_keys) {
        if (pointerKey.length > 0) {
          pointerKeys.add(pointerKey);
        }
      }
    }

    for (const pointerKey of pointerKeys) {
      const entity = await this.retrievalRepo.resolveEntityByPointer(
        pointerKey,
        viewerContext.viewer_agent_id,
      );
      if (entity && entity.id !== anchorEntityId) {
        relatedIds.add(entity.id);
      }
    }

    return [...relatedIds];
  }

  async localizeSeedsHybrid(
    query: string,
    viewerContext: ViewerContext,
    limit = 10,
    queryEmbedding?: Float32Array,
    modelId?: string,
  ): Promise<SeedCandidate[]> {
    const lexicalResults = await this.searchVisibleNarrative(
      query,
      viewerContext,
    );

    const lexicalRankByRef = new Map<string, number>();
    for (let i = 0; i < lexicalResults.length; i += 1) {
      lexicalRankByRef.set(lexicalResults[i].source_ref, i + 1);
    }

    const semanticRankByRef = new Map<
      string,
      { rank: number; nodeKind: string }
    >();
    const embeddingCount = await this.retrievalRepo.countNodeEmbeddings();
    if (embeddingCount > 0 && queryEmbedding) {
      const neighbors = await this.embeddingService.queryNearestNeighbors(
        queryEmbedding,
        {
          agentId: viewerContext.viewer_agent_id,
          limit: Math.max(limit * 4, 20),
          modelId,
        },
      );
      for (let i = 0; i < neighbors.length; i += 1) {
        semanticRankByRef.set(neighbors[i].nodeRef, {
          rank: i + 1,
          nodeKind: neighbors[i].nodeKind,
        });
      }
    }

    const fused = new Map<string, SeedCandidate>();
    for (let i = 0; i < lexicalResults.length; i += 1) {
      const row = lexicalResults[i];
      const nodeKind = this.parseNodeRefKind(row.source_ref);
      if (!nodeKind) {
        continue;
      }

      const lexicalRrf = this.rrf(i + 1);
      const semanticMatch = semanticRankByRef.get(row.source_ref);
      const semanticRrf = semanticMatch ? this.rrf(semanticMatch.rank) : 0;
      const fusedScore =
        semanticRankByRef.size > 0
          ? 0.5 * lexicalRrf + 0.5 * semanticRrf
          : lexicalRrf;

      fused.set(row.source_ref, {
        node_ref: row.source_ref,
        node_kind: nodeKind,
        lexical_score: lexicalRrf,
        semantic_score: semanticRrf,
        fused_score: fusedScore,
        source_scope: row.scope,
      });
    }

    for (const [nodeRef, semantic] of semanticRankByRef.entries()) {
      if (fused.has(nodeRef)) {
        continue;
      }
      const nodeKind = this.parseNodeRefKind(nodeRef);
      if (!nodeKind) {
        continue;
      }
      const semanticRrf = this.rrf(semantic.rank);
      fused.set(nodeRef, {
        node_ref: nodeRef as NodeRef,
        node_kind: nodeKind,
        lexical_score: 0,
        semantic_score: semanticRrf,
        fused_score: 0.5 * semanticRrf,
        source_scope: this.scopeFromNodeKind(nodeKind),
      });
    }

    const selected: SeedCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of Array.from(fused.values()).sort(
      (a, b) => b.fused_score - a.fused_score,
    )) {
      if (seen.has(candidate.node_ref)) {
        continue;
      }
      selected.push(candidate);
      seen.add(candidate.node_ref);
      if (selected.length >= limit) {
        break;
      }
    }

    return selected;
  }

  async resolveRedirect(name: string, ownerAgentId?: string): Promise<string> {
    return this.retrievalRepo.resolveRedirect(name, ownerAgentId);
  }

  async resolveEntityByPointer(
    pointerKey: string,
    viewerAgentId: string,
  ): Promise<EntityNode | null> {
    return this.retrievalRepo.resolveEntityByPointer(pointerKey, viewerAgentId);
  }

  private rrf(rank: number): number {
    return 1 / (60 + rank);
  }

  private parseNodeRefKind(nodeRef: string): NodeRefKind | null {
    try {
      return parseGraphNodeRef(nodeRef).kind;
    } catch {
      return null;
    }
  }

  private scopeFromNodeKind(
    nodeKind: NodeRefKind,
  ): "private" | "area" | "world" {
    const kind = nodeKind as string;
    if (
      kind === "assertion" ||
      kind === "evaluation" ||
      kind === "commitment" ||
      kind === "episode"
    ) {
      return "private";
    }
    return "world";
  }
}

function extractParticipantEntityIds(participantsJson: string | null): number[] {
  if (!participantsJson) {
    return [];
  }
  try {
    const parsed = JSON.parse(participantsJson) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const ids: number[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "string") {
        continue;
      }
      const match = entry.match(/^entity:(\d+)$/);
      if (!match) {
        continue;
      }
      const entityId = Number(match[1]);
      if (Number.isInteger(entityId) && entityId > 0) {
        ids.push(entityId);
      }
    }
    return ids;
  } catch {
    return [];
  }
}
