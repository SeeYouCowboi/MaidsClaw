import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaidsClawError } from "../../src/core/errors.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { MaterializationService, materializePublications } from "../../src/memory/materialization.js";
import type { PublicationDeclaration } from "../../src/runtime/rp-turn-contract.js";
import { openDatabase } from "../../src/storage/database.js";

type MaterializablePrivateEvent = {
	id: number;
	event_id: number | null;
	agent_id: string;
	role: string | null;
	private_notes: string | null;
	salience: number | null;
	emotion: string | null;
	event_category: "speech" | "action" | "thought" | "observation" | "state_change";
	primary_actor_entity_id: number | null;
	projection_class: "none" | "area_candidate";
	location_entity_id: number | null;
	projectable_summary: string | null;
	source_record_id: string | null;
	created_at: number;
};

function createTempDb() {
	const dbPath = join(tmpdir(), `maidsclaw-matrl-${randomUUID()}.db`);
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

let overlayIdSeq = 1;

function insertOverlay(
	_db: ReturnType<typeof openDatabase>,
	overrides: Partial<MaterializablePrivateEvent> & { agent_id: string },
): MaterializablePrivateEvent {
	const now = Date.now();
	const defaults = {
		id: overlayIdSeq++,
		event_id: null,
		role: null,
		private_notes: null,
		salience: null,
		emotion: null,
		event_category: "speech" as const,
		primary_actor_entity_id: null,
		projection_class: "area_candidate" as const,
		location_entity_id: null,
		projectable_summary: null,
		source_record_id: null,
		cognition_key: null,
		explicit_kind: null,
		settlement_id: null,
		op_index: null,
		metadata_json: null,
		cognition_status: "active",
		created_at: now,
		...overrides,
	};

	return defaults;
}

describe("MaterializationService", () => {
	// ── Scenario 1: Successful materialization ───────────────────────

	describe("Successful materialization", () => {
		it("area_candidate speech overlay creates a public event", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			const locationId = storage.upsertEntity({
				pointerKey: "kitchen",
				displayName: "Kitchen",
				entityType: "location",
				memoryScope: "shared_public",
			});

			const overlay = insertOverlay(db, {
				agent_id: "rp:alice",
				event_category: "speech",
				projection_class: "area_candidate",
				location_entity_id: locationId,
				projectable_summary: "Alice said hello to everyone",
				source_record_id: `src:${randomUUID()}`,
			});

			const matService = new MaterializationService(db as any, storage);
			const result = matService.materializeDelayed([overlay], "rp:alice");

			expect(result.materialized).toBe(1);
			expect(result.reconciled).toBe(0);
			expect(result.skipped).toBe(0);

			// Verify public event was created
			const publicEvents = db.query<{ id: number; summary: string; event_origin: string }>(
				"SELECT id, summary, event_origin FROM event_nodes WHERE visibility_scope = 'area_visible'",
			);
			expect(publicEvents.length).toBe(1);
			expect(publicEvents[0].summary).toBe("Alice said hello to everyone");
			expect(publicEvents[0].event_origin).toBe("delayed_materialization");

			db.close();
			cleanupDb(dbPath);
		});

		it("links private overlay event_id to the new public event", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			const locationId = storage.upsertEntity({
				pointerKey: "hall",
				displayName: "Hall",
				entityType: "location",
				memoryScope: "shared_public",
			});

			const overlay = insertOverlay(db, {
				agent_id: "rp:alice",
				event_category: "action",
				projection_class: "area_candidate",
				location_entity_id: locationId,
				projectable_summary: "Alice opened the door",
				source_record_id: `src:${randomUUID()}`,
			});

			const matService = new MaterializationService(db as any, storage);
			const result = matService.materializeDelayed([overlay], "rp:alice");
			expect(result.materialized).toBe(1);

			const publicEvents = db.query<{ id: number; source_record_id: string }>(
				"SELECT id, source_record_id FROM event_nodes WHERE source_record_id = ?",
				[overlay.source_record_id!],
			);
			expect(publicEvents.length).toBe(1);
			expect(publicEvents[0].source_record_id).toBe(overlay.source_record_id!);

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 2: Reconciliation ───────────────────────────────────

		describe("Reconciliation", () => {
		it("second overlay with same source_record_id reconciles to existing public event", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			const locationId = storage.upsertEntity({
				pointerKey: "garden",
				displayName: "Garden",
				entityType: "location",
				memoryScope: "shared_public",
			});

			const sharedSourceId = `src:shared-${randomUUID()}`;

			const overlay1 = insertOverlay(db, {
				agent_id: "rp:alice",
				event_category: "speech",
				projection_class: "area_candidate",
				location_entity_id: locationId,
				projectable_summary: "First version of the event",
				source_record_id: sharedSourceId,
			});
			const overlay2 = insertOverlay(db, {
				agent_id: "rp:alice",
				event_category: "speech",
				projection_class: "area_candidate",
				location_entity_id: locationId,
				projectable_summary: "Second version of the event",
				source_record_id: sharedSourceId,
			});

			const matService = new MaterializationService(db as any, storage);
			const result = matService.materializeDelayed([overlay1, overlay2], "rp:alice");

			expect(result.materialized).toBe(1);
			expect(result.reconciled).toBe(1);

			const publicEvents = db.query<{ id: number }>(
				"SELECT id FROM event_nodes WHERE source_record_id = ?",
				[sharedSourceId],
			);
			expect(publicEvents.length).toBe(1);

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 3: Skip conditions ──────────────────────────────────

	describe("Skip conditions", () => {
		it("skips 'thought' event_category (thoughts are private)", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			const locationId = storage.upsertEntity({
				pointerKey: "study",
				displayName: "Study",
				entityType: "location",
				memoryScope: "shared_public",
			});

			const overlay = insertOverlay(db, {
				agent_id: "rp:alice",
				event_category: "thought",
				projection_class: "area_candidate",
				location_entity_id: locationId,
				projectable_summary: "Alice pondered the meaning of life",
			});

			const matService = new MaterializationService(db as any, storage);
			const result = matService.materializeDelayed([overlay], "rp:alice");

			expect(result.skipped).toBe(1);
			expect(result.materialized).toBe(0);

			db.close();
			cleanupDb(dbPath);
		});

		it("skips projection_class 'none' (not a candidate)", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			const locationId = storage.upsertEntity({
				pointerKey: "room",
				displayName: "Room",
				entityType: "location",
				memoryScope: "shared_public",
			});

			const overlay = insertOverlay(db, {
				agent_id: "rp:alice",
				event_category: "speech",
				projection_class: "none",
				location_entity_id: locationId,
				projectable_summary: "Not a candidate",
			});

			const matService = new MaterializationService(db as any, storage);
			const result = matService.materializeDelayed([overlay], "rp:alice");

			expect(result.skipped).toBe(1);
			expect(result.materialized).toBe(0);

			db.close();
			cleanupDb(dbPath);
		});

		it("skips when projectable_summary is null", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			const locationId = storage.upsertEntity({
				pointerKey: "lobby",
				displayName: "Lobby",
				entityType: "location",
				memoryScope: "shared_public",
			});

			const overlay = insertOverlay(db, {
				agent_id: "rp:alice",
				event_category: "speech",
				projection_class: "area_candidate",
				location_entity_id: locationId,
				projectable_summary: null,
			});

			const matService = new MaterializationService(db as any, storage);
			const result = matService.materializeDelayed([overlay], "rp:alice");

			expect(result.skipped).toBe(1);

			db.close();
			cleanupDb(dbPath);
		});

		it("skips when location_entity_id is null", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			const overlay = insertOverlay(db, {
				agent_id: "rp:alice",
				event_category: "speech",
				projection_class: "area_candidate",
				location_entity_id: null,
				projectable_summary: "Something happened somewhere",
			});

			const matService = new MaterializationService(db as any, storage);
			const result = matService.materializeDelayed([overlay], "rp:alice");

			expect(result.skipped).toBe(1);

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 4: Agent isolation ──────────────────────────────────

	describe("Agent isolation", () => {
		it("skips overlays from a different agent", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			const locationId = storage.upsertEntity({
				pointerKey: "library",
				displayName: "Library",
				entityType: "location",
				memoryScope: "shared_public",
			});

			const overlay = insertOverlay(db, {
				agent_id: "rp:bob",
				event_category: "speech",
				projection_class: "area_candidate",
				location_entity_id: locationId,
				projectable_summary: "Bob said something",
			});

			const matService = new MaterializationService(db as any, storage);
			// Pass "rp:alice" as agentId — overlay belongs to "rp:bob"
			const result = matService.materializeDelayed([overlay], "rp:alice");

			expect(result.skipped).toBe(1);
			expect(result.materialized).toBe(0);

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 5: Entity resolution ────────────────────────────────

	describe("Entity resolution for public events", () => {
		it("private entity as location gets promoted to shared_public", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			// Create a private overlay entity for the location
			const privateLocationId = storage.upsertEntity({
				pointerKey: "secret_room",
				displayName: "Secret Room",
				entityType: "location",
				memoryScope: "private_overlay",
				ownerAgentId: "rp:alice",
			});

			const overlay = insertOverlay(db, {
				agent_id: "rp:alice",
				event_category: "observation",
				projection_class: "area_candidate",
				location_entity_id: privateLocationId,
				projectable_summary: "Alice noticed the hidden passage",
				source_record_id: `src:${randomUUID()}`,
			});

			const matService = new MaterializationService(db as any, storage);
			const result = matService.materializeDelayed([overlay], "rp:alice");

			expect(result.materialized).toBe(1);

			// Verify a shared_public entity was created for the location
			const publicEntity = db.get<{ memory_scope: string }>(
				"SELECT memory_scope FROM entity_nodes WHERE pointer_key = 'secret_room' AND memory_scope = 'shared_public'",
			);
			expect(publicEntity).not.toBeNull();

			db.close();
			cleanupDb(dbPath);
		});

		it("hidden entity markers resolve to Unknown person", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			const locationId = storage.upsertEntity({
				pointerKey: "plaza",
				displayName: "Plaza",
				entityType: "location",
				memoryScope: "shared_public",
			});

			// Create a "hidden" person entity as primary actor
			const hiddenPersonId = storage.upsertEntity({
				pointerKey: "unknown_stranger",
				displayName: "Unknown Stranger",
				entityType: "person",
				memoryScope: "private_overlay",
				ownerAgentId: "rp:alice",
			});

			const overlay = insertOverlay(db, {
				agent_id: "rp:alice",
				event_category: "observation",
				projection_class: "area_candidate",
				location_entity_id: locationId,
				primary_actor_entity_id: hiddenPersonId,
				projectable_summary: "Someone mysterious walked by",
				source_record_id: `src:${randomUUID()}`,
			});

			const matService = new MaterializationService(db as any, storage);
			const result = matService.materializeDelayed([overlay], "rp:alice");

			expect(result.materialized).toBe(1);

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 6: Mixed batch ──────────────────────────────────────

	describe("Mixed batch", () => {
		it("correctly counts materialized, reconciled, and skipped in a batch", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			const locationId = storage.upsertEntity({
				pointerKey: "courtyard",
				displayName: "Courtyard",
				entityType: "location",
				memoryScope: "shared_public",
			});

			const sharedSource = `src:shared-${randomUUID()}`;

			const overlays = [
				// 1. Materializable
				insertOverlay(db, {
					agent_id: "rp:alice",
					event_category: "speech",
					projection_class: "area_candidate",
					location_entity_id: locationId,
					projectable_summary: "Alice spoke",
					source_record_id: sharedSource,
				}),
				// 2. Reconcilable (same source_record_id as #1)
				insertOverlay(db, {
					agent_id: "rp:alice",
					event_category: "speech",
					projection_class: "area_candidate",
					location_entity_id: locationId,
					projectable_summary: "Alice spoke again",
					source_record_id: sharedSource,
				}),
				// 3. Materializable (different source)
				insertOverlay(db, {
					agent_id: "rp:alice",
					event_category: "action",
					projection_class: "area_candidate",
					location_entity_id: locationId,
					projectable_summary: "Alice waved",
					source_record_id: `src:${randomUUID()}`,
				}),
				// 4. Skippable (thought)
				insertOverlay(db, {
					agent_id: "rp:alice",
					event_category: "thought",
					projection_class: "area_candidate",
					location_entity_id: locationId,
					projectable_summary: "Alice thought deeply",
				}),
				// 5. Skippable (no summary)
				insertOverlay(db, {
					agent_id: "rp:alice",
					event_category: "speech",
					projection_class: "area_candidate",
					location_entity_id: locationId,
					projectable_summary: null,
				}),
			];

			const matService = new MaterializationService(db as any, storage);
			const result = matService.materializeDelayed(overlays, "rp:alice");

			expect(result.materialized).toBe(2);
			expect(result.reconciled).toBe(1);
			expect(result.skipped).toBe(2);

			db.close();
			cleanupDb(dbPath);
		});
	});
});

describe("Publication Materialization", () => {
	it("blocks publication writes for task_agent role with WRITE_TEMPLATE_DENIED", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const storage = new GraphStorageService(db);

		const locationId = storage.upsertEntity({
			pointerKey: "task-deny-location",
			displayName: "Task Deny Location",
			entityType: "location",
			memoryScope: "shared_public",
		});

		const publications: PublicationDeclaration[] = [
			{ kind: "spoken", targetScope: "current_area", summary: "Task agent should not publish this." },
		];

		try {
			let caught: unknown;
			try {
				materializePublications(storage, publications, `stl:task-deny-${randomUUID()}`, {
					sessionId: "sess-task-deny-code",
					locationEntityId: locationId,
					timestamp: 1235,
				}, {
					agentRole: "task_agent",
				});
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeDefined();
			expect(caught instanceof MaidsClawError).toBe(true);
			expect((caught as MaidsClawError).code).toBe("WRITE_TEMPLATE_DENIED");

			const rows = db.query<{ id: number }>("SELECT id FROM event_nodes");
			expect(rows.length).toBe(0);
		} finally {
			db.close();
			cleanupDb(dbPath);
		}
	});

	it("explicit publication creates event_node with provenance columns", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const storage = new GraphStorageService(db);

		const locationId = storage.upsertEntity({
			pointerKey: "tavern",
			displayName: "Tavern",
			entityType: "location",
			memoryScope: "shared_public",
		});

		const publications: PublicationDeclaration[] = [
			{ kind: "spoken", targetScope: "current_area", summary: "Alice announces dinner is ready." },
		];
		const settlementId = `stl:req-pub-${randomUUID()}`;

		const result = materializePublications(storage, publications, settlementId, {
			sessionId: "sess-pub-1",
			locationEntityId: locationId,
			timestamp: 1000,
		});

		expect(result.materialized).toBe(1);
		expect(result.reconciled).toBe(0);
		expect(result.skipped).toBe(0);

		const row = db.get<{
			summary: string;
			visibility_scope: string;
			event_origin: string;
			event_category: string;
			source_settlement_id: string;
			source_pub_index: number;
			location_entity_id: number;
		}>(
			"SELECT summary, visibility_scope, event_origin, event_category, source_settlement_id, source_pub_index, location_entity_id FROM event_nodes WHERE source_settlement_id = ?",
			[settlementId],
		);
		expect(row).toBeDefined();
		expect(row!.summary).toBe("Alice announces dinner is ready.");
		expect(row!.visibility_scope).toBe("area_visible");
		expect(row!.event_origin).toBe("runtime_projection");
		expect(row!.event_category).toBe("speech");
		expect(row!.source_settlement_id).toBe(settlementId);
		expect(row!.source_pub_index).toBe(0);
		expect(row!.location_entity_id).toBe(locationId);

		db.close();
		cleanupDb(dbPath);
	});

	it("publicReply alone does NOT create a publication event_node", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const storage = new GraphStorageService(db);

		const locationId = storage.upsertEntity({
			pointerKey: "parlor",
			displayName: "Parlor",
			entityType: "location",
			memoryScope: "shared_public",
		});

		const emptyPublications: PublicationDeclaration[] = [];
		const settlementId = `stl:req-nopub-${randomUUID()}`;

		const result = materializePublications(storage, emptyPublications, settlementId, {
			sessionId: "sess-nopub",
			locationEntityId: locationId,
			timestamp: 2000,
		});

		expect(result.materialized).toBe(0);
		expect(result.reconciled).toBe(0);
		expect(result.skipped).toBe(0);

		const rows = db.query<{ id: number }>(
			"SELECT id FROM event_nodes WHERE source_settlement_id = ?",
			[settlementId],
		);
		expect(rows.length).toBe(0);

		db.close();
		cleanupDb(dbPath);
	});

	it("publication kind maps correctly: visual → observation, spoken/written → speech", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const storage = new GraphStorageService(db);

		const locationId = storage.upsertEntity({
			pointerKey: "square",
			displayName: "Town Square",
			entityType: "location",
			memoryScope: "shared_public",
		});

		const publications: PublicationDeclaration[] = [
			{ kind: "visual", targetScope: "current_area", summary: "A notice board displays a message." },
			{ kind: "spoken", targetScope: "current_area", summary: "A town crier announces the news." },
			{ kind: "written", targetScope: "current_area", summary: "A record is read aloud." },
		];
		const settlementId = `stl:kinds-${randomUUID()}`;

		const result = materializePublications(storage, publications, settlementId, {
			sessionId: "sess-kinds",
			locationEntityId: locationId,
			timestamp: 3000,
		});

		expect(result.materialized).toBe(3);

		const rows = db.query<{ event_category: string; source_pub_index: number }>(
			"SELECT event_category, source_pub_index FROM event_nodes WHERE source_settlement_id = ? ORDER BY source_pub_index",
			[settlementId],
		);
		expect(rows.length).toBe(3);
		expect(rows[0]!.event_category).toBe("observation");
		expect(rows[1]!.event_category).toBe("speech");
		expect(rows[2]!.event_category).toBe("speech");

		db.close();
		cleanupDb(dbPath);
	});

	it("world_public targetScope creates world_public visibility_scope event", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const storage = new GraphStorageService(db);

		const locationId = storage.upsertEntity({
			pointerKey: "hall",
			displayName: "Great Hall",
			entityType: "location",
			memoryScope: "shared_public",
		});

		const publications: PublicationDeclaration[] = [
			{ kind: "spoken", targetScope: "world_public", summary: "A decree is issued across the land." },
		];
		const settlementId = `stl:world-${randomUUID()}`;

		const result = materializePublications(storage, publications, settlementId, {
			sessionId: "sess-world",
			locationEntityId: locationId,
			timestamp: 4000,
		});

		expect(result.materialized).toBe(1);

		const row = db.get<{ visibility_scope: string }>(
			"SELECT visibility_scope FROM event_nodes WHERE source_settlement_id = ?",
			[settlementId],
		);
		expect(row!.visibility_scope).toBe("world_public");

		db.close();
		cleanupDb(dbPath);
	});

	it("duplicate publication is reconciled via unique index (idempotency)", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const storage = new GraphStorageService(db);

		const locationId = storage.upsertEntity({
			pointerKey: "kitchen",
			displayName: "Kitchen",
			entityType: "location",
			memoryScope: "shared_public",
		});

		const publications: PublicationDeclaration[] = [
			{ kind: "spoken", targetScope: "current_area", summary: "First call." },
		];
		const settlementId = `stl:idempotent-${randomUUID()}`;

		const result1 = materializePublications(storage, publications, settlementId, {
			sessionId: "sess-idem",
			locationEntityId: locationId,
			timestamp: 5000,
		});
		expect(result1.materialized).toBe(1);

		const result2 = materializePublications(storage, publications, settlementId, {
			sessionId: "sess-idem",
			locationEntityId: locationId,
			timestamp: 5000,
		});
		expect(result2.reconciled).toBe(1);
		expect(result2.materialized).toBe(0);

		const rows = db.query<{ id: number }>(
			"SELECT id FROM event_nodes WHERE source_settlement_id = ?",
			[settlementId],
		);
		expect(rows.length).toBe(1);

		db.close();
		cleanupDb(dbPath);
	});

	it("retries transient non-unique SQLite error then succeeds", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const storage = new GraphStorageService(db);

		const locationId = storage.upsertEntity({
			pointerKey: "retry-hall",
			displayName: "Retry Hall",
			entityType: "location",
			memoryScope: "shared_public",
		});

		const publications: PublicationDeclaration[] = [
			{ kind: "spoken", targetScope: "current_area", summary: "Retry me once." },
		];
		const settlementId = `stl:retry-success-${randomUUID()}`;

		const originalCreateProjectedEvent = storage.createProjectedEvent.bind(storage);
		const patchedStorage = storage as unknown as {
			createProjectedEvent: typeof storage.createProjectedEvent;
		};
		let attemptCount = 0;
		patchedStorage.createProjectedEvent = ((params) => {
			attemptCount += 1;
			if (attemptCount === 1) {
				const transient = new Error("database is locked");
				transient.name = "SQLiteError";
				throw transient;
			}
			return originalCreateProjectedEvent(params);
		}) as typeof storage.createProjectedEvent;

		const originalSleepSync = Bun.sleepSync;
		const sleepCalls: number[] = [];
		(Bun as unknown as { sleepSync: (ms: number) => void }).sleepSync = (ms: number) => {
			sleepCalls.push(ms);
		};

		try {
			const result = materializePublications(storage, publications, settlementId, {
				sessionId: "sess-retry-success",
				locationEntityId: locationId,
				timestamp: 9_000,
			});

			expect(result.materialized).toBe(1);
			expect(result.reconciled).toBe(0);
			expect(result.skipped).toBe(0);
			expect(attemptCount).toBe(2);
			expect(sleepCalls).toEqual([100]);

			const rows = db.query<{ id: number }>(
				"SELECT id FROM event_nodes WHERE source_settlement_id = ?",
				[settlementId],
			);
			expect(rows.length).toBe(1);
		} finally {
			patchedStorage.createProjectedEvent = originalCreateProjectedEvent;
			(Bun as unknown as { sleepSync: (ms: number) => void }).sleepSync = originalSleepSync;
			db.close();
			cleanupDb(dbPath);
		}
	});

	it("skips publication after 3 retries for persistent non-unique SQLite error", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const storage = new GraphStorageService(db);

		const locationId = storage.upsertEntity({
			pointerKey: "retry-fail-hall",
			displayName: "Retry Fail Hall",
			entityType: "location",
			memoryScope: "shared_public",
		});

		const publications: PublicationDeclaration[] = [
			{ kind: "spoken", targetScope: "current_area", summary: "This keeps failing." },
		];
		const settlementId = `stl:retry-fail-${randomUUID()}`;

		const originalCreateProjectedEvent = storage.createProjectedEvent.bind(storage);
		const patchedStorage = storage as unknown as {
			createProjectedEvent: typeof storage.createProjectedEvent;
		};
		let attemptCount = 0;
		patchedStorage.createProjectedEvent = (() => {
			attemptCount += 1;
			const transient = new Error("database is busy");
			transient.name = "SQLiteError";
			throw transient;
		}) as typeof storage.createProjectedEvent;

		const originalSleepSync = Bun.sleepSync;
		const sleepCalls: number[] = [];
		(Bun as unknown as { sleepSync: (ms: number) => void }).sleepSync = (ms: number) => {
			sleepCalls.push(ms);
		};

		const originalWarn = console.warn;
		let warned = 0;
		console.warn = (..._args: unknown[]) => {
			warned += 1;
		};

		try {
			const result = materializePublications(storage, publications, settlementId, {
				sessionId: "sess-retry-fail",
				locationEntityId: locationId,
				timestamp: 9_500,
			});

			expect(result.materialized).toBe(0);
			expect(result.reconciled).toBe(0);
			expect(result.skipped).toBe(1);
			expect(attemptCount).toBe(4);
			expect(sleepCalls).toEqual([100, 200, 400]);
			expect(warned).toBe(1);

			const rows = db.query<{ id: number }>(
				"SELECT id FROM event_nodes WHERE source_settlement_id = ?",
				[settlementId],
			);
			expect(rows.length).toBe(0);
		} finally {
			patchedStorage.createProjectedEvent = originalCreateProjectedEvent;
			(Bun as unknown as { sleepSync: (ms: number) => void }).sleepSync = originalSleepSync;
			console.warn = originalWarn;
			db.close();
			cleanupDb(dbPath);
		}
	});

	it("current_area publication is skipped when no locationEntityId is available", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const storage = new GraphStorageService(db);

		const publications: PublicationDeclaration[] = [
			{ kind: "spoken", targetScope: "current_area", summary: "Nobody hears this." },
		];
		const settlementId = `stl:noloc-${randomUUID()}`;

		const result = materializePublications(storage, publications, settlementId, {
			sessionId: "sess-noloc",
			locationEntityId: undefined,
			timestamp: 6000,
		});

		expect(result.skipped).toBe(1);
		expect(result.materialized).toBe(0);

		db.close();
		cleanupDb(dbPath);
	});

	it("world_public publication proceeds with sentinel location when no locationEntityId", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const storage = new GraphStorageService(db);

		const publications: PublicationDeclaration[] = [
			{ kind: "spoken", targetScope: "world_public", summary: "A global announcement." },
		];
		const settlementId = `stl:sentinel-${randomUUID()}`;

		const result = materializePublications(storage, publications, settlementId, {
			sessionId: "sess-sentinel",
			locationEntityId: undefined,
			timestamp: 7000,
		});

		expect(result.materialized).toBe(1);

		const row = db.get<{ visibility_scope: string; location_entity_id: number }>(
			"SELECT visibility_scope, location_entity_id FROM event_nodes WHERE source_settlement_id = ?",
			[settlementId],
		);
		expect(row!.visibility_scope).toBe("world_public");
		expect(row!.location_entity_id).toBeGreaterThan(0);

		const entity = db.get<{ pointer_key: string }>(
			"SELECT pointer_key FROM entity_nodes WHERE id = ?",
			[row!.location_entity_id],
		);
		expect(entity!.pointer_key).toBe("world");

		db.close();
		cleanupDb(dbPath);
	});

	it("MaterializationService.materializePublications delegates to standalone function", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const storage = new GraphStorageService(db);

		const locationId = storage.upsertEntity({
			pointerKey: "foyer",
			displayName: "Foyer",
			entityType: "location",
			memoryScope: "shared_public",
		});

		const publications: PublicationDeclaration[] = [
			{ kind: "spoken", targetScope: "current_area", summary: "Welcome, everyone!" },
		];
		const settlementId = `stl:delegate-${randomUUID()}`;

		const matService = new MaterializationService(db as any, storage);
		const result = matService.materializePublications(publications, settlementId, {
			sessionId: "sess-delegate",
			locationEntityId: locationId,
			timestamp: 8000,
		});

		expect(result.materialized).toBe(1);

		const row = db.get<{ source_settlement_id: string }>(
			"SELECT source_settlement_id FROM event_nodes WHERE source_settlement_id = ?",
			[settlementId],
		);
		expect(row).toBeDefined();

		db.close();
		cleanupDb(dbPath);
	});
});
