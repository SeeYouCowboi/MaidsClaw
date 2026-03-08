import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, extname, dirname } from "path";

export type FileStore = {
  readJson<T>(relativePath: string): T | undefined;
  listFiles(relativeDir: string, options?: { extension?: string }): string[];
  exists(relativePath: string): boolean;
  writeJson(relativePath: string, data: unknown): void;
};

export function createFileStore(root: string): FileStore {
  return {
    readJson<T>(relativePath: string): T | undefined {
      const fullPath = join(root, relativePath);
      if (!existsSync(fullPath)) {
        return undefined;
      }
      try {
        const raw = readFileSync(fullPath, "utf-8");
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    },

    listFiles(relativeDir: string, options?: { extension?: string }): string[] {
      const fullDir = join(root, relativeDir);
      if (!existsSync(fullDir)) {
        return [];
      }
      const entries = readdirSync(fullDir, { withFileTypes: true });
      let files = entries.filter((e) => e.isFile()).map((e) => e.name);
      if (options?.extension) {
        const ext = options.extension.startsWith(".")
          ? options.extension
          : `.${options.extension}`;
        files = files.filter((f) => extname(f) === ext);
      }
      return files;
    },

    exists(relativePath: string): boolean {
      return existsSync(join(root, relativePath));
    },

    writeJson(relativePath: string, data: unknown): void {
      const fullPath = join(root, relativePath);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(fullPath, JSON.stringify(data, null, 2), "utf-8");
    },
  };
}
