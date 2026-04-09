/**
 * Mixed Latin + CJK query token extractor.
 *
 * Latin tokens are split on non-alphanumeric boundaries (preserving @, -, :).
 * CJK runs produce the full run (for alias matching) plus sliding bigrams
 * (for fuzzy matching), filtering stopword-only bigrams.
 */

// CJK Unified Ideographs + Extension A + Compatibility Ideographs
const CJK_CHAR_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

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
      // Extract contiguous CJK character runs
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
        // Full run (for alias exact matching)
        if (cjkStr.length >= 2) tokens.push(cjkStr);
        // Bigram sliding window (for keyword matching and fuzzy scoring)
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
  return [...new Set(tokens)];
}

/** Check whether text contains any CJK characters. */
export function containsCjk(text: string): boolean {
  return CJK_CHAR_RE.test(text);
}
