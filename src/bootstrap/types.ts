import type { Database } from "bun:sqlite";
import type { AgentProfile } from "../agents/profile.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { TraceStore } from "../app/diagnostics/trace-store.js";
import type { AgentLoop } from "../core/agent-loop.js";
import type { ConfigResult } from "../core/config-schema.js";
import type { DefaultModelServiceRegistry } from "../core/models/registry.js";
import type { PromptBuilder } from "../core/prompt-builder.js";
import type { PromptRenderer } from "../core/prompt-renderer.js";
import type { RuntimeProjectionSink } from "../core/runtime-projection.js";
import type { ToolExecutor } from "../core/tools/tool-executor.js";
import type { HealthCheckFn } from "../gateway/controllers.js";
import type { GatewayServer } from "../gateway/server.js";
import type { MemoryTaskAgent } from "../memory/task-agent.js";
import type { TurnService } from "../runtime/turn-service.js";
import type { SessionService } from "../session/service.js";
import type { Blackboard } from "../state/blackboard.js";
import type { BackendType, PgBackendFactory } from "../storage/backend-types.js";
import type { Db } from "../storage/database.js";
import type { CoreMemoryBlockRepo } from "../storage/domain-repos/contracts/core-memory-block-repo.js";
import type { InteractionRepo } from "../storage/domain-repos/contracts/interaction-repo.js";
import type { RecentCognitionSlotRepo } from "../storage/domain-repos/contracts/recent-cognition-slot-repo.js";
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
	cwd?: string;
	databasePath?: string;
	dataDir?: string;
	busyTimeoutMs?: number;
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
};

export type MemoryPipelineStatus =
	| "ready"
	| "missing_embedding_model"
	| "chat_model_unavailable"
	| "embedding_model_unavailable"
	| "organizer_embedding_model_unavailable";

/**
 * Full runtime bootstrap result used by the internal composition root.
 * @internal Not intended for public consumption — use
 * {@link PublicRuntimeBootstrapResult} instead when exposing the runtime
 * to consumers outside the bootstrap layer.
 */
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
	shutdown: () => void;
};

export type PublicRuntimeBootstrapResult = Omit<
	RuntimeBootstrapResult,
	"db" | "rawDb" | "sessionService"
>;

export type AppBootstrapOptions = {
port?: number;
host?: string;
cwd?: string;
configDir?: string;
databasePath?: string;
dataDir?: string;
busyTimeoutMs?: number;
memoryMigrationModelId?: string;
memoryEmbeddingModelId?: string;
memoryOrganizerEmbeddingModelId?: string;
enableGateway?: boolean;
requireAllProviders?: boolean;
traceCaptureEnabled?: boolean;
};

/**
 * @deprecated Use `AppHost` instead. This type remains available for backward
 * compatibility while callers migrate to the `AppHost` API.
 */
export type AppBootstrapResult = {
	runtime: RuntimeBootstrapResult;
	server?: GatewayServer;
	healthChecks: Record<string, HealthCheckFn>;
	configResult: ConfigResult;
	shutdown: () => void;
};
