import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { EmbeddingService } from "./embeddings.js";
import { createMemorySchema } from "./schema.js";
import { TransactionBatcher } from "./transaction-batcher.js";
import type { NodeRef } from "./types.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  createMemorySchema(db);
  return db;
}

describe("EmbeddingService", () => {
  let db: Database;
  let service: EmbeddingService;

  beforeEach(() => {
    db = freshDb();
    service = new EmbeddingService(db, new TransactionBatcher(db));
  });

  it("cosineSimilarity returns 1 for identical vectors", () => {
    const vector = new Float32Array([1, 2, 3]);
    expect(service.cosineSimilarity(vector, vector)).toBe(1);
  });

  it("cosineSimilarity returns near 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(service.cosineSimilarity(a, b)).toBe(0);
  });

  it("cosineSimilarity returns 0 for zero-vector comparison", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(service.cosineSimilarity(a, b)).toBe(0);
  });

  it("batchStoreEmbeddings stores rows with recoverable vectors", () => {
    service.batchStoreEmbeddings([
      {
        nodeRef: "event:1" as NodeRef,
        nodeKind: "event",
        viewType: "primary",
        modelId: "test-model",
        embedding: new Float32Array([1, 2, 3]),
      },
      {
        nodeRef: "entity:2" as NodeRef,
        nodeKind: "entity",
        viewType: "context",
        modelId: "test-model",
        embedding: new Float32Array([2, 3, 4]),
      },
    ]);

    const rows = db
      .prepare("SELECT node_ref, node_kind, view_type, model_id, embedding FROM node_embeddings ORDER BY id")
      .all() as Array<{
      node_ref: string;
      node_kind: string;
      view_type: string;
      model_id: string;
      embedding: Buffer;
    }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].node_ref).toBe("event:1");
    expect(rows[1].node_kind).toBe("entity");
    expect(rows[1].view_type).toBe("context");
    expect(rows[1].model_id).toBe("test-model");

    const vector = service.deserializeEmbedding(rows[0].embedding);
    expect(Array.from(vector)).toEqual([1, 2, 3]);
  });

  it("serializeEmbedding and deserializeEmbedding round-trip values", () => {
    const source = new Float32Array([0.1, 1.5, -3.25, 7]);
    const blob = service.serializeEmbedding(source);
    const restored = service.deserializeEmbedding(blob);
    expect(Array.from(restored)).toEqual(Array.from(source));
  });

  it("queryNearestNeighbors returns the most similar vector first", () => {
    service.batchStoreEmbeddings([
      {
        nodeRef: "event:1" as NodeRef,
        nodeKind: "event",
        viewType: "primary",
        modelId: "test-model",
        embedding: new Float32Array([1, 0, 0]),
      },
      {
        nodeRef: "event:2" as NodeRef,
        nodeKind: "event",
        viewType: "primary",
        modelId: "test-model",
        embedding: new Float32Array([0.9, 0.1, 0]),
      },
      {
        nodeRef: "event:3" as NodeRef,
        nodeKind: "event",
        viewType: "primary",
        modelId: "test-model",
        embedding: new Float32Array([0, 1, 0]),
      },
    ]);

    const neighbors = service.queryNearestNeighbors(new Float32Array([1, 0, 0]), { agentId: null, limit: 2 });
    expect(neighbors).toHaveLength(2);
    expect(neighbors[0].nodeRef).toBe("event:1");
    expect(neighbors[0].similarity).toBe(1);
    expect(neighbors[1].nodeRef).toBe("event:2");
  });

  it("queryNearestNeighbors with agentId filters out other agents' private refs", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO agent_event_overlay (id, event_id, agent_id, event_category, projection_class, created_at) VALUES (?,?,?,?,?,?)",
    ).run(1, null, "agent-a", "thought", "none", now);
    db.prepare(
      "INSERT INTO agent_event_overlay (id, event_id, agent_id, event_category, projection_class, created_at) VALUES (?,?,?,?,?,?)",
    ).run(2, null, "agent-b", "thought", "none", now);

    service.batchStoreEmbeddings([
      {
        nodeRef: "private_event:1" as NodeRef,
        nodeKind: "private_event",
        viewType: "primary",
        modelId: "test-model",
        embedding: new Float32Array([1, 0, 0]),
      },
      {
        nodeRef: "private_event:2" as NodeRef,
        nodeKind: "private_event",
        viewType: "primary",
        modelId: "test-model",
        embedding: new Float32Array([1, 0, 0]),
      },
    ]);

    const neighbors = service.queryNearestNeighbors(new Float32Array([1, 0, 0]), {
      agentId: "agent-a",
      limit: 10,
    });

    expect(neighbors.map((item) => item.nodeRef)).toEqual(["private_event:1"]);
  });
});
