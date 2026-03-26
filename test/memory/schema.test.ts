import { Database } from "bun:sqlite";
import { describe, expect, it, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphNavigator } from "../../src/memory/navigator.js";
import {
	MEMORY_MIGRATIONS,
	MAX_INTEGER,
	createMemorySchema,
	makeNodeRef,
	runMemoryMigrations,
} from "../../src/memory/schema.js";
import { TransactionBatcher } from "../../src/memory/transaction-batcher.js";
import { NODE_REF_KINDS } from "../../src/memory/types.js";
import { type Db, openDatabase } from "../../src/storage/database.js";

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

function listColumns(db: ReturnType<typeof createTempDb>["db"], tableName: string): string[] {
	return db.query<{ name: string }>(`PRAGMA table_info(${tableName})`).map((row) => row.name);
}

function wrapRawDatabase(raw: Database): Db {
	return {
		raw,
		exec(sql: string): void {
			raw.exec(sql);
		},
		query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
			const stmt = raw.prepare(sql);
			return (params ? stmt.all(...params as []) : stmt.all()) as T[];
		},
		run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
			const stmt = raw.prepare(sql);
			const result = params ? stmt.run(...params as []) : stmt.run();
			return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
		},
		get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
			const stmt = raw.prepare(sql);
			const result = params ? stmt.get(...params as []) : stmt.get();
			return result === null ? undefined : result as T;
		},
		close(): void {
			raw.close();
		},
		transaction<T>(fn: () => T): T {
			return raw.transaction(fn)();
		},
		prepare(sql: string) {
			const stmt = raw.prepare(sql);
			return {
				run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
					const result = params.length > 0 ? stmt.run(...params as []) : stmt.run();
					return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
				},
				all(...params: unknown[]): unknown[] {
					return (params.length > 0 ? stmt.all(...params as []) : stmt.all()) as unknown[];
				},
				get(...params: unknown[]): unknown {
					const result = params.length > 0 ? stmt.get(...params as []) : stmt.get();
					return result === null ? undefined : result;
				},
			};
		},
	};
}

