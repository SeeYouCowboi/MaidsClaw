import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";

import { loadVisibilityFilteredGraph } from "../../src/memory/retrieval/graph-loader.js";
import type { GraphSeedHint } from "../../src/memory/retrieval/graph-loader.js";
import {
  DEFAULT_GRAPH_RETRIEVAL_CONFIG,
  type GraphRetrievalConfig,
} from "../../src/memory/retrieval/graph-retrieval-config.js";
import { resolveGraphSeeds } from "../../src/memory/retrieval/graph-seed-resolver.js";
import type { GraphRetrievalEdgeInsert } from "../../src/storage/domain-repos/contracts/graph-retrieval-edge-repo.js";
import { PgGraphRetrievalEdgeRepo } from "../../src/storage/domain-repos/pg/graph-retrieval-edge-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { computeSkipPgTests } from "../helpers/pg-test-utils.js";

const BASE_TIME = 1_700_000_000_000;

function config(overrides: Partial<GraphRetrievalConfig> = {}): GraphRetrievalConfig {
  return {
    ...DEFAULT_GRAPH_RETRIEVAL_CONFIG,
    ...overrides,
    ppr: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.ppr, ...overrides.ppr },
    seed: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.seed, ...overrides.seed },
    recency: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.recency, ...overrides.recency },
  };
}

function edge(overrides: Partial<GraphRetrievalEdgeInsert> = {}): GraphRetrievalEdgeInsert {
  const sourceRef = overrides.sourceRef ?? "char:alice";
  const targetRef = overrides.targetRef ?? "loc:花房";
  const edgeKind = overrides.edgeKind ?? "cooccurrence_associative";
  return {
    runId: "run-loader",
    algorithmVersion: "v1",
    edgeKind,
    sourceRef,
    sourceKind: "entity",
    targetRef,
    targetKind: "entity",
    weight: 1,
    visibilityScope: "shared_public",
    ownerAgentId: null,
    firstSeenAt: BASE_TIME,
    lastSeenAt: BASE_TIME,
    sourcePassageRefs: [],
    sourceFactEdgeIds: [],
    sourceSemanticEdgeRefs: [],
    sourceHash: `${overrides.runId ?? "run-loader"}:${edgeKind}:${sourceRef}:${targetRef}:${Math.random()}`,
    ...overrides,
  };
}

async function bootstrapGraphSchema(sql: postgres.Sql, opts: { vector?: boolean } = {}): Promise<void> {
  await bootstrapTruthSchema(sql);
  await bootstrapDerivedSchema(sql, { skipVector: opts.vector !== true, embeddingDim: 3 });
}

async function seedEntity(
  sql: postgres.Sql,
  pointerKey: string,
  overrides: { scope?: string; owner?: string | null; displayName?: string } = {},
): Promise<number> {
  const rows = await sql<Array<{ id: number | string }>>`
    INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
    VALUES (
      ${pointerKey},
      ${overrides.displayName ?? pointerKey},
      'thing',
      ${overrides.scope ?? "shared_public"},
      ${overrides.owner ?? null},
      ${BASE_TIME},
      ${BASE_TIME}
    )
    RETURNING id
  `;
  return Number(rows[0].id);
}

async function seedGraph(
  sql: postgres.Sql,
  edges: GraphRetrievalEdgeInsert[],
): Promise<void> {
  const repo = new PgGraphRetrievalEdgeRepo(sql);
  await repo.insertBatch(edges);
  await repo.atomicSwapRun(edges[0]?.runId ?? "run-loader");
}

async function load(sql: postgres.Sql, seedHints: GraphSeedHint[], overrides: Partial<GraphRetrievalConfig> = {}) {
  return loadVisibilityFilteredGraph({
    sql,
    viewerAgentId: "agent-a",
    queryTime: BASE_TIME,
    config: config(overrides),
    seedHints,
    sessionId: "sess-1",
  });
}

