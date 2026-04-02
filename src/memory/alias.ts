import type { EntityAlias } from "./types.js";
import type { AliasRepo } from "../storage/domain-repos/contracts/alias-repo.js";

export class AliasService {
  constructor(private readonly repo: AliasRepo) {}

  /**
   * Exact string match lookup: returns canonical entity_id or null
   * Lookup priority:
   * 1. If ownerAgentId: check agent-specific alias first
   * 2. Then check shared alias
   * 3. Also check entity_nodes.pointer_key (canonical name = alias)
   */
  async resolveAlias(alias: string, ownerAgentId?: string): Promise<number | null> {
    return this.repo.resolveAlias(alias, ownerAgentId);
  }

  /**
   * Bulk resolution: returns Map<alias, entityId|null>
   */
  async resolveAliases(aliases: string[], ownerAgentId?: string): Promise<Map<string, number | null>> {
    return this.repo.resolveAliases(aliases, ownerAgentId);
  }

  /**
   * Create an alias for a canonical entity.
   * Returns the alias id (existing or newly created).
   */
  async createAlias(
    canonicalId: number,
    alias: string,
    aliasType?: string,
    ownerAgentId?: string,
  ): Promise<number> {
    return this.repo.createAlias(canonicalId, alias, aliasType, ownerAgentId);
  }

  /**
   * Get all aliases for a canonical entity.
   * Returns aliases owned by the specified agent OR shared aliases (owner_agent_id IS NULL).
   */
  async getAliasesForEntity(canonicalId: number, ownerAgentId?: string): Promise<EntityAlias[]> {
    return this.repo.getAliasesForEntity(canonicalId, ownerAgentId);
  }

  /**
   * Parse event_nodes.participants JSON array, resolve each entity ref to entity records.
   * Participants can be numeric entity IDs or pointer_key strings.
   */
  async resolveParticipants(
    participantsJson: string | null,
  ): Promise<Array<{ ref: string; entityId: number | null }>> {
    if (!participantsJson) return [];

    let refs: unknown[];
    try {
      refs = JSON.parse(participantsJson);
    } catch {
      return [];
    }

    const results: Array<{ ref: string; entityId: number | null }> = [];
    for (const ref of refs) {
      const refStr = String(ref);
      // If numeric, it's an entity ID
      const numId = Number(refStr);
      if (Number.isInteger(numId) && numId > 0) {
        const entity = await this.repo.findEntityById(numId);
        results.push({ ref: refStr, entityId: entity?.id ?? null });
      } else {
        // Otherwise it's a pointer_key string — resolve via alias
        const entityId = await this.resolveAlias(refStr);
        results.push({ ref: refStr, entityId });
      }
    }

    return results;
  }
}
