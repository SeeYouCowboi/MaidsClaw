/**
 * RelationBuilder — writes and reads `conflicts_with` relations in `memory_relations`
 * when assertions transition to the `contested` stance.
 *
 * V1 scope: only `conflicts_with` relations for contested assertion transitions.
 * Does NOT touch `logic_edges` (event-only).
 */

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

export type ConflictEvidence = {
  targetRef: string;
  strength: number;
  sourceKind: string;
  sourceRef: string;
  createdAt: number;
};

export class RelationBuilder {
  constructor(private readonly db: DbLike) {}

  /**
   * Write a `conflicts_with` relation when an assertion transitions to `contested`.
   *
   * @param sourceNodeRef - The contested assertion ref, e.g. `"private_belief:{id}"`
   * @param cognitionKey  - The cognition key of the assertion (used to build virtual target ref)
   * @param sourceRef     - Provenance ref (e.g. settlement ID)
   * @param strength      - Relation strength (0–1), default 0.8
   */
  writeContestRelation(
    sourceNodeRef: string,
    cognitionKey: string,
    sourceRef: string,
    strength = 0.8,
  ): void {
    const targetNodeRef = `cognition_key:${cognitionKey}`;

    // Guard: source_node_ref != target_node_ref (CHECK constraint)
    if (sourceNodeRef === targetNodeRef) {
      return;
    }

    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memory_relations
         (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at)
         VALUES (?, ?, 'conflicts_with', ?, 'direct', 'agent_op', ?, ?)`,
      )
      .run(sourceNodeRef, targetNodeRef, strength, sourceRef, now);
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
         WHERE source_node_ref = ? AND relation_type = 'conflicts_with'
         ORDER BY strength DESC
         LIMIT ?`,
      )
      .all(sourceNodeRef, limit) as ConflictEvidenceRow[];

    return rows.map((row) => ({
      targetRef: row.target_node_ref,
      strength: row.strength,
      sourceKind: row.source_kind,
      sourceRef: row.source_ref,
      createdAt: row.created_at,
    }));
  }
}
