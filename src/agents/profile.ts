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
  modelId: string;
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
  retrievalTemplate?: RetrievalTemplate;
  writeTemplate?: WriteTemplate;
};

export type EphemeralSpawnConfig = {
  baseProfileId: string;
  overrides?: Partial<Pick<AgentProfile, "modelId" | "outputMode" | "toolPermissions" | "detachable" | "narrativeContextEnabled">>;
  taskContract?: unknown; // Task-specific context schema
};
