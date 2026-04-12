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
  return (
    code === "EPERM" ||
    code === "ENOTSUP" ||
    code === "ENOSYS" ||
    code === "EINVAL"
  );
}

async function cleanupTmpFile(tmpPath: string): Promise<void> {
  try {
    await fs.rm(tmpPath, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

function formatBackupTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replace(/:/g, "-");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function validateWrittenJson(filePath: string): Promise<void> {
  const written = await fs.readFile(filePath, "utf-8");
  JSON.parse(written);
}

async function restorePreviousFile(options: {
  filePath: string;
  backupPath?: string;
  hadPreviousFile: boolean;
}): Promise<void> {
  if (options.hadPreviousFile && options.backupPath) {
    await fs.copyFile(options.backupPath, options.filePath);
    return;
  }

  await fs.rm(options.filePath, { force: true });
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
    throw new Error(
      `Failed to read JSON file ${filePath}: ${getErrorMessage(error)}`,
    );
  }

  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${getErrorMessage(error)}`);
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  data: unknown,
): Promise<void> {
  // 1) Serialize with deterministic formatting (+ trailing newline)
  let serialized: string;
  try {
    serialized = `${JSON.stringify(data, null, 2)}\n`;
  } catch (error) {
    throw new Error(
      `Failed to serialize JSON for ${filePath}: ${getErrorMessage(error)}`,
    );
  }

  // 2) Round-trip parse validation
  try {
    JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      `Serialized JSON validation failed for ${filePath}: ${getErrorMessage(error)}`,
    );
  }

  // 3) Determine tmp path
  const tmpPath = `${filePath}.tmp`;

  // 4) Determine backup dir
  const backupDir = path.join(path.dirname(filePath), ".backup");
  const backupBaseName = path.parse(filePath).name;

  let hadPreviousFile = false;
  let backupPath: string | undefined;
  let destinationMayHaveChanged = false;

  try {
    // 5) Ensure backup dir exists (idempotent)
    await fs.mkdir(backupDir, { recursive: true });

    // 6) Backup previous on-disk file before replacing it
    hadPreviousFile = await fileExists(filePath);
    if (hadPreviousFile) {
      const timestamp = formatBackupTimestamp(new Date());
      backupPath = path.join(backupDir, `${backupBaseName}-${timestamp}.bak`);
      await fs.copyFile(filePath, backupPath);
    }

    // 7) Write to temp file
    await fs.writeFile(tmpPath, serialized, "utf-8");

    // 8) Flush/fsync temp file
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

    // 9) Atomic replace with Windows-compatible fallback
    try {
      await fs.rename(tmpPath, filePath);
      destinationMayHaveChanged = true;
    } catch (renameError) {
      if (!isWindowsReplaceRenameError(renameError)) {
        throw renameError;
      }

      await fs.rm(filePath, { force: true });
      await fs.rename(tmpPath, filePath);
      destinationMayHaveChanged = true;
    }

    // 10) Validate persisted file can be parsed back.
    try {
      await validateWrittenJson(filePath);
    } catch (validationError) {
      throw new Error(
        `Post-write JSON validation failed for ${filePath}: ${getErrorMessage(validationError)}`,
      );
    }
  } catch (error) {
    // 11) Cleanup temp file on any failure after tmp path determination
    await cleanupTmpFile(tmpPath);

    if (destinationMayHaveChanged) {
      try {
        await restorePreviousFile({
          filePath,
          backupPath,
          hadPreviousFile,
        });
      } catch (restoreError) {
        throw new Error(
          `Failed to restore previous JSON after write failure for ${filePath}: ${getErrorMessage(restoreError)} (original error: ${getErrorMessage(error)})`,
        );
      }
    }

    throw error;
  }
}
