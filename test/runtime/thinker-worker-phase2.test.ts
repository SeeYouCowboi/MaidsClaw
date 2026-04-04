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
import { PgSettlementUnitOfWork } from "../../src/storage/pg-settlement-uow.js";
import {
	createThinkerWorker,
	type ThinkerWorkerDeps,
} from "../../src/runtime/thinker-worker.js";
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
					proposition: {
						subject: { kind: "special", value: "self" },
						predicate: "trusts",
						object: { kind: "entity", ref: { kind: "special", value: "user" } },
					},
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

describe.skipIf(skipPgTests)(
	"Thinker Worker Phase 2 — PG Integration",
	() => {
		let testDb: PgTestDb;
		let pool: postgres.Sql;

		beforeAll(async () => {
			testDb = await createPgTestDb();
			pool = testDb.pool;
		});

		afterAll(async () => {
			await testDb.cleanup();
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
						r.startsWith("event:"),
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
					nodeRef: "private_episode:9001",
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
					WHERE source_node_ref = 'private_episode:9001'
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
										proposition: {
											subject: { kind: "special", value: "self" },
											predicate: "likes",
											object: { kind: "entity", ref: { kind: "special", value: "user" } },
										},
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
					expect(resolved[0].nodeRef).toBe("private_episode:99999");
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
												proposition: {
													subject: { kind: "special" as const, value: "self" },
													predicate: "feels_warmth_toward",
													object: {
														kind: "entity" as const,
														ref: { kind: "special" as const, value: "user" },
													},
												},
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
				expect(String(relationRows[0].source_node_ref).startsWith("private_episode:")).toBe(true);
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
				expect(enqueuedNodeRefs.some((ref) => ref.startsWith("event:"))).toBe(true);
				expect(enqueuedNodeRefs.some((ref) => ref.startsWith("assertion:"))).toBe(true);
				expect(
					enqueuedNodeRefs.every((ref) =>
						/^(event|assertion|evaluation|commitment):\d+$/.test(ref),
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
									proposition: {
										subject: { kind: "special", value: "self" },
										predicate: "knows",
										object: { kind: "entity", ref: { kind: "special", value: "user" } },
									},
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
						r.startsWith("event:"),
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
