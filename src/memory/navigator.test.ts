import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { AliasService } from "./alias.js";
import { GraphNavigator } from "./navigator.js";
import { RetrievalService } from "./retrieval.js";
import { createMemorySchema, MAX_INTEGER } from "./schema.js";
import type { EvidencePath, NodeRef, SeedCandidate, ViewerContext } from "./types.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  createMemorySchema(db);
  return db;
}

function viewerA(overrides?: Partial<ViewerContext>): ViewerContext {
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

function insertEvent(
  db: Database,
  id: number,
  visibility: "world_public" | "area_visible",
  locationEntityId: number,
  participants: string,
  summary = "event",
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO event_nodes (id, session_id, raw_text, summary, timestamp, created_at, participants, emotion, topic_id, visibility_scope, location_entity_id, event_category, primary_actor_entity_id, promotion_class, source_record_id, event_origin)
     VALUES (?, 'sess-1', NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, 'action', NULL, 'none', NULL, ?)`,
  ).run(id, summary, now + id, now + id, participants, visibility, locationEntityId, visibility === "world_public" ? "promotion" : "runtime_projection");
}

function insertLogic(db: Database, sourceEventId: number, targetEventId: number, relation: "causal" | "temporal_prev" | "temporal_next" | "same_episode"): void {
  db.prepare("INSERT INTO logic_edges (source_event_id, target_event_id, relation_type, created_at) VALUES (?, ?, ?, ?)").run(
    sourceEventId,
    targetEventId,
    relation,
    Date.now(),
  );
}

function insertFact(
  db: Database,
  id: number,
  sourceEntityId: number,
  targetEntityId: number,
  predicate: string,
  sourceEventId: number | null,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO fact_edges (id, source_entity_id, target_entity_id, predicate, t_valid, t_invalid, t_created, t_expired, source_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sourceEntityId, targetEntityId, predicate, now, MAX_INTEGER, now, MAX_INTEGER, sourceEventId);
}

function insertPrivateEvent(db: Database, id: number, agentId: string, linkedEventId: number | null): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_event_overlay (id, event_id, agent_id, role, private_notes, salience, emotion, event_category, primary_actor_entity_id, projection_class, location_entity_id, projectable_summary, source_record_id, created_at)
     VALUES (?, ?, ?, NULL, NULL, 0.5, NULL, 'thought', NULL, 'none', NULL, 'private summary', NULL, ?)`,
  ).run(id, linkedEventId, agentId, now);
}

