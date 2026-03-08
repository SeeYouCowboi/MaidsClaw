import type { Database } from "bun:sqlite";
import type { AliasService } from "./alias.js";
import type { RetrievalService } from "./retrieval.js";
import { MAX_INTEGER } from "./schema.js";
import type {
  BeamEdge,
  BeamPath,
  EvidencePath,
  NavigatorEdgeKind,
  NavigatorResult,
  NodeRef,
  NodeRefKind,
  PathScore,
  QueryType,
  SeedCandidate,
  ViewerContext,
} from "./types.js";

type ModelProviderClientLike = {
  rewriteQuery?: (query: string) => string;
  tieBreak?: (query: string, candidateA: string, candidateB: string) => number;
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

const QUERY_TYPE_PRIORITY = {
  entity: ["fact_relation", "participant", "fact_support", "semantic_similar"],
  event: ["same_episode", "temporal_prev", "temporal_next", "causal", "fact_support"],
  why: ["causal", "fact_support", "fact_relation", "temporal_prev"],
  relationship: ["fact_relation", "fact_support", "participant", "semantic_similar"],
  timeline: ["temporal_prev", "temporal_next", "same_episode", "causal", "fact_support"],
  state: ["fact_relation", "conflict_or_update", "fact_support", "temporal_next"],
} satisfies Record<QueryType, NavigatorEdgeKind[]>;

const WHY_KEYWORDS = ["why", "because", "reason", "cause"];
const TIMELINE_KEYWORDS = ["when", "timeline", "before", "after", "sequence"];
const RELATIONSHIP_KEYWORDS = ["relationship", "between", "connected", "related"];
const STATE_KEYWORDS = ["state", "status", "current", "now", "is"];
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
  "private_event",
  "private_belief",
]);

export class GraphNavigator {
  constructor(
    private readonly db: Database,
    private readonly retrieval: RetrievalService,
    private readonly alias: AliasService,
    _modelProvider?: ModelProviderClientLike,
  ) {}

  async explore(
    query: string,
    viewerContext: ViewerContext,
    options?: NavigatorOptions,
  ): Promise<NavigatorResult> {
    if (!viewerContext || !viewerContext.viewer_agent_id) {
      throw new Error("viewerContext is required");
    }

    const opts = this.normalizeOptions(options);
    const analysis = this.analyzeQuery(query, viewerContext);

    const rawSeeds = await this.retrieval.localizeSeedsHybrid(query, viewerContext, opts.seedCount);
    const fallbackSeeds = this.fallbackSeedsFromAnalysis(rawSeeds, analysis);
    const visibleSeeds = fallbackSeeds.filter((seed) => this.isNodeVisible(seed.node_ref, viewerContext));

    if (visibleSeeds.length === 0) {
      return {
        query,
        query_type: analysis.query_type,
        evidence_paths: [],
      };
    }

    const seedScores = this.computeSeedScores(visibleSeeds, analysis);
    const expandedPaths = this.expandTypedBeam(visibleSeeds, seedScores, analysis.query_type, viewerContext, opts);
    const rerankedPaths = this.rerankPaths(expandedPaths, seedScores, analysis.query_type, opts.maxDepth);
    const assembled = this.assembleEvidence(rerankedPaths, viewerContext, opts.maxCandidates);

    return {
      query,
      query_type: analysis.query_type,
      evidence_paths: assembled,
    };
  }

  private normalizeOptions(options?: NavigatorOptions): Required<NavigatorOptions> {
    return {
      seedCount: Math.min(32, Math.max(1, options?.seedCount ?? DEFAULT_OPTIONS.seedCount)),
      beamWidth: Math.min(32, Math.max(1, options?.beamWidth ?? DEFAULT_OPTIONS.beamWidth)),
      maxDepth: Math.min(2, Math.max(1, options?.maxDepth ?? DEFAULT_OPTIONS.maxDepth)),
      maxCandidates: Math.min(64, Math.max(1, options?.maxCandidates ?? DEFAULT_OPTIONS.maxCandidates)),
    };
  }

