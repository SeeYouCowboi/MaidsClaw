/**
 * Shared Lore Canon entry schema.
 *
 * LoreEntry is the canonical shape for authored world-rule entries stored
 * under `data/lore/*.json`.  Entries are keyword-triggered and read-only
 * at runtime — the lore canon is authoritative for authored canon, world
 * rules, and static definitions.
 */

/** Scope of a lore entry — world-level or area-level. */
export type LoreScope = "world" | "area";

/** A single lore canon entry as persisted on disk. */
export type LoreEntry = {
  /** Unique identifier for this entry. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Keywords that trigger this entry during prompt assembly. */
  keywords: string[];
  /** The canonical lore text injected into prompts. */
  content: string;
  /** Whether this entry applies world-wide or to a specific area. */
  scope: LoreScope;
  /** Higher-priority entries are injected first (descending sort). */
  priority?: number;
  /** Whether the entry is active. Disabled entries are never matched. */
  enabled: boolean;
  /** Optional classification tags for filtering/debugging. */
  tags?: string[];
};

/**
 * Validates that `raw` conforms to the LoreEntry shape.
 * Returns `{ ok: true, entry }` on success, `{ ok: false, reason }` on failure.
 */
export function validateLoreEntry(
  raw: unknown,
): { ok: true; entry: LoreEntry } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, reason: "entry must be a non-null object" };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.id !== "string" || obj.id.length === 0) {
    return { ok: false, reason: "entry.id must be a non-empty string" };
  }
  if (typeof obj.title !== "string" || obj.title.length === 0) {
    return { ok: false, reason: "entry.title must be a non-empty string" };
  }
  if (!Array.isArray(obj.keywords) || obj.keywords.length === 0) {
    return { ok: false, reason: "entry.keywords must be a non-empty string array" };
  }
  if (!obj.keywords.every((k: unknown) => typeof k === "string" && k.length > 0)) {
    return { ok: false, reason: "every keyword must be a non-empty string" };
  }
  if (typeof obj.content !== "string" || obj.content.length === 0) {
    return { ok: false, reason: "entry.content must be a non-empty string" };
  }
  if (obj.scope !== "world" && obj.scope !== "area") {
    return { ok: false, reason: "entry.scope must be 'world' or 'area'" };
  }
  if (obj.priority !== undefined && typeof obj.priority !== "number") {
    return { ok: false, reason: "entry.priority must be a number if provided" };
  }
  if (typeof obj.enabled !== "boolean") {
    return { ok: false, reason: "entry.enabled must be a boolean" };
  }
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || !obj.tags.every((t: unknown) => typeof t === "string")) {
      return { ok: false, reason: "entry.tags must be a string array if provided" };
    }
  }

  return {
    ok: true,
    entry: {
      id: obj.id as string,
      title: obj.title as string,
      keywords: obj.keywords as string[],
      content: obj.content as string,
      scope: obj.scope as LoreScope,
      priority: obj.priority as number | undefined,
      enabled: obj.enabled as boolean,
      tags: obj.tags as string[] | undefined,
    },
  };
}
