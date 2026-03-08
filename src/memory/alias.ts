import type { Database } from "bun:sqlite";
import type { EntityAlias } from "./types.js";

export class AliasService {
  constructor(private readonly db: Database) {}

  /**
   * Exact string match lookup: returns canonical entity_id or null
   * Lookup priority:
   * 1. If ownerAgentId: check agent-specific alias first
   * 2. Then check shared alias
   * 3. Also check entity_nodes.pointer_key (canonical name = alias)
   */
  resolveAlias(alias: string, ownerAgentId?: string): number | null {
    // 1. Try agent-specific alias
    if (ownerAgentId) {
      const agentAlias = this.db.prepare(
        "SELECT canonical_id FROM entity_aliases WHERE alias=? AND owner_agent_id=?",
      ).get(alias, ownerAgentId) as { canonical_id: number } | undefined;
      if (agentAlias) return agentAlias.canonical_id;
    }

    // 2. Try shared alias
    const sharedAlias = this.db.prepare(
      "SELECT canonical_id FROM entity_aliases WHERE alias=? AND owner_agent_id IS NULL",
    ).get(alias) as { canonical_id: number } | undefined;
    if (sharedAlias) return sharedAlias.canonical_id;

    // 3. Try pointer_key (canonical entity name)
    if (ownerAgentId) {
      const privateEntity = this.db.prepare(
        "SELECT id FROM entity_nodes WHERE pointer_key=? AND memory_scope='private_overlay' AND owner_agent_id=?",
      ).get(alias, ownerAgentId) as { id: number } | undefined;
      if (privateEntity) return privateEntity.id;
    }

    const publicEntity = this.db.prepare(
      "SELECT id FROM entity_nodes WHERE pointer_key=? AND memory_scope='shared_public'",
    ).get(alias) as { id: number } | undefined;
    if (publicEntity) return publicEntity.id;

    return null;
  }

  /**
   * Bulk resolution: returns Map<alias, entityId|null>
   */
  resolveAliases(aliases: string[], ownerAgentId?: string): Map<string, number | null> {
    return new Map(aliases.map(a => [a, this.resolveAlias(a, ownerAgentId)]));
  }

  /**
   * Create an alias for a canonical entity.
   * Returns the alias id (existing or newly created).
   */
  createAlias(
    canonicalId: number,
    alias: string,
    aliasType?: string,
    ownerAgentId?: string,
  ): number {
    this.db.prepare(
      "INSERT OR IGNORE INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id) VALUES (?,?,?,?)",
    ).run(canonicalId, alias, aliasType ?? null, ownerAgentId ?? null);

    const result = this.db.prepare(
      "SELECT id FROM entity_aliases WHERE canonical_id=? AND alias=? AND (owner_agent_id IS ? OR owner_agent_id=?)",
    ).get(canonicalId, alias, ownerAgentId ?? null, ownerAgentId ?? null) as { id: number } | undefined;

    if (!result) {
      throw new Error("Failed to create or retrieve alias");
    }

    return result.id;
  }

  /**
   * Get all aliases for a canonical entity.
   * Returns aliases owned by the specified agent OR shared aliases (owner_agent_id IS NULL).
   */
  getAliasesForEntity(canonicalId: number, ownerAgentId?: string): EntityAlias[] {
    const results = this.db.prepare(
      "SELECT * FROM entity_aliases WHERE canonical_id=? AND (owner_agent_id IS NULL OR owner_agent_id=?)",
    ).all(canonicalId, ownerAgentId ?? null) as EntityAlias[];

    return results;
  }

  /**
   * Parse event_nodes.participants JSON array, resolve each entity ref to entity records.
   * Participants can be numeric entity IDs or pointer_key strings.
   */
  resolveParticipants(
    participantsJson: string | null,
  ): Array<{ ref: string; entityId: number | null }> {
    if (!participantsJson) return [];

    let refs: unknown[];
    try {
      refs = JSON.parse(participantsJson);
    } catch {
      return [];
    }

    return refs.map(ref => {
      const refStr = String(ref);
      // If numeric, it's an entity ID
      const numId = Number(refStr);
      if (Number.isInteger(numId) && numId > 0) {
        const entity = this.db.prepare(
          "SELECT id FROM entity_nodes WHERE id=?",
        ).get(numId) as { id: number } | undefined;
        return { ref: refStr, entityId: entity?.id ?? null };
      }
      // Otherwise it's a pointer_key string — resolve via alias
      const entityId = this.resolveAlias(refStr);
      return { ref: refStr, entityId };
    });
  }
}
