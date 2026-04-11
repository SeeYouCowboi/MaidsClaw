import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeJsonFileAtomic } from "../../src/config/atomic-writer.js";

const cleanupDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maidsclaw-atomic-writer-rollback-"));
  cleanupDirs.push(dir);
  return dir;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("atomic writer rollback safety", () => {
  it("keeps original file unchanged when serialization validation fails", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "auth.json");
    const original = `${JSON.stringify({ stable: true }, null, 2)}\n`;
    await fs.writeFile(filePath, original, "utf-8");

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(writeJsonFileAtomic(filePath, circular)).rejects.toThrow();

    const after = await fs.readFile(filePath, "utf-8");
    expect(after).toBe(original);
    expect(await pathExists(`${filePath}.tmp`)).toBe(false);
  });

  it("cleans up tmp file when rename fails", async () => {
    const dir = await makeTempDir();
    const targetDirectoryPath = path.join(dir, "runtime.json");
    await fs.mkdir(targetDirectoryPath, { recursive: true });

    await expect(writeJsonFileAtomic(targetDirectoryPath, { ok: false })).rejects.toThrow();

    const stat = await fs.stat(targetDirectoryPath);
    expect(stat.isDirectory()).toBe(true);
    expect(await pathExists(`${targetDirectoryPath}.tmp`)).toBe(false);
  });
});
