/**
 * Mixed Latin + CJK query token extractor.
 *
 * Latin tokens are split on non-alphanumeric boundaries (preserving @, -, :).
 * CJK runs are segmented via @node-rs/jieba when available, producing real
 * word tokens (e.g. "爱丽丝离开了" → ["爱丽丝", "离开"]). When jieba is
 * disabled or unavailable, the tokenizer falls back to the legacy bigram
 * scheme: full run + sliding bigrams with stopword-only pair filtering.
 *
 * The jieba path is strictly better for all downstream consumers (entity
 * resolution, word overlap detection, episode row scoring) so it is
 * preferred by default. Override via MAIDSCLAW_CJK_SEGMENTER=off.
 */

import { segmentCjk } from "./cjk-segmenter.js";

// CJK Unified Ideographs + Extension A + Compatibility Ideographs
const CJK_CHAR_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

const NOISE_TOKEN_RE = /^[\s\p{P}]+$/u;

// Common Chinese function words that provide minimal search value
const CJK_STOPWORDS = new Set([
  "的", "了", "是", "在", "和", "也", "就", "都",
  "有", "着", "把", "被", "让", "给", "从", "到",
  "对", "向", "跟", "比", "而", "又", "或", "但",
  "与", "之", "以", "为", "于", "则", "其", "所",
  "这", "那", "什", "么", "个", "们", "不", "没",
]);

export function tokenizeQuery(text: string): string[] {
  const tokens: string[] = [];
  // Split on Latin token boundaries, preserving CJK segments
  for (const segment of text.split(/([a-zA-Z0-9_@:-]+)/)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    if (/^[a-zA-Z0-9_@:-]+$/.test(trimmed)) {
      // Latin token — keep as-is if length > 1
      if (trimmed.length > 1) tokens.push(trimmed);
    } else {
      // CJK branch: try jieba first, fall back to bigrams if unavailable.
      const jiebaSegments = segmentCjk(trimmed);
      if (jiebaSegments !== null) {
        for (const seg of jiebaSegments) {
          // len >= 2 matches the bigram path's minimum token width; also
          // strip punctuation/whitespace-only tokens jieba may emit.
          if (seg.length >= 2 && !NOISE_TOKEN_RE.test(seg)) {
            tokens.push(seg);
          }
        }
      } else {
        // Legacy fallback: full run + sliding bigrams.
        const cjkRuns: string[] = [];
        let run = "";
        for (const ch of trimmed) {
          if (CJK_CHAR_RE.test(ch)) {
            run += ch;
          } else if (run) {
            cjkRuns.push(run);
            run = "";
          }
        }
        if (run) cjkRuns.push(run);

        for (const cjkStr of cjkRuns) {
          if (cjkStr.length >= 2) tokens.push(cjkStr);
          const chars = Array.from(cjkStr);
          for (let i = 0; i < chars.length - 1; i++) {
            const bg = chars[i] + chars[i + 1];
            if (!CJK_STOPWORDS.has(chars[i]) || !CJK_STOPWORDS.has(chars[i + 1])) {
              tokens.push(bg);
            }
          }
        }
      }
    }
  }
  return [...new Set(tokens)];
}

/** Check whether text contains any CJK characters. */
export function containsCjk(text: string): boolean {
  return CJK_CHAR_RE.test(text);
}
