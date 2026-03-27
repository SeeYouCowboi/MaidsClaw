import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { EmbeddingService } from "../../src/memory/embeddings.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { TransactionBatcher } from "../../src/memory/transaction-batcher.js";
import type { NodeRef } from "../../src/memory/types.js";
import { createTempDb, cleanupDb, type Db } from "../helpers/memory-test-utils.js";

describe("embedding versioning and dimension safety", () => {
  let db: Db;
  let dbPath: string;
  let storage: GraphStorageService;
  let embeddingService: EmbeddingService;

  beforeEach(() => {
    const temp = createTempDb();
    db = temp.db;
    dbPath = temp.dbPath;
    storage = new GraphStorageService(db);
    embeddingService = new EmbeddingService(db, new TransactionBatcher(db));
  });

  afterEach(() => {
    cleanupDb(db, dbPath);
  });

  describe("model switch safety", () => {
    it("similarity search with modelId filter only returns embeddings from the specified model", () => {
      for (let i = 1; i <= 5; i++) {
        embeddingService.batchStoreEmbeddings([
          {
            nodeRef: `event:${i}` as NodeRef,
            nodeKind: "event",
            viewType: "primary",
            modelId: "model-a",
            embedding: new Float32Array([i * 0.1, 0.5, 0.3]),
          },
        ]);
      }

      for (let i = 6; i <= 7; i++) {
        embeddingService.batchStoreEmbeddings([
          {
            nodeRef: `event:${i}` as NodeRef,
            nodeKind: "event",
            viewType: "primary",
            modelId: "model-b",
            embedding: new Float32Array([i * 0.1, 0.6, 0.4]),
          },
        ]);
      }

      const neighborsB = embeddingService.queryNearestNeighbors(
        new Float32Array([0.6, 0.6, 0.4]),
        { agentId: null, modelId: "model-b", limit: 10 },
      );

      expect(neighborsB).toHaveLength(2);
      const bRefs = neighborsB.map((n) => n.nodeRef);
      expect(bRefs).toContain("event:6" as NodeRef);
      expect(bRefs).toContain("event:7" as NodeRef);

      const neighborsA = embeddingService.queryNearestNeighbors(
        new Float32Array([0.3, 0.5, 0.3]),
        { agentId: null, modelId: "model-a", limit: 10 },
      );

      expect(neighborsA).toHaveLength(5);
    });

    it("search without modelId filter returns all embeddings across models", () => {
      embeddingService.batchStoreEmbeddings([
        {
          nodeRef: "event:1" as NodeRef,
          nodeKind: "event",
          viewType: "primary",
          modelId: "model-a",
          embedding: new Float32Array([1, 0, 0]),
        },
        {
          nodeRef: "event:2" as NodeRef,
          nodeKind: "event",
          viewType: "primary",
          modelId: "model-b",
          embedding: new Float32Array([0.9, 0.1, 0]),
        },
      ]);

      const all = embeddingService.queryNearestNeighbors(
        new Float32Array([1, 0, 0]),
        { agentId: null, limit: 10 },
      );

      expect(all).toHaveLength(2);
    });
  });

  describe("dimension mismatch rejection", () => {
    it("upsertNodeEmbedding rejects zero-length embedding", () => {
      expect(() => {
        storage.upsertNodeEmbedding(
          "event:1" as NodeRef,
          "event",
          "primary",
          "model-x",
          new Float32Array([]),
        );
      }).toThrow(/dimension is 0/i);
    });

    it("upsertNodeEmbedding rejects dimension mismatch within the same model", () => {
      storage.upsertNodeEmbedding(
        "event:1" as NodeRef,
        "event",
        "primary",
        "model-x",
        new Float32Array([1, 2, 3]),
      );

      expect(() => {
        storage.upsertNodeEmbedding(
          "event:2" as NodeRef,
          "event",
          "primary",
          "model-x",
          new Float32Array([1, 2, 3, 4, 5]),
        );
      }).toThrow(/dimension mismatch.*model.*model-x.*expected 3.*got 5/i);
    });

    it("upsertNodeEmbedding allows different dimensions for different models", () => {
      storage.upsertNodeEmbedding(
        "event:1" as NodeRef,
        "event",
        "primary",
        "model-small",
        new Float32Array([1, 2, 3]),
      );

      expect(() => {
        storage.upsertNodeEmbedding(
          "event:2" as NodeRef,
          "event",
          "primary",
          "model-large",
          new Float32Array([1, 2, 3, 4, 5]),
        );
      }).not.toThrow();
    });

    it("cosineSimilarity warns on dimension mismatch and returns 0", () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([1, 0, 0, 0, 0]);

      const warnMessages: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnMessages.push(args.map(String).join(" "));
      };

      try {
        const result = embeddingService.cosineSimilarity(a, b);
        expect(result).toBe(0);
        expect(warnMessages.length).toBeGreaterThan(0);
        expect(warnMessages[0]).toContain("dimension mismatch");
        expect(warnMessages[0]).toContain("3");
        expect(warnMessages[0]).toContain("5");
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe("getEmbeddingStatsByModel", () => {
    it("returns count and dimension grouped by model_id", () => {
      embeddingService.batchStoreEmbeddings([
        {
          nodeRef: "event:1" as NodeRef,
          nodeKind: "event",
          viewType: "primary",
          modelId: "text-embedding-3-small",
          embedding: new Float32Array([1, 2, 3]),
        },
        {
          nodeRef: "event:2" as NodeRef,
          nodeKind: "event",
          viewType: "primary",
          modelId: "text-embedding-3-small",
          embedding: new Float32Array([4, 5, 6]),
        },
        {
          nodeRef: "entity:1" as NodeRef,
          nodeKind: "entity",
          viewType: "primary",
          modelId: "text-embedding-3-large",
          embedding: new Float32Array([1, 2, 3, 4, 5]),
        },
      ]);

      const stats = storage.getEmbeddingStatsByModel();
      expect(stats).toHaveLength(2);

      const small = stats.find((s) => s.model_id === "text-embedding-3-small");
      const large = stats.find((s) => s.model_id === "text-embedding-3-large");

      expect(small).toBeDefined();
      expect(small!.count).toBe(2);
      expect(small!.dimension).toBe(3);

      expect(large).toBeDefined();
      expect(large!.count).toBe(1);
      expect(large!.dimension).toBe(5);
    });

    it("returns empty array when no embeddings exist", () => {
      const stats = storage.getEmbeddingStatsByModel();
      expect(stats).toEqual([]);
    });
  });
});
