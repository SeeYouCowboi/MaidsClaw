import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type postgres from "postgres";
import { TruthParityVerifier } from "../../src/migration/parity/truth-parity.js";
import { PgImporter } from "../../src/migration/pg-importer.js";
import { PgProjectionRebuilder } from "../../src/migration/pg-projection-rebuild.js";
import { SqliteExporter } from "../../src/migration/sqlite-exporter.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";

const TEST_DIR = join(tmpdir(), `parity-verify-test-${Date.now()}`);
const SQLITE_PATH = join(TEST_DIR, "source.db");
const EXPORT_DIR = join(TEST_DIR, "artifact");

const TRUTH_SURFACES = [
  "settlement_processing_ledger",
  "private_episode_events",
  "private_cognition_events",
  "area_state_events",
  "world_state_events",
  "event_nodes",
  "entity_nodes",
  "entity_aliases",
  "fact_edges",
  "memory_relations",
  "core_memory_blocks",
] as const;

function seedSqliteSource(db: Database): void {
  db.exec(`
    CREATE TABLE settlement_processing_ledger (
      settlement_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      payload_hash TEXT,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      claimed_by TEXT,
      claimed_at INTEGER,
      applied_at INTEGER,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE private_episode_events (
      id INTEGER PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      settlement_id TEXT NOT NULL,
      category TEXT NOT NULL,
      summary TEXT NOT NULL,
      private_notes TEXT,
      location_entity_id INTEGER,
      location_text TEXT,
      valid_time INTEGER,
      committed_time INTEGER NOT NULL,
      source_local_ref TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE private_cognition_events (
      id INTEGER PRIMARY KEY,
      agent_id TEXT NOT NULL,
      cognition_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      op TEXT NOT NULL,
      record_json TEXT,
      settlement_id TEXT NOT NULL,
      committed_time INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE area_state_events (
      id INTEGER PRIMARY KEY,
      agent_id TEXT NOT NULL,
      area_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      surfacing_classification TEXT NOT NULL,
      source_type TEXT NOT NULL,
      valid_time INTEGER,
      committed_time INTEGER NOT NULL,
      settlement_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE world_state_events (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      surfacing_classification TEXT NOT NULL,
      source_type TEXT NOT NULL,
      valid_time INTEGER,
      committed_time INTEGER NOT NULL,
      settlement_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE event_nodes (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      raw_text TEXT,
      summary TEXT,
      timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      participants TEXT,
      emotion TEXT,
      topic_id INTEGER,
      visibility_scope TEXT NOT NULL,
      location_entity_id INTEGER NOT NULL,
      event_category TEXT NOT NULL,
      primary_actor_entity_id INTEGER,
      promotion_class TEXT NOT NULL,
      source_record_id TEXT,
      source_settlement_id TEXT,
      source_pub_index INTEGER,
      event_origin TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE entity_nodes (
      id INTEGER PRIMARY KEY,
      pointer_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      memory_scope TEXT NOT NULL,
      owner_agent_id TEXT,
      canonical_entity_id INTEGER,
      summary TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE entity_aliases (
      id INTEGER PRIMARY KEY,
      canonical_id INTEGER NOT NULL,
      alias TEXT NOT NULL,
      alias_type TEXT,
      owner_agent_id TEXT
    )
  `);

  db.exec(`
    CREATE TABLE fact_edges (
      id INTEGER PRIMARY KEY,
      source_entity_id INTEGER NOT NULL,
      target_entity_id INTEGER NOT NULL,
      predicate TEXT NOT NULL,
      t_valid INTEGER NOT NULL,
      t_invalid INTEGER NOT NULL,
      t_created INTEGER NOT NULL,
      t_expired INTEGER NOT NULL,
      source_event_id INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE memory_relations (
      id INTEGER PRIMARY KEY,
      source_node_ref TEXT NOT NULL,
      target_node_ref TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      strength REAL NOT NULL,
      directness TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE core_memory_blocks (
      id INTEGER PRIMARY KEY,
      agent_id TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      value TEXT NOT NULL,
      char_limit INTEGER NOT NULL,
      read_only INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE private_cognition_current (
      id INTEGER PRIMARY KEY,
      agent_id TEXT NOT NULL,
      cognition_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      stance TEXT,
      basis TEXT,
      status TEXT NOT NULL,
      pre_contested_stance TEXT,
      conflict_summary TEXT,
      conflict_factor_refs_json TEXT,
      summary_text TEXT,
      record_json TEXT NOT NULL,
      source_event_id INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE area_state_current (
      agent_id TEXT NOT NULL,
      area_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      surfacing_classification TEXT NOT NULL,
      source_type TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      valid_time INTEGER,
      committed_time INTEGER,
      PRIMARY KEY (agent_id, area_id, key)
    )
  `);

  db.exec(`
    CREATE TABLE world_state_current (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      surfacing_classification TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      valid_time INTEGER,
      committed_time INTEGER
    )
  `);

  db.exec(`
    INSERT INTO settlement_processing_ledger
      (settlement_id, agent_id, payload_hash, status, attempt_count, max_attempts, claimed_by, claimed_at, applied_at, error_message, created_at, updated_at)
    VALUES
      ('stl-1', 'agent-1', 'hash-1', 'applied', 1, 4, 'agent-1', 1200, 1300, NULL, 1000, 1400)
  `);

  db.exec(`
    INSERT INTO private_episode_events
      (id, agent_id, session_id, settlement_id, category, summary, private_notes, location_entity_id, location_text, valid_time, committed_time, source_local_ref, created_at)
    VALUES
      (1, 'agent-1', 'sess-1', 'stl-1', 'observation', 'Observed the room', 'private note', 101, 'Room 101', 1000, 1000, 'ep-1', 1000)
  `);

  db.exec(`
    INSERT INTO private_cognition_events
      (id, agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
    VALUES
      (1, 'agent-1', 'cog:mood', 'evaluation', 'upsert', '{"meta":{"z":1,"a":2},"notes":"mood positive"}', 'stl-1', 1100, 1100)
  `);

  db.exec(`
    INSERT INTO area_state_events
      (id, agent_id, area_id, key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
    VALUES
      (1, 'agent-1', 1, 'weather', '{"alpha":0}', 'public_manifestation', 'system', 1000, 1000, 'stl-1', 1000),
      (2, 'agent-1', 1, 'weather', '{"beta":2,"alpha":1}', 'public_manifestation', 'system', 2000, 2000, 'stl-1', 2000)
  `);

  db.exec(`
    INSERT INTO world_state_events
      (id, key, value_json, surfacing_classification, source_type, valid_time, committed_time, settlement_id, created_at)
    VALUES
      (1, 'season', '{"name":"spring"}', 'public_manifestation', 'system', 1500, 1500, 'stl-1', 1500),
      (2, 'season', '{"name":"summer","year":3024}', 'public_manifestation', 'system', 2200, 2200, 'stl-1', 2200)
  `);

  db.exec(`
    INSERT INTO event_nodes
      (id, session_id, raw_text, summary, timestamp, created_at, participants, emotion, topic_id, visibility_scope, location_entity_id, event_category, primary_actor_entity_id, promotion_class, source_record_id, source_settlement_id, source_pub_index, event_origin)
    VALUES
      (1, 'sess-1', 'raw', 'summary', 1000, 1000, 'agent-1', 'calm', NULL, 'area_visible', 101, 'observation', NULL, 'none', 'rec-1', 'stl-1', 0, 'runtime_projection')
  `);

  db.exec(`
    INSERT INTO entity_nodes
      (id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at)
    VALUES
      (1, 'alice', 'Alice', 'person', 'private_overlay', 'agent-1', NULL, 'source', 1000, 1000),
      (2, 'bob', 'Bob', 'person', 'private_overlay', 'agent-1', NULL, 'target', 1000, 1000)
  `);

  db.exec(`
    INSERT INTO entity_aliases
      (id, canonical_id, alias, alias_type, owner_agent_id)
    VALUES
      (1, 1, 'Alice', 'name', 'agent-1')
  `);

  db.exec(`
    INSERT INTO fact_edges
      (id, source_entity_id, target_entity_id, predicate, t_valid, t_invalid, t_created, t_expired, source_event_id)
    VALUES
      (1, 1, 2, 'knows', 1200, 9007199254740991, 1200, 9007199254740991, 1)
  `);

  db.exec(`
    INSERT INTO memory_relations
      (id, source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
    VALUES
      (1, 'event:1', 'entity:1', 'supports', 0.8, 'direct', 'turn', 'turn-1', 1300, 1300)
  `);

  db.exec(`
    INSERT INTO core_memory_blocks
      (id, agent_id, label, description, value, char_limit, read_only, updated_at)
    VALUES
      (1, 'agent-1', 'user', NULL, 'remember this', 1000, 0, 1400)
  `);

  db.exec(`
    INSERT INTO private_cognition_current
      (id, agent_id, cognition_key, kind, stance, basis, status, pre_contested_stance, conflict_summary, conflict_factor_refs_json, summary_text, record_json, source_event_id, updated_at)
    VALUES
      (1, 'agent-1', 'cog:mood', 'evaluation', NULL, NULL, 'active', NULL, NULL, NULL, 'evaluation: mood positive', '{"notes":"mood positive","meta":{"a":2,"z":1}}', 1, 1100)
  `);

  db.exec(`
    INSERT INTO area_state_current
      (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
    VALUES
      ('agent-1', 1, 'weather', '{"alpha":1,"beta":2}', 'public_manifestation', 'system', 2000, 2000, 2000)
  `);

  db.exec(`
    INSERT INTO world_state_current
      (key, value_json, surfacing_classification, updated_at, valid_time, committed_time)
    VALUES
      ('season', '{"year":3024,"name":"summer"}', 'public_manifestation', 2200, 2200, 2200)
  `);
}

