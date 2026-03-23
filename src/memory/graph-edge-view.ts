import type { Database } from "bun:sqlite";
import { MAX_INTEGER } from "./schema.js";
import { VisibilityPolicy } from "./visibility-policy.js";
import type { EdgeLayer, NodeRef, NodeRefKind, ViewerContext } from "./types.js";
import type { TimeSliceQuery } from "./time-slice-query.js";
import { isEdgeInTimeSlice } from "./time-slice-query.js";

type GraphEdgeFamily = "logic_edges" | "memory_relations" | "semantic_edges";
type EndpointFamily = NodeRefKind | "unknown";

type RelationContract = {
  source_family: EndpointFamily;
  target_family: EndpointFamily;
  truth_bearing: boolean;
  heuristic_only: boolean;
};

const KNOWN_NODE_KINDS = new Set<NodeRefKind>([
  "event",
  "entity",
  "fact",
  "private_event",
  "private_belief",
]);

const RELATION_CONTRACTS: Record<string, RelationContract> = {
  causal: { source_family: "event", target_family: "event", truth_bearing: true, heuristic_only: false },
  temporal_prev: { source_family: "event", target_family: "event", truth_bearing: true, heuristic_only: false },
  temporal_next: { source_family: "event", target_family: "event", truth_bearing: true, heuristic_only: false },
  same_episode: { source_family: "event", target_family: "event", truth_bearing: true, heuristic_only: false },
  supports: { source_family: "unknown", target_family: "unknown", truth_bearing: true, heuristic_only: false },
  triggered: { source_family: "unknown", target_family: "unknown", truth_bearing: true, heuristic_only: false },
  conflicts_with: { source_family: "unknown", target_family: "unknown", truth_bearing: true, heuristic_only: false },
  derived_from: { source_family: "unknown", target_family: "unknown", truth_bearing: true, heuristic_only: false },
  supersedes: { source_family: "unknown", target_family: "unknown", truth_bearing: true, heuristic_only: false },
  semantic_similar: { source_family: "unknown", target_family: "unknown", truth_bearing: false, heuristic_only: true },
  conflict_or_update: { source_family: "unknown", target_family: "unknown", truth_bearing: false, heuristic_only: true },
  entity_bridge: { source_family: "unknown", target_family: "unknown", truth_bearing: false, heuristic_only: true },
};

export type GraphEdgeReadResult = {
  family: GraphEdgeFamily;
  layer: EdgeLayer;
  relation_type: string;
  source_ref: NodeRef;
  target_ref: NodeRef;
  weight: number;
  strength: number | null;
  source_kind: string | null;
  provenance_ref: string | null;
  timestamp: number | null;
  valid_time: number | null;
  committed_time: number | null;
  truth_bearing: boolean;
  heuristic_only: boolean;
  endpoint_contract: {
    source_family: EndpointFamily;
    target_family: EndpointFamily;
    declared: boolean;
  };
};

export class GraphEdgeView {
  constructor(private readonly db: Database, private readonly visibility: VisibilityPolicy) {}

