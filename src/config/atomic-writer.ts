import * as fs from "node:fs/promises";
import * as path from "node:path";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function isWindowsReplaceRenameError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}

function isFsyncNotSupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS" || code === "EINVAL";
}

async function cleanupTmpFile(tmpPath: string): Promise<void> {
  try {
    await fs.rm(tmpPath, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

export async function ensureBackupDir(configDir: string): Promise<string> {
  const backupDir = path.join(configDir, ".backup");
  await fs.mkdir(backupDir, { recursive: true });
  return backupDir;
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`JSON file not found: ${filePath}`);
    }
    throw new Error(`Failed to read JSON file ${filePath}: ${getErrorMessage(error)}`);
  }

  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${getErrorMessage(error)}`);
  }
}

export async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  // 1) Serialize with deterministic formatting (+ trailing newline)
  let serialized: string;
  try {
    serialized = `${JSON.stringify(data, null, 2)}\n`;
  } catch (error) {
    throw new Error(`Failed to serialize JSON for ${filePath}: ${getErrorMessage(error)}`);
  }

  // 2) Round-trip parse validation
  try {
    JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Serialized JSON validation failed for ${filePath}: ${getErrorMessage(error)}`);
  }

  // 3) Determine tmp path
  const tmpPath = `${filePath}.tmp`;

  // 4) Determine backup dir
  const backupDir = path.join(path.dirname(filePath), ".backup");

  try {
    // 5) Ensure backup dir exists (idempotent)
    await fs.mkdir(backupDir, { recursive: true });

    // 6) Write to temp file
    await fs.writeFile(tmpPath, serialized, "utf-8");

    // 7) Flush/fsync temp file
    const handle = await fs.open(tmpPath, "r+");
    try {
      try {
        await handle.datasync();
      } catch (error) {
        if (!isFsyncNotSupportedError(error)) {
          throw error;
        }

        try {
          await handle.sync();
        } catch (syncError) {
          if (!isFsyncNotSupportedError(syncError)) {
            throw syncError;
          }
        }
      }
    } finally {
      await handle.close();
    }

    // 8) Create/update backup from temp
    const backupPath = path.join(backupDir, `${path.basename(filePath)}.bak`);
    await fs.copyFile(tmpPath, backupPath);

    // 9) Atomic replace with Windows-compatible fallback
    try {
      await fs.rename(tmpPath, filePath);
    } catch (renameError) {
      if (!isWindowsReplaceRenameError(renameError)) {
        throw renameError;
      }

      await fs.rm(filePath, { force: true });
      await fs.rename(tmpPath, filePath);
    }
  } catch (error) {
    // 10) Cleanup temp file on any failure after tmp path determination
    await cleanupTmpFile(tmpPath);
    throw error;
  }
}
