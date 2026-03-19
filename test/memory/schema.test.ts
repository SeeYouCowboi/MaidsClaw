import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_INTEGER,
	makeNodeRef,
	runMemoryMigrations,
} from "../../src/memory/schema.js";
import { TransactionBatcher } from "../../src/memory/transaction-batcher.js";
import { openDatabase } from "../../src/storage/database.js";

function createTempDb() {
	const dbPath = join(tmpdir(), `maidsclaw-memory-schema-${randomUUID()}.db`);
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

describe("memory schema", () => {
	it("creates all required tables, FTS5 virtual tables, and indexes", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const nonFtsCount = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE '%fts%'",
		);
		expect(nonFtsCount?.count).toBe(20);

		const ftsCount = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'",
		);
		expect(ftsCount?.count).toBe(3);

		const indexNames = db
			.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
			)
			.map((row) => row.name);

		expect(indexNames.includes("ux_entity_public_pointer")).toBe(true);
		expect(indexNames.includes("ux_entity_private_pointer")).toBe(true);
		expect(indexNames.includes("ux_core_memory_agent_label")).toBe(true);
		expect(indexNames.includes("ux_node_embeddings_ref_view_model")).toBe(true);

		db.close();
		cleanupDb(dbPath);
	});

	it("uses WAL mode and supports trigram FTS5 query", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const walMode = db.get<{ journal_mode: string }>("PRAGMA journal_mode");
		expect(walMode?.journal_mode).toBe("wal");

		const docInsert = db.run(
			"INSERT INTO search_docs_world (doc_type, source_ref, content, created_at) VALUES (?, ?, ?, ?)",
			["event", "event:1", "Alice met Bob at the coffee shop", Date.now()],
		);
		db.run("INSERT INTO search_docs_world_fts (rowid, content) VALUES (?, ?)", [
			Number(docInsert.lastInsertRowid),
			"Alice met Bob at the coffee shop",
		]);

		const match = db.query<{ rowid: number }>(
			"SELECT rowid FROM search_docs_world_fts WHERE search_docs_world_fts MATCH ?",
			["coffee"],
		);
		expect(match.length).toBe(1);

		db.close();
		cleanupDb(dbPath);
	});

	it("enforces schema constraints and partial unique indexes", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		let invalidEventScopeFailed = false;
		try {
			db.run(
				"INSERT INTO event_nodes (session_id, timestamp, created_at, visibility_scope, location_entity_id, event_category, promotion_class, event_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				[
					"s1",
					Date.now(),
					Date.now(),
					"owner_private",
					1,
					"speech",
					"none",
					"runtime_projection",
				],
			);
		} catch {
			invalidEventScopeFailed = true;
		}
		expect(invalidEventScopeFailed).toBe(true);

		let thoughtInPublicEventFailed = false;
		try {
			db.run(
				"INSERT INTO event_nodes (session_id, timestamp, created_at, visibility_scope, location_entity_id, event_category, promotion_class, event_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				[
					"s1",
					Date.now(),
					Date.now(),
					"area_visible",
					1,
					"thought",
					"none",
					"runtime_projection",
				],
			);
		} catch {
			thoughtInPublicEventFailed = true;
		}
		expect(thoughtInPublicEventFailed).toBe(true);

		db.run(
			"INSERT INTO agent_event_overlay (agent_id, event_category, projection_class, created_at) VALUES (?, ?, ?, ?)",
			["agent-1", "thought", "none", Date.now()],
		);

		db.run(
			"INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				"alice",
				"Alice",
				"person",
				"shared_public",
				null,
				Date.now(),
				Date.now(),
			],
		);

		let duplicateSharedPointerFailed = false;
		try {
			db.run(
				"INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[
					"alice",
					"Alice 2",
					"person",
					"shared_public",
					null,
					Date.now(),
					Date.now(),
				],
			);
		} catch {
			duplicateSharedPointerFailed = true;
		}
		expect(duplicateSharedPointerFailed).toBe(true);

		db.run(
			"INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				"alice",
				"Alice private",
				"person",
				"private_overlay",
				"agent-1",
				Date.now(),
				Date.now(),
			],
		);
		db.run(
			"INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				"alice",
				"Alice private 2",
				"person",
				"private_overlay",
				"agent-2",
				Date.now(),
				Date.now(),
			],
		);

		const factInsert = db.run(
			"INSERT INTO fact_edges (source_entity_id, target_entity_id, predicate, t_valid, t_created, source_event_id) VALUES (?, ?, ?, ?, ?, ?)",
			[1, 2, "knows", Date.now(), Date.now(), null],
		);
		const fact = db.get<{ t_invalid: number }>(
			"SELECT t_invalid FROM fact_edges WHERE id = ?",
			[Number(factInsert.lastInsertRowid)],
		);
		expect(fact?.t_invalid).toBe(MAX_INTEGER);

		db.close();
		cleanupDb(dbPath);
	});

	it("creates typed node refs and batches writes atomically", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const ref = makeNodeRef("event", 42);
		expect(ref).toBe(makeNodeRef("event", 42));

		const batcher = new TransactionBatcher(db);
		batcher.enqueue((txDb) => {
			txDb.run(
				"INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["bob", "Bob", "person", "shared_public", null, Date.now(), Date.now()],
			);
		});
		batcher.enqueue((txDb) => {
			txDb.run(
				"INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[
					"claire",
					"Claire",
					"person",
					"shared_public",
					null,
					Date.now(),
					Date.now(),
				],
			);
		});

		const successCount = batcher.flush();
		expect(successCount).toBe(2);

		const successfulRows = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM entity_nodes WHERE pointer_key IN ('bob', 'claire')",
		);
		expect(successfulRows?.count).toBe(2);

		batcher.enqueue((txDb) => {
			txDb.run(
				"INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[
					"dana",
					"Dana",
					"person",
					"shared_public",
					null,
					Date.now(),
					Date.now(),
				],
			);
		});
		batcher.enqueue((txDb) => {
			txDb.run(
				"INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[
					"bob",
					"Bob duplicate",
					"person",
					"shared_public",
					null,
					Date.now(),
					Date.now(),
				],
			);
		});

		let rollbackHappened = false;
		try {
			batcher.flush();
		} catch {
			rollbackHappened = true;
		}
		expect(rollbackHappened).toBe(true);

		const danaRow = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM entity_nodes WHERE pointer_key = 'dana'",
		);
		expect(danaRow?.count).toBe(0);

		db.close();
		cleanupDb(dbPath);
	});
});