  readLogicEdges(frontier: Set<NodeRef>, viewerContext: ViewerContext, timeSlice?: TimeSliceQuery): GraphEdgeReadResult[] {
    const ids = this.extractIdsFromRefs(frontier, "event");
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT source_event_id, target_event_id, relation_type, created_at
         FROM logic_edges
         WHERE source_event_id IN (${placeholders}) OR target_event_id IN (${placeholders})`,
      )
      .all(...ids, ...ids) as Array<{
      source_event_id: number;
      target_event_id: number;
      relation_type: string;
      created_at: number;
    }>;

    const results: GraphEdgeReadResult[] = [];
    for (const row of rows) {
      const source = `event:${row.source_event_id}` as NodeRef;
      const target = `event:${row.target_event_id}` as NodeRef;
      if (frontier.has(source)) {
        const edge = this.toGraphEdge("logic_edges", "symbolic", row.relation_type, source, target, {
          weight: 1,
          timestamp: row.created_at,
          valid_time: row.created_at,
          committed_time: row.created_at,
        });
        if (this.isVisibleEdge(edge, viewerContext) && isEdgeInTimeSlice(edge, timeSlice)) {
          results.push(edge);
        }
      }
      if (frontier.has(target)) {
        const edge = this.toGraphEdge("logic_edges", "symbolic", this.reverseTemporalRelation(row.relation_type), target, source, {
          weight: 1,
          timestamp: row.created_at,
          valid_time: row.created_at,
          committed_time: row.created_at,
        });
        if (this.isVisibleEdge(edge, viewerContext) && isEdgeInTimeSlice(edge, timeSlice)) {
          results.push(edge);
        }
      }
    }
    return results;
  }

  readMemoryRelations(frontier: Set<NodeRef>, viewerContext: ViewerContext, timeSlice?: TimeSliceQuery): GraphEdgeReadResult[] {
    const refs = Array.from(frontier);
    if (refs.length === 0) {
      return [];
    }
    const placeholders = refs.map(() => "?").join(",");

    let rows: Array<{
      source_node_ref: NodeRef;
      target_node_ref: NodeRef;
      relation_type: string;
      strength: number;
      source_kind: string;
      source_ref: string;
      created_at: number;
      updated_at: number;
    }> = [];
    try {
      rows = this.db
        .prepare(
          `SELECT source_node_ref, target_node_ref, relation_type, strength, source_kind, source_ref, created_at, updated_at
           FROM memory_relations
           WHERE source_node_ref IN (${placeholders}) OR target_node_ref IN (${placeholders})`,
        )
        .all(...refs, ...refs) as typeof rows;
    } catch {
      return [];
    }

    const results: GraphEdgeReadResult[] = [];
    for (const row of rows) {
      if (frontier.has(row.source_node_ref)) {
        const edge = this.toGraphEdge("memory_relations", "symbolic", row.relation_type, row.source_node_ref, row.target_node_ref, {
          weight: row.strength,
          strength: row.strength,
          source_kind: row.source_kind,
          provenance_ref: row.source_ref,
          timestamp: row.created_at,
          valid_time: row.created_at,
          committed_time: row.updated_at > 0 ? row.updated_at : row.created_at,
        });
        if (this.isVisibleEdge(edge, viewerContext) && isEdgeInTimeSlice(edge, timeSlice)) {
          results.push(edge);
        }
      }
      if (frontier.has(row.target_node_ref)) {
        const edge = this.toGraphEdge("memory_relations", "symbolic", row.relation_type, row.target_node_ref, row.source_node_ref, {
          weight: row.strength,
          strength: row.strength,
          source_kind: row.source_kind,
          provenance_ref: row.source_ref,
          timestamp: row.created_at,
          valid_time: row.created_at,
          committed_time: row.updated_at > 0 ? row.updated_at : row.created_at,
        });
        if (this.isVisibleEdge(edge, viewerContext) && isEdgeInTimeSlice(edge, timeSlice)) {
          results.push(edge);
        }
      }
    }

    return results;
  }

  readSemanticEdges(frontier: Set<NodeRef>, viewerContext: ViewerContext, timeSlice?: TimeSliceQuery): GraphEdgeReadResult[] {
    const refs = Array.from(frontier);
    if (refs.length === 0) {
      return [];
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
      relation_type: string;
      weight: number;
      created_at: number;
    }>;

    const results: GraphEdgeReadResult[] = [];
    for (const row of rows) {
      if (frontier.has(row.source_node_ref)) {
        const edge = this.toGraphEdge("semantic_edges", "heuristic", row.relation_type, row.source_node_ref, row.target_node_ref, {
          weight: row.weight,
          timestamp: row.created_at,
          valid_time: row.created_at,
          committed_time: row.created_at,
        });
        if (this.isVisibleEdge(edge, viewerContext) && isEdgeInTimeSlice(edge, timeSlice)) {
          results.push(edge);
        }
      }
      if (frontier.has(row.target_node_ref)) {
        const edge = this.toGraphEdge("semantic_edges", "heuristic", row.relation_type, row.target_node_ref, row.source_node_ref, {
          weight: row.weight,
          timestamp: row.created_at,
          valid_time: row.created_at,
          committed_time: row.created_at,
        });
        if (this.isVisibleEdge(edge, viewerContext) && isEdgeInTimeSlice(edge, timeSlice)) {
          results.push(edge);
        }
      }
    }
    return results;
  }

  readStateFactEdges(
    frontier: Set<NodeRef>,
    viewerContext: ViewerContext,
    timeSlice?: TimeSliceQuery,
  ): GraphEdgeReadResult[] {
    const ids = this.extractIdsFromRefs(frontier, "event");
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, source_event_id, predicate, t_valid, t_created
         FROM fact_edges
         WHERE t_invalid = ? AND source_event_id IN (${placeholders})`,
      )
      .all(MAX_INTEGER, ...ids) as Array<{
      id: number;
      source_event_id: number;
      predicate: string;
      t_valid: number;
      t_created: number;
    }>;

