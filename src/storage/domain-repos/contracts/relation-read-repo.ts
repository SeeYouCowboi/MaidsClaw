import type { ResolutionChainType } from "../../../memory/contracts/relation-contract.js";
import type { RelationSourceKind } from "../../../memory/types.js";

export type ConflictEvidence = {
  targetRef: string;
  strength: number;
  sourceKind: RelationSourceKind;
  sourceRef: string;
  createdAt: number;
};

export type ConflictHistoryEntry = {
  relation_type: ResolutionChainType;
  source_node_ref: string;
  target_node_ref: string;
  created_at: number;
};

export interface RelationReadRepo {
  /**
   * Read up to `limit` conflict evidence rows for a given source node ref.
   * Returns strongest-first.
   */
  getConflictEvidence(sourceNodeRef: string, limit?: number): Promise<ConflictEvidence[]>;

  /**
   * Query the conflict/resolution chain for a given node ref, ordered by time (ASC).
   * Returns `conflicts_with`, `resolved_by`, and `downgraded_by` relations
   * where the node appears as either source or target.
   */
  getConflictHistory(nodeRef: string, limit?: number): Promise<ConflictHistoryEntry[]>;

  /**
   * Resolve the agent ID for a given source node ref.
   * Supports: assertion:{id}, episode:{id}, evaluation:{id}, commitment:{id}
   */
  resolveSourceAgentId(sourceNodeRef: string): Promise<string | null>;

  /**
   * Resolve a canonical cognition reference by key and optional agent ID.
   * Returns a node ref like "assertion:{id}" or "{kind}:{id}" for evaluations/commitments.
   */
  resolveCanonicalCognitionRefByKey(cognitionKey: string, sourceAgentId: string | null): Promise<string | null>;
}
