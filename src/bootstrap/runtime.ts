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
import type { MemoryDataSource } from "../core/prompt-data-sources.js";
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
import { CoreMemoryService } from "../memory/core-memory.js";
import { registerMemoryTools } from "../memory/tools.js";
import type { RetrievalService } from "../memory/retrieval.js";
import { EmbeddingService } from "../memory/embeddings.js";
import { MaterializationService } from "../memory/materialization.js";
import { MemoryTaskModelProviderAdapter } from "../memory/model-provider-adapter.js";
import { PendingSettlementSweeper } from "../memory/pending-settlement-sweeper.js";
import { PgTransactionBatcher } from "../memory/pg-transaction-batcher.js";
import { ProjectionManager } from "../memory/projection/projection-manager.js";
import {
	getAttachedSharedBlocksAsync,
	getPinnedBlocksAsync,
	getRecentCognitionAsync,
	getSharedBlocksAsync,
} from "../memory/prompt-data.js";
import { PublicationRecoverySweeper } from "../memory/publication-recovery-sweeper.js";
import type { SettlementLedger } from "../memory/settlement-ledger.js";
import { GraphStorageService } from "../memory/storage.js";
import {
	MemoryTaskAgent,
	type MemoryTaskDbAdapter,
	type MemoryTaskModelProvider,
} from "../memory/task-agent.js";
import { PersonaLoader } from "../persona/loader.js";
import { PersonaService } from "../persona/service.js";
import type { RpBufferedExecutionResult } from "../runtime/rp-turn-contract.js";
import { TurnService } from "../runtime/turn-service.js";
import { resolveViewerContext } from "../runtime/viewer-context-resolver.js";
import { SessionService } from "../session/service.js";
import { Blackboard } from "../state/blackboard.js";
import { PgBackendFactory } from "../storage/backend-types.js";
import type { Db } from "../storage/db-types.js";
import type { SettlementLedgerRepo } from "../storage/domain-repos/contracts/settlement-ledger-repo.js";
import { PgAreaWorldProjectionRepo } from "../storage/domain-repos/pg/area-world-projection-repo.js";
import { PgCognitionEventRepo } from "../storage/domain-repos/pg/cognition-event-repo.js";
import { PgCognitionProjectionRepo } from "../storage/domain-repos/pg/cognition-projection-repo.js";
import { PgCoreMemoryBlockRepo } from "../storage/domain-repos/pg/core-memory-block-repo.js";
import { PgEmbeddingRepo } from "../storage/domain-repos/pg/embedding-repo.js";
import { PgEpisodeRepo } from "../storage/domain-repos/pg/episode-repo.js";
import { PgGraphMutableStoreRepo } from "../storage/domain-repos/pg/graph-mutable-store-repo.js";
import { PgInteractionRepo } from "../storage/domain-repos/pg/interaction-repo.js";
import { PgNodeScoreRepo } from "../storage/domain-repos/pg/node-score-repo.js";
import { PgNodeScoringQueryRepo } from "../storage/domain-repos/pg/node-scoring-query-repo.js";
import { PgPendingFlushRecoveryRepo } from "../storage/domain-repos/pg/pending-flush-recovery-repo.js";
import { PgPromotionQueryRepo } from "../storage/domain-repos/pg/promotion-query-repo.js";
import { PgRecentCognitionSlotRepo } from "../storage/domain-repos/pg/recent-cognition-slot-repo.js";
import { PgSearchProjectionRepo } from "../storage/domain-repos/pg/search-projection-repo.js";
import { PgSemanticEdgeRepo } from "../storage/domain-repos/pg/semantic-edge-repo.js";
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

const throwingMemoryDbAdapter: MemoryTaskDbAdapter = {
	exec(sql: string): void {
		throw new Error(
			`[ThrowingMemoryTaskDbAdapter] Legacy SQLite path not supported in PG runtime: exec("${sql}")`,
		);
	},
	prepare(sql: string) {
		throw new Error(
			`[ThrowingMemoryTaskDbAdapter] Legacy SQLite path not supported in PG runtime: prepare("${sql}")`,
		);
	},
};

const throwingLegacyDbAdapter: Db = {
	raw: null,
	exec(sql: string): void {
		throwingMemoryDbAdapter.exec(sql);
	},
	query<T = Record<string, unknown>>(sql: string, _params?: unknown[]): T[] {
		throw new Error(
			`[ThrowingMemoryTaskDbAdapter] Legacy SQLite path not supported in PG runtime: query("${sql}")`,
		);
	},
	run(
		sql: string,
		_params?: unknown[],
	): { changes: number; lastInsertRowid: number | bigint } {
		throw new Error(
			`[ThrowingMemoryTaskDbAdapter] Legacy SQLite path not supported in PG runtime: run("${sql}")`,
		);
	},
	get<T = Record<string, unknown>>(
		sql: string,
		_params?: unknown[],
	): T | undefined {
		throw new Error(
			`[ThrowingMemoryTaskDbAdapter] Legacy SQLite path not supported in PG runtime: get("${sql}")`,
		);
	},
	close(): void {
		throw new Error(
			"[ThrowingMemoryTaskDbAdapter] Legacy SQLite path not supported in PG runtime: close()",
		);
	},
	transaction<T>(_fn: () => T): T {
		throw new Error(
			"[ThrowingMemoryTaskDbAdapter] Legacy SQLite path not supported in PG runtime: transaction(fn)",
		);
	},
	prepare(sql: string): {
		run(...params: unknown[]): {
			changes: number;
			lastInsertRowid: number | bigint;
		};
		all(...params: unknown[]): unknown[];
		get(...params: unknown[]): unknown;
	} {
		void sql;
		return throwingMemoryDbAdapter.prepare(sql);
	},
};

