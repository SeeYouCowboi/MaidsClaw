import type postgres from "postgres";
import type { ResolutionChainType } from "../../../memory/contracts/relation-contract.js";
import { parseGraphNodeRef } from "../../../memory/contracts/graph-node-ref.js";
import type { RelationSourceKind } from "../../../memory/types.js";
import type {
  ConflictEvidence,
  ConflictHistoryEntry,
  RelationReadRepo,
} from "../contracts/relation-read-repo.js";

type ConflictEvidenceRow = {
  target_node_ref: string;
  strength: number;
  source_kind: string;
  source_ref: string;
  created_at: number;
};

type ConflictHistoryRow = {
  relation_type: string;
  source_node_ref: string;
  target_node_ref: string;
  created_at: number;
};

type AgentRow = { agent_id: string };
type AssertionIdRow = { id: number };
type CognitionProjectionRow = { id: number; kind: string | null };

const CONFLICTS_WITH = "conflicts_with";
const COGNITION_KEY_PREFIX = "cognition_key" + ":";

export class PgRelationReadRepo implements RelationReadRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async getConflictEvidence(sourceNodeRef: string, limit = 3): Promise<ConflictEvidence[]> {
    const sourceAgentId = await this.resolveSourceAgentId(sourceNodeRef);
    const canonicalSourceRef = await this.resolveTargetNodeRef(sourceNodeRef, sourceAgentId);
    if (!canonicalSourceRef) {
      throw new Error(`Unsupported conflict source node ref: ${sourceNodeRef}`);
    }

    const rows = await this.sql<ConflictEvidenceRow[]>`
      SELECT target_node_ref, strength, source_kind, source_ref, created_at
      FROM memory_relations
      WHERE source_node_ref = ${canonicalSourceRef} AND relation_type = ${CONFLICTS_WITH}
      ORDER BY strength DESC
      LIMIT ${limit}
    `;

    const normalized: ConflictEvidence[] = [];
    for (const row of rows) {
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

  async getConflictHistory(nodeRef: string, limit = 20): Promise<ConflictHistoryEntry[]> {
    const rows = await this.sql<ConflictHistoryRow[]>`
      SELECT relation_type, source_node_ref, target_node_ref, created_at
      FROM memory_relations
      WHERE (source_node_ref = ${nodeRef} OR target_node_ref = ${nodeRef})
        AND relation_type IN ('conflicts_with', 'resolved_by', 'downgraded_by')
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      relation_type: row.relation_type as ConflictHistoryEntry["relation_type"],
      source_node_ref: row.source_node_ref,
      target_node_ref: row.target_node_ref,
      created_at: row.created_at,
    }));
  }

  async resolveSourceAgentId(sourceNodeRef: string): Promise<string | null> {
    const trimmed = sourceNodeRef.trim();

    if (trimmed.startsWith("assertion:")) {
      const id = Number(trimmed.slice("assertion:".length));
      if (!Number.isFinite(id)) {
        return null;
      }

      const rows = await this.sql<AgentRow[]>`
        SELECT agent_id FROM private_cognition_current WHERE id = ${id} AND kind = 'assertion'
      `;
      return rows[0]?.agent_id ?? null;
    }

    if (trimmed.startsWith("episode:") || trimmed.startsWith("private_episode:")) {
      const prefix = trimmed.startsWith("episode:") ? "episode:" : "private_episode:";
      const id = Number(trimmed.slice(prefix.length));
      if (!Number.isFinite(id)) {
        return null;
      }

      const rows = await this.sql<AgentRow[]>`
        SELECT agent_id FROM private_episode_events WHERE id = ${id}
      `;
      return rows[0]?.agent_id ?? null;
    }

    if (trimmed.startsWith("evaluation:") || trimmed.startsWith("commitment:")) {
      const id = Number(trimmed.slice(trimmed.indexOf(":") + 1));
      if (!Number.isFinite(id)) {
        return null;
      }

      const rows = await this.sql<AgentRow[]>`
        SELECT agent_id FROM private_cognition_current WHERE id = ${id}
      `;
      return rows[0]?.agent_id ?? null;
    }

    return null;
  }

  async resolveCanonicalCognitionRefByKey(
    cognitionKey: string,
    sourceAgentId: string | null,
  ): Promise<string | null> {
    const agentFilter = sourceAgentId ? this.sql` AND agent_id = ${sourceAgentId}` : this.sql``;

    const assertionRows = await this.sql<AssertionIdRow[]>`
      SELECT id
      FROM private_cognition_current
      WHERE cognition_key = ${cognitionKey}
        AND kind = 'assertion'
        ${agentFilter}
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `;

    if (assertionRows.length > 0) {
      return `assertion:${assertionRows[0].id}`;
    }

    const cognitionRows = await this.sql<CognitionProjectionRow[]>`
      SELECT id, kind
      FROM private_cognition_current
      WHERE cognition_key = ${cognitionKey}
        AND kind IN ('evaluation', 'commitment')
        ${agentFilter}
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `;

    if (cognitionRows.length === 0) {
      return null;
    }

    const cognition = cognitionRows[0];
    if (cognition.kind !== "evaluation" && cognition.kind !== "commitment") {
      return null;
    }

    return `${cognition.kind}:${cognition.id}`;
  }

  private async resolveTargetNodeRef(rawNodeRef: string, sourceAgentId: string | null): Promise<string | null> {
    const trimmed = rawNodeRef.trim();
    if (!trimmed) {
      return null;
    }

    // Normalize legacy private_episode: refs to episode:
    if (trimmed.startsWith("private_episode:")) {
      return `episode:${trimmed.slice("private_episode:".length)}`;
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

  private extractCognitionKey(rawRef: string): string | null {
    if (rawRef.startsWith(COGNITION_KEY_PREFIX)) {
      const prefixed = rawRef.slice(COGNITION_KEY_PREFIX.length).trim();
      return prefixed.length > 0 ? prefixed : null;
    }

    return null;
  }
}