function exportSqliteTruthArtifact(): void {
  const exporter = new SqliteExporter(
    {
      dbPath: SQLITE_PATH,
      outDir: EXPORT_DIR,
      surfaces: [...TRUTH_SURFACES],
    },
    () => {},
  );

  try {
    exporter.export();
  } finally {
    exporter.close();
  }
}

async function bootstrapAllSchemas(sql: postgres.Sql): Promise<void> {
  await bootstrapTruthSchema(sql);
  await bootstrapOpsSchema(sql);
  await bootstrapDerivedSchema(sql, { embeddingDim: 3 });
}

const describeWithSkipIf = describe as typeof describe & {
  skipIf: (condition: boolean) => (name: string, fn: () => void) => void;
};

describeWithSkipIf.skipIf(!process.env.PG_APP_TEST_URL)("parity-verify", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const sqlite = new Database(SQLITE_PATH, { create: true });
    seedSqliteSource(sqlite);
    sqlite.close();
    exportSqliteTruthArtifact();

    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("export→import→replay yields zero truth+projection mismatches", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);

      const importer = new PgImporter(
        {
          manifestPath: join(EXPORT_DIR, "manifest.json"),
          sql,
        },
        () => {},
      );
      await importer.import();

      const rebuilder = new PgProjectionRebuilder(sql);
      await rebuilder.rebuildAll();

      const sqliteDb = new Database(SQLITE_PATH, { readonly: true });
      try {
        const verifier = new TruthParityVerifier(sqliteDb, sql);
        const report = await verifier.generateReport();

        expect(report.passed).toBe(true);
        expect(report.totalMismatches).toBe(0);
        expect(report.surfaces.length).toBeGreaterThan(0);

        for (const surface of report.surfaces) {
          expect(surface.mismatchCount).toBe(0);
          expect(surface.countMatch).toBe(true);
        }
      } finally {
        sqliteDb.close();
      }
    });
  });

  test("detects mismatch after PG field mutation", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);

      const importer = new PgImporter(
        {
          manifestPath: join(EXPORT_DIR, "manifest.json"),
          sql,
        },
        () => {},
      );
      await importer.import();

      const rebuilder = new PgProjectionRebuilder(sql);
      await rebuilder.rebuildAll();

      await sql`
        UPDATE settlement_processing_ledger
        SET status = 'failed_terminal'
        WHERE settlement_id = 'stl-1'
      `;

      const sqliteDb = new Database(SQLITE_PATH, { readonly: true });
      try {
        const verifier = new TruthParityVerifier(sqliteDb, sql);
        const report = await verifier.generateReport();

        expect(report.passed).toBe(false);
        expect(report.totalMismatches).toBe(1);

        const ledgerSurface = report.surfaces.find(
          (surface) => surface.surface === "settlement_processing_ledger",
        );
        expect(ledgerSurface).toBeDefined();
        if (!ledgerSurface) {
          throw new Error("settlement_processing_ledger surface not present in report");
        }
        expect(ledgerSurface.mismatchCount).toBe(1);
        expect(ledgerSurface.mismatches[0]?.field).toBe("status");
      } finally {
        sqliteDb.close();
      }
    });
  });

  test("projection parity treats JSON field order as semantic-equal", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);

      const importer = new PgImporter(
        {
          manifestPath: join(EXPORT_DIR, "manifest.json"),
          sql,
        },
        () => {},
      );
      await importer.import();

      const rebuilder = new PgProjectionRebuilder(sql);
      await rebuilder.rebuildAll();

      await sql`
        UPDATE area_state_current
        SET value_json = jsonb_build_object('beta', 2, 'alpha', 1)
        WHERE agent_id = 'agent-1' AND area_id = 1 AND key = 'weather'
      `;

      const sqliteDb = new Database(SQLITE_PATH, { readonly: true });
      try {
        const verifier = new TruthParityVerifier(sqliteDb, sql);
        const projection = await verifier.verifyCurrentProjection();

        for (const surface of projection) {
          expect(surface.mismatchCount).toBe(0);
        }
      } finally {
        sqliteDb.close();
      }
    });
  });
});