function resolveSettledNow<T>(value: Promise<T> | T, context: string): T {
	if (!(value instanceof Promise)) {
		return value;
	}
	const settled = Bun.peek(value);
	if (settled instanceof Promise) {
		throw new Error(
			`[bootstrap/runtime] ${context} returned unresolved async result in sync bridge`,
		);
	}
	return settled as T;
}

function createSettlementLedgerAdapter(
	settlementLedgerRepo: SettlementLedgerRepo,
): SettlementLedger {
	return {
		check(settlementId: string) {
			return resolveSettledNow(
				settlementLedgerRepo.check(settlementId),
				"settlementLedger.check",
			);
		},
		rawStatus(settlementId: string) {
			return resolveSettledNow(
				settlementLedgerRepo.rawStatus(settlementId),
				"settlementLedger.rawStatus",
			);
		},
		markPending(settlementId: string, agentId: string) {
			resolveSettledNow(
				settlementLedgerRepo.markPending(settlementId, agentId),
				"settlementLedger.markPending",
			);
		},
		markClaimed(settlementId: string, claimedBy: string) {
			resolveSettledNow(
				settlementLedgerRepo.markClaimed(settlementId, claimedBy),
				"settlementLedger.markClaimed",
			);
		},
		markApplying(settlementId: string, agentId: string, payloadHash?: string) {
			resolveSettledNow(
				settlementLedgerRepo.markApplying(settlementId, agentId, payloadHash),
				"settlementLedger.markApplying",
			);
		},
		markApplied(settlementId: string) {
			resolveSettledNow(
				settlementLedgerRepo.markApplied(settlementId),
				"settlementLedger.markApplied",
			);
		},
		markReplayedNoop(settlementId: string) {
			resolveSettledNow(
				settlementLedgerRepo.markReplayedNoop(settlementId),
				"settlementLedger.markReplayedNoop",
			);
		},
		markConflict(settlementId: string, errorMessage: string) {
			resolveSettledNow(
				settlementLedgerRepo.markConflict(settlementId, errorMessage),
				"settlementLedger.markConflict",
			);
		},
		markFailed(settlementId: string, errorMessage: string, retryable: boolean) {
			if (retryable) {
				resolveSettledNow(
					settlementLedgerRepo.markFailedRetryScheduled(
						settlementId,
						errorMessage,
					),
					"settlementLedger.markFailedRetryScheduled",
				);
				return;
			}
			resolveSettledNow(
				settlementLedgerRepo.markFailedTerminal(settlementId, errorMessage),
				"settlementLedger.markFailedTerminal",
			);
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

	const sessionService = options.sessionService ?? new SessionService();
	const blackboard = options.blackboard ?? new Blackboard();
	const agentRegistry = buildAgentRegistry(options, runtimeCwd);
	const modelRegistry = options.modelRegistry ?? bootstrapRegistry();
	const toolExecutor = options.toolExecutor ?? new ToolExecutor();
	const resolvePgPool = () => pgFactory.getPool();

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
			console.error("[memoryPipelineStatus] embedding model unavailable:", error);
			return "embedding_model_unavailable";
		}

		if (effectiveOrganizerEmbeddingModelId) {
			try {
				modelRegistry.resolveEmbedding(effectiveOrganizerEmbeddingModelId);
			} catch (error) {
				console.error("[memoryPipelineStatus] organizer embedding model unavailable:", error);
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
	const memoryAdapter: MemoryDataSource = {
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
	const coreMemoryService = new CoreMemoryService(throwingLegacyDbAdapter);

	{
		// RetrievalService is not yet wired in PG bootstrap runtime.
		// Tools that depend on it (cognition_search, memory_explore, narrative_search)
		// are registered for schema visibility but will return an error if called
		// before RetrievalService is available. This is an intentional deferral,
		// not an "unimplemented" stub.
		const lazyRetrieval = createLazyPgRepo<RetrievalService>(
			() => {
				throw new Error(
					"RetrievalService is not yet available in this runtime configuration",
				);
			},
		);
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
							return memTool.handler(
								params as Record<string, unknown>,
								vc,
							);
						},
					});
				},
			},
			{
				coreMemory: coreMemoryService,
				retrieval: lazyRetrieval,
			},
		);
	}

	const embeddingService = new EmbeddingService(
		embeddingRepo,
		new PgTransactionBatcher(),
	);
	const materializationService = new MaterializationService(
		throwingLegacyDbAdapter,
		graphStorageService,
		promotionQueryRepo,
		undefined,
	);
	const settlementLedger = createSettlementLedgerAdapter(settlementLedgerRepo);
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
	const memoryTaskAgent = memoryEmbeddingModelId
		? new MemoryTaskAgent(
				{ db: throwingMemoryDbAdapter },
				graphStorageService,
				coreMemoryService,
				embeddingService,
				materializationService,
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
			? new PublicationRecoverySweeper(
					throwingLegacyDbAdapter,
					graphStorageService,
					undefined,
				)
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
