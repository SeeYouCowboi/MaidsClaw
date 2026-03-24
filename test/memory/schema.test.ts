import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphNavigator } from "../../src/memory/navigator.js";
import {
	MAX_INTEGER,
	makeNodeRef,
	runMemoryMigrations,
} from "../../src/memory/schema.js";
import { TransactionBatcher } from "../../src/memory/transaction-batcher.js";
import { NODE_REF_KINDS } from "../../src/memory/types.js";
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

function listColumns(db: ReturnType<typeof createTempDb>["db"], tableName: string): string[] {
	return db.query<{ name: string }>(`PRAGMA table_info(${tableName})`).map((row) => row.name);
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

		const factColumns = listColumns(db, "agent_fact_overlay");
		expect(factColumns.includes("basis")).toBe(true);
		expect(factColumns.includes("stance")).toBe(true);
		expect(factColumns.includes("pre_contested_stance")).toBe(true);
		expect(factColumns.includes("source_label_raw")).toBe(true);
		expect(factColumns.includes("source_event_ref")).toBe(true);
		expect(factColumns.includes("updated_at")).toBe(true);

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

	it("removes legacy overlay columns after rebuild migration", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const factColumns = listColumns(db, "agent_fact_overlay");
		expect(factColumns.includes("belief_type")).toBe(false);
		expect(factColumns.includes("confidence")).toBe(false);
		expect(factColumns.includes("epistemic_status")).toBe(false);

		db.close();
		cleanupDb(dbPath);
	});

	it("stores canonical stance and basis directly after rebuild migration", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		const insertResult = db.run(
			"INSERT INTO agent_fact_overlay (agent_id, source_entity_id, target_entity_id, predicate, stance, basis, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				"agent-1",
				1,
				2,
				"knows",
				"tentative",
				"first_hand",
				Date.now(),
				Date.now(),
			],
		);

		const row = db.get<{ stance: string | null; basis: string | null }>(
			"SELECT stance, basis FROM agent_fact_overlay WHERE id = ?",
			[Number(insertResult.lastInsertRowid)],
		);
		expect(row?.stance).toBe("tentative");
		expect(row?.basis).toBe("first_hand");

		db.close();
		cleanupDb(dbPath);
	});

	it("is idempotent when migrations run multiple times", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);
		runMemoryMigrations(db);

		const migrationCount = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM _migrations WHERE migration_id LIKE 'memory:%'",
		);
		expect(migrationCount?.count).toBe(22);

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

		const worldRow = db.get<{ surfacing_classification: string }>(
			"SELECT surfacing_classification FROM world_state_current WHERE key = ?",
			["world:decree"],
		);
		expect(worldRow?.surfacing_classification).toBe("public_manifestation");

		db.close();
		cleanupDb(dbPath);
	});

	it("allows contested stance without pre_contested_stance for legacy-table compatibility", () => {
		const { dbPath, db } = createTempDb();

		runMemoryMigrations(db);

		let insertFailed = false;
		try {
			db.run(
				"INSERT INTO agent_fact_overlay (agent_id, source_entity_id, target_entity_id, predicate, stance, pre_contested_stance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				["agent-1", 1, 2, "knows", "contested", null, Date.now(), Date.now()],
			);
		} catch {
			insertFailed = true;
		}

		expect(insertFailed).toBe(false);

		db.close();
		cleanupDb(dbPath);
	});

	it("keeps V1 node ref kinds unchanged and navigator importable", () => {
		expect([...NODE_REF_KINDS]).toEqual(["event", "entity", "fact", "assertion", "evaluation", "commitment", "private_event", "private_belief"]);
		expect(typeof GraphNavigator).toBe("function");
		expect(String(makeNodeRef("private_belief", 1))).toBe("private_belief:1");
		expect(String(makeNodeRef("private_event", 1))).toBe("private_event:1");
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

	it("migration count is 22 after all migrations", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);

		const migrationCount = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM _migrations WHERE migration_id LIKE 'memory:%'",
		);
		expect(migrationCount?.count).toBe(22);

		db.close();
		cleanupDb(dbPath);
	});
});
