import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { PgSearchRebuilder, type PgSearchRebuildScope } from "../../src/memory/search-rebuild-pg.js";
import { PgSearchProjectionRepo } from "../../src/storage/domain-repos/pg/search-projection-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";

const describeWithSkipIf = describe as typeof describe & {
  skipIf: (condition: boolean) => (name: string, fn: () => void) => void;
};

async function bootstrapAllSchemas(sql: postgres.Sql): Promise<void> {
  await bootstrapTruthSchema(sql);
  await bootstrapOpsSchema(sql);
  await bootstrapDerivedSchema(sql, { embeddingDim: 3 });
}

async function seedTestData(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO entity_nodes
      (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, summary, created_at, updated_at)
    VALUES
      ('alice', 'Alice', 'person', 'private_overlay', 'agent-1', 'A helpful maid', ${Date.now()}, ${Date.now()})
  `;

  await sql`
    INSERT INTO event_nodes
      (session_id, summary, timestamp, created_at, visibility_scope, location_entity_id, event_category, promotion_class, event_origin)
    VALUES
      ('sess-1', 'Area event happened', ${Date.now()}, ${Date.now()}, 'area_visible', 1, 'observation', 'none', 'runtime_projection')
  `;

  await sql`
    INSERT INTO event_nodes
      (session_id, summary, timestamp, created_at, visibility_scope, location_entity_id, event_category, promotion_class, event_origin)
    VALUES
      ('sess-1', 'World event occurred', ${Date.now()}, ${Date.now()}, 'world_public', 1, 'observation', 'none', 'runtime_projection')
  `;

  await sql`
    INSERT INTO entity_nodes
      (pointer_key, display_name, entity_type, memory_scope, summary, created_at, updated_at)
    VALUES
      ('castle', 'Castle', 'location', 'shared_public', 'A grand castle', ${Date.now()}, ${Date.now()})
  `;

  await sql`
    INSERT INTO private_cognition_current
      (agent_id, cognition_key, kind, status, summary_text, record_json, source_event_id, updated_at)
    VALUES
      ('agent-1', 'cog:mood', 'evaluation', 'active', 'Mood is positive', ${'{"notes":"mood"}'}::jsonb, 1, ${Date.now()})
  `;
}

describeWithSkipIf.skipIf(!process.env.PG_APP_TEST_URL)("search-rebuild-pg (script)", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  test("PgSearchRebuilder.rebuild({ scope: 'all' }) populates all search_docs tables", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);
      await seedTestData(sql);

      const rebuilder = new PgSearchRebuilder(sql);
      await rebuilder.rebuild({ agentId: "agent-1", scope: "all" });

      const privateRows = await sql`SELECT COUNT(*)::int as count FROM search_docs_private`;
      const areaRows = await sql`SELECT COUNT(*)::int as count FROM search_docs_area`;
      const worldRows = await sql`SELECT COUNT(*)::int as count FROM search_docs_world`;
      const cognitionRows = await sql`SELECT COUNT(*)::int as count FROM search_docs_cognition`;

      expect(privateRows[0].count).toBeGreaterThan(0);
      expect(areaRows[0].count).toBeGreaterThan(0);
      expect(worldRows[0].count).toBeGreaterThan(0);
      expect(cognitionRows[0].count).toBeGreaterThan(0);
    });
  });

  test("rebuild with scope='private' only populates search_docs_private", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);
      await seedTestData(sql);

      const rebuilder = new PgSearchRebuilder(sql);
      await rebuilder.rebuild({ agentId: "agent-1", scope: "private" });

      const privateRows = await sql`SELECT COUNT(*)::int as count FROM search_docs_private`;
      const areaRows = await sql`SELECT COUNT(*)::int as count FROM search_docs_area`;

      expect(privateRows[0].count).toBeGreaterThan(0);
      expect(areaRows[0].count).toBe(0);
    });
  });

  test("rebuild clears stale docs before repopulating", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);
      await seedTestData(sql);

      const rebuilder = new PgSearchRebuilder(sql);
      await rebuilder.rebuild({ agentId: "agent-1", scope: "all" });

      const beforeArea = await sql`SELECT COUNT(*)::int as count FROM search_docs_area`;
      expect(beforeArea[0].count).toBeGreaterThan(0);

      await sql`DELETE FROM event_nodes WHERE visibility_scope = 'area_visible'`;
      await rebuilder.rebuild({ agentId: "agent-1", scope: "area" });

      const afterArea = await sql`SELECT COUNT(*)::int as count FROM search_docs_area`;
      expect(afterArea[0].count).toBe(0);
    });
  });

  test("PgSearchProjectionRepo can query rebuilt docs via pg_trgm", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);
      await seedTestData(sql);

      const rebuilder = new PgSearchRebuilder(sql);
      await rebuilder.rebuild({ agentId: "agent-1", scope: "all" });

      const repo = new PgSearchProjectionRepo(sql);
      const results = await repo.searchPrivate("Alice", "agent-1", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("Alice");
    });
  });

  test("valid scopes are accepted", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);

      const rebuilder = new PgSearchRebuilder(sql);
      const scopes: PgSearchRebuildScope[] = ["private", "area", "world", "cognition", "all"];
      for (const scope of scopes) {
        await rebuilder.rebuild({ agentId: "agent-1", scope });
      }
    });
  });
});
