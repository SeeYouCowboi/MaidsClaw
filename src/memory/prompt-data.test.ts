import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createMemorySchema } from "./schema";
import { CoreMemoryService } from "./core-memory";
import { formatNavigatorEvidence, getRecentCognition, formatContestedEntry, getAttachedSharedBlocks, getPinnedBlocks } from "./prompt-data";
import { openDatabase, closeDatabaseGracefully, type Db } from "../storage/database.js";
import { runInteractionMigrations } from "../interaction/schema.js";
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
    expect(output).toContain("@1700000000");
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

// ---------------------------------------------------------------------------
// getRecentCognition
// ---------------------------------------------------------------------------

describe("getRecentCognition", () => {
  let db: Db;

  function insertSlot(agentId: string, sessionId: string, entries: unknown[]) {
    db.run(
      "INSERT OR REPLACE INTO recent_cognition_slots (session_id, agent_id, last_settlement_id, slot_payload, updated_at) VALUES (?, ?, ?, ?, ?)",
      [sessionId, agentId, "stl:test", JSON.stringify(entries), Date.now()],
    );
  }

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    runInteractionMigrations(db);
  });

  it("returns empty string when no slot exists", () => {
    const result = getRecentCognition("agent-1", "sess-1", db);
    expect(result).toBe("");
  });

  it("returns empty string for invalid JSON payload", () => {
    db.run(
      "INSERT INTO recent_cognition_slots (session_id, agent_id, last_settlement_id, slot_payload, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["sess-1", "agent-1", "stl:x", "not-json", Date.now()],
    );
    const result = getRecentCognition("agent-1", "sess-1", db);
    expect(result).toBe("");
  });

  it("recent cognition compresses latest state and retracts", () => {
    const entries = [
      { settlementId: "stl:1", committedAt: 1000, kind: "assertion", key: "trust-bob", summary: "self trusts Bob (accepted)", status: "active" },
      { settlementId: "stl:2", committedAt: 2000, kind: "assertion", key: "trust-bob", summary: "self trusts Bob (tentative)", status: "active" },
      { settlementId: "stl:1", committedAt: 1000, kind: "evaluation", key: "eval-bob", summary: "eval Bob [trust:5]", status: "active" },
      { settlementId: "stl:2", committedAt: 2000, kind: "evaluation", key: "eval-bob", summary: "eval Bob [trust:8]", status: "active" },
      { settlementId: "stl:3", committedAt: 3000, kind: "assertion", key: "old-grudge", summary: "(retracted)", status: "retracted" },
    ];
    insertSlot("agent-1", "sess-1", entries);

    const result = getRecentCognition("agent-1", "sess-1", db);

    expect(result).toContain("[assertion:trust-bob] self trusts Bob (tentative)");
    expect(result).not.toContain("self trusts Bob (accepted)");

    expect(result).toContain("[evaluation:eval-bob] eval Bob [trust:8]");
    expect(result).not.toContain("eval Bob [trust:5]");

    expect(result).toContain("[assertion:old-grudge] (retracted)");

    const lines = result.split("\n");
    expect(lines.length).toBe(3);

    expect(lines[0]).toContain("[assertion:old-grudge]");
    expect(lines[1]).toContain("[assertion:trust-bob]");
    expect(lines[2]).toContain("[evaluation:eval-bob]");

    closeDatabaseGracefully(db);
  });

  it("recent cognition caps rendered items to 10", () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({
      settlementId: `stl:${i}`,
      committedAt: 1000 + i,
      kind: "assertion",
      key: `key-${i}`,
      summary: `summary ${i}`,
      status: "active" as const,
    }));
    insertSlot("agent-1", "sess-1", entries);

    const result = getRecentCognition("agent-1", "sess-1", db);
    const lines = result.split("\n");
    expect(lines.length).toBe(10);

    expect(lines[0]).toContain("[assertion:key-14]");
    expect(lines[9]).toContain("[assertion:key-5]");

    expect(result).not.toContain("key-4");
    expect(result).not.toContain("key-0");

    closeDatabaseGracefully(db);
  });

  it("prioritizes active commitments even when older than other entries", () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      settlementId: `stl:${i}`,
      committedAt: 1000 + i * 100,
      kind: "assertion",
      key: `fact-${i}`,
      summary: `fact ${i}`,
      status: "active" as const,
    }));

    entries.push({
      settlementId: "stl:early",
      committedAt: 500,
      kind: "commitment",
      key: "old-goal",
      summary: "investigate butler accounts",
      status: "active" as const,
    });
    entries.push({
      settlementId: "stl:early2",
      committedAt: 600,
      kind: "commitment",
      key: "old-goal-2",
      summary: "protect master interests",
      status: "active" as const,
    });

    insertSlot("agent-1", "sess-1", entries);

    const result = getRecentCognition("agent-1", "sess-1", db);

    expect(result).toContain("[commitment:old-goal]");
    expect(result).toContain("[commitment:old-goal-2]");

    const lines = result.split("\n");
    expect(lines.length).toBe(10);

    closeDatabaseGracefully(db);
  });

  it("caps commitment priority slots to 4", () => {
    const entries: Array<{settlementId: string; committedAt: number; kind: string; key: string; summary: string; status: "active" | "retracted"}> = [];

    for (let i = 0; i < 6; i++) {
      entries.push({
        settlementId: `stl:c${i}`,
        committedAt: 100 + i,
        kind: "commitment",
        key: `commit-${i}`,
        summary: `commitment ${i}`,
        status: "active",
      });
    }

    for (let i = 0; i < 10; i++) {
      entries.push({
        settlementId: `stl:a${i}`,
        committedAt: 2000 + i,
        kind: "assertion",
        key: `assert-${i}`,
        summary: `assertion ${i}`,
        status: "active",
      });
    }

    insertSlot("agent-1", "sess-1", entries);

    const result = getRecentCognition("agent-1", "sess-1", db);
    const commitmentLines = result.split("\n").filter((l: string) => l.includes("[commitment:"));
    expect(commitmentLines.length).toBe(4);

    const lines = result.split("\n");
    expect(lines.length).toBe(10);

    closeDatabaseGracefully(db);
  });

  it("retracted commitments do not get priority slots", () => {
    const entries = [
      { settlementId: "stl:1", committedAt: 100, kind: "commitment", key: "retracted-goal", summary: "abandoned", status: "retracted" as const },
      { settlementId: "stl:2", committedAt: 200, kind: "assertion", key: "fact-1", summary: "a fact", status: "active" as const },
    ];
    insertSlot("agent-1", "sess-1", entries);

    const result = getRecentCognition("agent-1", "sess-1", db);
    expect(result).toContain("[commitment:retracted-goal] (retracted)");
    expect(result).toContain("[assertion:fact-1]");

    closeDatabaseGracefully(db);
  });

  it("renders newest-first ordering by committedAt", () => {
    const entries = [
      { settlementId: "stl:1", committedAt: 3000, kind: "commitment", key: "goal-a", summary: "goal A", status: "active" },
      { settlementId: "stl:2", committedAt: 1000, kind: "assertion", key: "fact-b", summary: "fact B", status: "active" },
      { settlementId: "stl:3", committedAt: 2000, kind: "evaluation", key: "eval-c", summary: "eval C", status: "active" },
    ];
    insertSlot("agent-1", "sess-1", entries);

    const result = getRecentCognition("agent-1", "sess-1", db);
    const lines = result.split("\n");
    expect(lines[0]).toContain("goal-a");
    expect(lines[1]).toContain("eval-c");
    expect(lines[2]).toContain("fact-b");

    closeDatabaseGracefully(db);
  });

  it("staged recent cognition appears before flush in getRecentCognition", () => {
    createMemorySchema(db as unknown as Database);

    const stagedEntries = [
      {
        settlementId: "stl:staged-1",
        committedAt: Date.now(),
        kind: "assertion",
        key: "staged-belief",
        summary: "This is a staged belief before flush",
        status: "active" as const,
      },
    ];
    insertSlot("agent-1", "sess-1", stagedEntries);

    const recentResult = getRecentCognition("agent-1", "sess-1", db);
    expect(recentResult).toContain("[assertion:staged-belief]");
    expect(recentResult).toContain("This is a staged belief before flush");

    closeDatabaseGracefully(db);
  });

  it("contested entries render with old belief + conflict evidence", () => {
    const entries = [
      {
        settlementId: "stl:contest-1",
        committedAt: 1000,
        kind: "assertion",
        key: "trust-bob",
        summary: "self trusts Bob",
        status: "active" as const,
        stance: "contested",
        preContestedStance: "accepted",
        conflictEvidence: ["Bob lied about the key", "Contradicts earlier observation"],
      },
      {
        settlementId: "stl:normal-1",
        committedAt: 2000,
        kind: "assertion",
        key: "likes-tea",
        summary: "self likes tea",
        status: "active" as const,
      },
    ];
    insertSlot("agent-1", "sess-1", entries);

    const result = getRecentCognition("agent-1", "sess-1", db);

    expect(result).toContain("[CONTESTED: was accepted]");
    expect(result).toContain("self trusts Bob");
    expect(result).toContain("Risk:");
    expect(result).not.toContain("Bob lied about the key");
    expect(result).toContain("[assertion:likes-tea] self likes tea");

    closeDatabaseGracefully(db);
  });

  it("contested entry without conflict evidence renders marker only", () => {
    const entries = [
      {
        settlementId: "stl:contest-2",
        committedAt: 1000,
        kind: "assertion",
        key: "mood-happy",
        summary: "self is happy",
        status: "active" as const,
        stance: "contested",
        preContestedStance: "confirmed",
      },
    ];
    insertSlot("agent-1", "sess-1", entries);

    const result = getRecentCognition("agent-1", "sess-1", db);

    expect(result).toContain("[CONTESTED: was confirmed]");
    expect(result).toContain("self is happy");
    expect(result).not.toContain("Conflicts:");

    closeDatabaseGracefully(db);
  });
});

