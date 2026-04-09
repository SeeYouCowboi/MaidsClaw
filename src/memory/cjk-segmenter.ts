/**
 * CJK tokenizer upgrade via @node-rs/jieba.
 *
 * Provides a lazily-initialized jieba singleton with user dictionary support
 * and a graceful fallback path. When the segmenter is unavailable (library
 * not installed, load failure, or explicitly disabled via the env flag),
 * segmentCjk() returns null and callers should fall back to bigram logic.
 *
 * Private aliases are intentionally NOT loaded here — doing so would leak
 * agent-scoped entity names across the global segmenter dictionary. Private
 * alias resolution continues to work via the per-token resolveAlias path.
 */

import { createRequire } from "node:module";

// Inlined CJK detection to break the circular import with query-tokenizer.ts.
// Keep the regex identical to query-tokenizer.ts's CJK_CHAR_RE so both modules
// agree on what "contains CJK" means. If the canonical definition changes,
// update both locations.
const CJK_CHAR_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

function hasCjk(text: string): boolean {
  return CJK_CHAR_RE.test(text);
}

type JiebaApi = {
  cut(text: string, hmm?: boolean): string[];
  loadDict(buf: Uint8Array): void;
};

let instance: JiebaApi | null = null;
let initialized = false;
let enabled = process.env.MAIDSCLAW_CJK_SEGMENTER !== "off";
let lastInitError: string | null = null;
let loadedUserWords = 0;

/**
 * Lazy-initialize the jieba singleton with the default dictionary.
 * Safe to call multiple times — subsequent calls are no-ops. Failures are
 * swallowed and the segmenter stays disabled, letting the tokenizer fall
 * back to bigrams.
 */
export function initCjkSegmenter(): void {
  if (initialized) return;
  initialized = true;
  if (!enabled) return;
  try {
    // createRequire to keep ESM-friendly and tolerate missing package.
    const require = createRequire(import.meta.url);
    const { Jieba } = require("@node-rs/jieba");
    const { dict } = require("@node-rs/jieba/dict");
    instance = Jieba.withDict(dict) as JiebaApi;
  } catch (err) {
    enabled = false;
    instance = null;
    lastInitError = err instanceof Error ? (err.stack ?? err.message) : String(err);
    // Log once on init failure so operators can tell the fallback is in use
    // because jieba failed, not because the env flag was set.
    console.debug(JSON.stringify({
      event: "cjk_segmenter_init_failed",
      error: lastInitError,
    }));
  }
}

/**
 * Load additional user dictionary words into the segmenter.
 * Safe to call multiple times — jieba's loadDict merges across calls.
 * Only CJK strings of length >= 2 are loaded; Latin words and single
 * characters are silently filtered.
 */
export function loadUserDict(words: readonly string[]): void {
  if (!initialized) initCjkSegmenter();
  if (!instance) return;
  const cjkWords = words.filter((w) => w.length >= 2 && hasCjk(w));
  if (cjkWords.length === 0) return;
  // High frequency ensures user words take priority over default dict entries.
  // Jieba's dict parser requires a trailing newline after the last entry.
  const dictText = cjkWords.map((w) => `${w} 1000000`).join("\n") + "\n";
  try {
    instance.loadDict(Buffer.from(dictText, "utf8"));
    loadedUserWords += cjkWords.length;
  } catch (err) {
    // Leave instance in place; default + prior user dict remain usable.
    console.debug(JSON.stringify({
      event: "cjk_segmenter_load_dict_failed",
      word_count: cjkWords.length,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    }));
  }
}

/**
 * Segment a CJK-containing string using jieba's accurate mode.
 * Returns null when the segmenter is unavailable — callers should fall
 * back to their existing bigram logic in that case.
 */
export function segmentCjk(text: string): string[] | null {
  if (!initialized) initCjkSegmenter();
  if (!instance) return null;
  try {
    return instance.cut(text, false);
  } catch {
    return null;
  }
}

/**
 * A jieba token with its character offset within the original input text.
 * Used by GAP-4 §8 private-alias substring scan to verify that an alias
 * candidate aligns to jieba token boundaries before accepting it.
 */
export type CjkSpan = { text: string; start: number; end: number };

/**
 * Like segmentCjk, but returns each token's character offset within the
 * input. Walks the original text consuming each jieba token in order.
 *
 * jieba may emit tokens that aren't byte-contiguous (whitespace
 * normalization, edge-case characters). This function uses an
 * indexOf-with-cursor walk that tolerates small gaps but bails (returns
 * null) if any token cannot be located after the previous one — that way
 * callers never see misaligned spans, only "spans available" or "spans
 * unavailable, fall back".
 *
 * Returns null when the segmenter is unavailable OR when the walk
 * detects drift; both cases mean callers should skip span-dependent work.
 */
export function segmentCjkWithSpans(text: string): CjkSpan[] | null {
  const segments = segmentCjk(text);
  if (segments === null) return null;
  const spans: CjkSpan[] = [];
  let cursor = 0;
  for (const seg of segments) {
    if (seg.length === 0) continue;
    const idx = text.indexOf(seg, cursor);
    if (idx === -1) return null;
    spans.push({ text: seg, start: idx, end: idx + seg.length });
    cursor = idx + seg.length;
  }
  return spans;
}

/** Whether the segmenter is currently available (for observability/tests). */
export function isCjkSegmenterAvailable(): boolean {
  if (!initialized) initCjkSegmenter();
  return instance !== null;
}

/** Observability helper: report current segmenter state for health checks. */
export function getCjkSegmenterStatus(): {
  available: boolean;
  initialized: boolean;
  enabled: boolean;
  lastInitError: string | null;
  loadedUserWords: number;
} {
  return {
    available: instance !== null,
    initialized,
    enabled,
    lastInitError,
    loadedUserWords,
  };
}

/** For tests only: reset internal state so a fresh init can be exercised. */
export function __resetCjkSegmenterForTests(): void {
  instance = null;
  initialized = false;
  enabled = process.env.MAIDSCLAW_CJK_SEGMENTER !== "off";
  lastInitError = null;
  loadedUserWords = 0;
}
