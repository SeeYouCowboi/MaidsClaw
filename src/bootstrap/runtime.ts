import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { MaidenDecisionLog } from "../agents/maiden/decision-log.js";
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
import {
	loadAuthConfig,
	loadRuntimeConfig,
	resolveProviderCredential,
} from "../core/config.js";
import type { AuthConfig, RuntimeConfig } from "../core/config-schema.js";
import { createLogger } from "../core/logger.js";
import { bootstrapRegistry } from "../core/models/bootstrap.js";
import {
	BUILT_IN_PROVIDERS,
	mergeProviderOverrides,
} from "../core/models/provider-catalog.js";
import { loadProviderOverrides } from "../core/models/provider-overrides-loader.js";
import type { ProviderCatalogEntry } from "../core/models/provider-types.js";
import { PromptBuilder } from "../core/prompt-builder.js";
import {
	BlackboardOperationalDataSource,
	LoreAdapter,
	PersonaAdapter,
} from "../core/prompt-data-adapters/index.js";
import type { GatewayTokenSnapshot } from "../gateway/auth.js";
import { MemoryAdapter } from "../core/prompt-data-adapters/memory-adapter.js";
import { PromptRenderer } from "../core/prompt-renderer.js";
import { ToolExecutor } from "../core/tools/tool-executor.js";
import type {
	GatewayContext,
	ProviderCatalogListResponse,
	ProviderCatalogService,
} from "../gateway/context.js";
import { CommitService } from "../interaction/commit-service.js";
import type {
	InteractionRecord,
	TurnSettlementPayload,
} from "../interaction/contracts.js";
import { FlushSelector } from "../interaction/flush-selector.js";
import type { InteractionStore } from "../interaction/store.js";
import type { DurableJobStore } from "../jobs/durable-store.js";
import {
	createJobQueryService,
	type JobQueryService,
} from "../jobs/job-query-service.js";
import { createJobPersistence } from "../jobs/job-persistence-factory.js";
import type { JobPersistence } from "../jobs/persistence.js";
import { bootstrapPgJobsSchema } from "../jobs/pg-schema.js";
import { PgJobStore } from "../jobs/pg-store.js";
import { createLoreAdminService } from "../lore/admin-service.js";
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
import { DeterministicQueryPlanBuilder } from "../memory/query-plan-builder.js";
import { RuleBasedQueryRouter } from "../memory/query-router.js";
import { RetrievalOrchestrator } from "../memory/retrieval/retrieval-orchestrator.js";
import { RetrievalService } from "../memory/retrieval.js";
import type { SettlementLedger } from "../memory/settlement-ledger.js";
import { GraphStorageService } from "../memory/storage.js";
import {
	MemoryTaskAgent,
	type MemoryTaskModelProvider,
} from "../memory/task-agent.js";
import { registerMemoryTools } from "../memory/tools.js";
import { createPersonaAdminService } from "../persona/admin-service.js";
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

function formatConfigErrors(
	errors: Array<{ field: string; message: string }>,
): string {
	return errors.map((error) => `${error.field}: ${error.message}`).join("; ");
}

function isSensitiveHeaderName(headerName: string): boolean {
	const normalized = headerName.replace(/[\s_-]/g, "").toLowerCase();
	return (
		normalized === "authorization" ||
		normalized === "apikey" ||
		normalized === "accesstoken" ||
		normalized === "token"
	);
}

function sanitizeExtraHeaders(
	extraHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!extraHeaders) {
		return undefined;
	}

	const sanitizedEntries = Object.entries(extraHeaders).map(([key, value]) => {
		if (isSensitiveHeaderName(key)) {
			return [key, "[REDACTED]"] as const;
		}
		return [key, value] as const;
	});

	if (sanitizedEntries.length === 0) {
		return undefined;
	}

	return Object.fromEntries(sanitizedEntries);
}

