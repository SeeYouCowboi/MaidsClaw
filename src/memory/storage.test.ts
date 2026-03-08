import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { createMemorySchema, MAX_INTEGER, makeNodeRef } from "./schema.js";
import { GraphStorageService } from "./storage.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  createMemorySchema(db);
  return db;
}

describe("GraphStorageService", () => {
  let db: Database;
  let storage: GraphStorageService;

  beforeEach(() => {
    db = freshDb();
    storage = new GraphStorageService(db);
  });

  it("upsertEntity shared_public returns same id and updates summary", () => {
    const firstId = storage.upsertEntity({
      pointerKey: "entity:alice",
      displayName: "Alice",
      entityType: "person",
      summary: "first",
      memoryScope: "shared_public",
    });

    const secondId = storage.upsertEntity({
      pointerKey: "entity:alice",
      displayName: "Alice",
      entityType: "person",
      summary: "updated",
      memoryScope: "shared_public",
    });

    expect(secondId).toBe(firstId);
    const row = db
      .prepare(`SELECT summary FROM entity_nodes WHERE id = ?`)
      .get(firstId) as { summary: string };
    expect(row.summary).toBe("updated");
  });

  it("upsertEntity private_overlay creates separate row from shared_public", () => {
    const sharedId = storage.upsertEntity({
      pointerKey: "entity:bob",
      displayName: "Bob",
      entityType: "person",
      memoryScope: "shared_public",
    });
    const privateId = storage.upsertEntity({
      pointerKey: "entity:bob",
      displayName: "Bob",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
    });

    expect(privateId).not.toBe(sharedId);
  });

  it("upsertEntity private_overlay allows same pointer_key for different agents", () => {
    const a1 = storage.upsertEntity({
      pointerKey: "entity:shared",
      displayName: "Shared",
      entityType: "thing",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
    });
    const a2 = storage.upsertEntity({
      pointerKey: "entity:shared",
      displayName: "Shared",
      entityType: "thing",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-2",
    });

    expect(a1).not.toBe(a2);
  });

  it("createFact invalidates existing current fact and inserts new current fact", () => {
    const firstFactId = storage.createFact(1, 2, "knows");
    const secondFactId = storage.createFact(1, 2, "knows");

    expect(secondFactId).not.toBe(firstFactId);

    const oldRow = db
      .prepare(`SELECT t_invalid FROM fact_edges WHERE id = ?`)
      .get(firstFactId) as { t_invalid: number };
    const newRow = db
      .prepare(`SELECT t_invalid FROM fact_edges WHERE id = ?`)
      .get(secondFactId) as { t_invalid: number };

    expect(oldRow.t_invalid).not.toBe(MAX_INTEGER);
    expect(newRow.t_invalid).toBe(MAX_INTEGER);
  });

  it("createPrivateEvent stores projection_class='area_candidate'", () => {
    const id = storage.createPrivateEvent({
      agentId: "agent-1",
      eventCategory: "thought",
      projectionClass: "area_candidate",
      privateNotes: "only private",
      projectableSummary: "public-safe",
    });

    const row = db
      .prepare(`SELECT projection_class, event_category, projectable_summary FROM agent_event_overlay WHERE id = ?`)
      .get(id) as { projection_class: string; event_category: string; projectable_summary: string };

    expect(row.projection_class).toBe("area_candidate");
    expect(row.event_category).toBe("thought");
    expect(row.projectable_summary).toBe("public-safe");
  });

  it("createPrivateBelief updates existing row for same tuple", () => {
    const beliefId1 = storage.createPrivateBelief({
      agentId: "agent-1",
      sourceEntityId: 10,
      targetEntityId: 20,
      predicate: "likes",
      confidence: 0.7,
    });

    db.prepare(`UPDATE agent_fact_overlay SET updated_at = ? WHERE id = ?`).run(1, beliefId1);

    const beliefId2 = storage.createPrivateBelief({
      agentId: "agent-1",
      sourceEntityId: 10,
      targetEntityId: 20,
      predicate: "likes",
      confidence: 0.95,
    });

    expect(beliefId2).toBe(beliefId1);

    const row = db
      .prepare(`SELECT updated_at FROM agent_fact_overlay WHERE id = ?`)
      .get(beliefId1) as { updated_at: number };
    expect(row.updated_at).toBeGreaterThan(1);

    const count = db
      .prepare(`SELECT count(*) as cnt FROM agent_fact_overlay WHERE agent_id = 'agent-1'`)
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("syncSearchDoc('private') writes to private docs and FTS", () => {
    const sourceRef = makeNodeRef("private_event", 1);
    const docId = storage.syncSearchDoc("private", sourceRef, "secret maid memory", "agent-1");

    const doc = db
      .prepare(`SELECT id, content, agent_id FROM search_docs_private WHERE id = ?`)
      .get(docId) as { id: number; content: string; agent_id: string };
    expect(doc.agent_id).toBe("agent-1");
    expect(doc.content).toContain("secret");

    const fts = db
      .prepare(`SELECT rowid FROM search_docs_private_fts WHERE content MATCH ?`)
      .all("maid") as Array<{ rowid: number }>;
    expect(fts.length).toBe(1);
    expect(fts[0].rowid).toBe(docId);
  });

  it("syncSearchDoc('area') writes area doc with location", () => {
    const sourceRef = makeNodeRef("event", 2);
    const docId = storage.syncSearchDoc("area", sourceRef, "hallway whisper", undefined, 42);

    const row = db
      .prepare(`SELECT location_entity_id, content FROM search_docs_area WHERE id = ?`)
      .get(docId) as { location_entity_id: number; content: string };
    expect(row.location_entity_id).toBe(42);
    expect(row.content).toBe("hallway whisper");
  });

  it("syncSearchDoc('world') writes world doc and FTS", () => {
    const sourceRef = makeNodeRef("event", 3);
    const docId = storage.syncSearchDoc("world", sourceRef, "global truth");

    const row = db
      .prepare(`SELECT id, content FROM search_docs_world WHERE id = ?`)
      .get(docId) as { id: number; content: string };
    expect(row.content).toBe("global truth");

    const fts = db
      .prepare(`SELECT rowid FROM search_docs_world_fts WHERE content MATCH ?`)
      .all("global") as Array<{ rowid: number }>;
    expect(fts.length).toBe(1);
    expect(fts[0].rowid).toBe(docId);
  });

  it("FTS5 search returns synced document", () => {
    storage.syncSearchDoc("world", makeNodeRef("event", 10), "the quick silver fox");

    const rows = db
      .prepare(`SELECT rowid, content FROM search_docs_world_fts WHERE content MATCH ?`)
      .all("silver") as Array<{ rowid: number; content: string }>;

    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain("silver");
  });

  it("createSameEpisodeEdges creates adjacent pairs only (with reverse edges)", () => {
    storage.createSameEpisodeEdges([
      { id: 1, session_id: "s1", topic_id: 7, timestamp: 1000 },
      { id: 2, session_id: "s1", topic_id: 7, timestamp: 2000 },
      { id: 3, session_id: "s1", topic_id: 7, timestamp: 3000 },
      { id: 4, session_id: "s1", topic_id: 8, timestamp: 4000 },
    ]);

    const edges = db
      .prepare(`SELECT source_event_id, target_event_id FROM logic_edges WHERE relation_type = 'same_episode'`)
      .all() as Array<{ source_event_id: number; target_event_id: number }>;

    const keySet = new Set(edges.map((edge) => `${edge.source_event_id}->${edge.target_event_id}`));
    expect(keySet.has("1->2")).toBe(true);
    expect(keySet.has("2->1")).toBe(true);
    expect(keySet.has("2->3")).toBe(true);
    expect(keySet.has("3->2")).toBe(true);
    expect(keySet.has("1->3")).toBe(false);
    expect(keySet.has("3->1")).toBe(false);
  });

  it("createProjectedEvent stores area_visible + runtime_projection and syncs area search", () => {
    const eventId = storage.createProjectedEvent({
      sessionId: "sess-1",
      summary: "Alice waves",
      timestamp: 1234,
      participants: JSON.stringify([makeNodeRef("entity", 1)]),
      locationEntityId: 99,
      eventCategory: "action",
      origin: "runtime_projection",
    });

    const row = db
      .prepare(`SELECT visibility_scope, event_origin, promotion_class, raw_text FROM event_nodes WHERE id = ?`)
      .get(eventId) as {
      visibility_scope: string;
      event_origin: string;
      promotion_class: string;
      raw_text: string | null;
    };

    expect(row.visibility_scope).toBe("area_visible");
    expect(row.event_origin).toBe("runtime_projection");
    expect(row.promotion_class).toBe("none");
    expect(row.raw_text).toBeNull();

    const areaDoc = db
      .prepare(`SELECT source_ref, content FROM search_docs_area WHERE source_ref = ?`)
      .get(makeNodeRef("event", eventId)) as { source_ref: string; content: string };
    expect(areaDoc.content).toBe("Alice waves");
  });

  it("createProjectedEvent rejects thought category", () => {
    expect(() =>
      storage.createProjectedEvent({
        sessionId: "sess-1",
        summary: "private thought",
        timestamp: 55,
        participants: "[]",
        locationEntityId: 1,
        eventCategory: "thought" as never,
        origin: "runtime_projection",
      }),
    ).toThrow();
  });

  it("createPromotedEvent stores world_public + promotion and syncs world search", () => {
    const eventId = storage.createPromotedEvent({
      sessionId: "sess-2",
      summary: "History remembers",
      timestamp: 4321,
      participants: "[]",
      locationEntityId: 5,
      eventCategory: "speech",
    });

    const row = db
      .prepare(`SELECT visibility_scope, event_origin, promotion_class, raw_text FROM event_nodes WHERE id = ?`)
      .get(eventId) as {
      visibility_scope: string;
      event_origin: string;
      promotion_class: string;
      raw_text: string | null;
    };

    expect(row.visibility_scope).toBe("world_public");
    expect(row.event_origin).toBe("promotion");
    expect(row.promotion_class).toBe("none");
    expect(row.raw_text).toBeNull();

    const worldDoc = db
      .prepare(`SELECT source_ref, content FROM search_docs_world WHERE source_ref = ?`)
      .get(makeNodeRef("event", eventId)) as { source_ref: string; content: string };
    expect(worldDoc.content).toBe("History remembers");
  });

  it("upsertNodeEmbedding stores Float32Array bytes", () => {
    const ref = makeNodeRef("event", 1);
    const vector = new Float32Array([1.5, 2.5, 3.5]);
    storage.upsertNodeEmbedding(ref, "event", "primary", "model-x", vector);

    const row = db
      .prepare(`SELECT embedding FROM node_embeddings WHERE node_ref = ?`)
      .get(ref) as { embedding: Uint8Array };

    const restored = new Float32Array(row.embedding.buffer.slice(0));
    expect(restored.length).toBe(3);
    expect(restored[0]).toBeCloseTo(1.5, 6);
    expect(restored[1]).toBeCloseTo(2.5, 6);
    expect(restored[2]).toBeCloseTo(3.5, 6);
  });

  it("invalidateFact updates t_invalid and t_expired", () => {
    const factId = storage.createFact(9, 10, "owns");
    storage.invalidateFact(factId);

    const row = db
      .prepare(`SELECT t_invalid, t_expired FROM fact_edges WHERE id = ?`)
      .get(factId) as { t_invalid: number; t_expired: number };

    expect(row.t_invalid).not.toBe(MAX_INTEGER);
    expect(row.t_expired).not.toBe(MAX_INTEGER);
    expect(row.t_invalid).toBe(row.t_expired);
  });

  it("runBatch wraps all writes in one transaction and rolls back on failure", () => {
    const before = db.prepare(`SELECT count(*) as cnt FROM topics`).get() as { cnt: number };
    expect(before.cnt).toBe(0);

    expect(() => {
      storage.runBatch(() => {
        storage.createTopic("topic-1");
        storage.createTopic("topic-2");
        db.prepare(`INSERT INTO topics (name, description, created_at) VALUES (?, ?, ?)`)
          .run("topic-1", "duplicate", Date.now());
      });
    }).toThrow();

    const after = db.prepare(`SELECT count(*) as cnt FROM topics`).get() as { cnt: number };
    expect(after.cnt).toBe(0);
  });
});