describe("memory schema", () => {
	it("creates all required tables, FTS5 virtual tables, and indexes", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const nonFtsCount = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE '%fts%'",
		);
		expect(nonFtsCount?.count).toBe(33);

		const ftsCount = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'",
		);
		expect(ftsCount?.count).toBe(4);

		const indexNames = db
			.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
			)
			.map((row) => row.name);

		expect(indexNames.includes("ux_entity_public_pointer")).toBe(true);
		expect(indexNames.includes("ux_entity_private_pointer")).toBe(true);
		expect(indexNames.includes("ux_core_memory_agent_label")).toBe(true);
		expect(indexNames.includes("ux_node_embeddings_ref_view_model")).toBe(true);
		expect(indexNames.includes("idx_memory_relations_source")).toBe(true);
		expect(indexNames.includes("idx_memory_relations_target")).toBe(true);
		expect(indexNames.includes("ux_memory_relations_pair_type")).toBe(true);
		expect(indexNames.includes("idx_search_docs_cognition_agent")).toBe(true);
		expect(indexNames.includes("idx_search_docs_cognition_agent_updated")).toBe(true);
		expect(indexNames.includes("idx_shared_block_attachments_target")).toBe(true);
		expect(indexNames.includes("idx_shared_block_patch_log_block_seq")).toBe(true);

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
			"INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, committed_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["agent-1", "s1", "settle-1", "observation", "test event", Date.now(), Date.now()],
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

	it("creates memory_relations and cognition search tables", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const relationsTable = db.get<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='memory_relations'",
		);
		expect(relationsTable?.name).toBe("memory_relations");

		const cognitionTable = db.get<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='search_docs_cognition'",
		);
		expect(cognitionTable?.name).toBe("search_docs_cognition");

		const cognitionFtsTable = db.get<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='search_docs_cognition_fts'",
		);
		expect(cognitionFtsTable?.name).toBe("search_docs_cognition_fts");

		db.close();
		cleanupDb(dbPath);
	});

	it("adds canonical overlay and publication provenance columns", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const episodeEventColumns = listColumns(db, "private_episode_events");
		expect(episodeEventColumns.includes("location_entity_id")).toBe(true);
		expect(episodeEventColumns.includes("created_at")).toBe(true);

		const eventNodeColumns = listColumns(db, "event_nodes");
		expect(eventNodeColumns.includes("source_settlement_id")).toBe(true);
		expect(eventNodeColumns.includes("source_pub_index")).toBe(true);

		const publicationIndex = db.get<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='index' AND name='ux_event_nodes_publication_scope'",
		);
		expect(publicationIndex?.name).toBe("ux_event_nodes_publication_scope");

		db.close();
		cleanupDb(dbPath);
	});

	it("enforces memory_relations self-ref and dedupe constraints", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		let selfRefInsertFailed = false;
		try {
			db.run(
				"INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				["private_belief:1", "private_belief:1", "supports", 0.9, "direct", "turn", "turn:t-1", Date.now(), 0],
			);
		} catch {
			selfRefInsertFailed = true;
		}
		expect(selfRefInsertFailed).toBe(true);

		let validInsertFailed = false;
		try {
			db.run(
				"INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				["private_belief:1", "private_event:2", "supports", 0.8, "inferred", "job", "job:j-1", Date.now(), 0],
			);
		} catch {
			validInsertFailed = true;
		}
		expect(validInsertFailed).toBe(false);

		let differentSourceInsertFailed = false;
		try {
			db.run(
				"INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				["private_belief:1", "private_event:2", "supports", 0.5, "direct", "system", "system", Date.now(), 0],
			);
		} catch {
			differentSourceInsertFailed = true;
		}
		expect(differentSourceInsertFailed).toBe(false);

		let duplicateInsertFailed = false;
		try {
			db.run(
				"INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				["private_belief:1", "private_event:2", "supports", 0.9, "direct", "job", "job:j-1", Date.now(), 0],
			);
		} catch {
			duplicateInsertFailed = true;
		}
		expect(duplicateInsertFailed).toBe(true);

		db.close();
		cleanupDb(dbPath);
	});

	it("supports trigram FTS on search_docs_cognition_fts", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const insert = db.run(
			"INSERT INTO search_docs_cognition (doc_type, source_ref, agent_id, kind, basis, stance, content, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				"cognition",
				"private_belief:1",
				"agent-1",
				"assertion",
				"belief",
				"tentative",
				"I suspect Bob is hiding evidence",
				Date.now(),
				Date.now(),
			],
		);
		db.run("INSERT INTO search_docs_cognition_fts (rowid, content) VALUES (?, ?)", [
			Number(insert.lastInsertRowid),
			"I suspect Bob is hiding evidence",
		]);

		const matchRows = db.query<{ rowid: number }>(
			"SELECT rowid FROM search_docs_cognition_fts WHERE search_docs_cognition_fts MATCH ?",
			["hiding"],
		);
		expect(matchRows.length).toBe(1);

		db.close();
		cleanupDb(dbPath);
	});

	it("memory:028 backfills NULL cognition_key overlay assertions into canonical cognition tables", () => {
		const rawDb = new Database(":memory:");
		const db = wrapRawDatabase(rawDb);

		db.exec(`CREATE TABLE agent_fact_overlay (
			id INTEGER PRIMARY KEY,
			agent_id TEXT NOT NULL,
			source_entity_id INTEGER NOT NULL,
			target_entity_id INTEGER NOT NULL,
			predicate TEXT NOT NULL,
			basis TEXT CHECK (basis IN ('first_hand', 'hearsay', 'inference', 'introspection', 'belief')),
			stance TEXT CHECK (stance IN ('hypothetical', 'tentative', 'accepted', 'confirmed', 'contested', 'rejected', 'abandoned')),
			pre_contested_stance TEXT CHECK (pre_contested_stance IN ('hypothetical', 'tentative', 'accepted', 'confirmed')),
			provenance TEXT,
			source_label_raw TEXT,
			source_event_ref TEXT,
			cognition_key TEXT,
			settlement_id TEXT,
			op_index INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			CHECK (pre_contested_stance IS NULL OR stance = 'contested')
		)`);
		db.exec(`CREATE TABLE private_cognition_events (
			id INTEGER PRIMARY KEY,
			agent_id TEXT NOT NULL,
			cognition_key TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('assertion', 'evaluation', 'commitment')),
			op TEXT NOT NULL CHECK (op IN ('upsert', 'retract')),
			record_json TEXT,
			settlement_id TEXT NOT NULL,
			committed_time INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		)`);
		db.exec(`CREATE TABLE private_cognition_current (
			id INTEGER PRIMARY KEY,
			agent_id TEXT NOT NULL,
			cognition_key TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('assertion', 'evaluation', 'commitment')),
			stance TEXT,
			basis TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			pre_contested_stance TEXT,
			conflict_summary TEXT,
			conflict_factor_refs_json TEXT,
			summary_text TEXT,
			record_json TEXT NOT NULL,
			source_event_id INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`);

		const now = Date.now();
		db.run(
			"INSERT INTO agent_fact_overlay (agent_id, source_entity_id, target_entity_id, predicate, basis, stance, pre_contested_stance, provenance, cognition_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			["agent-a", 1, 2, "knows", "first_hand", "confirmed", null, "witnessed", null, now - 3, now - 3],
		);
		db.run(
			"INSERT INTO agent_fact_overlay (agent_id, source_entity_id, target_entity_id, predicate, basis, stance, pre_contested_stance, provenance, cognition_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			["agent-a", 3, 4, "owes", "inference", "tentative", null, "rumor", null, now - 2, now - 2],
		);
		db.run(
			"INSERT INTO agent_fact_overlay (agent_id, source_entity_id, target_entity_id, predicate, basis, stance, pre_contested_stance, provenance, cognition_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			["agent-b", 5, 6, "fears", "belief", "contested", "accepted", "self-report", null, now - 1, now - 1],
		);

		const migration = MEMORY_MIGRATIONS.find((step) => step.id === "memory:028:backfill-unkeyed-assertions");
		if (!migration) {
			throw new Error("memory:028 migration not found");
		}
		migration.up(db);

		const backfilledCount = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM private_cognition_current WHERE cognition_key LIKE 'legacy_backfill:%'",
		);
		expect(backfilledCount?.count).toBe(3);

		db.close();
	});

	it("memory:029 purges legacy node refs from derived tables without touching source-of-truth tables", () => {
		const rawDb = new Database(":memory:");
		const db = wrapRawDatabase(rawDb);

		db.exec(`CREATE TABLE search_docs_cognition (
			id INTEGER PRIMARY KEY,
			doc_type TEXT NOT NULL,
			source_ref TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('assertion', 'evaluation', 'commitment')),
			basis TEXT,
			stance TEXT,
			content TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		)`);
		db.exec(`CREATE TABLE node_embeddings (
			id INTEGER PRIMARY KEY,
			node_ref TEXT NOT NULL,
			node_kind TEXT NOT NULL CHECK (node_kind IN ('event', 'entity', 'fact', 'assertion', 'evaluation', 'commitment', 'private_event', 'private_belief')),
			view_type TEXT NOT NULL CHECK (view_type IN ('primary', 'keywords', 'context')),
			model_id TEXT NOT NULL,
			embedding BLOB NOT NULL,
			updated_at INTEGER NOT NULL
		)`);
		db.exec(`CREATE TABLE semantic_edges (
			id INTEGER PRIMARY KEY,
			source_node_ref TEXT NOT NULL,
			target_node_ref TEXT NOT NULL,
			relation_type TEXT NOT NULL CHECK (relation_type IN ('semantic_similar', 'conflict_or_update', 'entity_bridge')),
			weight REAL NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`);
		db.exec(`CREATE TABLE node_scores (
			node_ref TEXT PRIMARY KEY,
			salience REAL NOT NULL,
			centrality REAL NOT NULL,
			bridge_score REAL NOT NULL,
			updated_at INTEGER NOT NULL
		)`);
		db.exec(`CREATE TABLE memory_relations (
			id INTEGER PRIMARY KEY,
			source_node_ref TEXT NOT NULL,
			target_node_ref TEXT NOT NULL,
			relation_type TEXT NOT NULL CHECK (relation_type IN ('supports', 'triggered', 'conflicts_with', 'derived_from', 'supersedes', 'surfaced_as', 'published_as', 'resolved_by', 'downgraded_by')),
			strength REAL NOT NULL DEFAULT 0.5 CHECK (strength >= 0 AND strength <= 1),
			directness TEXT NOT NULL DEFAULT 'direct' CHECK (directness IN ('direct', 'inferred', 'indirect')),
			source_kind TEXT NOT NULL CHECK (source_kind IN ('turn', 'job', 'agent_op', 'system')),
			source_ref TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL DEFAULT 0,
			CHECK (source_node_ref != target_node_ref)
		)`);
		db.exec(`CREATE TABLE private_episode_events (
			id INTEGER PRIMARY KEY,
			agent_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			settlement_id TEXT NOT NULL,
			category TEXT NOT NULL CHECK (category IN ('speech', 'action', 'observation', 'state_change')),
			summary TEXT NOT NULL,
			private_notes TEXT,
			location_entity_id INTEGER,
			location_text TEXT,
			valid_time INTEGER,
			committed_time INTEGER NOT NULL,
			source_local_ref TEXT,
			created_at INTEGER NOT NULL
		)`);
		db.exec(`CREATE TABLE private_cognition_current (
			id INTEGER PRIMARY KEY,
			agent_id TEXT NOT NULL,
			cognition_key TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('assertion', 'evaluation', 'commitment')),
			stance TEXT,
			basis TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			pre_contested_stance TEXT,
			conflict_summary TEXT,
			conflict_factor_refs_json TEXT,
			summary_text TEXT,
			record_json TEXT NOT NULL,
			source_event_id INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`);

		const now = Date.now();
		db.run(
			"INSERT INTO search_docs_cognition (doc_type, source_ref, agent_id, kind, basis, stance, content, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			["cognition", "private_event:1", "agent-1", "assertion", "belief", "tentative", "legacy event", now, now],
		);
		db.run(
			"INSERT INTO search_docs_cognition (doc_type, source_ref, agent_id, kind, basis, stance, content, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			["cognition", "private_belief:2", "agent-1", "evaluation", "inference", "accepted", "legacy belief", now, now],
		);
		db.run(
			"INSERT INTO search_docs_cognition (doc_type, source_ref, agent_id, kind, basis, stance, content, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			["cognition", "assertion:3", "agent-1", "assertion", "first_hand", "confirmed", "canonical", now, now],
		);

		db.run(
			"INSERT INTO node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["private_event:1", "private_event", "primary", "model-1", new Uint8Array([1, 2, 3]), now],
		);
		db.run(
			"INSERT INTO node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["private_belief:2", "private_belief", "primary", "model-1", new Uint8Array([4, 5, 6]), now],
		);
		db.run(
			"INSERT INTO node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["assertion:3", "assertion", "primary", "model-1", new Uint8Array([7, 8, 9]), now],
		);

		db.run(
			"INSERT INTO semantic_edges (source_node_ref, target_node_ref, relation_type, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["private_event:1", "assertion:3", "semantic_similar", 0.9, now, now],
		);
		db.run(
			"INSERT INTO semantic_edges (source_node_ref, target_node_ref, relation_type, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["assertion:3", "private_belief:2", "entity_bridge", 0.6, now, now],
		);
		db.run(
			"INSERT INTO semantic_edges (source_node_ref, target_node_ref, relation_type, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["assertion:3", "evaluation:4", "semantic_similar", 0.3, now, now],
		);

		db.run(
			"INSERT INTO node_scores (node_ref, salience, centrality, bridge_score, updated_at) VALUES (?, ?, ?, ?, ?)",
			["private_event:1", 0.9, 0.8, 0.7, now],
		);
		db.run(
			"INSERT INTO node_scores (node_ref, salience, centrality, bridge_score, updated_at) VALUES (?, ?, ?, ?, ?)",
			["private_belief:2", 0.5, 0.4, 0.3, now],
		);
		db.run(
			"INSERT INTO node_scores (node_ref, salience, centrality, bridge_score, updated_at) VALUES (?, ?, ?, ?, ?)",
			["assertion:3", 0.2, 0.2, 0.2, now],
		);

		db.run(
			"INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			["private_event:1", "assertion:3", "supports", 0.8, "direct", "system", "test:1", now, now],
		);
		db.run(
			"INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			["assertion:3", "private_belief:2", "triggered", 0.6, "inferred", "system", "test:2", now, now],
		);
		db.run(
			"INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			["assertion:3", "evaluation:4", "supports", 0.4, "direct", "system", "test:3", now, now],
		);

		db.run(
			"INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, committed_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["agent-1", "session-1", "settlement-1", "observation", "source event", now, now],
		);
		db.run(
			"INSERT INTO private_cognition_current (agent_id, cognition_key, kind, record_json, source_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["agent-1", "ck-1", "assertion", '{"value":"truth"}', 1, now],
		);

		const sourceTruthBeforeEpisode = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM private_episode_events",
		)?.count;
		const sourceTruthBeforeCognition = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM private_cognition_current",
		)?.count;

		const migration = MEMORY_MIGRATIONS.find((step) => step.id === "memory:029:purge-legacy-node-refs");
		if (!migration) {
			throw new Error("memory:029 migration not found");
		}
		migration.up(db);

		const legacyCognitionDocs = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM search_docs_cognition WHERE source_ref LIKE 'private_%'",
		);
		expect(legacyCognitionDocs?.count).toBe(0);

		const legacyEmbeddings = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM node_embeddings WHERE node_kind IN ('private_event','private_belief')",
		);
		expect(legacyEmbeddings?.count).toBe(0);

		const legacySemanticEdges = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM semantic_edges WHERE source_node_ref LIKE 'private_%' OR target_node_ref LIKE 'private_%'",
		);
		expect(legacySemanticEdges?.count).toBe(0);

		const legacyNodeScores = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM node_scores WHERE node_ref LIKE 'private_%'",
		);
		expect(legacyNodeScores?.count).toBe(0);

		const legacyMemoryRelations = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM memory_relations WHERE source_node_ref LIKE 'private_%' OR target_node_ref LIKE 'private_%'",
		);
		expect(legacyMemoryRelations?.count).toBe(0);

		const sourceTruthAfterEpisode = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM private_episode_events",
		)?.count;
		const sourceTruthAfterCognition = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM private_cognition_current",
		)?.count;
		expect(sourceTruthAfterEpisode).toBe(sourceTruthBeforeEpisode);
		expect(sourceTruthAfterCognition).toBe(sourceTruthBeforeCognition);

		db.close();
	});

  describe("memory:030 drop-agent-fact-overlay", () => {
    test("fresh DB via createMemorySchema() has no agent_fact_overlay table", () => {
      const db = new Database(":memory:");
      createMemorySchema(db);
      const row = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_fact_overlay'`,
      ).get() as { name: string } | null;
      expect(row).toBeNull();
      db.close();
    });

    test("fresh DB via runMemoryMigrations has no agent_fact_overlay table", () => {
      const { dbPath, db } = createTempDb();
      runMemoryMigrations(db);
      const row = db.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_fact_overlay'`,
      );
      expect(row).toBeUndefined();
      db.close();
      cleanupDb(dbPath);
    });
  });

  describe("memory:031 tighten-node-embeddings-check", () => {
    test("fresh DB rejects node_kind='private_event' INSERT (CHECK constraint)", () => {
      const db = new Database(":memory:");
      createMemorySchema(db);
      const now = Date.now();

      let privateEventInsertFailed = false;
      try {
        db.run(
          `INSERT INTO node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ["private_event:1", "private_event", "primary", "model-1", new Uint8Array(1536).fill(0), now],
        );
      } catch {
        privateEventInsertFailed = true;
      }
      expect(privateEventInsertFailed).toBe(true);

      let privateBeliefInsertFailed = false;
      try {
        db.run(
          `INSERT INTO node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ["private_belief:2", "private_belief", "primary", "model-1", new Uint8Array(1536).fill(0), now],
        );
      } catch {
        privateBeliefInsertFailed = true;
      }
      expect(privateBeliefInsertFailed).toBe(true);

      let assertionInsertFailed = false;
      try {
        db.run(
          `INSERT INTO node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ["assertion:1", "assertion", "primary", "model-1", new Uint8Array(1536).fill(0), now],
        );
      } catch {
        assertionInsertFailed = true;
      }
      expect(assertionInsertFailed).toBe(false);

      const count = db.prepare("SELECT count(*) as count FROM node_embeddings").get() as { count: number };
      expect(count.count).toBe(1);

      db.close();
    });

    test("migration preserves canonical node_embeddings rows", () => {
      const rawDb = new Database(":memory:");
      const db = wrapRawDatabase(rawDb);

      db.exec(`CREATE TABLE node_embeddings (
        id INTEGER PRIMARY KEY,
        node_ref TEXT NOT NULL,
        node_kind TEXT NOT NULL CHECK (node_kind IN ('event', 'entity', 'fact', 'assertion', 'evaluation', 'commitment', 'private_event', 'private_belief')),
        node_id TEXT,
        view_type TEXT NOT NULL CHECK (view_type IN ('primary', 'keywords', 'context')),
        model_id TEXT NOT NULL,
        embedding BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      db.exec(`CREATE UNIQUE INDEX ux_node_embeddings_ref_view_model ON node_embeddings(node_ref, view_type, model_id)`);

      const now = Date.now();
      db.run(
        `INSERT INTO node_embeddings (node_ref, node_kind, node_id, view_type, model_id, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["event:1", "event", "1", "primary", "model-1", new Uint8Array([1, 2, 3]), now],
      );
      db.run(
        `INSERT INTO node_embeddings (node_ref, node_kind, node_id, view_type, model_id, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["assertion:2", "assertion", "2", "primary", "model-1", new Uint8Array([4, 5, 6]), now],
      );
      db.run(
        `INSERT INTO node_embeddings (node_ref, node_kind, node_id, view_type, model_id, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["private_event:3", "private_event", "3", "primary", "model-1", new Uint8Array([7, 8, 9]), now],
      );

      const migration = MEMORY_MIGRATIONS.find((step) => step.id === "memory:031:tighten-node-embeddings-check");
      if (!migration) {
        throw new Error("memory:031 migration not found");
      }
      migration.up(db);

      const remainingRows = db.query<{ node_ref: string }>("SELECT node_ref FROM node_embeddings ORDER BY node_ref");
      expect(remainingRows.length).toBe(2);
      expect(remainingRows[0].node_ref).toBe("assertion:2");
      expect(remainingRows[1].node_ref).toBe("event:1");

      let privateEventFailed = false;
      try {
        db.run(
          `INSERT INTO node_embeddings (node_ref, node_kind, node_id, view_type, model_id, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ["private_event:99", "private_event", "99", "primary", "model-1", new Uint8Array(1536).fill(0), now],
        );
      } catch {
        privateEventFailed = true;
      }
      expect(privateEventFailed).toBe(true);

      db.close();
    });
  });

	describe("memory:032 migrate-character-labels", () => {
		test("migrates character rows to pinned_summary and tightens CHECK", () => {
			const rawDb = new Database(":memory:");
			const db = wrapRawDatabase(rawDb);

			db.exec(`CREATE TABLE _migrations (migration_id TEXT PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
			db.exec(`CREATE TABLE core_memory_blocks (
				id INTEGER PRIMARY KEY,
				agent_id TEXT NOT NULL,
				label TEXT NOT NULL CHECK (label IN ('character', 'user', 'index', 'pinned_summary', 'pinned_index', 'persona')),
				description TEXT,
				value TEXT NOT NULL DEFAULT '',
				char_limit INTEGER NOT NULL,
				read_only INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL
			)`);
			db.exec(`CREATE UNIQUE INDEX ux_core_memory_agent_label ON core_memory_blocks(agent_id, label)`);

			const now = Date.now();
			db.run(
				"INSERT INTO core_memory_blocks (agent_id, label, description, value, char_limit, read_only, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["agent-1", "character", "Agent persona (legacy)", "I am Alice", 4000, 1, now],
			);
			db.run(
				"INSERT INTO core_memory_blocks (agent_id, label, description, value, char_limit, read_only, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["agent-1", "user", "User info", "Bob", 3000, 1, now],
			);
			db.run(
				"INSERT INTO core_memory_blocks (agent_id, label, description, value, char_limit, read_only, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["agent-1", "pinned_summary", "Pinned summary", "Existing summary", 4000, 0, now],
			);
			db.run(
				"INSERT INTO core_memory_blocks (agent_id, label, description, value, char_limit, read_only, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["agent-2", "character", "Agent persona (legacy)", "I am Eve", 4000, 1, now],
			);

			const migration = MEMORY_MIGRATIONS.find((step) => step.id === "memory:032:migrate-character-labels");
			if (!migration) throw new Error("memory:032 migration not found");
			migration.up(db);

			const characterCount = db.get<{ count: number }>(
				"SELECT count(*) AS count FROM core_memory_blocks WHERE label = 'character'",
			);
			expect(characterCount?.count).toBe(0);

			const agent1Pinned = db.get<{ value: string }>(
				"SELECT value FROM core_memory_blocks WHERE agent_id = 'agent-1' AND label = 'pinned_summary'",
			);
			expect(agent1Pinned?.value).toBe("Existing summary");

			const agent2Pinned = db.get<{ value: string }>(
				"SELECT value FROM core_memory_blocks WHERE agent_id = 'agent-2' AND label = 'pinned_summary'",
			);
			expect(agent2Pinned?.value).toBe("I am Eve");

			const userRow = db.get<{ label: string }>(
				"SELECT label FROM core_memory_blocks WHERE agent_id = 'agent-1' AND label = 'user'",
			);
			expect(userRow?.label).toBe("user");

			let characterInsertFailed = false;
			try {
				db.run(
					"INSERT INTO core_memory_blocks (agent_id, label, description, value, char_limit, read_only, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					["agent-2", "character", "Should fail", "", 4000, 1, now],
				);
			} catch {
				characterInsertFailed = true;
			}
			expect(characterInsertFailed).toBe(true);

			db.close();
		});

		test("handles empty table gracefully", () => {
			const rawDb = new Database(":memory:");
			const db = wrapRawDatabase(rawDb);

			db.exec(`CREATE TABLE _migrations (migration_id TEXT PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
			db.exec(`CREATE TABLE core_memory_blocks (
				id INTEGER PRIMARY KEY,
				agent_id TEXT NOT NULL,
				label TEXT NOT NULL CHECK (label IN ('character', 'user', 'index', 'pinned_summary', 'pinned_index', 'persona')),
				description TEXT,
				value TEXT NOT NULL DEFAULT '',
				char_limit INTEGER NOT NULL,
				read_only INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL
			)`);
			db.exec(`CREATE UNIQUE INDEX ux_core_memory_agent_label ON core_memory_blocks(agent_id, label)`);

			const migration = MEMORY_MIGRATIONS.find((step) => step.id === "memory:032:migrate-character-labels");
			if (!migration) throw new Error("memory:032 migration not found");
			migration.up(db);

			const count = db.get<{ count: number }>(
				"SELECT count(*) AS count FROM core_memory_blocks",
			);
			expect(count?.count).toBe(0);

			db.close();
		});
	});

	it("is idempotent when migrations run multiple times", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);
		runMemoryMigrations(db);

		const migrationCount = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM _migrations WHERE migration_id LIKE 'memory:%'",
		);
		expect(migrationCount?.count).toBe(32);

		db.close();
		cleanupDb(dbPath);
	});

	it("adds bounded area/world current projections with surfacing classification constraints", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const tableNames = db
			.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('area_state_current', 'area_narrative_current', 'world_state_current', 'world_narrative_current') ORDER BY name",
			)
			.map((row) => row.name);
		expect(tableNames).toEqual([
			"area_narrative_current",
			"area_state_current",
			"world_narrative_current",
			"world_state_current",
		]);

		const areaColumns = listColumns(db, "area_state_current");
		expect(areaColumns.includes("valid_time")).toBe(true);
		expect(areaColumns.includes("committed_time")).toBe(true);
		expect(areaColumns.includes("source_type")).toBe(true);

		const worldColumns = listColumns(db, "world_state_current");
		expect(worldColumns.includes("valid_time")).toBe(true);
		expect(worldColumns.includes("committed_time")).toBe(true);

		const now = Date.now();
		db.run(
			"INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["rp:alice", 1, "door:status", '{"locked":true}', "latent_state_update", now],
		);

		let invalidClassificationFailed = false;
		try {
			db.run(
				"INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				["rp:alice", 1, "door:status:invalid", '{"locked":false}', "invalid_class", now],
			);
		} catch {
			invalidClassificationFailed = true;
		}
		expect(invalidClassificationFailed).toBe(true);

		db.run(
			"INSERT INTO world_state_current (key, value_json, surfacing_classification, updated_at) VALUES (?, ?, ?, ?)",
			["world:decree", '{"active":true}', "public_manifestation", now],
		);

		const areaRow = db.get<{ surfacing_classification: string }>(
			"SELECT surfacing_classification FROM area_state_current WHERE agent_id = ? AND area_id = ? AND key = ?",
			["rp:alice", 1, "door:status"],
		);
		expect(areaRow?.surfacing_classification).toBe("latent_state_update");

		db.run(
			"INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["rp:alice", 1, "door:gm-note", '{"locked":false}', "private_only", "gm", now],
		);

		const sourceTypeRow = db.get<{ source_type: string }>(
			"SELECT source_type FROM area_state_current WHERE agent_id = ? AND area_id = ? AND key = ?",
			["rp:alice", 1, "door:gm-note"],
		);
		expect(sourceTypeRow?.source_type).toBe("gm");

		let invalidSourceTypeFailed = false;
		try {
			db.run(
				"INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["rp:alice", 1, "door:bad-source", '{"locked":false}', "latent_state_update", "external", now],
			);
		} catch {
			invalidSourceTypeFailed = true;
		}
		expect(invalidSourceTypeFailed).toBe(true);

		const worldRow = db.get<{ surfacing_classification: string }>(
			"SELECT surfacing_classification FROM world_state_current WHERE key = ?",
			["world:decree"],
		);
		expect(worldRow?.surfacing_classification).toBe("public_manifestation");

		db.close();
		cleanupDb(dbPath);
	});

	it("keeps V1 node ref kinds unchanged and navigator importable", () => {
		// V3: NODE_REF_KINDS is canonical-only (6 kinds)
		expect([...NODE_REF_KINDS]).toEqual(["event", "entity", "fact", "assertion", "evaluation", "commitment"]);
		expect(typeof GraphNavigator).toBe("function");
	});

	it("creates all 6 shared_blocks tables", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const sharedBlockTables = db
			.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'shared_block%' ORDER BY name",
			)
			.map((r) => r.name);

		expect(sharedBlockTables).toEqual([
			"shared_block_admins",
			"shared_block_attachments",
			"shared_block_patch_log",
			"shared_block_sections",
			"shared_block_snapshots",
			"shared_blocks",
		]);

		db.close();
		cleanupDb(dbPath);
	});

	it("rejects shared_block_attachments with target_kind != 'agent'", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const now = Date.now();
		db.run("INSERT INTO shared_blocks (title, created_by_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			"test block",
			"agent-1",
			now,
			now,
		]);

		let invalidKindFailed = false;
		try {
			db.run(
				"INSERT INTO shared_block_attachments (block_id, target_kind, target_id, attached_by_agent_id, attached_at) VALUES (?, ?, ?, ?, ?)",
				[1, "area", "area-1", "agent-1", now],
			);
		} catch {
			invalidKindFailed = true;
		}
		expect(invalidKindFailed).toBe(true);

		let validKindFailed = false;
		try {
			db.run(
				"INSERT INTO shared_block_attachments (block_id, target_kind, target_id, attached_by_agent_id, attached_at) VALUES (?, ?, ?, ?, ?)",
				[1, "agent", "agent-2", "agent-1", now],
			);
		} catch {
			validKindFailed = true;
		}
		expect(validKindFailed).toBe(false);

		db.close();
		cleanupDb(dbPath);
	});

	it("enforces UNIQUE(block_id, patch_seq) on shared_block_patch_log", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const now = Date.now();
		db.run("INSERT INTO shared_blocks (title, created_by_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			"test block",
			"agent-1",
			now,
			now,
		]);

		db.run(
			"INSERT INTO shared_block_patch_log (block_id, patch_seq, op, section_path, content, applied_by_agent_id, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[1, 1, "set_section", "profile", "hello", "agent-1", now],
		);

		let duplicateSeqFailed = false;
		try {
			db.run(
				"INSERT INTO shared_block_patch_log (block_id, patch_seq, op, section_path, content, applied_by_agent_id, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[1, 1, "set_section", "profile", "world", "agent-1", now],
			);
		} catch {
			duplicateSeqFailed = true;
		}
		expect(duplicateSeqFailed).toBe(true);

		let nextSeqFailed = false;
		try {
			db.run(
				"INSERT INTO shared_block_patch_log (block_id, patch_seq, op, section_path, content, applied_by_agent_id, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[1, 2, "set_section", "profile", "world", "agent-1", now],
			);
		} catch {
			nextSeqFailed = true;
		}
		expect(nextSeqFailed).toBe(false);

		db.close();
		cleanupDb(dbPath);
	});

	it("creates private_episode_events table with correct schema", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const table = db.get<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='private_episode_events'",
		);
		expect(table?.name).toBe("private_episode_events");

		const columns = listColumns(db, "private_episode_events");
		expect(columns).toContain("id");
		expect(columns).toContain("agent_id");
		expect(columns).toContain("session_id");
		expect(columns).toContain("settlement_id");
		expect(columns).toContain("category");
		expect(columns).toContain("summary");
		expect(columns).toContain("private_notes");
		expect(columns).toContain("location_entity_id");
		expect(columns).toContain("location_text");
		expect(columns).toContain("valid_time");
		expect(columns).toContain("committed_time");
		expect(columns).toContain("source_local_ref");
		expect(columns).toContain("created_at");

		const indexNames = db
			.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%private_episode%' ORDER BY name",
			)
			.map((row) => row.name);

		expect(indexNames).toContain("idx_private_episode_events_settlement");
		expect(indexNames).toContain("idx_private_episode_events_agent");

		db.close();
		cleanupDb(dbPath);
	});

	it("enforces private_episode_events category CHECK constraint", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const now = Date.now();
		let validInsertFailed = false;
		try {
			db.run(
				"INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, committed_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["agent-1", "s1", "stl:1", "speech", "test", now, now],
			);
		} catch {
			validInsertFailed = true;
		}
		expect(validInsertFailed).toBe(false);

		let thoughtFailed = false;
		try {
			db.run(
				"INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, committed_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["agent-1", "s1", "stl:2", "thought", "internal", now, now],
			);
		} catch {
			thoughtFailed = true;
		}
		expect(thoughtFailed).toBe(true);

		let invalidCatFailed = false;
		try {
			db.run(
				"INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, committed_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["agent-1", "s1", "stl:3", "feeling", "warm", now, now],
			);
		} catch {
			invalidCatFailed = true;
		}
		expect(invalidCatFailed).toBe(true);

		db.close();
		cleanupDb(dbPath);
	});

	it("private_episode_events migration is idempotent", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);
		runMemoryMigrations(db);

		const table = db.get<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='private_episode_events'",
		);
		expect(table?.name).toBe("private_episode_events");

		db.close();
		cleanupDb(dbPath);
	});
});