function toProviderCatalogEntryView(
	entry: ProviderCatalogEntry,
	auth: AuthConfig,
): ProviderCatalogListResponse["providers"][number] {
	const configured = resolveProviderCredential(entry.id, auth) !== null;
	const extraHeaders = sanitizeExtraHeaders(entry.extraHeaders);

	return {
		id: entry.id,
		display_name: entry.displayName,
		transport_family: entry.transportFamily,
		api_kind: entry.apiKind,
		risk_tier: entry.riskTier,
		base_url: entry.baseUrl,
		auth_modes: [...entry.authModes],
		selection_policy: {
			enabled_by_default: entry.selectionPolicy.enabledByDefault,
			eligible_for_auto_fallback: entry.selectionPolicy.eligibleForAutoFallback,
			is_auto_default: entry.selectionPolicy.isAutoDefault,
		},
		...(entry.defaultChatModelId
			? { default_chat_model_id: entry.defaultChatModelId }
			: {}),
		...(entry.defaultEmbeddingModelId
			? { default_embedding_model_id: entry.defaultEmbeddingModelId }
			: {}),
		models: entry.models.map((model) => ({
			id: model.id,
			display_name: model.displayName,
			context_window: model.contextWindow,
			max_output_tokens: model.maxOutputTokens,
			supports_tools: model.supportsTools,
			supports_vision: model.supportsVision,
			supports_embedding: model.supportsEmbedding,
		})),
		...(entry.warningMessage ? { warning_message: entry.warningMessage } : {}),
		...(entry.supportsStreamingUsage !== undefined
			? { supports_streaming_usage: entry.supportsStreamingUsage }
			: {}),
		...(entry.disableToolChoiceRequired !== undefined
			? { disable_tool_choice_required: entry.disableToolChoiceRequired }
			: {}),
		...(entry.embeddingDimensions !== undefined
			? { embedding_dimensions: entry.embeddingDimensions }
			: {}),
		...(extraHeaders ? { extra_headers: extraHeaders } : {}),
		configured,
	};
}

class RuntimeProviderCatalogService implements ProviderCatalogService {
	private readonly providers: ReadonlyArray<ProviderCatalogEntry>;
	private readonly auth: AuthConfig;

	constructor(
		providers: ReadonlyArray<ProviderCatalogEntry>,
		auth: AuthConfig,
	) {
		this.providers = providers;
		this.auth = auth;
	}

	async listProviders(): Promise<ProviderCatalogListResponse> {
		return {
			providers: this.providers.map((entry) =>
				toProviderCatalogEntryView(entry, this.auth),
			),
		};
	}
}

