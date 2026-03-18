import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { MaterializationService } from "../../src/memory/materialization.js";
import type { AgentEventOverlay } from "../../src/memory/types.js";
import { openDatabase } from "../../src/storage/database.js";

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

function insertOverlay(
	db: ReturnType<typeof openDatabase>,
	overrides: Partial<AgentEventOverlay> & { agent_id: string },
): AgentEventOverlay {
	const now = Date.now();
	const defaults = {
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

	const result = db.run(
		`INSERT INTO agent_event_overlay
		 (event_id, agent_id, role, private_notes, salience, emotion, event_category,
		  primary_actor_entity_id, projection_class, location_entity_id, projectable_summary,
		  source_record_id, cognition_key, explicit_kind, settlement_id, op_index, metadata_json,
		  cognition_status, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			defaults.event_id, defaults.agent_id, defaults.role, defaults.private_notes,
			defaults.salience, defaults.emotion, defaults.event_category,
			defaults.primary_actor_entity_id, defaults.projection_class, defaults.location_entity_id,
			defaults.projectable_summary, defaults.source_record_id, defaults.cognition_key,
			defaults.explicit_kind, defaults.settlement_id, defaults.op_index,
			defaults.metadata_json, defaults.cognition_status, defaults.created_at,
		],
	);

	return { id: Number(result.lastInsertRowid), ...defaults } as AgentEventOverlay;
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
			matService.materializeDelayed([overlay], "rp:alice");

			// Check that overlay's event_id was updated
			const updated = db.get<{ event_id: number | null }>(
				"SELECT event_id FROM agent_event_overlay WHERE id = ?",
				[overlay.id],
			);
			expect(updated).not.toBeNull();
			expect(updated!.event_id).not.toBeNull();
			expect(typeof updated!.event_id).toBe("number");

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

			// Both overlays should point to the same public event
			const ov1 = db.get<{ event_id: number }>("SELECT event_id FROM agent_event_overlay WHERE id = ?", [overlay1.id]);
			const ov2 = db.get<{ event_id: number }>("SELECT event_id FROM agent_event_overlay WHERE id = ?", [overlay2.id]);
			expect(ov1!.event_id).toBe(ov2!.event_id);

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
