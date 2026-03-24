/**
 * RelationBuilder — writes and reads `conflicts_with` relations in `memory_relations`
 * when assertions transition to the `contested` stance.
 *
 * V1 scope: only `conflicts_with` relations for contested assertion transitions.
 * Does NOT touch `logic_edges` (event-only).
 */

import type { MemoryRelationType, RelationDirectness, RelationSourceKind } from "../types.js";

type DbLike = {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
};

type ConflictEvidenceRow = {
  target_node_ref: string;
  strength: number;
  source_kind: string;
  source_ref: string;
  created_at: number;
};

const STABLE_FACTOR_REF_PATTERN = /^(assertion|evaluation|commitment|private_belief|private_event|private_episode|event):\d+$/;

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

export class RelationBuilder {
  constructor(private readonly db: DbLike) {}

  /**
   * Write a `conflicts_with` relation when an assertion transitions to `contested`.
   *
   * @param sourceNodeRef - The contested assertion ref, e.g. `"private_belief:{id}"`
   * @param factorNodeRefs - Stable factor refs resolved from settlement artifacts
   * @param sourceRef     - Provenance ref (e.g. settlement ID)
   * @param strength      - Relation strength (0–1), default 0.8
   */
  writeContestRelations(
    sourceNodeRef: string,
    factorNodeRefs: string[],
    sourceRef: string,
    strength = 0.8,
  ): void {
    const targets = new Set<string>();
    let droppedInvalidRefs = 0;
    for (const nodeRef of factorNodeRefs) {
      const trimmed = nodeRef.trim();
      if (!STABLE_FACTOR_REF_PATTERN.test(trimmed)) {
        droppedInvalidRefs += 1;
        continue;
      }
      if (trimmed === sourceNodeRef) {
        continue;
      }
      targets.add(trimmed);
    }

    if (droppedInvalidRefs > 0) {
      console.warn(
        `[relation_builder_conflict_factor_dropped] source=${sourceNodeRef} dropped=${droppedInvalidRefs} source_ref=${sourceRef}`,
      );
    }

    if (targets.size === 0) {
      return;
    }

    const now = Date.now();
    for (const targetNodeRef of targets) {
      this.db
        .prepare(
          `INSERT INTO memory_relations
           (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_node_ref, target_node_ref, relation_type, source_kind, source_ref)
           DO UPDATE SET strength = excluded.strength, updated_at = excluded.updated_at`,
        )
        .run(
          sourceNodeRef,
          targetNodeRef,
          CONFLICTS_WITH,
          strength,
          DIRECTNESS_DIRECT,
          SOURCE_KIND_AGENT_OP,
          sourceRef,
          now,
          now,
        );
    }
  }

  /**
   * Read up to `limit` conflict evidence rows for a given source node ref.
   * Returns strongest-first.
   */
  getConflictEvidence(sourceNodeRef: string, limit = 3): ConflictEvidence[] {
    const rows = this.db
      .prepare(
        `SELECT target_node_ref, strength, source_kind, source_ref, created_at
         FROM memory_relations
         WHERE source_node_ref = ? AND relation_type = ?
         ORDER BY strength DESC
         LIMIT ?`,
      )
      .all(sourceNodeRef, CONFLICTS_WITH, limit) as ConflictEvidenceRow[];

    return rows.map((row) => ({
      targetRef: row.target_node_ref,
      strength: row.strength,
      sourceKind: row.source_kind as RelationSourceKind,
      sourceRef: row.source_ref,
      createdAt: row.created_at,
    }));
  }
}