export function createProviderCatalogService(options: {
	auth: AuthConfig;
	providerOverrides: ProviderCatalogEntry[];
}): ProviderCatalogService {
	const providers = mergeProviderOverrides(
		BUILT_IN_PROVIDERS,
		options.providerOverrides,
	);
	return new RuntimeProviderCatalogService(providers, options.auth);
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
			return settlementLedgerRepo.markApplying(
				settlementId,
				agentId,
				payloadHash,
			);
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
			return settlementLedgerRepo.markFailedTerminal(
				settlementId,
				errorMessage,
			);
		},
		markTalkerCommitted(settlementId: string, agentId: string) {
			return settlementLedgerRepo.markTalkerCommitted(settlementId, agentId);
		},
		markThinkerProjecting(settlementId: string, agentId: string) {
			return settlementLedgerRepo.markThinkerProjecting(settlementId, agentId);
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

	// Load runtime config (from options or config/runtime.json)
	const runtimeConfigResult = options.runtimeConfig
		? { ok: true as const, runtime: options.runtimeConfig }
		: loadRuntimeConfig({ cwd: runtimeCwd });
	const runtimeConfig: RuntimeConfig = runtimeConfigResult.ok
		? runtimeConfigResult.runtime
		: {};
	const authConfigResult = loadAuthConfig({ cwd: runtimeCwd });
	if (!authConfigResult.ok) {
		throw new Error(
			`Failed to load auth config: ${formatConfigErrors(authConfigResult.errors)}`,
		);
	}
	const authConfig = authConfigResult.auth;
	const providerOverrides = loadProviderOverrides({ cwd: runtimeCwd });
	const thinkerGlobalConcurrencyCap =
		runtimeConfig.talkerThinker?.globalConcurrencyCap;

	const resolvedJobPersistence: JobPersistence =
		options.jobPersistence ??
		createJobPersistence("pg", {
			pgFactory,
		});

	// Extract talkerThinker config with defaults
	const talkerThinkerConfig = runtimeConfig.talkerThinker ?? {
		enabled: false,
		stalenessThreshold: 2,
		softBlockTimeoutMs: 3000,
		softBlockPollIntervalMs: 500,
	};
	const runtimeConfigSnapshot: RuntimeConfig = {
		...runtimeConfig,
		talkerThinker: {
			enabled: talkerThinkerConfig.enabled,
			stalenessThreshold: talkerThinkerConfig.stalenessThreshold,
			softBlockTimeoutMs: talkerThinkerConfig.softBlockTimeoutMs,
			softBlockPollIntervalMs: talkerThinkerConfig.softBlockPollIntervalMs,
			...(typeof thinkerGlobalConcurrencyCap === "number"
				? { globalConcurrencyCap: thinkerGlobalConcurrencyCap }
				: {}),
		},
	};

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
	const modelRegistry =
		options.modelRegistry ??
		bootstrapRegistry({
			auth: authConfig,
			providerOverrides,
		});
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
	// Initialize CJK segmenter + load shared aliases as a user dictionary.
	// Fire-and-forget: bootstrapRuntime is synchronous, and any queries that
	// arrive before the sync completes will use the default jieba dictionary,
	// which already handles common Chinese proper nouns. Shared aliases that
	// are NOT in the default dict (e.g. fictional names) may fail to segment
	// as a single token during this cold window — acceptable for v1 since the
	// tokenizer still produces usable tokens via either jieba's fallback or
	// the legacy bigram path. Failures log once; the rest of bootstrap
	// continues with an un-synced segmenter.
	//
	// `segmenterReady` is exposed on RuntimeBootstrapResult so callers that
	// want strict ordering (e.g. HTTP host before opening its listener) can
	// `await result.segmenterReady`. Default behavior remains fire-and-forget.
	const bootstrapLogger = createLogger({
		name: "bootstrap.runtime",
		level: "debug",
	});
	const segmenterReady = aliasService
		.syncSharedAliasesToSegmenter()
		.catch((err) => {
			bootstrapLogger.debug("cjk_segmenter_sync_failed", {
				event: "cjk_segmenter_sync_failed",
				error: err instanceof Error ? (err.stack ?? err.message) : String(err),
			});
		});
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
		episodeRepository: episodeRepo,
		episodeSearchFn: async (query, agentId, limit) =>
			searchProjectionRepo.searchEpisode(query, agentId, limit),
	});
	// GAP-4 query understanding stack (Phase 1: router, Phase 2: plan builder,
	// Phase 3: plan-driven retrieval budget reallocation). Both are shared
	// between RetrievalService and GraphNavigator so the same instances power
	// both entry points.
	//   - MAIDSCLAW_QUERY_ROUTER_SHADOW=0 disables the router entirely.
	//   - MAIDSCLAW_QUERY_PLAN_SHADOW=0 disables plan construction.
	//   - MAIDSCLAW_RETRIEVAL_USE_PLAN=off disables plan consumption inside
	//     the orchestrator (falls back to the legacy template path).
	const queryRouterEnabled = process.env.MAIDSCLAW_QUERY_ROUTER_SHADOW !== "0";
	const queryRouter = queryRouterEnabled
		? new RuleBasedQueryRouter(aliasService)
		: undefined;
	const queryPlanBuilderEnabled =
		process.env.MAIDSCLAW_QUERY_PLAN_SHADOW !== "0";
	const queryPlanBuilder = queryPlanBuilderEnabled
		? new DeterministicQueryPlanBuilder()
		: undefined;
	const retrievalService = new RetrievalService({
		retrievalRepo: pgRetrievalReadRepo,
		embeddingService,
		narrativeSearch: narrativeSearchService,
		cognitionSearch: cognitionSearchService,
		orchestrator: retrievalOrchestrator,
		queryRouter,
		queryPlanBuilder,
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
	// queryRouter + queryPlanBuilder are created above, shared with RetrievalService.
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
		queryRouter,
		queryPlanBuilder,
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
							upsertRelation: (params) =>
								pgRelationWriteRepo.upsertRelation(params),
						},
						cognitionProjectionRepo: {
							getCurrent: (agentId, cognitionKey) =>
								cognitionProjectionRepo.getCurrent(agentId, cognitionKey),
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

	const maidenDecisionLog = new MaidenDecisionLog();

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
		talkerThinkerConfig,
		resolvedJobPersistence,
		maidenDecisionLog,
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
					talkerThinkerConfig.enabled
						? {
								get sql() {
									return resolvePgPool();
								},
								jobPersistence: resolvedJobPersistence,
								settlementLedger,
							}
						: undefined,
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

	const providerCatalogService = createProviderCatalogService({
		auth: authConfig,
		providerOverrides,
	});

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
		projectionManager,
		interactionRepo,
		coreMemoryBlockRepo,
		recentCognitionSlotRepo,
		sharedBlockRepo,
		jobPersistence: resolvedJobPersistence,
		thinkerGlobalConcurrencyCap,
		talkerThinkerConfig,
		maidenDecisionLog,
		shutdown,
		segmenterReady,
		providerCatalogService,
		runtimeCwd,
		runtimeConfigSnapshot,
		authConfigSnapshot: authConfig,
		coreMemoryService,
		episodeRepo,
		settlementLedgerRepo,
		areaWorldProjectionRepo,
	};
}

