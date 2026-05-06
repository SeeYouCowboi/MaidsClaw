import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";

import { PgUnifiedEdgeReadRepo } from "../../src/storage/domain-repos/pg/unified-edge-read-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

const PG_MAX_BIGINT = "9223372036854775807";

if (skipPgTests) {
  describe("graph retrieval hidden bridge privacy (PG)", () => {
    it.skip("skips without PG_TEST_URL/JOBS_PG_URL/PG_APP_URL/PG_APP_TEST_URL", () => {});
  });
} else {
  describe("graph retrieval hidden bridge privacy (PG)", () => {
    let pool: postgres.Sql;

    beforeAll(async () => {
      await ensureTestPgAppDb();
      pool = createTestPgAppPool();
    });

    afterAll(async () => {
      await teardownAppPool(pool);
    });

    it("does not let a hidden private bridge influence visible edge ranking", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapTruthSchema(sql);
        await bootstrapDerivedSchema(sql, { skipVector: true });
        const repo = new PgUnifiedEdgeReadRepo(sql);
        const now = Date.now();

        await sql`
          INSERT INTO entity_nodes
            (id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
          VALUES
            (810, 'public:left', 'Visible Left', 'thing', 'shared_public', NULL, ${now}, ${now}),
            (811, 'public:right', 'Visible Right', 'thing', 'shared_public', NULL, ${now}, ${now}),
            (812, 'private:bridge', 'Hidden Private Bridge', 'thing', 'private_overlay', 'agent-secret', ${now}, ${now})
        `;

        await sql.unsafe(`
          INSERT INTO fact_edges
            (source_entity_id, target_entity_id, predicate, fact_text, owner_agent_id, source_kind, source_ref, t_valid, t_invalid, t_created, t_expired, source_event_id)
          VALUES
            (810, 812, 'private_bridge', 'left touches hidden bridge', 'agent-secret', 'settlement', 'privacy:0', 1, ${PG_MAX_BIGINT}, 1, ${PG_MAX_BIGINT}, NULL),
            (812, 811, 'private_bridge', 'hidden bridge touches right', 'agent-secret', 'settlement', 'privacy:1', 2, ${PG_MAX_BIGINT}, 2, ${PG_MAX_BIGINT}, NULL)
        `);

        const visibleEdges = await repo.edgesAround("entity:810", {
          viewerAgentId: "agent-a",
          limit: 10,
        });
        expect(visibleEdges.map((edge) => edge.targetRef)).not.toContain("entity:812");
        expect(visibleEdges.map((edge) => edge.targetRef)).not.toContain("entity:811");

        const activeBridgeRows = await sql`
          SELECT source_entity_id, target_entity_id
          FROM graph_retrieval_edges
          WHERE active = TRUE
            AND source_ref = 'entity:810'
            AND target_ref = 'entity:811'
        `;
        expect(activeBridgeRows).toHaveLength(0);
      });
    });
  });
}
