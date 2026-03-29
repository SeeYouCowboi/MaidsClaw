import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type postgres from "postgres";
import { PgImporter } from "../../src/migration/pg-importer.js";
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

const TEST_DIR = join(tmpdir(), `pg-import-test-${Date.now()}`);
const SQLITE_PATH = join(TEST_DIR, "source.db");
const EXPORT_DIR = join(TEST_DIR, "artifact");

function seedSqliteSource(db: Database): void {
  db.run(`CREATE TABLE settlement_processing_ledger (
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
  )`);
  db.run(
    `INSERT INTO settlement_processing_ledger
      (settlement_id, agent_id, payload_hash, status, attempt_count, max_attempts, claimed_by, claimed_at, applied_at, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "stl-1",
      "agent-1",
      "hash-1",
      "applied",
      1,
      4,
      "agent-1",
      111,
      222,
      null,
      1000,
      2000,
    ],
  );

  db.run(`CREATE TABLE private_cognition_events (
    id INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL,
    cognition_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    op TEXT NOT NULL,
    record_json TEXT,
    settlement_id TEXT NOT NULL,
    committed_time INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.run(
    `INSERT INTO private_cognition_events
      (id, agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      7,
      "agent-1",
      "belief:trust",
      "assertion",
      "upsert",
      JSON.stringify({ stance: "accepted", basis: "first_hand" }),
      "stl-1",
      333,
      444,
    ],
  );

  db.run(`CREATE TABLE interaction_records (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    record_index INTEGER NOT NULL,
    actor_type TEXT NOT NULL,
    record_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    correlated_turn_id TEXT,
    committed_at INTEGER NOT NULL,
    is_processed INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(
    `INSERT INTO interaction_records
      (id, session_id, record_id, record_index, actor_type, record_type, payload, correlated_turn_id, committed_at, is_processed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      5,
      "sess-1",
      "rec-1",
      0,
      "user",
      "message",
      JSON.stringify({ text: "hello" }),
      "turn-1",
      555,
      0,
    ],
  );

  db.run(`CREATE TABLE node_embeddings (
    id INTEGER PRIMARY KEY,
    node_ref TEXT NOT NULL,
    node_kind TEXT NOT NULL,
    view_type TEXT NOT NULL,
    model_id TEXT NOT NULL,
    embedding BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const vector = new Float32Array([0.11, 0.22, 0.33]);
  db.run(
    `INSERT INTO node_embeddings
      (id, node_ref, node_kind, view_type, model_id, embedding, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      10,
      "event:1",
      "event",
      "primary",
      "model-A",
      Buffer.from(vector.buffer),
      666,
    ],
  );

  db.run(`CREATE TABLE search_docs_world (
    id INTEGER PRIMARY KEY,
    doc_type TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.run(
    `INSERT INTO search_docs_world (id, doc_type, source_ref, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [3, "event", "event:1", "world note", 777],
  );

  db.run(`CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    recovery_required INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(
    `INSERT INTO sessions (session_id, agent_id, created_at, closed_at, recovery_required)
     VALUES (?, ?, ?, ?, ?)`,
    ["sess-1", "agent-1", 123, null, 0],
  );
}

function exportSqliteArtifact(): void {
  const exporter = new SqliteExporter(
    {
      dbPath: SQLITE_PATH,
      outDir: EXPORT_DIR,
      surfaces: [
        "settlement_processing_ledger",
        "private_cognition_events",
        "interaction_records",
        "node_embeddings",
        "search_docs_world",
        "sessions",
      ],
    },
    () => {},
  );

  try {
    exporter.export();
  } finally {
    exporter.close();
  }
}

const describeWithSkipIf = describe as typeof describe & {
  skipIf: (condition: boolean) => (name: string, fn: () => void) => void;
};

describeWithSkipIf.skipIf(!process.env.PG_APP_TEST_URL)("PgImporter", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const sqlite = new Database(SQLITE_PATH, { create: true });
    seedSqliteSource(sqlite);
    sqlite.close();
    exportSqliteArtifact();

    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("exports from SQLite and imports to PG with matching row counts", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapOpsSchema(sql);
      await bootstrapDerivedSchema(sql, { embeddingDim: 3 });

      const importer = new PgImporter(
        {
          manifestPath: join(EXPORT_DIR, "manifest.json"),
          sql,
        },
        () => {},
      );

      await importer.import();

      const manifest = JSON.parse(
        readFileSync(join(EXPORT_DIR, "manifest.json"), "utf-8"),
      ) as { surfaces: Array<{ name: string; row_count: number }> };

      for (const surface of manifest.surfaces) {
        const [{ count }] = await sql.unsafe(
          `SELECT COUNT(*)::int AS count FROM "${surface.name}"`,
        ) as Array<{ count: number }>;
        expect(count).toBe(surface.row_count);
      }
    });
  });

  test("re-import is idempotent (truncate + import)", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapOpsSchema(sql);
      await bootstrapDerivedSchema(sql, { embeddingDim: 3 });

      const importer = new PgImporter(
        {
          manifestPath: join(EXPORT_DIR, "manifest.json"),
          sql,
        },
        () => {},
      );

      await importer.import();

      const firstCounts = {
        ledger: Number((await sql`SELECT COUNT(*)::int AS count FROM settlement_processing_ledger`)[0].count),
        cognition: Number((await sql`SELECT COUNT(*)::int AS count FROM private_cognition_events`)[0].count),
        interactions: Number((await sql`SELECT COUNT(*)::int AS count FROM interaction_records`)[0].count),
        embeddings: Number((await sql`SELECT COUNT(*)::int AS count FROM node_embeddings`)[0].count),
      };

      await importer.import();

      const secondCounts = {
        ledger: Number((await sql`SELECT COUNT(*)::int AS count FROM settlement_processing_ledger`)[0].count),
        cognition: Number((await sql`SELECT COUNT(*)::int AS count FROM private_cognition_events`)[0].count),
        interactions: Number((await sql`SELECT COUNT(*)::int AS count FROM interaction_records`)[0].count),
        embeddings: Number((await sql`SELECT COUNT(*)::int AS count FROM node_embeddings`)[0].count),
      };

      expect(secondCounts).toEqual(firstCounts);
    });
  });

  test("after import, BIGSERIAL sequences continue above max(id)", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapOpsSchema(sql);
      await bootstrapDerivedSchema(sql, { embeddingDim: 3 });

      const importer = new PgImporter(
        {
          manifestPath: join(EXPORT_DIR, "manifest.json"),
          sql,
        },
        () => {},
      );

      await importer.import();

      const [{ maxLedger }] = await sql<{ maxLedger: number | null }[]>`
        SELECT MAX(id)::int AS "maxLedger" FROM private_cognition_events
      `;

      const [inserted] = await sql<{ id: number }[]>`
        INSERT INTO private_cognition_events
          (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
        VALUES
          ('agent-1', 'belief:new', 'assertion', 'upsert', ${sql.json({ stance: "tentative" } as never)}, 'stl-new', 9999, 9999)
        RETURNING id::int AS id
      `;

      expect(inserted.id).toBeGreaterThan(Number(maxLedger ?? 0));
    });
  });
});
