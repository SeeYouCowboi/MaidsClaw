import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { ProjectionManager } from "../../src/memory/projection/projection-manager.js";
import {
	materializeRelationIntents,
	resolveConflictFactors,
	type ResolvedLocalRefs,
} from "../../src/memory/cognition/relation-intent-resolver.js";
import { applyContestConflictFactors } from "../../src/memory/cognition/contest-conflict-applicator.js";
import { RelationBuilder } from "../../src/memory/cognition/relation-builder.js";
import { enqueueOrganizerJobs } from "../../src/memory/organize-enqueue.js";
import { PgSettlementLedgerRepo } from "../../src/storage/domain-repos/pg/settlement-ledger-repo.js";
import { PgEpisodeRepo } from "../../src/storage/domain-repos/pg/episode-repo.js";
import { PgCognitionEventRepo } from "../../src/storage/domain-repos/pg/cognition-event-repo.js";
import { PgCognitionProjectionRepo } from "../../src/storage/domain-repos/pg/cognition-projection-repo.js";
import { PgAreaWorldProjectionRepo } from "../../src/storage/domain-repos/pg/area-world-projection-repo.js";
import { PgSearchProjectionRepo } from "../../src/storage/domain-repos/pg/search-projection-repo.js";
import { PgRelationWriteRepo } from "../../src/storage/domain-repos/pg/relation-write-repo.js";
import { PgGraphMutableStoreRepo } from "../../src/storage/domain-repos/pg/graph-mutable-store-repo.js";
import { PgUnresolvedWorldStateOpsRepo } from "../../src/storage/domain-repos/pg/unresolved-world-state-ops-repo.js";
import { PgSettlementUnitOfWork } from "../../src/storage/pg-settlement-uow.js";
import {
	createThinkerWorker,
	THINKER_RELATION_AND_CONFLICT_INSTRUCTIONS,
	type ThinkerWorkerDeps,
} from "../../src/runtime/thinker-worker.js";
import type { TurnSettlementPayload } from "../../src/interaction/contracts.js";
import { ExplicitSettlementProcessor } from "../../src/memory/explicit-settlement-processor.js";
import { CognitionRepository } from "../../src/memory/cognition/cognition-repo.js";
import type { CognitionCurrentRow } from "../../src/memory/cognition/private-cognition-current.js";
import type { AgentLoop } from "../../src/core/agent-loop.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import type { AgentProfile } from "../../src/agents/profile.js";
import type {
	InteractionRepo,
	InteractionTransactionContext,
} from "../../src/storage/domain-repos/contracts/interaction-repo.js";
import type { RecentCognitionSlotRepo } from "../../src/storage/domain-repos/contracts/recent-cognition-slot-repo.js";
import type { CognitionThinkerJobPayload } from "../../src/jobs/durable-store.js";
import { PgRecentCognitionSlotRepo } from "../../src/storage/domain-repos/pg/recent-cognition-slot-repo.js";
import type { SettlementProjectionParams } from "../../src/memory/projection/projection-manager.js";
import type { NodeRef } from "../../src/memory/types.js";
import type { JobPersistence, JobEntry } from "../../src/jobs/persistence.js";
import {
	createPgTestDb,
	type PgTestDb,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

const AGENT_ID = "rp:alice";

function makeTestSettlementPayload(
	overrides: Partial<SettlementProjectionParams> & { settlementId: string; sessionId: string },
): SettlementProjectionParams {
	return {
		agentId: AGENT_ID,
		cognitionOps: [
			{
				op: "upsert",
				record: {
					kind: "assertion",
					key: `test:belief:${overrides.settlementId}`,
					holderId: { kind: "special", value: "self" },
					claim: "trusts",
					entityRefs: [
						{ kind: "special", value: "self" },
						{ kind: "special", value: "user" },
					],
					stance: "accepted",
					basis: "first_hand",
				},
			},
		],
		privateEpisodes: [
			{
				category: "observation",
				summary: `episode for ${overrides.settlementId}`,
				localRef: `ep:${overrides.settlementId}`,
			},
		],
		publications: [],
		viewerSnapshot: { currentLocationEntityId: 42 },
		recentCognitionSlotJson: JSON.stringify([]),
		committedAt: 1_700_000_000_000,
		...overrides,
	};
}

function createMockJobPersistence(): JobPersistence & { enqueuedJobs: Array<Omit<JobEntry, "attemptCount" | "createdAt" | "updatedAt">> } {
	const enqueuedJobs: Array<Omit<JobEntry, "attemptCount" | "createdAt" | "updatedAt">> = [];
	return {
		enqueuedJobs,
		async enqueue(entry) {
			enqueuedJobs.push(entry);
		},
		async claim() { return false; },
		async complete() {},
		async fail() {},
		async retry() { return false; },
		async listPending() { return []; },
		async listRetryable() { return []; },
		async countByStatus() { return 0; },
	};
}

function createMockInteractionRepo(
	sessionId: string,
	requestId: string,
	payloadOverrides: Partial<TurnSettlementPayload> = {},
): InteractionRepo {
	const repo: InteractionRepo = {
		async getSettlementPayload(inputSessionId, inputRequestId) {
			if (inputSessionId !== sessionId || inputRequestId !== requestId) {
				return undefined;
			}
			return {
				settlementId: `stl:${inputRequestId}`,
				requestId: inputRequestId,
				sessionId: inputSessionId,
				ownerAgentId: AGENT_ID,
				publicReply: "Hello from test",
				hasPublicReply: true,
				viewerSnapshot: {
					selfPointerKey: "entity:self",
					userPointerKey: "entity:user",
					currentLocationEntityId: 42,
				},
				schemaVersion: "turn_settlement_v5",
				cognitiveSketch: "The user greeted me warmly.",
				...payloadOverrides,
			};
		},
		async getMessageRecords(inputSessionId) {
			if (inputSessionId !== sessionId) {
				return [];
			}
			return [
				{
					sessionId: inputSessionId,
					recordId: "rec:e2e:001",
					recordIndex: 0,
					actorType: "user",
					recordType: "message",
					payload: { role: "user", content: "Hello!" },
					committedAt: Date.now(),
				},
			];
		},
		async commit() {},
		async runInTransaction<T>(
			fn: (tx: InteractionTransactionContext) => Promise<T>,
		) {
			return fn({ interactionRepo: repo });
		},
		async settlementExists() {
			return true;
		},
		async findRecordByCorrelatedTurnId() {
			return undefined;
		},
		async findSessionIdByRequestId() {
			return sessionId;
		},
		async getBySession() {
			return [];
		},
		async getByRange() {
			return [];
		},
		async markProcessed() {},
		async markRangeProcessed() {},
		async countUnprocessedRpTurns() {
			return 0;
		},
		async getMinMaxUnprocessedIndex() {
			return undefined;
		},
		async getMaxIndex() {
			return undefined;
		},
		async getPendingSettlementJobState() {
			return null;
		},
		async countUnprocessedSettlements() {
			return 0;
		},
		async getUnprocessedSettlementRange() {
			return null;
		},
		async listStalePendingSettlementSessions() {
			return [];
		},
		async getUnprocessedRangeForSession() {
			return null;
		},
	};

	return repo;
}

async function runThinkerWorkerIntegration(opts: {
	pool: postgres.Sql;
	settlementId: string;
	requestId: string;
	sessionId: string;
	talkerTurnVersion?: number;
	settlementPayloadOverrides?: Partial<TurnSettlementPayload>;
	outcome: unknown;
	assertionCanonicalization?: ThinkerWorkerDeps["assertionCanonicalization"];
	cognitionProjectionRepo?: ThinkerWorkerDeps["cognitionProjectionRepo"];
	canonicalizationSimilarityThreshold?: number;
	sceneFactWritePath?: boolean;
	projectionManager?: ProjectionManager;
}): Promise<void> {
	const {
		pool,
		settlementId,
		requestId,
		sessionId,
		talkerTurnVersion = 1,
		settlementPayloadOverrides,
		outcome,
		assertionCanonicalization,
		cognitionProjectionRepo,
		canonicalizationSimilarityThreshold,
		sceneFactWritePath,
		projectionManager,
	} = opts;

	const ledger = new PgSettlementLedgerRepo(pool);
	await ledger.markTalkerCommitted(settlementId, AGENT_ID);
	const settlementLedgerAdapter: NonNullable<
		ThinkerWorkerDeps["settlementLedger"]
	> = {
		check: (inputSettlementId) => ledger.check(inputSettlementId),
		rawStatus: (inputSettlementId) => ledger.rawStatus(inputSettlementId),
		markPending: (inputSettlementId, inputAgentId) =>
			ledger.markPending(inputSettlementId, inputAgentId),
		markClaimed: (inputSettlementId, claimedBy) =>
			ledger.markClaimed(inputSettlementId, claimedBy),
		markApplying: (inputSettlementId, inputAgentId, payloadHash) =>
			ledger.markApplying(inputSettlementId, inputAgentId, payloadHash),
		markApplied: (inputSettlementId) => ledger.markApplied(inputSettlementId),
		markReplayedNoop: (inputSettlementId) =>
			ledger.markReplayedNoop(inputSettlementId),
		markConflict: (inputSettlementId, errorMessage) =>
			ledger.markConflict(inputSettlementId, errorMessage),
		markFailed: (inputSettlementId, errorMessage, retryable) =>
			retryable
				? ledger.markFailedRetryScheduled(inputSettlementId, errorMessage)
				: ledger.markFailedTerminal(inputSettlementId, errorMessage),
		markTalkerCommitted: (inputSettlementId, inputAgentId) =>
			ledger.markTalkerCommitted(inputSettlementId, inputAgentId),
		markThinkerProjecting: (inputSettlementId, inputAgentId) =>
			ledger.markThinkerProjecting(inputSettlementId, inputAgentId),
	};

	const runtimeProjectionManager = projectionManager ?? new ProjectionManager(
		new PgEpisodeRepo(pool),
		new PgCognitionEventRepo(pool),
		new PgCognitionProjectionRepo(pool),
		null,
		new PgAreaWorldProjectionRepo(pool),
	);

	const mockJobs = createMockJobPersistence();
	const mockInteractionRepo = createMockInteractionRepo(
		sessionId,
		requestId,
		settlementPayloadOverrides,
	);

	const mockSlotRepo: RecentCognitionSlotRepo = {
		async upsertRecentCognitionSlot() {
			return {};
		},
		async getSlotPayload() {
			return undefined;
		},
		async getBySession() {
			return undefined;
		},
		async getVersionGap() {
			return undefined;
		},
	};

	const registry = new AgentRegistry();
	const agentProfile: AgentProfile = {
		id: AGENT_ID,
		role: "rp_agent",
		lifecycle: "persistent",
		userFacing: true,
		outputMode: "freeform",
		modelId: "test-model",
		toolPermissions: [],
		maxDelegationDepth: 1,
		lorebookEnabled: true,
		narrativeContextEnabled: true,
	};
	registry.register(agentProfile);

	const mockAgentLoop = {
		async runBuffered() {
			return { outcome };
		},
	} as unknown as AgentLoop;

	const deps: ThinkerWorkerDeps = {
		sql: pool,
		projectionManager: runtimeProjectionManager,
		interactionRepo: mockInteractionRepo,
		recentCognitionSlotRepo: mockSlotRepo,
		agentRegistry: registry,
		createAgentLoop: (agentId: string) =>
			agentId === AGENT_ID ? mockAgentLoop : null,
		jobPersistence: mockJobs,
		settlementLedger: settlementLedgerAdapter,
		assertionCanonicalization,
		cognitionProjectionRepo,
		canonicalizationSimilarityThreshold,
		sceneFactWritePath: sceneFactWritePath ?? false,
	};

	const worker = createThinkerWorker(deps);
	const payload: CognitionThinkerJobPayload = {
		sessionId,
		agentId: AGENT_ID,
		settlementId,
		talkerTurnVersion,
	};

	await worker({ payload });
}

async function createSessionId(pool: postgres.Sql): Promise<string> {
	return new PgSettlementUnitOfWork(pool).run(async (repos) => {
		const session = await repos.sessionRepo.createSession(AGENT_ID);
		return session.sessionId;
	});
}

function makeCurrentAssertionRow(params: {
	id: number;
	key: string;
	holderId: string;
	claim: string;
	entityRefs: string[];
	status?: "active" | "retracted";
	stance?:
		| "hypothetical"
		| "tentative"
		| "accepted"
		| "confirmed"
		| "contested"
		| "rejected"
		| "abandoned";
	basis?: "first_hand" | "hearsay" | "inference" | "introspection" | "belief";
}): CognitionCurrentRow {
	return {
		id: params.id,
		agent_id: AGENT_ID,
		cognition_key: params.key,
		kind: "assertion",
		stance: params.stance ?? "accepted",
		basis: params.basis ?? "inference",
		status: params.status ?? "active",
		pre_contested_stance: null,
		conflict_summary: null,
		conflict_factor_refs_json: null,
		summary_text: null,
		record_json: JSON.stringify({
			holderId: { kind: "pointer_key", value: params.holderId },
			claim: params.claim,
			entityRefs: params.entityRefs.map((value) => ({
				kind: "pointer_key",
				value,
			})),
		}),
		source_event_id: params.id * 10,
		updated_at: Date.now(),
	};
}

function createMockCognitionProjectionRepo(
	rows: CognitionCurrentRow[],
): NonNullable<ThinkerWorkerDeps["cognitionProjectionRepo"]> {
	return {
		async upsertFromEvent() {},
		async rebuild() {},
		async getCurrent() {
			return null;
		},
		async getAllCurrent() {
			return rows;
		},
		async updateConflictFactors() {},
		async patchRecordJsonSourceEventRef() {},
		async resolveEntityByPointerKey() {
			return null;
		},
	};
}

function createMockAssertionCanonicalizationBundle(params: {
	neighbors: Array<{ nodeRef: string; similarity: number; nodeKind?: string }>;
	onEmbed?: () => void;
	onCosineSearch?: () => void;
}): NonNullable<ThinkerWorkerDeps["assertionCanonicalization"]> {
	return {
		embeddingRepo: {
			async upsert() {},
			async query() {
				return [];
			},
			async dimensionCheck() {
				return true;
			},
			async deleteByModel() {
				return 0;
			},
			async cosineSearch() {
				params.onCosineSearch?.();
				return params.neighbors.map((neighbor) => ({
					nodeRef: neighbor.nodeRef as NodeRef,
					similarity: neighbor.similarity,
					nodeKind: neighbor.nodeKind ?? "assertion",
				}));
			},
		},
		modelProvider: {
			defaultEmbeddingModelId: "test/embed",
			async chat() {
				return [];
			},
			async embed() {
				params.onEmbed?.();
				return [new Float32Array([0.1, 0.2, 0.3])];
			},
		},
		embeddingModelId: "test/embed",
	};
}

function makeAssertionUpsert(params: {
	key: string;
	claim: string;
	entityRefs: string[];
	stance?: "hypothetical" | "tentative" | "accepted" | "confirmed" | "contested" | "rejected" | "abandoned";
	basis?: "first_hand" | "hearsay" | "inference" | "introspection" | "belief";
	provenance?: string;
	claimedGroundingRefs?: Array<{ kind: string; ref: string }>;
	sceneFactBinding?: {
		scope: "area" | "world";
		factKey: string;
		areaId?: number;
		expectedValue: unknown;
	};
}) {
	return {
		op: "upsert",
		record: {
			kind: "assertion",
			key: params.key,
			holderId: { kind: "special", value: "self" },
			claim: params.claim,
			entityRefs: params.entityRefs.map((value) => ({
				kind: "pointer_key",
				value,
			})),
			stance: params.stance ?? "accepted",
			basis: params.basis ?? "first_hand",
			provenance: params.provenance ?? "user_stated",
			claimedGroundingRefs:
				params.claimedGroundingRefs ?? [{ kind: "user_message", ref: "request:canonical-1" }],
			...(params.sceneFactBinding
				? { sceneFactBinding: params.sceneFactBinding }
				: {}),
		},
	} as const;
}

function parseRowRecordJson(value: unknown): Record<string, unknown> {
	if (!value) {
		return {};
	}
	if (typeof value === "object") {
		return value as Record<string, unknown>;
	}
	if (typeof value === "string") {
		return JSON.parse(value) as Record<string, unknown>;
	}
	return {};
}

describe.skipIf(skipPgTests)(
	"Thinker Worker Phase 2 — PG Integration",
	() => {
		let testDb: PgTestDb | null = null;
		let pool: postgres.Sql;

		beforeAll(async () => {
			testDb = await createPgTestDb();
			pool = testDb.pool;
		});

		afterAll(async () => {
			if (testDb !== null) {
				await testDb.cleanup();
			}
		});

		it(
			"commitSettlement syncs cognition to search_docs_cognition via PgSearchProjectionRepo",
			async () => {
				const settlementId = "stl:search-sync:001";
				const uow = new PgSettlementUnitOfWork(pool);

				await uow.run(async (repos) => {
					const session = await repos.sessionRepo.createSession(AGENT_ID);
					const sessionId = session.sessionId;

					await repos.settlementLedger.markApplying(
						settlementId,
						AGENT_ID,
						"hash:search-sync",
					);

					const projectionManager = new ProjectionManager(
						new PgEpisodeRepo(pool),
						new PgCognitionEventRepo(pool),
						new PgCognitionProjectionRepo(pool),
						null,
						new PgAreaWorldProjectionRepo(pool),
					);

					const searchRepo = new PgSearchProjectionRepo(pool);

					await projectionManager.commitSettlement(
						makeTestSettlementPayload({ settlementId, sessionId }),
						{
							episodeRepo: repos.episodeRepo,
							cognitionEventRepo: repos.cognitionEventRepo,
							cognitionProjectionRepo: repos.cognitionProjectionRepo,
							areaWorldProjectionRepo: repos.areaWorldProjectionRepo,
							recentCognitionSlotRepo: repos.recentCognitionSlotRepo,
							searchProjectionRepo: searchRepo,
						},
					);

					const rows = await pool`
						SELECT id, source_ref, content, kind, stance, basis
						FROM search_docs_cognition
						WHERE agent_id = ${AGENT_ID}
						  AND source_ref LIKE ${"assertion:%"}
					`;
					expect(rows.length).toBeGreaterThanOrEqual(1);

					const doc = rows.find(
						(r: Record<string, unknown>) =>
							typeof r.content === "string" &&
							r.content.includes("trusts"),
					);
					expect(doc).toBeDefined();
					expect(doc!.kind).toBe("assertion");
					expect(doc!.stance).toBe("accepted");
					expect(doc!.basis).toBe("first_hand");
				});
			},
			20_000,
		);

		it(
			"commitSettlement returns changedNodeRefs containing episode + cognition refs",
			async () => {
				const settlementId = "stl:changed-refs:001";
				const uow = new PgSettlementUnitOfWork(pool);

				await uow.run(async (repos) => {
					const session = await repos.sessionRepo.createSession(AGENT_ID);
					const sessionId = session.sessionId;

					await repos.settlementLedger.markApplying(
						settlementId,
						AGENT_ID,
						"hash:changed-refs",
					);

					const projectionManager = new ProjectionManager(
						new PgEpisodeRepo(pool),
						new PgCognitionEventRepo(pool),
						new PgCognitionProjectionRepo(pool),
						null,
						new PgAreaWorldProjectionRepo(pool),
					);

					const result = await projectionManager.commitSettlement(
						makeTestSettlementPayload({ settlementId, sessionId }),
						{
							episodeRepo: repos.episodeRepo,
							cognitionEventRepo: repos.cognitionEventRepo,
							cognitionProjectionRepo: repos.cognitionProjectionRepo,
							areaWorldProjectionRepo: repos.areaWorldProjectionRepo,
							recentCognitionSlotRepo: repos.recentCognitionSlotRepo,
						},
					);

					expect(Array.isArray(result.changedNodeRefs)).toBe(true);
					expect(result.changedNodeRefs.length).toBe(2);

					const episodeRef = result.changedNodeRefs.find((r) =>
						r.startsWith("episode:"),
					);
					const cognitionRef = result.changedNodeRefs.find((r) =>
						r.startsWith("assertion:"),
					);
					expect(episodeRef).toBeDefined();
					expect(cognitionRef).toBeDefined();
				});
			},
			20_000,
		);

		it(
			"materializeRelationIntents writes relations via PgRelationWriteRepo",
			async () => {
				const settlementId = "stl:relation-mat:001";
				const relationWriteRepo = new PgRelationWriteRepo(pool);

				const localRefIndex = new Map<string, { kind: "episode"; nodeRef: string }>();
				localRefIndex.set("ep:source", {
					kind: "episode",
					nodeRef: "episode:9001",
				});

				const cognitionByKey = new Map<string, { kind: "assertion"; nodeRef: string }>();
				cognitionByKey.set("belief:target", {
					kind: "assertion",
					nodeRef: "private_cognition:9002",
				});

				const resolvedRefs: ResolvedLocalRefs = {
					settlementId,
					agentId: AGENT_ID,
					localRefIndex,
					cognitionByKey,
				};

				const written = await materializeRelationIntents(
					[
						{
							intent: "supports",
							sourceRef: "ep:source",
							targetRef: "belief:target",
						},
					],
					resolvedRefs,
					relationWriteRepo,
				);

				expect(written).toBe(1);

				const rows = await pool`
					SELECT source_node_ref, target_node_ref, relation_type, strength
					FROM memory_relations
					WHERE source_node_ref = 'episode:9001'
					  AND target_node_ref = 'private_cognition:9002'
				`;
				expect(rows.length).toBe(1);
				expect(rows[0].relation_type).toBe("supports");
				expect(Number(rows[0].strength)).toBeCloseTo(0.8, 1);
			},
			20_000,
		);

		it(
			"materializeRelationIntents handles empty intents gracefully",
			async () => {
				const relationWriteRepo = new PgRelationWriteRepo(pool);

				const resolvedRefs: ResolvedLocalRefs = {
					settlementId: "stl:empty-intent:001",
					agentId: AGENT_ID,
					localRefIndex: new Map(),
					cognitionByKey: new Map(),
				};

				const written = await materializeRelationIntents(
					[],
					resolvedRefs,
					relationWriteRepo,
				);

				expect(written).toBe(0);
			},
			10_000,
		);

		it(
			"resolveConflictFactors resolves refs and applyContestConflictFactors updates projection",
			async () => {
				const settlementId = "stl:conflict:001";
				const cognitionKey = `test:contested:${settlementId}`;

				const uow = new PgSettlementUnitOfWork(pool);

				await uow.run(async (repos) => {
					const session = await repos.sessionRepo.createSession(AGENT_ID);
					const sessionId = session.sessionId;

					await repos.settlementLedger.markApplying(
						settlementId,
						AGENT_ID,
						"hash:conflict",
					);

					const projectionManager = new ProjectionManager(
						new PgEpisodeRepo(pool),
						new PgCognitionEventRepo(pool),
						new PgCognitionProjectionRepo(pool),
						null,
						new PgAreaWorldProjectionRepo(pool),
					);

					await projectionManager.commitSettlement(
						makeTestSettlementPayload({
							settlementId,
							sessionId,
							cognitionOps: [
								{
									op: "upsert",
								record: {
									kind: "assertion",
									key: cognitionKey,
									holderId: { kind: "special", value: "self" },
									claim: "likes",
									entityRefs: [
										{ kind: "special", value: "self" },
										{ kind: "special", value: "user" },
									],
									stance: "accepted",
									basis: "first_hand",
								},
								},
							],
						}),
						{
							episodeRepo: repos.episodeRepo,
							cognitionEventRepo: repos.cognitionEventRepo,
							cognitionProjectionRepo: repos.cognitionProjectionRepo,
							areaWorldProjectionRepo: repos.areaWorldProjectionRepo,
							recentCognitionSlotRepo: repos.recentCognitionSlotRepo,
						},
					);

					const cognitionProjectionRepo = repos.cognitionProjectionRepo;
					const current = await cognitionProjectionRepo.getCurrent(AGENT_ID, cognitionKey);
					expect(current).not.toBeNull();

					const { resolved, unresolved } = await resolveConflictFactors(
						[
							{
								kind: "contradiction",
								ref: `private_episode:99999`,
								note: "contradicts prior observation",
							},
						],
						cognitionProjectionRepo,
						{ settlementId, agentId: AGENT_ID },
					);

					expect(resolved.length).toBe(1);
					expect(resolved[0].nodeRef).toBe("episode:99999");
					expect(unresolved.length).toBe(0);

					const relationWriteRepo = new PgRelationWriteRepo(pool);
					const relationReadRepo = {
						async resolveSourceAgentId() { return AGENT_ID; },
						async resolveCanonicalCognitionRefByKey() { return null; },
						async getConflictEvidence() { return []; },
						async getConflictHistory() { return []; },
					};
					const relationBuilder = new RelationBuilder({
						relationWriteRepo,
						relationReadRepo,
						cognitionProjectionRepo,
					});

					const contestedNodeRef = `assertion:${current!.id}`;

					await applyContestConflictFactors(
						relationBuilder,
						cognitionProjectionRepo,
						AGENT_ID,
						settlementId,
						[{ cognitionKey, nodeRef: contestedNodeRef }],
						[resolved[0].nodeRef],
						unresolved.length,
					);

					const updated = await cognitionProjectionRepo.getCurrent(AGENT_ID, cognitionKey);
					expect(updated).not.toBeNull();
					expect(updated!.conflict_summary).toContain("contested");
					expect(updated!.conflict_summary).toContain("1 factors");
				});
			},
			20_000,
		);

		it(
			"ledger lifecycle: talker_committed → thinker_projecting → applied",
			async () => {
				const settlementId = "stl:ledger-lifecycle:001";
				const ledger = new PgSettlementLedgerRepo(pool);

				await ledger.markTalkerCommitted(settlementId, AGENT_ID);
				const afterTalker = await ledger.getBySettlementId(settlementId);
				expect(afterTalker).not.toBeNull();
				expect(afterTalker!.status).toBe("talker_committed");
				expect(afterTalker!.attemptCount).toBe(0);

				await ledger.markThinkerProjecting(settlementId, AGENT_ID);
				const afterThinker = await ledger.getBySettlementId(settlementId);
				expect(afterThinker).not.toBeNull();
				expect(afterThinker!.status).toBe("thinker_projecting");
				expect(afterThinker!.attemptCount).toBe(1);

				await ledger.markApplied(settlementId);
				const afterApplied = await ledger.getBySettlementId(settlementId);
				expect(afterApplied).not.toBeNull();
				expect(afterApplied!.status).toBe("applied");
				expect(afterApplied!.appliedAt).not.toBeNull();
			},
			20_000,
		);

		it(
			"ledger retry: thinker_projecting → failed_retryable → thinker_projecting",
			async () => {
				const settlementId = "stl:ledger-retry:001";
				const ledger = new PgSettlementLedgerRepo(pool);

				await ledger.markTalkerCommitted(settlementId, AGENT_ID);
				await ledger.markThinkerProjecting(settlementId, AGENT_ID);

				const beforeFail = await ledger.getBySettlementId(settlementId);
				expect(beforeFail!.status).toBe("thinker_projecting");
				expect(beforeFail!.attemptCount).toBe(1);

				await ledger.markFailedRetryScheduled(
					settlementId,
					"transient network error",
				);
				const afterFail = await ledger.getBySettlementId(settlementId);
				expect(afterFail!.status).toBe("failed_retryable");
				expect(afterFail!.errorMessage).toBe("transient network error");

				await ledger.markThinkerProjecting(settlementId, AGENT_ID);
				const afterRetry = await ledger.getBySettlementId(settlementId);
				expect(afterRetry!.status).toBe("thinker_projecting");
				expect(afterRetry!.attemptCount).toBe(2);
				expect(afterRetry!.errorMessage).toBeNull();
			},
			20_000,
		);

		it(
			"enqueueOrganizerJobs creates chunked jobs via JobPersistence",
			async () => {
				const settlementId = "stl:organize:001";
				const mockJobs = createMockJobPersistence();

				const changedNodeRefs: NodeRef[] = [
					"event:1" as NodeRef,
					"event:2" as NodeRef,
					"assertion:3" as NodeRef,
					"evaluation:4" as NodeRef,
					"event:5" as NodeRef,
				];

				await enqueueOrganizerJobs(
					mockJobs,
					AGENT_ID,
					settlementId,
					changedNodeRefs,
					3,
				);

				expect(mockJobs.enqueuedJobs.length).toBe(2);

				expect(mockJobs.enqueuedJobs[0].id).toBe(
					`memory.organize:${settlementId}:chunk:0001`,
				);
				expect(mockJobs.enqueuedJobs[0].jobType).toBe("memory.organize");
				const payload0 = mockJobs.enqueuedJobs[0].payload as {
					agentId: string;
					chunkNodeRefs: NodeRef[];
					settlementId: string;
				};
				expect(payload0.agentId).toBe(AGENT_ID);
				expect(payload0.chunkNodeRefs.length).toBe(3);

				expect(mockJobs.enqueuedJobs[1].id).toBe(
					`memory.organize:${settlementId}:chunk:0002`,
				);
				const payload1 = mockJobs.enqueuedJobs[1].payload as {
					agentId: string;
					chunkNodeRefs: NodeRef[];
					settlementId: string;
				};
				expect(payload1.chunkNodeRefs.length).toBe(2);
			},
			10_000,
		);

		it(
			"createThinkerWorker end-to-end: LLM stub → projections → ledger → organize enqueue",
			async () => {
				const settlementId = "stl:e2e-worker:001";
				const requestId = "e2e-worker:001";

				const sessionId = await new PgSettlementUnitOfWork(pool).run(
					async (repos) => {
						const session = await repos.sessionRepo.createSession(AGENT_ID);
						return session.sessionId;
					},
				);

				const ledger = new PgSettlementLedgerRepo(pool);
				await ledger.markTalkerCommitted(settlementId, AGENT_ID);
				const settlementLedgerAdapter: NonNullable<
					ThinkerWorkerDeps["settlementLedger"]
				> = {
					check: (inputSettlementId) => ledger.check(inputSettlementId),
					rawStatus: (inputSettlementId) => ledger.rawStatus(inputSettlementId),
					markPending: (inputSettlementId, inputAgentId) =>
						ledger.markPending(inputSettlementId, inputAgentId),
					markClaimed: (inputSettlementId, claimedBy) =>
						ledger.markClaimed(inputSettlementId, claimedBy),
					markApplying: (inputSettlementId, inputAgentId, payloadHash) =>
						ledger.markApplying(inputSettlementId, inputAgentId, payloadHash),
					markApplied: (inputSettlementId) => ledger.markApplied(inputSettlementId),
					markReplayedNoop: (inputSettlementId) =>
						ledger.markReplayedNoop(inputSettlementId),
					markConflict: (inputSettlementId, errorMessage) =>
						ledger.markConflict(inputSettlementId, errorMessage),
					markFailed: (inputSettlementId, errorMessage, retryable) =>
						retryable
							? ledger.markFailedRetryScheduled(inputSettlementId, errorMessage)
							: ledger.markFailedTerminal(inputSettlementId, errorMessage),
					markTalkerCommitted: (inputSettlementId, inputAgentId) =>
						ledger.markTalkerCommitted(inputSettlementId, inputAgentId),
					markThinkerProjecting: (inputSettlementId, inputAgentId) =>
						ledger.markThinkerProjecting(inputSettlementId, inputAgentId),
				};

				const projectionManager = new ProjectionManager(
					new PgEpisodeRepo(pool),
					new PgCognitionEventRepo(pool),
					new PgCognitionProjectionRepo(pool),
					null,
					new PgAreaWorldProjectionRepo(pool),
				);

				const mockJobs = createMockJobPersistence();

				const mockInteractionRepo: InteractionRepo = {
					async getSettlementPayload(inputSessionId, inputRequestId) {
						if (inputSessionId !== sessionId || inputRequestId !== requestId) {
							return undefined;
						}
						return {
							settlementId: `stl:${inputRequestId}`,
							requestId: inputRequestId,
							sessionId: inputSessionId,
							ownerAgentId: AGENT_ID,
							publicReply: "Hello from test",
							hasPublicReply: true,
							viewerSnapshot: {
								selfPointerKey: "entity:self",
								userPointerKey: "entity:user",
								currentLocationEntityId: 42,
							},
							schemaVersion: "turn_settlement_v5",
							cognitiveSketch: "The user greeted me warmly.",
						};
					},
					async getMessageRecords(inputSessionId) {
						if (inputSessionId !== sessionId) {
							return [];
						}
						return [
							{
								sessionId: inputSessionId,
								recordId: "rec:e2e:001",
								recordIndex: 0,
								actorType: "user",
								recordType: "message",
								payload: { role: "user", content: "Hello!" },
								committedAt: Date.now(),
							},
						];
					},
					async commit() {},
					async runInTransaction<T>(
						fn: (tx: InteractionTransactionContext) => Promise<T>,
					) {
						return fn({ interactionRepo: mockInteractionRepo });
					},
					async settlementExists() {
						return false;
					},
					async findRecordByCorrelatedTurnId() {
						return undefined;
					},
					async findSessionIdByRequestId() {
						return undefined;
					},
					async getBySession() {
						return [];
					},
					async getByRange() {
						return [];
					},
					async markProcessed() {},
					async markRangeProcessed() {},
					async countUnprocessedRpTurns() {
						return 0;
					},
					async getMinMaxUnprocessedIndex() {
						return undefined;
					},
					async getMaxIndex() {
						return undefined;
					},
					async getPendingSettlementJobState() {
						return null;
					},
					async countUnprocessedSettlements() {
						return 0;
					},
					async getUnprocessedSettlementRange() {
						return null;
					},
					async listStalePendingSettlementSessions() {
						return [];
					},
					async getUnprocessedRangeForSession() {
						return null;
					},
				};

				const mockSlotRepo: RecentCognitionSlotRepo = {
					async upsertRecentCognitionSlot() {
						return {};
					},
					async getSlotPayload() {
						return undefined;
					},
					async getBySession() {
						return undefined;
					},
					async getVersionGap() {
						return undefined;
					},
				};

				const registry = new AgentRegistry();
				const agentProfile: AgentProfile = {
					id: AGENT_ID,
					role: "rp_agent",
					lifecycle: "persistent",
					userFacing: true,
					outputMode: "freeform",
					modelId: "test-model",
					toolPermissions: [],
					maxDelegationDepth: 1,
					lorebookEnabled: true,
					narrativeContextEnabled: true,
				};
				registry.register(agentProfile);

				const mockAgentLoop = {
					async runBuffered() {
						return {
							outcome: {
								schemaVersion: "rp_turn_outcome_v5" as const,
								publicReply: "I appreciate the greeting!",
								privateCognition: {
									ops: [
										{
											op: "upsert" as const,
											record: {
												kind: "assertion" as const,
												key: "test:e2e:belief-warmth",
												holderId: { kind: "special" as const, value: "self" },
												claim: "feels_warmth_toward",
												entityRefs: [
													{ kind: "special" as const, value: "self" },
													{ kind: "special" as const, value: "user" },
												],
												stance: "accepted" as const,
												basis: "first_hand" as const,
											},
										},
									],
								},
								privateEpisodes: [
									{
										category: "observation" as const,
										summary: "User greeted me warmly during our e2e test.",
										localRef: "ep:e2e:greeting",
									},
								],
								publications: [],
								relationIntents: [
									{
										sourceRef: "ep:e2e:greeting",
										targetRef: "test:e2e:belief-warmth",
										intent: "supports" as const,
									},
								],
								conflictFactors: [],
							},
						};
					},
				} as unknown as AgentLoop;

				const deps: ThinkerWorkerDeps = {
					sql: pool,
					projectionManager,
					interactionRepo: mockInteractionRepo,
					recentCognitionSlotRepo: mockSlotRepo,
					agentRegistry: registry,
					createAgentLoop: (agentId: string) =>
						agentId === AGENT_ID ? mockAgentLoop : null,
					jobPersistence: mockJobs,
					settlementLedger: settlementLedgerAdapter,
				};

				const worker = createThinkerWorker(deps);
				const payload: CognitionThinkerJobPayload = {
					sessionId,
					agentId: AGENT_ID,
					settlementId,
					talkerTurnVersion: 1,
				};

				await worker({ payload });

				const ledgerRow = await ledger.getBySettlementId(settlementId);
				expect(ledgerRow).not.toBeNull();
				expect(ledgerRow!.status).toBe("applied");

				const episodeRows = await pool`
					SELECT id, summary
					FROM private_episode_events
					WHERE settlement_id = ${settlementId}
					  AND agent_id = ${AGENT_ID}
				`;
				expect(episodeRows.length).toBe(1);
				expect(String(episodeRows[0].summary)).toContain("e2e test");

				const cognitionRows = await pool`
					SELECT id, kind, stance, cognition_key
					FROM private_cognition_current
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${"test:e2e:belief-warmth"}
					LIMIT 1
				`;
				expect(cognitionRows.length).toBe(1);
				expect(cognitionRows[0].kind).toBe("assertion");
				expect(cognitionRows[0].stance).toBe("accepted");

				const searchRows = await pool`
					SELECT source_ref, kind, stance, content
					FROM search_docs_cognition
					WHERE agent_id = ${AGENT_ID}
					  AND source_ref LIKE ${"assertion:%"}
					  AND content ILIKE ${"%feels_warmth_toward%"}
				`;
				expect(searchRows.length).toBeGreaterThanOrEqual(1);

				const relationRows = await pool`
					SELECT source_node_ref, target_node_ref, relation_type
					FROM memory_relations
					WHERE source_ref = ${settlementId}
				`;
				expect(relationRows.length).toBe(1);
				expect(relationRows[0].relation_type).toBe("supports");
				expect(String(relationRows[0].source_node_ref).startsWith("episode:")).toBe(true);
				expect(String(relationRows[0].target_node_ref).startsWith("assertion:")).toBe(true);

				expect(mockJobs.enqueuedJobs.length).toBeGreaterThanOrEqual(1);
				expect(mockJobs.enqueuedJobs[0].jobType).toBe("memory.organize");

				const enqueuedNodeRefs = mockJobs.enqueuedJobs.flatMap((job) => {
					const organizePayload = job.payload as {
						agentId: string;
						chunkNodeRefs: string[];
						settlementId: string;
					};
					expect(organizePayload.agentId).toBe(AGENT_ID);
					expect(organizePayload.settlementId).toBe(settlementId);
					return organizePayload.chunkNodeRefs;
				});

				expect(enqueuedNodeRefs.length).toBeGreaterThanOrEqual(1);
				expect(enqueuedNodeRefs.some((ref) => ref.startsWith("episode:"))).toBe(true);
				expect(enqueuedNodeRefs.some((ref) => ref.startsWith("assertion:"))).toBe(true);
				expect(
					enqueuedNodeRefs.every((ref) =>
						/^(episode|assertion|evaluation|commitment):\d+$/.test(ref),
					),
				).toBe(true);
				expect(
					enqueuedNodeRefs.every(
						(ref) =>
							!ref.startsWith("private_episode:") &&
							!ref.startsWith("private_cognition:"),
					),
				).toBe(true);

				const realRecentSlotRepo = new PgRecentCognitionSlotRepo(pool);
				const slot = await realRecentSlotRepo.getBySession(sessionId, AGENT_ID);
				expect(slot).toBeDefined();
				expect(slot!.thinkerCommittedVersion).toBeGreaterThanOrEqual(1);
			},
			30_000,
		);

		it(
			"user-anchored correction rewrites to one canonical key",
			async () => {
				const settlementId = "stl:canonicalize-single-match:001";
				const requestId = "canonicalize-single-match:001";
				const sessionId = await createSessionId(pool);

				const canonicalKey = "belief:canonical:user-location";
				const originalKey = "belief:draft:user-location:v2";
				const correctedClaim = "User relocated to the library";

				await runThinkerWorkerIntegration({
					pool,
					settlementId,
					requestId,
					sessionId,
					assertionCanonicalization: createMockAssertionCanonicalizationBundle({
						neighbors: [{ nodeRef: "assertion:101", similarity: 0.93 }],
					}),
					cognitionProjectionRepo: createMockCognitionProjectionRepo([
						makeCurrentAssertionRow({
							id: 101,
							key: canonicalKey,
							holderId: "self",
							claim: "User was in the hall",
							entityRefs: ["entity:user", "entity:library"],
						}),
					]),
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: {
							ops: [
								makeAssertionUpsert({
									key: originalKey,
									claim: correctedClaim,
									entityRefs: ["entity:user", "entity:library"],
								}),
							],
						},
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
					},
				});

				const rows = await pool`
					SELECT cognition_key, record_json
					FROM private_cognition_current
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key IN (${canonicalKey}, ${originalKey})
				`;
				expect(rows.length).toBe(1);
				expect(rows[0].cognition_key).toBe(canonicalKey);
				const record = parseRowRecordJson(rows[0].record_json);
				expect(record.claim).toBe(correctedClaim);
			},
			30_000,
		);

		it("no-match case preserves original key", async () => {
			const settlementId = "stl:canonicalize-no-match:001";
			const requestId = "canonicalize-no-match:001";
			const sessionId = await createSessionId(pool);

			const canonicalKey = "belief:canonical:no-match";
			const originalKey = "belief:draft:no-match";

			await runThinkerWorkerIntegration({
				pool,
				settlementId,
				requestId,
				sessionId,
				assertionCanonicalization: createMockAssertionCanonicalizationBundle({
					neighbors: [],
				}),
				cognitionProjectionRepo: createMockCognitionProjectionRepo([
					makeCurrentAssertionRow({
						id: 111,
						key: canonicalKey,
						holderId: "self",
						claim: "legacy",
						entityRefs: ["entity:user"],
					}),
				]),
				outcome: {
					schemaVersion: "rp_turn_outcome_v5",
					publicReply: "ok",
					privateCognition: {
						ops: [
							makeAssertionUpsert({
								key: originalKey,
								claim: "No canonical neighbor should match",
								entityRefs: ["entity:user"],
							}),
						],
					},
					privateEpisodes: [],
					publications: [],
					relationIntents: [],
					conflictFactors: [],
				},
			});

			const rows = await pool`
				SELECT cognition_key
				FROM private_cognition_current
				WHERE agent_id = ${AGENT_ID}
				  AND cognition_key IN (${canonicalKey}, ${originalKey})
			`;
			expect(rows.length).toBe(1);
			expect(rows[0].cognition_key).toBe(originalKey);
		}, 30_000);

		it("multi-match case preserves original key", async () => {
			const settlementId = "stl:canonicalize-multi-match:001";
			const requestId = "canonicalize-multi-match:001";
			const sessionId = await createSessionId(pool);

			const canonicalKeyA = "belief:canonical:multi-a";
			const canonicalKeyB = "belief:canonical:multi-b";
			const originalKey = "belief:draft:multi";

			await runThinkerWorkerIntegration({
				pool,
				settlementId,
				requestId,
				sessionId,
				assertionCanonicalization: createMockAssertionCanonicalizationBundle({
					neighbors: [
						{ nodeRef: "assertion:121", similarity: 0.92 },
						{ nodeRef: "assertion:122", similarity: 0.9 },
					],
				}),
				cognitionProjectionRepo: createMockCognitionProjectionRepo([
					makeCurrentAssertionRow({
						id: 121,
						key: canonicalKeyA,
						holderId: "self",
						claim: "candidate a",
						entityRefs: ["entity:user", "entity:room"],
					}),
					makeCurrentAssertionRow({
						id: 122,
						key: canonicalKeyB,
						holderId: "self",
						claim: "candidate b",
						entityRefs: ["entity:user", "entity:room"],
					}),
				]),
				outcome: {
					schemaVersion: "rp_turn_outcome_v5",
					publicReply: "ok",
					privateCognition: {
						ops: [
							makeAssertionUpsert({
								key: originalKey,
								claim: "ambiguous match should not rewrite",
								entityRefs: ["entity:user", "entity:room"],
							}),
						],
					},
					privateEpisodes: [],
					publications: [],
					relationIntents: [],
					conflictFactors: [],
				},
			});

			const rows = await pool`
				SELECT cognition_key
				FROM private_cognition_current
				WHERE agent_id = ${AGENT_ID}
				  AND cognition_key = ${originalKey}
			`;
			expect(rows.length).toBe(1);
		}, 30_000);

		it("terminal/retracted/cross-holder neighbors excluded", async () => {
			const settlementId = "stl:canonicalize-exclusions:001";
			const requestId = "canonicalize-exclusions:001";
			const sessionId = await createSessionId(pool);

			const originalKey = "belief:draft:exclusions";

			await runThinkerWorkerIntegration({
				pool,
				settlementId,
				requestId,
				sessionId,
				assertionCanonicalization: createMockAssertionCanonicalizationBundle({
					neighbors: [
						{ nodeRef: "assertion:131", similarity: 0.93 },
						{ nodeRef: "assertion:132", similarity: 0.92 },
						{ nodeRef: "assertion:133", similarity: 0.91 },
					],
				}),
				cognitionProjectionRepo: createMockCognitionProjectionRepo([
					makeCurrentAssertionRow({
						id: 131,
						key: "belief:terminal",
						holderId: "self",
						claim: "terminal candidate",
						entityRefs: ["entity:user"],
						stance: "rejected",
					}),
					makeCurrentAssertionRow({
						id: 132,
						key: "belief:retracted",
						holderId: "self",
						claim: "retracted candidate",
						entityRefs: ["entity:user"],
						status: "retracted",
					}),
					makeCurrentAssertionRow({
						id: 133,
						key: "belief:other-holder",
						holderId: "user",
						claim: "other holder candidate",
						entityRefs: ["entity:user"],
					}),
				]),
				outcome: {
					schemaVersion: "rp_turn_outcome_v5",
					publicReply: "ok",
					privateCognition: {
						ops: [
							makeAssertionUpsert({
								key: originalKey,
								claim: "all candidates should be excluded",
								entityRefs: ["entity:user"],
							}),
						],
					},
					privateEpisodes: [],
					publications: [],
					relationIntents: [],
					conflictFactors: [],
				},
			});

			const rows = await pool`
				SELECT cognition_key
				FROM private_cognition_current
				WHERE agent_id = ${AGENT_ID}
				  AND cognition_key = ${originalKey}
			`;
			expect(rows.length).toBe(1);
		}, 30_000);

		it("weak assertion excluded from canonicalization", async () => {
			const settlementId = "stl:canonicalize-weak-excluded:001";
			const requestId = "canonicalize-weak-excluded:001";
			const sessionId = await createSessionId(pool);

			let embedCalled = false;
			let cosineCalled = false;
			const canonicalKey = "belief:canonical:weak";
			const originalKey = "belief:draft:weak";

			await runThinkerWorkerIntegration({
				pool,
				settlementId,
				requestId,
				sessionId,
				assertionCanonicalization: createMockAssertionCanonicalizationBundle({
					neighbors: [{ nodeRef: "assertion:141", similarity: 0.95 }],
					onEmbed: () => {
						embedCalled = true;
					},
					onCosineSearch: () => {
						cosineCalled = true;
					},
				}),
				cognitionProjectionRepo: createMockCognitionProjectionRepo([
					makeCurrentAssertionRow({
						id: 141,
						key: canonicalKey,
						holderId: "self",
						claim: "candidate",
						entityRefs: ["entity:user"],
					}),
				]),
				outcome: {
					schemaVersion: "rp_turn_outcome_v5",
					publicReply: "ok",
					privateCognition: {
						ops: [
							makeAssertionUpsert({
								key: originalKey,
								claim: "weak assertion should skip canonicalization",
								entityRefs: ["entity:user"],
								basis: "belief",
								claimedGroundingRefs: [
									{ kind: "existing_cognition", ref: "cognition:prior:weak" },
								],
							}),
						],
					},
					privateEpisodes: [],
					publications: [],
					relationIntents: [],
					conflictFactors: [],
				},
			});

			expect(embedCalled).toBe(false);
			expect(cosineCalled).toBe(false);
			const rows = await pool`
				SELECT cognition_key
				FROM private_cognition_current
				WHERE agent_id = ${AGENT_ID}
				  AND cognition_key IN (${canonicalKey}, ${originalKey})
			`;
			expect(rows.length).toBe(1);
			expect(rows[0].cognition_key).toBe(originalKey);
		}, 30_000);

		it("batch-local overlay: later batch member sees earlier correction", async () => {
			const settlementId = "stl:canonicalize-overlay:001";
			const requestId = "canonicalize-overlay:001";
			const sessionId = await createSessionId(pool);

			const canonicalKey = "belief:canonical:overlay";
			const firstOriginalKey = "belief:draft:overlay:first";
			const secondOriginalKey = "belief:draft:overlay:second";
			const secondClaim = "User is definitely in the kitchen";
			let cosineSearchCount = 0;

			await runThinkerWorkerIntegration({
				pool,
				settlementId,
				requestId,
				sessionId,
				assertionCanonicalization: createMockAssertionCanonicalizationBundle({
					neighbors: [{ nodeRef: "assertion:151", similarity: 0.91 }],
					onCosineSearch: () => {
						cosineSearchCount += 1;
					},
				}),
				cognitionProjectionRepo: createMockCognitionProjectionRepo([
					makeCurrentAssertionRow({
						id: 151,
						key: canonicalKey,
						holderId: "self",
						claim: "legacy claim",
						entityRefs: ["entity:legacy"],
					}),
				]),
				outcome: {
					schemaVersion: "rp_turn_outcome_v5",
					publicReply: "ok",
					privateCognition: {
						ops: [
							makeAssertionUpsert({
								key: firstOriginalKey,
								claim: "User moved toward the kitchen",
								entityRefs: ["entity:legacy", "entity:user", "entity:kitchen"],
							}),
							makeAssertionUpsert({
								key: secondOriginalKey,
								claim: secondClaim,
								entityRefs: ["entity:user", "entity:kitchen"],
							}),
						],
					},
					privateEpisodes: [],
					publications: [],
					relationIntents: [],
					conflictFactors: [],
				},
			});

			expect(cosineSearchCount).toBe(2);

			const eventRows = await pool`
				SELECT cognition_key
				FROM private_cognition_events
				WHERE agent_id = ${AGENT_ID}
				  AND settlement_id = ${settlementId}
				ORDER BY id ASC
			`;
			expect(eventRows.length).toBe(1);
			expect(eventRows[0].cognition_key).toBe(canonicalKey);

			const slotRows = await pool`
				SELECT slot_payload
				FROM recent_cognition_slots
				WHERE session_id = ${sessionId}
				  AND agent_id = ${AGENT_ID}
				LIMIT 1
			`;
			expect(slotRows.length).toBe(1);
			const slotPayload = JSON.parse(String(slotRows[0].slot_payload)) as Array<{
				key?: string;
				summary?: string;
			}>;
			expect(slotPayload.length).toBe(1);
			expect(slotPayload[0].key).toBe(canonicalKey);
			expect(slotPayload[0].summary).toContain(secondClaim);

			const currentRows = await pool`
				SELECT record_json
				FROM private_cognition_current
				WHERE agent_id = ${AGENT_ID}
				  AND cognition_key = ${canonicalKey}
				LIMIT 1
			`;
			expect(currentRows.length).toBe(1);
			const current = parseRowRecordJson(currentRows[0].record_json);
			expect(current.claim).toBe(secondClaim);
		}, 30_000);

		it(
			"sketch-only assertion with hallucinated claimed refs remains weak/unverified pre-verification",
			async () => {
				const settlementId = "stl:guardrail-sketch-weak:001";
				const requestId = "guardrail-sketch-weak:001";
				const sessionId = await createSessionId(pool);

				await runThinkerWorkerIntegration({
					pool,
					settlementId,
					requestId,
					sessionId,
					settlementPayloadOverrides: {
						cognitiveSketchSource: "explicit",
					},
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: {
							ops: [
								{
									op: "upsert",
									record: {
										kind: "assertion",
										key: "test:guardrail:weak-sketch",
										holderId: { kind: "special", value: "self" },
										claim: "The user confessed yesterday",
										entityRefs: [
											{ kind: "special", value: "self" },
											{ kind: "special", value: "user" },
										],
										stance: "accepted",
										basis: "first_hand",
										claimedGroundingRefs: [
											{ kind: "user_message", ref: "request:fake-req" },
											{ kind: "private_episode", ref: "episode:fake-ep" },
										],
									},
								},
							],
						},
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
					},
				});

				const rows = await pool`
					SELECT basis, record_json
					FROM private_cognition_current
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${"test:guardrail:weak-sketch"}
					LIMIT 1
				`;
				expect(rows.length).toBe(1);
				expect(rows[0].basis).toBe("belief");

				const record = (typeof rows[0].record_json === "string"
					? JSON.parse(rows[0].record_json)
					: rows[0].record_json) as {
					groundingVerificationLevel?: string;
					verifiedGroundingRefs?: unknown[];
					provenance?: string;
				};
				expect(record.groundingVerificationLevel).toBe("unverified");
				expect(record.verifiedGroundingRefs).toEqual([]);
				expect(record.provenance).toBe("talker_sketch_explicit");
			},
			30_000,
		);

		it(
			"self-certified fake grounding refs stay weak on retrieval surfaces",
			async () => {
				const settlementId = "stl:guardrail-self-certified-fake:001";
				const requestId = "guardrail-self-certified-fake:001";
				const sessionId = await createSessionId(pool);

				await runThinkerWorkerIntegration({
					pool,
					settlementId,
					requestId,
					sessionId,
					settlementPayloadOverrides: {
						cognitiveSketchSource: "explicit",
					},
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: {
							ops: [
								{
									op: "upsert",
									record: {
										kind: "assertion",
										key: "test:guardrail:self-certified-fake",
										holderId: { kind: "special", value: "self" },
										claim: "I have perfect evidence",
										entityRefs: [
											{ kind: "special", value: "self" },
											{ kind: "special", value: "user" },
										],
										stance: "accepted",
										basis: "first_hand",
										provenance: "user_stated",
										claimedGroundingRefs: [
											{ kind: "user_message", ref: "request:does-not-exist" },
											{ kind: "private_episode", ref: "episode:missing-ep" },
										],
									},
								},
							],
						},
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
					},
				});

				const rows = await pool`
					SELECT basis, record_json
					FROM private_cognition_current
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${"test:guardrail:self-certified-fake"}
					LIMIT 1
				`;
				expect(rows.length).toBe(1);
				expect(rows[0].basis).toBe("inference");
				const record = parseRowRecordJson(rows[0].record_json) as {
					groundingVerificationLevel?: string;
					verifiedGroundingRefs?: unknown[];
				};
				expect(record.groundingVerificationLevel).toBe("unverified");
				expect(record.verifiedGroundingRefs).toEqual([]);

				const slotRows = await pool`
					SELECT slot_payload
					FROM recent_cognition_slots
					WHERE session_id = ${sessionId}
					  AND agent_id = ${AGENT_ID}
					LIMIT 1
				`;
				expect(slotRows.length).toBe(1);
				const slotEntries = (Array.isArray(slotRows[0].slot_payload)
					? slotRows[0].slot_payload
					: JSON.parse(String(slotRows[0].slot_payload))) as Array<{
					key?: string;
					basis?: string;
				}>;
				const assertionEntry = slotEntries.find(
					(entry) => entry.key === "test:guardrail:self-certified-fake",
				);
				expect(assertionEntry).toBeDefined();
				expect(assertionEntry!.basis).toBe("inference");
			},
			30_000,
		);

		it(
			"auto_fallback forces provenance to talker_sketch_auto and basis=belief with sourceTurnVersion stamp",
			async () => {
				const settlementId = "stl:guardrail-auto-fallback:001";
				const requestId = "guardrail-auto-fallback:001";
				const sessionId = await createSessionId(pool);

				await runThinkerWorkerIntegration({
					pool,
					settlementId,
					requestId,
					sessionId,
					talkerTurnVersion: 9,
					settlementPayloadOverrides: {
						cognitiveSketchSource: "auto_fallback",
					},
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: {
							ops: [
								{
									op: "upsert",
									record: {
										kind: "assertion",
										key: "test:guardrail:auto-fallback",
										holderId: { kind: "special", value: "self" },
										claim: "User said they are innocent",
										entityRefs: [
											{ kind: "special", value: "self" },
											{ kind: "special", value: "user" },
										],
										stance: "accepted",
										basis: "first_hand",
										provenance: "user_stated",
										claimedGroundingRefs: [
											{ kind: "user_message", ref: "request:123" },
										],
									},
								},
							],
						},
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
					},
				});

				const rows = await pool`
					SELECT basis, record_json
					FROM private_cognition_current
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${"test:guardrail:auto-fallback"}
					LIMIT 1
				`;
				expect(rows.length).toBe(1);
				expect(rows[0].basis).toBe("belief");
				const record = (typeof rows[0].record_json === "string"
					? JSON.parse(rows[0].record_json)
					: rows[0].record_json) as {
					provenance?: string;
					sourceTurnVersion?: number;
				};
				expect(record.provenance).toBe("talker_sketch_auto");
				expect(record.sourceTurnVersion).toBe(9);

			},
			30_000,
		);

		it(
			"auto_fallback cannot impersonate user_stated provenance",
			async () => {
				const settlementId = "stl:guardrail-auto-provenance-crosscheck:001";
				const requestId = "guardrail-auto-provenance-crosscheck:001";
				const sessionId = await createSessionId(pool);

				await runThinkerWorkerIntegration({
					pool,
					settlementId,
					requestId,
					sessionId,
					settlementPayloadOverrides: {
						cognitiveSketchSource: "auto_fallback",
					},
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: {
							ops: [
								{
									op: "upsert",
									record: {
										kind: "assertion",
										key: "test:guardrail:auto-provenance-crosscheck",
										holderId: { kind: "special", value: "self" },
										claim: "attempt impersonation",
										entityRefs: [{ kind: "special", value: "user" }],
										stance: "accepted",
										basis: "first_hand",
										provenance: "user_stated",
										claimedGroundingRefs: [
											{ kind: "user_message", ref: "request:fake-impersonation" },
										],
									},
								},
							],
						},
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
					},
				});

				const rows = await pool`
					SELECT basis, record_json
					FROM private_cognition_current
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${"test:guardrail:auto-provenance-crosscheck"}
					LIMIT 1
				`;
				expect(rows.length).toBe(1);
				expect(rows[0].basis).toBe("belief");
				const record = parseRowRecordJson(rows[0].record_json) as {
					provenance?: string;
				};
				expect(record.provenance).toBe("talker_sketch_auto");
				expect(record.provenance).not.toBe("user_stated");
			},
			30_000,
		);

		it(
			"confirmed sketch-origin assertion is downgraded to tentative before projection",
			async () => {
				const settlementId = "stl:guardrail-confirmed-downgrade:001";
				const requestId = "guardrail-confirmed-downgrade:001";
				const sessionId = await createSessionId(pool);

				await runThinkerWorkerIntegration({
					pool,
					settlementId,
					requestId,
					sessionId,
					settlementPayloadOverrides: {
						cognitiveSketchSource: "explicit",
					},
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: {
							ops: [
								{
									op: "upsert",
									record: {
										kind: "assertion",
										key: "test:guardrail:confirmed-downgrade",
										holderId: { kind: "special", value: "self" },
										claim: "Sketch said door is locked",
										entityRefs: [{ kind: "special", value: "self" }],
										stance: "confirmed",
										basis: "first_hand",
										provenance: "talker_sketch_explicit",
									},
								},
							],
						},
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
					},
				});

				const rows = await pool`
					SELECT stance
					FROM private_cognition_current
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${"test:guardrail:confirmed-downgrade"}
					LIMIT 1
				`;
				expect(rows.length).toBe(1);
				expect(rows[0].stance).toBe("tentative");
			},
			30_000,
		);

		it(
			"assertion with only cognition:* claimed refs is normalized to thinker_inferred provenance",
			async () => {
				const settlementId = "stl:guardrail-cognition-only-refs:001";
				const requestId = "guardrail-cognition-only-refs:001";
				const sessionId = await createSessionId(pool);

				await runThinkerWorkerIntegration({
					pool,
					settlementId,
					requestId,
					sessionId,
					settlementPayloadOverrides: {
						cognitiveSketchSource: "explicit",
					},
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: {
							ops: [
								{
									op: "upsert",
									record: {
										kind: "assertion",
										key: "test:guardrail:cognition-only-refs",
										holderId: { kind: "special", value: "self" },
										claim: "Another cognition key supports this",
										entityRefs: [{ kind: "special", value: "self" }],
										stance: "accepted",
										basis: "inference",
										provenance: "user_stated",
										claimedGroundingRefs: [
											{ kind: "existing_cognition", ref: "cognition:prior:key" },
											{ kind: "existing_cognition", ref: "cognition:other:key" },
										],
									},
								},
							],
						},
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
					},
				});

				const rows = await pool`
					SELECT record_json
					FROM private_cognition_current
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${"test:guardrail:cognition-only-refs"}
					LIMIT 1
				`;
				expect(rows.length).toBe(1);
				const record = (typeof rows[0].record_json === "string"
					? JSON.parse(rows[0].record_json)
					: rows[0].record_json) as {
					provenance?: string;
				};
				expect(record.provenance).toBe("thinker_inferred");
			},
			30_000,
		);

		it(
			"synchronous verification upgrades user-stated basis to first_hand",
			async () => {
				const settlementId = "stl:sync-verify-first-hand:001";
				const requestId = "sync-verify-first-hand:001";
				const sessionId = await createSessionId(pool);

				await runThinkerWorkerIntegration({
					pool,
					settlementId,
					requestId,
					sessionId,
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: {
							ops: [
								makeAssertionUpsert({
									key: "test:verify:first-hand",
									claim: "user gave direct statement",
									entityRefs: ["entity:user"],
									basis: "belief",
									provenance: "user_stated",
									claimedGroundingRefs: [
										{ kind: "user_message", ref: `request:${requestId}` },
									],
								}),
							],
						},
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
					},
				});

				const rows = await pool`
					SELECT basis, record_json
					FROM private_cognition_current
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${"test:verify:first-hand"}
					LIMIT 1
				`;
				expect(rows.length).toBe(1);
				expect(rows[0].basis).toBe("first_hand");

				const record = parseRowRecordJson(rows[0].record_json) as {
					groundingVerificationLevel?: string;
					verifiedGroundingRefs?: unknown[];
				};
				expect(record.groundingVerificationLevel).toBe("context_verified");
				expect(Array.isArray(record.verifiedGroundingRefs)).toBe(true);
				expect((record.verifiedGroundingRefs ?? []).length).toBeGreaterThanOrEqual(1);

				const slotRows = await pool`
					SELECT slot_payload
					FROM recent_cognition_slots
					WHERE session_id = ${sessionId}
					  AND agent_id = ${AGENT_ID}
					LIMIT 1
				`;
				expect(slotRows.length).toBe(1);
				const slotEntries = (Array.isArray(slotRows[0].slot_payload)
					? slotRows[0].slot_payload
					: JSON.parse(String(slotRows[0].slot_payload))) as Array<{
					kind?: string;
					key?: string;
					basis?: string;
				}>;
				const assertionEntry = slotEntries.find(
					(entry) => entry.kind === "assertion" && entry.key === "test:verify:first-hand",
				);
				expect(assertionEntry).toBeDefined();
				expect(assertionEntry!.basis).toBe("first_hand");
			},
			30_000,
		);

		it(
			"verified sketch-origin assertion reaches at most inference",
			async () => {
				const settlementId = "stl:sync-verify-sketch-cap:001";
				const requestId = "sync-verify-sketch-cap:001";
				const sessionId = await createSessionId(pool);

				await runThinkerWorkerIntegration({
					pool,
					settlementId,
					requestId,
					sessionId,
					settlementPayloadOverrides: {
						cognitiveSketchSource: "explicit",
					},
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: {
							ops: [
								makeAssertionUpsert({
									key: "test:verify:sketch-cap",
									claim: "sketch-origin assertion",
									entityRefs: ["entity:user"],
									basis: "belief",
									provenance: "talker_sketch_explicit",
									claimedGroundingRefs: [
										{ kind: "user_message", ref: `request:${requestId}` },
									],
								}),
							],
						},
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
					},
				});

				const rows = await pool`
					SELECT basis, record_json
					FROM private_cognition_current
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${"test:verify:sketch-cap"}
					LIMIT 1
				`;
				expect(rows.length).toBe(1);
				expect(rows[0].basis).toBe("inference");

				const record = parseRowRecordJson(rows[0].record_json) as {
					provenance?: string;
					groundingVerificationLevel?: string;
				};
				expect(record.provenance).toBe("talker_sketch_explicit");
				expect(record.groundingVerificationLevel).toBe("context_verified");

				const slotRows = await pool`
					SELECT slot_payload
					FROM recent_cognition_slots
					WHERE session_id = ${sessionId}
					  AND agent_id = ${AGENT_ID}
					LIMIT 1
				`;
				expect(slotRows.length).toBe(1);
				const slotEntries = (Array.isArray(slotRows[0].slot_payload)
					? slotRows[0].slot_payload
					: JSON.parse(String(slotRows[0].slot_payload))) as Array<{
					kind?: string;
					key?: string;
					basis?: string;
				}>;
				const assertionEntry = slotEntries.find(
					(entry) => entry.kind === "assertion" && entry.key === "test:verify:sketch-cap",
				);
				expect(assertionEntry).toBeDefined();
				expect(assertionEntry!.basis).toBe("inference");
				expect(assertionEntry!.basis).not.toBe("first_hand");
			},
			30_000,
		);

		it(
			"lower-version verification-upsert cannot beat higher-version correction",
			async () => {
				const key = "test:verify:version-priority";
				const sessionId = await createSessionId(pool);

				await runThinkerWorkerIntegration({
					pool,
					settlementId: "stl:verify-version-high:001",
					requestId: "verify-version-high:001",
					sessionId,
					talkerTurnVersion: 9,
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: {
							ops: [
								makeAssertionUpsert({
									key,
									claim: "higher-version correction",
									entityRefs: ["entity:user"],
									basis: "belief",
									provenance: "user_stated",
									claimedGroundingRefs: [
										{ kind: "user_message", ref: "request:verify-version-high:001" },
									],
								}),
							],
						},
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
					},
				});

				await runThinkerWorkerIntegration({
					pool,
					settlementId: "stl:verify-version-low:001",
					requestId: "verify-version-low:001",
					sessionId,
					talkerTurnVersion: 3,
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: {
							ops: [
								makeAssertionUpsert({
									key,
									claim: "lower-version replay",
									entityRefs: ["entity:user"],
									basis: "belief",
									provenance: "user_stated",
									claimedGroundingRefs: [
										{ kind: "user_message", ref: "request:verify-version-low:001" },
									],
								}),
							],
						},
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
					},
				});

				const rows = await pool`
					SELECT record_json
					FROM private_cognition_current
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${key}
					LIMIT 1
				`;
				expect(rows.length).toBe(1);
				const record = parseRowRecordJson(rows[0].record_json) as {
					claim?: string;
					sourceTurnVersion?: number;
				};
				expect(record.claim).toBe("higher-version correction");
				expect(record.sourceTurnVersion).toBe(9);

				const eventRows = await pool`
					SELECT id
					FROM private_cognition_events
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${key}
				`;
				expect(eventRows.length).toBe(4);
			},
			30_000,
		);

		it(
			"question input does not upsert factual belief",
			async () => {
				const key = "test:normalized-gate:question-bound";
				const settlementId = "stl:normalized-gate:question-bound:001";
				const requestId = "normalized-gate:question-bound:001";
				const sessionId = await createSessionId(pool);

				await runThinkerWorkerIntegration({
					pool,
					settlementId,
					requestId,
					sessionId,
					settlementPayloadOverrides: {
						normalizedTurnInput: {
							raw: "你是在问地点吗？",
							speechActs: ["question"],
							candidateActions: [],
							candidateClaims: [],
							validations: [],
							writeEligible: false,
						},
					},
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: {
							ops: [
								makeAssertionUpsert({
									key,
									claim: "The sword is in dungeon.",
									entityRefs: ["entity:self", "entity:sword", "entity:dungeon"],
									basis: "first_hand",
									provenance: "user_stated",
									sceneFactBinding: {
										scope: "world",
										factKey: "location:dungeon",
										expectedValue: true,
									},
								}),
							],
						},
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
					},
				});

				const rows = await pool`
					SELECT basis, stance, record_json
					FROM private_cognition_current
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${key}
					LIMIT 1
				`;
				expect(rows).toHaveLength(1);
				expect(rows[0].basis).toBe("inference");
				expect(rows[0].stance).toBe("tentative");
				const record = parseRowRecordJson(rows[0].record_json) as {
					sceneFactBinding?: unknown;
				};
				expect(record.sceneFactBinding).toBeUndefined();

				const factualRows = await pool`
					SELECT COUNT(*)::int AS count
					FROM private_cognition_events
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${key}
					  AND record_json->>'basis' IN ('first_hand', 'hearsay', 'introspection')
				`;
				expect(factualRows[0]?.count).toBe(0);
			},
			30_000,
		);

		it(
			"narrated_action with valid sceneFactBinding projects as factual belief",
			async () => {
				const key = "test:normalized-gate:narrated-action-bound";
				const settlementId = "stl:normalized-gate:narrated-action-bound:001";
				const requestId = "normalized-gate:narrated-action-bound:001";
				const sessionId = await createSessionId(pool);

				await runThinkerWorkerIntegration({
					pool,
					settlementId,
					requestId,
					sessionId,
					settlementPayloadOverrides: {
						cognitiveSketchSource: "explicit",
						normalizedTurnInput: {
							raw: "我把剑拿到了桌上。",
							speechActs: ["narrated_action"],
							candidateActions: [],
							candidateClaims: [],
							validations: [],
							writeEligible: true,
						},
					},
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: {
							ops: [
								makeAssertionUpsert({
									key,
									claim: "The sword is in location:sword anchor.",
									entityRefs: ["entity:self", "entity:sword"],
									basis: "first_hand",
									provenance: "user_stated",
									sceneFactBinding: {
										scope: "world",
										factKey: "location:sword",
										expectedValue: "table",
									},
								}),
							],
						},
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
					},
				});

				const rows = await pool`
					SELECT basis, stance
					FROM private_cognition_current
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${key}
					LIMIT 1
				`;
				expect(rows).toHaveLength(1);
				expect(rows[0].basis).toBe("first_hand");
				expect(rows[0].stance).toBe("accepted");
			},
			30_000,
		);

		it(
			"illegal sceneFactBinding degrades to unbound inference",
			async () => {
				const key = "test:normalized-gate:narrated-action-invalid-binding";
				const settlementId = "stl:normalized-gate:narrated-action-invalid-binding:001";
				const requestId = "normalized-gate:narrated-action-invalid-binding:001";
				const sessionId = await createSessionId(pool);

				await runThinkerWorkerIntegration({
					pool,
					settlementId,
					requestId,
					sessionId,
					settlementPayloadOverrides: {
						normalizedTurnInput: {
							raw: "我看起来很慌。",
							speechActs: ["narrated_action"],
							candidateActions: [],
							candidateClaims: [],
							validations: [],
							writeEligible: true,
						},
					},
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: {
							ops: [
								makeAssertionUpsert({
									key,
									claim: "panic mood was observed",
									entityRefs: ["entity:self", "entity:user"],
									basis: "first_hand",
									provenance: "user_stated",
									sceneFactBinding: {
										scope: "world",
										factKey: "mood:panic",
										expectedValue: true,
									},
								}),
							],
						},
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
					},
				});

				const rows = await pool`
					SELECT basis, stance, record_json
					FROM private_cognition_current
					WHERE agent_id = ${AGENT_ID}
					  AND cognition_key = ${key}
					LIMIT 1
				`;
				expect(rows).toHaveLength(1);
				expect(rows[0].basis).toBe("inference");
				expect(rows[0].stance).toBe("tentative");
				const record = parseRowRecordJson(rows[0].record_json) as {
					sceneFactBinding?: unknown;
				};
				expect(record.sceneFactBinding).toBeUndefined();

				const sceneFactRows = await pool`
					SELECT COUNT(*)::int AS count
					FROM area_state_events
					WHERE settlement_id = ${settlementId}
				`;
				expect(sceneFactRows[0]?.count).toBe(0);
			},
			30_000,
		);

		it("explicit settlement processing still rejects uncontrolled basis downgrade", async () => {
			const cognitionRepo = new CognitionRepository({
				cognitionProjectionRepo: new PgCognitionProjectionRepo(pool),
				cognitionEventRepo: new PgCognitionEventRepo(pool),
				searchProjectionRepo: new PgSearchProjectionRepo(pool),
				entityResolver: async (pointerKey: string) => {
					if (pointerKey === "__self__") return 100;
					if (pointerKey === "__user__") return 200;
					return null;
				},
			});

			const processor = new ExplicitSettlementProcessor(
				{
					cognitionRepo,
					relationBuilder: {
						async writeContestRelations() {},
					},
					relationWriteRepo: {
						async upsertRelation() {},
					},
					cognitionProjectionRepo: new PgCognitionProjectionRepo(pool),
					episodeRepo: new PgEpisodeRepo(pool),
					graphStoreRepo: new PgGraphMutableStoreRepo(pool),
					unresolvedOpsRepo: new PgUnresolvedWorldStateOpsRepo(pool),
				},
				{
					getEntityById: () => null,
					resolveEntityByPointerKey: (pointerKey: string) => {
						if (pointerKey === "__self__") return 100;
						if (pointerKey === "__user__") return 200;
						return null;
					},
				} as never,
				{ chat: async () => [] },
				async () => ({ entities: [], privateBeliefs: [] }),
				async () => {},
			);

			const settlementId = "stl:explicit-downgrade-block:001";
			const requestId = "explicit-downgrade-block:001";
			const payload: TurnSettlementPayload = {
				settlementId,
				requestId,
				sessionId: "sess-explicit-1",
				ownerAgentId: AGENT_ID,
				publicReply: "ok",
				hasPublicReply: true,
				viewerSnapshot: {
					selfPointerKey: "__self__",
					userPointerKey: "__user__",
				},
				schemaVersion: "turn_settlement_v5",
				privateCognition: {
					schemaVersion: "rp_private_cognition_v4",
					ops: [
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "test:explicit:basis-downgrade",
								holderId: { kind: "special", value: "self" },
								claim: "A claim",
								entityRefs: [
									{ kind: "special", value: "self" },
									{ kind: "special", value: "user" },
								],
								stance: "accepted",
								basis: "first_hand",
								provenance: "explicit_settlement",
							},
						},
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "test:explicit:basis-downgrade",
								holderId: { kind: "special", value: "self" },
								claim: "A claim",
								entityRefs: [
									{ kind: "special", value: "self" },
									{ kind: "special", value: "user" },
								],
								stance: "accepted",
								basis: "belief",
								provenance: "explicit_settlement",
							},
						},
					],
				},
				relationIntents: [],
				conflictFactors: [],
				publications: [],
			};

			const ingest = {
				batchId: "batch-explicit-1",
				agentId: AGENT_ID,
				sessionId: "sess-explicit-1",
				dialogue: [],
				attachments: [
					{
						recordType: "turn_settlement" as const,
						payload,
						committedAt: Date.now(),
						correlatedTurnId: requestId,
						explicitMeta: {
							settlementId,
							requestId,
							ownerAgentId: AGENT_ID,
							privateCognition: payload.privateCognition,
						},
					},
				],
				explicitSettlements: [
					{
						settlementId,
						requestId,
						ownerAgentId: AGENT_ID,
						privateCognition: payload.privateCognition,
					},
				],
			};

			await expect(
				processor.process(
					{
						sessionId: "sess-explicit-1",
						agentId: AGENT_ID,
						rangeStart: 0,
						rangeEnd: 1,
						flushMode: "manual",
						idempotencyKey: "explicit-downgrade-1",
					},
					ingest,
					{
						episodeEventIds: [],
						assertionIds: [],
						entityIds: [],
						factIds: [],
						changedNodeRefs: [],
					},
					[],
					{ agentRole: "rp_agent", skipEnforcement: true },
				),
			).rejects.toThrow("assertion basis change is not an allowed upgrade");
		}, 30_000);

		it("thinker instructions define claimedGroundingRefs vs relationIntents separately", () => {
			expect(THINKER_RELATION_AND_CONFLICT_INSTRUCTIONS).toContain(
				"claimedGroundingRefs belongs to assertion records",
			);
			expect(THINKER_RELATION_AND_CONFLICT_INSTRUCTIONS).toContain(
				"relationIntents is ONLY same-turn artifact structure",
			);
			expect(THINKER_RELATION_AND_CONFLICT_INSTRUCTIONS).toContain(
				"For v1, cross-turn revision is ONLY",
			);
		});

		it(
			"actionCommitments are ignored on thinker path (scene writes happen in talker commit path)",
			async () => {
				const settlementId = "stl:scene-fact:action-commitment:001";
				const requestId = "scene-fact:action-commitment:001";
				const sessionId = await createSessionId(pool);

				let applyAreaFactCommitCalled = 0;
				const mockAreaWorldProjectionRepo = {
					async applyAreaFactCommit(params: {
						sessionId: string;
						areaId: number;
						factKey: string;
						valueJson: unknown;
						sourceKind: string;
						exposureScope: string;
						sourceSettlementId: string | null;
						sourceAgentId: string | null;
						validTime: Date;
						committedTime: Date;
					}) {
						expect(params.sessionId).toBe(sessionId);
						expect(params.areaId).toBe(42);
						expect(params.factKey).toBe("status:door");
						applyAreaFactCommitCalled += 1;
						return { eventId: 1n };
					},
				};

				const mockProjectionManager = {
					async commitSettlement(params: SettlementProjectionParams) {
						for (const commit of params.sceneFactCommits ?? []) {
							if (commit.scope !== "area") {
								continue;
							}
							await mockAreaWorldProjectionRepo.applyAreaFactCommit({
								sessionId: params.sessionId,
								areaId:
									commit.areaId ??
									params.viewerSnapshot?.currentLocationEntityId ??
									0,
								factKey: commit.factKey,
								valueJson: commit.value,
								sourceKind: commit.sourceKind,
								exposureScope: String(commit.exposureScope),
								sourceSettlementId: params.settlementId,
								sourceAgentId: params.agentId,
								validTime: new Date(params.committedAt ?? Date.now()),
								committedTime: new Date(params.committedAt ?? Date.now()),
							});
						}
						return { changedNodeRefs: [] };
					},
				} as unknown as ProjectionManager;

				await runThinkerWorkerIntegration({
					pool,
					settlementId,
					requestId,
					sessionId,
					projectionManager: mockProjectionManager,
					sceneFactWritePath: true,
					outcome: {
						schemaVersion: "rp_turn_outcome_v5",
						publicReply: "ok",
						privateCognition: { ops: [] },
						privateEpisodes: [],
						publications: [],
						relationIntents: [],
						conflictFactors: [],
						actionCommitments: [
							{
								effect: "status_change",
								summary: "door opens",
								commits: [
									{
										scope: "area",
										exposureScope: "area_visible",
										factKey: "status:door",
										value: { open: true },
									},
								],
							},
						],
					},
					settlementPayloadOverrides: {
						viewerSnapshot: {
							selfPointerKey: "entity:self",
							userPointerKey: "entity:user",
							currentLocationEntityId: 42,
						},
					},
				});

				expect(applyAreaFactCommitCalled).toBe(0);
			},
			30_000,
		);

		it(
			"changedNodeRefs count matches cognitionOps + privateEpisodes count",
			async () => {
				const settlementId = "stl:ref-count:001";
				const uow = new PgSettlementUnitOfWork(pool);

				await uow.run(async (repos) => {
					const session = await repos.sessionRepo.createSession(AGENT_ID);
					const sessionId = session.sessionId;

					await repos.settlementLedger.markApplying(
						settlementId,
						AGENT_ID,
						"hash:ref-count",
					);

					const projectionManager = new ProjectionManager(
						new PgEpisodeRepo(pool),
						new PgCognitionEventRepo(pool),
						new PgCognitionProjectionRepo(pool),
						null,
						new PgAreaWorldProjectionRepo(pool),
					);

					const payload = makeTestSettlementPayload({
						settlementId,
						sessionId,
						cognitionOps: [
							{
								op: "upsert",
								record: {
									kind: "assertion",
									key: `test:count:belief-a:${settlementId}`,
									holderId: { kind: "special", value: "self" },
									claim: "knows",
									entityRefs: [
										{ kind: "special", value: "self" },
										{ kind: "special", value: "user" },
									],
									stance: "accepted",
									basis: "first_hand",
								},
							},
							{
								op: "upsert",
								record: {
									kind: "evaluation",
									key: `test:count:eval-a:${settlementId}`,
									target: { kind: "special", value: "user" },
									dimensions: [{ name: "mood", value: 0.9 }],
									notes: "user seems happy",
								},
							},
						],
						privateEpisodes: [
							{
								category: "observation",
								summary: "episode alpha",
								localRef: `ep:alpha:${settlementId}`,
							},
							{
								category: "speech",
								summary: "episode beta",
								localRef: `ep:beta:${settlementId}`,
							},
							{
								category: "action",
								summary: "episode gamma",
								localRef: `ep:gamma:${settlementId}`,
							},
						],
					});

					const result = await projectionManager.commitSettlement(
						payload,
						{
							episodeRepo: repos.episodeRepo,
							cognitionEventRepo: repos.cognitionEventRepo,
							cognitionProjectionRepo: repos.cognitionProjectionRepo,
							areaWorldProjectionRepo: repos.areaWorldProjectionRepo,
							recentCognitionSlotRepo: repos.recentCognitionSlotRepo,
						},
					);

					expect(result.changedNodeRefs.length).toBe(5);

					const episodeRefs = result.changedNodeRefs.filter((r) =>
						r.startsWith("episode:"),
					);
					const cognitionRefs = result.changedNodeRefs.filter((r) =>
						r.startsWith("assertion:") || r.startsWith("evaluation:") || r.startsWith("commitment:"),
					);
					expect(episodeRefs.length).toBe(3);
					expect(cognitionRefs.length).toBe(2);
				});
			},
			20_000,
		);
	},
);
