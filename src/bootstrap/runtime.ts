import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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
	PersonaAdapter,
} from "../core/prompt-data-adapters/index.js";
import { MemoryAdapter } from "../core/prompt-data-adapters/memory-adapter.js";
import { PromptRenderer } from "../core/prompt-renderer.js";
import { ToolExecutor } from "../core/tools/tool-executor.js";
import { CommitService } from "../interaction/commit-service.js";
import type {
	InteractionRecord,
	TurnSettlementPayload,
} from "../interaction/contracts.js";
import { FlushSelector } from "../interaction/flush-selector.js";
import type { InteractionStore } from "../interaction/store.js";
import { createJobPersistence } from "../jobs/job-persistence-factory.js";
import type { JobPersistence } from "../jobs/persistence.js";
import { createLoreService } from "../lore/service.js";
import { AliasService } from "../memory/alias.js";
import { CognitionRepository } from "../memory/cognition/cognition-repo.js";
import { CognitionSearchService } from "../memory/cognition/cognition-search.js";
import { RelationBuilder } from "../memory/cognition/relation-builder.js";
import { CoreMemoryService } from "../memory/core-memory.js";
import { EmbeddingService } from "../memory/embeddings.js";
import { MemoryTaskModelProviderAdapter } from "../memory/model-provider-adapter.js";
import { NarrativeSearchService } from "../memory/narrative/narrative-search.js";
import { GraphNavigator } from "../memory/navigator.js";
import { PendingSettlementSweeper } from "../memory/pending-settlement-sweeper.js";
import { PgTransactionBatcher } from "../memory/pg-transaction-batcher.js";
import { ProjectionManager } from "../memory/projection/projection-manager.js";
import type { PromptDataRepos } from "../memory/prompt-data.js";
import { PublicationRecoverySweeper } from "../memory/publication-recovery-sweeper.js";
import { RetrievalOrchestrator } from "../memory/retrieval/retrieval-orchestrator.js";
import { RetrievalService } from "../memory/retrieval.js";
import type { SettlementLedger } from "../memory/settlement-ledger.js";
import { GraphStorageService } from "../memory/storage.js";
import {
	MemoryTaskAgent,
	type MemoryTaskModelProvider,
} from "../memory/task-agent.js";
import { registerMemoryTools } from "../memory/tools.js";
import { PersonaLoader } from "../persona/loader.js";
import { PersonaService } from "../persona/service.js";
import type { RpBufferedExecutionResult } from "../runtime/rp-turn-contract.js";
import { TurnService } from "../runtime/turn-service.js";
import { resolveViewerContext } from "../runtime/viewer-context-resolver.js";
import { SessionService } from "../session/service.js";
import { Blackboard } from "../state/blackboard.js";
import { PgBackendFactory } from "../storage/backend-types.js";
import type { SettlementLedgerRepo } from "../storage/domain-repos/contracts/settlement-ledger-repo.js";
import { PgAliasRepo } from "../storage/domain-repos/pg/alias-repo.js";
import { PgAreaWorldProjectionRepo } from "../storage/domain-repos/pg/area-world-projection-repo.js";
import { PgCognitionEventRepo } from "../storage/domain-repos/pg/cognition-event-repo.js";
import { PgCognitionProjectionRepo } from "../storage/domain-repos/pg/cognition-projection-repo.js";
import { PgCognitionSearchRepo } from "../storage/domain-repos/pg/cognition-search-repo.js";
import { PgCoreMemoryBlockRepo } from "../storage/domain-repos/pg/core-memory-block-repo.js";
import { PgEmbeddingRepo } from "../storage/domain-repos/pg/embedding-repo.js";
import { PgEpisodeRepo } from "../storage/domain-repos/pg/episode-repo.js";
import { PgGraphMutableStoreRepo } from "../storage/domain-repos/pg/graph-mutable-store-repo.js";
import { PgGraphReadQueryRepo } from "../storage/domain-repos/pg/graph-read-query-repo.js";
import { PgInteractionRepo } from "../storage/domain-repos/pg/interaction-repo.js";
import { PgNarrativeSearchRepo } from "../storage/domain-repos/pg/narrative-search-repo.js";
import { PgNodeScoreRepo } from "../storage/domain-repos/pg/node-score-repo.js";
import { PgNodeScoringQueryRepo } from "../storage/domain-repos/pg/node-scoring-query-repo.js";
import { PgPendingFlushRecoveryRepo } from "../storage/domain-repos/pg/pending-flush-recovery-repo.js";
import { PgPromotionQueryRepo } from "../storage/domain-repos/pg/promotion-query-repo.js";
import { PgRecentCognitionSlotRepo } from "../storage/domain-repos/pg/recent-cognition-slot-repo.js";
import { PgRelationReadRepo } from "../storage/domain-repos/pg/relation-read-repo.js";
import { PgRelationWriteRepo } from "../storage/domain-repos/pg/relation-write-repo.js";
import { PgRetrievalReadRepo } from "../storage/domain-repos/pg/retrieval-read-repo.js";
import { PgSearchProjectionRepo } from "../storage/domain-repos/pg/search-projection-repo.js";
import { PgSemanticEdgeRepo } from "../storage/domain-repos/pg/semantic-edge-repo.js";
import { PgSessionRepo } from "../storage/domain-repos/pg/session-repo.js";
import { PgSettlementLedgerRepo } from "../storage/domain-repos/pg/settlement-ledger-repo.js";
import { PgSharedBlockRepo } from "../storage/domain-repos/pg/shared-block-repo.js";
import { resolveStoragePaths } from "../storage/paths.js";
import { PgSettlementUnitOfWork } from "../storage/pg-settlement-uow.js";
import type { SettlementUnitOfWork } from "../storage/unit-of-work.js";
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
	return isAbsolute(pathValue) ? pathValue : resolve(cwd, pathValue);
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

