import { AgentLoop, type AgentRunRequest } from "../core/agent-loop.js";
import type { Chunk } from "../core/chunk.js";
import type { AgentProfile } from "../agents/profile.js";
import { AgentRegistry } from "../agents/registry.js";
import { MAIDEN_PROFILE, PRESET_PROFILES, TASK_AGENT_PROFILE } from "../agents/presets.js";
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
import { CommitService } from "../interaction/commit-service.js";
import { FlushSelector } from "../interaction/flush-selector.js";
import { InteractionStore } from "../interaction/store.js";
import { createLoreService } from "../lore/service.js";
import { CoreMemoryService } from "../memory/core-memory.js";
import { EmbeddingService } from "../memory/embeddings.js";
import { MaterializationService } from "../memory/materialization.js";
import { MemoryTaskModelProviderAdapter } from "../memory/model-provider-adapter.js";
import { runMemoryMigrations } from "../memory/schema.js";
import { GraphStorageService } from "../memory/storage.js";
import { MemoryTaskAgent } from "../memory/task-agent.js";
import { TransactionBatcher } from "../memory/transaction-batcher.js";
import { PersonaLoader } from "../persona/loader.js";
import { PersonaService } from "../persona/service.js";
import { SessionService } from "../session/service.js";
import { resolveViewerContext } from "../runtime/viewer-context-resolver.js";
import { TurnService } from "../runtime/turn-service.js";
import type { RpBufferedExecutionResult } from "../runtime/rp-turn-contract.js";
import { Blackboard } from "../state/blackboard.js";
import { closeDatabaseGracefully, openDatabase } from "../storage/database.js";
import { resolveStoragePaths } from "../storage/paths.js";
import type {
  RuntimeBootstrapOptions,
  RuntimeBootstrapResult,
  RuntimeHealthStatus,
  MemoryPipelineStatus,
  RuntimeMigrationStatus,
} from "./types.js";
import { registerRuntimeTools } from "./tools.js";

function resolveDatabasePath(options: RuntimeBootstrapOptions): string {
  if (options.databasePath) {
    return options.databasePath;
  }

  const envDbPath = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.MAIDSCLAW_DB_PATH;
  return resolveStoragePaths({ databasePath: envDbPath }).databasePath;
}

function resolveDataDir(options: RuntimeBootstrapOptions): string {
  if (options.dataDir) {
    return options.dataDir;
  }

  const envDataDir = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.MAIDSCLAW_DATA_DIR;
  return resolveStoragePaths({ dataDir: envDataDir }).dataDir;
}

