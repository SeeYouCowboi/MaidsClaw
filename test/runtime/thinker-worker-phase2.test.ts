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
						r.startsWith("private_episode:"),
					);
					const cognitionRef = result.changedNodeRefs.find((r) =>
						r.startsWith("private_cognition:"),
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

					const cognitionProjectionRepo = new PgCognitionProjectionRepo(pool);
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
					"private_episode:1" as NodeRef,
					"private_episode:2" as NodeRef,
					"private_cognition:3" as NodeRef,
					"private_cognition:4" as NodeRef,
					"private_episode:5" as NodeRef,
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
						r.startsWith("private_episode:"),
					);
					const cognitionRefs = result.changedNodeRefs.filter((r) =>
						r.startsWith("private_cognition:"),
					);
					expect(episodeRefs.length).toBe(3);
					expect(cognitionRefs.length).toBe(2);
				});
			},
			20_000,
		);
	},
);
