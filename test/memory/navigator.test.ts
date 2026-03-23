import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { AliasService } from "../../src/memory/alias.js";
import { GraphNavigator } from "../../src/memory/navigator.js";
import { createMemorySchema, MAX_INTEGER } from "../../src/memory/schema.js";
import type { EvidencePath, NodeRef, SeedCandidate, ViewerContext } from "../../src/memory/types.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  createMemorySchema(db);
  return db;
}

function viewer(overrides?: Partial<ViewerContext>): ViewerContext {
  return {
    viewer_agent_id: "agent-a",
    viewer_role: "rp_agent",
    current_area_id: 1,
    session_id: "sess-1",
    ...overrides,
  };
}

function insertEntity(
  db: Database,
  id: number,
  pointerKey: string,
  scope: "shared_public" | "private_overlay",
  ownerAgentId: string | null,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO entity_nodes (id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at)
     VALUES (?, ?, ?, 'person', ?, ?, NULL, ?, ?, ?)`,
  ).run(id, pointerKey, pointerKey, scope, ownerAgentId, `summary:${pointerKey}`, now, now);
}

function insertPrivateEvent(db: Database, id: number, agentId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_event_overlay (id, event_id, agent_id, role, private_notes, salience, emotion, event_category, primary_actor_entity_id, projection_class, location_entity_id, projectable_summary, source_record_id, created_at)
     VALUES (?, NULL, ?, NULL, NULL, 0.5, NULL, 'thought', NULL, 'none', NULL, 'private summary', NULL, ?)`,
  ).run(id, agentId, now);
}

function insertEvent(db: Database, id: number, summary: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO event_nodes (id, session_id, raw_text, summary, timestamp, created_at, participants, emotion, topic_id, visibility_scope, location_entity_id, event_category, primary_actor_entity_id, promotion_class, source_record_id, event_origin)
     VALUES (?, 'sess-1', NULL, ?, ?, ?, '[]', NULL, NULL, 'world_public', 1, 'action', NULL, 'none', NULL, 'promotion')`,
  ).run(id, summary, now + id, now + id);
}

function insertLogic(db: Database, sourceEventId: number, targetEventId: number): void {
  db.prepare("INSERT INTO logic_edges (source_event_id, target_event_id, relation_type, created_at) VALUES (?, ?, 'causal', ?)").run(
    sourceEventId,
    targetEventId,
    Date.now(),
  );
}

function insertFact(db: Database, id: number, sourceEntityId: number, targetEntityId: number): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO fact_edges (id, source_entity_id, target_entity_id, predicate, t_valid, t_invalid, t_created, t_expired, source_event_id)
     VALUES (?, ?, ?, 'conflicts_with', ?, ?, ?, ?, NULL)`,
  ).run(id, sourceEntityId, targetEntityId, now, MAX_INTEGER, now, MAX_INTEGER);
}

class StubRetrieval {
  constructor(private readonly seeds: SeedCandidate[]) {}

  async localizeSeedsHybrid(): Promise<SeedCandidate[]> {
    return this.seeds;
  }
}

describe("GraphNavigator explain shell", () => {
  let db: Database;
  let alias: AliasService;

  beforeEach(() => {
    db = freshDb();
    alias = new AliasService(db);
    insertEntity(db, 1, "alice", "shared_public", null);
    insertEntity(db, 2, "bob", "shared_public", null);
  });

  it("adds conflict query type and returns summary-first result", async () => {
    insertEvent(db, 1, "Alice trusted Bob");
    insertEvent(db, 2, "Alice contested Bob");
    insertLogic(db, 1, 2);
    insertFact(db, 11, 1, 2);

    const retrieval = new StubRetrieval([
      {
        node_ref: "event:1" as NodeRef,
        node_kind: "event",
        lexical_score: 0.9,
        semantic_score: 0,
        fused_score: 0.9,
        source_scope: "world",
      },
    ]);
    const navigator = new GraphNavigator(db, retrieval as any, alias);

    const result = await navigator.explore("explain conflict about Alice and Bob", viewer());
    expect(result.query_type).toBe("conflict");
    expect(typeof result.summary).toBe("string");
    expect(result.summary?.length ?? 0).toBeGreaterThan(0);
  });

  it("emits redacted placeholders when path includes hidden/private nodes", () => {
    insertPrivateEvent(db, 70, "agent-b");
    const retrieval = new StubRetrieval([]);
    const navigator = new GraphNavigator(db, retrieval as any, alias);

    const unsafe: EvidencePath = {
      path: {
        seed: "entity:1" as NodeRef,
        nodes: ["entity:1" as NodeRef, "private_event:70" as NodeRef],
        edges: [
          {
            from: "entity:1" as NodeRef,
            to: "private_event:70" as NodeRef,
            kind: "semantic_similar",
            weight: 0.8,
            timestamp: Date.now(),
            summary: "private hop",
          },
        ],
        depth: 1,
      },
      score: {
        seed_score: 0.5,
        edge_type_score: 0.5,
        temporal_consistency: 1,
        query_intent_match: 0.5,
        support_score: 0,
        recency_score: 0.5,
        hop_penalty: 0.5,
        redundancy_penalty: 0,
        path_score: 0.4,
      },
      supporting_nodes: ["private_event:70" as NodeRef],
      supporting_facts: [],
    };

    const safe = (navigator as any).applyPostFilterSafetyNet(unsafe, viewer()) as EvidencePath | null;
    expect(safe).not.toBeNull();
    expect(safe?.path.nodes).toEqual(["entity:1"]);
    expect(safe?.redacted_placeholders).toEqual([
      {
        type: "redacted",
        reason: "private",
        node_ref: "private_event:70",
      },
    ]);
  });
});
