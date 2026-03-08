import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { PromotionService } from "./promotion.js";
import { createMemorySchema, makeNodeRef } from "./schema.js";
import { GraphStorageService } from "./storage.js";
import type { PromotionCandidate } from "./types.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  createMemorySchema(db);
  return db;
}

describe("PromotionService", () => {
  let db: Database;
  let storage: GraphStorageService;
  let service: PromotionService;

  beforeEach(() => {
    db = freshDb();
    storage = new GraphStorageService(db);
    service = new PromotionService(db, storage);
  });

  function seedSharedEntity(pointerKey: string, displayName: string, entityType = "person"): number {
    return storage.upsertEntity({
      pointerKey,
      displayName,
      entityType,
      memoryScope: "shared_public",
    });
  }

  function seedPrivateEntity(pointerKey: string, displayName: string, entityType = "person"): number {
    return storage.upsertEntity({
      pointerKey,
      displayName,
      entityType,
      memoryScope: "private_overlay",
      ownerAgentId: "maid-alpha",
    });
  }

  function seedAreaEvent(params: {
    summary: string;
    timestamp: number;
    locationEntityId: number;
    participants: string[];
    eventCategory?: "speech" | "action" | "observation" | "state_change";
  }): number {
    const eventId = storage.createProjectedEvent({
      sessionId: "session-promote",
      summary: params.summary,
      timestamp: params.timestamp,
      participants: JSON.stringify(params.participants),
      locationEntityId: params.locationEntityId,
      eventCategory: params.eventCategory ?? "speech",
      origin: "runtime_projection",
    });

    db.prepare(`UPDATE event_nodes SET promotion_class = 'world_candidate' WHERE id = ?`).run(eventId);
    return eventId;
  }

  it("identifyEventCandidates gates by speech + world_candidate", () => {
    const locationId = seedSharedEntity("area:hall", "Hall", "area");
    const speakerId = seedSharedEntity("person:alice", "Alice");

    const eligibleEventId = seedAreaEvent({
      summary: "Alice says hello to the hall",
      timestamp: 1,
      locationEntityId: locationId,
      participants: [makeNodeRef("entity", speakerId), makeNodeRef("entity", locationId)],
      eventCategory: "speech",
    });

    const ineligibleEventId = seedAreaEvent({
      summary: "Alice tidies a shelf",
      timestamp: 2,
      locationEntityId: locationId,
      participants: [makeNodeRef("entity", speakerId), makeNodeRef("entity", locationId)],
      eventCategory: "action",
    });

    const candidates = service.identifyEventCandidates();
    expect(candidates.map((candidate) => candidate.id)).toContain(eligibleEventId);
    expect(candidates.map((candidate) => candidate.id)).not.toContain(ineligibleEventId);
  });

  it("resolveReferences supports reuse + promote_full + promote_placeholder", () => {
    const sharedAliceId = seedSharedEntity("person:alice", "Alice");
    const privateAliasId = seedPrivateEntity("person:alice", "Alice");
    const privateBobId = seedPrivateEntity("person:bob", "Bob");
    const privateHiddenId = seedPrivateEntity("hidden_actor", "Hidden Person");

    const candidate: PromotionCandidate = {
      source_ref: makeNodeRef("private_event", 1),
      target_scope: "world_public",
      summary: "A public summary",
      entity_refs: [
        makeNodeRef("entity", sharedAliceId),
        makeNodeRef("entity", privateAliasId),
        makeNodeRef("entity", privateBobId),
        makeNodeRef("entity", privateHiddenId),
      ],
    };

    const resolutions = service.resolveReferences(candidate);
    expect(resolutions).toHaveLength(4);

    const byRef = new Map(resolutions.map((resolution) => [resolution.source_ref, resolution]));

    expect(byRef.get(makeNodeRef("entity", sharedAliceId))?.action).toBe("reuse");
    expect(byRef.get(makeNodeRef("entity", privateAliasId))?.action).toBe("reuse");
    expect(byRef.get(makeNodeRef("entity", privateAliasId))?.resolved_entity_id).toBe(sharedAliceId);

    const full = byRef.get(makeNodeRef("entity", privateBobId));
    expect(full?.action).toBe("promote_full");
    const promoted = db
      .prepare(`SELECT memory_scope, canonical_entity_id FROM entity_nodes WHERE id = ?`)
      .get(full?.resolved_entity_id) as { memory_scope: string; canonical_entity_id: number };
    expect(promoted.memory_scope).toBe("shared_public");
    expect(promoted.canonical_entity_id).toBe(privateBobId);

    const placeholder = byRef.get(makeNodeRef("entity", privateHiddenId));
    expect(placeholder?.action).toBe("promote_placeholder");
    expect(placeholder?.placeholder_pointer_key?.startsWith("unknown_person@area:t")).toBe(true);
    const placeholderRow = db
      .prepare(`SELECT pointer_key, memory_scope FROM entity_nodes WHERE id = ?`)
      .get(placeholder?.resolved_entity_id) as { pointer_key: string; memory_scope: string };
    expect(placeholderRow.pointer_key).toBe(placeholder?.placeholder_pointer_key);
    expect(placeholderRow.memory_scope).toBe("shared_public");
  });

  it("resolveReferences returns block for purely private entity and blocks write", () => {
    const privateSecretId = seedPrivateEntity("secret_asset", "Secret Asset", "artifact");
    const candidate: PromotionCandidate = {
      source_ref: makeNodeRef("private_event", 1),
      target_scope: "world_public",
      summary: "Should never promote",
      entity_refs: [makeNodeRef("entity", privateSecretId)],
    };

    const resolutions = service.resolveReferences(candidate);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].action).toBe("block");
    expect(resolutions[0].reason).toContain("private");

    const write = service.executeProjectedWrite(candidate, resolutions, "world_public");
    expect(write).toBeUndefined();
  });

  it("rejects direct crystallization from private_belief", () => {
    const candidate: PromotionCandidate = {
      source_ref: makeNodeRef("private_belief", 1),
      target_scope: "world_public",
      summary: "private_belief says Alice owns tea",
      entity_refs: [],
    };

    const resolutions = service.resolveReferences(candidate);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].action).toBe("block");
    expect(resolutions[0].reason).toContain("private_belief");
    expect(service.executeProjectedWrite(candidate, resolutions, "world_public")).toBeUndefined();
  });

  it("executeProjectedWrite creates world_public event and does not modify source event", () => {
    const locationId = seedSharedEntity("area:kitchen", "Kitchen", "area");
    const sharedAliceId = seedSharedEntity("person:alice", "Alice");
    const sourceEventId = seedAreaEvent({
      summary: "Alice says tea is ready",
      timestamp: 1000,
      locationEntityId: locationId,
      participants: [makeNodeRef("entity", sharedAliceId), makeNodeRef("entity", locationId)],
      eventCategory: "speech",
    });

    const candidate: PromotionCandidate = {
      source_ref: makeNodeRef("event", sourceEventId),
      target_scope: "world_public",
      summary: "Alice publicly announces tea is ready",
      entity_refs: [makeNodeRef("entity", sharedAliceId), makeNodeRef("entity", locationId)],
    };

    const beforeSource = db
      .prepare(`SELECT visibility_scope, event_origin FROM event_nodes WHERE id = ?`)
      .get(sourceEventId) as { visibility_scope: string; event_origin: string };
    expect(beforeSource.visibility_scope).toBe("area_visible");
    expect(beforeSource.event_origin).toBe("runtime_projection");

    const resolutions = service.resolveReferences(candidate);
    const projected = service.executeProjectedWrite(candidate, resolutions, "world_public");
    expect(projected).toBeDefined();
    expect(projected?.source_ref).toBe(candidate.source_ref);
    expect(projected?.target_scope).toBe("world_public");

    const promotedEventId = Number(projected?.created_ref.split(":")[1]);
    expect(promotedEventId).toBeGreaterThan(0);
    expect(promotedEventId).not.toBe(sourceEventId);

    const sourceAfter = db
      .prepare(`SELECT visibility_scope, event_origin, summary FROM event_nodes WHERE id = ?`)
      .get(sourceEventId) as { visibility_scope: string; event_origin: string; summary: string };
    expect(sourceAfter.visibility_scope).toBe("area_visible");
    expect(sourceAfter.event_origin).toBe("runtime_projection");
    expect(sourceAfter.summary).toBe("Alice says tea is ready");

    const promoted = db
      .prepare(
        `SELECT visibility_scope, event_origin, summary, participants
         FROM event_nodes
         WHERE id = ?`,
      )
      .get(promotedEventId) as { visibility_scope: string; event_origin: string; summary: string; participants: string };
    expect(promoted.visibility_scope).toBe("world_public");
    expect(promoted.event_origin).toBe("promotion");
    expect(promoted.summary).toBe("Alice publicly announces tea is ready");

    const participantRefs = JSON.parse(promoted.participants) as string[];
    const participantIds = participantRefs.map((ref) => Number(ref.split(":")[1]));
    const participantScopes = db
      .prepare(`SELECT memory_scope, pointer_key FROM entity_nodes WHERE id IN (${participantIds.map(() => "?").join(",")})`)
      .all(...participantIds) as Array<{ memory_scope: string; pointer_key: string }>;

    expect(participantScopes.length).toBeGreaterThan(0);
    for (const scopeRow of participantScopes) {
      expect(scopeRow.memory_scope).toBe("shared_public");
      expect(scopeRow.pointer_key.includes("secret")).toBe(false);
    }

    const worldDoc = db
      .prepare(`SELECT content FROM search_docs_world WHERE source_ref = ?`)
      .get(projected?.created_ref) as { content: string };
    expect(worldDoc.content).toBe("Alice publicly announces tea is ready");

    const fts = db
      .prepare(`SELECT rowid FROM search_docs_world_fts WHERE content MATCH ?`)
      .all("announces") as Array<{ rowid: number }>;
    expect(fts.length).toBe(1);

    const privateDocCount = db
      .prepare(`SELECT count(*) as cnt FROM search_docs_private`)
      .get() as { cnt: number };
    expect(privateDocCount.cnt).toBe(0);
  });

  it("executeProjectedWrite crystallizes fact into world_public fact_edges and syncs world docs", () => {
    const aliceId = seedSharedEntity("person:alice", "Alice");
    const teaId = seedSharedEntity("thing:tea", "Tea", "item");

    const candidate: PromotionCandidate = {
      source_ref: makeNodeRef("private_event", 44),
      target_scope: "world_public",
      summary: "Alice owns tea",
      entity_refs: [makeNodeRef("entity", aliceId), makeNodeRef("entity", teaId)],
    };

    const resolutions = service.resolveReferences(candidate);
    const write = service.executeProjectedWrite(candidate, resolutions, "world_public");
    expect(write?.created_ref.startsWith("fact:")).toBe(true);

    const factId = Number(write?.created_ref.split(":")[1]);
    const fact = db
      .prepare(`SELECT source_entity_id, target_entity_id, predicate FROM fact_edges WHERE id = ?`)
      .get(factId) as { source_entity_id: number; target_entity_id: number; predicate: string };
    expect(fact.source_entity_id).toBe(aliceId);
    expect(fact.target_entity_id).toBe(teaId);
    expect(fact.predicate).toBe("owns");

    const worldDoc = db
      .prepare(`SELECT content FROM search_docs_world WHERE source_ref = ?`)
      .get(write?.created_ref) as { content: string };
    expect(worldDoc.content).toBe("Alice owns tea");

    const fts = db
      .prepare(`SELECT rowid FROM search_docs_world_fts WHERE content MATCH ?`)
      .all("owns") as Array<{ rowid: number }>;
    expect(fts.length).toBe(1);
  });
});
