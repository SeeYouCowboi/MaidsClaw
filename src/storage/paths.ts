import { join, resolve } from "path";
import { existsSync, mkdirSync } from "fs";

export type StoragePaths = {
  storageRoot: string;
  dataDir: string;
  personasDir: string;
  loreDir: string;
  attachmentsDir: string;
};

export function resolveStoragePaths(options: {
  storageRoot?: string;
  dataDir?: string;
}): StoragePaths {
  const storageRoot = resolve(options.storageRoot ?? "./data");
  const dataDir = options.dataDir ? resolve(options.dataDir) : storageRoot;

  return {
    storageRoot,
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
