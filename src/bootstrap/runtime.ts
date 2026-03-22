import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	MAIDEN_PROFILE,
	PRESET_PROFILES,
	TASK_AGENT_PROFILE,
} from "../agents/presets.js";
import type { AgentProfile } from "../agents/profile.js";
import { AgentRegistry } from "../agents/registry.js";
import { loadFileAgents } from "../app/config/agents/agent-loader.js";
import { TraceStore } from "../app/diagnostics/trace-store.js";
import { AgentLoop, type AgentRunRequest } from "../core/agent-loop.js";
import type { Chunk } from "../core/chunk.js";
import { bootstrapRegistry } from "../core/models/bootstrap.js";
import { PromptBuilder } from "../core/prompt-builder.js";
import {
	BlackboardOperationalDataSource,
	LoreAdapter,
	MemoryAdapter,
	PersonaAdapter,
} from "../core/prompt-data-adapters/index.js";
import { PromptRenderer } from "../core/prompt-renderer.js";
import { ToolExecutor } from "../core/tools/tool-executor.js";
import { CommitService } from "../interaction/commit-service.js";
import { FlushSelector } from "../interaction/flush-selector.js";
import { runInteractionMigrations } from "../interaction/schema.js";
import { InteractionStore } from "../interaction/store.js";
import { createLoreService } from "../lore/service.js";
import { CoreMemoryService } from "../memory/core-memory.js";
import { EmbeddingService } from "../memory/embeddings.js";
import { MaterializationService } from "../memory/materialization.js";
import { MemoryTaskModelProviderAdapter } from "../memory/model-provider-adapter.js";
import { CognitionEventRepo } from "../memory/cognition/cognition-event-repo.js";
import { PrivateCognitionProjectionRepo } from "../memory/cognition/private-cognition-current.js";
import { EpisodeRepository } from "../memory/episode/episode-repo.js";
import { PendingSettlementSweeper } from "../memory/pending-settlement-sweeper.js";
import { ProjectionManager } from "../memory/projection/projection-manager.js";
import { runMemoryMigrations } from "../memory/schema.js";
import { GraphStorageService } from "../memory/storage.js";
import { MemoryTaskAgent } from "../memory/task-agent.js";
import { TransactionBatcher } from "../memory/transaction-batcher.js";
import { PersonaLoader } from "../persona/loader.js";
import { PersonaService } from "../persona/service.js";
import type { RpBufferedExecutionResult } from "../runtime/rp-turn-contract.js";
import { TurnService } from "../runtime/turn-service.js";
import { resolveViewerContext } from "../runtime/viewer-context-resolver.js";
import { runSessionMigrations } from "../session/migrations.js";
import { SessionService } from "../session/service.js";
import { Blackboard } from "../state/blackboard.js";
import { closeDatabaseGracefully, openDatabase } from "../storage/database.js";
import {
	ensureDirectoryExists,
	resolveStoragePaths,
} from "../storage/paths.js";
import { registerRuntimeTools } from "./tools.js";
import type {
	MemoryPipelineStatus,
	RuntimeBootstrapOptions,
	RuntimeBootstrapResult,
	RuntimeHealthStatus,
	RuntimeMigrationStatus,
} from "./types.js";

function resolveRuntimeCwd(options: RuntimeBootstrapOptions): string {
	return resolve(options.cwd ?? process.cwd());
}

function resolveFromCwd(
	pathValue: string | undefined,
	cwd: string,
): string | undefined {
	if (!pathValue) {
		return undefined;
	}
	if (pathValue === ":memory:") {
		return pathValue;
	}

	return isAbsolute(pathValue) ? pathValue : resolve(cwd, pathValue);
}

