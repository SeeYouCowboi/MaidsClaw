import { AgentLoop } from "../core/agent-loop.js";
import type { AgentProfile } from "../agents/profile.js";
import { bootstrapRegistry } from "../core/models/bootstrap.js";
import { ToolExecutor } from "../core/tools/tool-executor.js";
import { runInteractionMigrations } from "../interaction/schema.js";
import { runMemoryMigrations } from "../memory/schema.js";
import { SessionService } from "../session/service.js";
import { Blackboard } from "../state/blackboard.js";
import { closeDatabaseGracefully, openDatabase } from "../storage/database.js";
import { resolveStoragePaths } from "../storage/paths.js";
import type {
  RuntimeBootstrapOptions,
  RuntimeBootstrapResult,
  RuntimeHealthStatus,
  RuntimeMigrationStatus,
} from "./types.js";

const DEFAULT_AGENT_PROFILE: AgentProfile = {
  id: "maid:main",
  role: "maiden",
  lifecycle: "persistent",
  userFacing: true,
  outputMode: "freeform",
  modelId: "anthropic/claude-sonnet-4-20250514",
  toolPermissions: [],
  maxDelegationDepth: 3,
  lorebookEnabled: false,
  narrativeContextEnabled: false,
};

function resolveDatabasePath(options: RuntimeBootstrapOptions): string {
  if (options.databasePath) {
    return options.databasePath;
  }

  const envDbPath = process.env.MAIDSCLAW_DB_PATH;
  return resolveStoragePaths({ databasePath: envDbPath }).databasePath;
}

function buildHealthChecks(
  migrationStatus: RuntimeMigrationStatus,
  options: {
    modelRegistry: RuntimeBootstrapResult["modelRegistry"];
    toolExecutor: RuntimeBootstrapResult["toolExecutor"];
    defaultAgentProfile: AgentProfile;
  }
): Record<string, RuntimeHealthStatus> {
  const healthChecks: Record<string, RuntimeHealthStatus> = {
    storage: migrationStatus.succeeded ? "ok" : "error",
    models: "degraded",
    tools: "ok",
  };

  try {
    options.modelRegistry.resolveChat(options.defaultAgentProfile.modelId);
    healthChecks.models = "ok";
  } catch {
    healthChecks.models = "degraded";
  }

  try {
    options.toolExecutor.getSchemas();
    healthChecks.tools = "ok";
  } catch {
    healthChecks.tools = "error";
  }

  return healthChecks;
}

export function bootstrapRuntime(options: RuntimeBootstrapOptions = {}): RuntimeBootstrapResult {
  const defaultAgentProfile = options.defaultAgentProfile ?? DEFAULT_AGENT_PROFILE;
  const db = openDatabase({
    path: resolveDatabasePath(options),
    busyTimeoutMs: options.busyTimeoutMs,
  });

  const migrationStatus: RuntimeMigrationStatus = {
    interaction: {
      succeeded: false,
      appliedMigrations: [],
    },
    memory: {
      succeeded: false,
    },
    succeeded: false,
  };

  try {
    migrationStatus.interaction.appliedMigrations = runInteractionMigrations(db);
    migrationStatus.interaction.succeeded = true;

    runMemoryMigrations(db);
    migrationStatus.memory.succeeded = true;
    migrationStatus.succeeded = true;
  } catch (error) {
    closeDatabaseGracefully(db);
    throw error;
  }

  const sessionService = options.sessionService ?? new SessionService();
  const blackboard = options.blackboard ?? new Blackboard();
  const modelRegistry = options.modelRegistry ?? bootstrapRegistry();
  const toolExecutor = options.toolExecutor ?? new ToolExecutor();
  const healthChecks = buildHealthChecks(migrationStatus, {
    modelRegistry,
    toolExecutor,
    defaultAgentProfile,
  });

  const createAgentLoop = (agentId: string): AgentLoop | null => {
    const profile = agentId === defaultAgentProfile.id
      ? defaultAgentProfile
      : { ...defaultAgentProfile, id: agentId };

    try {
      const modelProvider = modelRegistry.resolveChat(profile.modelId);
      return new AgentLoop({
        profile,
        modelProvider,
        toolExecutor,
      });
    } catch {
      return null;
    }
  };

  const shutdown = (): void => {
    closeDatabaseGracefully(db);
  };

  const runtimeServices = {
    db,
    rawDb: db.raw,
    sessionService,
    blackboard,
    modelRegistry,
    toolExecutor,
    migrationStatus,
  };

  return {
    db,
    rawDb: db.raw,
    sessionService,
    blackboard,
    modelRegistry,
    toolExecutor,
    runtimeServices,
    createAgentLoop,
    healthChecks,
    migrationStatus,
    shutdown,
  };
}
