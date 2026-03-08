import { join, resolve } from "path";
import { existsSync, mkdirSync } from "fs";

export type StoragePaths = {
  storageRoot: string;
  databasePath: string;
  dataDir: string;
  personasDir: string;
  loreDir: string;
  attachmentsDir: string;
};

// Defaults: storageRoot=./data, databasePath=<root>/maidsclaw.db, dataDir=<root>
export function resolveStoragePaths(options: {
  storageRoot?: string;
  databasePath?: string;
  dataDir?: string;
}): StoragePaths {
  const storageRoot = resolve(options.storageRoot ?? "./data");
  const dataDir = options.dataDir ? resolve(options.dataDir) : storageRoot;
  const databasePath = options.databasePath
    ? resolve(options.databasePath)
    : join(storageRoot, "maidsclaw.db");

  return {
    storageRoot,
    databasePath,
    dataDir,
    personasDir: join(dataDir, "personas"),
    loreDir: join(dataDir, "lore"),
    attachmentsDir: join(dataDir, "attachments"),
  };
}

export function ensureDirectoryExists(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}
