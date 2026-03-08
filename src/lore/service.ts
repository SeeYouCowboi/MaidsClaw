/**
 * LoreService — entry registry + keyword-triggered retrieval.
 *
 * This is the primary public API for the Shared Lore Canon module.
 * It loads entries from disk, stores them in memory, and provides
 * `getMatchingEntries(text, options?)` for prompt-time lookup.
 *
 * LoreService provides data only — prompt assembly is owned by T24
 * (Prompt Builder).
 */

import { join } from "path";

import type { LoreEntry, LoreScope } from "./entry-schema.js";
import { loadLoreEntries, type LoreLoadResult } from "./loader.js";
import { findMatchingEntries, type MatchOptions } from "./matcher.js";

export type LoreServiceOptions = {
  /** Root data directory. Lore files are read from `<dataDir>/lore/`. */
  dataDir: string;
};

export type LoreService = {
  /** Load all entries from disk. Safe to call multiple times (replaces). */
  loadAll(): LoreLoadResult;
  /** Find entries whose keywords match the given text. */
  getMatchingEntries(
    text: string,
    options?: { limit?: number; scope?: LoreScope | "all" },
  ): LoreEntry[];
  /** Return all registered entries (for debugging/admin). */
  getAllEntries(): LoreEntry[];
  /** Register an entry in memory (does not persist to disk). */
  registerEntry(entry: LoreEntry): void;
};

/**
 * Creates a new LoreService instance.
 */
export function createLoreService(options: LoreServiceOptions): LoreService {
  let entries: LoreEntry[] = [];
  const loreDir = join(options.dataDir, "lore");

  return {
    loadAll(): LoreLoadResult {
      const result = loadLoreEntries(loreDir);
      entries = result.entries;
      return result;
    },

    getMatchingEntries(
      text: string,
      matchOptions?: { limit?: number; scope?: LoreScope | "all" },
    ): LoreEntry[] {
      const opts: MatchOptions = {};
      if (matchOptions?.limit !== undefined) opts.limit = matchOptions.limit;
      if (matchOptions?.scope !== undefined) opts.scope = matchOptions.scope;
      return findMatchingEntries(text, entries, opts);
    },

    getAllEntries(): LoreEntry[] {
      return [...entries];
    },

    registerEntry(entry: LoreEntry): void {
      // Deduplicate by id — replace if exists, append otherwise
      const idx = entries.findIndex((e) => e.id === entry.id);
      if (idx >= 0) {
        entries[idx] = entry;
      } else {
        entries.push(entry);
      }
    },
  };
}