describe("formatContestedEntry", () => {
  it("formats contested entry with preContestedStance and short risk note (section-18 frontstage)", () => {
    const entry = {
      settlementId: "stl:1",
      committedAt: 1000,
      kind: "assertion",
      key: "trust-bob",
      summary: "self trusts Bob",
      status: "active" as const,
      stance: "contested",
      preContestedStance: "accepted",
      conflictEvidence: ["evidence A", "evidence B"],
    };

    const result = formatContestedEntry(entry);
    expect(result).toContain("[CONTESTED: was accepted]");
    expect(result).toContain("self trusts Bob");
    // Section-18: frontstage shows short risk note only; full conflict chain is explain-only
    expect(result).toContain("Risk:");
    expect(result).not.toContain("evidence A; evidence B");
  });

  it("formats contested entry without evidence", () => {
    const entry = {
      settlementId: "stl:2",
      committedAt: 1000,
      kind: "assertion",
      key: "mood",
      summary: "self is happy",
      stance: "contested",
    };

    const result = formatContestedEntry(entry);
    expect(result).toContain("[CONTESTED: was unknown]");
    expect(result).toContain("self is happy");
    expect(result).not.toContain("Conflicts:");
  });
});

// ---------------------------------------------------------------------------
// getAttachedSharedBlocks
// ---------------------------------------------------------------------------

