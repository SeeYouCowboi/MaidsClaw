/**
 * RelationBuilder — writes and reads `conflicts_with` relations in `memory_relations`
 * when assertions transition to the `contested` stance.
 *
 * V1 scope: only `conflicts_with` relations for contested assertion transitions.
 * Does NOT touch `logic_edges` (event-only).
 */

import type { MemoryRelationType, RelationDirectness, RelationSourceKind } from "../types.js";
import type { ResolutionChainType } from "../contracts/relation-contract.js";
import { parseGraphNodeRef } from "../contracts/graph-node-ref.js";
import type { CognitionProjectionRepo } from "../../storage/domain-repos/contracts/cognition-projection-repo.js";
import type { RelationReadRepo } from "../../storage/domain-repos/contracts/relation-read-repo.js";
import type { RelationWriteRepo } from "../../storage/domain-repos/contracts/relation-write-repo.js";

const COGNITION_KEY_PREFIX = "cognition_key" + ":";

export const CONFLICTS_WITH: MemoryRelationType = "conflicts_with";
export const DIRECTNESS_DIRECT: RelationDirectness = "direct";
export const SOURCE_KIND_AGENT_OP: RelationSourceKind = "agent_op";

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

type RelationBuilderDeps = {
  relationWriteRepo: RelationWriteRepo;
  relationReadRepo: RelationReadRepo;
  cognitionProjectionRepo: CognitionProjectionRepo;
};

export class RelationBuilder {
  private readonly relationWriteRepo: RelationWriteRepo;
  private readonly relationReadRepo: RelationReadRepo;

  constructor(deps: RelationBuilderDeps | unknown) {
    if (isRelationBuilderDeps(deps)) {
      this.relationWriteRepo = deps.relationWriteRepo;
      this.relationReadRepo = deps.relationReadRepo;
      void deps.cognitionProjectionRepo;
      return;
    }

    const unsupported = (): never => {
      throw new Error("RelationBuilder requires PG repo dependencies");
    };

    this.relationWriteRepo = {
      upsertRelation: async () => unsupported(),
      getRelationsBySource: async () => unsupported(),
      getRelationsForNode: async () => unsupported(),
    };

    this.relationReadRepo = {
      getConflictEvidence: async () => unsupported(),
      getConflictHistory: async () => unsupported(),
      resolveSourceAgentId: async () => unsupported(),
      resolveCanonicalCognitionRefByKey: async () => unsupported(),
    };
  }

  /**
   * Write a `conflicts_with` relation when an assertion transitions to `contested`.
   *
   * @param sourceNodeRef - The contested assertion ref, e.g. `"assertion:{id}"`
   * @param factorNodeRefs - Stable factor refs resolved from settlement artifacts
   * @param sourceRef     - Provenance ref (e.g. settlement ID)
   * @param strength      - Relation strength (0–1), default 0.8
   */
  async writeContestRelations(
    sourceNodeRef: string,
    factorNodeRefs: string[],
    sourceRef: string,
    strength = 0.8,
  ): Promise<void> {
    const sourceAgentId = await this.resolveSourceAgentId(sourceNodeRef);
    const canonicalSourceRef = await this.resolveTargetNodeRef(sourceNodeRef, sourceAgentId);
    if (!canonicalSourceRef) {
      throw new Error(`Unsupported conflict source node ref: ${sourceNodeRef}`);
    }

    const targets = new Set<string>();
    let droppedInvalidRefs = 0;
    for (const nodeRef of factorNodeRefs) {
      const resolvedTargetRef = await this.resolveTargetNodeRef(nodeRef, sourceAgentId);
      if (!resolvedTargetRef) {
        droppedInvalidRefs += 1;
        continue;
      }

      if (resolvedTargetRef === canonicalSourceRef) {
        continue;
      }

      targets.add(resolvedTargetRef);
    }

    if (droppedInvalidRefs > 0) {
      console.warn(
        `[relation_builder_conflict_factor_dropped] source=${sourceNodeRef} dropped=${droppedInvalidRefs} source_ref=${sourceRef}`,
      );
    }

    if (targets.size === 0) {
      return;
    }

    for (const targetNodeRef of targets) {
      await this.writeRelation(CONFLICTS_WITH, canonicalSourceRef, targetNodeRef, sourceRef, {
        strength,
      });
    }
  }

