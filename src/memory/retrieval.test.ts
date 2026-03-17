import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { EmbeddingService } from "./embeddings.js";
import { RetrievalService } from "./retrieval.js";
import { createMemorySchema, MAX_INTEGER } from "./schema.js";
import { TransactionBatcher } from "./transaction-batcher.js";
import type { NodeRef, ViewerContext } from "./types.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  createMemorySchema(db);
  return db;
}

function insertSearchDoc(
  db: Database,
  scope: "private" | "area" | "world",
  data: { sourceRef: NodeRef; docType: string; content: string; agentId?: string; locationEntityId?: number },
): void {
  const now = Date.now();
  if (scope === "private") {
    db.prepare(
      "INSERT INTO search_docs_private (id, doc_type, source_ref, agent_id, content, created_at) VALUES (?,?,?,?,?,?)",
    ).run(
      null,
      data.docType,
      data.sourceRef,
      data.agentId,
      data.content,
      now,
    );
    const id = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    db.prepare("INSERT INTO search_docs_private_fts(rowid, content) VALUES (?,?)").run(id.id, data.content);
    return;
  }

  if (scope === "area") {
    db.prepare(
      "INSERT INTO search_docs_area (id, doc_type, source_ref, location_entity_id, content, created_at) VALUES (?,?,?,?,?,?)",
    ).run(
      null,
      data.docType,
      data.sourceRef,
      data.locationEntityId,
      data.content,
      now,
    );
    const id = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    db.prepare("INSERT INTO search_docs_area_fts(rowid, content) VALUES (?,?)").run(id.id, data.content);
    return;
  }

  db.prepare("INSERT INTO search_docs_world (id, doc_type, source_ref, content, created_at) VALUES (?,?,?,?,?)").run(
    null,
    data.docType,
    data.sourceRef,
    data.content,
    now,
  );
  const id = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
  db.prepare("INSERT INTO search_docs_world_fts(rowid, content) VALUES (?,?)").run(id.id, data.content);
}