if (computeSkipPgTests()) {
  describe("graph loader (PG)", () => {
    it.skip("skips without PG_TEST_URL/JOBS_PG_URL/PG_APP_URL/PG_APP_TEST_URL", () => {});
  });
} else {
  describe("graph loader", () => {
    let pool: postgres.Sql;

    beforeAll(async () => {
      await ensureTestPgAppDb();
      pool = createTestPgAppPool();
    });

    afterAll(async () => {
      await teardownAppPool(pool);
    });

    it("excludes hidden nodes and their edges before traversal", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapGraphSchema(sql);
        await seedEntity(sql, "char:alice");
        await seedEntity(sql, "loc:花房");
        await seedEntity(sql, "secret:bridge", { scope: "private_overlay", owner: "agent-b" });
        await seedGraph(sql, [
          edge({ sourceRef: "char:alice", targetRef: "secret:bridge", visibilityScope: "private_overlay", ownerAgentId: "agent-b" }),
          edge({ sourceRef: "secret:bridge", targetRef: "loc:花房", visibilityScope: "private_overlay", ownerAgentId: "agent-b" }),
          edge({ sourceRef: "char:alice", targetRef: "loc:花房" }),
        ]);

        const result = await load(sql, [{ ref: "char:alice" }]);

        expect(result.nodes.has("secret:bridge")).toBe(false);
        expect(result.adjacency.has("secret:bridge")).toBe(false);
        expect(result.adjacency.get("char:alice")?.has("secret:bridge")).toBe(false);
        expect(result.adjacency.get("char:alice")?.get("loc:花房")).toBe(1);
      });
    });

    it("applies recency decay to edge weights", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapGraphSchema(sql);
        await seedEntity(sql, "char:alice");
        await seedEntity(sql, "loc:花房");
        await seedEntity(sql, "item:watch");
        await seedGraph(sql, [
          edge({ sourceRef: "char:alice", targetRef: "loc:花房", weight: 2, lastSeenAt: BASE_TIME - 1_000, sourcePassageRefs: ["sess-1:turn-1"] }),
          edge({ sourceRef: "char:alice", targetRef: "item:watch", weight: 2, lastSeenAt: BASE_TIME, sourcePassageRefs: ["sess-1:turn-2"] }),
        ]);

        // B3: session-scoped recency is not yet wired (graph_retrieval_edges
        // has no session_id column) so all edges decay at globalHalfLifeMs
        // regardless of recency.scope. This test verifies decay still
        // applies and is monotone — it does not assert session-vs-global
        // discrimination because that would require schema migration.
        const result = await load(sql, [{ ref: "char:alice" }], {
          recency: { scope: "global", sessionHalfLifeMs: 1_000, globalHalfLifeMs: 10_000 },
        });
        const decayed = 2 * Math.exp(-1_000 / 10_000);
        const fresh = 2;

        expect(result.adjacency.get("char:alice")?.get("loc:花房")).toBeCloseTo(decayed / (decayed + fresh), 9);
        expect(result.adjacency.get("char:alice")?.get("item:watch")).toBeCloseTo(fresh / (decayed + fresh), 9);
      });
    });

    it("row-normalizes outgoing weights", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapGraphSchema(sql);
        await seedEntity(sql, "char:alice");
        await seedEntity(sql, "loc:花房");
        await seedEntity(sql, "item:watch");
        await seedGraph(sql, [
          edge({ sourceRef: "char:alice", targetRef: "loc:花房", weight: 2 }),
          edge({ sourceRef: "char:alice", targetRef: "item:watch", weight: 3 }),
        ]);

        const result = await load(sql, [{ ref: "char:alice" }]);
        const total = [...(result.adjacency.get("char:alice")?.values() ?? [])].reduce((sum, weight) => sum + weight, 0);

        expect(total).toBeCloseTo(1, 9);
        expect(result.adjacency.get("char:alice")?.get("loc:花房")).toBeCloseTo(0.4, 9);
        expect(result.adjacency.get("char:alice")?.get("item:watch")).toBeCloseTo(0.6, 9);
      });
    });

    it("falls back to seed-only graph when node limit is exceeded", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapGraphSchema(sql);
        await seedEntity(sql, "char:alice");
        await seedEntity(sql, "loc:花房");
        await seedGraph(sql, [edge({ sourceRef: "char:alice", targetRef: "loc:花房" })]);

        const result = await load(sql, [{ ref: "char:alice" }], { ppr: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.ppr, maxVisibleNodes: 1 } });

        expect(result.fallbackReason).toBe("node_limit_exceeded");
        expect(result.seedRefs).toEqual(["char:alice"]);
        expect(result.adjacency.size).toBe(0);
      });
    });

    it("truncates highest-weight edges when edge limit is exceeded", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapGraphSchema(sql);
        await seedEntity(sql, "char:alice");
        await seedEntity(sql, "loc:花房");
        await seedEntity(sql, "item:watch");
        await seedGraph(sql, [
          edge({ sourceRef: "char:alice", targetRef: "loc:花房", weight: 10 }),
          edge({ sourceRef: "char:alice", targetRef: "item:watch", weight: 1 }),
        ]);

        const result = await load(sql, [{ ref: "char:alice" }], { ppr: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.ppr, maxVisibleEdges: 1 } });

        expect(result.fallbackReason).toBe("edge_limit_exceeded");
        expect(result.visibleEdgeCount).toBe(1);
        expect(result.adjacency.get("char:alice")?.get("loc:花房")).toBe(1);
        expect(result.adjacency.get("char:alice")?.has("item:watch")).toBe(false);
      });
    });

    it("resolves alias hints to canonical entity refs", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapGraphSchema(sql);
        const canonicalId = await seedEntity(sql, "loc:花房");
        await sql`
          INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id, status, created_at, updated_at)
          VALUES (${canonicalId}, 'flower-garden', 'manual', NULL, 'active', ${BASE_TIME}, ${BASE_TIME})
        `;

        const result = await resolveGraphSeeds({
          sql,
          hints: [{ ref: "flower-garden", kind: "alias" }],
          viewerAgentId: "agent-a",
          config: config(),
        });

        expect(result.resolvedRefs).toEqual(["loc:花房"]);
        expect(result.aliasHits).toBe(1);
      });
    });

    it("reports missing alias hints without failing", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapGraphSchema(sql);

        const result = await resolveGraphSeeds({
          sql,
          hints: [{ ref: "missing-alias", kind: "alias" }],
          viewerAgentId: "agent-a",
          config: config(),
        });

        expect(result.resolvedRefs).toEqual([]);
        expect(result.missingRefs).toEqual(["missing-alias"]);
      });
    });

    it("treats empty node_embeddings as a no-op while preserving alias seeds", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapGraphSchema(sql, { vector: true });
        const canonicalId = await seedEntity(sql, "loc:花房");
        await sql`
          INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id, status, created_at, updated_at)
          VALUES (${canonicalId}, 'flower-garden', 'manual', NULL, 'active', ${BASE_TIME}, ${BASE_TIME})
        `;

        const result = await resolveGraphSeeds({
          sql,
          hints: [{ ref: "flower-garden" }, { ref: "missing-alias" }],
          viewerAgentId: "agent-a",
          config: config(),
        });

        expect(result.resolvedRefs).toEqual(["loc:花房"]);
        expect(result.denseHits).toBe(0);
        expect(result.missingRefs).toEqual(["missing-alias"]);
      });
    });

    it("resolves flower-garden alias and excludes another viewer private bridge", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapGraphSchema(sql);
        const flowerId = await seedEntity(sql, "loc:花房");
        await seedEntity(sql, "char:alice");
        await seedEntity(sql, "secret:bridge", { scope: "private_overlay", owner: "agent-b" });
        await sql`
          INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id, status, created_at, updated_at)
          VALUES (${flowerId}, 'flower-garden', 'manual', NULL, 'active', ${BASE_TIME}, ${BASE_TIME})
        `;
        await seedGraph(sql, [
          edge({ sourceRef: "loc:花房", targetRef: "secret:bridge", visibilityScope: "private_overlay", ownerAgentId: "agent-b" }),
          edge({ sourceRef: "secret:bridge", targetRef: "char:alice", visibilityScope: "private_overlay", ownerAgentId: "agent-b" }),
          edge({ sourceRef: "loc:花房", targetRef: "char:alice" }),
        ]);

        const result = await load(sql, [{ ref: "flower-garden", kind: "alias" }]);

        expect(result.seedRefs).toEqual(["loc:花房"]);
        expect(result.nodes.has("secret:bridge")).toBe(false);
        expect(result.adjacency.get("loc:花房")?.get("char:alice")).toBe(1);
      });
    });
  });
}
