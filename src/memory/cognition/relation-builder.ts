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

type AgentRow = { agent_id: string };
type AssertionIdRow = { id: number };
type CognitionProjectionRow = { id: number; kind: string | null };

const STABLE_FACTOR_REF_PATTERN = /^(assertion|evaluation|commitment|private_belief|private_event|private_episode|event):\d+$/;
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
    const sourceAgentId = this.resolveSourceAgentId(sourceNodeRef);
    const canonicalSourceRef = this.resolveTargetNodeRef(sourceNodeRef, sourceAgentId) ?? sourceNodeRef.trim();

    const targets = new Set<string>();
    let droppedInvalidRefs = 0;
    for (const nodeRef of factorNodeRefs) {
      const resolvedTargetRef = this.resolveTargetNodeRef(nodeRef, sourceAgentId);
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
    const sourceAgentId = this.resolveSourceAgentId(sourceNodeRef);
    const rows = this.db
      .prepare(
        `SELECT target_node_ref, strength, source_kind, source_ref, created_at
         FROM memory_relations
         WHERE source_node_ref = ? AND relation_type = ?
         ORDER BY strength DESC
         LIMIT ?`,
      )
      .all(sourceNodeRef, CONFLICTS_WITH, limit) as ConflictEvidenceRow[];

    const normalized: ConflictEvidence[] = [];
    for (const row of rows) {
      const targetRef = this.resolveTargetNodeRef(row.target_node_ref, sourceAgentId);
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

  private resolveTargetNodeRef(rawNodeRef: string, sourceAgentId: string | null): string | null {
    const trimmed = rawNodeRef.trim();
    if (!trimmed) {
      return null;
    }

    if (STABLE_FACTOR_REF_PATTERN.test(trimmed)) {
      if (trimmed.startsWith("private_belief:")) {
        return `assertion:${trimmed.slice("private_belief:".length)}`;
      }
      if (trimmed.startsWith("private_event:")) {
        return trimmed;
      }
      return trimmed;
    }

    const cognitionKey = this.extractCognitionKey(trimmed);
    if (!cognitionKey) {
      return null;
    }

    return this.resolveCanonicalCognitionRefByKey(cognitionKey, sourceAgentId);
  }

  private resolveSourceAgentId(sourceNodeRef: string): string | null {
    const trimmed = sourceNodeRef.trim();

    if (trimmed.startsWith("assertion:")) {
      const id = Number(trimmed.slice("assertion:".length));
      if (!Number.isFinite(id)) {
        return null;
      }

      const row = this.db
        .prepare(`SELECT agent_id FROM agent_fact_overlay WHERE id = ?`)
        .get(id) as AgentRow | null;
      return row?.agent_id ?? null;
    }

    if (trimmed.startsWith("private_belief:")) {
      const id = Number(trimmed.slice("private_belief:".length));
      if (!Number.isFinite(id)) {
        return null;
      }

      const row = this.db
        .prepare(`SELECT agent_id FROM agent_fact_overlay WHERE id = ?`)
        .get(id) as AgentRow | null;
      return row?.agent_id ?? null;
    }

    if (trimmed.startsWith("evaluation:") || trimmed.startsWith("commitment:") || trimmed.startsWith("private_event:")) {
      const id = Number(trimmed.slice(trimmed.indexOf(":") + 1));
      if (!Number.isFinite(id)) {
        return null;
      }

      const row = this.db
        .prepare(`SELECT agent_id FROM private_cognition_current WHERE id = ?`)
        .get(id) as AgentRow | null;
      return row?.agent_id ?? null;
    }

    return null;
  }

  private extractCognitionKey(rawRef: string): string | null {
    if (rawRef.startsWith(COGNITION_KEY_PREFIX)) {
      const prefixed = rawRef.slice(COGNITION_KEY_PREFIX.length).trim();
      return prefixed.length > 0 ? prefixed : null;
    }

    return null;
  }

  private resolveCanonicalCognitionRefByKey(cognitionKey: string, sourceAgentId: string | null): string | null {
    const agentFilter = sourceAgentId ? " AND agent_id = ?" : "";
    const agentBind = sourceAgentId ? [sourceAgentId] : [];

    const assertion = this.db
      .prepare(
        `SELECT id
         FROM agent_fact_overlay
         WHERE cognition_key = ?${agentFilter}
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
      )
      .get(cognitionKey, ...agentBind) as AssertionIdRow | null;
    if (assertion) {
      return `assertion:${assertion.id}`;
    }

    const cognition = this.db
      .prepare(
        `SELECT id, kind
         FROM private_cognition_current
         WHERE cognition_key = ?${agentFilter}
           AND kind IN ('evaluation', 'commitment')
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
      )
      .get(cognitionKey, ...agentBind) as CognitionProjectionRow | null;
    if (!cognition || (cognition.kind !== "evaluation" && cognition.kind !== "commitment")) {
      return null;
    }

    return `${cognition.kind}:${cognition.id}`;
  }
}
