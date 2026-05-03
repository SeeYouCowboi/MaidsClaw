import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  backfillEdgeProvenance,
  bootstrapTruthSchema,
} from "../../src/storage/pg-app-schema-truth.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

const PG_MAX_BIGINT = "9223372036854775807";

async function columnExists(
  sql: postgres.Sql,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ${table}
      AND column_name = ${column}
  `;
  return rows.length > 0;
}

async function tableExists(sql: postgres.Sql, table: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = ${table}
  `;
  return rows.length > 0;
}

describe.skipIf(skipPgTests)("pg-edge-schema-upgrades", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("fresh bootstrap creates new provenance columns and unresolved ops table", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);

      expect(await columnExists(sql, "logic_edges", "source_kind")).toBe(true);
      expect(await columnExists(sql, "logic_edges", "source_ref")).toBe(true);

      expect(await columnExists(sql, "fact_edges", "fact_text")).toBe(true);
      expect(await columnExists(sql, "fact_edges", "owner_agent_id")).toBe(true);
      expect(await columnExists(sql, "fact_edges", "source_kind")).toBe(true);
      expect(await columnExists(sql, "fact_edges", "source_ref")).toBe(true);

      expect(await columnExists(sql, "semantic_edges", "source_kind")).toBe(true);
      expect(await columnExists(sql, "semantic_edges", "source_ref")).toBe(true);

      expect(await tableExists(sql, "unresolved_world_state_ops")).toBe(true);
    });
  });

  it("re-running bootstrap is a no-op (idempotent)", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);
    });
  });

  it("memory_relations CHECK accepts both legacy and new source_kind values", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const now = Date.now();

      const variants = ["turn", "job", "agent_op", "system", "settlement", "sweep", "migration", "seed", "derived"];
      for (let i = 0; i < variants.length; i++) {
        const kind = variants[i];
        await sql.unsafe(`
          INSERT INTO memory_relations
            (source_node_ref, target_node_ref, relation_type, source_kind, source_ref, created_at, updated_at)
          VALUES ('event:${i}a', 'event:${i}b', 'supports', '${kind}', 'ref-${i}', ${now}, ${now})
        `);
      }
    });
  });

  it("backfillEdgeProvenance rewrites memory_relations legacy source_kind values", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const now = Date.now();

      await sql.unsafe(`
        INSERT INTO memory_relations
          (source_node_ref, target_node_ref, relation_type, source_kind, source_ref, created_at, updated_at)
        VALUES
          ('event:1', 'event:2', 'supports', 'job',    'ref-a', ${now}, ${now}),
          ('event:1', 'event:2', 'supports', 'system', 'ref-b', ${now}, ${now})
      `);

      await backfillEdgeProvenance(sql, { batchSize: 100 });

      const rows = await sql`
        SELECT source_kind, source_ref
        FROM memory_relations
        WHERE source_node_ref = 'event:1' AND target_node_ref = 'event:2'
        ORDER BY id
      `;

      expect(rows.length).toBe(2);
      expect(rows[0].source_kind).toBe("sweep");
      expect(rows[1].source_kind).toBe("migration");
      expect(rows[0].source_ref).toBe("ref-a");
      expect(rows[1].source_ref).toBe("ref-b");
    });
  });

  it("backfillEdgeProvenance applies :legacy- suffix when post-rewrite tuples collide", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const now = Date.now();

      await sql.unsafe(`DROP INDEX IF EXISTS ux_memory_relations_pair_type`);
      await sql.unsafe(`
        INSERT INTO memory_relations
          (source_node_ref, target_node_ref, relation_type, source_kind, source_ref, created_at, updated_at)
        VALUES
          ('event:1', 'event:2', 'supports', 'job', 'ref-x', ${now}, ${now}),
          ('event:1', 'event:2', 'supports', 'job', 'ref-x', ${now}, ${now})
      `);

      await backfillEdgeProvenance(sql, { batchSize: 100 });

      const rows = await sql`
        SELECT source_kind, source_ref
        FROM memory_relations
        WHERE source_node_ref = 'event:1' AND target_node_ref = 'event:2'
        ORDER BY id
      `;

      expect(rows.length).toBe(2);
      for (const r of rows) {
        expect(r.source_kind).toBe("sweep");
      }
      const refs = rows.map((r) => String(r.source_ref));
      expect(new Set(refs).size).toBe(2);
      expect(refs.some((r) => r.includes(":legacy-"))).toBe(true);
    });
  });

  it("backfillEdgeProvenance is re-entrant (calling twice does nothing on already-backfilled rows)", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);
      const now = Date.now();

      await sql.unsafe(`
        INSERT INTO logic_edges
          (source_event_id, target_event_id, relation_type, created_at)
        VALUES (1, 2, 'causal', ${now})
      `);

      await backfillEdgeProvenance(sql, { batchSize: 100 });
      const [first] = await sql`
        SELECT source_kind, source_ref FROM logic_edges WHERE source_event_id = 1
      `;
      expect(first.source_kind).toBe("migration");
      expect(first.source_ref).toBe("legacy:logic_edges");

      await backfillEdgeProvenance(sql, { batchSize: 100 });
      const [second] = await sql`
        SELECT source_kind, source_ref FROM logic_edges WHERE source_event_id = 1
      `;
      expect(second.source_kind).toBe("migration");
      expect(second.source_ref).toBe("legacy:logic_edges");
    });
  });

  it("fact_edges idempotency guard is full-history (active or invalidated) for settlement source_ref", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const now = Date.now();

      await sql.unsafe(`
        INSERT INTO fact_edges
          (source_entity_id, target_entity_id, predicate, t_valid, t_created, source_kind, source_ref)
        VALUES (1, 2, 'located_at', ${now}, ${now}, 'settlement', 'stl-1:0')
      `);

      // Active duplicate must fail — basic idempotency.
      let caughtActive: Error | null = null;
      try {
        await sql.unsafe(`
          INSERT INTO fact_edges
            (source_entity_id, target_entity_id, predicate, t_valid, t_created, source_kind, source_ref)
          VALUES (3, 4, 'has_color', ${now}, ${now}, 'settlement', 'stl-1:0')
        `);
      } catch (e: any) {
        caughtActive = e;
      }
      expect(caughtActive).not.toBeNull();
      expect(caughtActive!.message.toLowerCase()).toContain("unique");

      // Now invalidate the original row. With the OLD active-only index this
      // freed the (source_kind, source_ref) slot and let a replayed settlement
      // re-insert a new active row, resurrecting stale facts. With the NEW
      // full-history index, the slot stays occupied — replay must fail.
      await sql.unsafe(`
        UPDATE fact_edges SET t_invalid = ${now + 1000}
        WHERE source_kind = 'settlement' AND source_ref = 'stl-1:0'
      `);

      let caughtReplay: Error | null = null;
      try {
        await sql.unsafe(`
          INSERT INTO fact_edges
            (source_entity_id, target_entity_id, predicate, t_valid, t_created, source_kind, source_ref)
          VALUES (3, 4, 'has_color', ${now + 1000}, ${now + 1000}, 'settlement', 'stl-1:0')
        `);
      } catch (e: any) {
        caughtReplay = e;
      }
      expect(caughtReplay).not.toBeNull();
      expect(caughtReplay!.message.toLowerCase()).toContain("unique");

      // Exactly one row exists for that source_ref, regardless of state.
      const total = await sql.unsafe(`
        SELECT count(*)::int AS cnt
        FROM fact_edges
        WHERE source_kind = 'settlement' AND source_ref = 'stl-1:0'
      `);
      expect(total[0].cnt).toBe(1);

      // And no active rows, since we invalidated the only one.
      const active = await sql.unsafe(`
        SELECT count(*)::int AS cnt
        FROM fact_edges
        WHERE source_kind = 'settlement'
          AND source_ref = 'stl-1:0'
          AND t_invalid = ${PG_MAX_BIGINT}
      `);
      expect(active[0].cnt).toBe(0);
    });
  });

  it("migrateFactEdgesIdempotencyToFullHistory dedupes legacy duplicates and switches to full-history index", async () => {
    const { migrateFactEdgesIdempotencyToFullHistory } = await import(
      "../../src/storage/pg-app-schema-truth.js"
    );

    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);

      // Simulate an old deployment: drop new index, recreate the active-only
      // legacy index, and seed duplicates that the legacy guard allowed.
      await sql.unsafe(`DROP INDEX IF EXISTS ux_fact_edges_settlement_source_ref`);
      await sql.unsafe(`
        CREATE UNIQUE INDEX ux_fact_edges_settlement_active
          ON fact_edges(source_kind, source_ref)
          WHERE source_kind = 'settlement' AND t_invalid = ${PG_MAX_BIGINT}
      `);

      const now = Date.now();
      await sql.unsafe(`
        INSERT INTO fact_edges
          (source_entity_id, target_entity_id, predicate, t_valid, t_invalid, t_created, source_kind, source_ref)
        VALUES
          (1, 2, 'located_at', ${now},        ${now + 100}, ${now},       'settlement', 'stl-1:0'),
          (1, 2, 'located_at', ${now + 200},  ${PG_MAX_BIGINT}, ${now + 200}, 'settlement', 'stl-1:0')
      `);

      const before = await sql.unsafe(`
        SELECT count(*)::int AS cnt
        FROM fact_edges
        WHERE source_kind = 'settlement' AND source_ref = 'stl-1:0'
      `);
      expect(before[0].cnt).toBe(2);

      await migrateFactEdgesIdempotencyToFullHistory(sql);

      // After migration, the canonical row keeps its source_ref; the duplicate
      // is suffixed; both rows still exist but resolve to distinct source_refs.
      const refs = await sql.unsafe(`
        SELECT source_ref FROM fact_edges
        WHERE source_kind = 'settlement'
        ORDER BY id
      `);
      expect(refs.length).toBe(2);
      expect(refs[0].source_ref).toBe("stl-1:0");
      expect(String(refs[1].source_ref)).toContain(":legacy-");

      // Old index is gone; new full-history index is present.
      const idx = await sql.unsafe(`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname IN (
            'ux_fact_edges_settlement_active',
            'ux_fact_edges_settlement_source_ref'
          )
      `);
      const indexNames = idx.map((row: any) => row.indexname).sort();
      expect(indexNames).toEqual(["ux_fact_edges_settlement_source_ref"]);

      // Re-running migration is a no-op (no further dedupe needed).
      await migrateFactEdgesIdempotencyToFullHistory(sql);
      const after = await sql.unsafe(`
        SELECT count(*)::int AS cnt FROM fact_edges
        WHERE source_kind = 'settlement'
      `);
      expect(after[0].cnt).toBe(2);
    });
  });

  it("unresolved_world_state_ops enforces unique (settlement_id, op_index)", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const now = Date.now();

      await sql.unsafe(`
        INSERT INTO unresolved_world_state_ops
          (session_id, settlement_id, op_index, op_payload, created_at, updated_at)
        VALUES ('sess-1', 'stl-1', 0, '{}'::jsonb, ${now}, ${now})
      `);

      let caught: Error | null = null;
      try {
        await sql.unsafe(`
          INSERT INTO unresolved_world_state_ops
            (session_id, settlement_id, op_index, op_payload, created_at, updated_at)
          VALUES ('sess-1', 'stl-1', 0, '{}'::jsonb, ${now}, ${now})
        `);
      } catch (e: any) {
        caught = e;
      }
      expect(caught).not.toBeNull();
    });
  });
});
