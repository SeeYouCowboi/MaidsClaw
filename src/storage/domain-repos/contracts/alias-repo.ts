import type { EntityAlias } from "../../../memory/types.js";

export interface AliasRepo {
  resolveAlias(alias: string, ownerAgentId?: string): Promise<number | null>;

  resolveAliases(aliases: string[], ownerAgentId?: string): Promise<Map<string, number | null>>;

  createAlias(
    canonicalId: number,
    alias: string,
    aliasType?: string,
    ownerAgentId?: string,
  ): Promise<number>;

  getAliasesForEntity(canonicalId: number, ownerAgentId?: string): Promise<EntityAlias[]>;

  findEntityById(id: number): Promise<{ id: number; pointer_key: string; memory_scope: string; owner_agent_id: string | null } | null>;

  findEntityByPointerKey(
    pointerKey: string,
    scope: string,
    ownerAgentId?: string,
  ): Promise<{ id: number; pointer_key: string; memory_scope: string; owner_agent_id: string | null } | null>;

  /**
   * Return distinct shared alias strings (owner_agent_id IS NULL).
   *
   * Used by the CJK segmenter to build its user dictionary at bootstrap.
   * Private/agent-scoped aliases are intentionally excluded to avoid leaking
   * entity names across agent boundaries through a global tokenizer dict.
   */
  listSharedAliasStrings(): Promise<string[]>;
}
