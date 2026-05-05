import type { MaidenDecisionLog } from "../agents/maiden/decision-log.js";
import type { AgentProfile } from "../agents/profile.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { TraceStore } from "../app/diagnostics/trace-store.js";
import type { AgentLoop } from "../core/agent-loop.js";
import type { AuthConfig, RuntimeConfig } from "../core/config-schema.js";
import type { DefaultModelServiceRegistry } from "../core/models/registry.js";
import type { PromptBuilder } from "../core/prompt-builder.js";
import type { PromptRenderer } from "../core/prompt-renderer.js";
import type { RuntimeProjectionSink } from "../core/runtime-projection.js";
import type { ToolExecutor } from "../core/tools/tool-executor.js";
import type { ProviderCatalogService } from "../gateway/context.js";
import type { JobPersistence } from "../jobs/persistence.js";
import type { LoreService } from "../lore/service.js";
import type { CoreMemoryService } from "../memory/core-memory.js";
import type { ProjectionManager } from "../memory/projection/projection-manager.js";
import type { GraphStorageService } from "../memory/storage.js";
import type { MemoryTaskAgent } from "../memory/task-agent.js";
import type { UnifiedEdgeReadRepo } from "../storage/domain-repos/contracts/unified-edge-read-repo.js";
import type { UnresolvedWorldStateOpsRepo } from "../storage/domain-repos/contracts/unresolved-world-state-ops-repo.js";
import type { PersonaService } from "../persona/service.js";
import type { TurnService } from "../runtime/turn-service.js";
import type { SessionService } from "../session/service.js";
import type { Blackboard } from "../state/blackboard.js";
import type {
	BackendType,
	PgBackendFactory,
} from "../storage/backend-types.js";
import type { AreaWorldProjectionRepo } from "../storage/domain-repos/contracts/area-world-projection-repo.js";
import type { AliasRepo } from "../storage/domain-repos/contracts/alias-repo.js";
import type { CoreMemoryBlockRepo } from "../storage/domain-repos/contracts/core-memory-block-repo.js";
import type { EpisodeRepo } from "../storage/domain-repos/contracts/episode-repo.js";
import type { InteractionRepo } from "../storage/domain-repos/contracts/interaction-repo.js";
import type { RecentCognitionSlotRepo } from "../storage/domain-repos/contracts/recent-cognition-slot-repo.js";
import type { SettlementLedgerRepo } from "../storage/domain-repos/contracts/settlement-ledger-repo.js";
import type { SettlementLedger } from "../memory/settlement-ledger.js";
import type { SharedBlockRepo } from "../storage/domain-repos/contracts/shared-block-repo.js";
import type { SettlementUnitOfWork } from "../storage/unit-of-work.js";

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
	sessionService: SessionService;
	blackboard: Blackboard;
	agentRegistry: AgentRegistry;
	modelRegistry: DefaultModelServiceRegistry;
	toolExecutor: ToolExecutor;
	migrationStatus: RuntimeMigrationStatus;
};

export type RuntimeBootstrapOptions = {
	cwd?: string;
	dataDir?: string;
	memoryMigrationModelId?: string;
	memoryEmbeddingModelId?: string;
	memoryOrganizerEmbeddingModelId?: string;
	defaultAgentProfile?: AgentProfile;
	agentProfiles?: AgentProfile[];
	sessionService?: SessionService;
	blackboard?: Blackboard;
	modelRegistry?: DefaultModelServiceRegistry;
	toolExecutor?: ToolExecutor;
	projectionSink?: RuntimeProjectionSink;
	traceStore?: TraceStore;
	traceCaptureEnabled?: boolean;
	jobPersistence?: JobPersistence;
	strictDurableMode?: boolean;
	runtimeConfig?: RuntimeConfig;
};

export type MemoryPipelineStatus =
	| "ready"
	| "partial"
	| "missing_embedding_model"
	| "chat_model_unavailable"
	| "embedding_model_unavailable"
	| "organizer_embedding_model_unavailable";

