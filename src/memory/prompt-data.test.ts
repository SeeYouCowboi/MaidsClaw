import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createMemorySchema } from "./schema";
import { CoreMemoryService } from "./core-memory";
import { getCoreMemoryBlocks, getMemoryHints, formatNavigatorEvidence } from "./prompt-data";
import type { ViewerContext, NavigatorResult, NodeRef } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb() {
  const db = new Database(":memory:");
  createMemorySchema(db);
  return db;
}

function makeViewerContext(overrides?: Partial<ViewerContext>): ViewerContext {
  return {
    viewer_agent_id: "agent-1",
    viewer_role: "rp_agent",
    current_area_id: 1,
    session_id: "sess-1",
    ...overrides,
  };
}

function insertSearchDocPrivate(
  db: Database,
  agentId: string,
  content: string,
  sourceRef: string,
  docType = "entity_summary",
) {
  const now = Date.now();
  const result = db
    .prepare(
      "INSERT INTO search_docs_private (doc_type, source_ref, agent_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(docType, sourceRef, agentId, content, now);
  db.prepare("INSERT INTO search_docs_private_fts (rowid, content) VALUES (?, ?)").run(
    result.lastInsertRowid,
    content,
  );
}

function insertSearchDocArea(
  db: Database,
  locationId: number,
  content: string,
  sourceRef: string,
  docType = "event_summary",
) {
  const now = Date.now();
  const result = db
    .prepare(
      "INSERT INTO search_docs_area (doc_type, source_ref, location_entity_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(docType, sourceRef, locationId, content, now);
  db.prepare("INSERT INTO search_docs_area_fts (rowid, content) VALUES (?, ?)").run(
    result.lastInsertRowid,
    content,
  );
}

function insertSearchDocWorld(
  db: Database,
  content: string,
  sourceRef: string,
  docType = "entity_summary",
) {
  const now = Date.now();
  const result = db
    .prepare(
      "INSERT INTO search_docs_world (doc_type, source_ref, content, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(docType, sourceRef, content, now);
  db.prepare("INSERT INTO search_docs_world_fts (rowid, content) VALUES (?, ?)").run(
    result.lastInsertRowid,
    content,
  );
}

// ---------------------------------------------------------------------------
// getCoreMemoryBlocks
// ---------------------------------------------------------------------------

describe("getCoreMemoryBlocks", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
    const service = new CoreMemoryService(db);
    service.initializeBlocks("agent-1");
  });

  it("returns XML-wrapped blocks with chars metadata for empty blocks", () => {
    const xml = getCoreMemoryBlocks("agent-1", db);

    expect(xml).toContain('<core_memory label="character"');
    expect(xml).toContain('<core_memory label="index"');
    expect(xml).toContain('<core_memory label="user"');
    expect(xml).toContain('chars_current="0"');
    expect(xml).toContain('chars_limit="4000"');
    expect(xml).toContain('chars_limit="3000"');
    expect(xml).toContain('chars_limit="1500"');
  });

  it("returns all 3 blocks", () => {
    const xml = getCoreMemoryBlocks("agent-1", db);
    const blockCount = (xml.match(/<core_memory /g) || []).length;
    expect(blockCount).toBe(3);
  });

  it("includes chars_current and chars_limit attributes", () => {
    // Write some content to character block
    const service = new CoreMemoryService(db);
    service.appendBlock("agent-1", "character", "A cheerful maid");

    const xml = getCoreMemoryBlocks("agent-1", db);

    // character block should show chars_current=15 (length of "A cheerful maid")
    expect(xml).toContain('chars_current="15"');
    expect(xml).toContain('chars_limit="4000"');
  });

  it("includes block value content inside XML tags", () => {
    const service = new CoreMemoryService(db);
    service.appendBlock("agent-1", "character", "Sakura is a diligent maid");

    const xml = getCoreMemoryBlocks("agent-1", db);
    expect(xml).toContain("Sakura is a diligent maid</core_memory>");
  });
});

// ---------------------------------------------------------------------------
// getMemoryHints
// ---------------------------------------------------------------------------

