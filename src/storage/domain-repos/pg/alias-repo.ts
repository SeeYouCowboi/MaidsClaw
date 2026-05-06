import type postgres from "postgres";
import type { EntityAlias } from "../../../memory/types.js";
import type {
  AliasLifecycleCreate,
  AliasLifecycleStatus,
  AliasLifecycleStatusValue,
  AliasRepo,
} from "../contracts/alias-repo.js";

function normalizeLookupText(raw: string): string {
  return raw.normalize("NFKC").trim();
}

type AliasLifecycleRow = {
  id: number;
  canonical_id: number;
  alias: string;
  alias_type: string | null;
  owner_agent_id: string | null;
  status: AliasLifecycleStatusValue;
  conflict_group_key: string | null;
  review_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  source_kind: string | null;
  source_ref: string | null;
  created_at: number;
  updated_at: number;
};

function toAliasLifecycleStatus(row: AliasLifecycleRow): AliasLifecycleStatus {
  return {
    id: Number(row.id),
    canonicalId: Number(row.canonical_id),
    alias: row.alias,
    aliasType: row.alias_type,
    ownerAgentId: row.owner_agent_id,
    status: row.status,
    conflictGroupKey: row.conflict_group_key,
    reviewReason: row.review_reason,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at === null ? null : Number(row.reviewed_at),
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class PgAliasRepo implements AliasRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async resolveAlias(alias: string, ownerAgentId?: string): Promise<number | null> {
    const lookup = normalizeLookupText(alias);
    if (lookup.length === 0) {
      return null;
    }

    if (ownerAgentId) {
      const agentAlias = await this.sql<{ canonical_id: number }[]>`
        SELECT canonical_id
        FROM entity_aliases
        WHERE (alias = ${lookup} OR LOWER(alias) = LOWER(${lookup}))
          AND owner_agent_id = ${ownerAgentId}
          AND status = 'active'
        ORDER BY CASE WHEN alias = ${lookup} THEN 0 ELSE 1 END
        LIMIT 1
      `;
      if (agentAlias.length > 0) {
        return Number(agentAlias[0].canonical_id);
      }
    }

    const sharedAlias = await this.sql<{ canonical_id: number }[]>`
      SELECT canonical_id
      FROM entity_aliases
      WHERE (alias = ${lookup} OR LOWER(alias) = LOWER(${lookup}))
        AND owner_agent_id IS NULL
        AND status = 'active'
      ORDER BY CASE WHEN alias = ${lookup} THEN 0 ELSE 1 END
      LIMIT 1
    `;
    if (sharedAlias.length > 0) {
      return Number(sharedAlias[0].canonical_id);
    }

    if (ownerAgentId) {
      const privateEntity = await this.sql<{ id: number }[]>`
        SELECT id
        FROM entity_nodes
        WHERE (pointer_key = ${lookup} OR LOWER(pointer_key) = LOWER(${lookup}))
          AND memory_scope = 'private_overlay'
          AND owner_agent_id = ${ownerAgentId}
        ORDER BY CASE WHEN pointer_key = ${lookup} THEN 0 ELSE 1 END
        LIMIT 1
      `;
      if (privateEntity.length > 0) {
        return Number(privateEntity[0].id);
      }
    }

    const publicEntity = await this.sql<{ id: number }[]>`
      SELECT id
      FROM entity_nodes
      WHERE (pointer_key = ${lookup} OR LOWER(pointer_key) = LOWER(${lookup}))
        AND memory_scope = 'shared_public'
      ORDER BY CASE WHEN pointer_key = ${lookup} THEN 0 ELSE 1 END
      LIMIT 1
    `;
    if (publicEntity.length > 0) {
      return Number(publicEntity[0].id);
    }

    return null;
  }

  async resolveAliases(aliases: string[], ownerAgentId?: string): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    for (const alias of aliases) {
      result.set(alias, await this.resolveAlias(alias, ownerAgentId));
    }
    return result;
  }

  async createAlias(
    canonicalId: number,
    alias: string,
    aliasType?: string,
    ownerAgentId?: string,
  ): Promise<number> {
    let existing: { id: number }[];

    if (aliasType === undefined && ownerAgentId === undefined) {
      existing = await this.sql<{ id: number }[]>`
        SELECT id
        FROM entity_aliases
        WHERE canonical_id = ${canonicalId}
          AND alias = ${alias}
          AND alias_type IS NULL
          AND owner_agent_id IS NULL
          AND status = 'active'
        LIMIT 1
      `;
    } else if (aliasType === undefined) {
      // Narrowing: the first if ruled out (undefined, undefined); being in this
      // branch means ownerAgentId is defined even though TS can't infer it.
      const owner = ownerAgentId as string;
      existing = await this.sql<{ id: number }[]>`
        SELECT id
        FROM entity_aliases
        WHERE canonical_id = ${canonicalId}
          AND alias = ${alias}
          AND alias_type IS NULL
          AND owner_agent_id = ${owner}
          AND status = 'active'
        LIMIT 1
      `;
    } else if (ownerAgentId === undefined) {
      existing = await this.sql<{ id: number }[]>`
        SELECT id
        FROM entity_aliases
        WHERE canonical_id = ${canonicalId}
          AND alias = ${alias}
          AND alias_type = ${aliasType}
          AND owner_agent_id IS NULL
          AND status = 'active'
        LIMIT 1
      `;
    } else {
      existing = await this.sql<{ id: number }[]>`
        SELECT id
        FROM entity_aliases
        WHERE canonical_id = ${canonicalId}
          AND alias = ${alias}
          AND alias_type = ${aliasType}
          AND owner_agent_id = ${ownerAgentId}
          AND status = 'active'
        LIMIT 1
      `;
    }

    if (existing.length > 0) {
      return Number(existing[0].id);
    }

    const now = Date.now();
    const inserted = await this.sql<{ id: number }[]>`
      INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id, status, created_at, updated_at)
      VALUES (${canonicalId}, ${alias}, ${aliasType ?? null}, ${ownerAgentId ?? null}, 'active', ${now}, ${now})
      RETURNING id
    `;
    return Number(inserted[0].id);
  }

  async createAliasWithLifecycle(params: AliasLifecycleCreate): Promise<number> {
    const requestedStatus = params.status ?? "active";
    const now = Date.now();
    const createdAt = params.createdAt ?? now;
    const updatedAt = params.updatedAt ?? createdAt;
    const conflictGroupKey = params.conflictGroupKey ?? this.conflictGroupKey(params.alias, params.ownerAgentId);
    const existingActive = await this.findActiveAlias(params.alias, params.ownerAgentId);

    if (existingActive && Number(existingActive.canonical_id) === params.canonicalId && requestedStatus === "active") {
      return Number(existingActive.id);
    }

    const hasCanonicalConflict = existingActive && Number(existingActive.canonical_id) !== params.canonicalId;
    const status: AliasLifecycleStatusValue = hasCanonicalConflict ? "conflicted" : requestedStatus;
    const reviewReason = hasCanonicalConflict
      ? params.reviewReason ?? `Alias conflicts with active canonical_id ${existingActive.canonical_id}`
      : params.reviewReason ?? null;

    const inserted = await this.sql<{ id: number }[]>`
      INSERT INTO entity_aliases (
        canonical_id,
        alias,
        alias_type,
        owner_agent_id,
        status,
        conflict_group_key,
        review_reason,
        reviewed_by,
        reviewed_at,
        source_kind,
        source_ref,
        created_at,
        updated_at
      )
      VALUES (
        ${params.canonicalId},
        ${params.alias},
        ${params.aliasType ?? null},
        ${params.ownerAgentId ?? null},
        ${status},
        ${hasCanonicalConflict ? conflictGroupKey : params.conflictGroupKey ?? null},
        ${reviewReason},
        ${params.reviewedBy ?? null},
        ${params.reviewedAt ?? null},
        ${params.sourceKind ?? null},
        ${params.sourceRef ?? null},
        ${createdAt},
        ${updatedAt}
      )
      RETURNING id
    `;
    return Number(inserted[0].id);
  }

  async getAliasLifecycleStatus(alias: string, ownerAgentId?: string): Promise<AliasLifecycleStatus | null> {
    const lookup = normalizeLookupText(alias);
    if (lookup.length === 0) {
      return null;
    }

    const rows = ownerAgentId === undefined
      ? await this.sql<AliasLifecycleRow[]>`
          SELECT *
          FROM entity_aliases
          WHERE (alias = ${lookup} OR LOWER(alias) = LOWER(${lookup}))
            AND owner_agent_id IS NULL
          ORDER BY
            CASE status
              WHEN 'active' THEN 0
              WHEN 'conflicted' THEN 1
              WHEN 'pending_review' THEN 2
              WHEN 'deprecated' THEN 3
              ELSE 4
            END,
            updated_at DESC,
            id DESC
          LIMIT 1
        `
      : await this.sql<AliasLifecycleRow[]>`
          SELECT *
          FROM entity_aliases
          WHERE (alias = ${lookup} OR LOWER(alias) = LOWER(${lookup}))
            AND owner_agent_id = ${ownerAgentId}
          ORDER BY
            CASE status
              WHEN 'active' THEN 0
              WHEN 'conflicted' THEN 1
              WHEN 'pending_review' THEN 2
              WHEN 'deprecated' THEN 3
              ELSE 4
            END,
            updated_at DESC,
            id DESC
          LIMIT 1
        `;

    if (rows.length === 0) {
      return null;
    }
    return toAliasLifecycleStatus(rows[0]);
  }

  private conflictGroupKey(alias: string, ownerAgentId?: string): string {
    return `${normalizeLookupText(alias).toLowerCase()}:${ownerAgentId ?? "__shared__"}`;
  }

  private async findActiveAlias(alias: string, ownerAgentId?: string): Promise<{ id: number; canonical_id: number } | null> {
    const lookup = normalizeLookupText(alias);
    if (lookup.length === 0) {
      return null;
    }

    const rows = ownerAgentId === undefined
      ? await this.sql<{ id: number; canonical_id: number }[]>`
          SELECT id, canonical_id
          FROM entity_aliases
          WHERE (alias = ${lookup} OR LOWER(alias) = LOWER(${lookup}))
            AND owner_agent_id IS NULL
            AND status = 'active'
          ORDER BY CASE WHEN alias = ${lookup} THEN 0 ELSE 1 END, id ASC
          LIMIT 1
        `
      : await this.sql<{ id: number; canonical_id: number }[]>`
          SELECT id, canonical_id
          FROM entity_aliases
          WHERE (alias = ${lookup} OR LOWER(alias) = LOWER(${lookup}))
            AND owner_agent_id = ${ownerAgentId}
            AND status = 'active'
          ORDER BY CASE WHEN alias = ${lookup} THEN 0 ELSE 1 END, id ASC
          LIMIT 1
        `;

    return rows[0] ?? null;
  }

  async getAliasesForEntity(canonicalId: number, ownerAgentId?: string): Promise<EntityAlias[]> {
    const rows = ownerAgentId === undefined
      ? await this.sql<EntityAlias[]>`
          SELECT *
          FROM entity_aliases
          WHERE canonical_id = ${canonicalId}
        `
      : await this.sql<EntityAlias[]>`
          SELECT *
          FROM entity_aliases
          WHERE canonical_id = ${canonicalId}
            AND (owner_agent_id IS NULL OR owner_agent_id = ${ownerAgentId})
        `;
    return rows;
  }

  async findEntityById(
    id: number,
  ): Promise<{ id: number; pointer_key: string; memory_scope: string; owner_agent_id: string | null } | null> {
    const rows = await this.sql<{
      id: number;
      pointer_key: string;
      memory_scope: string;
      owner_agent_id: string | null;
    }[]>`
      SELECT id, pointer_key, memory_scope, owner_agent_id
      FROM entity_nodes
      WHERE id = ${id}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return null;
    }
    return {
      id: Number(rows[0].id),
      pointer_key: rows[0].pointer_key,
      memory_scope: rows[0].memory_scope,
      owner_agent_id: rows[0].owner_agent_id,
    };
  }

  async findEntityByPointerKey(
    pointerKey: string,
    scope: string,
    ownerAgentId?: string,
  ): Promise<{ id: number; pointer_key: string; memory_scope: string; owner_agent_id: string | null } | null> {
    let rows: {
      id: number;
      pointer_key: string;
      memory_scope: string;
      owner_agent_id: string | null;
    }[];

    if (scope === 'private_overlay' && ownerAgentId) {
      rows = await this.sql<{
        id: number;
        pointer_key: string;
        memory_scope: string;
        owner_agent_id: string | null;
      }[]>`
        SELECT id, pointer_key, memory_scope, owner_agent_id
        FROM entity_nodes
        WHERE pointer_key = ${pointerKey}
          AND memory_scope = ${scope}
          AND owner_agent_id = ${ownerAgentId}
        LIMIT 1
      `;
    } else {
      rows = await this.sql<{
        id: number;
        pointer_key: string;
        memory_scope: string;
        owner_agent_id: string | null;
      }[]>`
        SELECT id, pointer_key, memory_scope, owner_agent_id
        FROM entity_nodes
        WHERE pointer_key = ${pointerKey}
          AND memory_scope = ${scope}
        LIMIT 1
      `;
    }

    if (rows.length === 0) {
      return null;
    }
    return {
      id: Number(rows[0].id),
      pointer_key: rows[0].pointer_key,
      memory_scope: rows[0].memory_scope,
      owner_agent_id: rows[0].owner_agent_id,
    };
  }

  async listSharedAliasStrings(): Promise<string[]> {
    // Defensive cap. jieba user dictionary performance scales well into the
    // 10^6 range, but bootstrap-time loading is still bounded. If a deployment
    // ever exceeds this, we'll need a paged sync strategy.
    const LIMIT = 100_000;
    const rows = await this.sql<{ alias: string }[]>`
      SELECT DISTINCT alias
      FROM entity_aliases
      WHERE owner_agent_id IS NULL
        AND status = 'active'
      LIMIT ${LIMIT}
    `;
    return rows.map((r) => r.alias);
  }

  async listPrivateAliasStrings(agentId: string): Promise<string[]> {
    // Defensive cap on per-agent private alias count. A single agent should
    // never approach this; if it does, the substring scan in
    // RuleBasedQueryRouter would also become a hot loop and the scan should
    // be upgraded to Aho-Corasick (GAP-4 §8 future work).
    const LIMIT = 10_000;
    const rows = await this.sql<{ alias: string }[]>`
      SELECT DISTINCT alias
      FROM entity_aliases
      WHERE owner_agent_id = ${agentId}
        AND status = 'active'
      LIMIT ${LIMIT}
    `;
    return rows.map((r) => r.alias);
  }
}
