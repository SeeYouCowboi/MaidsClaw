import type postgres from "postgres";
import { parseGraphNodeRef } from "../../../memory/contracts/graph-node-ref.js";
import {
  EDGE_SEMANTICS_BY_TABLE,
  FACT_EDGE_PREDICATE_WILDCARD,
  getRelationContract,
} from "../../../memory/contracts/relation-contract.js";
import type {
  UnifiedEdgeReadOptions,
  UnifiedEdgeReadRepo,
  UnifiedEdgeRecord,
} from "../contracts/unified-edge-read-repo.js";

const PG_MAX_BIGINT = "9223372036854775807";

const DEFAULT_ANCHOR_LIMIT = 100;
const DEFAULT_CHAIN_DEPTH = 2;
const DEFAULT_CHAIN_MAX_EDGES = 50;
const DEFAULT_SEMANTIC_TOP_K = 10;

type LogicRow = {
  id: number | string;
  source_event_id: number | string;
  target_event_id: number | string;
  relation_type: string;
  weight: number | string | null;
  source_kind: string | null;
  source_ref: string | null;
  created_at: number | string;
};

type MemoryRow = {
  id: number | string;
  source_node_ref: string;
  target_node_ref: string;
  relation_type: string;
  strength: number | string;
  source_kind: string;
  source_ref: string;
  created_at: number | string;
};

type SemanticRow = {
  id: number | string;
  source: string;
  target: string;
  relation_type: string;
  weight: number | string;
  source_kind: string | null;
  source_ref: string | null;
  created_at: number | string;
};

type FactRow = {
  id: number | string;
  source_entity_id: number | string;
  target_entity_id: number | string;
  predicate: string;
  fact_text: string | null;
  source_kind: string | null;
  source_ref: string | null;
  owner_agent_id: string | null;
  t_valid: number | string;
  t_invalid: number | string;
  t_created: number | string;
};

