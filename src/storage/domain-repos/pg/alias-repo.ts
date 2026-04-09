import type postgres from "postgres";
import type { EntityAlias } from "../../../memory/types.js";
import type { AliasRepo } from "../contracts/alias-repo.js";

export class PgAliasRepo implements AliasRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async resolveAlias(alias: string, ownerAgentId?: string): Promise<number | null> {
    if (ownerAgentId) {
      const agentAlias = await this.sql<{ canonical_id: number }[]>`
        SELECT canonical_id
        FROM entity_aliases
        WHERE alias = ${alias} AND owner_agent_id = ${ownerAgentId}
        LIMIT 1
      `;
      if (agentAlias.length > 0) {
        return Number(agentAlias[0].canonical_id);
      }
    }

    const sharedAlias = await this.sql<{ canonical_id: number }[]>`
      SELECT canonical_id
      FROM entity_aliases
      WHERE alias = ${alias} AND owner_agent_id IS NULL
      LIMIT 1
    `;
    if (sharedAlias.length > 0) {
      return Number(sharedAlias[0].canonical_id);
    }

    if (ownerAgentId) {
      const privateEntity = await this.sql<{ id: number }[]>`
        SELECT id
        FROM entity_nodes
        WHERE pointer_key = ${alias}
          AND memory_scope = 'private_overlay'
          AND owner_agent_id = ${ownerAgentId}
        LIMIT 1
      `;
      if (privateEntity.length > 0) {
        return Number(privateEntity[0].id);
      }
    }

    const publicEntity = await this.sql<{ id: number }[]>`
      SELECT id
      FROM entity_nodes
      WHERE pointer_key = ${alias}
        AND memory_scope = 'shared_public'
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
    const existing = await this.sql<{ id: number }[]>`
      SELECT id
      FROM entity_aliases
      WHERE canonical_id = ${canonicalId}
        AND alias = ${alias}
        AND ((alias_type = ${aliasType ?? null}) OR (alias_type IS NULL AND ${aliasType ?? null} IS NULL))
        AND ((owner_agent_id = ${ownerAgentId ?? null}) OR (owner_agent_id IS NULL AND ${ownerAgentId ?? null} IS NULL))
      LIMIT 1
    `;
    if (existing.length > 0) {
      return Number(existing[0].id);
    }

    const inserted = await this.sql<{ id: number }[]>`
      INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
      VALUES (${canonicalId}, ${alias}, ${aliasType ?? null}, ${ownerAgentId ?? null})
      RETURNING id
    `;
    return Number(inserted[0].id);
  }

  async getAliasesForEntity(canonicalId: number, ownerAgentId?: string): Promise<EntityAlias[]> {
    const rows = await this.sql<EntityAlias[]>`
      SELECT *
      FROM entity_aliases
      WHERE canonical_id = ${canonicalId}
        AND (owner_agent_id IS NULL OR owner_agent_id = ${ownerAgentId ?? null})
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
      LIMIT ${LIMIT}
    `;
    return rows.map((r) => r.alias);
  }
}
