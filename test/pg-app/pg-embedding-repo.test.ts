import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import type { NodeRef } from "../../src/memory/types.js";
import { PgEmbeddingRepo } from "../../src/storage/domain-repos/pg/embedding-repo.js";
import { PgNodeScoreRepo } from "../../src/storage/domain-repos/pg/node-score-repo.js";
import { PgSemanticEdgeRepo } from "../../src/storage/domain-repos/pg/semantic-edge-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)(
  "PgEmbeddingRepo + PgSemanticEdgeRepo + PgNodeScoreRepo",
  () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
      await ensureTestPgAppDb();
      sql = createTestPgAppPool();
    });

    afterAll(async () => {
      await teardownAppPool(sql);
    });

    it("round-trips Float32Array through pgvector", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapDerivedSchema(pool, { embeddingDim: 3 });
        const repo = new PgEmbeddingRepo(pool);

        const vector = new Float32Array([0.125, -0.5, 0.875]);
        const nodeRef = "event:1" as NodeRef;
        await repo.upsert(nodeRef, "event", "primary", "model-A", vector);

        const rows = await repo.getByNodeRef(nodeRef, "model-A");
        expect(rows.length).toBe(1);
        expect(rows[0].embedding.length).toBe(3);
        expect(rows[0].embedding[0]).toBeCloseTo(0.125, 6);
        expect(rows[0].embedding[1]).toBeCloseTo(-0.5, 6);
        expect(rows[0].embedding[2]).toBeCloseTo(0.875, 6);
      });
    });

    it("cosine search returns nearest vector first and enforces model epoch", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapDerivedSchema(pool, { embeddingDim: 3 });
        const repo = new PgEmbeddingRepo(pool);

        await repo.upsert(("event:10" as NodeRef), "event", "primary", "model-A", new Float32Array([1, 0, 0]));
        await repo.upsert(("event:11" as NodeRef), "event", "primary", "model-A", new Float32Array([0.9, 0.1, 0]));
        await repo.upsert("event:12" as NodeRef, "event", "primary", "model-B", new Float32Array([1, 0, 0]));

        const result = await repo.cosineSearch(new Float32Array([1, 0, 0]), {
          agentId: null,
          modelId: "model-A",
          limit: 5,
        });

        expect(result.length).toBe(2);
        const first = result[0];
        const second = result[1];
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        if (!first || !second) {
          throw new Error("expected two cosine search results");
        }

        expect(first.nodeRef).toBe("event:10" as NodeRef);
        expect(second.nodeRef).toBe("event:11" as NodeRef);
        expect(first.similarity).toBeGreaterThanOrEqual(second.similarity);
        expect(result.some((row) => row.nodeRef === ("event:12" as NodeRef))).toBe(false);
      });
    });

    it("deleteByModel removes only target model embeddings", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapDerivedSchema(pool, { embeddingDim: 3 });
        const repo = new PgEmbeddingRepo(pool);

        await repo.upsert("event:20" as NodeRef, "event", "primary", "model-A", new Float32Array([0.1, 0.2, 0.3]));
        await repo.upsert("event:21" as NodeRef, "event", "primary", "model-B", new Float32Array([0.3, 0.2, 0.1]));

        const deleted = await repo.deleteByModel("model-A");
        expect(deleted).toBe(1);
        expect((await repo.getByNodeRef("event:20" as NodeRef, "model-A")).length).toBe(0);
        expect((await repo.getByNodeRef("event:21" as NodeRef, "model-B")).length).toBe(1);
      });
    });

    it("semantic edge upsert/query/delete works", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapDerivedSchema(pool);
        const repo = new PgSemanticEdgeRepo(pool);

        const source = "event:101" as NodeRef;
        const target = "event:102" as NodeRef;

        await repo.upsert(source, target, "semantic_similar", 0.42);
        await repo.upsert(source, target, "semantic_similar", 0.88);

        const bySource = await repo.queryBySource(source);
        expect(bySource.length).toBe(1);
        const sourceRow = bySource[0];
        expect(sourceRow).toBeDefined();
        if (!sourceRow) {
          throw new Error("expected source semantic edge result");
        }
        expect(sourceRow.weight).toBeCloseTo(0.88, 6);

        const byTarget = await repo.queryByTarget(target, "semantic_similar");
        expect(byTarget.length).toBe(1);
        const targetRow = byTarget[0];
        expect(targetRow).toBeDefined();
        if (!targetRow) {
          throw new Error("expected target semantic edge result");
        }
        expect(targetRow.sourceRef).toBe(source);

        const deleted = await repo.deleteForNodes([source]);
        expect(deleted).toBe(1);
        expect((await repo.queryBySource(source)).length).toBe(0);
      });
    });

    it("node score upsert/query/top/delete works", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapDerivedSchema(pool);
        const repo = new PgNodeScoreRepo(pool);

        const nodeA = "event:201" as NodeRef;
        const nodeB = "event:202" as NodeRef;

        await repo.upsert(nodeA, 0.3, 0.4, 0.5);
        await repo.upsert(nodeB, 0.9, 0.1, 0.2);
        await repo.upsert(nodeA, 0.7, 0.8, 0.6);

        const rowA = await repo.getByNodeRef(nodeA);
        expect(rowA).not.toBeNull();
        if (!rowA) {
          throw new Error("expected node score row");
        }
        expect(rowA.salience).toBeCloseTo(0.7, 6);
        expect(rowA.centrality).toBeCloseTo(0.8, 6);

        const top = await repo.getTopByField("salience", 2);
        expect(top.length).toBe(2);
        const top1 = top[0];
        const top2 = top[1];
        expect(top1).toBeDefined();
        expect(top2).toBeDefined();
        if (!top1 || !top2) {
          throw new Error("expected two top score rows");
        }
        expect(top1.nodeRef).toBe(nodeB);
        expect(top2.nodeRef).toBe(nodeA);

        const deleted = await repo.deleteForNodes([nodeB]);
        expect(deleted).toBe(1);
        expect(await repo.getByNodeRef(nodeB)).toBeNull();
      });
    });
  },
);
