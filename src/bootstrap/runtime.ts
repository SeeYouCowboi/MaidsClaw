import { AgentLoop } from "../core/agent-loop.js";
import type { AgentProfile } from "../agents/profile.js";
import { AgentRegistry } from "../agents/registry.js";
import { MAIDEN_PROFILE, PRESET_PROFILES } from "../agents/presets.js";
import { bootstrapRegistry } from "../core/models/bootstrap.js";
import { PromptBuilder } from "../core/prompt-builder.js";
import {
  PersonaAdapter,
  LoreAdapter,
  MemoryAdapter,
  BlackboardOperationalDataSource,
} from "../core/prompt-data-adapters/index.js";
import { PromptRenderer } from "../core/prompt-renderer.js";
import { ToolExecutor } from "../core/tools/tool-executor.js";
import { runInteractionMigrations } from "../interaction/schema.js";
import { createLoreService } from "../lore/service.js";
import { runMemoryMigrations } from "../memory/schema.js";
import { PersonaLoader } from "../persona/loader.js";
import { PersonaService } from "../persona/service.js";
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
import { registerRuntimeTools } from "./tools.js";

function resolveDatabasePath(options: RuntimeBootstrapOptions): string {
  if (options.databasePath) {
    return options.databasePath;
  }

  const envDbPath = process.env.MAIDSCLAW_DB_PATH;
  return resolveStoragePaths({ databasePath: envDbPath }).databasePath;
}

function resolveDataDir(options: RuntimeBootstrapOptions): string {
  if (options.dataDir) {
    return options.dataDir;
  }

  const envDataDir = process.env.MAIDSCLAW_DATA_DIR;
  return resolveStoragePaths({ dataDir: envDataDir }).dataDir;
}

function buildHealthChecks(
  migrationStatus: RuntimeMigrationStatus,
  options: {
    modelRegistry: RuntimeBootstrapResult["modelRegistry"];
    toolExecutor: RuntimeBootstrapResult["toolExecutor"];
    healthCheckAgentProfile: AgentProfile;
  }
): Record<string, RuntimeHealthStatus> {
  const healthChecks: Record<string, RuntimeHealthStatus> = {
    storage: migrationStatus.succeeded ? "ok" : "error",
    models: "degraded",
    tools: "ok",
  };

  try {
    options.modelRegistry.resolveChat(options.healthCheckAgentProfile.modelId);
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

function buildAgentRegistry(options: RuntimeBootstrapOptions): AgentRegistry {
  const registry = new AgentRegistry();
  const mergedProfiles = new Map<string, AgentProfile>();

  for (const profile of PRESET_PROFILES) {
    mergedProfiles.set(profile.id, profile);
  }

  if (options.defaultAgentProfile) {
    mergedProfiles.set(options.defaultAgentProfile.id, options.defaultAgentProfile);
  }

  for (const profile of options.agentProfiles ?? []) {
    mergedProfiles.set(profile.id, profile);
  }

  for (const profile of mergedProfiles.values()) {
    registry.register(profile);
  }

  return registry;
}

export function bootstrapRuntime(options: RuntimeBootstrapOptions = {}): RuntimeBootstrapResult {
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
  const agentRegistry = buildAgentRegistry(options);
  const modelRegistry = options.modelRegistry ?? bootstrapRegistry();
  const toolExecutor = options.toolExecutor ?? new ToolExecutor();
  const runtimeServices = {
    db,
    rawDb: db.raw,
    sessionService,
    blackboard,
    agentRegistry,
    modelRegistry,
    toolExecutor,
    migrationStatus,
  };

  registerRuntimeTools(toolExecutor, runtimeServices);

  const healthCheckAgentProfile =
    agentRegistry.get(MAIDEN_PROFILE.id) ?? agentRegistry.getAll()[0] ?? MAIDEN_PROFILE;
  const healthChecks = buildHealthChecks(migrationStatus, {
    modelRegistry,
    toolExecutor,
    healthCheckAgentProfile,
  });

  const dataDir = resolveDataDir(options);
  const storagePaths = resolveStoragePaths({ dataDir });

  const personaService = new PersonaService({
    loader: new PersonaLoader(storagePaths.personasDir),
  });
  personaService.loadAll();

  const loreService = createLoreService({ dataDir });
  loreService.loadAll();

  const personaAdapter = new PersonaAdapter(personaService);
  const loreAdapter = new LoreAdapter(loreService);
  const memoryAdapter = new MemoryAdapter(db);
  const operationalAdapter = new BlackboardOperationalDataSource(blackboard);

  const promptBuilder = new PromptBuilder({
    persona: personaAdapter,
    lore: loreAdapter,
    memory: memoryAdapter,
    operational: operationalAdapter,
  });

  const promptRenderer = new PromptRenderer();

  const createAgentLoop = (agentId: string): AgentLoop | null => {
    const profile = agentRegistry.get(agentId);
    if (!profile) {
      return null;
    }

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

  return {
    db,
    rawDb: db.raw,
    sessionService,
    blackboard,
    agentRegistry,
    modelRegistry,
    toolExecutor,
    promptBuilder,
    promptRenderer,
    runtimeServices,
    createAgentLoop,
    healthChecks,
    migrationStatus,
    shutdown,
  };
}
