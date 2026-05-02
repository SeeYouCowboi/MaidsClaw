import type { ConversationHistoryMode } from "../storage/domain-repos/contracts/interaction-repo.js";
import type { RetrievalTemplate } from "../memory/contracts/retrieval-template.js";
import type { WriteTemplate } from "../memory/contracts/write-template.js";

export type AgentRole = "maiden" | "rp_agent" | "task_agent";

export type AgentLifecycle = "persistent" | "ephemeral";

export type OutputMode = "freeform" | "structured";

export type ToolPermission = {
  toolName: string;
  allowed: boolean;
};

export type AuthorizationPolicy = {
  canReadAgentIds: string[];
};

export type AgentProfile = {
  id: string;
  role: AgentRole;
  lifecycle: AgentLifecycle;
  userFacing: boolean;
  outputMode: OutputMode;
  /**
   * Legacy in-memory fallback for callers that have not migrated yet. Runtime
   * config and public APIs use thinkerModelId/talkerModelId instead.
   */
  modelId?: string;
  talkerModelId?: string;
  thinkerModelId?: string;
  talkerThinkerEnabled?: boolean;
  maxOutputTokens?: number;
  personaId?: string;
  toolPermissions: ToolPermission[];
  authorizationPolicy?: AuthorizationPolicy;
  maxDelegationDepth: number;
  detachable?: boolean;
  contextBudget?: {
    maxTokens: number;
    reservedForCoordination?: number;
  };
  lorebookEnabled: boolean;
  narrativeContextEnabled: boolean;
  conversationHistoryMode?: ConversationHistoryMode;
  retrievalTemplate?: RetrievalTemplate;
  writeTemplate?: WriteTemplate;
};

export type EphemeralSpawnConfig = {
  baseProfileId: string;
  overrides?: Partial<Pick<AgentProfile, "thinkerModelId" | "talkerModelId" | "outputMode" | "toolPermissions" | "detachable" | "narrativeContextEnabled">>;
  taskContract?: unknown; // Task-specific context schema
};

export function getThinkerModelId(profile: AgentProfile): string {
  const modelId = profile.thinkerModelId ?? profile.modelId;
  if (!modelId) {
    throw new Error(`Agent "${profile.id}" is missing thinkerModelId`);
  }
  return modelId;
}

export function getTalkerModelId(profile: AgentProfile): string {
  return profile.talkerModelId ?? getThinkerModelId(profile);
}
