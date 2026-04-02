import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import type { NodeRef } from "../../src/memory/types.js";
import { PgEmbeddingRebuilder } from "../../src/memory/embedding-rebuild-pg.js";
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

describe.skipIf(skipPgTests)("PgEmbeddingRebuilder", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  const DIM = 3;

  function vec(...values: number[]): Float32Array {
    return new Float32Array(values);
  }

  it("rebuildEmbeddings inserts vectors for a model", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql, { embeddingDim: DIM });
      const rebuilder = new PgEmbeddingRebuilder(sql);
      const embRepo = new PgEmbeddingRepo(sql);

      const result = await rebuilder.rebuildEmbeddings("model-A", [
        { nodeRef: "event:1" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(1, 0, 0) },
        { nodeRef: "event:2" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(0, 1, 0) },
      ]);

      expect(result.inserted).toBe(2);

      const rows1 = await embRepo.getByNodeRef("event:1" as NodeRef, "model-A");
      expect(rows1.length).toBe(1);
      expect(rows1[0].embedding[0]).toBeCloseTo(1, 6);

      const rows2 = await embRepo.getByNodeRef("event:2" as NodeRef, "model-A");
      expect(rows2.length).toBe(1);
      expect(rows2[0].embedding[1]).toBeCloseTo(1, 6);
    });
  });

  it("rebuildEmbeddings preserves other model's embeddings (model epoch isolation)", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql, { embeddingDim: DIM });
      const rebuilder = new PgEmbeddingRebuilder(sql);
      const embRepo = new PgEmbeddingRepo(sql);

      await rebuilder.rebuildEmbeddings("model-A", [
        { nodeRef: "event:1" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(1, 0, 0) },
      ]);

      await rebuilder.rebuildEmbeddings("model-B", [
        { nodeRef: "event:2" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(0, 1, 0) },
      ]);

      const modelARows = await embRepo.getByNodeRef("event:1" as NodeRef, "model-A");
      expect(modelARows.length).toBe(1);
      expect(modelARows[0].embedding[0]).toBeCloseTo(1, 6);

      const modelBRows = await embRepo.getByNodeRef("event:2" as NodeRef, "model-B");
      expect(modelBRows.length).toBe(1);
      expect(modelBRows[0].embedding[1]).toBeCloseTo(1, 6);
    });
  });

  it("rebuildEmbeddings with clearFirst clears old model embeddings before inserting", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql, { embeddingDim: DIM });
      const rebuilder = new PgEmbeddingRebuilder(sql);
      const embRepo = new PgEmbeddingRepo(sql);

      await rebuilder.rebuildEmbeddings("model-A", [
        { nodeRef: "event:1" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(1, 0, 0) },
        { nodeRef: "event:2" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(0, 1, 0) },
      ]);

      const result = await rebuilder.rebuildEmbeddings("model-A", [
        { nodeRef: "event:3" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(0, 0, 1) },
      ]);

      expect(result.inserted).toBe(1);

      expect((await embRepo.getByNodeRef("event:1" as NodeRef, "model-A")).length).toBe(0);
      expect((await embRepo.getByNodeRef("event:2" as NodeRef, "model-A")).length).toBe(0);

      const rows3 = await embRepo.getByNodeRef("event:3" as NodeRef, "model-A");
      expect(rows3.length).toBe(1);
    });
  });

  it("rebuildSemanticEdges builds edges above similarity threshold", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql, { embeddingDim: DIM });
      const rebuilder = new PgEmbeddingRebuilder(sql);
      const edgeRepo = new PgSemanticEdgeRepo(sql);

      await rebuilder.rebuildEmbeddings("model-A", [
        { nodeRef: "event:1" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(1, 0, 0) },
        { nodeRef: "event:2" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(0.95, 0.1, 0) },
        { nodeRef: "event:3" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(0, 1, 0) },
      ]);

      const result = await rebuilder.rebuildSemanticEdges("model-A", { similarityThreshold: 0.8 });

      expect(result.inserted).toBeGreaterThanOrEqual(1);

      const edgesFrom1 = await edgeRepo.queryBySource("event:1" as NodeRef, "semantic_similar");
      const highSimEdge = edgesFrom1.find((e) => e.targetRef === ("event:2" as NodeRef));
      expect(highSimEdge).toBeDefined();
      if (highSimEdge) {
        expect(highSimEdge.weight).toBeGreaterThan(0.8);
      }

      const edgesFrom3 = await edgeRepo.queryBySource("event:3" as NodeRef, "semantic_similar");
      const edgesTo3 = await edgeRepo.queryByTarget("event:3" as NodeRef, "semantic_similar");
      const noHighSimTo1 = [...edgesFrom3, ...edgesTo3].every(
        (e) => !(
          (e.sourceRef === ("event:1" as NodeRef) && e.targetRef === ("event:3" as NodeRef)) ||
          (e.sourceRef === ("event:3" as NodeRef) && e.targetRef === ("event:1" as NodeRef))
        ) || false,
      );
      expect(noHighSimTo1).toBe(true);
    });
  });

  it("rebuildSemanticEdges with empty embeddings returns zero", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql, { embeddingDim: DIM });
      const rebuilder = new PgEmbeddingRebuilder(sql);

      const result = await rebuilder.rebuildSemanticEdges("model-nonexistent");
      expect(result.inserted).toBe(0);
    });
  });

  it("rebuildNodeScores upserts scores correctly", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql, { embeddingDim: DIM });
      const rebuilder = new PgEmbeddingRebuilder(sql);
      const scoreRepo = new PgNodeScoreRepo(sql);

      const result = await rebuilder.rebuildNodeScores([
        { nodeRef: "event:1" as NodeRef, salience: 0.9, centrality: 0.5, bridge: 0.3 },
        { nodeRef: "event:2" as NodeRef, salience: 0.4, centrality: 0.8, bridge: 0.7 },
      ]);

      expect(result.updated).toBe(2);

      const score1 = await scoreRepo.getByNodeRef("event:1" as NodeRef);
      expect(score1).not.toBeNull();
      if (score1) {
        expect(score1.salience).toBeCloseTo(0.9, 6);
        expect(score1.centrality).toBeCloseTo(0.5, 6);
        expect(score1.bridgeScore).toBeCloseTo(0.3, 6);
      }

      const score2 = await scoreRepo.getByNodeRef("event:2" as NodeRef);
      expect(score2).not.toBeNull();
      if (score2) {
        expect(score2.salience).toBeCloseTo(0.4, 6);
        expect(score2.centrality).toBeCloseTo(0.8, 6);
        expect(score2.bridgeScore).toBeCloseTo(0.7, 6);
      }
    });
  });

  it("rebuildNodeScores overwrites existing scores", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql, { embeddingDim: DIM });
      const rebuilder = new PgEmbeddingRebuilder(sql);
      const scoreRepo = new PgNodeScoreRepo(sql);

      await rebuilder.rebuildNodeScores([
        { nodeRef: "event:1" as NodeRef, salience: 0.1, centrality: 0.2, bridge: 0.3 },
      ]);

      await rebuilder.rebuildNodeScores([
        { nodeRef: "event:1" as NodeRef, salience: 0.9, centrality: 0.8, bridge: 0.7 },
      ]);

      const score = await scoreRepo.getByNodeRef("event:1" as NodeRef);
      expect(score).not.toBeNull();
      if (score) {
        expect(score.salience).toBeCloseTo(0.9, 6);
        expect(score.centrality).toBeCloseTo(0.8, 6);
        expect(score.bridgeScore).toBeCloseTo(0.7, 6);
      }
    });
  });

  it("rebuildAll clears old embeddings, inserts new ones, and builds edges", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql, { embeddingDim: DIM });
      const rebuilder = new PgEmbeddingRebuilder(sql);
      const embRepo = new PgEmbeddingRepo(sql);

      await rebuilder.rebuildEmbeddings("model-A", [
        { nodeRef: "event:1" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(1, 0, 0) },
      ]);

      const result = await rebuilder.rebuildAll("model-A", [
        { nodeRef: "event:10" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(1, 0, 0) },
        { nodeRef: "event:11" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(0.99, 0.05, 0) },
      ], { similarityThreshold: 0.9 });

      expect(result.embeddings).toBe(2);
      expect(result.edges).toBeGreaterThanOrEqual(1);

      expect((await embRepo.getByNodeRef("event:1" as NodeRef, "model-A")).length).toBe(0);
      expect((await embRepo.getByNodeRef("event:10" as NodeRef, "model-A")).length).toBe(1);
      expect((await embRepo.getByNodeRef("event:11" as NodeRef, "model-A")).length).toBe(1);
    });
  });

  it("rebuildAll does not affect other models (cross-model isolation)", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql, { embeddingDim: DIM });
      const rebuilder = new PgEmbeddingRebuilder(sql);
      const embRepo = new PgEmbeddingRepo(sql);

      await rebuilder.rebuildEmbeddings("model-B", [
        { nodeRef: "event:100" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(0, 0, 1) },
      ]);

      await rebuilder.rebuildAll("model-A", [
        { nodeRef: "event:200" as NodeRef, nodeKind: "event", viewType: "primary", vector: vec(1, 0, 0) },
      ]);

      const modelBRows = await embRepo.getByNodeRef("event:100" as NodeRef, "model-B");
      expect(modelBRows.length).toBe(1);
      expect(modelBRows[0].embedding[2]).toBeCloseTo(1, 6);
    });
  });
});
