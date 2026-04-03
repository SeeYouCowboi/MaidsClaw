import type { AgentProfile } from "../agents/profile.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { TraceStore } from "../app/diagnostics/trace-store.js";
import type { AgentLoop } from "../core/agent-loop.js";
import type { DefaultModelServiceRegistry } from "../core/models/registry.js";
import type { PromptBuilder } from "../core/prompt-builder.js";
import type { PromptRenderer } from "../core/prompt-renderer.js";
import type { RuntimeProjectionSink } from "../core/runtime-projection.js";
import type { ToolExecutor } from "../core/tools/tool-executor.js";
import type { JobPersistence } from "../jobs/persistence.js";
import type { MemoryTaskAgent } from "../memory/task-agent.js";
import type { TurnService } from "../runtime/turn-service.js";
import type { SessionService } from "../session/service.js";
import type { Blackboard } from "../state/blackboard.js";
import type { BackendType, PgBackendFactory } from "../storage/backend-types.js";
import type { CoreMemoryBlockRepo } from "../storage/domain-repos/contracts/core-memory-block-repo.js";
import type { InteractionRepo } from "../storage/domain-repos/contracts/interaction-repo.js";
import type { RecentCognitionSlotRepo } from "../storage/domain-repos/contracts/recent-cognition-slot-repo.js";
import type { SharedBlockRepo } from "../storage/domain-repos/contracts/shared-block-repo.js";
import type { SettlementUnitOfWork } from "../storage/unit-of-work.js";

import type { RuntimeConfig } from "../core/config-schema.js";

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
	memoryPipelineReady: boolean;
	memoryPipelineStatus: MemoryPipelineStatus;
	effectiveOrganizerEmbeddingModelId: string | undefined;
	healthChecks: Record<string, RuntimeHealthStatus>;
	migrationStatus: RuntimeMigrationStatus;
	traceStore?: TraceStore;
	backendType: BackendType;
	pgFactory: PgBackendFactory | null;
	settlementUnitOfWork: SettlementUnitOfWork | null;
	interactionRepo: InteractionRepo;
	coreMemoryBlockRepo: CoreMemoryBlockRepo;
	recentCognitionSlotRepo: RecentCognitionSlotRepo;
	sharedBlockRepo: SharedBlockRepo;
	jobPersistence: JobPersistence;
	shutdown: () => void;
};

export type PublicRuntimeBootstrapResult = Omit<
	RuntimeBootstrapResult,
	"sessionService"
>;
