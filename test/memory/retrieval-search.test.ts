import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CognitionRepository } from "../../src/memory/cognition/cognition-repo.js";
import { CognitionSearchService } from "../../src/memory/cognition/cognition-search.js";
import { PrivateCognitionProjectionRepo } from "../../src/memory/cognition/private-cognition-current.js";
import { RelationBuilder } from "../../src/memory/cognition/relation-builder.js";
import { NarrativeSearchService } from "../../src/memory/narrative/narrative-search.js";
import { EpisodeRepository } from "../../src/memory/episode/episode-repo.js";
import { getTypedRetrievalSurface } from "../../src/memory/prompt-data.js";
import { RetrievalOrchestrator } from "../../src/memory/retrieval/retrieval-orchestrator.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { RetrievalService } from "../../src/memory/retrieval.js";
import { buildMemoryTools } from "../../src/memory/tools.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import type { CognitionHit } from "../../src/memory/cognition/cognition-search.js";
import type { MemoryHint, NodeRef, ViewerContext } from "../../src/memory/types.js";
import { openDatabase } from "../../src/storage/database.js";

function createTempDb() {
	const dbPath = join(tmpdir(), `maidsclaw-retrieval-${randomUUID()}.db`);
	const db = openDatabase({ path: dbPath });
	return { dbPath, db };
}

function cleanupDb(dbPath: string): void {
	try {
		rmSync(dbPath, { force: true });
		rmSync(`${dbPath}-shm`, { force: true });
		rmSync(`${dbPath}-wal`, { force: true });
	} catch {}
}

function viewer(overrides?: Partial<ViewerContext>): ViewerContext {
	return {
		viewer_agent_id: "rp:alice",
		viewer_role: "rp_agent",
		current_area_id: 1,
		session_id: "test-session",
		...overrides,
	};
}

function seedWorld(storage: GraphStorageService) {
	const locationId = storage.upsertEntity({
		pointerKey: "kitchen",
		displayName: "Kitchen",
		entityType: "location",
		memoryScope: "shared_public",
	});
	const aliceId = storage.upsertEntity({
		pointerKey: "alice",
		displayName: "Alice",
		entityType: "person",
		memoryScope: "shared_public",
	});
	const bobId = storage.upsertEntity({
		pointerKey: "bob",
		displayName: "Bob",
		entityType: "person",
		memoryScope: "shared_public",
	});
	return { locationId, aliceId, bobId };
}