// ─── memory:021 — extended memory_relations relation_type CHECK ─────────────

describe("memory:021 extended relation types", () => {
	const NEW_RELATION_TYPES = ["surfaced_as", "published_as", "resolved_by", "downgraded_by"] as const;
	const ALL_RELATION_TYPES = [
		"supports", "triggered", "conflicts_with", "derived_from", "supersedes",
		...NEW_RELATION_TYPES,
	] as const;

	it("accepts all 9 relation types in memory_relations after migration", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const now = Date.now();

		for (const relType of ALL_RELATION_TYPES) {
			let threw = false;
			try {
				db.run(
					`INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[`event:${100 + ALL_RELATION_TYPES.indexOf(relType)}`, `entity:${200 + ALL_RELATION_TYPES.indexOf(relType)}`, relType, 0.5, "direct", "system", "test:021", now, now],
				);
			} catch (e) {
				threw = true;
				throw new Error(`relation_type '${relType}' should be accepted but threw: ${e}`);
			}
			expect(threw).toBe(false);
		}

		const count = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM memory_relations",
		);
		expect(count?.count).toBe(ALL_RELATION_TYPES.length);

		db.close();
		cleanupDb(dbPath);
	});

	it("still rejects invalid relation types", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const now = Date.now();

		expect(() => {
			db.run(
				`INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				["event:1", "entity:2", "invalid_type", 0.5, "direct", "system", "test:021", now, now],
			);
		}).toThrow();

		db.close();
		cleanupDb(dbPath);
	});

	it("preserves existing rows after migration rebuild", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const now = Date.now();

		db.run(
			`INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			["event:1", "entity:2", "supports", 0.8, "direct", "turn", "turn:pre-021", now, now],
		);

		runMemoryMigrations(db);

		const row = db.get<{ relation_type: string; strength: number }>(
			"SELECT relation_type, strength FROM memory_relations WHERE source_ref = 'turn:pre-021'",
		);
		expect(row?.relation_type).toBe("supports");
		expect(row?.strength).toBe(0.8);

		db.close();
		cleanupDb(dbPath);
	});

	it("migration count matches memory migrations after all migrations", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);

		const migrationCount = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM _migrations WHERE migration_id LIKE 'memory:%'",
		);
		expect(migrationCount?.count).toBe(MEMORY_MIGRATIONS.length);

		db.close();
		cleanupDb(dbPath);
	});
});