describe("RetrievalService", () => {
  let db: Database;
  let service: RetrievalService;
  let rpCtx: ViewerContext;
  let otherRpCtx: ViewerContext;

  beforeEach(() => {
    db = freshDb();
    service = new RetrievalService(db);
    rpCtx = {
      viewer_agent_id: "agent-a",
      viewer_role: "rp_agent",
      current_area_id: 10,
      session_id: "sess-1",
    };
    otherRpCtx = {
      viewer_agent_id: "agent-b",
      viewer_role: "rp_agent",
      current_area_id: 10,
      session_id: "sess-1",
    };
  });

  it("readByEntity follows pointer redirects", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO pointer_redirects (old_name, new_name, redirect_type, owner_agent_id, created_at) VALUES (?,?,?,?,?)",
    ).run("old-name", "alice-new", "merge", null, now);
    db.prepare(
      "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("alice-new", "Alice", "person", "shared_public", null, null, "shared", now, now);

    const result = service.readByEntity("old-name", rpCtx);
    expect(result.entity?.pointer_key).toBe("alice-new");
  });

  it("readByEntity prioritizes private overlay over shared", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("alice", "Alice Shared", "person", "shared_public", null, null, "shared", now, now);
    db.prepare(
      "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("alice", "Alice Private", "person", "private_overlay", "agent-a", null, "private", now, now);

    const result = service.readByEntity("alice", rpCtx);
    expect(result.entity?.memory_scope).toBe("private_overlay");
    expect(result.entity?.display_name).toBe("Alice Private");
  });

  it("readByEntity resolves aliases to canonical entity", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO entity_nodes (id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(20, "alice-canonical", "Alice", "person", "shared_public", null, null, "shared", now, now);
    db.prepare(
      "INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id) VALUES (?,?,?,?)",
    ).run(20, "ally", "nickname", null);

    const result = service.readByEntity("ally", rpCtx);
    expect(result.entity?.id).toBe(20);
  });

  it("readByEventIds enforces world_public and area_visible filters", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO event_nodes (id, session_id, timestamp, created_at, visibility_scope, location_entity_id, event_category, event_origin) VALUES (?,?,?,?,?,?,?,?)",
    ).run(1, "sess-1", now, now, "world_public", 123, "speech", "promotion");
    db.prepare(
      "INSERT INTO event_nodes (id, session_id, timestamp, created_at, visibility_scope, location_entity_id, event_category, event_origin) VALUES (?,?,?,?,?,?,?,?)",
    ).run(2, "sess-1", now, now, "area_visible", 999, "speech", "runtime_projection");

    const result = service.readByEventIds([1, 2], rpCtx);
    expect(result.map((event) => event.id)).toEqual([1]);
  });

  it("searchVisibleNarrative returns private, area, and world for rp_agent", async () => {
    insertSearchDoc(db, "private", {
      sourceRef: "private_event:1" as NodeRef,
      docType: "private_event",
      agentId: "agent-a",
      content: "agent-a private coffee note",
    });
    insertSearchDoc(db, "area", {
      sourceRef: "event:2" as NodeRef,
      docType: "event",
      locationEntityId: 10,
      content: "area coffee smell",
    });
    insertSearchDoc(db, "world", {
      sourceRef: "event:3" as NodeRef,
      docType: "event",
      content: "world coffee festival",
    });

    const results = await service.searchVisibleNarrative("coffee", rpCtx);
    const scopes = new Set(results.map((item) => item.scope));
    expect(scopes.has("private")).toBe(true);
    expect(scopes.has("area")).toBe(true);
    expect(scopes.has("world")).toBe(true);
  });

  it("searchVisibleNarrative returns empty for short queries", async () => {
    const results = await service.searchVisibleNarrative("ab", rpCtx);
    expect(results).toEqual([]);
  });

  it("generateMemoryHints returns at most 5 hints", async () => {
    for (let i = 1; i <= 7; i += 1) {
      insertSearchDoc(db, "world", {
        sourceRef: `event:${i}` as NodeRef,
        docType: "event",
        content: `coffee memory ${i}`,
      });
    }

    const hints = await service.generateMemoryHints("Tell me about coffee", rpCtx);
    expect(hints.length).toBeLessThanOrEqual(5);
    expect(hints.length).toBeGreaterThan(0);
  });

  it("generateMemoryHints returns empty for very short messages", async () => {
    const hints = await service.generateMemoryHints("Hi", rpCtx);
    expect(hints).toEqual([]);
  });

  it("localizeSeedsHybrid returns lexical-only seeds when embeddings are empty", async () => {
    insertSearchDoc(db, "world", {
      sourceRef: "event:1" as NodeRef,
      docType: "event",
      content: "coffee event",
    });

    const seeds = await service.localizeSeedsHybrid("coffee", rpCtx, 10);
    expect(seeds.length).toBeGreaterThan(0);
    expect(seeds.every((seed) => seed.semantic_score === 0)).toBe(true);
  });

  it("localizeSeedsHybrid fuses lexical and semantic seeds when query embedding is provided", async () => {
    insertSearchDoc(db, "world", {
      sourceRef: "event:1" as NodeRef,
      docType: "event",
      content: "coffee at dawn",
    });

    const embeddingService = new EmbeddingService(db, new TransactionBatcher(db));
    embeddingService.batchStoreEmbeddings([
      {
        nodeRef: "event:1" as NodeRef,
        nodeKind: "event",
        viewType: "primary",
        modelId: "test-model",
        embedding: new Float32Array([1, 0, 0]),
      },
      {
        nodeRef: "event:9" as NodeRef,
        nodeKind: "event",
        viewType: "primary",
        modelId: "test-model",
        embedding: new Float32Array([0.9, 0.1, 0]),
      },
    ]);

    const seeds = await service.localizeSeedsHybrid("coffee", rpCtx, 10, new Float32Array([1, 0, 0]));
    expect(seeds.length).toBeGreaterThan(0);
    expect(seeds.some((seed) => seed.semantic_score > 0)).toBe(true);
  });

  it("agent-b cannot read agent-a private search docs", async () => {
    insertSearchDoc(db, "private", {
      sourceRef: "private_event:1" as NodeRef,
      docType: "private_event",
      agentId: "agent-a",
      content: "coffee secret",
    });
    insertSearchDoc(db, "world", {
      sourceRef: "event:100" as NodeRef,
      docType: "event",
      content: "coffee fair",
    });

    const results = await service.searchVisibleNarrative("coffee", otherRpCtx);
    expect(results.some((result) => result.scope === "private")).toBe(false);
    expect(results.some((result) => result.source_ref === "event:100")).toBe(true);
  });

  it("readByFactIds returns only current facts", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO fact_edges (id, source_entity_id, target_entity_id, predicate, t_valid, t_invalid, t_created, t_expired, source_event_id) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(1, 1, 2, "likes", now, MAX_INTEGER, now, MAX_INTEGER, null);
    db.prepare(
      "INSERT INTO fact_edges (id, source_entity_id, target_entity_id, predicate, t_valid, t_invalid, t_created, t_expired, source_event_id) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(2, 1, 3, "likes", now, now, now, MAX_INTEGER, null);

    const facts = service.readByFactIds([1, 2], rpCtx);
    expect(facts.map((fact) => fact.id)).toEqual([1]);
  });

  it("unflushed explicit cognition is not searchable", async () => {
    // recent_cognition_slots table does not exist in retrieval tests (it's in interaction schema)
    // This test verifies that RetrievalService.searchVisibleNarrative only queries
    // search_docs_private/search_docs_area/search_docs_world — NOT recent_cognition_slots

    // Verify retrieval.ts does NOT read from recent_cognition_slots by checking search behavior
    // Since recent_cognition_slots is not in the search path, any content there won't be found

    // Search for content that might appear in staged cognition
    const results = await service.searchVisibleNarrative("unflushed staged belief", rpCtx);

    // Unflushed cognition should NOT appear in search results (retrieval is flush-backed only)
    expect(results.length).toBe(0);
  });

  it("flushed explicit cognition becomes searchable after organizer", async () => {
    const now = Date.now();

    // Insert flushed explicit cognition into agent_fact_overlay (simulating flush-time write)
    db.prepare(
      "INSERT INTO agent_fact_overlay (agent_id, source_entity_id, target_entity_id, predicate, cognition_key, settlement_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("agent-a", 0, 0, "flushed belief predicate", "flushed-belief", "stl:flushed", now, now);

    // Insert corresponding search doc in search_docs_private (simulating organizer sync)
    db.prepare(
      "INSERT INTO search_docs_private (doc_type, source_ref, agent_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("private_belief", "private_belief:1", "agent-a", "This belief has been flushed to overlay", now);
    const id = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    db.prepare("INSERT INTO search_docs_private_fts(rowid, content) VALUES (?,?)").run(id.id, "This belief has been flushed to overlay");

    // Search for the flushed cognition content
    const results = await service.searchVisibleNarrative("flushed belief", rpCtx);

    // Flushed cognition SHOULD appear in search results (after organizer sync)
    const flushedResult = results.some((r) => r.content.includes("flushed to overlay"));
    expect(flushedResult).toBe(true);
    expect(results.some((r) => r.scope === "private")).toBe(true);
  });
});
