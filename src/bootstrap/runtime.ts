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
import type { MemoryDataSource } from "../core/prompt-data-sources.js";
import { PromptRenderer } from "../core/prompt-renderer.js";
import { ToolExecutor } from "../core/tools/tool-executor.js";
import { CommitService } from "../interaction/commit-service.js";
import type {
	InteractionRecord,
	TurnSettlementPayload,
} from "../interaction/contracts.js";
import { FlushSelector } from "../interaction/flush-selector.js";
import { runInteractionMigrations } from "../interaction/schema.js";
import { InteractionStore } from "../interaction/store.js";
import { createJobPersistence } from "../jobs/job-persistence-factory.js";
import type { JobPersistence } from "../jobs/persistence.js";
import { createLoreService } from "../lore/service.js";
import { CognitionEventRepo } from "../memory/cognition/cognition-event-repo.js";
import { PrivateCognitionProjectionRepo } from "../memory/cognition/private-cognition-current.js";
import { CoreMemoryService } from "../memory/core-memory.js";
import { EmbeddingService } from "../memory/embeddings.js";
import { EpisodeRepository } from "../memory/episode/episode-repo.js";
import { MaterializationService } from "../memory/materialization.js";
import { MemoryTaskModelProviderAdapter } from "../memory/model-provider-adapter.js";
import { PendingSettlementSweeper } from "../memory/pending-settlement-sweeper.js";
import { PgTransactionBatcher } from "../memory/pg-transaction-batcher.js";
import { AreaWorldProjectionRepo } from "../memory/projection/area-world-projection-repo.js";
import { ProjectionManager } from "../memory/projection/projection-manager.js";
import {
	getAttachedSharedBlocksAsync,
	getPinnedBlocksAsync,
	getRecentCognitionAsync,
	getSharedBlocksAsync,
} from "../memory/prompt-data.js";
import { PublicationRecoverySweeper } from "../memory/publication-recovery-sweeper.js";
import { runMemoryMigrations } from "../memory/schema.js";
import { SqliteSettlementLedger } from "../memory/settlement-ledger.js";
import { SharedBlockRepo as SqliteSharedBlockRepoImpl } from "../memory/shared-blocks/shared-block-repo.js";
import { GraphStorageService } from "../memory/storage.js";
import { MemoryTaskAgent } from "../memory/task-agent.js";
import { TransactionBatcher } from "../memory/transaction-batcher.js";
import { SqlitePromotionQueryRepo } from "../storage/domain-repos/sqlite/promotion-query-repo.js";
import { PgEmbeddingRepo } from "../storage/domain-repos/pg/embedding-repo.js";
import { SqliteEmbeddingRepoAdapter } from "../storage/domain-repos/sqlite/embedding-repo.js";
import { PersonaLoader } from "../persona/loader.js";
import { PersonaService } from "../persona/service.js";
import type { RpBufferedExecutionResult } from "../runtime/rp-turn-contract.js";
import { TurnService } from "../runtime/turn-service.js";
import { resolveViewerContext } from "../runtime/viewer-context-resolver.js";
import { runSessionMigrations } from "../session/migrations.js";
import { SessionService } from "../session/service.js";
import { Blackboard } from "../state/blackboard.js";
import {
	PgBackendFactory,
	resolveBackendType,
} from "../storage/backend-types.js";
import {
	closeDatabaseGracefully,
	type Db,
	openDatabase,
} from "../storage/database.js";
import { PgAreaWorldProjectionRepo } from "../storage/domain-repos/pg/area-world-projection-repo.js";
import { PgCognitionEventRepo } from "../storage/domain-repos/pg/cognition-event-repo.js";
import { PgCognitionProjectionRepo } from "../storage/domain-repos/pg/cognition-projection-repo.js";
import { PgCoreMemoryBlockRepo } from "../storage/domain-repos/pg/core-memory-block-repo.js";
import { PgEpisodeRepo } from "../storage/domain-repos/pg/episode-repo.js";
import { PgInteractionRepo } from "../storage/domain-repos/pg/interaction-repo.js";
import { PgPendingFlushRecoveryRepo } from "../storage/domain-repos/pg/pending-flush-recovery-repo.js";
import { PgRecentCognitionSlotRepo } from "../storage/domain-repos/pg/recent-cognition-slot-repo.js";
import { PgSharedBlockRepo } from "../storage/domain-repos/pg/shared-block-repo.js";
import { SqliteCoreMemoryBlockRepoAdapter } from "../storage/domain-repos/sqlite/core-memory-block-repo.js";
import { SqliteInteractionRepoAdapter } from "../storage/domain-repos/sqlite/interaction-repo.js";
import { SqlitePendingFlushRecoveryRepoAdapter } from "../storage/domain-repos/sqlite/pending-flush-recovery-repo.js";
import { SqliteRecentCognitionSlotRepoAdapter } from "../storage/domain-repos/sqlite/recent-cognition-slot-repo.js";
import { SqliteSharedBlockRepoAdapter } from "../storage/domain-repos/sqlite/shared-block-repo.js";
import {
	ensureDirectoryExists,
	resolveStoragePaths,
} from "../storage/paths.js";
import { PgSettlementUnitOfWork } from "../storage/pg-settlement-uow.js";
import type { SettlementUnitOfWork } from "../storage/unit-of-work.js";
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

