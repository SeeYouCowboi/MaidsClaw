import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { EmbeddingService } from "./embeddings.js";
import { createMemorySchema } from "./schema.js";
import { TransactionBatcher } from "./transaction-batcher.js";
import type { NodeRef } from "./types.js";
import type { Db } from "../storage/database.js";

function freshDb(): Db {
  const raw = new Database(":memory:");
  createMemorySchema(raw);
  return {
    raw,
    exec(sql: string): void {
      raw.exec(sql);
    },
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
      const stmt = raw.prepare(sql);
      return (params ? stmt.all(...params as []) : stmt.all()) as T[];
    },
    run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
      const stmt = raw.prepare(sql);
      const result = params ? stmt.run(...params as []) : stmt.run();
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
      const stmt = raw.prepare(sql);
      const result = params ? stmt.get(...params as []) : stmt.get();
      return result === null ? undefined : result as T;
    },
    close(): void {
      raw.close();
    },
    transaction<T>(fn: () => T): T {
      return raw.transaction(fn)();
    },
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      return {
        run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
          const result = params.length > 0 ? stmt.run(...params as []) : stmt.run();
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        all(...params: unknown[]): unknown[] {
          return (params.length > 0 ? stmt.all(...params as []) : stmt.all()) as unknown[];
        },
        get(...params: unknown[]): unknown {
          const result = params.length > 0 ? stmt.get(...params as []) : stmt.get();
          return result === null ? undefined : result;
        },
      };
    },
  };
}

describe("EmbeddingService", () => {
  let db: Db;
  let service: EmbeddingService;

  beforeEach(() => {
    db = freshDb();
    service = EmbeddingService.fromSqlite(db, new TransactionBatcher(db));
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
    expect(neighbors[0].nodeRef).toBe("event:1" as NodeRef);
    expect(neighbors[0].similarity).toBe(1);
    expect(neighbors[1].nodeRef).toBe("event:2" as NodeRef);
  });

  it("queryNearestNeighbors with agentId filters out other agents' private cognition refs", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO private_cognition_current (id, agent_id, cognition_key, kind, stance, basis, status, pre_contested_stance, summary_text, record_json, source_event_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(1, "agent-a", "eval:1", "evaluation", null, null, "active", null, "a", "{}", 1, now);
    db.prepare(
      "INSERT INTO private_cognition_current (id, agent_id, cognition_key, kind, stance, basis, status, pre_contested_stance, summary_text, record_json, source_event_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(2, "agent-b", "eval:2", "evaluation", null, null, "active", null, "b", "{}", 1, now);

    service.batchStoreEmbeddings([
      {
        nodeRef: "evaluation:1" as NodeRef,
        nodeKind: "evaluation",
        viewType: "primary",
        modelId: "test-model",
        embedding: new Float32Array([1, 0, 0]),
      },
      {
        nodeRef: "evaluation:2" as NodeRef,
        nodeKind: "evaluation",
        viewType: "primary",
        modelId: "test-model",
        embedding: new Float32Array([1, 0, 0]),
      },
    ]);

    const neighbors = service.queryNearestNeighbors(new Float32Array([1, 0, 0]), {
      agentId: "agent-a",
      limit: 10,
    });

    expect(neighbors.map((item) => item.nodeRef)).toEqual(["evaluation:1"]);
  });
});