export type RuntimeBootstrapResult = {
	sessionService: SessionService;
	blackboard: Blackboard;
	agentRegistry: AgentRegistry;
	modelRegistry: DefaultModelServiceRegistry;
	toolExecutor: ToolExecutor;
	promptBuilder: PromptBuilder;
	promptRenderer: PromptRenderer;
	runtimeServices: RuntimeServices;
	createAgentLoop: (agentId: string) => AgentLoop | null;
	turnService: TurnService;
	memoryTaskAgent: MemoryTaskAgent | null;
	entityReconciliation?: import("../memory/entity-judge-sweeper.js").EntityJudgeSweeper;
	searchRebuilder?: import("../memory/search-rebuild-pg.js").PgSearchRebuilder;
	memoryPipelineReady: boolean;
	memoryPipelineStatus: MemoryPipelineStatus;
	effectiveOrganizerEmbeddingModelId: string | undefined;
	healthChecks: Record<string, RuntimeHealthStatus>;
	migrationStatus: RuntimeMigrationStatus;
	traceStore?: TraceStore;
	backendType: BackendType;
	pgFactory: PgBackendFactory | null;
	settlementUnitOfWork: SettlementUnitOfWork | null;
	projectionManager: ProjectionManager;
	graphStorageService: GraphStorageService;
	interactionRepo: InteractionRepo;
	coreMemoryBlockRepo: CoreMemoryBlockRepo;
	recentCognitionSlotRepo: RecentCognitionSlotRepo;
	sharedBlockRepo: SharedBlockRepo;
	jobPersistence: JobPersistence;
	thinkerGlobalConcurrencyCap?: number;
	assertionCanonicalizationBundle?: {
		embeddingRepo: import("../storage/domain-repos/contracts/embedding-repo.js").EmbeddingRepo;
		modelProvider: import("../memory/task-agent.js").MemoryTaskModelProvider;
		embeddingModelId: string;
	};
	talkerThinkerConfig: {
		enabled: boolean;
		stalenessThreshold: number;
		softBlockTimeoutMs: number;
		softBlockPollIntervalMs: number;
		canonicalizationSimilarityThreshold?: number;
		speakerNormalizationGate: boolean;
		sceneFactWritePath: boolean;
		sceneRetrieval: boolean;
		legacyAreaStateCompat: boolean;
    entityCanonicalization: {
      knownEntitiesInjection: boolean;
      pointerKeyAliasRewrite: boolean;
      judgeModelId: string;
      judgeEnabled: boolean;
      judgeBatchIntervalMs: number;
    };
	};
	maidenDecisionLog: MaidenDecisionLog;
	shutdown: () => void;
	/**
	 * Seeds the static world entity catalog (shared_public locations + persona
	 * character names) into entity_nodes and generates their embeddings. Must
	 * be invoked AFTER the pg backend is initialized — calling before
	 * `initializePgBackendForRuntime` will throw because the upserts go through
	 * the pg pool. Returns a status describing whether the seed actually ran;
	 * callers should treat a `skipped: true` return as a degraded mode and
	 * propagate the `reason` to their startup health endpoint.
	 *
	 * The function performs an inline health check after seeding and rejects if
	 * `shared_public` is still empty — that condition means entity
	 * canonicalization will silently fall back to creating private duplicates,
	 * which is what the project memory `project_maidsclaw_bugs.md` flagged as
	 * the root cause of the 0-canonical-entity issue.
	 */
	runWorldEntitySeed: () => Promise<{
		seeded: number;
		embedded: number;
		skipped: boolean;
		reason?: string;
	}>;
	/**
	 * Resolves once the CJK segmenter has finished loading shared aliases into
	 * its user dictionary. Bootstrap fires the load asynchronously and does
	 * NOT block on it (queries arriving in the cold window degrade gracefully
	 * to the default jieba dictionary). Callers that want strict ordering —
	 * e.g. an HTTP host that must serve correct CJK tokenization on the very
	 * first request — can `await result.segmenterReady` before opening their
	 * listener. Always resolves; load failures are logged and the promise
	 * still resolves so callers don't deadlock.
	 */
	segmenterReady: Promise<void>;
	providerCatalogService: ProviderCatalogService;
	runtimeCwd: string;
	runtimeConfigSnapshot: RuntimeConfig;
	authConfigSnapshot: AuthConfig;
	coreMemoryService: CoreMemoryService;
	episodeRepo: EpisodeRepo;
	settlementLedgerRepo: SettlementLedgerRepo;
	settlementLedger: SettlementLedger;
	areaWorldProjectionRepo: AreaWorldProjectionRepo;
	personaService: PersonaService;
	loreService: LoreService;
	reloadPromptData: () => Promise<void>;
  aliasRepo: AliasRepo;
  /**
   * Read-only access to consensus memory edges (logic / memory_relations /
   * semantic / fact). Exposed on the bootstrap result so the gateway can build
   * the world-state inspection service for the Cockpit/Study Room.
   */
  unifiedEdgeReadRepo: UnifiedEdgeReadRepo;
  /**
   * Queue of worldStateOps awaiting entity resolution. Exposed for the
   * inspection service so the Study Room can show pending/dead-letter rows.
   */
  unresolvedWorldStateOpsRepo: UnresolvedWorldStateOpsRepo;
};

export type PublicRuntimeBootstrapResult = Omit<
	RuntimeBootstrapResult,
	"sessionService"
>;