describe("getMemoryHints", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("returns formatted bullet list from search results", async () => {
    const ctx = makeViewerContext();
    insertSearchDocArea(db, 1, "Alice visited the coffee shop today", "entity:1", "entity_summary");

    const result = await getMemoryHints("coffee shop", ctx, db);

    expect(result).toContain("•");
    expect(result).toContain("[entity]");
    expect(result).toContain("Alice visited the coffee shop today");
  });

  it("returns empty string for short query (< 3 chars)", async () => {
    const ctx = makeViewerContext();
    insertSearchDocArea(db, 1, "Alice visited the coffee shop today", "entity:1");

    const result = await getMemoryHints("ab", ctx, db);
    expect(result).toBe("");
  });

  it("returns empty string when no matches", async () => {
    const ctx = makeViewerContext();

    const result = await getMemoryHints("nonexistent topic xyz", ctx, db);
    expect(result).toBe("");
  });

  it("respects limit parameter", async () => {
    const ctx = makeViewerContext();
    // Insert multiple area docs
    for (let i = 0; i < 10; i++) {
      insertSearchDocArea(db, 1, `Event about coffee number ${i}`, `event:${i + 1}`);
    }

    const result = await getMemoryHints("coffee", ctx, db, 2);
    const bulletCount = (result.match(/•/g) || []).length;
    expect(bulletCount).toBeLessThanOrEqual(2);
  });

  it("defaults limit to 5", async () => {
    const ctx = makeViewerContext();
    for (let i = 0; i < 10; i++) {
      insertSearchDocArea(db, 1, `Event about coffee number ${i}`, `event:${i + 1}`);
    }

    const result = await getMemoryHints("coffee", ctx, db);
    const bulletCount = (result.match(/•/g) || []).length;
    expect(bulletCount).toBeLessThanOrEqual(5);
  });

  it("rp_agent queries private + area + world FTS5 tables", async () => {
    const rpCtx = makeViewerContext({ viewer_role: "rp_agent", viewer_agent_id: "agent-1" });

    insertSearchDocPrivate(db, "agent-1", "Private memory about coffee brewing", "private_event:1");
    insertSearchDocArea(db, 1, "Area event about coffee ordering", "event:1");
    insertSearchDocWorld(db, "World fact about coffee origins", "entity:1");

    const result = await getMemoryHints("coffee", rpCtx, db);

    expect(result).toContain("Private memory about coffee brewing");
    expect(result).toContain("Area event about coffee ordering");
    expect(result).toContain("World fact about coffee origins");
  });

  it("maiden queries area + world only (NOT private)", async () => {
    const maidenCtx = makeViewerContext({
      viewer_role: "maiden",
      viewer_agent_id: "maiden-1",
    });

    insertSearchDocPrivate(db, "maiden-1", "Private memory about coffee brewing", "private_event:1");
    insertSearchDocArea(db, 1, "Area event about coffee ordering", "event:1");
    insertSearchDocWorld(db, "World fact about coffee origins", "entity:1");

    const result = await getMemoryHints("coffee", maidenCtx, db);

    expect(result).not.toContain("Private memory about coffee brewing");
    expect(result).toContain("Area event about coffee ordering");
    expect(result).toContain("World fact about coffee origins");
  });

  it("uses node kind from source_ref in bullet format", async () => {
    const ctx = makeViewerContext();
    insertSearchDocArea(db, 1, "A fact about tea leaves", "fact:42", "fact_triple");

    const result = await getMemoryHints("tea leaves", ctx, db);
    expect(result).toContain("[fact]");
  });
});

// ---------------------------------------------------------------------------
// formatNavigatorEvidence
// ---------------------------------------------------------------------------