  private analyzeQuery(query: string, viewerContext: ViewerContext): QueryAnalysis {
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
    if (this.includesAny(normalized, WHY_KEYWORDS)) {
      queryType = "why";
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

  private computeSeedScores(seeds: SeedCandidate[], analysis: QueryAnalysis): Map<NodeRef, number> {
    const salienceByRef = this.loadSalienceForRefs(seeds.map((seed) => seed.node_ref));
    const scores = new Map<NodeRef, number>();

    for (const seed of seeds) {
      const aliasBonus = this.isAliasMatchedSeed(seed, analysis) ? 1 : 0;
      const nodeTypePrior = this.nodeTypePrior(analysis.query_type, seed.node_kind);
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
      entity: { entity: 1, fact: 0.75, event: 0.4, private_event: 0.4, private_belief: 0.7 },
      event: { event: 1, fact: 0.7, entity: 0.55, private_event: 0.8, private_belief: 0.45 },
      why: { event: 1, fact: 0.85, entity: 0.5, private_event: 0.85, private_belief: 0.65 },
      relationship: { entity: 1, fact: 0.9, event: 0.45, private_event: 0.45, private_belief: 0.7 },
      timeline: { event: 1, fact: 0.5, entity: 0.3, private_event: 0.85, private_belief: 0.45 },
      state: { fact: 1, entity: 0.85, event: 0.5, private_event: 0.5, private_belief: 0.8 },
    } satisfies Record<QueryType, Record<NodeRefKind, number>>;

    return priors[queryType][nodeKind] ?? 0.2;
  }

  private expandTypedBeam(
    seeds: SeedCandidate[],
    seedScores: Map<NodeRef, number>,
    queryType: QueryType,
    viewerContext: ViewerContext,
    options: Required<NavigatorOptions>,
  ): InternalBeamPath[] {
    const sortedSeeds = [...seeds].sort((a, b) => (seedScores.get(b.node_ref) ?? 0) - (seedScores.get(a.node_ref) ?? 0));
    let currentLayer: InternalBeamPath[] = sortedSeeds.slice(0, options.beamWidth).map((seed) => ({
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
      const neighborMap = this.fetchNeighborsByFrontier(frontier, viewerContext);

      const nextCandidates: InternalBeamPath[] = [];
      for (const pathItem of currentLayer) {
        const tail = pathItem.path.nodes[pathItem.path.nodes.length - 1];
        const neighbors = [...(neighborMap.get(tail) ?? [])];
        neighbors.sort((a, b) => this.compareNeighborEdges(a, b, queryType));

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
      unique.sort((a, b) => this.preliminaryPathScore(b, seedScores, queryType) - this.preliminaryPathScore(a, seedScores, queryType));
      currentLayer = unique.slice(0, options.beamWidth);
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
  ): Map<NodeRef, InternalBeamEdge[]> {
    const map = new Map<NodeRef, InternalBeamEdge[]>();

    this.expandEventFrontier(frontier.get("event"), viewerContext, map);
    this.expandEntityFrontier(frontier.get("entity"), viewerContext, map);
    this.expandFactFrontier(frontier.get("fact"), viewerContext, map);
    this.expandPrivateEventFrontier(frontier.get("private_event"), viewerContext, map);
    this.expandPrivateBeliefFrontier(frontier.get("private_belief"), viewerContext, map);

    return map;
  }

  private expandEventFrontier(frontier: Set<NodeRef> | undefined, viewerContext: ViewerContext, map: Map<NodeRef, InternalBeamEdge[]>): void {
    if (!frontier || frontier.size === 0) {
      return;
    }

    const ids = this.extractIdsFromRefs(frontier, "event");
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(",");

    const logicRows = this.db
      .prepare(
        `SELECT source_event_id, target_event_id, relation_type, created_at
         FROM logic_edges
         WHERE source_event_id IN (${placeholders}) OR target_event_id IN (${placeholders})`,
      )
      .all(...ids, ...ids) as Array<{
      source_event_id: number;
      target_event_id: number;
      relation_type: NavigatorEdgeKind;
      created_at: number;
    }>;

    for (const row of logicRows) {
      const srcRef = `event:${row.source_event_id}` as NodeRef;
      const dstRef = `event:${row.target_event_id}` as NodeRef;
      if (frontier.has(srcRef) && this.isNodeVisible(dstRef, viewerContext)) {
        this.pushEdge(map, srcRef, {
          from: srcRef,
          to: dstRef,
          kind: row.relation_type,
          weight: 1,
          timestamp: row.created_at,
          summary: row.relation_type,
          canonical_fact_id: null,
          canonical_evidence: true,
        });
      }

      if (frontier.has(dstRef) && this.isNodeVisible(srcRef, viewerContext)) {
        const reverseKind = this.reverseTemporalKind(row.relation_type);
        this.pushEdge(map, dstRef, {
          from: dstRef,
          to: srcRef,
          kind: reverseKind,
          weight: 1,
          timestamp: row.created_at,
          summary: reverseKind,
          canonical_fact_id: null,
          canonical_evidence: true,
        });
      }
    }

    const factRows = this.db
      .prepare(
        `SELECT id, source_event_id, predicate, t_valid
         FROM fact_edges
         WHERE t_invalid = ? AND source_event_id IN (${placeholders})`,
      )
      .all(MAX_INTEGER, ...ids) as Array<{ id: number; source_event_id: number; predicate: string; t_valid: number }>;

    for (const row of factRows) {
      const srcRef = `event:${row.source_event_id}` as NodeRef;
      const factRef = `fact:${row.id}` as NodeRef;
      if (!this.isNodeVisible(factRef, viewerContext)) {
        continue;
      }
      this.pushEdge(map, srcRef, {
        from: srcRef,
        to: factRef,
        kind: "fact_support",
        weight: 0.95,
        timestamp: row.t_valid,
        summary: row.predicate,
        canonical_fact_id: row.id,
        canonical_evidence: true,
      });
    }

    const eventRows = this.db
      .prepare(
        `SELECT id, participants, primary_actor_entity_id, timestamp, summary
         FROM event_nodes
         WHERE id IN (${placeholders})
           AND (
             visibility_scope='world_public'
             OR (visibility_scope='area_visible' AND location_entity_id=?)
           )`,
      )
      .all(...ids, viewerContext.current_area_id) as Array<{
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

    this.expandSemanticEdges(frontier, viewerContext, map);
  }

  private expandEntityFrontier(frontier: Set<NodeRef> | undefined, viewerContext: ViewerContext, map: Map<NodeRef, InternalBeamEdge[]>): void {
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
    const participantSql =
      `SELECT id, participants, primary_actor_entity_id, timestamp, summary
       FROM event_nodes
       WHERE (
         primary_actor_entity_id IN (${placeholders})` +
      (participantConditions.length > 0 ? ` OR ${participantConditions}` : "") +
      `)
       AND (
         visibility_scope='world_public'
         OR (visibility_scope='area_visible' AND location_entity_id=?)
       )`;

    const participantRows = this.db.prepare(participantSql).all(
      ...ids,
      ...ids.map((id) => `%entity:${id}%`),
      viewerContext.current_area_id,
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

    const beliefRows = this.db
      .prepare(
        `SELECT id, source_entity_id, target_entity_id, predicate, source_event_ref, created_at
         FROM agent_fact_overlay
         WHERE agent_id = ? AND (source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders}))`,
      )
      .all(viewerContext.viewer_agent_id, ...ids, ...ids) as Array<{
      id: number;
      source_entity_id: number;
      target_entity_id: number;
      predicate: string;
      source_event_ref: NodeRef | null;
      created_at: number;
    }>;

    for (const row of beliefRows) {
      const beliefRef = `private_belief:${row.id}` as NodeRef;
      if (!this.isNodeVisible(beliefRef, viewerContext)) {
        continue;
      }

      const sourceRef = `entity:${row.source_entity_id}` as NodeRef;
      const targetRef = `entity:${row.target_entity_id}` as NodeRef;

      if (frontier.has(sourceRef)) {
        this.pushEdge(map, sourceRef, {
          from: sourceRef,
          to: beliefRef,
          kind: "fact_relation",
          weight: 0.7,
          timestamp: row.created_at,
          summary: row.predicate,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }
      if (frontier.has(targetRef)) {
        this.pushEdge(map, targetRef, {
          from: targetRef,
          to: beliefRef,
          kind: "fact_relation",
          weight: 0.7,
          timestamp: row.created_at,
          summary: row.predicate,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }
    }

    this.expandSemanticEdges(frontier, viewerContext, map);
  }

  private expandFactFrontier(frontier: Set<NodeRef> | undefined, viewerContext: ViewerContext, map: Map<NodeRef, InternalBeamEdge[]>): void {
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

    this.expandSemanticEdges(frontier, viewerContext, map);
  }

  private expandPrivateEventFrontier(
    frontier: Set<NodeRef> | undefined,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
  ): void {
    if (!frontier || frontier.size === 0) {
      return;
    }

    const ids = this.extractIdsFromRefs(frontier, "private_event");
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(",");

    const rows = this.db
      .prepare(
        `SELECT id, event_id, primary_actor_entity_id, location_entity_id, projectable_summary, created_at
         FROM agent_event_overlay
         WHERE agent_id=? AND id IN (${placeholders})`,
      )
      .all(viewerContext.viewer_agent_id, ...ids) as Array<{
      id: number;
      event_id: number | null;
      primary_actor_entity_id: number | null;
      location_entity_id: number | null;
      projectable_summary: string | null;
      created_at: number;
    }>;

    for (const row of rows) {
      const privateRef = `private_event:${row.id}` as NodeRef;
      if (row.event_id !== null) {
        const eventRef = `event:${row.event_id}` as NodeRef;
        if (this.isNodeVisible(eventRef, viewerContext)) {
          this.pushEdge(map, privateRef, {
            from: privateRef,
            to: eventRef,
            kind: "same_episode",
            weight: 0.85,
            timestamp: row.created_at,
            summary: row.projectable_summary,
            canonical_fact_id: null,
            canonical_evidence: false,
          });
        }
      }

      if (row.primary_actor_entity_id !== null) {
        const actorRef = `entity:${row.primary_actor_entity_id}` as NodeRef;
        if (this.isNodeVisible(actorRef, viewerContext)) {
          this.pushEdge(map, privateRef, {
            from: privateRef,
            to: actorRef,
            kind: "participant",
            weight: 0.8,
            timestamp: row.created_at,
            summary: row.projectable_summary,
            canonical_fact_id: null,
            canonical_evidence: false,
          });
        }
      }

      if (row.location_entity_id !== null) {
        const locationRef = `entity:${row.location_entity_id}` as NodeRef;
        if (this.isNodeVisible(locationRef, viewerContext)) {
          this.pushEdge(map, privateRef, {
            from: privateRef,
            to: locationRef,
            kind: "entity_bridge",
            weight: 0.65,
            timestamp: row.created_at,
            summary: row.projectable_summary,
            canonical_fact_id: null,
            canonical_evidence: false,
          });
        }
      }
    }

    this.expandSemanticEdges(frontier, viewerContext, map, true);
  }

  private expandPrivateBeliefFrontier(
    frontier: Set<NodeRef> | undefined,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
  ): void {
    if (!frontier || frontier.size === 0) {
      return;
    }

    const ids = this.extractIdsFromRefs(frontier, "private_belief");
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(",");

    const rows = this.db
      .prepare(
        `SELECT id, source_entity_id, target_entity_id, predicate, source_event_ref, created_at
         FROM agent_fact_overlay
         WHERE agent_id=? AND id IN (${placeholders})`,
      )
      .all(viewerContext.viewer_agent_id, ...ids) as Array<{
      id: number;
      source_entity_id: number;
      target_entity_id: number;
      predicate: string;
      source_event_ref: NodeRef | null;
      created_at: number;
    }>;

    for (const row of rows) {
      const beliefRef = `private_belief:${row.id}` as NodeRef;
      const sourceRef = `entity:${row.source_entity_id}` as NodeRef;
      const targetRef = `entity:${row.target_entity_id}` as NodeRef;

      if (this.isNodeVisible(sourceRef, viewerContext)) {
        this.pushEdge(map, beliefRef, {
          from: beliefRef,
          to: sourceRef,
          kind: "fact_relation",
          weight: 0.75,
          timestamp: row.created_at,
          summary: row.predicate,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }

      if (this.isNodeVisible(targetRef, viewerContext)) {
        this.pushEdge(map, beliefRef, {
          from: beliefRef,
          to: targetRef,
          kind: "fact_relation",
          weight: 0.75,
          timestamp: row.created_at,
          summary: row.predicate,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }

      if (row.source_event_ref && this.isNodeVisible(row.source_event_ref, viewerContext)) {
        this.pushEdge(map, beliefRef, {
          from: beliefRef,
          to: row.source_event_ref,
          kind: "fact_support",
          weight: 0.7,
          timestamp: row.created_at,
          summary: row.predicate,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }
    }

    this.expandSemanticEdges(frontier, viewerContext, map, true);
  }

  private expandSemanticEdges(
    frontier: Set<NodeRef>,
    viewerContext: ViewerContext,
    map: Map<NodeRef, InternalBeamEdge[]>,
    privateFrontier = false,
  ): void {
    const refs = Array.from(frontier);
    if (refs.length === 0) {
      return;
    }
    const placeholders = refs.map(() => "?").join(",");

    const rows = this.db
      .prepare(
        `SELECT source_node_ref, target_node_ref, relation_type, weight, created_at
         FROM semantic_edges
         WHERE source_node_ref IN (${placeholders}) OR target_node_ref IN (${placeholders})`,
      )
      .all(...refs, ...refs) as Array<{
      source_node_ref: NodeRef;
      target_node_ref: NodeRef;
      relation_type: NavigatorEdgeKind;
      weight: number;
      created_at: number;
    }>;

    for (const row of rows) {
      const directionPairs: Array<{ from: NodeRef; to: NodeRef }> = [];
      if (frontier.has(row.source_node_ref)) {
        directionPairs.push({ from: row.source_node_ref, to: row.target_node_ref });
      }
      if (frontier.has(row.target_node_ref)) {
        directionPairs.push({ from: row.target_node_ref, to: row.source_node_ref });
      }

      for (const pair of directionPairs) {
        if (!this.isNodeVisible(pair.from, viewerContext) || !this.isNodeVisible(pair.to, viewerContext)) {
          continue;
        }
        if (privateFrontier && !this.isSameAgentPrivateCompatibility(pair.from, pair.to, viewerContext.viewer_agent_id)) {
          continue;
        }

        this.pushEdge(map, pair.from, {
          from: pair.from,
          to: pair.to,
          kind: row.relation_type,
          weight: this.clamp01(row.weight),
          timestamp: row.created_at,
          summary: row.relation_type,
          canonical_fact_id: null,
          canonical_evidence: false,
        });
      }
    }
  }

  private isSameAgentPrivateCompatibility(from: NodeRef, to: NodeRef, viewerAgentId: string): boolean {
    const fromKind = this.parseNodeRef(from)?.kind;
    const toKind = this.parseNodeRef(to)?.kind;
    const fromPrivate = fromKind === "private_event" || fromKind === "private_belief";
    const toPrivate = toKind === "private_event" || toKind === "private_belief";

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
    if (parsed.kind === "private_event") {
      const row = this.db
        .prepare("SELECT agent_id FROM agent_event_overlay WHERE id=?")
        .get(parsed.id) as { agent_id: string } | undefined;
      return row?.agent_id ?? null;
    }
    if (parsed.kind === "private_belief") {
      const row = this.db
        .prepare("SELECT agent_id FROM agent_fact_overlay WHERE id=?")
        .get(parsed.id) as { agent_id: string } | undefined;
      return row?.agent_id ?? null;
    }
    return null;
  }

  private compareNeighborEdges(a: InternalBeamEdge, b: InternalBeamEdge, queryType: QueryType): number {
    const scoreA = this.edgePriorityScore(a.kind, queryType);
    const scoreB = this.edgePriorityScore(b.kind, queryType);
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    if (a.weight !== b.weight) {
      return b.weight - a.weight;
    }
    return (b.timestamp ?? 0) - (a.timestamp ?? 0);
  }

  private edgePriorityScore(kind: NavigatorEdgeKind, queryType: QueryType): number {
    const ordered = QUERY_TYPE_PRIORITY[queryType];
    const index = ordered.indexOf(kind);
    if (index === -1) {
      return 0.1;
    }
    return 1 - index / Math.max(ordered.length, 1);
  }

  private preliminaryPathScore(path: InternalBeamPath, seedScores: Map<NodeRef, number>, queryType: QueryType): number {
    const seed = seedScores.get(path.path.seed) ?? 0;
    const edgeScore = path.internal_edges.length === 0
      ? 0
      : path.internal_edges.reduce((acc, edge) => acc + this.edgePriorityScore(edge.kind, queryType), 0) /
        path.internal_edges.length;
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
  ): Array<{ path: InternalBeamPath; score: PathScore }> {
    const snapshots = this.loadNodeSnapshots(paths.flatMap((p) => p.path.nodes));

    const scored = paths.map((path) => {
      const seedScore = seedScores.get(path.path.seed) ?? 0;
      const edgeTypeScore = this.average(path.internal_edges.map((edge) => this.edgePriorityScore(edge.kind, queryType)));
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
    this.populateSnapshots(
      map,
      "private_event",
      byKind.get("private_event"),
      "agent_event_overlay",
      "projectable_summary",
      "created_at",
    );
    this.populateSnapshots(
      map,
      "private_belief",
      byKind.get("private_belief"),
      "agent_fact_overlay",
      "predicate",
      "created_at",
    );

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
    const topKinds = new Set(QUERY_TYPE_PRIORITY[queryType].slice(0, 2));
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
    const visibleNodes = evidencePath.path.nodes.filter((node) => this.isNodeVisible(node, viewerContext));
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
    };

    if (filtered.path.nodes.length === 0) {
      return null;
    }
    return filtered;
  }

  private isNodeVisible(nodeRef: NodeRef, viewerContext: ViewerContext): boolean {
    const parsed = this.parseNodeRef(nodeRef);
    if (!parsed) {
      return false;
    }

    if (parsed.kind === "entity") {
      const row = this.db
        .prepare("SELECT memory_scope, owner_agent_id FROM entity_nodes WHERE id = ?")
        .get(parsed.id) as { memory_scope: "shared_public" | "private_overlay"; owner_agent_id: string | null } | undefined;
      if (!row) {
        return false;
      }
      return (
        row.memory_scope === "shared_public" ||
        (row.memory_scope === "private_overlay" && row.owner_agent_id === viewerContext.viewer_agent_id)
      );
    }

    if (parsed.kind === "private_event") {
      const row = this.db
        .prepare("SELECT agent_id FROM agent_event_overlay WHERE id = ?")
        .get(parsed.id) as { agent_id: string } | undefined;
      return row?.agent_id === viewerContext.viewer_agent_id;
    }

    if (parsed.kind === "private_belief") {
      const row = this.db
        .prepare("SELECT agent_id FROM agent_fact_overlay WHERE id = ?")
        .get(parsed.id) as { agent_id: string } | undefined;
      return row?.agent_id === viewerContext.viewer_agent_id;
    }

    if (parsed.kind === "event") {
      const row = this.db
        .prepare("SELECT visibility_scope, location_entity_id FROM event_nodes WHERE id = ?")
        .get(parsed.id) as { visibility_scope: "world_public" | "area_visible"; location_entity_id: number } | undefined;
      if (!row) {
        return false;
      }
      return (
        row.visibility_scope === "world_public" ||
        (row.visibility_scope === "area_visible" && row.location_entity_id === viewerContext.current_area_id)
      );
    }

    if (parsed.kind === "fact") {
      const row = this.db
        .prepare("SELECT id FROM fact_edges WHERE id = ? AND t_invalid = ?")
        .get(parsed.id, MAX_INTEGER) as { id: number } | undefined;
      return Boolean(row);
    }

    return false;
  }

  private pushEdge(map: Map<NodeRef, InternalBeamEdge[]>, from: NodeRef, edge: InternalBeamEdge): void {
    const list = map.get(from) ?? [];
    list.push(edge);
    map.set(from, list);
  }

  private parseNodeRef(ref: NodeRef): { kind: NodeRefKind; id: number } | null {
    const [kindRaw, idRaw] = String(ref).split(":");
    if (!kindRaw || !idRaw) {
      return null;
    }
    if (!KNOWN_NODE_KINDS.has(kindRaw as NodeRefKind)) {
      return null;
    }
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      return null;
    }
    return { kind: kindRaw as NodeRefKind, id };
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

  private reverseTemporalKind(kind: NavigatorEdgeKind): NavigatorEdgeKind {
    if (kind === "temporal_prev") {
      return "temporal_next";
    }
    if (kind === "temporal_next") {
      return "temporal_prev";
    }
    return kind;
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
