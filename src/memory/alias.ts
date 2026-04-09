import type { EntityAlias } from "./types.js";
import type { AliasRepo } from "../storage/domain-repos/contracts/alias-repo.js";
import { containsCjk, initCjkSegmenter, loadUserDict } from "./cjk-segmenter.js";

export class AliasService {
  constructor(private readonly repo: AliasRepo) {}

  /**
   * Load all shared aliases (owner_agent_id IS NULL) into the CJK segmenter's
   * user dictionary. Call once at bootstrap, after the repo is ready. Private
   * agent-scoped aliases are intentionally excluded to avoid leaking entity
   * names across agent boundaries.
   *
   * Failures are swallowed: if the segmenter is unavailable or the repo
   * query fails, the tokenizer falls back to its bigram path without
   * disturbing the rest of bootstrap.
   */
  async syncSharedAliasesToSegmenter(): Promise<void> {
    initCjkSegmenter();
    try {
      const aliases = await this.repo.listSharedAliasStrings();
      loadUserDict(aliases);
    } catch {
      // Segmenter will still work with the default jieba dictionary.
    }
  }

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
   * Return distinct private alias strings owned by `agentId`. Used by
   * RuleBasedQueryRouter's private-alias substring scan to recover CJK
   * aliases the global jieba tokenizer cannot recognize. Strictly
   * agent-scoped — does not include shared aliases.
   */
  async listPrivateAliasStrings(agentId: string): Promise<string[]> {
    return this.repo.listPrivateAliasStrings(agentId);
  }

  /**
   * Create an alias for a canonical entity.
   * Returns the alias id (existing or newly created).
   *
   * GAP-4 §7: when a shared CJK alias is created at runtime (not during
   * bootstrap), incrementally merge it into jieba's user dictionary so the
   * tokenizer can recognize it as a single token immediately, without
   * waiting for the next bootstrap to call `syncSharedAliasesToSegmenter`.
   * Private aliases are intentionally excluded from the global jieba dict
   * (scope isolation); they are recovered via the router's second-pass
   * substring scan (GAP-4 §8). Latin-only and < 2 char aliases are
   * filtered by `loadUserDict` itself; we still gate on `containsCjk` here
   * to skip the call entirely for non-CJK shared aliases.
   *
   * Failures of `loadUserDict` are swallowed by the segmenter module
   * (logged but not thrown), so this code path cannot break alias
   * creation.
   */
  async createAlias(
    canonicalId: number,
    alias: string,
    aliasType?: string,
    ownerAgentId?: string,
  ): Promise<number> {
    const id = await this.repo.createAlias(canonicalId, alias, aliasType, ownerAgentId);
    if (!ownerAgentId && containsCjk(alias)) {
      loadUserDict([alias]);
    }
    return id;
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
