import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";

import { buildGraphRetrievalEdges } from "../../src/memory/graph-edge-builder.js";
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

const PG_MAX_BIGINT = "9223372036854775807";

if (computeSkipPgTests()) {
  describe("graph edge builder (PG)", () => {
    it.skip("skips without PG_TEST_URL/JOBS_PG_URL/PG_APP_URL/PG_APP_TEST_URL", () => {});
  });
} else {
  describe("graph edge builder (PG)", () => {
    let pool: postgres.Sql;

    beforeAll(async () => {
      await ensureTestPgAppDb();
      pool = createTestPgAppPool();
    });

    afterAll(async () => {
      await teardownAppPool(pool);
    });

    it("creates Alice and 花房 co-occurrence edges from seeded episodes", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapTruthSchema(sql);
        await bootstrapDerivedSchema(sql, { skipVector: true });
        await seedEntities(sql);
        await seedEpisode(sql, {
          id: 1,
          summary: "Alice stood in the flower garden.",
          entityPointerKeys: ["char:alice", "loc:花房"],
          createdAt: 1_700_000_000_001,
        });

        const result = await buildGraphRetrievalEdges({
          sql,
          agentId: "agent-a",
          runId: "pg-flower-run",
        });
        const repo = new PgGraphRetrievalEdgeRepo(sql);
        const active = await repo.loadActiveEdges({ ownerAgentId: "agent-a" });

        expect(result.cooccurrenceEdges).toBe(2);
        expect(active).toContainEqual(
          expect.objectContaining({
            edgeKind: "cooccurrence_associative",
            sourceRef: "loc:花房",
            targetRef: "char:alice",
            sourcePassageRefs: ["ep:1"],
            visibilityScope: "private_overlay",
            ownerAgentId: "agent-a",
          }),
        );
      });
    });

    it("keeps gold and silver watches separate without same_as merging", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapTruthSchema(sql);
        await bootstrapDerivedSchema(sql, { skipVector: true });
        await seedEntities(sql);
        await seedEpisode(sql, {
          id: 2,
          summary: "The gold watch contrasted with the silver watch.",
          entityPointerKeys: ["item:金怀表", "item:银怀表"],
          createdAt: 1_700_000_000_010,
        });
        await sql.unsafe(`
          INSERT INTO fact_edges
            (source_entity_id, target_entity_id, predicate, fact_text, owner_agent_id, source_kind, source_ref, t_valid, t_invalid, t_created, t_expired, source_event_id)
          VALUES
            (102, 103, 'contrasts_with', 'gold and silver watch are distinct', 'agent-a', 'settlement', 'watch:contrast', 1, ${PG_MAX_BIGINT}, 1, ${PG_MAX_BIGINT}, NULL),
            (102, 103, 'same_as', 'legacy hypothesis remains only a fact edge', 'agent-a', 'settlement', 'watch:same-as', 2, ${PG_MAX_BIGINT}, 2, ${PG_MAX_BIGINT}, NULL)
        `);

        await buildGraphRetrievalEdges({
          sql,
          agentId: "agent-a",
          runId: "pg-watch-run",
        });
        const repo = new PgGraphRetrievalEdgeRepo(sql);
        const active = await repo.loadActiveEdges({ ownerAgentId: "agent-a" });
        const entityRows = await sql`
          SELECT pointer_key, canonical_entity_id
          FROM entity_nodes
          WHERE pointer_key IN ('item:金怀表', 'item:银怀表')
          ORDER BY pointer_key ASC
        `;
        const aliasRows = await sql`
          SELECT alias
          FROM entity_aliases
          WHERE alias IN ('item:金怀表', 'item:银怀表')
        `;

        expect(entityRows).toHaveLength(2);
        expect(entityRows.map((row) => row.pointer_key)).toEqual(["item:金怀表", "item:银怀表"]);
        expect(entityRows.every((row) => row.canonical_entity_id == null)).toBe(true);
        expect(aliasRows).toHaveLength(0);
        expect(active).toContainEqual(
          expect.objectContaining({
            edgeKind: "cooccurrence_contrastive",
            sourceRef: "item:金怀表",
            targetRef: "item:银怀表",
          }),
        );
        expect(active).toContainEqual(
          expect.objectContaining({
            edgeKind: "fact_relation",
            sourceRef: "item:金怀表",
            targetRef: "item:银怀表",
            sourceFactEdgeIds: [expect.any(Number)],
          }),
        );
      });
    });
  });
}

async function seedEntities(sql: postgres.Sql): Promise<void> {
  const now = Date.now();
  await sql`
    INSERT INTO entity_nodes
      (id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
    VALUES
      (100, 'char:alice', 'Alice', 'character', 'private_overlay', 'agent-a', ${now}, ${now}),
      (101, 'loc:花房', '花房', 'location', 'private_overlay', 'agent-a', ${now}, ${now}),
      (102, 'item:金怀表', '金怀表', 'item', 'private_overlay', 'agent-a', ${now}, ${now}),
      (103, 'item:银怀表', '银怀表', 'item', 'private_overlay', 'agent-a', ${now}, ${now})
  `;
}

async function seedEpisode(
  sql: postgres.Sql,
  params: {
    id: number;
    summary: string;
    entityPointerKeys: string[];
    createdAt: number;
  },
): Promise<void> {
  await sql`
    INSERT INTO private_episode_events
      (id, agent_id, session_id, settlement_id, category, summary, committed_time, created_at, entity_pointer_keys, actor)
    VALUES
      (${params.id}, 'agent-a', 'session-a', ${`settlement-${params.id}`}, 'observation', ${params.summary}, ${params.createdAt}, ${params.createdAt}, ${params.entityPointerKeys}, 'agent')
  `;
}