function createSettlementLedgerAdapter(
	settlementLedgerRepo: SettlementLedgerRepo,
): SettlementLedger {
	return {
		check(settlementId: string) {
			return settlementLedgerRepo.check(settlementId);
		},
		rawStatus(settlementId: string) {
			return settlementLedgerRepo.rawStatus(settlementId);
		},
		markPending(settlementId: string, agentId: string) {
			return settlementLedgerRepo.markPending(settlementId, agentId);
		},
		markClaimed(settlementId: string, claimedBy: string) {
			return settlementLedgerRepo.markClaimed(settlementId, claimedBy);
		},
		markApplying(settlementId: string, agentId: string, payloadHash?: string) {
			return settlementLedgerRepo.markApplying(settlementId, agentId, payloadHash);
		},
		markApplied(settlementId: string) {
			return settlementLedgerRepo.markApplied(settlementId);
		},
		markReplayedNoop(settlementId: string) {
			return settlementLedgerRepo.markReplayedNoop(settlementId);
		},
		markConflict(settlementId: string, errorMessage: string) {
			return settlementLedgerRepo.markConflict(settlementId, errorMessage);
		},
		markFailed(settlementId: string, errorMessage: string, retryable: boolean) {
			if (retryable) {
				return settlementLedgerRepo.markFailedRetryScheduled(
					settlementId,
					errorMessage,
				);
			}
			return settlementLedgerRepo.markFailedTerminal(settlementId, errorMessage);
		},
	};
}

