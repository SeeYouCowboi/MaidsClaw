/**
 * @file Stress tests for V3 time-slice query subsystem.
 * Covers dual-dimension filtering, t_valid=0 edge cases, boundary conditions,
 * large-dataset performance, and empty-result scenarios.
 */
import { Database } from "bun:sqlite";
import { describe, it, expect } from "bun:test";
import { createMemorySchema } from "./schema.js";
import {
	filterProjectionRowsByTimeSlice,
	isEdgeInTimeSlice,
	isProjectionRowInTimeSlice,
	type TimeSliceQuery,
	type TimeAwareProjectionRow,
} from "./time-slice-query.js";

function freshDb(): Database {
	const db = new Database(":memory:");
	createMemorySchema(db);
	return db;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function insertAreaState(
	db: Database,
	agentId: string,
	areaId: number,
	key: string,
	valueJson: string,
	validTime: number | null,
	committedTime: number | null,
): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
     VALUES (?, ?, ?, ?, 'public_manifestation', 'system', ?, ?, ?)`,
	).run(agentId, areaId, key, valueJson, now, validTime, committedTime);
}

// ── Dual-dimension filter ───────────────────────────────────────────────────

describe("stress: time-slice dual-dimension filter", () => {
	it("returns only rows matching both valid_time and committed_time constraints", () => {
		const db = freshDb();
		const base = 10_000;

		// Row A: valid=100, committed=200  → visible at asOf(v>=100, c>=200)
		insertAreaState(db, "a1", 1, "rowA", '{"v":"A"}', base + 100, base + 200);
		// Row B: valid=300, committed=100  → visible at asOf(v>=300, c>=100)
		insertAreaState(db, "a1", 1, "rowB", '{"v":"B"}', base + 300, base + 100);
		// Row C: valid=50, committed=50    → visible at asOf(v>=50, c>=50)
		insertAreaState(db, "a1", 1, "rowC", '{"v":"C"}', base + 50, base + 50);

		// Query with asOfValidTime=base+150, asOfCommittedTime=base+150
		// Row A: valid 100 <= 150 ✓, committed 200 > 150 ✗  → excluded
		// Row B: valid 300 > 150 ✗                           → excluded
		// Row C: valid 50 <= 150 ✓, committed 50 <= 150 ✓    → included
		const rows = db
			.prepare(
				`SELECT key, valid_time, committed_time FROM area_state_current WHERE agent_id = ? AND area_id = ?`,
			)
			.all("a1", 1) as Array<{ key: string; valid_time: number; committed_time: number }>;

		const query: TimeSliceQuery = {
			asOfValidTime: base + 150,
			asOfCommittedTime: base + 150,
		};
		const filtered = filterProjectionRowsByTimeSlice(
			rows.map((r) => ({ ...r, valid_time: r.valid_time, committed_time: r.committed_time })),
			query,
		);

		expect(filtered).toHaveLength(1);
		expect((filtered[0] as { key: string }).key).toBe("rowC");
		db.close();
	});

	it("filters correctly when only valid_time constraint is specified", () => {
		const rows: TimeAwareProjectionRow[] = [
			{ valid_time: 100, committed_time: 500, updated_at: 100 },
			{ valid_time: 200, committed_time: 500, updated_at: 200 },
			{ valid_time: 300, committed_time: 500, updated_at: 300 },
		];

		const result = filterProjectionRowsByTimeSlice(rows, { asOfValidTime: 200 });
		expect(result).toHaveLength(2);
	});

	it("filters correctly when only committed_time constraint is specified", () => {
		const rows: TimeAwareProjectionRow[] = [
			{ valid_time: 100, committed_time: 100, updated_at: 100 },
			{ valid_time: 100, committed_time: 200, updated_at: 200 },
			{ valid_time: 100, committed_time: 300, updated_at: 300 },
		];

		const result = filterProjectionRowsByTimeSlice(rows, { asOfCommittedTime: 200 });
		expect(result).toHaveLength(2);
	});
});

// ── t_valid=0 edge visibility ───────────────────────────────────────────────

describe("stress: t_valid=0 edges visible in ALL time slices", () => {
	it("edge with valid_time=0 passes any asOfValidTime filter", () => {
		// Per isEdgeInTimeSlice: effectiveValid=0 is explicitly skipped
		expect(isEdgeInTimeSlice({ valid_time: 0, committed_time: 100 }, { asOfValidTime: 1 })).toBe(true);
		expect(isEdgeInTimeSlice({ valid_time: 0, committed_time: 100 }, { asOfValidTime: 0 })).toBe(true);
		expect(isEdgeInTimeSlice({ valid_time: 0, committed_time: 100 }, { asOfValidTime: 999_999 })).toBe(true);
	});

	it("projection row with valid_time=0 passes any asOfValidTime filter", () => {
		expect(isProjectionRowInTimeSlice({ valid_time: 0, committed_time: 100 }, { asOfValidTime: 1 })).toBe(true);
		expect(isProjectionRowInTimeSlice({ valid_time: 0, committed_time: 100 }, { asOfValidTime: 0 })).toBe(true);
	});

	it("DB rows with valid_time=0 appear in time-slice queries regardless of asOf", () => {
		const db = freshDb();

		// Insert with valid_time=0 (epoch/genesis data)
		insertAreaState(db, "a1", 1, "genesis", '{"origin":true}', 0, 100);
		// Insert with valid_time=500
		insertAreaState(db, "a1", 1, "later", '{"origin":false}', 500, 100);

		const allRows = db
			.prepare(`SELECT key, valid_time, committed_time FROM area_state_current WHERE agent_id = ?`)
			.all("a1") as Array<{ key: string; valid_time: number; committed_time: number }>;

		// At asOfValidTime=1 — genesis (0) should pass, later (500) should not
		const sliced = filterProjectionRowsByTimeSlice(allRows, { asOfValidTime: 1 });
		expect(sliced).toHaveLength(1);
		expect((sliced[0] as { key: string }).key).toBe("genesis");

		db.close();
	});
});

// ── Boundary: asOfValidTime exactly equals row's valid_time ─────────────────

describe("stress: time-slice boundary — asOf equals row's time", () => {
	it("row with valid_time exactly at asOfValidTime is included (not excluded)", () => {
		const row: TimeAwareProjectionRow = { valid_time: 1000, committed_time: 500, updated_at: 500 };
		// valid_time (1000) <= asOfValidTime (1000) → should pass
		expect(isProjectionRowInTimeSlice(row, { asOfValidTime: 1000 })).toBe(true);
	});

	it("row with valid_time one tick past asOfValidTime is excluded", () => {
		const row: TimeAwareProjectionRow = { valid_time: 1001, committed_time: 500, updated_at: 500 };
		expect(isProjectionRowInTimeSlice(row, { asOfValidTime: 1000 })).toBe(false);
	});

	it("edge with committed_time exactly at asOfCommittedTime is included", () => {
		expect(isEdgeInTimeSlice({ committed_time: 500 }, { asOfCommittedTime: 500 })).toBe(true);
	});

	it("edge with committed_time one tick past asOfCommittedTime is excluded", () => {
		expect(isEdgeInTimeSlice({ committed_time: 501 }, { asOfCommittedTime: 500 })).toBe(false);
	});

	it("DB boundary: row at exact asOfValidTime returned by filterProjectionRows", () => {
		const db = freshDb();
		const exact = 5000;

		insertAreaState(db, "a1", 1, "exact", '{"at":"boundary"}', exact, exact);
		insertAreaState(db, "a1", 1, "before", '{"at":"before"}', exact - 1, exact);
		insertAreaState(db, "a1", 1, "after", '{"at":"after"}', exact + 1, exact);

		const allRows = db
			.prepare(`SELECT key, valid_time, committed_time FROM area_state_current WHERE agent_id = ?`)
			.all("a1") as Array<{ key: string; valid_time: number; committed_time: number }>;

		const sliced = filterProjectionRowsByTimeSlice(allRows, { asOfValidTime: exact });
		const keys = sliced.map((r) => (r as { key: string }).key).sort();
		expect(keys).toEqual(["before", "exact"]);

		db.close();
	});
});

// ── Large dataset performance ───────────────────────────────────────────────

describe("stress: time-slice large dataset performance", () => {
	it("insert 100+ rows and filter within 500ms", () => {
		const db = freshDb();
		const ROW_COUNT = 150;
		const base = 10_000;

		// Bulk insert 150 rows with spread valid_times
		const stmt = db.prepare(
			`INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
       VALUES (?, ?, ?, ?, 'public_manifestation', 'system', ?, ?, ?)`,
		);
		for (let i = 0; i < ROW_COUNT; i++) {
			stmt.run("perf-agent", 1, `key-${i}`, `{"i":${i}}`, base, base + i * 10, base + 100);
		}

		const allRows = db
			.prepare(`SELECT key, valid_time, committed_time FROM area_state_current WHERE agent_id = ?`)
			.all("perf-agent") as Array<{ key: string; valid_time: number; committed_time: number }>;

		expect(allRows).toHaveLength(ROW_COUNT);

		// Time the filter operation
		const start = performance.now();
		const midpoint = base + (ROW_COUNT / 2) * 10;
		const filtered = filterProjectionRowsByTimeSlice(allRows, { asOfValidTime: midpoint });
		const elapsed = performance.now() - start;

		expect(elapsed).toBeLessThan(500);
		// Midpoint should include ~half the rows (those with valid_time <= midpoint)
		expect(filtered.length).toBeGreaterThan(0);
		expect(filtered.length).toBeLessThanOrEqual(ROW_COUNT);

		db.close();
	});

	it("SQL-level time-slice query on 200 rows completes under 500ms", () => {
		const db = freshDb();
		const base = 10_000;

		const stmt = db.prepare(
			`INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
       VALUES (?, ?, ?, ?, 'public_manifestation', 'system', ?, ?, ?)`,
		);
		for (let i = 0; i < 200; i++) {
			stmt.run("bulk", 1, `k-${i}`, `{"i":${i}}`, base, base + i * 5, base + i * 3);
		}

		const start = performance.now();
		const rows = db
			.prepare(
				`SELECT key FROM area_state_current WHERE agent_id = ? AND valid_time <= ? AND committed_time <= ?`,
			)
			.all("bulk", base + 500, base + 300) as Array<{ key: string }>;
		const elapsed = performance.now() - start;

		expect(elapsed).toBeLessThan(500);
		expect(rows.length).toBeGreaterThan(0);

		db.close();
	});
});

// ── Empty result ────────────────────────────────────────────────────────────

describe("stress: time-slice empty result on no-data range", () => {
	it("query returns empty when asOfValidTime is before all rows", () => {
		const db = freshDb();
		insertAreaState(db, "a1", 1, "future", '{"v":"f"}', 10_000, 10_000);

		const allRows = db
			.prepare(`SELECT key, valid_time, committed_time FROM area_state_current WHERE agent_id = ?`)
			.all("a1") as Array<{ key: string; valid_time: number; committed_time: number }>;

		const filtered = filterProjectionRowsByTimeSlice(allRows, { asOfValidTime: 1 });
		expect(filtered).toHaveLength(0);

		db.close();
	});

	it("filterProjectionRowsByTimeSlice returns empty array for empty input", () => {
		const filtered = filterProjectionRowsByTimeSlice([], { asOfValidTime: 1000 });
		expect(filtered).toEqual([]);
	});

	it("SQL query returns empty for non-existent agent", () => {
		const db = freshDb();
		insertAreaState(db, "real-agent", 1, "k", '{}', 100, 100);

		const rows = db
			.prepare(
				`SELECT key FROM area_state_current WHERE agent_id = ? AND valid_time <= ?`,
			)
			.all("ghost-agent", 999_999) as Array<{ key: string }>;

		expect(rows).toHaveLength(0);
		db.close();
	});
});
