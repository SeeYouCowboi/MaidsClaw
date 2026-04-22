import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { EntityJudgeSweeper } from "../../src/memory/entity-judge-sweeper.js";
import { PgAliasRepo } from "../../src/storage/domain-repos/pg/alias-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

async function bootstrapAllSchemas(sql: postgres.Sql): Promise<void> {
  await bootstrapTruthSchema(sql);
  await bootstrapOpsSchema(sql);
  await bootstrapDerivedSchema(sql);
}

describe.skipIf(skipPgTests)("EntityJudgeSweeper (PG)", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("creates a runtime entity from settlement entityMentions and preserves the surface name", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);

      const now = Date.now();
      await sql`
        INSERT INTO interaction_records (
          session_id,
          record_id,
          record_index,
          actor_type,
          record_type,
          payload,
          correlated_turn_id,
          committed_at,
          is_processed
        ) VALUES (
          ${"session-1"},
          ${"settlement-1"},
          ${2},
          ${"rp_agent"},
          ${"turn_settlement"},
          ${JSON.stringify({
            settlementId: "settlement-1",
            requestId: "request-1",
            sessionId: "session-1",
            ownerAgentId: "agent-1",
            publicReply: "Alice刚才来过。",
            hasPublicReply: true,
            viewerSnapshot: {
              selfPointerKey: "mei",
              userPointerKey: "user",
            },
            entityMentions: ["Alice"],
          })}::jsonb,
          ${"request-1"},
          ${now},
          ${0}
        )
      `;

      const sweeper = new EntityJudgeSweeper(
        {
          getPool() {
            return sql;
          },
        },
        {
          defaultEmbeddingModelId: "test-embedding",
          async chat() {
            return [];
          },
          async embed() {
            return [];
          },
        },
        new PgAliasRepo(sql),
      );

      const report = await sweeper.runSweep({
        agentId: "agent-1",
        sessionId: "session-1",
        dryRun: false,
      });

      expect(report.created).toBe(1);
      expect(report.decisions[0]?.pointer_key).toBe("alice");

      const entityRows = await sql<{
        pointer_key: string;
        display_name: string;
        owner_agent_id: string | null;
      }[]>`
        SELECT pointer_key, display_name, owner_agent_id
        FROM entity_nodes
        WHERE pointer_key = ${"alice"}
      `;
      expect(entityRows).toHaveLength(1);
      expect(entityRows[0]).toMatchObject({
        pointer_key: "alice",
        display_name: "Alice",
        owner_agent_id: "agent-1",
      });

      const aliasRows = await sql<{ alias: string; owner_agent_id: string | null }[]>`
        SELECT alias, owner_agent_id
        FROM entity_aliases
        WHERE alias = ${"Alice"}
      `;
      expect(aliasRows).toEqual([
        { alias: "Alice", owner_agent_id: "agent-1" },
      ]);
    });
  });
});