function isPublicationRecoverySchemaCompatible(): boolean {
	return false;
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

		getMessageRecords(
			sessionId: string,
			options?: { mode?: string },
		): InteractionRecord[] {
			const mode = options?.mode ?? "full";
			const sorted = getSortedRecords(sessionId).filter(
				(entry) => entry.recordType === "message",
			);
			if (mode === "truncated") {
				return sorted.filter((entry) => !entry.isProcessed);
			}
			return sorted;
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
	const pgFactory = new PgBackendFactory();

	const runtimeCwd = resolveRuntimeCwd(options);
	const resolvedJobPersistence: JobPersistence =
		options.jobPersistence ??
		createJobPersistence("pg", {
			pgFactory,
		});

	const migrationStatus: RuntimeMigrationStatus = {
		interaction: {
			succeeded: true,
			appliedMigrations: [],
		},
		memory: {
			succeeded: true,
		},
		succeeded: true,
	};

	const resolvePgPool = () => pgFactory.getPool();
	const pgSessionRepo = createLazyPgRepo(
		() => new PgSessionRepo(resolvePgPool()),
	);
	const sessionService =
		options.sessionService ?? new SessionService({ pgRepo: pgSessionRepo });
	const blackboard = options.blackboard ?? new Blackboard();
	const agentRegistry = buildAgentRegistry(options, runtimeCwd);
	const modelRegistry = options.modelRegistry ?? bootstrapRegistry();
	const toolExecutor = options.toolExecutor ?? new ToolExecutor();

	const interactionStore = createPgInteractionStoreShim();
	const commitService = new CommitService(interactionStore);
	const flushSelector = new FlushSelector(interactionStore);

	const interactionRepo: RuntimeBootstrapResult["interactionRepo"] =
		createLazyPgRepo(() => new PgInteractionRepo(resolvePgPool()));

	const coreMemoryBlockRepo: RuntimeBootstrapResult["coreMemoryBlockRepo"] =
		createLazyPgRepo(() => new PgCoreMemoryBlockRepo(resolvePgPool()));

	const recentCognitionSlotRepo: RuntimeBootstrapResult["recentCognitionSlotRepo"] =
		createLazyPgRepo(() => new PgRecentCognitionSlotRepo(resolvePgPool()));

	const sharedBlockRepo: RuntimeBootstrapResult["sharedBlockRepo"] =
		createLazyPgRepo(() => new PgSharedBlockRepo(resolvePgPool()));

	const memoryMigrationModelId =
		options.memoryMigrationModelId ?? TASK_AGENT_PROFILE.modelId;
	const memoryEmbeddingModelId = options.memoryEmbeddingModelId;
	const effectiveOrganizerEmbeddingModelId =
		options.memoryOrganizerEmbeddingModelId ?? memoryEmbeddingModelId;
	let memoryPipelineReady = false;
	const memoryPipelineStatusPreliminary: MemoryPipelineStatus = (() => {
		if (!memoryEmbeddingModelId) {
			return "missing_embedding_model";
		}

		try {
			modelRegistry.resolveChat(memoryMigrationModelId);
		} catch (error) {
			console.error("[memoryPipelineStatus] chat model unavailable:", error);
			return "chat_model_unavailable";
		}

		try {
			modelRegistry.resolveEmbedding(memoryEmbeddingModelId);
		} catch (error) {
			console.error(
				"[memoryPipelineStatus] embedding model unavailable:",
				error,
			);
			return "embedding_model_unavailable";
		}

		if (effectiveOrganizerEmbeddingModelId) {
			try {
				modelRegistry.resolveEmbedding(effectiveOrganizerEmbeddingModelId);
			} catch (error) {
				console.error(
					"[memoryPipelineStatus] organizer embedding model unavailable:",
					error,
				);
				return "organizer_embedding_model_unavailable";
			}
		}

		return "partial";
	})();

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
	const promptDataRepos: PromptDataRepos = {
		coreMemoryBlockRepo,
		recentCognitionSlotRepo,
		interactionRepo,
		sharedBlockRepo,
	};
	const operationalAdapter = new BlackboardOperationalDataSource(blackboard);

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

	const settlementUnitOfWork: SettlementUnitOfWork | null = {
		run<T>(
			fn: (
				repos: import("../storage/unit-of-work.js").SettlementRepos,
			) => Promise<T>,
		): Promise<T> {
			return new PgSettlementUnitOfWork(pgFactory.getPool()).run(fn);
		},
	};

	const episodeRepo = createLazyPgRepo(
		() => new PgEpisodeRepo(resolvePgPool()),
	);
	const cognitionEventRepo = createLazyPgRepo(
		() => new PgCognitionEventRepo(resolvePgPool()),
	);
	const cognitionProjectionRepo = createLazyPgRepo(
		() => new PgCognitionProjectionRepo(resolvePgPool()),
	);
	const areaWorldProjectionRepo = createLazyPgRepo(
		() => new PgAreaWorldProjectionRepo(resolvePgPool()),
	);
	const graphStoreRepo = createLazyPgRepo(
		() => new PgGraphMutableStoreRepo(resolvePgPool()),
	);
	const searchProjectionRepo = createLazyPgRepo(
		() => new PgSearchProjectionRepo(resolvePgPool()),
	);
	const embeddingRepo = createLazyPgRepo(
		() => new PgEmbeddingRepo(resolvePgPool()),
	);
	const pgRetrievalReadRepo = createLazyPgRepo(
		() => new PgRetrievalReadRepo(resolvePgPool()),
	);
	const pgCognitionSearchRepo = createLazyPgRepo(
		() => new PgCognitionSearchRepo(resolvePgPool()),
	);
	const pgRelationReadRepo = createLazyPgRepo(
		() => new PgRelationReadRepo(resolvePgPool()),
	);
	const pgRelationWriteRepo = createLazyPgRepo(
		() => new PgRelationWriteRepo(resolvePgPool()),
	);
	const pgAliasRepo = createLazyPgRepo(() => new PgAliasRepo(resolvePgPool()));
	const pgGraphReadQueryRepo = createLazyPgRepo(
		() => new PgGraphReadQueryRepo(resolvePgPool()),
	);
	const pgNarrativeSearchRepo = createLazyPgRepo(
		() => new PgNarrativeSearchRepo(resolvePgPool()),
	);
	const semanticEdgeRepo = createLazyPgRepo(
		() => new PgSemanticEdgeRepo(resolvePgPool()),
	);
	const nodeScoreRepo = createLazyPgRepo(
		() => new PgNodeScoreRepo(resolvePgPool()),
	);
	const nodeScoringQueryRepo = createLazyPgRepo(
		() => new PgNodeScoringQueryRepo(resolvePgPool()),
	);
	const promotionQueryRepo = createLazyPgRepo(
		() => new PgPromotionQueryRepo(resolvePgPool()),
	);
	const settlementLedgerRepo = createLazyPgRepo(
		() => new PgSettlementLedgerRepo(resolvePgPool()),
	);
	const projectionManager = new ProjectionManager(
		episodeRepo,
		cognitionEventRepo,
		cognitionProjectionRepo,
		null,
		areaWorldProjectionRepo,
		undefined,
	);
	const graphStorageService = GraphStorageService.withDomainRepos(
		{
			graphStoreRepo,
			searchProjectionRepo,
			embeddingRepo,
			semanticEdgeRepo,
			nodeScoreRepo,
			coreMemoryBlockRepo,
			sharedBlockRepo,
			episodeRepo,
			cognitionEventRepo,
			cognitionProjectionRepo,
			areaWorldProjectionRepo,
		},
		resolvedJobPersistence,
	);
	const coreMemoryService = new CoreMemoryService(coreMemoryBlockRepo);

	const embeddingService = new EmbeddingService(
		embeddingRepo,
		new PgTransactionBatcher(),
	);
	const aliasService = new AliasService(pgAliasRepo);
	const narrativeSearchService = new NarrativeSearchService(
		pgNarrativeSearchRepo,
	);
	const cognitionSearchService = new CognitionSearchService(
		pgCognitionSearchRepo,
		pgRelationReadRepo,
		cognitionProjectionRepo,
	);
	const currentProjectionReader =
		cognitionSearchService.createCurrentProjectionReader();
	const retrievalOrchestrator = new RetrievalOrchestrator({
		narrativeService: narrativeSearchService,
		cognitionService: cognitionSearchService,
		currentProjectionReader,
	});
	const retrievalService = new RetrievalService({
		retrievalRepo: pgRetrievalReadRepo,
		embeddingService,
		narrativeSearch: narrativeSearchService,
		cognitionSearch: cognitionSearchService,
		orchestrator: retrievalOrchestrator,
	});
	const memoryTaskModelProvider: MemoryTaskModelProvider | undefined =
		memoryEmbeddingModelId
			? (() => {
					try {
						return new MemoryTaskModelProviderAdapter(
							modelRegistry,
							memoryMigrationModelId,
							memoryEmbeddingModelId,
						);
					} catch (error) {
						const reason =
							error instanceof Error ? error.message : String(error);
						return {
							defaultEmbeddingModelId: memoryEmbeddingModelId,
							chat: async () => {
								throw new Error(
									`[MemoryTaskModelProviderAdapter] chat provider unavailable: ${reason}`,
								);
							},
							embed: async () => {
								throw new Error(
									`[MemoryTaskModelProviderAdapter] embedding provider unavailable: ${reason}`,
								);
							},
						} satisfies MemoryTaskModelProvider;
					}
				})()
			: undefined;
	const graphNavigator = new GraphNavigator(
		pgGraphReadQueryRepo,
		retrievalService,
		aliasService,
		undefined,
		narrativeSearchService,
		cognitionSearchService,
		undefined,
		undefined,
		undefined,
		memoryTaskModelProvider,
		effectiveOrganizerEmbeddingModelId,
	);
	const memoryAdapter = new MemoryAdapter(promptDataRepos, retrievalService);
	const promptBuilder = new PromptBuilder({
		persona: personaAdapter,
		lore: loreAdapter,
		memory: memoryAdapter,
		operational: operationalAdapter,
	});
	registerMemoryTools(
		{
			registerLocal(memTool) {
				toolExecutor.registerLocal({
					name: memTool.name,
					description: memTool.description,
					parameters: memTool.parameters,
					effectClass: memTool.effectClass,
					traceVisibility: memTool.traceVisibility,
					executionContract: memTool.executionContract,
					async execute(params, context) {
						const vc = context?.viewerContext;
						if (!vc) {
							throw new Error(
								`Memory tool '${memTool.name}' requires viewerContext in DispatchContext`,
							);
						}
						return memTool.handler(params as Record<string, unknown>, vc);
					},
				});
			},
		},
		{
			coreMemory: coreMemoryService,
			retrieval: retrievalService,
			navigator: graphNavigator,
			narrativeSearch: narrativeSearchService,
			cognitionSearch: cognitionSearchService,
		},
	);
	const settlementLedger = createSettlementLedgerAdapter(settlementLedgerRepo);
	const cognitionRepo = new CognitionRepository({
		cognitionProjectionRepo,
		cognitionEventRepo,
		searchProjectionRepo,
		entityResolver: (pointerKey: string, agentId: string) =>
			cognitionProjectionRepo.resolveEntityByPointerKey(pointerKey, agentId),
	});
	const relationBuilder = new RelationBuilder({
		relationWriteRepo: pgRelationWriteRepo,
		relationReadRepo: pgRelationReadRepo,
		cognitionProjectionRepo,
	});
	const memoryTaskAgent = memoryEmbeddingModelId
		? new MemoryTaskAgent(
				{
					sqlFactory: () => resolvePgPool(),
					graphMutableStoreRepo: graphStoreRepo,
					graphReadQueryRepo: pgGraphReadQueryRepo,
					episodeRepo,
					promotionQueryRepo,
					areaWorldProjectionRepo,
					explicitSettlement: {
						cognitionRepo,
						relationBuilder,
						relationWriteRepo: {
							upsertRelation: (params) => pgRelationWriteRepo.upsertRelation(params),
						},
						cognitionProjectionRepo: {
							getCurrent: (agentId, cognitionKey) => cognitionProjectionRepo.getCurrent(agentId, cognitionKey),
							updateConflictFactors: (
								agentId,
								cognitionKey,
								conflictSummary,
								conflictFactorRefsJson,
								updatedAt,
							) =>
								cognitionProjectionRepo.updateConflictFactors(
									agentId,
									cognitionKey,
									conflictSummary,
									conflictFactorRefsJson,
									updatedAt,
								),
						},
						episodeRepo: {
							readBySettlement: (settlementId, agentId) =>
								episodeRepo.readBySettlement(settlementId, agentId),
							readPublicationsBySettlement: (settlementId) =>
								episodeRepo.readPublicationsBySettlement(settlementId),
						},
					},
				},
				graphStorageService,
				coreMemoryService,
				embeddingService,
				memoryTaskModelProvider,
				settlementLedger,
				resolvedJobPersistence,
				options.strictDurableMode ?? false,
				nodeScoringQueryRepo,
			)
		: null;
	memoryPipelineReady = memoryTaskAgent !== null;
	const memoryPipelineStatus: MemoryPipelineStatus = memoryPipelineReady
		? "ready"
		: memoryPipelineStatusPreliminary;
	healthChecks.memory_pipeline = memoryPipelineReady ? "ok" : "degraded";

	const turnService = new TurnService(
		turnServiceAgentLoop,
		commitService,
		interactionStore,
		flushSelector,
		memoryTaskAgent,
		sessionService,
		viewerContextResolver,
		options.projectionSink,
		undefined,
		traceStore,
		projectionManager,
		settlementUnitOfWork,
		memoryPipelineReady,
	);

	const pendingFlushRepo = createLazyPgRepo(
		() => new PgPendingFlushRecoveryRepo(resolvePgPool()),
	);
	const pendingSettlementSweeper =
		memoryTaskAgent !== null
			? new PendingSettlementSweeper(
					pendingFlushRepo,
					interactionStore,
					flushSelector,
					memoryTaskAgent,
					{
						isEnabled: () => memoryPipelineReady,
					},
				)
			: null;
	const publicationRecoverySweeper =
		memoryTaskAgent !== null && isPublicationRecoverySchemaCompatible()
			? new PublicationRecoverySweeper(graphStorageService, undefined)
			: null;

	pendingSettlementSweeper?.start();
	publicationRecoverySweeper?.start();

	const shutdown = (): void => {
		pendingSettlementSweeper?.stop();
		publicationRecoverySweeper?.stop();
		void pgFactory
			.close()
			.catch((err) => console.error("PG pool close error:", err));
	};

	return {
		sessionService,
		blackboard,
		agentRegistry,
		modelRegistry,
		toolExecutor,
		promptBuilder,
		promptRenderer,
		runtimeServices: {
			sessionService,
			blackboard,
			agentRegistry,
			modelRegistry,
			toolExecutor,
			migrationStatus,
		},
		createAgentLoop,
		turnService,
		memoryTaskAgent,
		memoryPipelineReady,
		memoryPipelineStatus,
		effectiveOrganizerEmbeddingModelId,
		healthChecks,
		migrationStatus,
		traceStore,
		backendType: "pg",
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

export async function initializePgBackendForRuntime(
	result: RuntimeBootstrapResult,
): Promise<void> {
	if (!result.pgFactory) return;
	await result.pgFactory.initialize({
		type: "pg",
		pg: { url: process.env.PG_APP_URL ?? "" },
	});
}
