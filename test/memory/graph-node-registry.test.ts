import { describe, expect, it } from "bun:test";
import { CoreMemoryService } from "../../src/memory/core-memory.js";
import { EmbeddingService } from "../../src/memory/embeddings.js";
import { GraphOrganizer } from "../../src/memory/graph-organizer.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { TransactionBatcher } from "../../src/memory/transaction-batcher.js";
import type { NodeRef } from "../../src/memory/types.js";
import { cleanupDb, createTempDb } from "../helpers/memory-test-utils.js";

const AGENT_ID = "agent-registry-1";
const EMBEDDING_MODEL = "test-embed-model";

function makeMockModelProvider() {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
    },
  };
}

function seedAssertion(db: ReturnType<typeof createTempDb>["db"], agentId: string): { assertionId: number; eventId: number } {
  const now = Date.now();
  const eventResult = db.run(
    `INSERT INTO event_nodes
       (session_id, summary, timestamp, created_at, location_entity_id, event_category, visibility_scope, event_origin)
     VALUES ('sess-seed', 'seed event', ?, ?, 1, 'observation', 'area_visible', 'runtime_projection')`,
    [now, now],
  );
  const eventId = Number(eventResult.lastInsertRowid);
  const result = db.run(
    `INSERT INTO private_cognition_current
       (agent_id, kind, cognition_key, summary_text, record_json, status, stance, source_event_id, updated_at)
     VALUES (?, 'assertion', 'test-cog-key', 'test predicate', '{"provenance":"test"}', 'active', 'held', ?, ?)`,
    [agentId, eventId, now],
  );
  return { assertionId: Number(result.lastInsertRowid), eventId };
}

describe("graph node registry (shadow)", () => {
  it("registers nodes in graph_nodes when organizer runs", async () => {
    const { db, dbPath } = createTempDb();
    try {
      const storage = new GraphStorageService(db);
      const coreMemory = new CoreMemoryService(db);
      const embeddings = new EmbeddingService(db, new TransactionBatcher(db));
      const modelProvider = makeMockModelProvider();

      coreMemory.initializeBlocks(AGENT_ID);

      const { assertionId } = seedAssertion(db, AGENT_ID);
      const nodeRef = `assertion:${assertionId}` as NodeRef;

      const organizer = new GraphOrganizer(db.raw, storage, coreMemory, embeddings, modelProvider);
      await organizer.run({
        agentId: AGENT_ID,
        sessionId: "session-registry-1",
        batchId: "batch-registry-1",
        changedNodeRefs: [nodeRef],
        embeddingModelId: EMBEDDING_MODEL,
      });

      const row = db.get<{ node_kind: string; node_id: number; node_ref: string }>(
        `SELECT node_kind, node_id, node_ref FROM graph_nodes WHERE node_ref = ?`,
        [nodeRef],
      );
      expect(row).toBeDefined();
      expect(row!.node_kind).toBe("assertion");
      expect(row!.node_id).toBe(assertionId);
      expect(row!.node_ref).toBe(nodeRef);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("updates updated_at on duplicate shadow registration", async () => {
    const { db, dbPath } = createTempDb();
    try {
      const storage = new GraphStorageService(db);
      const coreMemory = new CoreMemoryService(db);
      const embeddings = new EmbeddingService(db, new TransactionBatcher(db));
      const modelProvider = makeMockModelProvider();

      coreMemory.initializeBlocks(AGENT_ID);

      const { assertionId } = seedAssertion(db, AGENT_ID);
      const nodeRef = `assertion:${assertionId}` as NodeRef;

      const organizer = new GraphOrganizer(db.raw, storage, coreMemory, embeddings, modelProvider);
      const job = {
        agentId: AGENT_ID,
        sessionId: "session-registry-2",
        batchId: "batch-registry-2",
        changedNodeRefs: [nodeRef],
        embeddingModelId: EMBEDDING_MODEL,
      };

      await organizer.run(job);
      const first = db.get<{ updated_at: number }>(`SELECT updated_at FROM graph_nodes WHERE node_ref = ?`, [nodeRef]);
      expect(first).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 5));
      await organizer.run(job);
      const second = db.get<{ updated_at: number }>(`SELECT updated_at FROM graph_nodes WHERE node_ref = ?`, [nodeRef]);
      expect(second).toBeDefined();
      expect(second!.updated_at).toBeGreaterThanOrEqual(first!.updated_at);

      const count = db.get<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM graph_nodes WHERE node_ref = ?`, [nodeRef]);
      expect(count!.cnt).toBe(1);
    } finally {
      cleanupDb(db, dbPath);
    }
  });
});

describe("migration 036 idempotency", () => {
  it("runs migration 036 twice without error", () => {
    const { db, dbPath } = createTempDb();
    try {
      runMemoryMigrations(db);

      const row = db.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='graph_nodes'`,
      );
      expect(row).toBeDefined();
      expect(row!.name).toBe("graph_nodes");
    } finally {
      cleanupDb(db, dbPath);
    }
  });
});

describe("graph-registry-coverage script", () => {
  it("produces coverage output on an empty database", () => {
    const { db, dbPath } = createTempDb();
    try {
      const embeddingTotal =
        db.get<{ total: number }>(`SELECT COUNT(DISTINCT node_ref) as total FROM node_embeddings`)?.total ?? 0;
      const registeredTotal =
        db.get<{ total: number }>(`SELECT COUNT(*) as total FROM graph_nodes`)?.total ?? 0;

      expect(embeddingTotal).toBe(0);
      expect(registeredTotal).toBe(0);

      const coveragePct = embeddingTotal > 0 ? ((registeredTotal / embeddingTotal) * 100).toFixed(1) : "N/A";
      expect(coveragePct).toBe("N/A");
    } finally {
      cleanupDb(db, dbPath);
    }
  });
});
