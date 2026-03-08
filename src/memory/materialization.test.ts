import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { MaterializationService } from "./materialization.js";
import { createMemorySchema, makeNodeRef } from "./schema.js";
import { GraphStorageService } from "./storage.js";
import type { AgentEventOverlay } from "./types.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  createMemorySchema(db);
  return db;
}

describe("MaterializationService", () => {
  let db: Database;
  let storage: GraphStorageService;
  let service: MaterializationService;

  beforeEach(() => {
    db = freshDb();
    storage = new GraphStorageService(db);
    service = new MaterializationService(db, storage);
  });

  function getPrivateEvent(id: number): AgentEventOverlay {
    return db.prepare(`SELECT * FROM agent_event_overlay WHERE id = ?`).get(id) as AgentEventOverlay;
  }

  it("materializes area_candidate event when no runtime projection match exists", () => {
    const locationId = storage.upsertEntity({
      pointerKey: "area:kitchen",
      displayName: "Kitchen",
      entityType: "area",
      memoryScope: "shared_public",
    });
    const privateActorId = storage.upsertEntity({
      pointerKey: "person:alice",
      displayName: "Alice",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "maid-alice",
    });
    const privateEventId = storage.createPrivateEvent({
      agentId: "maid-alice",
      eventCategory: "action",
      projectionClass: "area_candidate",
      projectableSummary: "Alice leaves tea near the window",
      privateNotes: "raw secret reasoning should never leak",
      locationEntityId: locationId,
      primaryActorEntityId: privateActorId,
      sourceRecordId: "record-1",
    });

    const result = service.materializeDelayed([getPrivateEvent(privateEventId)], "maid-alice");
    expect(result).toEqual({ materialized: 1, reconciled: 0, skipped: 0 });

    const event = db
      .prepare(
        `SELECT id, summary, raw_text, event_origin, visibility_scope, source_record_id, participants
         FROM event_nodes
         WHERE source_record_id = ?`,
      )
      .get("record-1") as {
      id: number;
      summary: string;
      raw_text: string | null;
      event_origin: string;
      visibility_scope: string;
      source_record_id: string;
      participants: string;
    };

    expect(event.summary).toBe("Alice leaves tea near the window");
    expect(event.raw_text).toBeNull();
    expect(event.event_origin).toBe("delayed_materialization");
    expect(event.visibility_scope).toBe("area_visible");
    expect(event.source_record_id).toBe("record-1");
    expect(JSON.parse(event.participants)).toContain(makeNodeRef("entity", locationId));

    const linkedPrivate = db
      .prepare(`SELECT event_id FROM agent_event_overlay WHERE id = ?`)
      .get(privateEventId) as { event_id: number };
    expect(linkedPrivate.event_id).toBe(event.id);

    const areaDoc = db
      .prepare(`SELECT content FROM search_docs_area WHERE source_ref = ?`)
      .get(makeNodeRef("event", event.id)) as { content: string };
    expect(areaDoc.content).toBe("Alice leaves tea near the window");

    const ftsRows = db
      .prepare(`SELECT rowid FROM search_docs_area_fts WHERE content MATCH ?`)
      .all("window") as Array<{ rowid: number }>;
    expect(ftsRows.length).toBe(1);
    expect(ftsRows[0].rowid).toBeGreaterThan(0);
  });

  it("reconciles to existing runtime_projection by source_record_id without duplicate creation", () => {
    const locationId = storage.upsertEntity({
      pointerKey: "area:hall",
      displayName: "Hall",
      entityType: "area",
      memoryScope: "shared_public",
    });
    const runtimeEventId = storage.createProjectedEvent({
      sessionId: "session-1",
      summary: "Runtime saw movement",
      timestamp: 100,
      participants: JSON.stringify([makeNodeRef("entity", locationId)]),
      locationEntityId: locationId,
      eventCategory: "observation",
      sourceRecordId: "record-2",
      origin: "runtime_projection",
    });
    const privateEventId = storage.createPrivateEvent({
      agentId: "maid-alice",
      eventCategory: "observation",
      projectionClass: "area_candidate",
      projectableSummary: "Public-safe summary from overlay",
      locationEntityId: locationId,
      sourceRecordId: "record-2",
    });

    const result = service.materializeDelayed([getPrivateEvent(privateEventId)], "maid-alice");
    expect(result).toEqual({ materialized: 0, reconciled: 1, skipped: 0 });

    const count = db
      .prepare(`SELECT count(*) as cnt FROM event_nodes WHERE source_record_id = ?`)
      .get("record-2") as { cnt: number };
    expect(count.cnt).toBe(1);

    const linked = db
      .prepare(`SELECT event_id FROM agent_event_overlay WHERE id = ?`)
      .get(privateEventId) as { event_id: number };
    expect(linked.event_id).toBe(runtimeEventId);

    const existing = db
      .prepare(`SELECT event_origin FROM event_nodes WHERE id = ?`)
      .get(runtimeEventId) as { event_origin: string };
    expect(existing.event_origin).toBe("runtime_projection");
  });

  it("does not materialize private thought events", () => {
    const locationId = storage.upsertEntity({
      pointerKey: "area:study",
      displayName: "Study",
      entityType: "area",
      memoryScope: "shared_public",
    });
    const privateEventId = storage.createPrivateEvent({
      agentId: "maid-alice",
      eventCategory: "thought",
      projectionClass: "area_candidate",
      projectableSummary: "should not be public",
      locationEntityId: locationId,
    });

    const result = service.materializeDelayed([getPrivateEvent(privateEventId)], "maid-alice");
    expect(result).toEqual({ materialized: 0, reconciled: 0, skipped: 1 });

    const eventCount = db.prepare(`SELECT count(*) as cnt FROM event_nodes`).get() as { cnt: number };
    expect(eventCount.cnt).toBe(0);
  });

  it("does not materialize projection_class none", () => {
    const locationId = storage.upsertEntity({
      pointerKey: "area:library",
      displayName: "Library",
      entityType: "area",
      memoryScope: "shared_public",
    });
    const privateEventId = storage.createPrivateEvent({
      agentId: "maid-alice",
      eventCategory: "speech",
      projectionClass: "none",
      projectableSummary: "should remain private",
      locationEntityId: locationId,
    });

    const result = service.materializeDelayed([getPrivateEvent(privateEventId)], "maid-alice");
    expect(result).toEqual({ materialized: 0, reconciled: 0, skipped: 1 });

    const eventCount = db.prepare(`SELECT count(*) as cnt FROM event_nodes`).get() as { cnt: number };
    expect(eventCount.cnt).toBe(0);
  });

  it("writes participants as resolved entity refs and never owner_private refs", () => {
    const locationId = storage.upsertEntity({
      pointerKey: "area:atrium",
      displayName: "Atrium",
      entityType: "area",
      memoryScope: "shared_public",
    });
    const privateActorId = storage.upsertEntity({
      pointerKey: "person:bob",
      displayName: "Bob",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "maid-alice",
    });
    const privateEventId = storage.createPrivateEvent({
      agentId: "maid-alice",
      eventCategory: "speech",
      projectionClass: "area_candidate",
      projectableSummary: "Bob says hello",
      locationEntityId: locationId,
      primaryActorEntityId: privateActorId,
      sourceRecordId: "record-3",
    });

    service.materializeDelayed([getPrivateEvent(privateEventId)], "maid-alice");

    const event = db
      .prepare(`SELECT participants, primary_actor_entity_id, location_entity_id FROM event_nodes WHERE source_record_id = ?`)
      .get("record-3") as { participants: string; primary_actor_entity_id: number; location_entity_id: number };
    const participants = JSON.parse(event.participants) as string[];

    expect(participants.length).toBeGreaterThanOrEqual(1);
    expect(participants.every((part) => part.startsWith("entity:"))).toBe(true);
    expect(participants.some((part) => part.includes("Bob"))).toBe(false);

    const actorScope = db
      .prepare(`SELECT memory_scope FROM entity_nodes WHERE id = ?`)
      .get(event.primary_actor_entity_id) as { memory_scope: string };
    const locationScope = db
      .prepare(`SELECT memory_scope FROM entity_nodes WHERE id = ?`)
      .get(event.location_entity_id) as { memory_scope: string };

    expect(actorScope.memory_scope).toBe("shared_public");
    expect(locationScope.memory_scope).toBe("shared_public");
  });

  it("creates placeholder entity for hidden private identity", () => {
    const locationId = storage.upsertEntity({
      pointerKey: "area:garden",
      displayName: "Garden",
      entityType: "area",
      memoryScope: "shared_public",
    });
    const hiddenPrivateActorId = storage.upsertEntity({
      pointerKey: "hidden_actor",
      displayName: "Hidden Person",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "maid-alice",
    });
    const privateEventId = storage.createPrivateEvent({
      agentId: "maid-alice",
      eventCategory: "observation",
      projectionClass: "area_candidate",
      projectableSummary: "Someone moves behind the hedges",
      locationEntityId: locationId,
      primaryActorEntityId: hiddenPrivateActorId,
      sourceRecordId: "record-4",
    });
    const privateEvent = getPrivateEvent(privateEventId);

    service.materializeDelayed([privateEvent], "maid-alice");

    const event = db
      .prepare(`SELECT primary_actor_entity_id FROM event_nodes WHERE source_record_id = ?`)
      .get("record-4") as { primary_actor_entity_id: number };
    const actor = db
      .prepare(`SELECT pointer_key, memory_scope FROM entity_nodes WHERE id = ?`)
      .get(event.primary_actor_entity_id) as { pointer_key: string; memory_scope: string };

    expect(actor.pointer_key).toBe(`unknown_person@area:t${privateEvent.created_at}`);
    expect(actor.memory_scope).toBe("shared_public");

    const hiddenShared = db
      .prepare(`SELECT count(*) as cnt FROM entity_nodes WHERE pointer_key = ? AND memory_scope = 'shared_public'`)
      .get("hidden_actor") as { cnt: number };
    expect(hiddenShared.cnt).toBe(0);
  });

  it("indexes only projectable_summary content in area search docs", () => {
    const locationId = storage.upsertEntity({
      pointerKey: "area:lounge",
      displayName: "Lounge",
      entityType: "area",
      memoryScope: "shared_public",
    });
    const privateEventId = storage.createPrivateEvent({
      agentId: "maid-alice",
      eventCategory: "action",
      projectionClass: "area_candidate",
      projectableSummary: "Public summary text",
      privateNotes: "ULTRA_SECRET_NOTE",
      locationEntityId: locationId,
      sourceRecordId: "record-5",
    });

    service.materializeDelayed([getPrivateEvent(privateEventId)], "maid-alice");

    const areaDoc = db
      .prepare(`SELECT content FROM search_docs_area WHERE source_ref = (SELECT 'event:' || id FROM event_nodes WHERE source_record_id = ?)`)
      .get("record-5") as { content: string };
    expect(areaDoc.content).toBe("Public summary text");

    const secretMatches = db
      .prepare(`SELECT rowid FROM search_docs_area_fts WHERE content MATCH ?`)
      .all("ULTRA_SECRET_NOTE") as Array<{ rowid: number }>;
    expect(secretMatches.length).toBe(0);

    const publicMatches = db
      .prepare(`SELECT rowid FROM search_docs_area_fts WHERE content MATCH ?`)
      .all("summary") as Array<{ rowid: number }>;
    expect(publicMatches.length).toBe(1);
  });
});