describe("RetrievalService", () => {
	// ── Scenario 1: readByEntity ─────────────────────────────────────

	describe("readByEntity", () => {
		it("reads entity with associated facts and events", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			const { locationId, aliceId, bobId } = seedWorld(storage);

			storage.createFact(aliceId, bobId, "knows");
			storage.createProjectedEvent({
				sessionId: "s1",
				summary: "Alice greeted Bob in the kitchen",
				timestamp: Date.now(),
				participants: JSON.stringify([`entity:${aliceId}`, `entity:${bobId}`]),
				locationEntityId: locationId,
				eventCategory: "speech",
				origin: "runtime_projection",
			});

			const retrieval = RetrievalService.create(db);
			const result = retrieval.readByEntity("alice", viewer({ current_area_id: locationId }));

			expect(result.entity).not.toBeNull();
			expect(result.entity!.pointer_key).toBe("alice");
			expect(result.facts.length).toBeGreaterThanOrEqual(1);
			expect(result.facts[0].predicate).toBe("knows");
			expect(result.events.length).toBeGreaterThanOrEqual(1);

			db.close();
			cleanupDb(dbPath);
		});

		it("returns null entity for unknown pointer_key", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);

			const retrieval = RetrievalService.create(db);
			const result = retrieval.readByEntity("nonexistent", viewer());

			expect(result.entity).toBeNull();
			expect(result.facts).toHaveLength(0);
			expect(result.events).toHaveLength(0);

			db.close();
			cleanupDb(dbPath);
		});

		it("only returns active facts (t_invalid = MAX_INTEGER)", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			const { aliceId, bobId } = seedWorld(storage);

			const factId = storage.createFact(aliceId, bobId, "old_relation");
			storage.invalidateFact(factId);
			storage.createFact(aliceId, bobId, "current_relation");

			const retrieval = RetrievalService.create(db);
			const result = retrieval.readByEntity("alice", viewer());

			const predicates = result.facts.map((f) => f.predicate);
			expect(predicates).toContain("current_relation");
			expect(predicates).not.toContain("old_relation");

			db.close();
			cleanupDb(dbPath);
		});

		it("only returns events visible to viewer (area-scoped)", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			const { aliceId, bobId } = seedWorld(storage);

			const area1 = storage.upsertEntity({
				pointerKey: "area1",
				displayName: "Area 1",
				entityType: "location",
				memoryScope: "shared_public",
			});
			const area2 = storage.upsertEntity({
				pointerKey: "area2",
				displayName: "Area 2",
				entityType: "location",
				memoryScope: "shared_public",
			});

			storage.createProjectedEvent({
				sessionId: "s1",
				summary: "Alice in area 1",
				timestamp: Date.now(),
				participants: JSON.stringify([`entity:${aliceId}`]),
				locationEntityId: area1,
				eventCategory: "action",
				origin: "runtime_projection",
			});
			storage.createProjectedEvent({
				sessionId: "s1",
				summary: "Alice in area 2",
				timestamp: Date.now(),
				participants: JSON.stringify([`entity:${aliceId}`]),
				locationEntityId: area2,
				eventCategory: "action",
				origin: "runtime_projection",
			});

			const retrieval = RetrievalService.create(db);
			const result = retrieval.readByEntity("alice", viewer({ current_area_id: area1 }));

			const summaries = result.events.map((e) => e.summary);
			expect(summaries).toContain("Alice in area 1");
			expect(summaries).not.toContain("Alice in area 2");

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 2: FTS5 scope isolation ─────────────────────────────

	describe("FTS5 scope isolation", () => {
		it("narrative search excludes private docs entirely", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			storage.syncSearchDoc("private", "private_event:1" as any, "Alice thinks Bob is suspicious", "rp:alice");
			storage.syncSearchDoc("private", "private_event:2" as any, "Bob thinks Alice is kind", "rp:bob");

			const retrieval = RetrievalService.create(db);
			const results = await retrieval.searchVisibleNarrative("suspicious", viewer({ viewer_agent_id: "rp:alice" }));

			expect(results).toHaveLength(0);

			db.close();
			cleanupDb(dbPath);
		});

		it("area scope only returns docs matching viewer location", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			storage.syncSearchDoc("area", "event:1" as any, "A loud crash in the kitchen", undefined, 10);
			storage.syncSearchDoc("area", "event:2" as any, "A loud crash in the garden", undefined, 20);

			const retrieval = RetrievalService.create(db);
			const results = await retrieval.searchVisibleNarrative("crash", viewer({ current_area_id: 10 }));

			expect(results.length).toBe(1);
			expect(results[0].content).toContain("kitchen");

			db.close();
			cleanupDb(dbPath);
		});

		it("world scope returns docs to all viewers", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			storage.syncSearchDoc("world", "event:1" as any, "The annual festival began at dawn");

			const retrieval = RetrievalService.create(db);
			const alice = await retrieval.searchVisibleNarrative("festival", viewer({ viewer_agent_id: "rp:alice" }));
			const bob = await retrieval.searchVisibleNarrative("festival", viewer({ viewer_agent_id: "rp:bob" }));

			expect(alice.length).toBe(1);
			expect(bob.length).toBe(1);

			db.close();
			cleanupDb(dbPath);
		});

		it("narrative search returns only area + world results (not private)", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			storage.syncSearchDoc("private", "private_event:1" as any, "Alice privately recalled the moonlit garden", "rp:alice");
			storage.syncSearchDoc("area", "event:1" as any, "The moonlit garden was peaceful", undefined, 1);
			storage.syncSearchDoc("world", "event:2" as any, "A moonlit celebration in the town square");

			const retrieval = RetrievalService.create(db);
			const results = await retrieval.searchVisibleNarrative("moonlit", viewer({ viewer_agent_id: "rp:alice", current_area_id: 1 }));

			expect(results).toHaveLength(2);
			const scopes = results.map((r) => r.scope);
			expect(scopes).toContain("area");
			expect(scopes).toContain("world");
			expect(scopes).not.toContain("private");

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 3: Search edge cases ────────────────────────────────

	describe("Search edge cases", () => {
		it("no matching content returns empty results", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			storage.syncSearchDoc("world", "event:1" as any, "Alice baked a cake");

			const retrieval = RetrievalService.create(db);
			const results = await retrieval.searchVisibleNarrative("dragon", viewer());

			expect(results).toHaveLength(0);

			db.close();
			cleanupDb(dbPath);
		});

		it("trigram tokenizer matches partial words", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			storage.syncSearchDoc("world", "event:1" as any, "Alice visited the coffee shop downtown");

			const retrieval = RetrievalService.create(db);
			const results = await retrieval.searchVisibleNarrative("coff", viewer());

			expect(results.length).toBeGreaterThanOrEqual(1);
			expect(results[0].content).toContain("coffee");

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 4: readByTopic ──────────────────────────────────────

	describe("readByTopic", () => {
		it("returns topic with associated events", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			const locationId = storage.upsertEntity({
				pointerKey: "park",
				displayName: "Park",
				entityType: "location",
				memoryScope: "shared_public",
			});
			const topicId = storage.createTopic("friendship");
			storage.createProjectedEvent({
				sessionId: "s1",
				summary: "A conversation about friendship",
				timestamp: Date.now(),
				participants: "[]",
				locationEntityId: locationId,
				eventCategory: "speech",
				topicId,
				origin: "runtime_projection",
			});

			const retrieval = RetrievalService.create(db);
			const result = retrieval.readByTopic("friendship", viewer({ current_area_id: locationId }));

			expect(result.topic).not.toBeNull();
			expect(result.topic!.name).toBe("friendship");
			expect(result.events.length).toBeGreaterThanOrEqual(1);

			db.close();
			cleanupDb(dbPath);
		});

		it("returns null topic for unknown name", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);

			const retrieval = RetrievalService.create(db);
			const result = retrieval.readByTopic("nonexistent_topic", viewer());

			expect(result.topic).toBeNull();
			expect(result.events).toHaveLength(0);

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 5: Narrative search isolation ──────────────────────

	describe("NarrativeSearchService", () => {
		it("returns only area and world results", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			storage.syncSearchDoc("area", "event:1" as any, "A dragon appeared in the courtyard", undefined, 5);
			storage.syncSearchDoc("world", "event:2" as any, "A dragon was spotted near the mountains");

			const service = new NarrativeSearchService(db);
			const results = await service.searchNarrative("dragon", viewer({ current_area_id: 5 }));

			expect(results).toHaveLength(2);
			expect(results[0].scope).toBe("area");
			expect(results[1].scope).toBe("world");

			db.close();
			cleanupDb(dbPath);
		});

		it("viewer_role change does not alter narrative visibility", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			storage.syncSearchDoc("area", "event:1" as any, "The garden was blooming with beautiful flowers", undefined, 10);
			storage.syncSearchDoc("world", "event:2" as any, "The annual flower festival began with beautiful flowers");

			const service = new NarrativeSearchService(db);

			const rpResults = await service.searchNarrative("flowers", viewer({ viewer_role: "rp_agent", current_area_id: 10 }));
			const taskResults = await service.searchNarrative("flowers", viewer({ viewer_role: "task_agent", current_area_id: 10 }));
			const maidenResults = await service.searchNarrative("flowers", viewer({ viewer_role: "maiden", current_area_id: 10 }));

			expect(rpResults).toHaveLength(2);
			expect(taskResults).toHaveLength(2);
			expect(maidenResults).toHaveLength(2);
			expect(rpResults.map((r) => r.source_ref)).toEqual(taskResults.map((r) => r.source_ref));
			expect(rpResults.map((r) => r.source_ref)).toEqual(maidenResults.map((r) => r.source_ref));

			db.close();
			cleanupDb(dbPath);
		});

		it("private cognition docs are never surfaced by narrative search", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			storage.syncSearchDoc("private", "private_belief:1" as any, "Alice suspects betrayal from the butler", "rp:alice");
			storage.syncSearchDoc("private", "private_event:2" as any, "Alice evaluated the butler as untrustworthy", "rp:alice");
			storage.syncSearchDoc("world", "event:3" as any, "The butler served tea in the parlor");

			const service = new NarrativeSearchService(db);
			const results = await service.searchNarrative("butler", viewer({ viewer_agent_id: "rp:alice", current_area_id: 1 }));

			expect(results).toHaveLength(1);
			expect(results[0].scope).toBe("world");
			expect(results[0].content).toContain("served tea");

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 6: CognitionSearchService ────────────────────────────

	describe("CognitionSearchService", () => {
		function seedCognitionEntities(storage: GraphStorageService) {
			storage.upsertEntity({
				pointerKey: "__self__",
				displayName: "Alice",
				entityType: "person",
				memoryScope: "shared_public",
			});
			storage.upsertEntity({
				pointerKey: "__user__",
				displayName: "User",
				entityType: "person",
				memoryScope: "shared_public",
			});
			storage.upsertEntity({
				pointerKey: "bob",
				displayName: "Bob",
				entityType: "person",
				memoryScope: "shared_public",
			});
		}

		it("returns filtered assertion/evaluation/commitment hits from canonical index", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedCognitionEntities(storage);

			const repo = new CognitionRepository(db);
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "search:a1",
				settlementId: "stl:s1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});
			repo.upsertEvaluation({
				agentId: "rp:alice",
				cognitionKey: "search:e1",
				settlementId: "stl:s1",
				opIndex: 1,
				dimensions: [{ name: "trust", value: 0.8 }],
				notes: "Bob seems trustworthy",
			});
			repo.upsertCommitment({
				agentId: "rp:alice",
				cognitionKey: "search:c1",
				settlementId: "stl:s1",
				opIndex: 2,
				mode: "goal",
				target: { action: "help Bob" },
				status: "active",
				priority: 5,
				horizon: "near",
			});

			const search = new CognitionSearchService(db);

			const allHits = search.searchCognition({ agentId: "rp:alice" });
			expect(allHits.length).toBe(3);

			const assertionHits = search.searchCognition({ agentId: "rp:alice", kind: "assertion" });
			expect(assertionHits.length).toBe(1);
			expect(assertionHits[0].kind).toBe("assertion");
			expect(assertionHits[0].stance).toBe("accepted");
			expect(assertionHits[0].basis).toBe("first_hand");

			const evalHits = search.searchCognition({ agentId: "rp:alice", kind: "evaluation" });
			expect(evalHits.length).toBe(1);
			expect(evalHits[0].kind).toBe("evaluation");

			const commitHits = search.searchCognition({ agentId: "rp:alice", kind: "commitment" });
			expect(commitHits.length).toBe(1);
			expect(commitHits[0].kind).toBe("commitment");

			db.close();
			cleanupDb(dbPath);
		});

		it("commitment sorting follows priority + horizon + updated_at", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedCognitionEntities(storage);

			const repo = new CognitionRepository(db);
			repo.upsertCommitment({
				agentId: "rp:alice",
				cognitionKey: "sort:c-low-prio",
				settlementId: "stl:s1",
				opIndex: 0,
				mode: "goal",
				target: { action: "low priority task" },
				status: "active",
				priority: 10,
				horizon: "immediate",
			});
			repo.upsertCommitment({
				agentId: "rp:alice",
				cognitionKey: "sort:c-high-prio",
				settlementId: "stl:s1",
				opIndex: 1,
				mode: "goal",
				target: { action: "high priority task" },
				status: "active",
				priority: 1,
				horizon: "long",
			});
			repo.upsertCommitment({
				agentId: "rp:alice",
				cognitionKey: "sort:c-mid-prio",
				settlementId: "stl:s1",
				opIndex: 2,
				mode: "intent",
				target: { action: "mid priority near" },
				status: "active",
				priority: 5,
				horizon: "near",
			});
			repo.upsertCommitment({
				agentId: "rp:alice",
				cognitionKey: "sort:c-mid-prio-imm",
				settlementId: "stl:s1",
				opIndex: 3,
				mode: "plan",
				target: { action: "mid priority immediate" },
				status: "active",
				priority: 5,
				horizon: "immediate",
			});

			const search = new CognitionSearchService(db);
			const hits = search.searchCognition({ agentId: "rp:alice", kind: "commitment" });

			expect(hits.length).toBe(4);
			expect(hits[0].content).toContain("high priority");
			expect(hits[1].content).toContain("mid priority immediate");
			expect(hits[2].content).toContain("mid priority near");
			expect(hits[3].content).toContain("low priority");

			db.close();
			cleanupDb(dbPath);
		});

		it("cognition hits do NOT appear in narrative search results", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedCognitionEntities(storage);

			const repo = new CognitionRepository(db);
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "isolation:a1",
				settlementId: "stl:s1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "distrusts",
				targetPointerKey: "bob",
				stance: "tentative",
				basis: "inference",
			});

			storage.syncSearchDoc("world", "event:99" as any, "Bob arrived at the mansion distrusts nobody");

			const cognitionSearch = new CognitionSearchService(db);
			const cognitionHits = cognitionSearch.searchCognition({
				agentId: "rp:alice",
				query: "distrusts",
			});
			expect(cognitionHits.length).toBe(1);
			expect(cognitionHits[0].kind).toBe("assertion");

			const narrativeSearch = new NarrativeSearchService(db);
			const narrativeResults = await narrativeSearch.searchNarrative(
				"distrusts",
				viewer({ viewer_agent_id: "rp:alice", current_area_id: 1 }),
			);
			expect(narrativeResults.length).toBe(1);
			expect(narrativeResults[0].scope).toBe("world");
			expect(narrativeResults[0].content).toContain("mansion");

			db.close();
			cleanupDb(dbPath);
		});

		it("contested cognition_search hits expose short risk note plus explain handoff fields", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedCognitionEntities(storage);

			const repo = new CognitionRepository(db);
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "evidence:factor",
				settlementId: "stl:ev-0",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "noticed",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "evidence:contested",
				settlementId: "stl:ev-1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "evidence:contested",
				settlementId: "stl:ev-2",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "contested",
				basis: "first_hand",
				preContestedStance: "accepted",
			});

			const now = Date.now();
			db.run(
				`INSERT INTO private_cognition_events (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"rp:alice",
					"evidence:contested",
					"assertion",
					"upsert",
					JSON.stringify({
						sourcePointerKey: "__self__",
						predicate: "trusts",
						targetPointerKey: "bob",
						stance: "contested",
						basis: "first_hand",
						preContestedStance: "accepted",
						conflictSummary: "contested (1 factors)",
						conflictFactorRefs: ["private_belief:1"],
					}),
					"stl:ev-3",
					now,
					now,
				],
			);

			const projection = new PrivateCognitionProjectionRepo(db);
			projection.rebuild("rp:alice");

			const search = new CognitionSearchService(db);
			const hits = search.searchCognition({
				agentId: "rp:alice",
				kind: "assertion",
				stance: "contested",
			});

			expect(hits.length).toBe(1);
			expect(hits[0].stance).toBe("contested");
			expect(hits[0].conflictEvidence).toBeDefined();
			expect(hits[0].conflictEvidence).toEqual([]);
			expect(hits[0].conflictSummary).toBe("contested (1 factors)");
			expect(hits[0].conflictFactorRefs).toEqual(["private_belief:1"]);

			db.close();
			cleanupDb(dbPath);
		});

		it("non-contested hits do not have conflictEvidence", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedCognitionEntities(storage);

			const repo = new CognitionRepository(db);
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "evidence:accepted",
				settlementId: "stl:ev-3",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "likes",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			const search = new CognitionSearchService(db);
			const hits = search.searchCognition({
				agentId: "rp:alice",
				kind: "assertion",
				stance: "accepted",
			});

			expect(hits.length).toBe(1);
			expect(hits[0].conflictEvidence).toBeUndefined();

			db.close();
			cleanupDb(dbPath);
		});

		it("FTS text search finds matching cognition docs", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedCognitionEntities(storage);

			const repo = new CognitionRepository(db);
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "fts:a1",
				settlementId: "stl:s1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "suspects",
				targetPointerKey: "bob",
				stance: "tentative",
				basis: "inference",
			});
			repo.upsertEvaluation({
				agentId: "rp:alice",
				cognitionKey: "fts:e1",
				settlementId: "stl:s1",
				opIndex: 1,
				dimensions: [{ name: "mood", value: 0.3 }],
				notes: "feeling uneasy about the situation",
			});

			const search = new CognitionSearchService(db);

			const suspectHits = search.searchCognition({ agentId: "rp:alice", query: "suspects" });
			expect(suspectHits.length).toBe(1);
			expect(suspectHits[0].kind).toBe("assertion");

			const uneasyHits = search.searchCognition({ agentId: "rp:alice", query: "uneasy" });
			expect(uneasyHits.length).toBe(1);
			expect(uneasyHits[0].kind).toBe("evaluation");

			db.close();
			cleanupDb(dbPath);
		});
	});

	describe("CurrentProjectionReader via cognition-search", () => {
		function seedCognitionEntities(storage: GraphStorageService) {
			storage.upsertEntity({
				pointerKey: "__self__",
				displayName: "Alice",
				entityType: "person",
				memoryScope: "shared_public",
			});
			storage.upsertEntity({
				pointerKey: "__user__",
				displayName: "User",
				entityType: "person",
				memoryScope: "shared_public",
			});
			storage.upsertEntity({
				pointerKey: "bob",
				displayName: "Bob",
				entityType: "person",
				memoryScope: "shared_public",
			});
		}

		it("currentProjectionReader reads from private_cognition_current after rebuild", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedCognitionEntities(storage);

			const repo = new CognitionRepository(db);
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "proj-read:a1",
				settlementId: "stl:pr-1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});
			repo.upsertEvaluation({
				agentId: "rp:alice",
				cognitionKey: "proj-read:e1",
				settlementId: "stl:pr-1",
				opIndex: 1,
				dimensions: [{ name: "trust", value: 0.9 }],
				notes: "very trustworthy",
			});

			const projection = new PrivateCognitionProjectionRepo(db);
			projection.rebuild("rp:alice");

			const search = new CognitionSearchService(db);
			const reader = search.createCurrentProjectionReader();

			const all = reader.getAllCurrent("rp:alice");
			expect(all.length).toBe(2);

			const assertion = reader.getCurrent("rp:alice", "proj-read:a1");
			expect(assertion).not.toBeNull();
			expect(assertion!.kind).toBe("assertion");
			expect(assertion!.stance).toBe("accepted");

			const evaluation = reader.getCurrent("rp:alice", "proj-read:e1");
			expect(evaluation).not.toBeNull();
			expect(evaluation!.kind).toBe("evaluation");

			db.close();
			cleanupDb(dbPath);
		});

		it("getActiveCurrent excludes retracted rows", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedCognitionEntities(storage);

			const repo = new CognitionRepository(db);
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "proj-read:active",
				settlementId: "stl:pr-2",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "likes",
				targetPointerKey: "bob",
				stance: "accepted",
			});
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "proj-read:retracted",
				settlementId: "stl:pr-2",
				opIndex: 1,
				sourcePointerKey: "__self__",
				predicate: "dislikes",
				targetPointerKey: "bob",
				stance: "accepted",
			});
			repo.retractCognition("rp:alice", "proj-read:retracted", "assertion", "stl:pr-3");

			const projection = new PrivateCognitionProjectionRepo(db);
			projection.rebuild("rp:alice");

			const search = new CognitionSearchService(db);
			const reader = search.createCurrentProjectionReader();

			const active = reader.getActiveCurrent("rp:alice");
			expect(active.length).toBe(1);
			expect(active[0].cognition_key).toBe("proj-read:active");

			const all = reader.getAllCurrent("rp:alice");
			expect(all.length).toBe(2);

			db.close();
			cleanupDb(dbPath);
		});

		it("getAllCurrentByKind filters by kind", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedCognitionEntities(storage);

			const repo = new CognitionRepository(db);
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "proj-read:kind-a",
				settlementId: "stl:pr-4",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "knows",
				targetPointerKey: "bob",
				stance: "accepted",
			});
			repo.upsertCommitment({
				agentId: "rp:alice",
				cognitionKey: "proj-read:kind-c",
				settlementId: "stl:pr-4",
				opIndex: 1,
				mode: "goal",
				target: { action: "help" },
				status: "active",
			});

			const projection = new PrivateCognitionProjectionRepo(db);
			projection.rebuild("rp:alice");

			const search = new CognitionSearchService(db);
			const reader = search.createCurrentProjectionReader();

			const assertions = reader.getAllCurrentByKind("rp:alice", "assertion");
			expect(assertions.length).toBe(1);
			expect(assertions[0].kind).toBe("assertion");

			const commitments = reader.getAllCurrentByKind("rp:alice", "commitment");
			expect(commitments.length).toBe(1);
			expect(commitments[0].kind).toBe("commitment");

			db.close();
			cleanupDb(dbPath);
		});

		it("toHit converts projection row to CognitionHit format", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedCognitionEntities(storage);

			const repo = new CognitionRepository(db);
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "proj-read:hit",
				settlementId: "stl:pr-5",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			const projection = new PrivateCognitionProjectionRepo(db);
			projection.rebuild("rp:alice");

			const search = new CognitionSearchService(db);
			const reader = search.createCurrentProjectionReader();
			const row = reader.getCurrent("rp:alice", "proj-read:hit")!;
			const hit = reader.toHit(row);

			expect(hit.kind).toBe("assertion");
			expect(hit.stance).toBe("accepted");
			expect(hit.basis).toBe("first_hand");
			expect(hit.content).toContain("trusts");

			db.close();
			cleanupDb(dbPath);
		});
	});

		describe("Typed Retrieval Surface", () => {
			it("create factory returns RetrievalService instance", () => {
				const { dbPath, db } = createTempDb();
				runMemoryMigrations(db);

				const retrieval = RetrievalService.create(db);
				expect(retrieval instanceof RetrievalService).toBe(true);

				db.close();
				cleanupDb(dbPath);
			});

			it("keeps typed retrieval frontstage separate from memory_explore explain shell", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			storage.syncSearchDoc("world", "event:1" as any, "A ledger dispute happened in the hall");

			const retrieval = RetrievalService.create(db);
			const typed = await retrieval.generateTypedRetrieval(
				"ledger dispute",
				viewer({ viewer_agent_id: "rp:alice", current_area_id: 1 }),
				undefined,
				{
					cognitionBudget: 1,
					narrativeBudget: 1,
					conflictNotesBudget: 1,
					episodeBudget: 0,
				},
			);

			expect((typed as Record<string, unknown>).evidence_paths).toBeUndefined();
			expect((typed as Record<string, unknown>).query_type).toBeUndefined();

			let capturedExploreInput: Record<string, unknown> | undefined;
			const tools = buildMemoryTools({
				coreMemory: {} as any,
				retrieval,
					navigator: {
					async explore(_query: string, _ctx: ViewerContext, input?: any) {
						capturedExploreInput = input;
						return {
							query: "ledger dispute",
							query_type: "conflict",
							summary: "Explain conflict: 1 evidence path",
							drilldown: {
								mode: "conflict",
								focus_ref: "event:1" as any,
								focus_cognition_key: "conf:1",
								as_of_valid_time: 100,
								as_of_committed_time: 200,
								time_sliced_paths: [],
							},
							evidence_paths: [],
						};
					},
				},
			});

			const exploreTool = tools.find((tool) => tool.name === "memory_explore");
			expect(exploreTool).toBeDefined();
			const exploreResult = await exploreTool!.handler(
				{
					query: "ledger dispute",
					mode: "conflict",
					focusRef: "event:1",
					focusCognitionKey: "conf:1",
					asOfValidTime: 100,
					asOfCommittedTime: 200,
				},
				viewer({ viewer_agent_id: "rp:alice", current_area_id: 1 }),
			) as Record<string, unknown>;

			expect(exploreResult.summary).toBe("Explain conflict: 1 evidence path");
			expect((exploreResult.drilldown as Record<string, unknown>).mode).toBe("conflict");
			expect(exploreResult.evidence_paths).toBeDefined();
			expect(capturedExploreInput).toEqual({
				query: "ledger dispute",
				mode: "conflict",
				focusRef: "event:1",
				focusCognitionKey: "conf:1",
				asOfValidTime: 100,
				asOfCommittedTime: 200,
			});

			db.close();
			cleanupDb(dbPath);
		});

		it("uses per-type budgets and keeps episode default at zero", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			storage.syncSearchDoc("world", "fact:1" as any, "Ledger protocol remains strict in the manor");
			storage.syncSearchDoc("world", "event:1" as any, "Yesterday a ledger fell in the hall");

			storage.upsertEntity({
				pointerKey: "__self__",
				displayName: "Alice",
				entityType: "person",
				memoryScope: "shared_public",
			});
			storage.upsertEntity({
				pointerKey: "bob",
				displayName: "Bob",
				entityType: "person",
				memoryScope: "shared_public",
			});

			const repo = new CognitionRepository(db);
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "typed:budget",
				settlementId: "stl:typed-1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "tracks",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			const retrieval = RetrievalService.create(db);
			const typed = await retrieval.generateTypedRetrieval(
				"ledger",
				viewer({ viewer_agent_id: "rp:alice" }),
				undefined,
				{
					cognitionBudget: 1,
					narrativeBudget: 1,
					conflictNotesBudget: 1,
					episodeBudget: 0,
				},
			);

			expect(typed.cognition.length).toBeLessThanOrEqual(1);
			expect(typed.narrative.length).toBeLessThanOrEqual(1);
			expect(typed.episode).toHaveLength(0);

			db.close();
			cleanupDb(dbPath);
		});

		it("supports query-triggered episode boost from zero default", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			storage.syncSearchDoc("world", "event:10" as any, "Earlier in the hall, Bob dropped a key");

			const retrieval = RetrievalService.create(db);
			const typed = await retrieval.generateTypedRetrieval(
				"what happened before in the hall",
				viewer({ viewer_agent_id: "rp:alice", current_area_id: 1 }),
				undefined,
				{
					cognitionBudget: 0,
					narrativeBudget: 0,
					conflictNotesBudget: 0,
					episodeBudget: 0,
					queryEpisodeBoost: 1,
					sceneEpisodeBoost: 1,
				},
			);

			expect(typed.episode.length).toBeGreaterThanOrEqual(1);

			db.close();
			cleanupDb(dbPath);
		});

		it("supports detective/scene query-triggered episode boost from zero default", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);

			const episodeRepo = new EpisodeRepository(db);
			episodeRepo.append({
				agentId: "rp:alice",
				sessionId: "session-detective",
				settlementId: "stl:episode-detective-1",
				category: "observation",
				summary: "A clue was left in the kitchen pantry after midnight",
				locationEntityId: 1,
				committedTime: Date.now(),
			});

			const retrieval = RetrievalService.create(db);
			const typed = await retrieval.generateTypedRetrieval(
				"investigate clues here in the kitchen",
				viewer({ viewer_agent_id: "rp:alice", current_area_id: 1 }),
				undefined,
				{
					cognitionBudget: 0,
					narrativeBudget: 0,
					conflictNotesBudget: 0,
					episodeBudget: 0,
					queryEpisodeBoost: 1,
					sceneEpisodeBoost: 1,
				},
			);

			expect(typed.episode.length).toBeGreaterThanOrEqual(1);

			db.close();
			cleanupDb(dbPath);
		});

		it("getTypedRetrievalSurface auto-includes durable episodes without manual tool call", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			runInteractionMigrations(db);

			const episodeRepo = new EpisodeRepository(db);
			episodeRepo.append({
				agentId: "rp:alice",
				sessionId: "session-a",
				settlementId: "stl:episode-1",
				category: "observation",
				summary: "Earlier in the kitchen, Bob dropped a brass key near the stove",
				locationEntityId: 1,
				committedTime: Date.now(),
			});

			const sessionA = RetrievalService.create(db);
			const sessionB = RetrievalService.create(db);
			expect(sessionA).not.toBe(sessionB);

			const rendered = await getTypedRetrievalSurface(
				"what happened before here in the kitchen",
				viewer({
					viewer_agent_id: "rp:alice",
					session_id: "session-b",
					current_area_id: 1,
				}),
				db,
				sessionB,
			);

			expect(rendered).toContain("[episode]");
			expect(rendered).toContain("Bob dropped a brass key");

			db.close();
			cleanupDb(dbPath);
		});

		it("reserves conflict_notes budget independently from cognition budget", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			storage.upsertEntity({
				pointerKey: "__self__",
				displayName: "Alice",
				entityType: "person",
				memoryScope: "shared_public",
			});
			storage.upsertEntity({
				pointerKey: "bob",
				displayName: "Bob",
				entityType: "person",
				memoryScope: "shared_public",
			});

			const repo = new CognitionRepository(db);
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "typed:conflict",
				settlementId: "stl:typed-c1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "typed:conflict",
				settlementId: "stl:typed-c2",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "contested",
				basis: "first_hand",
				preContestedStance: "accepted",
			});

			const tempSearch = new CognitionSearchService(db);
			const tempHits = tempSearch.searchCognition({ agentId: "rp:alice", kind: "assertion", stance: "contested" });
			const sourceRef = String(tempHits[0].source_ref);
			const rb = new RelationBuilder(db);
			rb.writeContestRelations(sourceRef, ["assertion:99"], "stl:typed-c2", 0.8);

			const retrieval = RetrievalService.create(db);
			const typed = await retrieval.generateTypedRetrieval(
				"trusts",
				viewer({ viewer_agent_id: "rp:alice" }),
				undefined,
				{
					cognitionBudget: 0,
					narrativeBudget: 0,
					conflictNotesBudget: 1,
					episodeBudget: 0,
				},
			);

			expect(typed.cognition).toHaveLength(0);
			expect(typed.conflict_notes.length).toBeGreaterThanOrEqual(1);

			db.close();
			cleanupDb(dbPath);
		});

		it("strongly deduplicates recent cognition, conversation, cognitionKey, and surfaced narrative", async () => {
			const orchestrator = new RetrievalOrchestrator({
				narrativeService: {
					generateMemoryHints: async () => [
						{
							source_ref: "event:1" as any,
							doc_type: "event",
							scope: "world",
							content: "same narrative",
							score: 0.9,
						},
						{
							source_ref: "fact:2" as any,
							doc_type: "fact",
							scope: "world",
							content: "new narrative",
							score: 0.8,
						},
					],
				} as unknown as NarrativeSearchService,
				cognitionService: {
					searchCognition: () => [
						{
							kind: "assertion",
							basis: "first_hand",
							stance: "accepted",
							source_ref: "cognition_key:dup" as any,
							cognitionKey: "dup",
							content: "already in recent",
							updated_at: 10,
						},
						{
							kind: "assertion",
							basis: "first_hand",
							stance: "accepted",
							source_ref: "cognition_key:dup" as any,
							cognitionKey: "dup",
							content: "duplicate key should drop",
							updated_at: 9,
						},
						{
							kind: "evaluation",
							basis: null,
							stance: null,
							source_ref: "cognition_key:kept" as any,
							cognitionKey: "kept",
							content: "unique cognition",
							updated_at: 8,
						},
					],
				} as unknown as CognitionSearchService,
			});

			const result = await orchestrator.search(
				"recall",
				viewer(),
				"rp_agent",
				{
					cognitionBudget: 3,
					narrativeBudget: 2,
					conflictNotesBudget: 0,
					episodeBudget: 0,
				},
				{
					recentCognitionKeys: new Set(["dup"]),
					recentCognitionTexts: ["already in recent"],
					conversationTexts: ["already in conversation"],
					surfacedNarrativeTexts: ["same narrative"],
				},
			);

			expect(result.typed.cognition).toHaveLength(1);
			expect(result.typed.cognition[0]?.cognitionKey).toBe("kept");
			expect(result.typed.narrative).toHaveLength(1);
			expect(result.typed.narrative[0]?.content).toBe("new narrative");
		});

		it("auto-uplifts conflict_notes budget from contested assertion count", async () => {
			const now = Date.now();
			const orchestrator = new RetrievalOrchestrator({
				narrativeService: {
					generateMemoryHints: async () => [],
				} as unknown as NarrativeSearchService,
				cognitionService: {
					searchCognition: () => [
						{
							kind: "assertion",
							basis: "first_hand",
							stance: "contested",
							source_ref: "assertion:1" as NodeRef,
							cognitionKey: "contested:key",
							content: "contested cognition",
							updated_at: now,
							conflictEvidence: [
								{ targetRef: "assertion:11", strength: 0.9, sourceKind: "system", sourceRef: "test" },
								{ targetRef: "assertion:12", strength: 0.8, sourceKind: "system", sourceRef: "test" },
								{ targetRef: "assertion:13", strength: 0.7, sourceKind: "system", sourceRef: "test" },
								{ targetRef: "assertion:14", strength: 0.6, sourceKind: "system", sourceRef: "test" },
							],
						},
					],
				} as unknown as CognitionSearchService,
			});

			const result = await orchestrator.search(
				"who is lying",
				viewer(),
				"rp_agent",
				{
					cognitionBudget: 0,
					narrativeBudget: 0,
					conflictNotesBudget: 1,
					conflictBoostFactor: 1,
					episodeBudget: 0,
					queryEpisodeBoost: 0,
					sceneEpisodeBoost: 0,
				},
				undefined,
				"default_retrieval",
				3,
			);

			expect(result.typed.conflict_notes).toHaveLength(4);
		});

		it("keeps conflict_notes budget unchanged when conflictBoostFactor is zero", async () => {
			const now = Date.now();
			const orchestrator = new RetrievalOrchestrator({
				narrativeService: {
					generateMemoryHints: async () => [],
				} as unknown as NarrativeSearchService,
				cognitionService: {
					searchCognition: () => [
						{
							kind: "assertion",
							basis: "first_hand",
							stance: "contested",
							source_ref: "assertion:2" as NodeRef,
							cognitionKey: "contested:key:zero",
							content: "contested cognition",
							updated_at: now,
							conflictEvidence: [
								{ targetRef: "assertion:21", strength: 0.9, sourceKind: "system", sourceRef: "test" },
								{ targetRef: "assertion:22", strength: 0.8, sourceKind: "system", sourceRef: "test" },
								{ targetRef: "assertion:23", strength: 0.7, sourceKind: "system", sourceRef: "test" },
							],
						},
					],
				} as unknown as CognitionSearchService,
			});

			const result = await orchestrator.search(
				"who is lying",
				viewer(),
				"rp_agent",
				{
					cognitionBudget: 0,
					narrativeBudget: 0,
					conflictNotesBudget: 1,
					conflictBoostFactor: 0,
					episodeBudget: 0,
					queryEpisodeBoost: 0,
					sceneEpisodeBoost: 0,
				},
				undefined,
				"default_retrieval",
				3,
			);

			expect(result.typed.conflict_notes).toHaveLength(1);
		});

		it("deduplicates cognition hits against active current-projection summary text", async () => {
			const orchestrator = new RetrievalOrchestrator({
				narrativeService: {
					generateMemoryHints: async () => [],
				} as unknown as NarrativeSearchService,
				cognitionService: {
					searchCognition: () => [
						{
							kind: "assertion",
							basis: "first_hand",
							stance: "accepted",
							source_ref: "assertion:31" as NodeRef,
							cognitionKey: "candidate-key",
							content: "Projection duplicate text",
							updated_at: 10,
						},
						{
							kind: "evaluation",
							basis: null,
							stance: null,
							source_ref: "evaluation:32" as NodeRef,
							cognitionKey: "kept-key",
							content: "Unique cognition text",
							updated_at: 9,
						},
					],
				} as unknown as CognitionSearchService,
				currentProjectionReader: {
					getActiveCurrent: () => [
						{
							cognition_key: "projection:key",
							summary_text: "Projection duplicate text",
						},
					],
				} as any,
			});

			const result = await orchestrator.search(
				"recall",
				viewer(),
				"rp_agent",
				{
					cognitionBudget: 2,
					narrativeBudget: 0,
					conflictNotesBudget: 0,
					episodeBudget: 0,
					queryEpisodeBoost: 0,
					sceneEpisodeBoost: 0,
				},
				{
					recentCognitionKeys: new Set(["projection:key"]),
					recentCognitionTexts: ["Projection duplicate text"],
				},
			);

			expect(result.typed.cognition).toHaveLength(1);
			expect(result.typed.cognition[0]?.cognitionKey).toBe("kept-key");
		});

		it("deep_explain strategy increases typed retrieval budgets over default_retrieval", async () => {
			const now = Date.now();
			const stubNarrativeHints: MemoryHint[] = [
				{ source_ref: "fact:1" as NodeRef, doc_type: "fact", scope: "world", content: "narrative fact", score: 1.0 },
				{ source_ref: "entity:1" as NodeRef, doc_type: "entity_summary", scope: "world", content: "narrative entity", score: 0.95 },
				{ source_ref: "event:3" as NodeRef, doc_type: "event", scope: "world", content: "narrative event", score: 0.8 },
			];
			const stubCognitionHits: CognitionHit[] = [
				{
					kind: "assertion",
					basis: "first_hand",
					stance: "accepted",
					source_ref: "assertion:1" as NodeRef,
					cognitionKey: "k1",
					content: "cognition 1",
					updated_at: now,
				},
				{
					kind: "assertion",
					basis: "first_hand",
					stance: "accepted",
					source_ref: "assertion:2" as NodeRef,
					cognitionKey: "k2",
					content: "cognition 2",
					updated_at: now - 1,
				},
				{
					kind: "assertion",
					basis: "first_hand",
					stance: "contested",
					source_ref: "assertion:3" as NodeRef,
					cognitionKey: "k3",
					content: "cognition 3",
					updated_at: now - 2,
					conflictEvidence: [{ targetRef: "assertion:99", strength: 0.7, sourceKind: "system", sourceRef: "test" }],
				},
			];

			const orchestrator = new RetrievalOrchestrator({
				narrativeService: {
					generateMemoryHints: async () => stubNarrativeHints,
				} as unknown as NarrativeSearchService,
				cognitionService: {
					searchCognition: () => stubCognitionHits,
				} as unknown as CognitionSearchService,
			});

			const baseTemplate = {
				cognitionBudget: 1,
				narrativeBudget: 1,
				conflictNotesBudget: 0,
				episodeBudget: 0,
				queryEpisodeBoost: 0,
				sceneEpisodeBoost: 0,
			};

			const defaultResult = await orchestrator.search(
				"recall",
				viewer(),
				"rp_agent",
				baseTemplate,
				undefined,
				"default_retrieval",
			);

			const deepResult = await orchestrator.search(
				"recall",
				viewer(),
				"rp_agent",
				baseTemplate,
				undefined,
				"deep_explain",
			);

			expect(deepResult.typed.cognition.length).toBeGreaterThan(defaultResult.typed.cognition.length);
			expect(deepResult.typed.episode.length).toBeGreaterThanOrEqual(defaultResult.typed.episode.length);
			expect(
				deepResult.typed.narrative.length + deepResult.typed.episode.length,
			).toBeGreaterThan(defaultResult.typed.narrative.length + defaultResult.typed.episode.length);
			expect(deepResult.typed.conflict_notes.length).toBeGreaterThanOrEqual(defaultResult.typed.conflict_notes.length);
		});
	});
});
