import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";

import {
  EXPORT_SURFACES,
  SqliteExporter,
  processRow,
  type ExportManifest,
  type ExportSurfaceConfig,
} from "../../src/migration/sqlite-exporter.js";

const TEST_DIR = join(tmpdir(), `sqlite-export-test-${Date.now()}`);
const DB_PATH = join(TEST_DIR, "test.db");
const silentLog = () => {};

function readJsonl<T = Record<string, unknown>>(path: string): T[] {
  const content = readFileSync(path, "utf-8").trim();
  if (content === "") return [];
  return content.split("\n").map((line) => JSON.parse(line) as T);
}

function seedTestDatabase(db: Database): void {
  db.run(`CREATE TABLE topics (
    id INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.run(
    "INSERT INTO topics (agent_id, label, created_at) VALUES (?, ?, ?)",
    ["agent-1", "history", 1000],
  );
  db.run(
    "INSERT INTO topics (agent_id, label, created_at) VALUES (?, ?, ?)",
    ["agent-1", "science", 2000],
  );

  db.run("CREATE TABLE settlement_processing_ledger (id INTEGER PRIMARY KEY, status TEXT)");

  db.run(`CREATE TABLE area_state_events (
    id INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL,
    area_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT,
    surfacing_classification TEXT,
    committed_time INTEGER NOT NULL
  )`);
  db.run(
    "INSERT INTO area_state_events (agent_id, area_id, key, value_json, surfacing_classification, committed_time) VALUES (?, ?, ?, ?, ?, ?)",
    ["agent-1", 1, "mood", '{"level":"calm"}', "active", 5000],
  );
  db.run(
    "INSERT INTO area_state_events (agent_id, area_id, key, value_json, surfacing_classification, committed_time) VALUES (?, ?, ?, ?, ?, ?)",
    ["agent-1", 1, "empty-val", null, "dormant", 6000],
  );

  db.run(`CREATE TABLE node_embeddings (
    id INTEGER PRIMARY KEY,
    node_ref TEXT NOT NULL,
    embedding BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const floats = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  db.run(
    "INSERT INTO node_embeddings (node_ref, embedding, updated_at) VALUES (?, ?, ?)",
    ["entity:1", Buffer.from(floats.buffer), 9000],
  );

  db.run(`CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  )`);
  db.run(
    "INSERT INTO sessions (session_id, agent_id, started_at) VALUES (?, ?, ?)",
    ["sess-1", "agent-1", 3000],
  );

  db.run(`CREATE TABLE interaction_records (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    payload TEXT
  )`);
  db.run(
    "INSERT INTO interaction_records (session_id, role, payload) VALUES (?, ?, ?)",
    ["sess-1", "user", '{"text":"hello"}'],
  );
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  seedTestDatabase(db);
  db.close();
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function runExport(subDir: string, surfaces?: string[]): ExportManifest {
  const outDir = join(TEST_DIR, subDir);
  const exporter = new SqliteExporter(
    { dbPath: DB_PATH, outDir, surfaces },
    silentLog,
  );
  try {
    return exporter.export();
  } finally {
    exporter.close();
  }
}

describe("SqliteExporter", () => {
  test("manifest has correct structure", () => {
    const manifest = runExport("manifest-structure");

    expect(manifest.schema_version).toBe("1.0.0");
    expect(manifest.exported_at).toBeTruthy();
    expect(manifest.source_db).toContain("test.db");
    expect(Array.isArray(manifest.surfaces)).toBe(true);
    expect(manifest.surfaces.length).toBe(EXPORT_SURFACES.length);
  });

  test("manifest.json is written to disk", () => {
    runExport("manifest-disk");
    const manifestPath = join(TEST_DIR, "manifest-disk", "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as ExportManifest;
    expect(parsed.schema_version).toBe("1.0.0");
  });

  test("exports rows from a normal table", () => {
    runExport("normal-table", ["topics"]);
    const rows = readJsonl(join(TEST_DIR, "normal-table", "topics.jsonl"));

    expect(rows).toHaveLength(2);
    expect(rows[0].agent_id).toBe("agent-1");
    expect(rows[0].label).toBe("history");
    expect(rows[1].agent_id).toBe("agent-1");
    expect(rows[1].label).toBe("science");
  });

  test("empty table produces empty JSONL with 0 rows", () => {
    const manifest = runExport("empty-table", ["settlement_processing_ledger"]);
    const result = manifest.surfaces.find(
      (s) => s.name === "settlement_processing_ledger",
    );

    expect(result).toBeDefined();
    expect(result!.row_count).toBe(0);

    const rows = readJsonl(
      join(TEST_DIR, "empty-table", "settlement_processing_ledger.jsonl"),
    );
    expect(rows).toHaveLength(0);
  });

  test("missing table produces empty JSONL without throwing", () => {
    const manifest = runExport("missing-table", ["search_docs_private"]);
    const result = manifest.surfaces.find(
      (s) => s.name === "search_docs_private",
    );

    expect(result).toBeDefined();
    expect(result!.row_count).toBe(0);
    expect(
      existsSync(join(TEST_DIR, "missing-table", "search_docs_private.jsonl")),
    ).toBe(true);
  });

  test("JSON TEXT columns are parsed to objects", () => {
    runExport("json-parse", ["area_state_events"]);
    const rows = readJsonl(
      join(TEST_DIR, "json-parse", "area_state_events.jsonl"),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].value_json).toEqual({ level: "calm" });
  });

  test("NULL in JSON TEXT column stays null", () => {
    runExport("json-null", ["area_state_events"]);
    const rows = readJsonl(
      join(TEST_DIR, "json-null", "area_state_events.jsonl"),
    );

    const nullRow = rows.find((r) => r.key === "empty-val");
    expect(nullRow).toBeDefined();
    expect(nullRow!.value_json).toBeNull();
  });

  test("BLOB columns are encoded as base64", () => {
    runExport("blob-b64", ["node_embeddings"]);
    const rows = readJsonl(
      join(TEST_DIR, "blob-b64", "node_embeddings.jsonl"),
    );

    expect(rows).toHaveLength(1);
    expect(typeof rows[0].embedding).toBe("string");

    const decoded = Buffer.from(rows[0].embedding as string, "base64");
    const floats = new Float32Array(
      decoded.buffer,
      decoded.byteOffset,
      decoded.byteLength / 4,
    );
    expect(floats[0]).toBeCloseTo(0.1);
    expect(floats[1]).toBeCloseTo(0.2);
    expect(floats[2]).toBeCloseTo(0.3);
    expect(floats[3]).toBeCloseTo(0.4);
  });

  test("SHA-256 checksum matches file content", () => {
    const manifest = runExport("checksum", ["topics"]);
    const result = manifest.surfaces.find((s) => s.name === "topics")!;

    const fileContent = readFileSync(
      join(TEST_DIR, "checksum", "topics.jsonl"),
    );
    const expectedHash = createHash("sha256").update(fileContent).digest("hex");

    expect(result.checksum).toBe(`sha256:${expectedHash}`);
  });

  test("surface filter limits exported surfaces", () => {
    const manifest = runExport("filter", ["topics", "sessions"]);

    expect(manifest.surfaces).toHaveLength(2);
    const names = manifest.surfaces.map((s) => s.name);
    expect(names).toContain("topics");
    expect(names).toContain("sessions");
  });

  test("surfaces follow canonical order", () => {
    const manifest = runExport("order");
    const names = manifest.surfaces.map((s) => s.name);
    const canonicalNames = EXPORT_SURFACES.map((s) => s.name);

    expect(names).toEqual(canonicalNames);
  });

  test("interaction_records payload is parsed as JSON", () => {
    runExport("interaction-json", ["interaction_records"]);
    const rows = readJsonl(
      join(TEST_DIR, "interaction-json", "interaction_records.jsonl"),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ text: "hello" });
  });
});

describe("processRow", () => {
  const surface: ExportSurfaceConfig = {
    name: "test",
    jsonColumns: ["data"],
    blobColumns: ["bin"],
  };

  test("passes through plain values", () => {
    const result = processRow({ id: 1, name: "foo" }, { name: "plain" });
    expect(result).toEqual({ id: 1, name: "foo" });
  });

  test("converts NULL to null via ?? null", () => {
    const result = processRow({ id: 1, value: null }, { name: "nulls" });
    expect(result.value).toBeNull();
  });

  test("parses JSON TEXT column", () => {
    const result = processRow({ data: '{"a":1}' }, surface);
    expect(result.data).toEqual({ a: 1 });
  });

  test("keeps invalid JSON as string", () => {
    const result = processRow({ data: "not-json" }, surface);
    expect(result.data).toBe("not-json");
  });

  test("encodes BLOB as base64", () => {
    const buf = new Uint8Array([1, 2, 3]);
    const result = processRow({ bin: buf }, surface);
    expect(result.bin).toBe(Buffer.from(buf).toString("base64"));
  });

  test("null BLOB column stays null", () => {
    const result = processRow({ bin: null }, surface);
    expect(result.bin).toBeNull();
  });
});