function insertPrivateBelief(
  db: Database,
  id: number,
  agentId: string,
  sourceEntityId: number,
  targetEntityId: number,
  sourceEventRef: NodeRef | null,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_fact_overlay (id, agent_id, source_entity_id, target_entity_id, predicate, belief_type, confidence, epistemic_status, provenance, source_event_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'suspects', 'suspicion', 0.6, 'suspected', NULL, ?, ?, ?)`,
  ).run(id, agentId, sourceEntityId, targetEntityId, sourceEventRef, now, now);
}

function insertSemantic(
  db: Database,
  source: NodeRef,
  target: NodeRef,
  relation: "semantic_similar" | "conflict_or_update" | "entity_bridge" = "semantic_similar",
): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO semantic_edges (source_node_ref, target_node_ref, relation_type, weight, created_at, updated_at) VALUES (?, ?, ?, 0.9, ?, ?)",
  ).run(source, target, relation, now, now);
}

function seed(nodeRef: NodeRef, nodeKind: SeedCandidate["node_kind"], lexical = 0.9): SeedCandidate {
  return {
    node_ref: nodeRef,
    node_kind: nodeKind,
    lexical_score: lexical,
    semantic_score: 0,
    fused_score: lexical,
    source_scope: "world",
  };
}

class StubRetrieval {
  calls = 0;

  constructor(private readonly seeds: SeedCandidate[]) {}

  async localizeSeedsHybrid(_query: string, _viewerContext: ViewerContext, limit = 10): Promise<SeedCandidate[]> {
    this.calls += 1;
    return this.seeds.slice(0, limit);
  }
}

describe("GraphNavigator", () => {
  let db: Database;
  let alias: AliasService;

  beforeEach(() => {
    db = freshDb();
    alias = new AliasService(db);

    insertEntity(db, 1, "alice", "shared_public", null);
    insertEntity(db, 2, "bob", "shared_public", null);
    insertEntity(db, 3, "garden", "shared_public", null);
  });

  it("returns scored evidence paths for why queries", async () => {
    insertEvent(db, 1, "world_public", 1, JSON.stringify(["entity:1"]), "Alice leaves the garden");
    insertEvent(db, 2, "world_public", 1, JSON.stringify(["entity:1"]), "Storm approaches");
    insertLogic(db, 2, 1, "causal");
    insertFact(db, 1, 1, 3, "was_at", 1);

    const retrieval = new StubRetrieval([seed("event:1" as NodeRef, "event")]);
    const navigator = new GraphNavigator(db, retrieval as unknown as RetrievalService, alias);

    const result = await navigator.explore("why did Alice leave", viewerA());
    expect(result.query_type).toBe("why");
    expect(result.evidence_paths.length).toBeGreaterThan(0);
    expect(result.evidence_paths[0].score.path_score).toBeGreaterThan(-1);
  });

  it("requires ViewerContext as mandatory second parameter", async () => {
    const retrieval = new StubRetrieval([seed("entity:1" as NodeRef, "entity")]);
    const navigator = new GraphNavigator(db, retrieval as unknown as RetrievalService, alias);
    await expect(navigator.explore("why did Alice leave", undefined as unknown as ViewerContext)).rejects.toThrow(
      "viewerContext is required",
    );
  });

  it("makes 0 optional model-provider calls on common path", async () => {
    insertEvent(db, 1, "world_public", 1, "[]");
    const retrieval = new StubRetrieval([seed("event:1" as NodeRef, "event")]);

    const calls = { rewrite: 0, tie: 0 };
    const navigator = new GraphNavigator(db, retrieval as unknown as RetrievalService, alias, {
      rewriteQuery: (_q) => {
        calls.rewrite += 1;
        return _q;
      },
      tieBreak: () => {
        calls.tie += 1;
        return 0;
      },
    });

    await navigator.explore("what happened", viewerA());
    expect(calls.rewrite).toBe(0);
    expect(calls.tie).toBe(0);
  });

  it("enforces max depth=2 and never yields 3-hop paths", async () => {
    insertEvent(db, 1, "world_public", 1, "[]");
    insertEvent(db, 2, "world_public", 1, "[]");
    insertEvent(db, 3, "world_public", 1, "[]");
    insertEvent(db, 4, "world_public", 1, "[]");
    insertLogic(db, 1, 2, "causal");
    insertLogic(db, 2, 3, "causal");
    insertLogic(db, 3, 4, "causal");

    const retrieval = new StubRetrieval([seed("event:1" as NodeRef, "event")]);
    const navigator = new GraphNavigator(db, retrieval as unknown as RetrievalService, alias);

    const result = await navigator.explore("why chain", viewerA(), { maxCandidates: 30 });
    expect(result.evidence_paths.every((path) => path.path.depth <= 2)).toBe(true);
    const allNodes = result.evidence_paths.flatMap((path) => path.path.nodes);
    expect(allNodes).not.toContain("event:4");
  });

  it("uses default beam width 8 and honors configurable beam width", async () => {
    insertEvent(db, 1, "world_public", 1, "[]");
    for (let i = 2; i <= 20; i += 1) {
      insertEvent(db, i, "world_public", 1, "[]");
      insertLogic(db, 1, i, "causal");
    }

    const retrieval = new StubRetrieval([seed("event:1" as NodeRef, "event")]);
    const navigator = new GraphNavigator(db, retrieval as unknown as RetrievalService, alias);

    const defaultResult = await navigator.explore("why branching", viewerA(), { maxDepth: 1, maxCandidates: 50 });
    const defaultDepthOne = defaultResult.evidence_paths.filter((path) => path.path.depth === 1).length;
    expect(defaultDepthOne).toBeLessThanOrEqual(8);

    const narrowResult = await navigator.explore("why branching", viewerA(), {
      maxDepth: 1,
      maxCandidates: 50,
      beamWidth: 3,
    });
    const narrowDepthOne = narrowResult.evidence_paths.filter((path) => path.path.depth === 1).length;
    expect(narrowDepthOne).toBeLessThanOrEqual(3);
  });

  it("applies query-type edge priorities (why prefers causal, relationship prefers fact_relation)", async () => {
    insertEvent(db, 1, "world_public", 1, JSON.stringify(["entity:1"]));
    insertEvent(db, 2, "world_public", 1, "[]");
    insertLogic(db, 2, 1, "causal");
    insertFact(db, 10, 1, 2, "knows", null);

    const retrievalEvent = new StubRetrieval([seed("event:1" as NodeRef, "event")]);
    const navWhy = new GraphNavigator(db, retrievalEvent as unknown as RetrievalService, alias);
    const whyResult = await navWhy.explore("why did this happen", viewerA(), { maxDepth: 1, maxCandidates: 10 });
    const whyTopEdge = whyResult.evidence_paths.find((path) => path.path.depth === 1)?.path.edges[0];
    expect(whyTopEdge?.kind).toBe("causal");

    const retrievalEntity = new StubRetrieval([seed("entity:1" as NodeRef, "entity")]);
    const navRel = new GraphNavigator(db, retrievalEntity as unknown as RetrievalService, alias);
    const relResult = await navRel.explore("relationship between alice and bob", viewerA(), {
      maxDepth: 1,
      maxCandidates: 10,
    });
    const relTopEdge = relResult.evidence_paths.find((path) => path.path.depth === 1)?.path.edges[0];
    expect(relTopEdge?.kind).toBe("fact_relation");
  });

  it("materializes and traverses fact:{id} virtual nodes", async () => {
    insertEvent(db, 1, "world_public", 1, JSON.stringify(["entity:1"]));
    insertFact(db, 101, 1, 2, "knows", 1);

    const retrieval = new StubRetrieval([seed("event:1" as NodeRef, "event")]);
    const navigator = new GraphNavigator(db, retrieval as unknown as RetrievalService, alias);

    const result = await navigator.explore("why did alice leave", viewerA(), { maxDepth: 2, maxCandidates: 20 });
    const nodes = result.evidence_paths.flatMap((path) => path.path.nodes);
    expect(nodes).toContain("fact:101");
    expect(nodes).toContain("entity:2");
  });

  it("support_score excludes semantic_edges and counts only canonical evidence", async () => {
    insertSemantic(db, "entity:1" as NodeRef, "entity:2" as NodeRef, "semantic_similar");
    const retrieval = new StubRetrieval([seed("entity:1" as NodeRef, "entity")]);
    const navigator = new GraphNavigator(db, retrieval as unknown as RetrievalService, alias);

    const result = await navigator.explore("relationship between alice and bob", viewerA(), {
      maxDepth: 1,
      maxCandidates: 10,
    });
    const semanticPath = result.evidence_paths.find((path) => path.path.depth === 1);
    expect(semanticPath).toBeDefined();
    expect(semanticPath?.score.support_score).toBe(0);
  });

  it("gracefully degrades to lexical-only seeds when embeddings table is empty", async () => {
    insertEvent(db, 1, "world_public", 1, "[]", "coffee event");

    const now = Date.now();
    const worldDoc = db
      .prepare("INSERT INTO search_docs_world (doc_type, source_ref, content, created_at) VALUES ('event', 'event:1', ?, ?)")
      .run("coffee event", now);
    db.prepare("INSERT INTO search_docs_world_fts (rowid, content) VALUES (?, ?)").run(worldDoc.lastInsertRowid, "coffee event");

    const retrieval = new RetrievalService(db);
    const navigator = new GraphNavigator(db, retrieval, alias);
    const result = await navigator.explore("coffee", viewerA());

    expect(result.evidence_paths.length).toBeGreaterThan(0);
  });

  it("uses batched cross-table queries and avoids monolithic recursive CTE", async () => {
    insertEvent(db, 1, "world_public", 1, JSON.stringify(["entity:1"]));
    insertEvent(db, 2, "world_public", 1, "[]");
    insertLogic(db, 1, 2, "causal");
    insertFact(db, 1, 1, 2, "knows", 1);

    const capturedSql: string[] = [];
    const proxyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            capturedSql.push(sql);
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as Database;

    const retrieval = new StubRetrieval([seed("event:1" as NodeRef, "event")]);
    const navigator = new GraphNavigator(proxyDb, retrieval as unknown as RetrievalService, alias);
    await navigator.explore("why happened", viewerA(), { maxDepth: 1 });

    expect(capturedSql.some((sql) => /with\s+recursive/i.test(sql))).toBe(false);
    expect(capturedSql.some((sql) => sql.includes("FROM logic_edges"))).toBe(true);
    expect(capturedSql.some((sql) => sql.includes("FROM fact_edges"))).toBe(true);
  });

  it("prevents agent-a from traversing through agent-b private overlay nodes", async () => {
    insertPrivateBelief(db, 51, "agent-b", 1, 2, null);
    insertSemantic(db, "entity:1" as NodeRef, "private_belief:51" as NodeRef);
    const retrieval = new StubRetrieval([seed("entity:1" as NodeRef, "entity")]);
    const navigator = new GraphNavigator(db, retrieval as unknown as RetrievalService, alias);

    const result = await navigator.explore("relationship", viewerA(), { maxDepth: 2, maxCandidates: 20 });
    const nodes = result.evidence_paths.flatMap((path) => path.path.nodes);
    expect(nodes).not.toContain("private_belief:51");
  });

  it("never traverses semantic edges between different agents' private nodes", async () => {
    insertPrivateEvent(db, 61, "agent-a", null);
    insertPrivateEvent(db, 62, "agent-b", null);
    insertSemantic(db, "private_event:61" as NodeRef, "private_event:62" as NodeRef);

    const retrieval = new StubRetrieval([seed("private_event:61" as NodeRef, "private_event")]);
    const navigator = new GraphNavigator(db, retrieval as unknown as RetrievalService, alias);
    const result = await navigator.explore("why", viewerA(), { maxDepth: 1, maxCandidates: 10 });

    const nodes = result.evidence_paths.flatMap((path) => path.path.nodes);
    expect(nodes).not.toContain("private_event:62");
  });

  it("post-filter safety net strips nodes that bypassed upstream filters", () => {
    insertPrivateEvent(db, 70, "agent-b", null);

    const retrieval = new StubRetrieval([seed("entity:1" as NodeRef, "entity")]);
    const navigator = new GraphNavigator(db, retrieval as unknown as RetrievalService, alias);

    const unsafe: EvidencePath = {
      path: {
        seed: "entity:1" as NodeRef,
        nodes: ["entity:1" as NodeRef, "private_event:70" as NodeRef],
        edges: [
          {
            from: "entity:1" as NodeRef,
            to: "private_event:70" as NodeRef,
            kind: "semantic_similar",
            weight: 0.9,
            timestamp: Date.now(),
            summary: "unsafe",
          },
        ],
        depth: 1,
      },
      score: {
        seed_score: 0.8,
        edge_type_score: 0.8,
        temporal_consistency: 1,
        query_intent_match: 0.5,
        support_score: 0,
        recency_score: 0.7,
        hop_penalty: 0.5,
        redundancy_penalty: 0,
        path_score: 0.6,
      },
      supporting_nodes: ["private_event:70" as NodeRef],
      supporting_facts: [],
    };

    const safe = (navigator as unknown as { applyPostFilterSafetyNet: (path: EvidencePath, ctx: ViewerContext) => EvidencePath | null })
      .applyPostFilterSafetyNet(unsafe, viewerA());

    expect(safe).not.toBeNull();
    expect(safe?.path.nodes).toEqual(["entity:1"]);
    expect(safe?.path.edges).toEqual([]);
    expect(safe?.supporting_nodes).toEqual([]);
  });
});
