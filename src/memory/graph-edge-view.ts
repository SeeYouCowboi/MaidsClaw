import type {
  GraphReadEdgeRecord,
  GraphReadQueryRepo,
} from "../storage/domain-repos/contracts/graph-read-query-repo.js";
import { parseGraphNodeRef } from "./contracts/graph-node-ref.js";
import type { EdgeLayer, NodeRef, NodeRefKind, ViewerContext, MemoryRelationType } from "./types.js";
import type { TimeSliceQuery } from "./time-slice-query.js";

type GraphEdgeFamily = "logic_edges" | "memory_relations" | "semantic_edges";
type EndpointFamily = NodeRefKind | "unknown";

type RelationContract = {
  source_family: EndpointFamily;
  target_family: EndpointFamily;
  truth_bearing: boolean;
  heuristic_only: boolean;
};

const LOGIC_EDGE_CONTRACTS: Record<string, RelationContract> = {
  causal: { source_family: "event", target_family: "event", truth_bearing: true, heuristic_only: false },
  temporal_prev: { source_family: "event", target_family: "event", truth_bearing: true, heuristic_only: false },
  temporal_next: { source_family: "event", target_family: "event", truth_bearing: true, heuristic_only: false },
  same_episode: { source_family: "event", target_family: "event", truth_bearing: true, heuristic_only: false },
  semantic_similar: { source_family: "unknown", target_family: "unknown", truth_bearing: false, heuristic_only: true },
  conflict_or_update: { source_family: "unknown", target_family: "unknown", truth_bearing: false, heuristic_only: true },
  entity_bridge: { source_family: "unknown", target_family: "unknown", truth_bearing: false, heuristic_only: true },
};

const MEMORY_RELATION_CONTRACTS: Record<MemoryRelationType, RelationContract> = {
  supports: { source_family: "event", target_family: "assertion", truth_bearing: true, heuristic_only: false },
  triggered: { source_family: "event", target_family: "evaluation", truth_bearing: true, heuristic_only: false },
  conflicts_with: { source_family: "assertion", target_family: "assertion", truth_bearing: true, heuristic_only: false },
  derived_from: { source_family: "fact", target_family: "assertion", truth_bearing: true, heuristic_only: false },
  supersedes: { source_family: "assertion", target_family: "assertion", truth_bearing: true, heuristic_only: false },
  surfaced_as: { source_family: "assertion", target_family: "event", truth_bearing: true, heuristic_only: false },
  published_as: { source_family: "event", target_family: "entity", truth_bearing: true, heuristic_only: false },
  resolved_by: { source_family: "assertion", target_family: "fact", truth_bearing: false, heuristic_only: true },
  downgraded_by: { source_family: "assertion", target_family: "evaluation", truth_bearing: false, heuristic_only: true },
};

const RELATION_CONTRACTS: Record<string, RelationContract> = {
  ...LOGIC_EDGE_CONTRACTS,
  ...MEMORY_RELATION_CONTRACTS,
};

const KNOWN_NODE_KINDS = new Set<NodeRefKind>([
  "event",
  "entity",
  "fact",
  "assertion",
  "evaluation",
  "commitment",
]);

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
  constructor(private readonly readRepo: GraphReadQueryRepo) {}

  async readLogicEdges(frontier: Set<NodeRef>, viewerContext: ViewerContext, timeSlice?: TimeSliceQuery): Promise<GraphEdgeReadResult[]> {
    const records = await this.readRepo.readLogicEdges(Array.from(frontier), viewerContext, timeSlice);
    return records.map((record) => this.fromRepoRecord(record));
  }

  async readMemoryRelations(frontier: Set<NodeRef>, viewerContext: ViewerContext, timeSlice?: TimeSliceQuery): Promise<GraphEdgeReadResult[]> {
    const records = await this.readRepo.readMemoryRelationEdges(Array.from(frontier), viewerContext, timeSlice);
    return records.map((record) => this.fromRepoRecord(record));
  }

  async readSemanticEdges(frontier: Set<NodeRef>, viewerContext: ViewerContext, timeSlice?: TimeSliceQuery): Promise<GraphEdgeReadResult[]> {
    const records = await this.readRepo.readSemanticEdges(Array.from(frontier), viewerContext, timeSlice);
    return records.map((record) => this.fromRepoRecord(record));
  }

  async readStateFactEdges(
    frontier: Set<NodeRef>,
    viewerContext: ViewerContext,
    timeSlice?: TimeSliceQuery,
  ): Promise<GraphEdgeReadResult[]> {
    const records = await this.readRepo.readStateFactEdges(Array.from(frontier), viewerContext, timeSlice);
    return records.map((record) => this.fromRepoRecord(record));
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

  private fromRepoRecord(record: GraphReadEdgeRecord): GraphEdgeReadResult {
    return this.toGraphEdge(
      record.family,
      record.layer,
      record.relationType,
      record.sourceRef,
      record.targetRef,
      {
        weight: record.weight,
        strength: record.strength ?? undefined,
        source_kind: record.sourceKind ?? undefined,
        provenance_ref: record.provenanceRef ?? undefined,
        timestamp: record.timestamp,
        valid_time: record.validTime,
        committed_time: record.committedTime,
      },
    );
  }

  private parseNodeRef(ref: NodeRef): { kind: NodeRefKind; id: number } | null {
    try {
      const parsed = parseGraphNodeRef(String(ref));
      if (!KNOWN_NODE_KINDS.has(parsed.kind)) {
        return null;
      }
      const id = Number(parsed.id);
      if (!Number.isInteger(id) || id <= 0) {
        return null;
      }
      return { kind: parsed.kind as NodeRefKind, id };
    } catch {
      return null;
    }
  }
}