describe("getAttachedSharedBlocks", () => {
  let db: Db;

  function seedSharedBlock(title: string, createdBy: string): number {
    const now = Date.now();
    const result = db.run(
      `INSERT INTO shared_blocks (title, created_by_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [title, createdBy, now, now],
    );
    return Number(result.lastInsertRowid);
  }

  function addSection(blockId: number, sectionPath: string, content: string): void {
    const now = Date.now();
    db.run(
      `INSERT INTO shared_block_sections (block_id, section_path, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [blockId, sectionPath, content, now, now],
    );
  }

  function attachToAgent(blockId: number, agentId: string, attachedBy: string): void {
    const now = Date.now();
    db.run(
      `INSERT INTO shared_block_attachments (block_id, target_kind, target_id, attached_by_agent_id, attached_at) VALUES (?, 'agent', ?, ?, ?)`,
      [blockId, agentId, attachedBy, now],
    );
  }

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    createMemorySchema(db.raw);
  });

  it("returns empty string when no attachments exist", () => {
    const result = getAttachedSharedBlocks("agent-1", db);
    expect(result).toBe("");
  });

  it("returns formatted shared block with sections for attached agent", () => {
    const blockId = seedSharedBlock("Household Rules", "agent-owner");
    addSection(blockId, "etiquette/greeting", "Always bow when greeting");
    addSection(blockId, "etiquette/service", "Serve tea promptly");
    attachToAgent(blockId, "agent-1", "agent-owner");

    const result = getAttachedSharedBlocks("agent-1", db);

    expect(result).toContain('<shared_block title="Household Rules">');
    expect(result).toContain("etiquette/greeting: Always bow when greeting");
    expect(result).toContain("etiquette/service: Serve tea promptly");
    expect(result).toContain("</shared_block>");
  });

  it("returns multiple blocks when agent has multiple attachments", () => {
    const block1 = seedSharedBlock("Rules", "agent-owner");
    addSection(block1, "rule-1", "Be polite");
    attachToAgent(block1, "agent-1", "agent-owner");

    const block2 = seedSharedBlock("Lore", "agent-owner");
    addSection(block2, "world/setting", "Victorian mansion");
    attachToAgent(block2, "agent-1", "agent-owner");

    const result = getAttachedSharedBlocks("agent-1", db);

    expect(result).toContain('<shared_block title="Rules">');
    expect(result).toContain('<shared_block title="Lore">');
    expect(result).toContain("rule-1: Be polite");
    expect(result).toContain("world/setting: Victorian mansion");
  });

  it("skips blocks with no sections", () => {
    const blockId = seedSharedBlock("Empty Block", "agent-owner");
    attachToAgent(blockId, "agent-1", "agent-owner");

    const result = getAttachedSharedBlocks("agent-1", db);
    expect(result).toBe("");
  });

  it("does not return blocks attached to a different agent", () => {
    const blockId = seedSharedBlock("Private Rules", "agent-owner");
    addSection(blockId, "rule", "Secret rule");
    attachToAgent(blockId, "agent-2", "agent-owner");

    const result = getAttachedSharedBlocks("agent-1", db);
    expect(result).toBe("");
  });

  it("shared blocks coexist with pinned memory blocks without overwriting", () => {
    createMemorySchema(db.raw);
    const coreMemory = new CoreMemoryService(db.raw);
    coreMemory.initializeBlocks("agent-1");
    coreMemory.appendBlock("agent-1", "persona", "A cheerful maid");

    const blockId = seedSharedBlock("Shared Etiquette", "agent-owner");
    addSection(blockId, "greeting", "Always curtsy");
    attachToAgent(blockId, "agent-1", "agent-owner");

    const pinnedResult = getPinnedBlocks("agent-1", db.raw);
    const sharedResult = getAttachedSharedBlocks("agent-1", db);

    expect(pinnedResult).toContain("A cheerful maid");
    expect(pinnedResult).toContain('<pinned_block label="persona"');
    expect(pinnedResult).not.toContain("Always curtsy");

    expect(sharedResult).toContain('<shared_block title="Shared Etiquette">');
    expect(sharedResult).toContain("greeting: Always curtsy");
    expect(sharedResult).not.toContain("A cheerful maid");

    closeDatabaseGracefully(db);
  });
});