    const results: GraphEdgeReadResult[] = [];
    for (const row of rows) {
      const source = `event:${row.source_event_id}` as NodeRef;
      const target = `fact:${row.id}` as NodeRef;
      const edge = this.toGraphEdge("memory_relations", "state", "fact_support", source, target, {
        weight: 0.95,
        timestamp: row.t_valid,
        valid_time: row.t_valid,
        committed_time: row.t_created,
      });
      if (this.isVisibleEdge(edge, viewerContext) && isEdgeInTimeSlice(edge, timeSlice)) {
        edge.endpoint_contract.source_family = "event";
        edge.endpoint_contract.target_family = "fact";
        results.push(edge);
      }
    }
    return results;
  }

  private toGraphEdge(
    family: GraphEdgeFamily,
    layer: EdgeLayer,
    relationType: string,
    sourceRef: NodeRef,
    targetRef: NodeRef,
    options: {
      weight: number;
      strength?: number;
      source_kind?: string;
      provenance_ref?: string;
      timestamp: number | null;
      valid_time: number | null;
      committed_time: number | null;
    },
  ): GraphEdgeReadResult {
    const sourceKind = this.parseNodeRef(sourceRef)?.kind ?? "unknown";
    const targetKind = this.parseNodeRef(targetRef)?.kind ?? "unknown";
    const relationContract = RELATION_CONTRACTS[relationType];
    const declared = relationContract !== undefined;

    return {
      family,
      layer,
      relation_type: relationType,
      source_ref: sourceRef,
      target_ref: targetRef,
      weight: options.weight,
      strength: options.strength ?? null,
      source_kind: options.source_kind ?? null,
      provenance_ref: options.provenance_ref ?? null,
      timestamp: options.timestamp,
      valid_time: options.valid_time,
      committed_time: options.committed_time,
      truth_bearing: relationContract?.truth_bearing ?? layer !== "heuristic",
      heuristic_only: relationContract?.heuristic_only ?? layer === "heuristic",
      endpoint_contract: {
        source_family: relationContract?.source_family === "unknown" ? sourceKind : relationContract?.source_family ?? sourceKind,
        target_family: relationContract?.target_family === "unknown" ? targetKind : relationContract?.target_family ?? targetKind,
        declared,
      },
    };
  }

  private reverseTemporalRelation(relationType: string): string {
    if (relationType === "temporal_prev") {
      return "temporal_next";
    }
    if (relationType === "temporal_next") {
      return "temporal_prev";
    }
    return relationType;
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

  private isVisibleEdge(edge: GraphEdgeReadResult, viewerContext: ViewerContext): boolean {
    const sourceData = this.loadNodeVisibilityData(edge.source_ref);
    const targetData = this.loadNodeVisibilityData(edge.target_ref);
    if (!sourceData || !targetData) {
      return false;
    }
    return this.visibility.isEdgeVisible(viewerContext, edge.source_ref, sourceData, edge.target_ref, targetData);
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

    if (parsed.kind === "private_event") {
      const row = this.db
        .prepare("SELECT agent_id FROM agent_event_overlay WHERE id = ?")
        .get(parsed.id) as { agent_id: string } | undefined;
      return row ? { agent_id: row.agent_id } : null;
    }

    if (parsed.kind === "private_belief") {
      const row = this.db
        .prepare("SELECT agent_id FROM agent_fact_overlay WHERE id = ?")
        .get(parsed.id) as { agent_id: string } | undefined;
      return row ? { agent_id: row.agent_id } : null;
    }

    if (parsed.kind === "event") {
      const row = this.db
        .prepare("SELECT visibility_scope, location_entity_id, NULL as owner_agent_id FROM event_nodes WHERE id = ?")
        .get(parsed.id) as {
        visibility_scope: "world_public" | "area_visible";
        location_entity_id: number;
        owner_agent_id: string | null;
      } | undefined;
      return row
        ? {
          visibility_scope: row.visibility_scope,
          location_entity_id: row.location_entity_id,
          owner_agent_id: row.owner_agent_id,
        }
        : null;
    }

    if (parsed.kind === "fact") {
      const row = this.db
        .prepare("SELECT id FROM fact_edges WHERE id = ? AND t_invalid = ?")
        .get(parsed.id, MAX_INTEGER) as { id: number } | undefined;
      return row ? { id: row.id } : null;
    }

    return null;
  }
}
