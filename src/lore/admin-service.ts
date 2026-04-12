/**
 * LoreAdminService — file-backed CRUD for the lore canon.
 *
 * Reads from a reloadable snapshot, writes via atomic JSON writer,
 * and triggers reload after every mutation so the live LoreService
 * picks up the change on the next prompt-assembly request.
 */

import { readFile } from "node:fs/promises";
import { writeJsonFileAtomic } from "../config/atomic-writer.js";
import {
  createReloadable,
  type ReloadableSnapshot,
} from "../config/reloadable.js";
import { MaidsClawError } from "../core/errors.js";
import type { LoreEntry, LoreScope } from "./entry-schema.js";
import { validateLoreEntry } from "./entry-schema.js";
import type { LoreService } from "./service.js";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

// ── Public types ─────────────────────────────────────────────────────────────

export type LoreAdminServiceOptions = {
  /** Absolute path to config/lore.json. */
  configPath: string;
  loreService?: LoreService;
  onWriteSuccess?: () => Promise<void> | void;
};

export type LoreListFilters = {
  scope?: LoreScope;
  keyword?: string;
};

export type LoreAdminService = {
  listLore(filters?: LoreListFilters): Promise<LoreEntryDto[]>;
  getLore(id: string): Promise<LoreEntryDto | null>;
  createLore(data: unknown): Promise<LoreEntryDto>;
  updateLore(id: string, data: unknown): Promise<LoreEntryDto>;
  deleteLore(id: string): Promise<void>;
  reloadLore(): Promise<{ reloaded: true; count: number }>;
  getSnapshot(): { version: number; entries: LoreEntryDto[] };
};

// ── Wire DTO (snake_case) ────────────────────────────────────────────────────

export type LoreEntryDto = {
  id: string;
  title: string;
  keywords: string[];
  content: string;
  scope: LoreScope;
  priority: number;
  enabled: boolean;
  tags: string[];
};

function toDto(entry: LoreEntry): LoreEntryDto {
  return {
    id: entry.id,
    title: entry.title,
    keywords: entry.keywords,
    content: entry.content,
    scope: entry.scope,
    priority: entry.priority ?? 0,
    enabled: entry.enabled,
    tags: entry.tags ?? [],
  };
}

// ── Snapshot loader ──────────────────────────────────────────────────────────

