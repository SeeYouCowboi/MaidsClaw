import { describe, expect, it } from "bun:test";
import { AreaWorldProjectionRepo } from "../../src/memory/projection/area-world-projection-repo.js";
import { MEMORY_MIGRATIONS } from "../../src/memory/schema.js";
import { cleanupDb, createTempDb, seedStandardEntities } from "../helpers/memory-test-utils.js";

type AreaCurrentSnapshotRow = {
	agent_id: string;
	area_id: number;
	key: string;
	value_json: string;
	surfacing_classification: string;
	source_type: string;
	updated_at: number;
	valid_time: number | null;
	committed_time: number | null;
};

type WorldCurrentSnapshotRow = {
	key: string;
	value_json: string;
	surfacing_classification: string;
	updated_at: number;
	valid_time: number | null;
	committed_time: number | null;
};

describe("area/world history ledger + replay", () => {
	it("rebuildAreaCurrentFromEvents rebuilds identical current rows after wipe", () => {
		const { db, dbPath } = createTempDb();
		const { locationId } = seedStandardEntities(db);
		const repo = new AreaWorldProjectionRepo(db.raw);

		try {
			const agentId = "rp:alice";
			const areaId = locationId;

			repo.upsertAreaStateCurrent({
				agentId,
				areaId,
				key: "door:status",
				value: { locked: true },
				surfacingClassification: "latent_state_update",
				sourceType: "simulation",
				updatedAt: 1_000,
				validTime: 900,
				committedTime: 1_000,
				settlementId: "stl:area-replay:1",
			});

			repo.upsertAreaStateCurrent({
				agentId,
				areaId,
				key: "door:status",
				value: { locked: false },
				surfacingClassification: "public_manifestation",
				sourceType: "gm",
				updatedAt: 1_200,
				validTime: 1_150,
				committedTime: 1_200,
				settlementId: "stl:area-replay:2",
			});

			repo.upsertAreaStateCurrent({
				agentId,
				areaId,
				key: "room:temperature",
				value: { celsius: 23 },
				surfacingClassification: "latent_state_update",
				sourceType: "system",
				updatedAt: 1_300,
				validTime: 1_250,
				committedTime: 1_300,
				settlementId: "stl:area-replay:3",
			});

			const snapshot = db
				.query<AreaCurrentSnapshotRow>(
					`SELECT agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time
					 FROM area_state_current
					 WHERE agent_id = ? AND area_id = ?
					 ORDER BY key`,
					[agentId, areaId],
				);

			expect(snapshot.length).toBe(2);

			db.run("DELETE FROM area_state_current WHERE agent_id = ? AND area_id = ?", [agentId, areaId]);
			repo.rebuildAreaCurrentFromEvents(agentId, areaId);

			const rebuilt = db
				.query<AreaCurrentSnapshotRow>(
					`SELECT agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time
					 FROM area_state_current
					 WHERE agent_id = ? AND area_id = ?
					 ORDER BY key`,
					[agentId, areaId],
				);

			expect(rebuilt).toEqual(snapshot);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("rebuildWorldCurrentFromEvents rebuilds identical world projection after wipe", () => {
		const { db, dbPath } = createTempDb();
		const repo = new AreaWorldProjectionRepo(db.raw);

		try {
			repo.upsertWorldStateCurrent({
				key: "world:weather",
				value: { weather: "rain" },
				surfacingClassification: "public_manifestation",
				sourceType: "simulation",
				updatedAt: 2_000,
				validTime: 1_900,
				committedTime: 2_000,
				settlementId: "stl:world-replay:1",
			});

			repo.upsertWorldStateCurrent({
				key: "world:weather",
				value: { weather: "clear" },
				surfacingClassification: "public_manifestation",
				sourceType: "gm",
				updatedAt: 2_300,
				validTime: 2_250,
				committedTime: 2_300,
				settlementId: "stl:world-replay:2",
			});

			repo.upsertWorldStateCurrent({
				key: "world:season",
				value: { season: "spring" },
				surfacingClassification: "public_manifestation",
				sourceType: "system",
				updatedAt: 2_400,
				validTime: 2_350,
				committedTime: 2_400,
				settlementId: "stl:world-replay:3",
			});

			const snapshot = db
				.query<WorldCurrentSnapshotRow>(
					`SELECT key, value_json, surfacing_classification, updated_at, valid_time, committed_time
					 FROM world_state_current
					 ORDER BY key`,
				);

			expect(snapshot.length).toBe(2);

			db.run("DELETE FROM world_state_current");
			repo.rebuildWorldCurrentFromEvents();

			const rebuilt = db
				.query<WorldCurrentSnapshotRow>(
					`SELECT key, value_json, surfacing_classification, updated_at, valid_time, committed_time
					 FROM world_state_current
					 ORDER BY key`,
				);

			expect(rebuilt).toEqual(snapshot);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("area/world state event ledgers are append-only", () => {
		const { db, dbPath } = createTempDb();
		const { locationId } = seedStandardEntities(db);
		const repo = new AreaWorldProjectionRepo(db.raw);

		try {
			repo.upsertAreaStateCurrent({
				agentId: "rp:alice",
				areaId: locationId,
				key: "drawer:letter",
				value: { exists: true },
				surfacingClassification: "latent_state_update",
				updatedAt: 3_000,
				validTime: 2_900,
				committedTime: 3_000,
				settlementId: "stl:append-only:area",
			});

			repo.upsertWorldStateCurrent({
				key: "world:decree",
				value: { active: true },
				surfacingClassification: "public_manifestation",
				updatedAt: 3_100,
				validTime: 3_050,
				committedTime: 3_100,
				settlementId: "stl:append-only:world",
			});

			const areaEvent = db.get<{ id: number }>(
				"SELECT id FROM area_state_events WHERE settlement_id = ?",
				["stl:append-only:area"],
			);
			const worldEvent = db.get<{ id: number }>(
				"SELECT id FROM world_state_events WHERE settlement_id = ?",
				["stl:append-only:world"],
			);

			expect(areaEvent?.id).toBeGreaterThan(0);
			expect(worldEvent?.id).toBeGreaterThan(0);

			expect(() =>
				db.run("UPDATE area_state_events SET value_json = ? WHERE id = ?", ['{"exists":false}', areaEvent!.id]),
			).toThrow("append-only");
			expect(() => db.run("DELETE FROM area_state_events WHERE id = ?", [areaEvent!.id])).toThrow(
				"append-only",
			);

			expect(() =>
				db.run("UPDATE world_state_events SET value_json = ? WHERE id = ?", ['{"active":false}', worldEvent!.id]),
			).toThrow("append-only");
			expect(() => db.run("DELETE FROM world_state_events WHERE id = ?", [worldEvent!.id])).toThrow(
				"append-only",
			);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("memory:035 migration is idempotent and creates all event append-only triggers", () => {
		const { db, dbPath } = createTempDb();

		try {
			const migration035 = MEMORY_MIGRATIONS.find(
				(migration) => migration.id === "memory:035:create-area-world-state-events",
			);
			expect(migration035).toBeDefined();
			if (!migration035) {
				throw new Error("memory:035 migration not found");
			}

			migration035.up(db);
			migration035.up(db);

			const tableNames = db
				.query<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('area_state_events', 'world_state_events') ORDER BY name",
				)
				.map((row) => row.name);

			expect(tableNames).toEqual(["area_state_events", "world_state_events"]);

			const triggerNames = db
				.query<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('trg_area_state_events_no_update', 'trg_area_state_events_no_delete', 'trg_world_state_events_no_update', 'trg_world_state_events_no_delete') ORDER BY name",
				)
				.map((row) => row.name);

			expect(triggerNames).toEqual([
				"trg_area_state_events_no_delete",
				"trg_area_state_events_no_update",
				"trg_world_state_events_no_delete",
				"trg_world_state_events_no_update",
			]);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("upsertAreaStateCurrent dual-writes events and current rows", () => {
		const { db, dbPath } = createTempDb();
		const { locationId } = seedStandardEntities(db);
		const repo = new AreaWorldProjectionRepo(db.raw);

		try {
			const settlementId = "stl:dual-write:area:1";

			repo.upsertAreaStateCurrent({
				agentId: "rp:alice",
				areaId: locationId,
				key: "chandelier:state",
				value: { lit: true },
				surfacingClassification: "public_manifestation",
				sourceType: "system",
				updatedAt: 4_000,
				validTime: 3_950,
				committedTime: 4_000,
				settlementId,
			});

			const eventRow = db.get<{
				agent_id: string;
				area_id: number;
				key: string;
				settlement_id: string;
				committed_time: number;
			}>(
				`SELECT agent_id, area_id, key, settlement_id, committed_time
				 FROM area_state_events
				 WHERE agent_id = ? AND area_id = ? AND key = ?
				 ORDER BY id DESC
				 LIMIT 1`,
				["rp:alice", locationId, "chandelier:state"],
			);

			const currentRow = db.get<AreaCurrentSnapshotRow>(
				`SELECT agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time
				 FROM area_state_current
				 WHERE agent_id = ? AND area_id = ? AND key = ?`,
				["rp:alice", locationId, "chandelier:state"],
			);

			expect(eventRow).not.toBeNull();
			expect(eventRow?.settlement_id).toBe(settlementId);
			expect(eventRow?.committed_time).toBe(4_000);

			expect(currentRow).not.toBeNull();
			expect(currentRow?.key).toBe("chandelier:state");
			expect(currentRow?.updated_at).toBe(4_000);
			expect(currentRow?.committed_time).toBe(4_000);
		} finally {
			cleanupDb(db, dbPath);
		}
	});
});
