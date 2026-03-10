import type { AgentLoop } from "../core/agent-loop.js";
import type { AgentProfile } from "../agents/profile.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { DefaultModelServiceRegistry } from "../core/models/registry.js";
import type { PromptBuilder } from "../core/prompt-builder.js";
import type { PromptRenderer } from "../core/prompt-renderer.js";
import type { ToolExecutor } from "../core/tools/tool-executor.js";
import type { SessionService } from "../session/service.js";
import type { Blackboard } from "../state/blackboard.js";
import type { Db } from "../storage/database.js";
import type { Database } from "bun:sqlite";
import type { MemoryTaskAgent } from "../memory/task-agent.js";

export type RuntimeHealthStatus = "ok" | "degraded" | "error";

export type RuntimeMigrationStatus = {
  interaction: {
    succeeded: boolean;
    appliedMigrations: string[];
  };
  memory: {
    succeeded: boolean;
  };
  succeeded: boolean;
};

export type RuntimeServices = {
  db: Db;
  rawDb: Database;
  sessionService: SessionService;
  blackboard: Blackboard;
  agentRegistry: AgentRegistry;
  modelRegistry: DefaultModelServiceRegistry;
  toolExecutor: ToolExecutor;
  migrationStatus: RuntimeMigrationStatus;
};

export type RuntimeBootstrapOptions = {
  databasePath?: string;
  dataDir?: string;
  busyTimeoutMs?: number;
  memoryMigrationModelId?: string;
  memoryEmbeddingModelId?: string;
  defaultAgentProfile?: AgentProfile;
  agentProfiles?: AgentProfile[];
  sessionService?: SessionService;
  blackboard?: Blackboard;
  modelRegistry?: DefaultModelServiceRegistry;
  toolExecutor?: ToolExecutor;
};

export type MemoryPipelineStatus =
  | "ready"
  | "missing_embedding_model"
  | "chat_model_unavailable"
  | "embedding_model_unavailable";

export type RuntimeBootstrapResult = {
  db: Db;
  rawDb: Database;
  sessionService: SessionService;
  blackboard: Blackboard;
  agentRegistry: AgentRegistry;
  modelRegistry: DefaultModelServiceRegistry;
  toolExecutor: ToolExecutor;
  promptBuilder: PromptBuilder;
  promptRenderer: PromptRenderer;
  runtimeServices: RuntimeServices;
  createAgentLoop: (agentId: string) => AgentLoop | null;
  memoryTaskAgent: MemoryTaskAgent | null;
  memoryPipelineReady: boolean;
  memoryPipelineStatus: MemoryPipelineStatus;
  healthChecks: Record<string, RuntimeHealthStatus>;
  migrationStatus: RuntimeMigrationStatus;
  shutdown: () => void;
};
