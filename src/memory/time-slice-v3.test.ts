import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createMemorySchema } from "./schema";

function freshDb(): Database {
	const db = new Database(":memory:");
	createMemorySchema(db);
	return db;
}

// ── Time-Slice Dual-Dimension: valid_time + committed_time ──────────────────

describe("time-slice dual-dimension — area_state_current", () => {
	it("stores and retrieves valid_time independently from committed_time", () => {
		const db = freshDb();
		const now = Date.now();
		const validTime = now - 60_000; // 1 minute ago (in-fiction time)
		const committedTime = now; // wall-clock settlement time

		db.prepare(
			`INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("agent-rp", 1, "weather", '{"condition":"rain"}', "public_manifestation", "system", now, validTime, committedTime);

		const row = db
			.prepare(
				`SELECT valid_time, committed_time FROM area_state_current WHERE agent_id = ? AND area_id = ? AND key = ?`,
			)
			.get("agent-rp", 1, "weather") as { valid_time: number; committed_time: number };

		expect(row.valid_time).toBe(validTime);
		expect(row.committed_time).toBe(committedTime);
		expect(row.valid_time).not.toBe(row.committed_time);
		db.close();
	});

	it("filters area state by valid_time range query", () => {
		const db = freshDb();
		const base = Date.now();

		// Insert 3 entries with different valid_times
		for (let i = 0; i < 3; i++) {
			db.prepare(
				`INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("agent-rp", 1, `key-${i}`, `{"i":${i}}`, "public_manifestation", "system", base, base + i * 1000, base);
		}

		// Query only entries with valid_time >= base+1000 (should get key-1, key-2)
		const rows = db
			.prepare(
				`SELECT key FROM area_state_current WHERE agent_id = ? AND area_id = ? AND valid_time >= ?`,
			)
			.all("agent-rp", 1, base + 1000) as Array<{ key: string }>;

		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.key).sort()).toEqual(["key-1", "key-2"]);
		db.close();
	});

	it("committed_time query spans session boundary (different agents same area)", () => {
		const db = freshDb();
		const session1Time = 1000;
		const session2Time = 2000;

		// Session 1 agent writes area state
		db.prepare(
			`INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("agent-A", 1, "door_state", '{"open":true}', "public_manifestation", "system", session1Time, session1Time, session1Time);

		// Session 2 different agent writes same area
		db.prepare(
			`INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("agent-B", 1, "door_state", '{"open":false}', "latent_state_update", "gm", session2Time, session2Time, session2Time);

		// Query by committed_time >= session2Time: only agent-B's entry
		const rows = db
			.prepare(
				`SELECT agent_id, value_json FROM area_state_current WHERE area_id = ? AND key = ? AND committed_time >= ?`,
			)
			.all(1, "door_state", session2Time) as Array<{ agent_id: string; value_json: string }>;

		expect(rows).toHaveLength(1);
		expect(rows[0].agent_id).toBe("agent-B");
		expect(JSON.parse(rows[0].value_json).open).toBe(false);
		db.close();
	});
});

describe("time-slice dual-dimension — world_state_current", () => {
	it("world state stores valid_time and committed_time", () => {
		const db = freshDb();
		const now = Date.now();
		const validTime = now - 30_000;
		const committedTime = now;

		db.prepare(
			`INSERT INTO world_state_current (key, value_json, surfacing_classification, updated_at, valid_time, committed_time)
       VALUES (?, ?, ?, ?, ?, ?)`,
		).run("global_season", '{"season":"winter"}', "public_manifestation", now, validTime, committedTime);

		const row = db
			.prepare(
				`SELECT valid_time, committed_time FROM world_state_current WHERE key = ?`,
			)
			.get("global_season") as { valid_time: number; committed_time: number };

		expect(row.valid_time).toBe(validTime);
		expect(row.committed_time).toBe(committedTime);
		db.close();
	});
});