describe("formatNavigatorEvidence", () => {
  const ctx = makeViewerContext();

  it("returns empty string for null input", () => {
    expect(formatNavigatorEvidence(null, ctx)).toBe("");
  });

  it("returns empty string for undefined input", () => {
    expect(formatNavigatorEvidence(undefined, ctx)).toBe("");
  });

  it("returns empty string for non-object input", () => {
    expect(formatNavigatorEvidence("not an object", ctx)).toBe("");
    expect(formatNavigatorEvidence(42, ctx)).toBe("");
  });

  it("returns empty string for result with no evidence paths", () => {
    const emptyResult: NavigatorResult = {
      query: "test",
      query_type: "entity",
      evidence_paths: [],
    };
    expect(formatNavigatorEvidence(emptyResult, ctx)).toBe("");
  });

  it("returns readable structured text for valid navigator result", () => {
    const result: NavigatorResult = {
      query: "Who is Alice?",
      query_type: "entity",
      evidence_paths: [
        {
          path: {
            seed: "entity:1" as NodeRef,
            nodes: ["entity:1" as NodeRef, "event:5" as NodeRef],
            edges: [
              {
                from: "entity:1" as NodeRef,
                to: "event:5" as NodeRef,
                kind: "participant",
                weight: 0.9,
                timestamp: 1700000000,
                summary: "Alice attended the gathering",
              },
            ],
            depth: 1,
          },
          score: {
            seed_score: 0.8,
            edge_type_score: 0.7,
            temporal_consistency: 0.9,
            query_intent_match: 0.85,
            support_score: 0.6,
            recency_score: 0.75,
            hop_penalty: 0.1,
            redundancy_penalty: 0.05,
            path_score: 0.723,
          },
          supporting_nodes: ["entity:2" as NodeRef],
          supporting_facts: [10, 11],
        },
      ],
    };

    const output = formatNavigatorEvidence(result, ctx);

    expect(output).toContain('Query: "Who is Alice?" (entity)');
    expect(output).toContain("Evidence Path 1");
    expect(output).toContain("score: 0.723");
    expect(output).toContain("Seed: entity:1");
    expect(output).toContain("Depth: 1");
    expect(output).toContain("entity:1 -[participant]-> event:5");
    expect(output).toMatch(/\[(just now|recent|days ago|weeks ago|old)\]/);
    expect(output).toContain("Alice attended the gathering");
    expect(output).toContain("f:10, f:11");
    expect(output).toContain("entity:2");
  });

  it("formats multiple evidence paths", () => {
    const result: NavigatorResult = {
      query: "coffee events",
      query_type: "timeline",
      evidence_paths: [
        {
          path: {
            seed: "event:1" as NodeRef,
            nodes: ["event:1" as NodeRef],
            edges: [],
            depth: 0,
          },
          score: {
            seed_score: 0.9,
            edge_type_score: 0,
            temporal_consistency: 1,
            query_intent_match: 0.8,
            support_score: 0,
            recency_score: 0.9,
            hop_penalty: 0,
            redundancy_penalty: 0,
            path_score: 0.85,
          },
          supporting_nodes: [],
          supporting_facts: [],
        },
        {
          path: {
            seed: "event:2" as NodeRef,
            nodes: ["event:2" as NodeRef],
            edges: [],
            depth: 0,
          },
          score: {
            seed_score: 0.7,
            edge_type_score: 0,
            temporal_consistency: 1,
            query_intent_match: 0.6,
            support_score: 0,
            recency_score: 0.7,
            hop_penalty: 0,
            redundancy_penalty: 0,
            path_score: 0.65,
          },
          supporting_nodes: [],
          supporting_facts: [],
        },
      ],
    };

    const output = formatNavigatorEvidence(result, ctx);

    expect(output).toContain("Evidence Path 1");
    expect(output).toContain("Evidence Path 2");
    expect(output).toContain("score: 0.850");
    expect(output).toContain("score: 0.650");
  });

  it("handles edges without timestamp or summary", () => {
    const result: NavigatorResult = {
      query: "test",
      query_type: "relationship",
      evidence_paths: [
        {
          path: {
            seed: "entity:1" as NodeRef,
            nodes: ["entity:1" as NodeRef, "entity:2" as NodeRef],
            edges: [
              {
                from: "entity:1" as NodeRef,
                to: "entity:2" as NodeRef,
                kind: "entity_bridge",
                weight: 0.5,
                timestamp: null,
                summary: null,
              },
            ],
            depth: 1,
          },
          score: {
            seed_score: 0.5,
            edge_type_score: 0.3,
            temporal_consistency: 0.5,
            query_intent_match: 0.4,
            support_score: 0.2,
            recency_score: 0.3,
            hop_penalty: 0.1,
            redundancy_penalty: 0,
            path_score: 0.4,
          },
          supporting_nodes: [],
          supporting_facts: [],
        },
      ],
    };

    const output = formatNavigatorEvidence(result, ctx);

    // Should have the edge line without @timestamp or summary
    expect(output).toContain("entity:1 -[entity_bridge]-> entity:2");
    expect(output).not.toContain("@");
    expect(output).not.toContain("—");
  });

  it("does not contain prompt assembly logic", () => {
    // Verify that formatNavigatorEvidence only returns data text,
    // not system prompt templates, role markers, or placement directives
    const result: NavigatorResult = {
      query: "test",
      query_type: "entity",
      evidence_paths: [
        {
          path: {
            seed: "entity:1" as NodeRef,
            nodes: ["entity:1" as NodeRef],
            edges: [],
            depth: 0,
          },
          score: {
            seed_score: 0.5,
            edge_type_score: 0,
            temporal_consistency: 1,
            query_intent_match: 0.5,
            support_score: 0,
            recency_score: 0.5,
            hop_penalty: 0,
            redundancy_penalty: 0,
            path_score: 0.5,
          },
          supporting_nodes: [],
          supporting_facts: [],
        },
      ],
    };

    const output = formatNavigatorEvidence(result, ctx);

    // No prompt assembly markers
    expect(output).not.toContain("<system>");
    expect(output).not.toContain("</system>");
    expect(output).not.toContain("<user>");
    expect(output).not.toContain("<assistant>");
    expect(output).not.toContain("You are");
  });
});
