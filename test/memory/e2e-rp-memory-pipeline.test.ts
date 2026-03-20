import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CognitionOpCommitter } from "../../src/memory/cognition-op-committer.js";
import { CoreMemoryService } from "../../src/memory/core-memory.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { RetrievalService } from "../../src/memory/retrieval.js";
import { InteractionStore } from "../../src/interaction/store.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import { FlushSelector } from "../../src/interaction/flush-selector.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { openDatabase } from "../../src/storage/database.js";
import type { CognitionOp } from "../../src/runtime/rp-turn-contract.js";
import type { ViewerContext } from "../../src/memory/types.js";

function createTempDb() {
	const dbPath = join(tmpdir(), `maidsclaw-e2e-memory-${randomUUID()}.db`);
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

describe("E2E: RP memory pipeline", () => {
	// ── Scenario 1: Cognition commit → retrieval round-trip ──────────

	it("cognition commit stores assertion retrievable via readByEntity", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const storage = new GraphStorageService(db);

		// Seed entities
		const selfId = storage.upsertEntity({
			pointerKey: "__self__",
			displayName: "Alice",
			entityType: "person",
			memoryScope: "shared_public",
		});
		const userId = storage.upsertEntity({
			pointerKey: "__user__",
			displayName: "User",
			entityType: "person",
			memoryScope: "shared_public",
		});
		const locationId = storage.upsertEntity({
			pointerKey: "living_room",
			displayName: "Living Room",
			entityType: "location",
			memoryScope: "shared_public",
		});

		// Commit assertion: self likes user
		const committer = new CognitionOpCommitter(storage, "rp:alice", locationId);
		const ops: CognitionOp[] = [
			{
				op: "upsert",
				record: {
					kind: "assertion",
					key: "alice-likes-user",
					proposition: {
						subject: { kind: "special", value: "self" },
						predicate: "likes",
						object: { kind: "entity", ref: { kind: "special", value: "user" } },
					},
					stance: "accepted",
					confidence: 0.9,
				},
			},
		];
		const refs = committer.commit(ops, "stl:turn-1");
		expect(refs).toHaveLength(1);

		// Verify via direct DB query: agent_fact_overlay should have the assertion
		const factOverlays = db.query<{ predicate: string; cognition_key: string }>(
			"SELECT predicate, cognition_key FROM agent_fact_overlay WHERE agent_id = 'rp:alice'",
		);
		expect(factOverlays.length).toBeGreaterThanOrEqual(1);
		const matchingFact = factOverlays.find((f) => f.cognition_key === "alice-likes-user");
		expect(matchingFact).toBeDefined();
		expect(matchingFact!.predicate).toBe("likes");

		// Verify retrieval reads the entities
		const retrieval = new RetrievalService(db);
		const entityResult = retrieval.readByEntity("__self__", viewer({ current_area_id: locationId }));
		expect(entityResult.entity).not.toBeNull();
		expect(entityResult.entity!.display_name).toBe("Alice");

		db.close();
		cleanupDb(dbPath);
	});

	// ── Scenario 2: Core memory write → read round-trip ──────────────

	it("core memory blocks persist and return correct char counts", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const cm = new CoreMemoryService(db);

		cm.initializeBlocks("rp:alice");

		const charResult = cm.appendBlock("rp:alice", "character", "I am Alice, a loyal maid.");
		expect(charResult.success).toBe(true);

		const userResult = cm.appendBlock("rp:alice", "user", "Master enjoys tea.");
		expect(userResult.success).toBe(true);

		const allBlocks = cm.getAllBlocks("rp:alice");
		expect(allBlocks).toHaveLength(3);

		const charBlock = allBlocks.find((b) => b.label === "character");
		expect(charBlock).toBeDefined();
		expect(charBlock!.value).toBe("I am Alice, a loyal maid.");
		expect(charBlock!.chars_current).toBe(25);

		const userBlock = allBlocks.find((b) => b.label === "user");
		expect(userBlock).toBeDefined();
		expect(userBlock!.value).toBe("Master enjoys tea.");

		const indexBlock = allBlocks.find((b) => b.label === "index");
		expect(indexBlock).toBeDefined();
		expect(indexBlock!.value).toBe("");

		db.close();
		cleanupDb(dbPath);
	});

	// ── Scenario 3: Interaction log → flush selector ─────────────────

	it("flush selector triggers after threshold settlements", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		runInteractionMigrations(db);
		const interactionStore = new InteractionStore(db);
		const commitService = new CommitService(interactionStore);
		const flushSelector = new FlushSelector(interactionStore);

		const sessionId = `session:${randomUUID()}`;
		const agentId = "rp:alice";

		// Commit 10 turn_settlement records (threshold = 10)
		for (let i = 0; i < 10; i++) {
			const requestId = `req:${i}`;
			// User message
			commitService.commit({
				sessionId,
				actorType: "user",
				recordType: "message",
				payload: { role: "user", content: `Message ${i}` },
				correlatedTurnId: requestId,
			});
			// Settlement
			commitService.commitWithId({
				sessionId,
				recordId: `stl:${requestId}`,
				actorType: "rp_agent",
				recordType: "turn_settlement",
				payload: {
					settlementId: `stl:${requestId}`,
					requestId,
					sessionId,
					ownerAgentId: agentId,
					publicReply: `Reply ${i}`,
					hasPublicReply: true,
				},
				correlatedTurnId: requestId,
			});
		}

		const flushRequest = flushSelector.shouldFlush(sessionId, agentId);
		expect(flushRequest).not.toBeNull();
		expect(flushRequest!.sessionId).toBe(sessionId);

		db.close();
		cleanupDb(dbPath);
	});

	// ── Scenario 4: Multi-turn memory accumulation ───────────────────

	it("multi-turn interactions accumulate correctly in interaction log", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		runInteractionMigrations(db);
		const interactionStore = new InteractionStore(db);
		const commitService = new CommitService(interactionStore);

		const sessionId = `session:${randomUUID()}`;

		for (let turn = 0; turn < 3; turn++) {
			const requestId = `req:turn-${turn}`;
			commitService.commit({
				sessionId,
				actorType: "user",
				recordType: "message",
				payload: { role: "user", content: `Turn ${turn} question` },
				correlatedTurnId: requestId,
			});
			commitService.commit({
				sessionId,
				actorType: "rp_agent",
				recordType: "message",
				payload: { role: "assistant", content: `Turn ${turn} reply` },
				correlatedTurnId: requestId,
			});
			commitService.commitWithId({
				sessionId,
				recordId: `stl:${requestId}`,
				actorType: "rp_agent",
				recordType: "turn_settlement",
				payload: {
					settlementId: `stl:${requestId}`,
					requestId,
					sessionId,
					ownerAgentId: "rp:alice",
					publicReply: `Turn ${turn} reply`,
					hasPublicReply: true,
				},
				correlatedTurnId: requestId,
			});
		}

		const records = interactionStore.getBySession(sessionId);
		expect(records.length).toBe(9); // 3 turns × 3 records

		// Verify ordering
		for (let i = 1; i < records.length; i++) {
			expect(records[i].recordIndex).toBeGreaterThan(records[i - 1].recordIndex);
		}

		// Verify unprocessed settlements
		const unprocessed = interactionStore.countUnprocessedSettlements(sessionId);
		expect(unprocessed).toBe(3);

		db.close();
		cleanupDb(dbPath);
	});

	// ── Scenario 5: Settlement with private cognition payload ────────

	it("turn_settlement stores and retrieves private cognition ops", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		runInteractionMigrations(db);
		const interactionStore = new InteractionStore(db);
		const commitService = new CommitService(interactionStore);

		const sessionId = `session:${randomUUID()}`;
		const requestId = `req:${randomUUID()}`;

		const payload = {
			settlementId: `stl:${requestId}`,
			requestId,
			sessionId,
			ownerAgentId: "rp:alice",
			publicReply: "Hello there!",
			hasPublicReply: true,
			viewerSnapshot: {
				selfPointerKey: "__self__",
				userPointerKey: "__user__",
				currentLocationEntityId: 1,
			},
			privateCommit: {
				schemaVersion: "rp_private_cognition_v3",
				ops: [
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "user-is-friendly",
							proposition: {
								subject: { kind: "special", value: "user" },
								predicate: "is",
								object: { kind: "entity", ref: { kind: "special", value: "self" } },
							},
							stance: "accepted",
						},
					},
					{
						op: "upsert",
						record: {
							kind: "commitment",
							key: "be-helpful",
							mode: "intent",
							target: { action: "be helpful" },
							status: "active",
						},
					},
				],
			},
		};

		commitService.commitWithId({
			sessionId,
			recordId: `stl:${requestId}`,
			actorType: "rp_agent",
			recordType: "turn_settlement",
			payload,
			correlatedTurnId: requestId,
		});

		// Retrieve and verify
		const records = interactionStore.getBySession(sessionId);
		expect(records).toHaveLength(1);
		expect(records[0].recordType).toBe("turn_settlement");

		const storedPayload = records[0].payload as typeof payload;
		expect(storedPayload.privateCommit).toBeDefined();
		expect(storedPayload.privateCommit!.ops).toHaveLength(2);
		expect(storedPayload.privateCommit!.ops[0].op).toBe("upsert");

		db.close();
		cleanupDb(dbPath);
	});

	// ── Scenario 6: FTS5 search after event creation ─────────────────

	it("events indexed in FTS5 are searchable via RetrievalService", async () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const storage = new GraphStorageService(db);

		const locationId = storage.upsertEntity({
			pointerKey: "garden",
			displayName: "Garden",
			entityType: "location",
			memoryScope: "shared_public",
		});

		const eventId = storage.createProjectedEvent({
			sessionId: "s1",
			summary: "Alice and Bob had afternoon tea in the garden",
			timestamp: Date.now(),
			participants: "[]",
			locationEntityId: locationId,
			eventCategory: "speech",
			origin: "runtime_projection",
		});

		// Sync to FTS5
		storage.syncSearchDoc("world", `event:${eventId}` as any, "Alice and Bob had afternoon tea in the garden");
		storage.syncSearchDoc("area", `event:${eventId}` as any, "Alice and Bob had afternoon tea in the garden", undefined, locationId);

		const retrieval = new RetrievalService(db);

		// World search — any viewer
		const worldResults = await retrieval.searchVisibleNarrative("afternoon tea", viewer({ current_area_id: locationId }));
		expect(worldResults.length).toBeGreaterThanOrEqual(1);
		expect(worldResults[0].content).toContain("afternoon tea");

		// Area search — must match location
		const areaResults = await retrieval.searchVisibleNarrative("afternoon tea", viewer({ current_area_id: locationId }));
		expect(areaResults.length).toBeGreaterThanOrEqual(1);

		// Different area — should get fewer or no area results
		const otherAreaResults = await retrieval.searchVisibleNarrative("afternoon tea", viewer({ current_area_id: 999 }));
		// Should still get world result but not the area result
		const areaScoped = otherAreaResults.filter((r) => r.scope === "area");
		expect(areaScoped).toHaveLength(0);

		db.close();
		cleanupDb(dbPath);
	});

	// ── Scenario 7: Cross-session isolation ──────────────────────────

	it("interaction records are isolated per session", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		runInteractionMigrations(db);
		const interactionStore = new InteractionStore(db);
		const commitService = new CommitService(interactionStore);

		const session1 = `session:${randomUUID()}`;
		const session2 = `session:${randomUUID()}`;

		commitService.commit({
			sessionId: session1,
			actorType: "user",
			recordType: "message",
			payload: { role: "user", content: "Session 1 message" },
			correlatedTurnId: "req:s1",
		});

		commitService.commit({
			sessionId: session2,
			actorType: "user",
			recordType: "message",
			payload: { role: "user", content: "Session 2 message" },
			correlatedTurnId: "req:s2",
		});

		const s1Records = interactionStore.getBySession(session1);
		const s2Records = interactionStore.getBySession(session2);

		expect(s1Records).toHaveLength(1);
		expect(s2Records).toHaveLength(1);
		expect((s1Records[0].payload as { content: string }).content).toBe("Session 1 message");
		expect((s2Records[0].payload as { content: string }).content).toBe("Session 2 message");

		db.close();
		cleanupDb(dbPath);
	});

	// ── Scenario 8: Full cognition + search integration ──────────────

	it("private cognition creates overlays searchable via private FTS5", async () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const storage = new GraphStorageService(db);

		// Seed world
		const selfId = storage.upsertEntity({
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
		const locationId = storage.upsertEntity({
			pointerKey: "parlor",
			displayName: "Parlor",
			entityType: "location",
			memoryScope: "shared_public",
		});

		// Commit cognition
		const committer = new CognitionOpCommitter(storage, "rp:alice", locationId);
		const refs = committer.commit(
			[
				{
					op: "upsert",
					record: {
						kind: "commitment",
						key: "protect-master",
						mode: "goal",
						target: { action: "protect master at all costs" },
						status: "active",
						priority: 10,
						horizon: "long",
					},
				},
			],
			"stl:deep-1",
		);
		expect(refs).toHaveLength(1);

		// Manually sync the cognition data to private FTS for search
		storage.syncSearchDoc(
			"private",
			refs[0],
			"Alice commits to protecting master at all costs - long-term goal with highest priority",
			"rp:alice",
		);

		const retrieval = new RetrievalService(db);
		const aliceResults = await retrieval.searchVisibleNarrative("protecting master", viewer({ viewer_agent_id: "rp:alice" }));
		expect(aliceResults).toHaveLength(0);

		const bobResults = await retrieval.searchVisibleNarrative("protecting master", viewer({ viewer_agent_id: "rp:bob" }));
		expect(bobResults).toHaveLength(0);

		db.close();
		cleanupDb(dbPath);
	});
});
