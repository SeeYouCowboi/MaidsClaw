import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";

import type { GraphRetrievalEdgeInsert } from "../../src/storage/domain-repos/contracts/graph-retrieval-edge-repo.js";
import { PgGraphRetrievalEdgeRepo } from "../../src/storage/domain-repos/pg/graph-retrieval-edge-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { computeSkipPgTests, skipPgTests } from "../helpers/pg-test-utils.js";

function makeEdge(overrides: Partial<GraphRetrievalEdgeInsert> = {}): GraphRetrievalEdgeInsert {
  return {
    runId: "run-a",
    algorithmVersion: "v1",
    edgeKind: "mention_episode_entity",
    sourceRef: "episode:1",
    sourceKind: "episode",
    targetRef: "entity:101",
    targetKind: "entity",
    weight: 1,
    visibilityScope: "private_overlay",
    ownerAgentId: "agent-a",
    firstSeenAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    sourcePassageRefs: ["episode:1#p0"],
    sourceFactEdgeIds: [],
    sourceSemanticEdgeRefs: [],
    sourceHash: "run-a:episode:1:entity:101",
    ...overrides,
  };
}

if (computeSkipPgTests()) {
  describe("graph retrieval edge repo (PG)", () => {
    it.skip("skips without PG_TEST_URL/JOBS_PG_URL/PG_APP_URL/PG_APP_TEST_URL", () => {});
  });
} else {
  describe("graph retrieval edge repo (PG)", () => {
    let pool: postgres.Sql;

    beforeAll(async () => {
      await ensureTestPgAppDb();
      pool = createTestPgAppPool();
    });

    afterAll(async () => {
      await teardownAppPool(pool);
    });

    it("inserting edges and activating a run makes them visible", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapDerivedSchema(sql, { skipVector: true });
        const repo = new PgGraphRetrievalEdgeRepo(sql);

        await repo.insertBatch([
          makeEdge({
            sourceFactEdgeIds: [11, 12],
            sourceSemanticEdgeRefs: ["semantic:episode:1:entity:101"],
          }),
        ]);
        expect(await repo.loadActiveEdges({ ownerAgentId: "agent-a" })).toHaveLength(0);

        await repo.activateRun("run-a");
        const active = await repo.loadActiveEdges({ ownerAgentId: "agent-a" });

        expect(active).toHaveLength(1);
        expect(active[0]).toMatchObject({
          runId: "run-a",
          edgeKind: "mention_episode_entity",
          sourceRef: "episode:1",
          targetRef: "entity:101",
          active: true,
        });
        expect(active[0].sourcePassageRefs).toEqual(["episode:1#p0"]);
        expect(active[0].sourceFactEdgeIds).toEqual([11, 12]);
        expect(active[0].sourceSemanticEdgeRefs).toEqual(["semantic:episode:1:entity:101"]);
      });
    });

    it("keeps identical rebuild inputs idempotent across active swaps", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapDerivedSchema(sql, { skipVector: true });
        const repo = new PgGraphRetrievalEdgeRepo(sql);
        const edgeA = makeEdge({
          runId: "rebuild-1",
          sourceHash: "mention:episode:1:entity:101",
        });
        const edgeB = makeEdge({
          ...edgeA,
          runId: "rebuild-2",
        });

        await repo.insertBatch([edgeA, edgeA]);
        await repo.atomicSwapRun("rebuild-1");
        const firstActiveSet = await repo.loadActiveEdges({ ownerAgentId: "agent-a" });

        await repo.insertBatch([edgeB, edgeB]);
        await repo.atomicSwapRun("rebuild-2");
        const secondActiveSet = await repo.loadActiveEdges({ ownerAgentId: "agent-a" });
        const duplicateRows = await sql`
          SELECT source_ref, target_ref, edge_kind, owner_agent_id, COUNT(*) AS cnt
          FROM graph_retrieval_edges
          WHERE active = TRUE
          GROUP BY source_ref, target_ref, edge_kind, owner_agent_id
          HAVING COUNT(*) > 1
        `;

        expect(firstActiveSet.map(({ id: _id, runId: _runId, createdAt: _createdAt, ...edge }) => edge)).toEqual(
          secondActiveSet.map(({ id: _id, runId: _runId, createdAt: _createdAt, ...edge }) => edge),
        );
        expect(secondActiveSet).toHaveLength(1);
        expect(duplicateRows).toHaveLength(0);
      });
    });

    it("does not return edges for a non-active partial run", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapDerivedSchema(sql, { skipVector: true });
        const repo = new PgGraphRetrievalEdgeRepo(sql);

        await repo.insertBatch([
          makeEdge({ runId: "partial-run", sourceHash: "partial:episode:1:entity:101" }),
        ]);

        expect(await repo.loadActiveEdges({ ownerAgentId: "agent-a" })).toHaveLength(0);
        expect(await repo.countActiveEdgesByKind()).toEqual({});
      });
    });

    it("atomicSwapRun deactivates old runs and activates the new run", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapDerivedSchema(sql, { skipVector: true });
        const repo = new PgGraphRetrievalEdgeRepo(sql);

        await repo.insertBatch([
          makeEdge({ runId: "old-run", sourceHash: "old:episode:1:entity:101" }),
          makeEdge({
            runId: "new-run",
            sourceRef: "episode:2",
            targetRef: "entity:202",
            sourceHash: "new:episode:2:entity:202",
            lastSeenAt: 1_700_000_000_100,
          }),
        ]);
        await repo.activateRun("old-run");

        await repo.atomicSwapRun("new-run");

        const active = await repo.loadActiveEdges({ ownerAgentId: "agent-a" });
        const runRows = await sql`
          SELECT run_id, active
          FROM graph_retrieval_edges
          ORDER BY run_id ASC
        `;

        expect(active.map((edge) => edge.runId)).toEqual(["new-run"]);
        expect(runRows).toEqual([
          { run_id: "new-run", active: true },
          { run_id: "old-run", active: false },
        ]);
      });
    });
  });
}

expect(skipPgTests).toBe(computeSkipPgTests());