function buildHealthChecks(
  migrationStatus: RuntimeMigrationStatus,
  options: {
    modelRegistry: RuntimeBootstrapResult["modelRegistry"];
    toolExecutor: RuntimeBootstrapResult["toolExecutor"];
    healthCheckAgentProfile: AgentProfile;
    memoryPipelineReady: boolean;
  }
): Record<string, RuntimeHealthStatus> {
  const healthChecks: Record<string, RuntimeHealthStatus> = {
    storage: migrationStatus.succeeded ? "ok" : "error",
    models: "degraded",
    tools: "ok",
    memory_pipeline: options.memoryPipelineReady ? "ok" : "degraded",
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

  const interactionStore = new InteractionStore(db);
  const commitService = new CommitService(interactionStore);
  const flushSelector = new FlushSelector(interactionStore);
  const graphStorage = new GraphStorageService(db);

  registerRuntimeTools(toolExecutor, runtimeServices);

  const memoryMigrationModelId = options.memoryMigrationModelId ?? TASK_AGENT_PROFILE.modelId;
  const memoryEmbeddingModelId = options.memoryEmbeddingModelId;
  const effectiveOrganizerEmbeddingModelId = options.memoryOrganizerEmbeddingModelId ?? memoryEmbeddingModelId;
  let memoryTaskAgent: MemoryTaskAgent | null = null;
  let memoryPipelineReady = false;
  let memoryPipelineStatus: MemoryPipelineStatus = "missing_embedding_model";

  try {
    modelRegistry.resolveChat(memoryMigrationModelId);
  } catch {
    memoryPipelineStatus = "chat_model_unavailable";
  }

  if (memoryPipelineStatus !== "chat_model_unavailable") {
    if (!memoryEmbeddingModelId) {
      memoryPipelineStatus = "missing_embedding_model";
    } else {
      try {
        modelRegistry.resolveEmbedding(memoryEmbeddingModelId);

        // Validate organizer embedding model if different from base embedding
        if (effectiveOrganizerEmbeddingModelId && effectiveOrganizerEmbeddingModelId !== memoryEmbeddingModelId) {
          try {
            modelRegistry.resolveEmbedding(effectiveOrganizerEmbeddingModelId);
          } catch {
            memoryPipelineStatus = "organizer_embedding_model_unavailable";
          }
        }

        if (memoryPipelineStatus !== "organizer_embedding_model_unavailable") {
          const coreMemory = new CoreMemoryService(db);
          const embeddings = new EmbeddingService(db, new TransactionBatcher(db));
          const materialization = new MaterializationService(db.raw, graphStorage);
          const provider = new MemoryTaskModelProviderAdapter(modelRegistry, memoryMigrationModelId, effectiveOrganizerEmbeddingModelId!);
          memoryTaskAgent = new MemoryTaskAgent(db.raw, graphStorage, coreMemory, embeddings, materialization, provider);
          memoryPipelineReady = true;
          memoryPipelineStatus = "ready";
        }
      } catch {
        memoryPipelineStatus = "embedding_model_unavailable";
      }
    }
  }

  const healthCheckAgentProfile =
    agentRegistry.get(MAIDEN_PROFILE.id) ?? agentRegistry.getAll()[0] ?? MAIDEN_PROFILE;
  const healthChecks = buildHealthChecks(migrationStatus, {
    modelRegistry,
    toolExecutor,
    healthCheckAgentProfile,
    memoryPipelineReady,
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
  const viewerContextResolver = ({
    sessionId,
    agentId,
    role,
  }: {
    sessionId: string;
    agentId: string;
    role: AgentProfile["role"];
  }) => resolveViewerContext(agentId, blackboard, { sessionId, role });

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
        promptBuilder,
        promptRenderer,
        viewerContextResolver,
      });
    } catch {
      return null;
    }
  };

  const turnServiceAgentLoop = {
    async *run(request: AgentRunRequest): AsyncGenerator<Chunk> {
      const canonicalAgentId = sessionService.getSession(request.sessionId)?.agentId ?? MAIDEN_PROFILE.id;
      const profile = agentRegistry.get(canonicalAgentId);
      const loop = createAgentLoop(canonicalAgentId);
      if (!loop) {
        throw new Error(`No agent loop available for agent '${canonicalAgentId}'`);
      }

      if (profile?.role === "rp_agent") {
        const bufferedResult = await loop.runBuffered(request);
        if ("error" in bufferedResult) {
          yield {
            type: "error",
            code: "RP_BUFFERED_EXECUTION_FAILED",
            message: bufferedResult.error,
            retriable: false,
          };
          return;
        }

        if (bufferedResult.outcome.publicReply.length > 0) {
          yield {
            type: "text_delta",
            text: bufferedResult.outcome.publicReply,
          };
        }

        yield {
          type: "message_end",
          stopReason: "end_turn",
        };
        return;
      }

      for await (const chunk of loop.run(request)) {
        yield chunk;
      }
    },
    async runBuffered(request: AgentRunRequest): Promise<RpBufferedExecutionResult> {
      const canonicalAgentId = sessionService.getSession(request.sessionId)?.agentId ?? MAIDEN_PROFILE.id;
      const profile = agentRegistry.get(canonicalAgentId);
      const loop = createAgentLoop(canonicalAgentId);
      if (!loop) {
        throw new Error(`No agent loop available for agent '${canonicalAgentId}'`);
      }

      if (profile?.role !== "rp_agent") {
        return { error: `Buffered RP mode is only available for rp_agent sessions` };
      }

      return loop.runBuffered(request);
    },
  } as unknown as AgentLoop;

  const turnService = new TurnService(
    turnServiceAgentLoop,
    commitService,
    interactionStore,
    flushSelector,
    memoryTaskAgent,
    sessionService,
    viewerContextResolver,
    options.projectionSink,
    graphStorage,
  );

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
    turnService,
    memoryTaskAgent,
    memoryPipelineReady,
    memoryPipelineStatus,
    effectiveOrganizerEmbeddingModelId,
    healthChecks,
    migrationStatus,
    shutdown,
  };
}
