import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { RetrievalService } from "../../src/memory/retrieval.js";
import type { ViewerContext } from "../../src/memory/types.js";
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

			const retrieval = new RetrievalService(db);
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

			const retrieval = new RetrievalService(db);
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

			const retrieval = new RetrievalService(db);
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

			const retrieval = new RetrievalService(db);
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
		it("private scope only returns docs matching viewer agent_id", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			storage.syncSearchDoc("private", "private_event:1" as any, "Alice thinks Bob is suspicious", "rp:alice");
			storage.syncSearchDoc("private", "private_event:2" as any, "Bob thinks Alice is kind", "rp:bob");

			const retrieval = new RetrievalService(db);
			const results = await retrieval.searchVisibleNarrative("suspicious", viewer({ viewer_agent_id: "rp:alice" }));

			expect(results.length).toBe(1);
			expect(results[0].content).toContain("suspicious");

			db.close();
			cleanupDb(dbPath);
		});

		it("area scope only returns docs matching viewer location", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			storage.syncSearchDoc("area", "event:1" as any, "A loud crash in the kitchen", undefined, 10);
			storage.syncSearchDoc("area", "event:2" as any, "A loud crash in the garden", undefined, 20);

			const retrieval = new RetrievalService(db);
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

			const retrieval = new RetrievalService(db);
			const alice = await retrieval.searchVisibleNarrative("festival", viewer({ viewer_agent_id: "rp:alice" }));
			const bob = await retrieval.searchVisibleNarrative("festival", viewer({ viewer_agent_id: "rp:bob" }));

			expect(alice.length).toBe(1);
			expect(bob.length).toBe(1);

			db.close();
			cleanupDb(dbPath);
		});

		it("search across all 3 scopes returns combined results", async () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			storage.syncSearchDoc("private", "private_event:1" as any, "Alice privately recalled the moonlit garden", "rp:alice");
			storage.syncSearchDoc("area", "event:1" as any, "The moonlit garden was peaceful", undefined, 1);
			storage.syncSearchDoc("world", "event:2" as any, "A moonlit celebration in the town square");

			const retrieval = new RetrievalService(db);
			const results = await retrieval.searchVisibleNarrative("moonlit", viewer({ viewer_agent_id: "rp:alice", current_area_id: 1 }));

			expect(results.length).toBeGreaterThanOrEqual(2);

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

			const retrieval = new RetrievalService(db);
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

			const retrieval = new RetrievalService(db);
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

			const retrieval = new RetrievalService(db);
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

			const retrieval = new RetrievalService(db);
			const result = retrieval.readByTopic("nonexistent_topic", viewer());

			expect(result.topic).toBeNull();
			expect(result.events).toHaveLength(0);

			db.close();
			cleanupDb(dbPath);
		});
	});
});
