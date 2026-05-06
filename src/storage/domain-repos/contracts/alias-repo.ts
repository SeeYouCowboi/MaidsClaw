import type { EntityAlias } from "../../../memory/types.js";

export type AliasLifecycleStatusValue = "active" | "pending_review" | "conflicted" | "deprecated";

export type AliasLifecycleCreate = {
  canonicalId: number;
  alias: string;
  aliasType?: string;
  ownerAgentId?: string;
  status?: AliasLifecycleStatusValue;
  conflictGroupKey?: string | null;
  reviewReason?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: number | null;
  sourceKind?: string | null;
  sourceRef?: string | null;
  createdAt?: number;
  updatedAt?: number;
};

export type AliasLifecycleStatus = {
  id: number;
  canonicalId: number;
  alias: string;
  aliasType: string | null;
  ownerAgentId: string | null;
  status: AliasLifecycleStatusValue;
  conflictGroupKey: string | null;
  reviewReason: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  sourceKind: string | null;
  sourceRef: string | null;
  createdAt: number;
  updatedAt: number;
};

export interface AliasRepo {
  resolveAlias(alias: string, ownerAgentId?: string): Promise<number | null>;

  resolveAliases(aliases: string[], ownerAgentId?: string): Promise<Map<string, number | null>>;

  createAlias(
    canonicalId: number,
    alias: string,
    aliasType?: string,
    ownerAgentId?: string,
  ): Promise<number>;

  createAliasWithLifecycle(params: AliasLifecycleCreate): Promise<number>;

  getAliasLifecycleStatus(alias: string, ownerAgentId?: string): Promise<AliasLifecycleStatus | null>;

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

  /**
   * Return distinct private alias strings owned by the given agent
   * (owner_agent_id = agentId). Used by RuleBasedQueryRouter's private-alias
   * substring scan (GAP-4 §8) to recover CJK aliases that the global jieba
   * tokenizer cannot recognize without leaking them across agent boundaries.
   * The agentId is the only scope key — implementations MUST filter strictly
   * by owner_agent_id and MUST NOT fall back to shared aliases.
   */
  listPrivateAliasStrings(agentId: string): Promise<string[]>;
}
