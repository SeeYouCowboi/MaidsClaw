import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureBackupDir, readJsonFile, writeJsonFileAtomic } from "../../src/config/atomic-writer.js";

const cleanupDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maidsclaw-atomic-writer-"));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("atomic writer", () => {
  it("writes deterministic JSON with trailing newline and creates backup", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "runtime.json");
    const value = {
      zeta: 1,
      alpha: {
        nested: true,
      },
    };

    await writeJsonFileAtomic(filePath, value);

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(content.endsWith("\n")).toBe(true);

    const backupPath = path.join(dir, ".backup", "runtime.json.bak");
    const backupContent = await fs.readFile(backupPath, "utf-8");
    expect(backupContent).toBe(content);

    const loaded = await readJsonFile<typeof value>(filePath);
    expect(loaded).toEqual(value);
  });

  it("updates target and backup on subsequent writes", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "personas.json");

    const first = { version: 1, items: ["a"] };
    const second = { version: 2, items: ["a", "b"] };

    await writeJsonFileAtomic(filePath, first);
    await writeJsonFileAtomic(filePath, second);

    const expected = `${JSON.stringify(second, null, 2)}\n`;
    const current = await fs.readFile(filePath, "utf-8");
    expect(current).toBe(expected);

    const backupPath = path.join(dir, ".backup", "personas.json.bak");
    const backup = await fs.readFile(backupPath, "utf-8");
    expect(backup).toBe(expected);
  });

  it("ensureBackupDir is idempotent and returns backup path", async () => {
    const dir = await makeTempDir();

    const first = await ensureBackupDir(dir);
    const second = await ensureBackupDir(dir);

    expect(first).toBe(path.join(dir, ".backup"));
    expect(second).toBe(first);

    const stat = await fs.stat(first);
    expect(stat.isDirectory()).toBe(true);
  });
});
