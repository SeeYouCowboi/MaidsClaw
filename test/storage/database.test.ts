import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { openDatabase, closeDatabaseGracefully } from "../../src/storage/database.js";
import { runMigrations, initMigrationsTable, isMigrationApplied } from "../../src/storage/migrations.js";
import { createFileStore } from "../../src/storage/file-store.js";
import type { Db, MigrationStep } from "../../src/storage/index.js";

// Use in-memory database for tests
const IN_MEMORY = ":memory:";

describe("Database", () => {
  it("happy path: opens in WAL mode with foreign keys", () => {
    // WAL mode requires a file-based database, not :memory:
    const tmpDir = join(import.meta.dir, `../../.tmp-wal-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const dbPath = join(tmpDir, "wal-test.db");

    const db = openDatabase({ path: dbPath });

    const walResult = db.get<{ journal_mode: string }>("PRAGMA journal_mode");
    expect(walResult?.journal_mode).toBe("wal");

    const fkResult = db.get<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(fkResult?.foreign_keys).toBe(1);

    db.close();

    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("migration runner: applies steps idempotently", () => {
    const db = openDatabase({ path: IN_MEMORY });

    const steps: MigrationStep[] = [
      {
        id: "test:001:create-foo",
        description: "Create test table",
        up: (db) => {
          db.exec("CREATE TABLE foo (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
        },
      },
    ];

    const applied1 = runMigrations(db, steps);
    expect(applied1).toEqual(["test:001:create-foo"]);

    // Run again — should skip already-applied
    const applied2 = runMigrations(db, steps);
    expect(applied2).toEqual([]); // Nothing applied second time

    db.close();
  });

  it("error path: duplicate migration step is skipped, not rejected", () => {
    const db = openDatabase({ path: IN_MEMORY });

    const steps: MigrationStep[] = [
      {
        id: "test:dup",
        description: "Duplicate step",
        up: (db) => {
          db.exec("CREATE TABLE bar (id INTEGER PRIMARY KEY)");
        },
      },
    ];

    runMigrations(db, steps);
    // Second call should NOT throw
    let threw1 = false;
    try {
      runMigrations(db, steps);
    } catch {
      threw1 = true;
    }
    expect(threw1).toBe(false);

    db.close();
  });

  it("FTS5 verification: ENABLE_FTS5 is available", () => {
    const db = openDatabase({ path: IN_MEMORY });

    const result = db.get<{ "sqlite_compileoption_used('ENABLE_FTS5')": number }>(
      "SELECT sqlite_compileoption_used('ENABLE_FTS5')",
    );
    const fts5Available = Object.values(result ?? {})[0];
    expect(fts5Available).toBe(1);

    db.close();
  });

  it("FTS5 trigram tokenizer: creates successfully", () => {
    const db = openDatabase({ path: IN_MEMORY });

    // This proves downstream search prerequisites are available
    let threw2 = false;
    try {
      db.exec("CREATE VIRTUAL TABLE test_fts USING fts5(content, tokenize='trigram')");
    } catch {
      threw2 = true;
    }
    expect(threw2).toBe(false);

    db.close();
  });

  it("transactions: rollback on error", () => {
    const db = openDatabase({ path: IN_MEMORY });
    db.exec("CREATE TABLE txn_test (id INTEGER PRIMARY KEY, val TEXT)");

    // Successful transaction
    db.transaction(() => {
      db.run("INSERT INTO txn_test VALUES (1, 'hello')");
    });

    const row = db.get<{ val: string }>("SELECT val FROM txn_test WHERE id=1");
    expect(row?.val).toBe("hello");

    // Failed transaction should rollback
    try {
      db.transaction(() => {
        db.run("INSERT INTO txn_test VALUES (2, 'world')");
        throw new Error("Intentional rollback");
      });
    } catch {
      // Expected
    }

    const row2 = db.get<{ val: string }>("SELECT val FROM txn_test WHERE id=2");
    expect(row2).toBeUndefined();

    db.close();
  });

  it("closeDatabaseGracefully: does not throw on double close", () => {
    const db = openDatabase({ path: IN_MEMORY });
    closeDatabaseGracefully(db);
    // Second close should not throw
    let threw3 = false;
    try {
      closeDatabaseGracefully(db);
    } catch {
      threw3 = true;
    }
    expect(threw3).toBe(false);
  });

  it("isMigrationApplied: returns correct boolean", () => {
    const db = openDatabase({ path: IN_MEMORY });
    initMigrationsTable(db);

    expect(isMigrationApplied(db, "nonexistent")).toBe(false);

    runMigrations(db, [
      {
        id: "check:001",
        description: "Check migration",
        up: (db) => {
          db.exec("CREATE TABLE check_tbl (id INTEGER PRIMARY KEY)");
        },
      },
    ]);

    expect(isMigrationApplied(db, "check:001")).toBe(true);

    db.close();
  });

  it("query: returns multiple rows", () => {
    const db = openDatabase({ path: IN_MEMORY });
    db.exec("CREATE TABLE multi (id INTEGER PRIMARY KEY, name TEXT)");
    db.run("INSERT INTO multi VALUES (1, 'alice')", []);
    db.run("INSERT INTO multi VALUES (2, 'bob')", []);

    const rows = db.query<{ id: number; name: string }>("SELECT * FROM multi ORDER BY id");
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("alice");
    expect(rows[1].name).toBe("bob");

    db.close();
  });

  it("run: returns changes count", () => {
    const db = openDatabase({ path: IN_MEMORY });
    db.exec("CREATE TABLE counter (id INTEGER PRIMARY KEY, val INTEGER)");
    db.run("INSERT INTO counter VALUES (1, 10)", []);
    db.run("INSERT INTO counter VALUES (2, 20)", []);

    const result = db.run("UPDATE counter SET val = val + 1", []);
    expect(result.changes).toBe(2);

    db.close();
  });
});

describe("FileStore", () => {
  it("writeJson and readJson round-trip", () => {
    // Use a temp dir via Bun
    const tmpDir = `${import.meta.dir}/../../.tmp-test-filestore-${Date.now()}`;
    const store = createFileStore(tmpDir);

    const testData = { hello: "world", count: 42 };
    store.writeJson("test/data.json", testData);

    const loaded = store.readJson<{ hello: string; count: number }>("test/data.json");
    expect(loaded).toEqual(testData);

    // Cleanup
    const { rmSync } = require("fs");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("readJson returns undefined for missing file", () => {
    const store = createFileStore("/nonexistent-dir-xyz");
    expect(store.readJson("missing.json")).toBeUndefined();
  });

  it("exists returns correct boolean", () => {
    const tmpDir = `${import.meta.dir}/../../.tmp-test-filestore-exists-${Date.now()}`;
    const store = createFileStore(tmpDir);

    expect(store.exists("nope.json")).toBe(false);
    store.writeJson("yep.json", { ok: true });
    expect(store.exists("yep.json")).toBe(true);

    const { rmSync } = require("fs");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("listFiles with extension filter", () => {
    const tmpDir = `${import.meta.dir}/../../.tmp-test-filestore-list-${Date.now()}`;
    const store = createFileStore(tmpDir);

    store.writeJson("items/a.json", {});
    store.writeJson("items/b.json", {});
    store.writeJson("items/c.txt", "text");

    const jsonFiles = store.listFiles("items", { extension: ".json" });
    expect(jsonFiles).toHaveLength(2);
    expect(jsonFiles.sort()).toEqual(["a.json", "b.json"]);

    const allFiles = store.listFiles("items");
    expect(allFiles).toHaveLength(3);

    const { rmSync } = require("fs");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("listFiles returns empty for missing directory", () => {
    const store = createFileStore("/nonexistent-dir-xyz");
    expect(store.listFiles("missing")).toEqual([]);
  });
});