  /**
   * Write a single relation of any `MemoryRelationType` into `memory_relations`.
   *
   * Defaults mirror the `conflicts_with` path:
   *   strength = 0.8, directness = "direct", sourceKind = "agent_op"
   */
  async writeRelation(
    relationType: MemoryRelationType,
    sourceNodeRef: string,
    targetNodeRef: string,
    sourceRef: string,
    options?: {
      strength?: number;
      directness?: RelationDirectness;
      sourceKind?: RelationSourceKind;
    },
  ): Promise<void> {
    const strength = options?.strength ?? 0.8;
    const directness: RelationDirectness = options?.directness ?? DIRECTNESS_DIRECT;
    const sourceKind: RelationSourceKind = options?.sourceKind ?? SOURCE_KIND_AGENT_OP;
    const now = Date.now();

    await this.relationWriteRepo.upsertRelation({
      sourceNodeRef,
      targetNodeRef,
      relationType,
      sourceKind,
      sourceRef,
      strength,
      directness,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Read up to `limit` conflict evidence rows for a given source node ref.
   * Returns strongest-first.
   */
  async getConflictEvidence(sourceNodeRef: string, limit = 3): Promise<ConflictEvidence[]> {
    const sourceAgentId = await this.resolveSourceAgentId(sourceNodeRef);
    const canonicalSourceRef = await this.resolveTargetNodeRef(sourceNodeRef, sourceAgentId);
    if (!canonicalSourceRef) {
      throw new Error(`Unsupported conflict source node ref: ${sourceNodeRef}`);
    }

    const rows = await this.relationWriteRepo.getRelationsBySource(canonicalSourceRef, CONFLICTS_WITH);
    rows.sort((a, b) => b.strength - a.strength);
    const limitedRows = rows.slice(0, limit);

    const normalized: ConflictEvidence[] = [];
    for (const row of limitedRows) {
      const targetRef = await this.resolveTargetNodeRef(row.target_node_ref, sourceAgentId);
      if (!targetRef) {
        continue;
      }
      normalized.push({
        targetRef,
        strength: row.strength,
        sourceKind: row.source_kind as RelationSourceKind,
        sourceRef: row.source_ref,
        createdAt: row.created_at,
      });
    }

    return normalized;
  }

  /**
   * Query the conflict/resolution chain for a given node ref, ordered by time (ASC).
   * Returns `conflicts_with`, `resolved_by`, and `downgraded_by` relations
   * where the node appears as either source or target.
   */
  async getConflictHistory(nodeRef: string, limit = 20): Promise<ConflictHistoryEntry[]> {
    const rows = await this.relationWriteRepo.getRelationsForNode(nodeRef, [
      "conflicts_with",
      "resolved_by",
      "downgraded_by",
    ]);

    const mapped = rows.map((row) => ({
      relation_type: row.relation_type as ConflictHistoryEntry["relation_type"],
      source_node_ref: row.source_node_ref,
      target_node_ref: row.target_node_ref,
      created_at: row.created_at,
    }));

    mapped.sort((a, b) => a.created_at - b.created_at);
    return mapped.slice(0, limit);
  }

  private async resolveTargetNodeRef(rawNodeRef: string, sourceAgentId: string | null): Promise<string | null> {
    const trimmed = rawNodeRef.trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.startsWith("private_episode:")) {
      return trimmed;
    }
    try {
      parseGraphNodeRef(trimmed);
      return trimmed;
    } catch {
      // not a direct node ref, try cognition key resolution
    }

    const cognitionKey = this.extractCognitionKey(trimmed);
    if (!cognitionKey) {
      return null;
    }

    return this.resolveCanonicalCognitionRefByKey(cognitionKey, sourceAgentId);
  }

  private async resolveSourceAgentId(sourceNodeRef: string): Promise<string | null> {
    return this.relationReadRepo.resolveSourceAgentId(sourceNodeRef);
  }

  private extractCognitionKey(rawRef: string): string | null {
    if (rawRef.startsWith(COGNITION_KEY_PREFIX)) {
      const prefixed = rawRef.slice(COGNITION_KEY_PREFIX.length).trim();
      return prefixed.length > 0 ? prefixed : null;
    }

    return null;
  }

  private async resolveCanonicalCognitionRefByKey(
    cognitionKey: string,
    sourceAgentId: string | null,
  ): Promise<string | null> {
    return this.relationReadRepo.resolveCanonicalCognitionRefByKey(cognitionKey, sourceAgentId);
  }
}

function isRelationBuilderDeps(value: unknown): value is RelationBuilderDeps {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<RelationBuilderDeps>;
  return (
    typeof candidate.relationWriteRepo === "object"
    && candidate.relationWriteRepo !== null
    && typeof candidate.relationReadRepo === "object"
    && candidate.relationReadRepo !== null
    && typeof candidate.cognitionProjectionRepo === "object"
    && candidate.cognitionProjectionRepo !== null
  );
}
