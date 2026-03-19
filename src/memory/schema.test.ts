import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createMemorySchema,
  makeNodeRef,
  MAX_INTEGER,
  VisibilityScope,
  MemoryScope,
  EventCategory,
  ProjectionClass,
  PromotionClass,
} from "./schema";
import { TransactionBatcher } from "./transaction-batcher";

function freshDb(): Database {
  const db = new Database(":memory:");
  createMemorySchema(db);
  return db;
}

// ─── 1. Schema creates all 22 tables ────────────────────────────────────────

describe("createMemorySchema", () => {
  it("creates 20 non-FTS tables (17 core + 3 infrastructure)", () => {
    const db = freshDb();
    const result = db
      .prepare(
        "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name NOT LIKE '%fts%'"
      )
      .get() as { cnt: number };
    expect(result.cnt).toBe(20);
    db.close();
  });

  it("creates 3 FTS5 virtual tables", () => {
    const db = freshDb();
    const result = db
      .prepare(
        "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'"
      )
      .get() as { cnt: number };
    expect(result.cnt).toBe(3);
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
    db.prepare("INSERT INTO search_docs_world_fts(rowid, content) VALUES (?, ?)").run(
      1,
      "The quick brown fox jumps over the lazy dog"
    );

    // Trigram search for substring
    const results = db
      .prepare("SELECT rowid, content FROM search_docs_world_fts WHERE content MATCH ?")
      .all("brown fox") as { rowid: number; content: string }[];

    expect(results.length).toBe(1);
    expect(results[0].content).toContain("brown fox");
    db.close();
  });

  it("returns no results for non-matching substrings", () => {
    const db = freshDb();

    db.prepare("INSERT INTO search_docs_private_fts(rowid, content) VALUES (?, ?)").run(
      1,
      "Hello world example text"
    );

    const results = db
      .prepare("SELECT rowid FROM search_docs_private_fts WHERE content MATCH ?")
      .all("zzzznotfound") as { rowid: number }[];

    expect(results.length).toBe(0);
    db.close();
  });
});

// ─── 3. TransactionBatcher ──────────────────────────────────────────────────

describe("TransactionBatcher", () => {
  it("successful batch commits all rows", () => {
    const db = freshDb();
    const batcher = new TransactionBatcher(db);
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

    const count = db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number };
    expect(count.cnt).toBe(2);
    db.close();
  });

  it("failed batch rolls back all rows (UNIQUE violation)", () => {
    const db = freshDb();
    const batcher = new TransactionBatcher(db);
    const now = Date.now();

    // Insert one topic first
    db.prepare("INSERT INTO topics (name, description, created_at) VALUES (?, ?, ?)").run(
      "existing_topic",
      "Already exists",
      now
    );

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
    const count = db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number };
    expect(count.cnt).toBe(1);
    db.close();
  });

  it("runInTransaction commits on success", () => {
    const db = freshDb();
    const batcher = new TransactionBatcher(db);
    const now = Date.now();

    const result = batcher.runInTransaction(() => {
      db.prepare("INSERT INTO topics (name, description, created_at) VALUES (?, ?, ?)").run(
        "txn_topic",
        "From transaction",
        now
      );
      return "ok";
    });

    expect(result).toBe("ok");
    const count = db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number };
    expect(count.cnt).toBe(1);
    db.close();
  });

  it("runInTransaction rolls back on error", () => {
    const db = freshDb();
    const batcher = new TransactionBatcher(db);
    const now = Date.now();

    expect(() => {
      batcher.runInTransaction(() => {
        db.prepare("INSERT INTO topics (name, description, created_at) VALUES (?, ?, ?)").run(
          "will_rollback",
          "Should not persist",
          now
        );
        throw new Error("Intentional failure");
      });
    }).toThrow("Intentional failure");

    const count = db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number };
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
         VALUES (?, ?, ?, 'shared_public', 'agent_1', ?, ?)`
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
         VALUES (?, ?, ?, 'private_overlay', NULL, ?, ?)`
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
         VALUES (?, ?, ?, 'shared_public', NULL, ?, ?)`
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
         VALUES (?, ?, ?, 'private_overlay', 'agent_1', ?, ?)`
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
       VALUES (?, ?, ?, 'shared_public', NULL, ?, ?)`
    ).run("dup_ptr", "First", "person", now, now);

    expect(() => {
      db.prepare(
        `INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, 'shared_public', NULL, ?, ?)`
      ).run("dup_ptr", "Second", "person", now, now);
    }).toThrow();
    db.close();
  });

  it("different agents can share same pointer_key in private_overlay", () => {
    const db = freshDb();
    const now = Date.now();

    db.prepare(
      `INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, 'private_overlay', 'agent_1', ?, ?)`
    ).run("shared_ptr", "Agent1 view", "person", now, now);

    // Different agent, same pointer_key — should succeed
    let threw = false;
    try {
      db.prepare(
        `INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, 'private_overlay', 'agent_2', ?, ?)`
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
       VALUES (?, ?, ?, 'private_overlay', 'agent_1', ?, ?)`
    ).run("dup_private_ptr", "First", "person", now, now);

    expect(() => {
      db.prepare(
        `INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, 'private_overlay', 'agent_1', ?, ?)`
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
         VALUES (?, ?, ?, 'owner_private', ?, ?, ?)`
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
         VALUES (?, ?, ?, 'area_visible', ?, ?, ?)`
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
         VALUES (?, ?, ?, 'world_public', ?, ?, ?)`
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
         VALUES (?, ?, ?, 'area_visible', ?, ?, ?)`
      ).run("sess1", now, now, 1, "thought", "runtime_projection");
    }).toThrow();
    db.close();
  });
});

// ─── 7. makeNodeRef ─────────────────────────────────────────────────────────

describe("makeNodeRef", () => {
  it("returns 'event:42' for kind='event', id=42", () => {
    expect(makeNodeRef("event", 42)).toBe("event:42");
  });

  it("returns 'entity:1' for kind='entity', id=1", () => {
    expect(makeNodeRef("entity", 1)).toBe("entity:1");
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
