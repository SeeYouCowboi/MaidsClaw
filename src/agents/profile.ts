// Agent profile types — configuration for ALL agent types in MaidsClaw

/** Agent roles in the system */
export type AgentRole = "maiden" | "rp_agent" | "task_agent";

/** Lifecycle determines if agent persists across sessions or is spawned ephemerally */
export type AgentLifecycle = "persistent" | "ephemeral";

/** Output mode for task agents (structured vs. free-form) */
export type OutputMode = "freeform" | "structured";

/** Tool permission entry */
export type ToolPermission = {
  toolName: string;
  allowed: boolean;
};

/** Authorization for private memory reads (Maiden-specific) */
export type AuthorizationPolicy = {
  canReadAgentIds: string[]; // Which agent private memories Maiden can read
};

/** Agent profile — configuration for ALL agent types */
export type AgentProfile = {
  id: string;
  role: AgentRole;
  lifecycle: AgentLifecycle;
  userFacing: boolean;
  outputMode: OutputMode;
  modelId: string;         // e.g. "claude-opus-4-5", "gpt-4o"
  maxOutputTokens?: number;  // max tokens reserved for model output
  personaId?: string;      // For rp_agent: which character card
  toolPermissions: ToolPermission[];
  authorizationPolicy?: AuthorizationPolicy; // Maiden-only
  maxDelegationDepth: number;
  detachable?: boolean;    // For task_agent: run after parent stream ends
  contextBudget?: {
    maxTokens: number;
    reservedForCoordination?: number; // Maiden coordination overhead reserve
  };
  lorebookEnabled: boolean;
  narrativeContextEnabled: boolean; // opt-in for task agents
};

/** Ephemeral task agent spawn config (derived from a base profile) */
export type EphemeralSpawnConfig = {
  baseProfileId: string;
  overrides?: Partial<Pick<AgentProfile, "modelId" | "outputMode" | "toolPermissions" | "detachable" | "narrativeContextEnabled">>;
  taskContract?: unknown; // Task-specific context schema
};