async function loadEntries(configPath: string): Promise<readonly LoreEntry[]> {
  let rawText: string;
  try {
    rawText = await readFile(configPath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // File missing → empty canon
      return [];
    }
    throw new Error(
      `Failed to read lore config ${configPath}: ${getErrorMessage(error)}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `Invalid JSON in lore config ${configPath}: ${getErrorMessage(error)}`,
    );
  }

  const items = Array.isArray(raw) ? raw : [raw];
  const entries: LoreEntry[] = [];
  for (const item of items) {
    const result = validateLoreEntry(item);
    if (result.ok) {
      entries.push(result.entry);
    }
  }
  return entries;
}

// ── Sorting ──────────────────────────────────────────────────────────────────

function sortEntries(entries: LoreEntryDto[]): LoreEntryDto[] {
  return entries.sort((a, b) => {
    const pDiff = b.priority - a.priority;
    if (pDiff !== 0) return pDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createLoreAdminService(
  options: LoreAdminServiceOptions,
): LoreAdminService {
  const { configPath } = options;

  const snapshot: ReloadableSnapshot<readonly LoreEntry[]> = createReloadable({
    initial: [] as readonly LoreEntry[],
    load: () => loadEntries(configPath),
  });

  let initialLoadDone = false;

  async function reloadLore(): Promise<{ reloaded: true; count: number }> {
    const result = await snapshot.reload();
    if (!result.ok) {
      throw new MaidsClawError({
        code: "INTERNAL_ERROR",
        message: `Failed to reload lore: ${result.error.message}`,
        retriable: false,
        details: {
          reason: "LORE_LOAD_FAILED",
          error_code: "LORE_RELOAD_FAILED",
          cause: result.error,
        },
      });
    }

    initialLoadDone = true;
    return { reloaded: true, count: result.snapshot.length };
  }

  async function ensureLoaded(): Promise<readonly LoreEntry[]> {
    if (!initialLoadDone) {
      await reloadLore();
    }
    return snapshot.get();
  }

  async function persist(entries: LoreEntry[]): Promise<void> {
    await writeJsonFileAtomic(configPath, entries);
    try {
      options.loreService?.loadAll();
    } catch (error) {
      throw new MaidsClawError({
        code: "INTERNAL_ERROR",
        message: `Failed to reload runtime lore snapshot: ${getErrorMessage(error)}`,
        retriable: false,
        details: {
          error_code: "LORE_RUNTIME_RELOAD_FAILED",
          cause: error,
        },
      });
    }
    await reloadLore();
    await options.onWriteSuccess?.();
  }

  return {
    async listLore(filters?: LoreListFilters): Promise<LoreEntryDto[]> {
      const entries = await ensureLoaded();
      let result = entries.map(toDto);

      if (filters?.scope) {
        result = result.filter((e) => e.scope === filters.scope);
      }

      if (filters?.keyword) {
        const needle = filters.keyword.toLowerCase();
        result = result.filter(
          (e) =>
            e.keywords.some((k) => k.toLowerCase().includes(needle)) ||
            e.title.toLowerCase().includes(needle),
        );
      }

      return sortEntries(result);
    },

    async getLore(id: string): Promise<LoreEntryDto | null> {
      const entries = await ensureLoaded();
      const found = entries.find((e) => e.id === id);
      return found ? toDto(found) : null;
    },

    getSnapshot(): { version: number; entries: LoreEntryDto[] } {
      const currentSnapshot = snapshot.getSnapshot();
      return {
        version: currentSnapshot.version,
        entries: currentSnapshot.snapshot.map(toDto),
      };
    },

    reloadLore,

    async createLore(data: unknown): Promise<LoreEntryDto> {
      const validated = validateLoreEntry(data);
      if (!validated.ok) {
        throw new MaidsClawError({
          code: "BAD_REQUEST",
          message: validated.reason,
          retriable: false,
          details: {
            error_code: "LORE_ENTRY_INVALID",
          },
        });
      }

      const entries = [...(await ensureLoaded())];
      if (entries.some((e) => e.id === validated.entry.id)) {
        throw new MaidsClawError({
          code: "CONFLICT",
          message: `Lore entry already exists: ${validated.entry.id}`,
          retriable: false,
          details: {
            error_code: "LORE_ALREADY_EXISTS",
            lore_id: validated.entry.id,
          },
        });
      }

      entries.push(validated.entry);
      await persist(entries);
      return toDto(validated.entry);
    },

    async updateLore(id: string, data: unknown): Promise<LoreEntryDto> {
      const validated = validateLoreEntry(data);
      if (!validated.ok) {
        throw new MaidsClawError({
          code: "BAD_REQUEST",
          message: validated.reason,
          retriable: false,
          details: {
            error_code: "LORE_ENTRY_INVALID",
          },
        });
      }

      if (validated.entry.id !== id) {
        throw new MaidsClawError({
          code: "BAD_REQUEST",
          message: `Body id '${validated.entry.id}' does not match path id '${id}'`,
          retriable: false,
          details: {
            error_code: "LORE_ID_MISMATCH",
            path_id: id,
            payload_id: validated.entry.id,
          },
        });
      }

      const entries = [...(await ensureLoaded())];
      const idx = entries.findIndex((e) => e.id === id);
      if (idx < 0) {
        throw new MaidsClawError({
          code: "BAD_REQUEST",
          message: `Lore entry not found: ${id}`,
          retriable: false,
          details: {
            error_code: "LORE_NOT_FOUND",
            status: 404,
            lore_id: id,
          },
        });
      }

      entries[idx] = validated.entry;
      await persist(entries);
      return toDto(validated.entry);
    },

    async deleteLore(id: string): Promise<void> {
      const entries = [...(await ensureLoaded())];
      const idx = entries.findIndex((e) => e.id === id);
      if (idx < 0) {
        throw new MaidsClawError({
          code: "BAD_REQUEST",
          message: `Lore entry not found: ${id}`,
          retriable: false,
          details: {
            error_code: "LORE_NOT_FOUND",
            status: 404,
            lore_id: id,
          },
        });
      }

      entries.splice(idx, 1);
      await persist(entries);
    },
  };
}