function resolveDatabasePath(
	options: RuntimeBootstrapOptions,
	cwd: string,
): string {
	if (options.databasePath) {
		const resolvedPath = resolveFromCwd(options.databasePath, cwd);
		if (resolvedPath) {
			return resolvedPath;
		}
	}

	const envDbPath = (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process?.env?.MAIDSCLAW_DB_PATH;
	return resolveStoragePaths({
		storageRoot: join(cwd, "data"),
		databasePath: resolveFromCwd(envDbPath, cwd),
	}).databasePath;
}

function resolveDataDir(options: RuntimeBootstrapOptions, cwd: string): string {
	if (options.dataDir) {
		const resolvedPath = resolveFromCwd(options.dataDir, cwd);
		if (resolvedPath) {
			return resolvedPath;
		}
	}

	const envDataDir = (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process?.env?.MAIDSCLAW_DATA_DIR;
	return resolveStoragePaths({
		storageRoot: join(cwd, "data"),
		dataDir: resolveFromCwd(envDataDir, cwd),
	}).dataDir;
}

function buildHealthChecks(
	migrationStatus: RuntimeMigrationStatus,
	options: {
		modelRegistry: RuntimeBootstrapResult["modelRegistry"];
		toolExecutor: RuntimeBootstrapResult["toolExecutor"];
		healthCheckAgentProfile: AgentProfile;
		memoryPipelineReady: boolean;
	},
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

function buildAgentRegistry(
	options: RuntimeBootstrapOptions,
	runtimeCwd: string,
): AgentRegistry {
	const registry = new AgentRegistry();
	const mergedProfiles = new Map<string, AgentProfile>();

	for (const profile of PRESET_PROFILES) {
		mergedProfiles.set(profile.id, profile);
	}

	// Load file-backed agents from config/agents.json if present
	const configAgentsPath = join(runtimeCwd, "config", "agents.json");
	if (existsSync(configAgentsPath)) {
		const { agents: fileAgents } = loadFileAgents(configAgentsPath);
		for (const profile of fileAgents) {
			mergedProfiles.set(profile.id, profile);
		}
	}

	if (options.defaultAgentProfile) {
		mergedProfiles.set(
			options.defaultAgentProfile.id,
			options.defaultAgentProfile,
		);
	}

	for (const profile of options.agentProfiles ?? []) {
		mergedProfiles.set(profile.id, profile);
	}

	for (const profile of mergedProfiles.values()) {
		registry.register(profile);
	}

	return registry;
}

export function bootstrapRuntime(
	options: RuntimeBootstrapOptions = {},
): RuntimeBootstrapResult {
	const runtimeCwd = resolveRuntimeCwd(options);
	const databasePath = resolveDatabasePath(options, runtimeCwd);
	ensureDirectoryExists(dirname(databasePath));

	const db = openDatabase({
		path: databasePath,
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
		migrationStatus.interaction.appliedMigrations =
			runInteractionMigrations(db);
		migrationStatus.interaction.succeeded = true;

		runMemoryMigrations(db);
		migrationStatus.memory.succeeded = true;

		runSessionMigrations(db);
		migrationStatus.succeeded = true;
	} catch (error) {
		closeDatabaseGracefully(db);
		throw error;
	}

	const sessionService = options.sessionService ?? new SessionService(db);
	const blackboard = options.blackboard ?? new Blackboard();
	const agentRegistry = buildAgentRegistry(options, runtimeCwd);
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

	const memoryMigrationModelId =
		options.memoryMigrationModelId ?? TASK_AGENT_PROFILE.modelId;
	const memoryEmbeddingModelId = options.memoryEmbeddingModelId;
	const effectiveOrganizerEmbeddingModelId =
		options.memoryOrganizerEmbeddingModelId ?? memoryEmbeddingModelId;
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
				if (
					effectiveOrganizerEmbeddingModelId &&
					effectiveOrganizerEmbeddingModelId !== memoryEmbeddingModelId
				) {
					try {
						modelRegistry.resolveEmbedding(effectiveOrganizerEmbeddingModelId);
					} catch {
						memoryPipelineStatus = "organizer_embedding_model_unavailable";
					}
				}

				if (memoryPipelineStatus !== "organizer_embedding_model_unavailable") {
					const coreMemory = new CoreMemoryService(db);
					const embeddings = new EmbeddingService(
						db,
						new TransactionBatcher(db),
					);
					const materialization = new MaterializationService(
						db.raw,
						graphStorage,
					);
					const organizerEmbeddingModelId =
						effectiveOrganizerEmbeddingModelId ?? memoryEmbeddingModelId;
					const provider = new MemoryTaskModelProviderAdapter(
						modelRegistry,
						memoryMigrationModelId,
						organizerEmbeddingModelId,
					);
					memoryTaskAgent = new MemoryTaskAgent(
						db.raw,
						graphStorage,
						coreMemory,
						embeddings,
						materialization,
						provider,
					);
					memoryPipelineReady = true;
					memoryPipelineStatus = "ready";
				}
			} catch {
				memoryPipelineStatus = "embedding_model_unavailable";
			}
		}
	}

	const healthCheckAgentProfile =
		agentRegistry.get(MAIDEN_PROFILE.id) ??
		agentRegistry.getAll()[0] ??
		MAIDEN_PROFILE;
	const healthChecks = buildHealthChecks(migrationStatus, {
		modelRegistry,
		toolExecutor,
		healthCheckAgentProfile,
		memoryPipelineReady,
	});

	const dataDir = resolveDataDir(options, runtimeCwd);
	const traceStore =
		options.traceStore ??
		(options.traceCaptureEnabled
			? new TraceStore(join(dataDir, "debug", "traces"))
			: undefined);
	const storagePaths = resolveStoragePaths({ dataDir });
	const configPersonasPath = join(runtimeCwd, "config", "personas.json");
	const configLorePath = join(runtimeCwd, "config", "lore.json");

	const personaService = new PersonaService({
		loader: new PersonaLoader(storagePaths.personasDir, configPersonasPath),
	});
	personaService.loadAll();

	const loreService = createLoreService({ dataDir, configLorePath });
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
			const canonicalAgentId =
				sessionService.getSession(request.sessionId)?.agentId ??
				MAIDEN_PROFILE.id;
			const profile = agentRegistry.get(canonicalAgentId);
			const loop = createAgentLoop(canonicalAgentId);
			if (!loop) {
				throw new Error(
					`No agent loop available for agent '${canonicalAgentId}'`,
				);
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
		async runBuffered(
			request: AgentRunRequest,
		): Promise<RpBufferedExecutionResult> {
			const canonicalAgentId =
				sessionService.getSession(request.sessionId)?.agentId ??
				MAIDEN_PROFILE.id;
			const profile = agentRegistry.get(canonicalAgentId);
			const loop = createAgentLoop(canonicalAgentId);
			if (!loop) {
				throw new Error(
					`No agent loop available for agent '${canonicalAgentId}'`,
				);
			}

			if (profile?.role !== "rp_agent") {
				return {
					error: `Buffered RP mode is only available for rp_agent sessions`,
				};
			}

			return loop.runBuffered(request);
		},
	} as unknown as AgentLoop;

	const episodeRepo = new EpisodeRepository(db);
	const cognitionEventRepo = new CognitionEventRepo(db.raw);
	const cognitionProjectionRepo = new PrivateCognitionProjectionRepo(db.raw);
	const projectionManager = new ProjectionManager(
		episodeRepo,
		cognitionEventRepo,
		cognitionProjectionRepo,
		graphStorage,
	);

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
		traceStore,
		projectionManager,
	);

	const pendingSettlementSweeper = memoryTaskAgent
		? new PendingSettlementSweeper(
				db,
				interactionStore,
				flushSelector,
				memoryTaskAgent,
			)
		: null;
	pendingSettlementSweeper?.start();

	const shutdown = (): void => {
		pendingSettlementSweeper?.stop();
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
		traceStore,
		shutdown,
	};
}