function toGatewayTokenSnapshot(auth: AuthConfig): GatewayTokenSnapshot {
	return {
		tokens: (auth.gateway?.tokens ?? []).map((token) => ({
			id: token.id,
			token: token.token,
			scopes: [...token.scopes],
			...(typeof token.disabled === "boolean"
				? { disabled: token.disabled }
				: {}),
		})),
	};
}

function getDurableStore(
	runtime: RuntimeBootstrapResult,
): DurableJobStore | undefined {
	const store = (
		runtime.pgFactory as (PgBackendFactory & { store?: DurableJobStore }) | null
	)?.store;
	return store;
}

function buildSettlementRepoService(
	runtime: RuntimeBootstrapResult,
): GatewayContext["settlementRepo"] {
	if (!runtime.pgFactory) {
		return undefined;
	}

	return {
		async listByAgent(agentId: string, options?: { limit?: number }) {
			const sql = runtime.pgFactory?.getPool();
			if (!sql) {
				return [];
			}
			const limit = Math.max(1, Math.min(200, options?.limit ?? 50));
			const rows = await sql`
				SELECT settlement_id, status, attempt_count, payload_hash,
				       claimed_by, claimed_at, applied_at, error_message,
				       created_at, updated_at
				FROM settlement_processing_ledger
				WHERE agent_id = ${agentId}
				ORDER BY updated_at DESC, settlement_id DESC
				LIMIT ${limit}
			`;
			return rows.map((row) => ({
				settlement_id: String(row.settlement_id),
				status: String(row.status),
				attempt_count: Number(row.attempt_count),
				payload_hash:
					typeof row.payload_hash === "string" ? row.payload_hash : undefined,
				claimed_by:
					typeof row.claimed_by === "string" ? row.claimed_by : undefined,
				claimed_at:
					typeof row.claimed_at === "number"
						? row.claimed_at
						: row.claimed_at === null || row.claimed_at === undefined
							? undefined
							: Number(row.claimed_at),
				applied_at:
					typeof row.applied_at === "number"
						? row.applied_at
						: row.applied_at === null || row.applied_at === undefined
							? undefined
							: Number(row.applied_at),
				error_message:
					typeof row.error_message === "string" ? row.error_message : undefined,
				created_at: Number(row.created_at),
				updated_at: Number(row.updated_at),
			}));
		},
	};
}

function buildAreaWorldProjectionService(
	runtime: RuntimeBootstrapResult,
): GatewayContext["areaWorldProjection"] {
	if (!runtime.pgFactory) {
		return undefined;
	}

	return {
		async listByAgent(agentId: string) {
			const sql = runtime.pgFactory?.getPool();
			if (!sql) {
				return [];
			}

			const areaRows = await sql`
				SELECT area_id, summary_text, updated_at
				FROM area_narrative_current
				WHERE agent_id = ${agentId}
			`;

			const worldRows = await sql`
				SELECT summary_text, updated_at
				FROM world_narrative_current
				WHERE id = 1
			`;

			const items: Array<Record<string, unknown>> = [];
			for (const row of worldRows) {
				items.push({
					scope: "world",
					summary_text: String(row.summary_text),
					updated_at: Number(row.updated_at),
				});
			}
			for (const row of areaRows) {
				items.push({
					scope: "area",
					area_id: Number(row.area_id),
					summary_text: String(row.summary_text),
					updated_at: Number(row.updated_at),
				});
			}

			return items;
		},
	};
}