export class PgUnifiedEdgeReadRepo implements UnifiedEdgeReadRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async edgesFrom(nodeRef: string, opts: UnifiedEdgeReadOptions = {}): Promise<UnifiedEdgeRecord[]> {
    const limit = this.resolveLimit(opts.limit, DEFAULT_ANCHOR_LIMIT);
    const edgeRows = await Promise.all([
      this.readLogicEdgesFrom(nodeRef, opts, limit),
      this.readMemoryEdgesFrom(nodeRef, opts, limit),
      this.readSemanticEdgesFrom(nodeRef, opts, limit),
      this.readFactEdgesFrom(nodeRef, opts, limit),
    ]);
    const cascadeFiltered = await this.applyEndpointCascade(edgeRows.flat(), opts);
    return this.sortAndClamp(cascadeFiltered, limit);
  }

  async edgesTo(nodeRef: string, opts: UnifiedEdgeReadOptions = {}): Promise<UnifiedEdgeRecord[]> {
    const limit = this.resolveLimit(opts.limit, DEFAULT_ANCHOR_LIMIT);
    const edgeRows = await Promise.all([
      this.readLogicEdgesTo(nodeRef, opts, limit),
      this.readMemoryEdgesTo(nodeRef, opts, limit),
      this.readSemanticEdgesTo(nodeRef, opts, limit),
      this.readFactEdgesTo(nodeRef, opts, limit),
    ]);
    const cascadeFiltered = await this.applyEndpointCascade(edgeRows.flat(), opts);
    return this.sortAndClamp(cascadeFiltered, limit);
  }

  async edgesAround(nodeRef: string, opts: UnifiedEdgeReadOptions = {}): Promise<UnifiedEdgeRecord[]> {
    const limit = this.resolveLimit(opts.limit, DEFAULT_ANCHOR_LIMIT);
    const [from, to] = await Promise.all([
      this.edgesFrom(nodeRef, { ...opts, limit }),
      this.edgesTo(nodeRef, { ...opts, limit }),
    ]);
    return this.sortAndClamp(this.dedupeByPhysicalEdge([...from, ...to]), limit);
  }

  async worldStateOf(entityRef: string, opts: UnifiedEdgeReadOptions = {}): Promise<UnifiedEdgeRecord[]> {
    const entityId = this.parseNodeId(entityRef, "entity");
    if (entityId === null) {
      return [];
    }

    const limit = this.resolveLimit(opts.limit, DEFAULT_ANCHOR_LIMIT);
    const ownerVisibility = this.factOwnerVisibility(opts.viewerAgentId);
    const temporalFilter = this.factTemporalFilter(opts);
    const asOfFilter = this.createdAtAsOfFilter(opts.asOf);

    const [factRows, publishedAsRows] = await Promise.all([
      this.sql<FactRow[]>`
        SELECT
          id,
          source_entity_id,
          target_entity_id,
          predicate,
          fact_text,
          source_kind,
          source_ref,
          owner_agent_id,
          t_valid,
          t_invalid,
          t_created
        FROM fact_edges
        WHERE (source_entity_id = ${entityId} OR target_entity_id = ${entityId})
          AND fact_text IS NOT NULL
          AND predicate NOT IN ('explicit_assertion', 'explicit_evaluation', 'explicit_commitment')
          AND (source_kind IS NULL OR source_kind != 'migration')
          ${ownerVisibility}
          ${temporalFilter}
        ORDER BY t_valid DESC, t_created DESC, id DESC
        LIMIT ${limit}
      `,
      this.sql<MemoryRow[]>`
        SELECT id, source_node_ref, target_node_ref, relation_type, strength, source_kind, source_ref, created_at
        FROM memory_relations
        WHERE relation_type = 'published_as'
          AND target_node_ref = ${entityRef}
          ${asOfFilter}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `,
    ]);

    const combined = [
      ...factRows.map((row) => this.normalizeFactRow(row)),
      ...publishedAsRows.map((row) => this.normalizeMemoryRow(row)),
    ];

    const cascadeFiltered = await this.applyEndpointCascade(combined, opts);
    return this.sortAndClamp(cascadeFiltered, limit);
  }

  async cognitiveContextOf(nodeRef: string, opts: UnifiedEdgeReadOptions = {}): Promise<UnifiedEdgeRecord[]> {
    const limit = this.resolveLimit(opts.limit, DEFAULT_ANCHOR_LIMIT);
    const asOfFilter = this.createdAtAsOfFilter(opts.asOf);

    const rows = await this.sql<MemoryRow[]>`
      SELECT id, source_node_ref, target_node_ref, relation_type, strength, source_kind, source_ref, created_at
      FROM memory_relations
      WHERE (source_node_ref = ${nodeRef} OR target_node_ref = ${nodeRef})
        ${asOfFilter}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;

    const records = rows.map((row) => this.normalizeMemoryRow(row));
    return this.applyEndpointCascade(records, opts);
  }

  async narrativeChainOf(
    eventRef: string,
    opts: UnifiedEdgeReadOptions & { maxDepth?: number; maxEdges?: number } = {},
  ): Promise<UnifiedEdgeRecord[]> {
    const rootEventId = this.parseNodeId(eventRef, "event");
    if (rootEventId === null) {
      return [];
    }

    const maxDepth = Math.max(1, opts.maxDepth ?? DEFAULT_CHAIN_DEPTH);
    const maxEdges = this.resolveLimit(opts.maxEdges ?? opts.limit, DEFAULT_CHAIN_MAX_EDGES);
    const asOfFilter = this.createdAtAsOfFilter(opts.asOf);

    const visitedEventIds = new Set<number>([rootEventId]);
    let frontier = [rootEventId];
    const edgeById = new Map<string, UnifiedEdgeRecord>();

    for (let depth = 0; depth < maxDepth && frontier.length > 0 && edgeById.size < maxEdges; depth += 1) {
      const remaining = maxEdges - edgeById.size;
      const rows = await this.sql<LogicRow[]>`
        SELECT id, source_event_id, target_event_id, relation_type, weight, source_kind, source_ref, created_at
        FROM logic_edges
        WHERE (source_event_id IN ${this.sql(frontier)} OR target_event_id IN ${this.sql(frontier)})
          ${asOfFilter}
        ORDER BY created_at DESC, id DESC
        LIMIT ${Math.max(remaining * 2, remaining)}
      `;

      const nextFrontier = new Set<number>();
      for (const row of rows) {
        const normalized = this.normalizeLogicRow(row);
        const key = this.edgeKey(normalized);
        if (!edgeById.has(key)) {
          edgeById.set(key, normalized);
        }

        const sourceId = Number(row.source_event_id);
        const targetId = Number(row.target_event_id);
        if (!visitedEventIds.has(sourceId)) {
          visitedEventIds.add(sourceId);
          nextFrontier.add(sourceId);
        }
        if (!visitedEventIds.has(targetId)) {
          visitedEventIds.add(targetId);
          nextFrontier.add(targetId);
        }
        if (edgeById.size >= maxEdges) {
          break;
        }
      }

      frontier = Array.from(nextFrontier);
    }

    const cascadeFiltered = await this.applyEndpointCascade(
      Array.from(edgeById.values()),
      opts,
    );
    return this.sortAndClamp(cascadeFiltered, maxEdges);
  }

  async semanticNeighborsOf(
    nodeRef: string,
    opts: UnifiedEdgeReadOptions & { topK?: number } = {},
  ): Promise<UnifiedEdgeRecord[]> {
    const topK = this.resolveLimit(opts.topK, DEFAULT_SEMANTIC_TOP_K);
    const finalLimit = this.resolveLimit(opts.limit, topK);
    const asOfFilter = this.createdAtAsOfFilter(opts.asOf);

    const rows = await this.sql<SemanticRow[]>`
      SELECT id, source, target, relation_type, weight, source_kind, source_ref, created_at
      FROM semantic_edges
      WHERE (source = ${nodeRef} OR target = ${nodeRef})
        ${asOfFilter}
      ORDER BY weight DESC, created_at DESC, id DESC
      LIMIT ${Math.min(topK, finalLimit)}
    `;

    const records = rows.map((row) => this.normalizeSemanticRow(row));
    return this.applyEndpointCascade(records, opts);
  }

  async evidencePathTo(
    assertionRef: string,
    opts: UnifiedEdgeReadOptions & { maxDepth?: number; maxEdges?: number } = {},
  ): Promise<UnifiedEdgeRecord[]> {
    const maxDepth = Math.max(1, opts.maxDepth ?? DEFAULT_CHAIN_DEPTH);
    const maxEdges = this.resolveLimit(opts.maxEdges ?? opts.limit, DEFAULT_CHAIN_MAX_EDGES);

    let frontier = [assertionRef];
    const visitedNodes = new Set<string>([assertionRef]);
    const edgeById = new Map<string, UnifiedEdgeRecord>();

    for (let depth = 0; depth < maxDepth && frontier.length > 0 && edgeById.size < maxEdges; depth += 1) {
      const nextFrontier = new Set<string>();
      for (const nodeRef of frontier) {
        const remaining = maxEdges - edgeById.size;
        if (remaining <= 0) {
          break;
        }

        const around = await this.edgesAround(nodeRef, {
          ...opts,
          limit: remaining,
        });

        for (const edge of around) {
          const key = this.edgeKey(edge);
          if (!edgeById.has(key)) {
            edgeById.set(key, edge);
          }

          const neighbor = edge.sourceRef === nodeRef ? edge.targetRef : edge.sourceRef;
          if (!visitedNodes.has(neighbor)) {
            visitedNodes.add(neighbor);
            nextFrontier.add(neighbor);
          }

          if (edgeById.size >= maxEdges) {
            break;
          }
        }
        if (edgeById.size >= maxEdges) {
          break;
        }
      }
      frontier = Array.from(nextFrontier);
    }

    return this.sortAndClamp(Array.from(edgeById.values()), maxEdges);
  }

  private async readLogicEdgesFrom(
    nodeRef: string,
    opts: UnifiedEdgeReadOptions,
    limit: number,
  ): Promise<UnifiedEdgeRecord[]> {
    const eventId = this.parseNodeId(nodeRef, "event");
    if (eventId === null) {
      return [];
    }
    const asOfFilter = this.createdAtAsOfFilter(opts.asOf);
    const rows = await this.sql<LogicRow[]>`
      SELECT id, source_event_id, target_event_id, relation_type, weight, source_kind, source_ref, created_at
      FROM logic_edges
      WHERE source_event_id = ${eventId}
        ${asOfFilter}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => this.normalizeLogicRow(row));
  }

  private async readLogicEdgesTo(
    nodeRef: string,
    opts: UnifiedEdgeReadOptions,
    limit: number,
  ): Promise<UnifiedEdgeRecord[]> {
    const eventId = this.parseNodeId(nodeRef, "event");
    if (eventId === null) {
      return [];
    }
    const asOfFilter = this.createdAtAsOfFilter(opts.asOf);
    const rows = await this.sql<LogicRow[]>`
      SELECT id, source_event_id, target_event_id, relation_type, weight, source_kind, source_ref, created_at
      FROM logic_edges
      WHERE target_event_id = ${eventId}
        ${asOfFilter}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => this.normalizeLogicRow(row));
  }

  private async readMemoryEdgesFrom(
    nodeRef: string,
    opts: UnifiedEdgeReadOptions,
    limit: number,
  ): Promise<UnifiedEdgeRecord[]> {
    const asOfFilter = this.createdAtAsOfFilter(opts.asOf);
    const rows = await this.sql<MemoryRow[]>`
      SELECT id, source_node_ref, target_node_ref, relation_type, strength, source_kind, source_ref, created_at
      FROM memory_relations
      WHERE source_node_ref = ${nodeRef}
        ${asOfFilter}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => this.normalizeMemoryRow(row));
  }

  private async readMemoryEdgesTo(
    nodeRef: string,
    opts: UnifiedEdgeReadOptions,
    limit: number,
  ): Promise<UnifiedEdgeRecord[]> {
    const asOfFilter = this.createdAtAsOfFilter(opts.asOf);
    const rows = await this.sql<MemoryRow[]>`
      SELECT id, source_node_ref, target_node_ref, relation_type, strength, source_kind, source_ref, created_at
      FROM memory_relations
      WHERE target_node_ref = ${nodeRef}
        ${asOfFilter}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => this.normalizeMemoryRow(row));
  }

  private async readSemanticEdgesFrom(
    nodeRef: string,
    opts: UnifiedEdgeReadOptions,
    limit: number,
  ): Promise<UnifiedEdgeRecord[]> {
    const asOfFilter = this.createdAtAsOfFilter(opts.asOf);
    const rows = await this.sql<SemanticRow[]>`
      SELECT id, source, target, relation_type, weight, source_kind, source_ref, created_at
      FROM semantic_edges
      WHERE source = ${nodeRef}
        ${asOfFilter}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => this.normalizeSemanticRow(row));
  }

  private async readSemanticEdgesTo(
    nodeRef: string,
    opts: UnifiedEdgeReadOptions,
    limit: number,
  ): Promise<UnifiedEdgeRecord[]> {
    const asOfFilter = this.createdAtAsOfFilter(opts.asOf);
    const rows = await this.sql<SemanticRow[]>`
      SELECT id, source, target, relation_type, weight, source_kind, source_ref, created_at
      FROM semantic_edges
      WHERE target = ${nodeRef}
        ${asOfFilter}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => this.normalizeSemanticRow(row));
  }

  private async readFactEdgesFrom(
    nodeRef: string,
    opts: UnifiedEdgeReadOptions,
    limit: number,
  ): Promise<UnifiedEdgeRecord[]> {
    const entityId = this.parseNodeId(nodeRef, "entity");
    if (entityId === null) {
      return [];
    }
    const ownerVisibility = this.factOwnerVisibility(opts.viewerAgentId);
    const temporalFilter = this.factTemporalFilter(opts);

    const rows = await this.sql<FactRow[]>`
      SELECT
        id,
        source_entity_id,
        target_entity_id,
        predicate,
        fact_text,
        source_kind,
        source_ref,
        owner_agent_id,
        t_valid,
        t_invalid,
        t_created
      FROM fact_edges
      WHERE source_entity_id = ${entityId}
        ${ownerVisibility}
        ${temporalFilter}
      ORDER BY t_created DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => this.normalizeFactRow(row));
  }

  private async readFactEdgesTo(
    nodeRef: string,
    opts: UnifiedEdgeReadOptions,
    limit: number,
  ): Promise<UnifiedEdgeRecord[]> {
    const entityId = this.parseNodeId(nodeRef, "entity");
    if (entityId === null) {
      return [];
    }
    const ownerVisibility = this.factOwnerVisibility(opts.viewerAgentId);
    const temporalFilter = this.factTemporalFilter(opts);

    const rows = await this.sql<FactRow[]>`
      SELECT
        id,
        source_entity_id,
        target_entity_id,
        predicate,
        fact_text,
        source_kind,
        source_ref,
        owner_agent_id,
        t_valid,
        t_invalid,
        t_created
      FROM fact_edges
      WHERE target_entity_id = ${entityId}
        ${ownerVisibility}
        ${temporalFilter}
      ORDER BY t_created DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => this.normalizeFactRow(row));
  }

  private createdAtAsOfFilter(asOf: number | undefined) {
    if (asOf == null) {
      return this.sql``;
    }
    return this.sql`AND created_at <= ${asOf}`;
  }

  private factTemporalFilter(opts: UnifiedEdgeReadOptions) {
    if (opts.asOf != null) {
      return this.sql`AND t_valid <= ${opts.asOf} AND t_invalid > ${opts.asOf}`;
    }
    if (opts.active ?? true) {
      return this.sql`AND t_invalid = ${PG_MAX_BIGINT}`;
    }
    return this.sql``;
  }

  private factOwnerVisibility(viewerAgentId: string | undefined) {
    if (viewerAgentId) {
      return this.sql`AND (owner_agent_id IS NULL OR owner_agent_id = ${viewerAgentId})`;
    }
    return this.sql`AND owner_agent_id IS NULL`;
  }

  private normalizeLogicRow(row: LogicRow): UnifiedEdgeRecord {
    const contract = this.resolveRelationContract(row.relation_type, "causal");

    return {
      id: Number(row.id),
      table: "logic_edges",
      sourceRef: `event:${Number(row.source_event_id)}`,
      targetRef: `event:${Number(row.target_event_id)}`,
      edgeKind: row.relation_type,
      layer: contract.layer,
      truthBearing: contract.truth_bearing,
      heuristicOnly: contract.heuristic_only,
      lifecycle: contract.lifecycle,
      weight: row.weight == null ? undefined : Number(row.weight),
      sourceKind: row.source_kind,
      sourceRefOrigin: row.source_ref,
      createdAt: Number(row.created_at),
    };
  }

  private normalizeMemoryRow(row: MemoryRow): UnifiedEdgeRecord {
    const contract = this.resolveRelationContract(row.relation_type, "supports");

    return {
      id: Number(row.id),
      table: "memory_relations",
      sourceRef: row.source_node_ref,
      targetRef: row.target_node_ref,
      edgeKind: row.relation_type,
      layer: contract.layer,
      truthBearing: contract.truth_bearing,
      heuristicOnly: contract.heuristic_only,
      lifecycle: contract.lifecycle,
      weight: Number(row.strength),
      sourceKind: row.source_kind,
      sourceRefOrigin: row.source_ref,
      createdAt: Number(row.created_at),
    };
  }

  private normalizeSemanticRow(row: SemanticRow): UnifiedEdgeRecord {
    const contract = this.resolveRelationContract(row.relation_type, "semantic_similar");

    return {
      id: Number(row.id),
      table: "semantic_edges",
      sourceRef: row.source,
      targetRef: row.target,
      edgeKind: row.relation_type,
      layer: contract.layer,
      truthBearing: contract.truth_bearing,
      heuristicOnly: contract.heuristic_only,
      lifecycle: contract.lifecycle,
      weight: Number(row.weight),
      sourceKind: row.source_kind,
      sourceRefOrigin: row.source_ref,
      createdAt: Number(row.created_at),
    };
  }

  private normalizeFactRow(row: FactRow): UnifiedEdgeRecord {
    const semantics = EDGE_SEMANTICS_BY_TABLE.fact_edges[FACT_EDGE_PREDICATE_WILDCARD];

    return {
      id: Number(row.id),
      table: "fact_edges",
      sourceRef: `entity:${Number(row.source_entity_id)}`,
      targetRef: `entity:${Number(row.target_entity_id)}`,
      edgeKind: row.predicate,
      layer: semantics.layer,
      truthBearing: semantics.truthBearing,
      heuristicOnly: semantics.heuristicOnly,
      lifecycle: semantics.lifecycle,
      tValid: Number(row.t_valid),
      tInvalid: this.normalizeFactInvalid(row.t_invalid),
      factText: row.fact_text,
      sourceKind: row.source_kind,
      sourceRefOrigin: row.source_ref,
      createdAt: Number(row.t_created),
      ownerAgentId: row.owner_agent_id,
    };
  }

  private normalizeFactInvalid(raw: number | string): number | null {
    if (typeof raw === "string") {
      if (raw === PG_MAX_BIGINT) {
        return null;
      }
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    }

    // In PG test pools int8 may already be parsed as Number. Sentinel BIGINT
    // exceeds JS safe-integer range and is rounded to ~9.223372036854776e18.
    if (!Number.isSafeInteger(raw) || raw >= 9_000_000_000_000_000) {
      return null;
    }

    return raw;
  }

  private resolveRelationContract(
    relationType: string,
    fallbackRelationType: string,
  ) {
    const contract = getRelationContract(relationType);
    if (contract) {
      return contract;
    }
    const fallback = getRelationContract(fallbackRelationType);
    if (fallback) {
      return fallback;
    }
    return {
      source_family: "unknown",
      target_family: "unknown",
      truth_bearing: false,
      heuristic_only: false,
      layer: "cognitive",
      temporal: false,
      lifecycle: "immutable",
    } as const;
  }

  private sortAndClamp(edges: UnifiedEdgeRecord[], limit: number): UnifiedEdgeRecord[] {
    return edges
      .slice()
      .sort((a, b) => this.sortKey(b) - this.sortKey(a))
      .slice(0, limit);
  }

  private sortKey(edge: UnifiedEdgeRecord): number {
    if (edge.tValid != null) {
      return edge.tValid;
    }
    if (edge.createdAt != null) {
      return edge.createdAt;
    }
    return Number(edge.id);
  }

  private dedupeByPhysicalEdge(edges: UnifiedEdgeRecord[]): UnifiedEdgeRecord[] {
    const byId = new Map<string, UnifiedEdgeRecord>();
    for (const edge of edges) {
      const key = this.edgeKey(edge);
      if (!byId.has(key)) {
        byId.set(key, edge);
      }
    }
    return Array.from(byId.values());
  }

  private edgeKey(edge: UnifiedEdgeRecord): string {
    return `${edge.table}:${String(edge.id)}`;
  }

  private resolveLimit(value: number | undefined, fallback: number): number {
    if (value == null || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(1, Math.floor(value));
  }

  private parseNodeId(nodeRef: string, expectedKind: "event" | "entity"): number | null {
    try {
      const parsed = parseGraphNodeRef(nodeRef);
      if (parsed.kind !== expectedKind) {
        return null;
      }
      const id = Number(parsed.id);
      if (!Number.isInteger(id) || id <= 0) {
        return null;
      }
      return id;
    } catch {
      return null;
    }
  }

  /**
   * Endpoint visibility cascade: an edge is only returned if both endpoints
   * are visible to the viewer. When opts.viewerAgentId is unset, the caller
   * is treated as system-level and no cascade is applied (current default).
   *
   * Visibility rules per endpoint kind:
   * - entity: shared_public OR owner_agent_id = viewer
   * - event:  world_public OR (area_visible AND location_entity_id = viewerCurrentAreaId)
   * - fact:   owner_agent_id IS NULL OR owner_agent_id = viewer
   *           (also delegated to PgRetrievalReadRepo / VisibilityPolicy elsewhere)
   * - assertion / evaluation / commitment / episode: agent_id = viewer
   *
   * Endpoints whose target rows cannot be located (orphaned, deleted) are
   * treated as not-visible — strict-mode safety to avoid accidental leaks.
   */
  private async applyEndpointCascade(
    records: UnifiedEdgeRecord[],
    opts: UnifiedEdgeReadOptions,
  ): Promise<UnifiedEdgeRecord[]> {
    if (!opts.viewerAgentId || records.length === 0) {
      return records;
    }

    const refs = new Set<string>();
    for (const rec of records) {
      refs.add(rec.sourceRef);
      refs.add(rec.targetRef);
    }
    const visibility = await this.fetchEndpointVisibility(Array.from(refs));

    return records.filter((rec) =>
      this.isEndpointVisibleTo(visibility, rec.sourceRef, opts) &&
      this.isEndpointVisibleTo(visibility, rec.targetRef, opts),
    );
  }

  private async fetchEndpointVisibility(
    nodeRefs: readonly string[],
  ): Promise<Map<string, EndpointVisibilityMeta>> {
    const map = new Map<string, EndpointVisibilityMeta>();
    if (nodeRefs.length === 0) {
      return map;
    }

    const idsByKind = new Map<string, number[]>();
    for (const ref of nodeRefs) {
      const colonIdx = ref.indexOf(":");
      if (colonIdx <= 0) continue;
      const kind = ref.slice(0, colonIdx);
      const idStr = ref.slice(colonIdx + 1);
      const id = Number(idStr);
      if (!Number.isFinite(id)) continue;
      const list = idsByKind.get(kind) ?? [];
      list.push(id);
      idsByKind.set(kind, list);
    }

    const eventIds = idsByKind.get("event") ?? [];
    if (eventIds.length > 0) {
      const rows = await this.sql<{
        id: number | string;
        visibility_scope: string;
        location_entity_id: number | string;
      }[]>`
        SELECT id, visibility_scope, location_entity_id
        FROM event_nodes
        WHERE id IN ${this.sql(eventIds)}
      `;
      for (const row of rows) {
        map.set(`event:${Number(row.id)}`, {
          kind: "event",
          visibilityScope: String(row.visibility_scope),
          locationEntityId: Number(row.location_entity_id),
        });
      }
    }

    const entityIds = idsByKind.get("entity") ?? [];
    if (entityIds.length > 0) {
      const rows = await this.sql<{
        id: number | string;
        memory_scope: string;
        owner_agent_id: string | null;
      }[]>`
        SELECT id, memory_scope, owner_agent_id
        FROM entity_nodes
        WHERE id IN ${this.sql(entityIds)}
      `;
      for (const row of rows) {
        map.set(`entity:${Number(row.id)}`, {
          kind: "entity",
          memoryScope: String(row.memory_scope),
          ownerAgentId: row.owner_agent_id,
        });
      }
    }

    const factIds = idsByKind.get("fact") ?? [];
    if (factIds.length > 0) {
      const rows = await this.sql<{
        id: number | string;
        owner_agent_id: string | null;
      }[]>`
        SELECT id, owner_agent_id
        FROM fact_edges
        WHERE id IN ${this.sql(factIds)}
      `;
      for (const row of rows) {
        map.set(`fact:${Number(row.id)}`, {
          kind: "fact",
          ownerAgentId: row.owner_agent_id,
        });
      }
    }

    for (const kind of ["assertion", "evaluation", "commitment"] as const) {
      const ids = idsByKind.get(kind) ?? [];
      if (ids.length === 0) continue;
      const rows = await this.sql<{
        id: number | string;
        agent_id: string | null;
      }[]>`
        SELECT id, agent_id
        FROM private_cognition_events
        WHERE id IN ${this.sql(ids)}
      `;
      for (const row of rows) {
        map.set(`${kind}:${Number(row.id)}`, {
          kind,
          agentId: row.agent_id,
        });
      }
    }

    const episodeIds = idsByKind.get("episode") ?? [];
    if (episodeIds.length > 0) {
      const rows = await this.sql<{
        id: number | string;
        agent_id: string | null;
      }[]>`
        SELECT id, agent_id
        FROM private_episode_events
        WHERE id IN ${this.sql(episodeIds)}
      `;
      for (const row of rows) {
        map.set(`episode:${Number(row.id)}`, {
          kind: "episode",
          agentId: row.agent_id,
        });
      }
    }

    return map;
  }

  private isEndpointVisibleTo(
    visibility: Map<string, EndpointVisibilityMeta>,
    nodeRef: string,
    opts: UnifiedEdgeReadOptions,
  ): boolean {
    const meta = visibility.get(nodeRef);
    if (!meta) {
      // Unknown / orphaned endpoint — strict-mode default: hide.
      return false;
    }

    if (meta.kind === "event") {
      if (meta.visibilityScope === "world_public") return true;
      if (meta.visibilityScope === "area_visible") {
        return (
          opts.viewerCurrentAreaId != null &&
          meta.locationEntityId === opts.viewerCurrentAreaId
        );
      }
      return false;
    }

    if (meta.kind === "entity") {
      if (meta.memoryScope === "shared_public") return true;
      if (meta.memoryScope === "private_overlay") {
        return meta.ownerAgentId === opts.viewerAgentId;
      }
      return false;
    }

    if (meta.kind === "fact") {
      if (!meta.ownerAgentId) return true;
      return meta.ownerAgentId === opts.viewerAgentId;
    }

    if (
      meta.kind === "assertion" ||
      meta.kind === "evaluation" ||
      meta.kind === "commitment" ||
      meta.kind === "episode"
    ) {
      return meta.agentId === opts.viewerAgentId;
    }

    return false;
  }
}

type EndpointVisibilityMeta =
  | {
      kind: "event";
      visibilityScope: string;
      locationEntityId: number;
    }
  | {
      kind: "entity";
      memoryScope: string;
      ownerAgentId: string | null;
    }
  | {
      kind: "fact";
      ownerAgentId: string | null;
    }
  | {
      kind: "assertion" | "evaluation" | "commitment" | "episode";
      agentId: string | null;
    };
