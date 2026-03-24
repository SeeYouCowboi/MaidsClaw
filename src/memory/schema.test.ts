import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../storage/database";
import { parseGraphNodeRef } from "./contracts/graph-node-ref";
import {
	createMemorySchema,
	EventCategory,
	MAX_INTEGER,
	MemoryScope,
	makeNodeRef,
	ProjectionClass,
	PromotionClass,
	runMemoryMigrations,
	VisibilityScope,
} from "./schema";
import { TransactionBatcher } from "./transaction-batcher";

function freshDb(): Database {
	const db = new Database(":memory:");
	createMemorySchema(db);
	return db;
}

// ─── 1. Schema creates all 45 tables ────────────────────────────────────────

describe("createMemorySchema", () => {
	it("creates 53 non-FTS tables (core + infrastructure + FTS shadow tables)", () => {
		const db = freshDb();
		const result = db
			.prepare(
				"SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND sql NOT LIKE '%fts5%'",
			)
			.get() as { cnt: number };
		expect(result.cnt).toBe(53);
		db.close();
	});

	it("creates 4 FTS5 virtual tables", () => {
		const db = freshDb();
		const result = db
			.prepare(
				"SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'",
			)
			.get() as { cnt: number };
		expect(result.cnt).toBe(4);
		db.close();
	});

	it("is idempotent — running twice does not error", () => {
		const db = new Database(":memory:");
		createMemorySchema(db);
		let threw = false;
		try {
			createMemorySchema(db);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		db.close();
	});
});

// ─── 2. FTS5 trigram search ─────────────────────────────────────────────────

describe("FTS5 trigram search", () => {
	it("supports Latin substring search via trigram tokenizer", () => {
		const db = freshDb();

		// Insert a document into the FTS table
		db.prepare(
			"INSERT INTO search_docs_world_fts(rowid, content) VALUES (?, ?)",
		).run(1, "The quick brown fox jumps over the lazy dog");

		// Trigram search for substring
		const results = db
			.prepare(
				"SELECT rowid, content FROM search_docs_world_fts WHERE content MATCH ?",
			)
			.all("brown fox") as { rowid: number; content: string }[];

		expect(results.length).toBe(1);
		expect(results[0].content).toContain("brown fox");
		db.close();
	});

	it("returns no results for non-matching substrings", () => {
		const db = freshDb();

		db.prepare(
			"INSERT INTO search_docs_private_fts(rowid, content) VALUES (?, ?)",
		).run(1, "Hello world example text");

		const results = db
			.prepare(
				"SELECT rowid FROM search_docs_private_fts WHERE content MATCH ?",
			)
			.all("zzzznotfound") as { rowid: number }[];

		expect(results.length).toBe(0);
		db.close();
	});
});

// ─── 3. TransactionBatcher ──────────────────────────────────────────────────

describe("TransactionBatcher", () => {
	it("successful batch commits all rows", () => {
		const db = freshDb();
		const batcher = new TransactionBatcher(
			db as unknown as ConstructorParameters<typeof TransactionBatcher>[0],
		);
		const now = Date.now();

		batcher.run([
			{
				sql: "INSERT INTO topics (name, description, created_at) VALUES (?, ?, ?)",
				params: ["topic_a", "First topic", now],
			},
			{
				sql: "INSERT INTO topics (name, description, created_at) VALUES (?, ?, ?)",
				params: ["topic_b", "Second topic", now],
			},
		]);

		const count = db.prepare("SELECT count(*) as cnt FROM topics").get() as {
			cnt: number;
		};
		expect(count.cnt).toBe(2);
		db.close();
	});

	it("failed batch rolls back all rows (UNIQUE violation)", () => {
		const db = freshDb();
		const batcher = new TransactionBatcher(
			db as unknown as ConstructorParameters<typeof TransactionBatcher>[0],
		);
		const now = Date.now();

		// Insert one topic first
		db.prepare(
			"INSERT INTO topics (name, description, created_at) VALUES (?, ?, ?)",
		).run("existing_topic", "Already exists", now);

		// Batch with a UNIQUE violation on second op
		expect(() => {
			batcher.run([
				{
					sql: "INSERT INTO topics (name, description, created_at) VALUES (?, ?, ?)",
					params: ["new_topic", "Should be rolled back", now],
				},
				{
					sql: "INSERT INTO topics (name, description, created_at) VALUES (?, ?, ?)",
					params: ["existing_topic", "Duplicate - will fail", now],
				},
			]);
		}).toThrow();

		// Only the original row should exist — batch was rolled back
		const count = db.prepare("SELECT count(*) as cnt FROM topics").get() as {
			cnt: number;
		};
		expect(count.cnt).toBe(1);
		db.close();
	});

	it("runInTransaction commits on success", () => {
		const db = freshDb();
		const batcher = new TransactionBatcher(
			db as unknown as ConstructorParameters<typeof TransactionBatcher>[0],
		);
		const now = Date.now();

		const result = batcher.runInTransaction(() => {
			db.prepare(
				"INSERT INTO topics (name, description, created_at) VALUES (?, ?, ?)",
			).run("txn_topic", "From transaction", now);
			return "ok";
		});

		expect(result).toBe("ok");
		const count = db.prepare("SELECT count(*) as cnt FROM topics").get() as {
			cnt: number;
		};
		expect(count.cnt).toBe(1);
		db.close();
	});

	it("runInTransaction rolls back on error", () => {
		const db = freshDb();
		const batcher = new TransactionBatcher(
			db as unknown as ConstructorParameters<typeof TransactionBatcher>[0],
		);
		const now = Date.now();

		expect(() => {
			batcher.runInTransaction(() => {
				db.prepare(
					"INSERT INTO topics (name, description, created_at) VALUES (?, ?, ?)",
				).run("will_rollback", "Should not persist", now);
				throw new Error("Intentional failure");
			});
		}).toThrow("Intentional failure");

		const count = db.prepare("SELECT count(*) as cnt FROM topics").get() as {
			cnt: number;
		};
		expect(count.cnt).toBe(0);
		db.close();
	});
});

// ─── 4. entity_nodes CHECK constraint ───────────────────────────────────────

describe("entity_nodes CHECK constraints", () => {
	it("enforces memory_scope/owner_agent_id: shared_public requires NULL owner", () => {
		const db = freshDb();
		const now = Date.now();

		// shared_public with owner_agent_id should fail
		expect(() => {
			db.prepare(
				`INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, 'shared_public', 'agent_1', ?, ?)`,
			).run("test_ptr", "Test", "person", now, now);
		}).toThrow();
		db.close();
	});

	it("enforces memory_scope/owner_agent_id: private_overlay requires owner", () => {
		const db = freshDb();
		const now = Date.now();

		// private_overlay without owner should fail
		expect(() => {
			db.prepare(
				`INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, 'private_overlay', NULL, ?, ?)`,
			).run("test_ptr", "Test", "person", now, now);
		}).toThrow();
		db.close();
	});

	it("allows valid shared_public insert (NULL owner)", () => {
		const db = freshDb();
		const now = Date.now();

		let threw = false;
		try {
			db.prepare(
				`INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, 'shared_public', NULL, ?, ?)`,
			).run("valid_ptr", "Valid", "person", now, now);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		db.close();
	});

	it("allows valid private_overlay insert (with owner)", () => {
		const db = freshDb();
		const now = Date.now();

		let threw = false;
		try {
			db.prepare(
				`INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, 'private_overlay', 'agent_1', ?, ?)`,
			).run("valid_ptr", "Valid", "person", now, now);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		db.close();
	});
});

// ─── 5. Partial unique indexes on entity_nodes ──────────────────────────────

describe("entity_nodes partial unique indexes", () => {
	it("rejects duplicate shared_public pointer_key", () => {
		const db = freshDb();
		const now = Date.now();

		db.prepare(
			`INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, 'shared_public', NULL, ?, ?)`,
		).run("dup_ptr", "First", "person", now, now);

		expect(() => {
			db.prepare(
				`INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, 'shared_public', NULL, ?, ?)`,
			).run("dup_ptr", "Second", "person", now, now);
		}).toThrow();
		db.close();
	});

	it("different agents can share same pointer_key in private_overlay", () => {
		const db = freshDb();
		const now = Date.now();

		db.prepare(
			`INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, 'private_overlay', 'agent_1', ?, ?)`,
		).run("shared_ptr", "Agent1 view", "person", now, now);

		// Different agent, same pointer_key — should succeed
		let threw = false;
		try {
			db.prepare(
				`INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, 'private_overlay', 'agent_2', ?, ?)`,
			).run("shared_ptr", "Agent2 view", "person", now, now);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		db.close();
	});

	it("same agent cannot have duplicate pointer_key in private_overlay", () => {
		const db = freshDb();
		const now = Date.now();

		db.prepare(
			`INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, 'private_overlay', 'agent_1', ?, ?)`,
		).run("dup_private_ptr", "First", "person", now, now);

		expect(() => {
			db.prepare(
				`INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, 'private_overlay', 'agent_1', ?, ?)`,
			).run("dup_private_ptr", "Second", "person", now, now);
		}).toThrow();
		db.close();
	});
});

// ─── 6. event_nodes visibility_scope CHECK ──────────────────────────────────

describe("event_nodes CHECK constraints", () => {
	it("rejects invalid visibility_scope 'owner_private'", () => {
		const db = freshDb();
		const now = Date.now();

		expect(() => {
			db.prepare(
				`INSERT INTO event_nodes (session_id, timestamp, created_at, visibility_scope, location_entity_id, event_category, event_origin)
         VALUES (?, ?, ?, 'owner_private', ?, ?, ?)`,
			).run("sess1", now, now, 1, "speech", "runtime_projection");
		}).toThrow();
		db.close();
	});

	it("accepts valid visibility_scope 'area_visible'", () => {
		const db = freshDb();
		const now = Date.now();

		let threw = false;
		try {
			db.prepare(
				`INSERT INTO event_nodes (session_id, timestamp, created_at, visibility_scope, location_entity_id, event_category, event_origin)
         VALUES (?, ?, ?, 'area_visible', ?, ?, ?)`,
			).run("sess1", now, now, 1, "speech", "runtime_projection");
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		db.close();
	});

	it("accepts valid visibility_scope 'world_public'", () => {
		const db = freshDb();
		const now = Date.now();

		let threw = false;
		try {
			db.prepare(
				`INSERT INTO event_nodes (session_id, timestamp, created_at, visibility_scope, location_entity_id, event_category, event_origin)
         VALUES (?, ?, ?, 'world_public', ?, ?, ?)`,
			).run("sess1", now, now, 1, "action", "promotion");
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		db.close();
	});

	it("rejects invalid event_category 'thought'", () => {
		const db = freshDb();
		const now = Date.now();

		expect(() => {
			db.prepare(
				`INSERT INTO event_nodes (session_id, timestamp, created_at, visibility_scope, location_entity_id, event_category, event_origin)
         VALUES (?, ?, ?, 'area_visible', ?, ?, ?)`,
			).run("sess1", now, now, 1, "thought", "runtime_projection");
		}).toThrow();
		db.close();
	});
});

// ─── 7. makeNodeRef ─────────────────────────────────────────────────────────

describe("makeNodeRef", () => {
	it("returns 'event:42' for kind='event', id=42", () => {
		expect(String(makeNodeRef("event", 42))).toBe("event:42");
	});

	it("returns 'entity:1' for kind='entity', id=1", () => {
		expect(String(makeNodeRef("entity", 1))).toBe("entity:1");
	});

	it("rejects unsupported kinds", () => {
		let threw = false;
		try {
			makeNodeRef("custom" as never, 99);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});

// ─── 8. MAX_INTEGER ─────────────────────────────────────────────────────────

describe("MAX_INTEGER", () => {
	it("equals Number.MAX_SAFE_INTEGER (9007199254740991)", () => {
		expect(MAX_INTEGER).toBe(Number.MAX_SAFE_INTEGER);
		expect(MAX_INTEGER).toBe(9007199254740991);
	});
});

// ─── 9. Enum-like const objects ─────────────────────────────────────────────

describe("enum-like const objects", () => {
	it("VisibilityScope has correct values", () => {
		expect(VisibilityScope.AREA_VISIBLE).toBe("area_visible");
		expect(VisibilityScope.WORLD_PUBLIC).toBe("world_public");
	});

	it("MemoryScope has correct values", () => {
		expect(MemoryScope.SHARED_PUBLIC).toBe("shared_public");
		expect(MemoryScope.PRIVATE_OVERLAY).toBe("private_overlay");
	});

	it("EventCategory has correct values", () => {
		expect(EventCategory.SPEECH).toBe("speech");
		expect(EventCategory.ACTION).toBe("action");
		expect(EventCategory.OBSERVATION).toBe("observation");
		expect(EventCategory.STATE_CHANGE).toBe("state_change");
	});

	it("ProjectionClass has correct values", () => {
		expect(ProjectionClass.NONE).toBe("none");
		expect(ProjectionClass.AREA_CANDIDATE).toBe("area_candidate");
	});

	it("PromotionClass has correct values", () => {
		expect(PromotionClass.NONE).toBe("none");
		expect(PromotionClass.WORLD_CANDIDATE).toBe("world_candidate");
	});
});

// ─── 10. Append-only ledger triggers ────────────────────────────────────────

describe("append-only ledger triggers", () => {
	it("rejects UPDATE on private_cognition_events", () => {
		const db = freshDb();
		const now = Date.now();

		db.prepare(
			`INSERT INTO private_cognition_events (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("agent_1", "key_1", "assertion", "upsert", '{}', "settle_1", now, now);

		expect(() => {
			db.prepare(
				`UPDATE private_cognition_events SET record_json = '{"updated":true}' WHERE agent_id = 'agent_1'`,
			).run();
		}).toThrow(/append-only/);
		db.close();
	});

	it("rejects DELETE on private_cognition_events", () => {
		const db = freshDb();
		const now = Date.now();

		db.prepare(
			`INSERT INTO private_cognition_events (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("agent_1", "key_1", "assertion", "upsert", '{}', "settle_1", now, now);

		expect(() => {
			db.prepare(
				`DELETE FROM private_cognition_events WHERE agent_id = 'agent_1'`,
			).run();
		}).toThrow(/append-only/);
		db.close();
	});

	it("rejects UPDATE on private_episode_events", () => {
		const db = freshDb();
		const now = Date.now();

		db.prepare(
			`INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, committed_time, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("agent_1", "sess_1", "settle_1", "speech", "hello", now, now);

		expect(() => {
			db.prepare(
				`UPDATE private_episode_events SET summary = 'modified' WHERE agent_id = 'agent_1'`,
			).run();
		}).toThrow(/append-only/);
		db.close();
	});

	it("rejects DELETE on private_episode_events", () => {
		const db = freshDb();
		const now = Date.now();

		db.prepare(
			`INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, committed_time, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("agent_1", "sess_1", "settle_1", "speech", "hello", now, now);

		expect(() => {
			db.prepare(
				`DELETE FROM private_episode_events WHERE agent_id = 'agent_1'`,
			).run();
		}).toThrow(/append-only/);
		db.close();
	});
});

// ─── 11. Episode idempotency key ────────────────────────────────────────────

describe("private_episode_events idempotency", () => {
	it("rejects duplicate (settlement_id, source_local_ref)", () => {
		const db = freshDb();
		const now = Date.now();

		db.prepare(
			`INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, committed_time, source_local_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("agent_1", "sess_1", "settle_1", "speech", "first", now, "ref_001", now);

		expect(() => {
			db.prepare(
				`INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, committed_time, source_local_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("agent_2", "sess_2", "settle_1", "action", "duplicate", now, "ref_001", now);
		}).toThrow();
		db.close();
	});

	it("allows same source_local_ref in different settlements", () => {
		const db = freshDb();
		const now = Date.now();

		db.prepare(
			`INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, committed_time, source_local_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("agent_1", "sess_1", "settle_1", "speech", "first", now, "ref_001", now);

		let threw = false;
		try {
			db.prepare(
				`INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, committed_time, source_local_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("agent_1", "sess_1", "settle_2", "speech", "second", now, "ref_001", now);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		db.close();
	});

	it("allows NULL source_local_ref duplicates in same settlement", () => {
		const db = freshDb();
		const now = Date.now();

		db.prepare(
			`INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, committed_time, source_local_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("agent_1", "sess_1", "settle_1", "speech", "first", now, null, now);

		let threw = false;
		try {
			db.prepare(
				`INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, committed_time, source_local_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("agent_1", "sess_1", "settle_1", "speech", "second", now, null, now);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		db.close();
	});
});

// ─── 12. fact_edges t_valid CHECK ───────────────────────────────────────────

describe("fact_edges t_valid CHECK constraint", () => {
	it("allows t_valid = 0 (no time constraint)", () => {
		const db = freshDb();
		const now = Date.now();

		let threw = false;
		try {
			db.prepare(
				`INSERT INTO fact_edges (source_entity_id, target_entity_id, predicate, t_valid, t_created)
         VALUES (?, ?, ?, ?, ?)`,
			).run(1, 2, "knows", 0, now);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		db.close();
	});

	it("allows positive t_valid", () => {
		const db = freshDb();
		const now = Date.now();

		let threw = false;
		try {
			db.prepare(
				`INSERT INTO fact_edges (source_entity_id, target_entity_id, predicate, t_valid, t_created)
         VALUES (?, ?, ?, ?, ?)`,
			).run(1, 2, "knows", 1000, now);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		db.close();
	});

	it("rejects negative t_valid", () => {
		const db = freshDb();
		const now = Date.now();

		expect(() => {
			db.prepare(
				`INSERT INTO fact_edges (source_entity_id, target_entity_id, predicate, t_valid, t_created)
         VALUES (?, ?, ?, ?, ?)`,
			).run(1, 2, "knows", -1, now);
		}).toThrow();
		db.close();
	});
});

// ─── 13. Migration:022 — node_embeddings node_id column ────────────────────

describe("migration:022 node_embeddings node_id", () => {
	function freshMigrationDb() {
		const dbPath = join(tmpdir(), `maidsclaw-schema-test-${randomUUID()}.db`);
		const db = openDatabase({ path: dbPath });
		createMemorySchema(db.raw);
		return { db, dbPath };
	}

	function cleanup(dbPath: string) {
		try {
			rmSync(dbPath, { force: true });
			rmSync(`${dbPath}-shm`, { force: true });
			rmSync(`${dbPath}-wal`, { force: true });
		} catch {}
	}

	it("applies 22 migrations without error", () => {
		const { db, dbPath } = freshMigrationDb();
		runMemoryMigrations(db);
		const rows = db.get<{ cnt: number }>("SELECT count(*) as cnt FROM _migrations");
		expect(rows!.cnt).toBe(22);
		db.close();
		cleanup(dbPath);
	});

	it("node_embeddings has node_id column after migration", () => {
		const { db, dbPath } = freshMigrationDb();
		runMemoryMigrations(db);
		const cols = db.query<{ name: string }>("PRAGMA table_info(node_embeddings)");
		const colNames = cols.map((c) => c.name);
		expect(colNames).toContain("node_id");
		expect(colNames).toContain("node_kind");
		expect(colNames).toContain("node_ref");
		db.close();
		cleanup(dbPath);
	});

	it("backfills node_id from node_ref during migration", () => {
		const { db, dbPath } = freshMigrationDb();
		const now = Date.now();
		db.run(
			`INSERT INTO node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
			["private_belief:42", "private_belief", "primary", "test-model", new Uint8Array([1, 2, 3]), now],
		);
		runMemoryMigrations(db);
		const row = db.get<{ node_id: string; node_kind: string; node_ref: string }>(
			"SELECT node_id, node_kind, node_ref FROM node_embeddings WHERE node_ref = ?",
			["private_belief:42"],
		);
		expect(row!.node_id).toBe("42");
		expect(row!.node_kind).toBe("private_belief");
		expect(row!.node_ref).toBe("private_belief:42");
		db.close();
		cleanup(dbPath);
	});
});

// ─── 14. parseGraphNodeRef backward compatibility ───────────────────────────

describe("parseGraphNodeRef backward compat", () => {
	it("parses legacy private_belief:42 ref", () => {
		const ref = parseGraphNodeRef("private_belief:42");
		expect(ref.kind).toBe("private_belief");
		expect(ref.id).toBe("42");
	});

	it("parses legacy private_event:7 ref", () => {
		const ref = parseGraphNodeRef("private_event:7");
		expect(ref.kind).toBe("private_event");
		expect(ref.id).toBe("7");
	});

	it("parses canonical assertion:100 ref", () => {
		const ref = parseGraphNodeRef("assertion:100");
		expect(ref.kind).toBe("assertion");
		expect(ref.id).toBe("100");
	});

	it("throws on invalid format", () => {
		expect(() => parseGraphNodeRef("invalid")).toThrow();
	});

	it("throws on unknown kind", () => {
		expect(() => parseGraphNodeRef("bogus:1")).toThrow();
	});
});
