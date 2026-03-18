/**
 * LoreLoader — loads lore canon entries from `data/lore/*.json` files.
 *
 * Each JSON file may contain either a single LoreEntry object or an array of
 * LoreEntry objects.  Invalid entries are skipped with a warning; a missing
 * data directory returns an empty array.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";

import type { LoreEntry } from "./entry-schema.js";
import { validateLoreEntry } from "./entry-schema.js";

export type LoreLoadResult = {
  entries: LoreEntry[];
  errors: Array<{ file: string; reason: string }>;
};

/**
 * Loads all lore entries from JSON files in `loreDir`.
 *
 * - Gracefully handles a missing directory (returns empty).
 * - Validates every entry against the schema; invalid entries are collected
 *   into `errors` but do not abort the load.
 */
export function loadLoreEntries(loreDir: string, configLorePath?: string): LoreLoadResult {
  const entries: LoreEntry[] = [];
  const errors: Array<{ file: string; reason: string }> = [];

  if (configLorePath && existsSync(configLorePath)) {
    let raw: unknown;
    const configFileName = basename(configLorePath);

    try {
      const text = readFileSync(configLorePath, "utf-8");
      raw = JSON.parse(text);
    } catch (err) {
      errors.push({
        file: configFileName,
        reason: `failed to read/parse: ${err instanceof Error ? err.message : String(err)}`,
      });
      return { entries, errors };
    }

    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of items) {
      const result = validateLoreEntry(item);
      if (result.ok) {
        entries.push(result.entry);
      } else {
        errors.push({ file: configFileName, reason: result.reason });
      }
    }

    return { entries, errors };
  }

  if (!existsSync(loreDir)) {
    return { entries, errors };
  }

  let fileNames: string[];
  try {
    fileNames = readdirSync(loreDir)
      .filter((f) => extname(f) === ".json");
  } catch {
    return { entries, errors };
  }

  for (const fileName of fileNames) {
    const filePath = join(loreDir, fileName);
    let raw: unknown;
    try {
      const text = readFileSync(filePath, "utf-8");
      raw = JSON.parse(text);
    } catch (err) {
      errors.push({
        file: fileName,
        reason: `failed to read/parse: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const items: unknown[] = Array.isArray(raw) ? raw : [raw];
    for (const item of items) {
      const result = validateLoreEntry(item);
      if (result.ok) {
        entries.push(result.entry);
      } else {
        errors.push({ file: fileName, reason: result.reason });
      }
    }
  }

  return { entries, errors };
}
