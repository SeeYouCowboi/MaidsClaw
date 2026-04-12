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

import { join } from "node:path";
import { createReloadable, type ReloadResult } from "../config/reloadable.js";
import type { LoreEntry, LoreScope } from "./entry-schema.js";
import { type LoreLoadResult, loadLoreEntries } from "./loader.js";
import { findMatchingEntries, type MatchOptions } from "./matcher.js";

export type LoreServiceSnapshot = {
  version: number;
  entries: readonly LoreEntry[];
};

export type LoreServiceOptions = {
  /** Root data directory. Lore files are read from `<dataDir>/lore/`. */
  dataDir: string;
  configLorePath?: string;
};

export type LoreService = {
  /** Load all entries from disk. Safe to call multiple times (replaces). */
  loadAll(): LoreLoadResult;
  /** Reload lore entries with snapshot-swap semantics. */
  reload(): Promise<ReloadResult<readonly LoreEntry[]>>;
  /** Find entries whose keywords match the given text. */
  getMatchingEntries(
    text: string,
    options?: { limit?: number; scope?: LoreScope | "all" },
  ): LoreEntry[];
  /** Return all registered entries (for debugging/admin). */
  getAllEntries(): LoreEntry[];
  /** Register an entry in memory (does not persist to disk). */
  registerEntry(entry: LoreEntry): void;
  getSnapshot(): LoreServiceSnapshot;
};

/**
 * Creates a new LoreService instance.
 */
export function createLoreService(options: LoreServiceOptions): LoreService {
  const loreDir = join(options.dataDir, "lore");

  function createEntriesReloadable(initial: readonly LoreEntry[]) {
    return createReloadable<readonly LoreEntry[]>({
      initial,
      load: async () => {
        const result = loadLoreEntries(loreDir, options.configLorePath);
        return result.entries;
      },
    });
  }

  let snapshot = createEntriesReloadable([]);

  return {
    loadAll(): LoreLoadResult {
      const result = loadLoreEntries(loreDir, options.configLorePath);
      snapshot = createEntriesReloadable(result.entries);
      return result;
    },

    reload(): Promise<ReloadResult<readonly LoreEntry[]>> {
      return snapshot.reload();
    },

    getMatchingEntries(
      text: string,
      matchOptions?: { limit?: number; scope?: LoreScope | "all" },
    ): LoreEntry[] {
      const opts: MatchOptions = {};
      if (matchOptions?.limit !== undefined) opts.limit = matchOptions.limit;
      if (matchOptions?.scope !== undefined) opts.scope = matchOptions.scope;
      return findMatchingEntries(text, snapshot.get(), opts);
    },

    getAllEntries(): LoreEntry[] {
      return [...snapshot.get()];
    },

    registerEntry(entry: LoreEntry): void {
      // Deduplicate by id — replace if exists, append otherwise
      const nextEntries = [...snapshot.get()];
      const idx = nextEntries.findIndex((e) => e.id === entry.id);
      if (idx >= 0) {
        nextEntries[idx] = entry;
      } else {
        nextEntries.push(entry);
      }
      snapshot = createEntriesReloadable(nextEntries);
    },

    getSnapshot(): LoreServiceSnapshot {
      const currentSnapshot = snapshot.getSnapshot();
      return {
        version: currentSnapshot.version,
        entries: [...currentSnapshot.snapshot],
      };
    },
  };
}
