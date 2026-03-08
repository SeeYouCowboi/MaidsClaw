/**
 * LoreMatcher — keyword-triggered entry selection.
 *
 * Uses `matchKeywords` from `src/core/native.ts` which provides Aho-Corasick
 * multi-pattern matching when the native module is available, with a TS
 * fallback otherwise.
 */

import { matchKeywords } from "../core/native.js";
import type { LoreEntry, LoreScope } from "./entry-schema.js";

export type MatchOptions = {
  /** Filter by scope. Defaults to matching all scopes. */
  scope?: LoreScope | "all";
  /** Maximum number of entries to return. */
  limit?: number;
};

/**
 * Returns lore entries whose keywords appear in `text`.
 *
 * Only enabled entries are considered. Results are sorted by priority
 * (descending, higher first); entries without a priority default to 0.
 * The optional `limit` caps the result count.
 */
export function findMatchingEntries(
  text: string,
  entries: readonly LoreEntry[],
  options?: MatchOptions,
): LoreEntry[] {
  const scopeFilter = options?.scope ?? "all";
  const limit = options?.limit;

  const loweredText = text.toLowerCase();

  const matched: LoreEntry[] = [];

  for (const entry of entries) {
    // Skip disabled entries
    if (!entry.enabled) continue;

    // Scope filter
    if (scopeFilter !== "all" && entry.scope !== scopeFilter) continue;

    // Keyword matching via native Aho-Corasick / TS fallback
    const loweredKeywords = entry.keywords.map((k) => k.toLowerCase());
    const hits = matchKeywords(loweredText, loweredKeywords);
    if (hits.length > 0) {
      matched.push(entry);
    }
  }

  // Sort by priority descending (higher priority first); default to 0
  matched.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  if (limit !== undefined && limit > 0) {
    return matched.slice(0, limit);
  }

  return matched;
}