function createLazyPgRepo<T extends object>(factory: () => T): T {
	return new Proxy({} as T, {
		get(_target, property, receiver) {
			const repo = factory() as Record<PropertyKey, unknown>;
			const value = Reflect.get(repo, property, receiver);
			if (typeof value === "function") {
				return (value as (...args: unknown[]) => unknown).bind(repo);
			}
			return value;
		},
	});
}

function requireSqliteDb(db: Db | undefined): Db {
	if (!db) {
		throw new Error("SQLite database handle is unavailable");
	}
	return db;
}

function createPgInteractionStoreShim(): InteractionStore {
	type StoredRecord = InteractionRecord & { isProcessed: boolean };

	const recordsBySession = new Map<string, StoredRecord[]>();
	const slotPayloadBySessionAgent = new Map<string, string>();

	const getRecords = (sessionId: string): StoredRecord[] => {
		const existing = recordsBySession.get(sessionId);
		if (existing) {
			return existing;
		}
		const created: StoredRecord[] = [];
		recordsBySession.set(sessionId, created);
		return created;
	};

	const getSortedRecords = (sessionId: string): StoredRecord[] =>
		[...getRecords(sessionId)].sort((a, b) => a.recordIndex - b.recordIndex);

	const sessionAgentKey = (sessionId: string, agentId: string): string =>
		`${sessionId}::${agentId}`;

	const store = {
		commit(record: InteractionRecord): void {
			const records = getRecords(record.sessionId);
			const duplicate = records.find(
				(entry) => entry.recordId === record.recordId,
			);
			if (duplicate) {
				throw new Error(`Duplicate record: recordId=${record.recordId}`);
			}
			records.push({ ...record, isProcessed: false });
		},

		runInTransaction<T>(fn: (store: InteractionStore) => T): T {
			return fn(store as unknown as InteractionStore);
		},

		async runInTransactionAsync<T>(
			fn: (store: InteractionStore) => Promise<T>,
		): Promise<T> {
			return fn(store as unknown as InteractionStore);
		},

		settlementExists(sessionId: string, settlementId: string): boolean {
			return getRecords(sessionId).some(
				(entry) =>
					entry.recordId === settlementId &&
					entry.recordType === "turn_settlement",
			);
		},

		findRecordByCorrelatedTurnId(
			sessionId: string,
			correlatedTurnId: string,
			actorType: string,
		): InteractionRecord | undefined {
			return getRecords(sessionId).find(
				(entry) =>
					entry.correlatedTurnId === correlatedTurnId &&
					entry.actorType === actorType,
			);
		},

		findSessionIdByRequestId(requestId: string): string | undefined {
			const sessionIds = new Set<string>();
			for (const [sessionId, records] of recordsBySession.entries()) {
				if (records.some((entry) => entry.correlatedTurnId === requestId)) {
					sessionIds.add(sessionId);
				}
			}
			if (sessionIds.size === 0) {
				return undefined;
			}
			if (sessionIds.size > 1) {
				throw new Error(
					`Request id maps to multiple sessions: requestId=${requestId}`,
				);
			}
			return [...sessionIds][0];
		},

		getSettlementPayload(
			sessionId: string,
			requestId: string,
		): TurnSettlementPayload | undefined {
			const latest = getSortedRecords(sessionId)
				.filter(
					(entry) =>
						entry.recordType === "turn_settlement" &&
						entry.correlatedTurnId === requestId,
				)
				.at(-1);
			if (!latest) {
				return undefined;
			}
			const payload = latest.payload;
			if (!payload || typeof payload !== "object") {
				return undefined;
			}
			return payload as TurnSettlementPayload;
		},

		getMessageRecords(sessionId: string): InteractionRecord[] {
			return getSortedRecords(sessionId).filter(
				(entry) => entry.recordType === "message",
			);
		},

		upsertRecentCognitionSlot(
			sessionId: string,
			agentId: string,
			_settlementId: string,
			newEntriesJson = "[]",
		): void {
			const key = sessionAgentKey(sessionId, agentId);
			const current = slotPayloadBySessionAgent.get(key);
			let existingEntries: unknown[] = [];
			if (current) {
				try {
					const parsed = JSON.parse(current) as unknown;
					existingEntries = Array.isArray(parsed) ? parsed : [];
				} catch {
					existingEntries = [];
				}
			}

			let incomingEntries: unknown[] = [];
			try {
				const parsed = JSON.parse(newEntriesJson) as unknown;
				incomingEntries = Array.isArray(parsed) ? parsed : [];
			} catch {
				incomingEntries = [];
			}

			const merged = existingEntries.concat(incomingEntries).slice(-64);
			slotPayloadBySessionAgent.set(key, JSON.stringify(merged));
		},

		getBySession(
			sessionId: string,
			options?: { fromIndex?: number; toIndex?: number; limit?: number },
		): InteractionRecord[] {
			let records = getSortedRecords(sessionId);
			if (options?.fromIndex !== undefined) {
				const fromIndex = options.fromIndex;
				records = records.filter((entry) => entry.recordIndex >= fromIndex);
			}
			if (options?.toIndex !== undefined) {
				const toIndex = options.toIndex;
				records = records.filter((entry) => entry.recordIndex <= toIndex);
			}
			if (options?.limit !== undefined) {
				records = records.slice(0, options.limit);
			}
			return records;
		},

		getByRange(
			sessionId: string,
			rangeStart: number,
			rangeEnd: number,
		): InteractionRecord[] {
			return getSortedRecords(sessionId).filter(
				(entry) =>
					entry.recordIndex >= rangeStart && entry.recordIndex <= rangeEnd,
			);
		},

		markProcessed(sessionId: string, upToIndex: number): void {
			for (const entry of getRecords(sessionId)) {
				if (entry.recordIndex <= upToIndex) {
					entry.isProcessed = true;
				}
			}
		},

		markRangeProcessed(
			sessionId: string,
			rangeStart: number,
			rangeEnd: number,
		): void {
			for (const entry of getRecords(sessionId)) {
				if (entry.recordIndex >= rangeStart && entry.recordIndex <= rangeEnd) {
					entry.isProcessed = true;
				}
			}
		},

		countUnprocessedRpTurns(sessionId: string): number {
			return getRecords(sessionId).filter(
				(entry) =>
					!entry.isProcessed &&
					entry.recordType === "message" &&
					(entry.actorType === "user" || entry.actorType === "rp_agent"),
			).length;
		},

		getMinMaxUnprocessedIndex(
			sessionId: string,
		): { min: number; max: number } | undefined {
			const unprocessed = getRecords(sessionId)
				.filter((entry) => !entry.isProcessed)
				.map((entry) => entry.recordIndex);
			if (unprocessed.length === 0) {
				return undefined;
			}
			return {
				min: Math.min(...unprocessed),
				max: Math.max(...unprocessed),
			};
		},

		getMaxIndex(sessionId: string): number | undefined {
			const indices = getRecords(sessionId).map((entry) => entry.recordIndex);
			if (indices.length === 0) {
				return undefined;
			}
			return Math.max(...indices);
		},

		getPendingSettlementJobState(_sessionId: string): {
			status?: string;
			failure_count?: number;
			next_attempt_at?: number | null;
			last_error_code?: string | null;
			last_error_message?: string | null;
		} | null {
			void _sessionId;
			return null;
		},

		countUnprocessedSettlements(sessionId: string): number {
			return getRecords(sessionId).filter(
				(entry) => !entry.isProcessed && entry.recordType === "turn_settlement",
			).length;
		},

		getUnprocessedSettlementRange(
			sessionId: string,
		): { min: number; max: number } | null {
			const indices = getRecords(sessionId)
				.filter(
					(entry) =>
						!entry.isProcessed && entry.recordType === "turn_settlement",
				)
				.map((entry) => entry.recordIndex);
			if (indices.length === 0) {
				return null;
			}
			return { min: Math.min(...indices), max: Math.max(...indices) };
		},

		listStalePendingSettlementSessions(staleCutoffMs: number): Array<{
			sessionId: string;
			agentId: string;
			oldestSettlementAt: number;
		}> {
			const includeAll = staleCutoffMs < 0;
			const cutoffTs = Date.now() - staleCutoffMs;
			const result: Array<{
				sessionId: string;
				agentId: string;
				oldestSettlementAt: number;
			}> = [];

			for (const [sessionId, records] of recordsBySession.entries()) {
				const settlements = records.filter(
					(entry) =>
						!entry.isProcessed && entry.recordType === "turn_settlement",
				);
				if (settlements.length === 0) {
					continue;
				}

				const newest = settlements.reduce((current, candidate) =>
					candidate.committedAt > current.committedAt ? candidate : current,
				);
				if (!includeAll && newest.committedAt > cutoffTs) {
					continue;
				}

				const payload = newest.payload as {
					ownerAgentId?: unknown;
				};
				if (typeof payload.ownerAgentId !== "string") {
					continue;
				}

				const oldestSettlementAt = settlements.reduce(
					(min, record) => Math.min(min, record.committedAt),
					Number.POSITIVE_INFINITY,
				);
				if (!Number.isFinite(oldestSettlementAt)) {
					continue;
				}

				result.push({
					sessionId,
					agentId: payload.ownerAgentId,
					oldestSettlementAt,
				});
			}

			return result.sort((a, b) => a.oldestSettlementAt - b.oldestSettlementAt);
		},

		getUnprocessedRangeForSession(
			sessionId: string,
		): { rangeStart: number; rangeEnd: number } | null {
			const range = store.getMinMaxUnprocessedIndex(sessionId);
			if (!range) {
				return null;
			}
			return {
				rangeStart: range.min,
				rangeEnd: range.max,
			};
		},
	};

	return store as unknown as InteractionStore;
}

