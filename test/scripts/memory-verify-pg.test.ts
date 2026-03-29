import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import {
  verifyCognitionSurfacePg,
  verifyAreaSurfacePg,
  verifyWorldSurfacePg,
  verifySearchSurfacePg,
  verifyGraphRegistrySurfacePg,
  verifyContestedSurfacePg,
  runVerifyPg,
} from "../../scripts/memory-verify.js";

async function bootstrapAllSchemas(sql: postgres.Sql): Promise<void> {
  await bootstrapTruthSchema(sql);
  await bootstrapOpsSchema(sql);
  await bootstrapDerivedSchema(sql, { embeddingDim: 3 });
}

async function seedPgData(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO settlement_processing_ledger
      (settlement_id, agent_id, payload_hash, status, attempt_count, max_attempts, claimed_by, claimed_at, applied_at, error_message, created_at, updated_at)
    VALUES
      ('stl-1', 'agent-1', 'hash-1', 'applied', 1, 4, 'agent-1', 1200, 1300, NULL, 1000, 1400)
  `;

  await sql`
    INSERT INTO private_cognition_events
      (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
    VALUES
      ('agent-1', 'cog:mood', 'evaluation', 'upsert', ${sql.json({ notes: "mood positive" } as never)}, 'stl-1', 1100, 1100)
  `;

  await sql`
    INSERT INTO private_cognition_current
      (agent_id, cognition_key, kind, stance, basis, status, summary_text, record_json, source_event_id, updated_at)
    VALUES
      ('agent-1', 'cog:mood', 'evaluation', NULL, NULL, 'active', 'mood positive', ${sql.json({ notes: "mood positive" } as never)}, 1, 1100)
  `;

  await sql`
    INSERT INTO area_state_events
      (agent_id, area_id, key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
    VALUES
      ('agent-1', 1, 'weather', ${sql.json({ temp: 22 } as never)}, 'public_manifestation', 'system', 1000, 1000, 'stl-1', 1000)
  `;

  await sql`
    INSERT INTO area_state_current
      (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
    VALUES
      ('agent-1', 1, 'weather', ${sql.json({ temp: 22 } as never)}, 'public_manifestation', 'system', 1000, 1000, 1000)
  `;

  await sql`
    INSERT INTO world_state_events
      (key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
    VALUES
      ('season', ${sql.json({ name: "spring" } as never)}, 'public_manifestation', 'system', 1500, 1500, 'stl-1', 1500)
  `;

  await sql`
    INSERT INTO world_state_current
      (key, value_json, surfacing_classification, updated_at, valid_time, committed_time)
    VALUES
      ('season', ${sql.json({ name: "spring" } as never)}, 'public_manifestation', 1500, 1500, 1500)
  `;

  await sql`
    INSERT INTO event_nodes
      (session_id, raw_text, summary, timestamp, created_at, participants, emotion, visibility_scope, location_entity_id, event_category, promotion_class, event_origin)
    VALUES
      ('sess-1', 'raw', 'summary', 1000, 1000, 'agent-1', 'calm', 'area_visible', 101, 'observation', 'none', 'runtime_projection')
  `;

  await sql`
    INSERT INTO entity_nodes
      (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, summary, created_at, updated_at)
    VALUES
      ('alice', 'Alice', 'person', 'private_overlay', 'agent-1', 'a person', 1000, 1000)
  `;

  await sql`
    INSERT INTO fact_edges
      (source_entity_id, target_entity_id, predicate, t_valid, t_invalid, t_created, t_expired, source_event_id)
    VALUES
      (1, 1, 'knows', 1200, 9223372036854775807, 1200, 9223372036854775807, 1)
  `;
}

const describeWithSkipIf = describe as typeof describe & {
  skipIf: (condition: boolean) => (name: string, fn: () => void) => void;
};

describeWithSkipIf.skipIf(!process.env.PG_APP_TEST_URL)("memory-verify PG", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  test("verifyCognitionSurfacePg passes with consistent data", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);
      await seedPgData(sql);

      const result = await verifyCognitionSurfacePg(sql);
      expect(result.surface).toBe("cognition");
      expect(result.pass).toBe(true);
      expect(result.checkedKeys).toBeGreaterThan(0);
      expect(result.mismatches.length).toBe(0);
    });
  });

  test("verifyCognitionSurfacePg detects count mismatch", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);
      await seedPgData(sql);

      await sql`
        INSERT INTO private_cognition_events
          (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
        VALUES
          ('agent-1', 'cog:trust', 'assertion', 'upsert', ${sql.json({ notes: "trust high" } as never)}, 'stl-1', 1200, 1200)
      `;

      const result = await verifyCognitionSurfacePg(sql);
      expect(result.pass).toBe(false);
      expect(result.mismatches.length).toBeGreaterThan(0);
    });
  });

  test("verifyAreaSurfacePg passes with consistent data", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);
      await seedPgData(sql);

      const result = await verifyAreaSurfacePg(sql);
      expect(result.surface).toBe("area");
      expect(result.pass).toBe(true);
      expect(result.checkedKeys).toBeGreaterThan(0);
    });
  });

  test("verifyWorldSurfacePg passes with consistent data", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);
      await seedPgData(sql);

      const result = await verifyWorldSurfacePg(sql);
      expect(result.surface).toBe("world");
      expect(result.pass).toBe(true);
      expect(result.checkedKeys).toBeGreaterThan(0);
    });
  });

  test("verifySearchSurfacePg reports empty tables as pass", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);

      const result = await verifySearchSurfacePg(sql);
      expect(result.surface).toBe("search");
      expect(result.pass).toBe(true);
      expect(result.checkedKeys).toBe(0);
    });
  });

  test("verifyGraphRegistrySurfacePg counts graph tables", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);
      await seedPgData(sql);

      const result = await verifyGraphRegistrySurfacePg(sql);
      expect(result.surface).toBe("graph-registry");
      expect(result.pass).toBe(true);
      expect(result.checkedKeys).toBeGreaterThan(0);
      expect(result.summary).toContain("event_nodes=");
      expect(result.summary).toContain("entity_nodes=");
      expect(result.summary).toContain("fact_edges=");
    });
  });

  test("verifyContestedSurfacePg passes with no conflict relations", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);
      await seedPgData(sql);

      const result = await verifyContestedSurfacePg(sql);
      expect(result.surface).toBe("contested");
      expect(result.pass).toBe(true);
    });
  });

  test("runVerifyPg dispatches to all surfaces", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);
      await seedPgData(sql);

      const results = await runVerifyPg(sql, ["cognition", "area", "world", "search", "graph-registry", "contested"]);
      expect(results.length).toBe(6);
      for (const r of results) {
        expect(r.pass).toBe(true);
      }
    });
  });

  test("verifyWorldSurfacePg detects missing current row", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);
      await seedPgData(sql);

      await sql`DELETE FROM world_state_current`;

      const result = await verifyWorldSurfacePg(sql);
      expect(result.pass).toBe(false);
      expect(result.mismatches.length).toBe(1);
      expect(result.mismatches[0]!.kind).toBe("missing_from_current");
    });
  });
});
