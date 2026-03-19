import { describe, expect, it, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AreaHierarchyService } from "./area-hierarchy.js";
import { runMemoryMigrations } from "./schema.js";
import { openDatabase } from "../storage/database.js";

function createTempDb() {
  const dbPath = join(tmpdir(), `maidsclaw-hierarchy-${randomUUID()}.db`);
  const db = openDatabase({ path: dbPath });
  runMemoryMigrations(db);
  return { dbPath, db };
}

function cleanupDb(dbPath: string): void {
  try {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  } catch {}
}

describe("AreaHierarchyService", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDatabase>;
  let hierarchy: AreaHierarchyService;

  function setup() {
    const tmp = createTempDb();
    dbPath = tmp.dbPath;
    db = tmp.db;
    hierarchy = new AreaHierarchyService(db);

    // Create some area entities for FK references
    const now = Date.now();
    for (const id of [1, 5, 10, 11, 20]) {
      db.prepare(
        `INSERT OR IGNORE INTO entity_nodes (id, pointer_key, display_name, entity_type, memory_scope, created_at, updated_at)
         VALUES (?, ?, ?, 'place', 'shared_public', ?, ?)`,
      ).run(id, `area_${id}`, `Area ${id}`, now, now);
    }
  }

  afterEach(() => {
    db?.close();
    cleanupDb(dbPath);
  });

  it("getParent returns null for unregistered area", () => {
    setup();
    expect(hierarchy.getParent(999)).toBeNull();
  });

  it("setParent and getParent work correctly", () => {
    setup();
    hierarchy.setParent(10, 5);
    expect(hierarchy.getParent(10)).toBe(5);
  });

  it("setParent with null creates a root area", () => {
    setup();
    hierarchy.setParent(1, null);
    expect(hierarchy.getParent(1)).toBeNull();
  });

  it("getAncestors returns empty for root area", () => {
    setup();
    hierarchy.setParent(1, null);
    expect(hierarchy.getAncestors(1)).toEqual([]);
  });

  it("getAncestors walks up the tree", () => {
    setup();
    // Kitchen (10) → Service Wing (5) → Mansion (1)
    hierarchy.setParent(1, null);
    hierarchy.setParent(5, 1);
    hierarchy.setParent(10, 5);

    expect(hierarchy.getAncestors(10)).toEqual([5, 1]);
    expect(hierarchy.getAncestors(5)).toEqual([1]);
    expect(hierarchy.getAncestors(1)).toEqual([]);
  });

  it("getVisibleAreaIds includes self + ancestors", () => {
    setup();
    hierarchy.setParent(1, null);
    hierarchy.setParent(5, 1);
    hierarchy.setParent(10, 5);

    expect(hierarchy.getVisibleAreaIds(10)).toEqual([10, 5, 1]);
    expect(hierarchy.getVisibleAreaIds(5)).toEqual([5, 1]);
    expect(hierarchy.getVisibleAreaIds(1)).toEqual([1]);
  });

  it("getVisibleAreaIds for unregistered area returns singleton", () => {
    setup();
    expect(hierarchy.getVisibleAreaIds(99)).toEqual([99]);
  });

  it("getChildren returns direct children", () => {
    setup();
    hierarchy.setParent(1, null);
    hierarchy.setParent(5, 1);
    hierarchy.setParent(10, 5);
    hierarchy.setParent(11, 5);

    expect(hierarchy.getChildren(5).sort()).toEqual([10, 11]);
    expect(hierarchy.getChildren(1)).toEqual([5]);
    expect(hierarchy.getChildren(10)).toEqual([]);
  });

  it("setParent can update an existing parent", () => {
    setup();
    hierarchy.setParent(10, 5);
    expect(hierarchy.getParent(10)).toBe(5);

    hierarchy.setParent(10, 1);
    expect(hierarchy.getParent(10)).toBe(1);
  });
});