export function bootstrapRuntime(
	options: RuntimeBootstrapOptions = {},
): RuntimeBootstrapResult {
	const backendType = resolveBackendType();
	let pgFactory: PgBackendFactory | null = null;
	if (backendType === "pg") {
		pgFactory = new PgBackendFactory();
	}

	const runtimeCwd = resolveRuntimeCwd(options);
	const databasePath = resolveDatabasePath(options, runtimeCwd);
	if (backendType === "sqlite") {
		ensureDirectoryExists(dirname(databasePath));
	}

	const db =
		backendType === "sqlite"
			? openDatabase({
					path: databasePath,
					busyTimeoutMs: options.busyTimeoutMs,
				})
			: undefined;
	const resolvedJobPersistence: JobPersistence =
		options.jobPersistence ??
		createJobPersistence(backendType, {
			db,
			pgFactory: pgFactory ?? undefined,
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

	if (backendType === "sqlite" && db) {
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
	} else if (backendType === "pg") {
		migrationStatus.interaction.succeeded = true;
		migrationStatus.memory.succeeded = true;
		migrationStatus.succeeded = true;
	}

	const sessionService =
		options.sessionService ??
		new SessionService(backendType === "sqlite" ? db : undefined);
	const blackboard = options.blackboard ?? new Blackboard();
	const agentRegistry = buildAgentRegistry(options, runtimeCwd);
	const modelRegistry = options.modelRegistry ?? bootstrapRegistry();
	const toolExecutor = options.toolExecutor ?? new ToolExecutor();
	const resolvePgPool = () => {
		if (!pgFactory) {
			throw new Error("PG backend factory is unavailable");
		}
		return pgFactory.getPool();
	};
	const runtimeServices = {
		db: backendType === "sqlite" ? db : undefined,
		rawDb: backendType === "sqlite" ? db?.raw : undefined,
		sessionService,
		blackboard,
		agentRegistry,
		modelRegistry,
		toolExecutor,
		migrationStatus,
	};

	const interactionStore =
		backendType === "sqlite" && db
			? new InteractionStore(db)
			: createPgInteractionStoreShim();
	const commitService = new CommitService(interactionStore);
	const flushSelector = new FlushSelector(interactionStore);
	const graphStorage =
		backendType === "sqlite" && db
			? new GraphStorageService(db, resolvedJobPersistence)
			: undefined;

	const coreMemoryService =
		backendType === "sqlite" && db ? new CoreMemoryService(db) : undefined;
	const sqliteDb = backendType === "sqlite" ? requireSqliteDb(db) : undefined;
	const sqliteGraphStorage =
		backendType === "sqlite" ? graphStorage : undefined;
	const sqliteCoreMemoryService =
		backendType === "sqlite" ? coreMemoryService : undefined;

	const requireSqliteCoreMemoryService = (): CoreMemoryService => {
		if (!sqliteCoreMemoryService) {
			throw new Error("SQLite core memory service is unavailable");
		}
		return sqliteCoreMemoryService;
	};

	const interactionRepo: RuntimeBootstrapResult["interactionRepo"] =
		backendType === "pg"
			? createLazyPgRepo(() => new PgInteractionRepo(resolvePgPool()))
			: new SqliteInteractionRepoAdapter(interactionStore);

	const coreMemoryBlockRepo: RuntimeBootstrapResult["coreMemoryBlockRepo"] =
		backendType === "pg"
			? createLazyPgRepo(() => new PgCoreMemoryBlockRepo(resolvePgPool()))
			: new SqliteCoreMemoryBlockRepoAdapter(requireSqliteCoreMemoryService());

	const recentCognitionSlotRepo: RuntimeBootstrapResult["recentCognitionSlotRepo"] =
		backendType === "pg"
			? createLazyPgRepo(() => new PgRecentCognitionSlotRepo(resolvePgPool()))
			: new SqliteRecentCognitionSlotRepoAdapter(
					interactionStore,
					requireSqliteDb(sqliteDb),
				);

	const sharedBlockRepo: RuntimeBootstrapResult["sharedBlockRepo"] =
		backendType === "pg"
			? createLazyPgRepo(() => new PgSharedBlockRepo(resolvePgPool()))
			: new SqliteSharedBlockRepoAdapter(
					new SqliteSharedBlockRepoImpl(requireSqliteDb(sqliteDb).raw as never),
					requireSqliteDb(sqliteDb),
				);

	if (backendType === "sqlite") {
		registerRuntimeTools(toolExecutor, runtimeServices);
	}

	const memoryMigrationModelId =
		options.memoryMigrationModelId ?? TASK_AGENT_PROFILE.modelId;
	const memoryEmbeddingModelId = options.memoryEmbeddingModelId;
	const effectiveOrganizerEmbeddingModelId =
		options.memoryOrganizerEmbeddingModelId ?? memoryEmbeddingModelId;
	const settlementLedger =
		backendType === "sqlite" && db
			? new SqliteSettlementLedger(db.raw)
			: undefined;
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
					const transactionBatcher =
						backendType === "pg"
							? new PgTransactionBatcher()
							: new TransactionBatcher(requireSqliteDb(sqliteDb));
					const embeddingRepo =
						backendType === "pg"
							? createLazyPgRepo(() => new PgEmbeddingRepo(resolvePgPool()))
							: new SqliteEmbeddingRepoAdapter(requireSqliteDb(sqliteDb));
					const embeddings = new EmbeddingService(embeddingRepo, transactionBatcher);
					if (
						backendType === "sqlite" &&
						sqliteDb &&
						sqliteGraphStorage &&
						sqliteCoreMemoryService &&
						settlementLedger
					) {
						const promotionQueryRepo = new SqlitePromotionQueryRepo(sqliteDb);
						const materialization = new MaterializationService(
							sqliteDb,
							sqliteGraphStorage,
							promotionQueryRepo,
							new AreaWorldProjectionRepo(sqliteDb.raw),
						);
						const organizerEmbeddingModelId =
							effectiveOrganizerEmbeddingModelId ?? memoryEmbeddingModelId;
						const provider = new MemoryTaskModelProviderAdapter(
							modelRegistry,
							memoryMigrationModelId,
							organizerEmbeddingModelId,
						);
						memoryTaskAgent = new MemoryTaskAgent(
							sqliteDb,
							sqliteGraphStorage,
							sqliteCoreMemoryService,
							embeddings,
							materialization,
							provider,
							settlementLedger,
							resolvedJobPersistence,
							options.strictDurableMode,
						);
						memoryPipelineReady = true;
						memoryPipelineStatus = "ready";
					}
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
	const memoryAdapter: MemoryDataSource =
		backendType === "sqlite" && db
			? new MemoryAdapter(db, {
					coreMemoryBlockRepo,
					recentCognitionSlotRepo,
					interactionRepo,
					sharedBlockRepo,
				})
			: {
					getPinnedBlocks(agentId: string): Promise<string> {
						return getPinnedBlocksAsync(agentId, {
							coreMemoryBlockRepo,
							recentCognitionSlotRepo,
							interactionRepo,
							sharedBlockRepo,
						});
					},
					getSharedBlocks(agentId: string): Promise<string> {
						return getSharedBlocksAsync(agentId, {
							coreMemoryBlockRepo,
							recentCognitionSlotRepo,
							interactionRepo,
							sharedBlockRepo,
						});
					},
					getRecentCognition(viewerContext): Promise<string> {
						return getRecentCognitionAsync(
							viewerContext.viewer_agent_id,
							viewerContext.session_id,
							{
								coreMemoryBlockRepo,
								recentCognitionSlotRepo,
								interactionRepo,
								sharedBlockRepo,
							},
						);
					},
					getAttachedSharedBlocks(agentId: string): Promise<string> {
						return getAttachedSharedBlocksAsync(agentId, {
							coreMemoryBlockRepo,
							recentCognitionSlotRepo,
							interactionRepo,
							sharedBlockRepo,
						});
					},
					async getTypedRetrievalSurface(
						_userMessage: string,
						_viewerContext: unknown,
					): Promise<string> {
						return "";
					},
				};
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
				(await sessionService.getSession(request.sessionId))?.agentId ??
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
				(await sessionService.getSession(request.sessionId))?.agentId ??
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

	const settlementUnitOfWork: SettlementUnitOfWork | null =
		backendType === "pg" && pgFactory
			? {
					run<T>(
						fn: (
							repos: import("../storage/unit-of-work.js").SettlementRepos,
						) => Promise<T>,
					): Promise<T> {
						return new PgSettlementUnitOfWork(pgFactory.getPool()).run(fn);
					},
				}
			: null;

	const episodeRepo =
		backendType === "pg"
			? createLazyPgRepo(() => new PgEpisodeRepo(resolvePgPool()))
			: new EpisodeRepository(requireSqliteDb(sqliteDb));
	const cognitionEventRepo =
		backendType === "pg"
			? createLazyPgRepo(() => new PgCognitionEventRepo(resolvePgPool()))
			: new CognitionEventRepo(requireSqliteDb(sqliteDb).raw);
	const cognitionProjectionRepo =
		backendType === "pg"
			? createLazyPgRepo(() => new PgCognitionProjectionRepo(resolvePgPool()))
			: new PrivateCognitionProjectionRepo(requireSqliteDb(sqliteDb).raw);
	const sqliteAreaWorldProjectionRepo =
		backendType === "sqlite"
			? new AreaWorldProjectionRepo(requireSqliteDb(sqliteDb).raw)
			: undefined;
	const areaWorldProjectionRepo =
		backendType === "pg"
			? createLazyPgRepo(() => new PgAreaWorldProjectionRepo(resolvePgPool()))
			: sqliteAreaWorldProjectionRepo;
	const projectionManager = new ProjectionManager(
		episodeRepo,
		cognitionEventRepo,
		cognitionProjectionRepo,
		graphStorage ?? null,
		areaWorldProjectionRepo,
		backendType === "sqlite" ? db?.raw : undefined,
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
		settlementUnitOfWork,
	);

	const pendingFlushRepo =
		backendType === "pg"
			? createLazyPgRepo(() => new PgPendingFlushRecoveryRepo(resolvePgPool()))
			: new SqlitePendingFlushRecoveryRepoAdapter(requireSqliteDb(sqliteDb));
	const pendingSettlementSweeper = memoryTaskAgent
		? new PendingSettlementSweeper(
				pendingFlushRepo,
				interactionStore,
				flushSelector,
				memoryTaskAgent,
			)
		: null;
	const publicationRecoverySweeper =
		backendType === "sqlite" && db && graphStorage
			? new PublicationRecoverySweeper(db, graphStorage, {
					projectionRepo: sqliteAreaWorldProjectionRepo,
				})
			: null;
	pendingSettlementSweeper?.start();
	publicationRecoverySweeper?.start();

	const shutdown = (): void => {
		pendingSettlementSweeper?.stop();
		publicationRecoverySweeper?.stop();
		if (db) {
			closeDatabaseGracefully(db);
		}
		if (pgFactory) {
			void pgFactory
				.close()
				.catch((err) => console.error("PG pool close error:", err));
		}
	};

	return {
		db: db ?? undefined,
		rawDb: db?.raw ?? undefined,
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
		backendType,
		pgFactory,
		settlementUnitOfWork,
		interactionRepo,
		coreMemoryBlockRepo,
		recentCognitionSlotRepo,
		sharedBlockRepo,
		jobPersistence: resolvedJobPersistence,
		shutdown,
	};
}

/**
 * Async PG backend initialization — call after bootstrapRuntime() when
 * backendType is 'pg'. Creates a PG pool, bootstraps all three schema
 * layers (truth, ops, derived), and stores the pool on the factory.
 *
 * No-op if the runtime's pgFactory is null (i.e. SQLite backend).
 */
export async function initializePgBackendForRuntime(
	result: RuntimeBootstrapResult,
): Promise<void> {
	if (!result.pgFactory) return;
	await result.pgFactory.initialize({
		type: "pg",
		pg: { url: process.env.PG_APP_URL ?? "" },
	});
}