/**
 * Single seam for wiring optional gateway domain services from runtime.
 *
 * Keep all Phase A-D services optional so lightweight/local tests stay minimal,
 * and attach concrete implementations here as each service lands.
 */
export function buildGatewayRuntimeContextExtensions(
	runtime: RuntimeBootstrapResult,
): Pick<
	GatewayContext,
	| "providerCatalog"
	| "personaAdmin"
	| "loreAdmin"
	| "jobQueryService"
	| "blackboard"
	| "coreMemory"
	| "episodeRepo"
	| "settlementRepo"
	| "areaWorldProjection"
	| "decisionLog"
	| "getAuthSnapshot"
	| "getRuntimeSnapshot"
> {
	const runtimeCwd =
		typeof runtime.runtimeCwd === "string" ? runtime.runtimeCwd : undefined;

	const personaAdmin = runtimeCwd
		? createPersonaAdminService({
				configPath: join(runtimeCwd, "config", "personas.json"),
				agentConfigPath: join(runtimeCwd, "config", "agents.json"),
			})
		: undefined;

	const loreAdmin = runtimeCwd
		? createLoreAdminService({
				configPath: join(runtimeCwd, "config", "lore.json"),
			})
		: undefined;

	const durableStore = getDurableStore(runtime);
	const jobQueryService: JobQueryService | undefined = durableStore
		? createJobQueryService(durableStore)
		: undefined;

	const episodeRepo: GatewayContext["episodeRepo"] = runtime.episodeRepo
		? {
				async listByAgent(
					agentId: string,
					options?: { since?: number; limit?: number },
				) {
					const rows = await runtime.episodeRepo.readByAgent(
						agentId,
						options?.limit,
					);
					const since = options?.since;
					if (typeof since === "number") {
						return rows.filter((row) => row.created_at >= since);
					}
					return rows;
				},
			}
		: undefined;

	const settlementRepo = buildSettlementRepoService(runtime);
	const areaWorldProjection = buildAreaWorldProjectionService(runtime);

	const getAuthSnapshot =
		typeof runtime.authConfigSnapshot === "object" && runtime.authConfigSnapshot
			? () => {
					if (runtimeCwd) {
						const reloaded = loadAuthConfig({ cwd: runtimeCwd });
						if (reloaded.ok) {
							return toGatewayTokenSnapshot(reloaded.auth);
						}
					}
					return toGatewayTokenSnapshot(runtime.authConfigSnapshot);
				}
			: undefined;

	const getRuntimeSnapshot =
		typeof runtime.runtimeConfigSnapshot === "object" &&
		runtime.runtimeConfigSnapshot
			? () => {
					if (runtimeCwd) {
						const reloaded = loadRuntimeConfig({ cwd: runtimeCwd });
						if (reloaded.ok) {
							return reloaded.runtime;
						}
					}
					return runtime.runtimeConfigSnapshot;
				}
			: undefined;

	return {
		providerCatalog: runtime.providerCatalogService,
		personaAdmin,
		loreAdmin,
		jobQueryService,
		blackboard: runtime.blackboard,
		coreMemory: runtime.coreMemoryService,
		episodeRepo,
		settlementRepo,
		areaWorldProjection,
		decisionLog: runtime.maidenDecisionLog,
		getAuthSnapshot,
		getRuntimeSnapshot,
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

	const pgFactoryWithStore = result.pgFactory as PgBackendFactory & {
		store?: DurableJobStore;
	};
	if (!pgFactoryWithStore.store) {
		let pool: ReturnType<PgBackendFactory["getPool"]> | null = null;
		try {
			pool = result.pgFactory.getPool();
		} catch {
			pool = null;
		}

		if (pool) {
			await bootstrapPgJobsSchema(pool);
			pgFactoryWithStore.store = new PgJobStore(
				pool,
				typeof result.thinkerGlobalConcurrencyCap === "number"
					? {
							thinkerGlobalConcurrencyCap: result.thinkerGlobalConcurrencyCap,
						}
					: undefined,
			);
		}
	}
}
