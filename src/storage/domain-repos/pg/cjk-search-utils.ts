/**
 * CJK-aware fuzzy search utilities for PostgreSQL.
 *
 * pg_trgm is ineffective for CJK text (trigrams operate on UTF-8 bytes,
 * producing near-zero similarity scores). This module provides jieba-backed
 * token decomposition and coverage-based scoring for Chinese text search.
 */

import { segmentCjk } from "../../../memory/cjk-segmenter.js";

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

export function isCjkQuery(text: string): boolean {
  return CJK_CHAR_RE.test(text);
}

export type CjkDecomposition = {
  /** Original query text */
  original: string;
  /** High-information multi-character terms, preferably from jieba segmentation */
  bigrams: string[];
  /** Individual fallback characters and Latin tokens */
  unigrams: string[];
  /** Maximum possible score for normalization */
  maxScore: number;
};

/**
 * Extracts Latin word-like tokens (length >= 2) from mixed-script text.
 * Used by decomposeCjk so mixed queries like "Alice有时候比管家还麻烦"
 * keep "Alice" as a retrievable unigram instead of silently dropping it.
 */
const LATIN_TOKEN_RE = /[a-zA-Z][a-zA-Z0-9]+/g;

/**
 * Decompose a mixed CJK + Latin string into weighted terms and unigrams.
 *
 * For query "储藏室":
 * - bigrams: ["储藏室"]  (weight=3 each)
 * - unigrams: ["储", "藏", "室"]  (weight=1 each, stopwords excluded)
 * - exact match weight: 5
 * - maxScore: 5 + 1*3 + 3*1 = 11
 *
 * For query "Alice有时候比管家还麻烦":
 * - bigrams: ["有时候", "管家", "麻烦"]
 * - unigrams: ["有", "时", "候", "管", "家", "还", "麻", "烦", "alice"]
 *   (CJK stopwords excluded; "比" is a stopword so it's dropped; "Alice" is
 *    preserved as a lower-cased Latin unigram)
 */
export function decomposeCjk(query: string): CjkDecomposition {
  const chars = Array.from(query).filter((ch) => CJK_CHAR_RE.test(ch));
  const bigrams: string[] = [];
  const seenBigrams = new Set<string>();
  const pushBigram = (token: string): void => {
    const trimmed = token.trim();
    if (trimmed.length < 2) return;
    if (!containsCjk(trimmed)) return;
    if (isAllStopwordToken(trimmed)) return;
    if (seenBigrams.has(trimmed)) return;
    seenBigrams.add(trimmed);
    bigrams.push(trimmed);
  };

  const segmented = segmentCjk(query);
  if (segmented !== null) {
    for (const token of segmented) {
      pushBigram(token);
    }
  }

  const unigrams = chars.filter((ch) => !CJK_STOPWORDS.has(ch));

  // Also extract Latin word tokens (length >= 2) so mixed-script queries
  // don't silently lose their most informative ASCII terms (proper names,
  // codes, identifiers). Normalized to lowercase for case-insensitive match
  // against content.toLowerCase() in the scorer path.
  const latinMatches = query.match(LATIN_TOKEN_RE) ?? [];
  for (const token of latinMatches) {
    if (token.length >= 2) {
      unigrams.push(token.toLowerCase());
    }
  }

  const WEIGHT_EXACT = 5;
  const WEIGHT_BIGRAM = 3;
  const WEIGHT_UNIGRAM = 1;
  const maxScore = WEIGHT_EXACT + bigrams.length * WEIGHT_BIGRAM + unigrams.length * WEIGHT_UNIGRAM;

  return { original: query, bigrams, unigrams, maxScore };
}

function containsCjk(text: string): boolean {
  return CJK_CHAR_RE.test(text);
}

function isAllStopwordToken(token: string): boolean {
  const chars = Array.from(token).filter((ch) => CJK_CHAR_RE.test(ch));
  return chars.length > 0 && chars.every((ch) => CJK_STOPWORDS.has(ch));
}

/**
 * Build SQL ILIKE patterns from a CJK decomposition.
 * Returns patterns suitable for WHERE ... ILIKE ANY(patterns).
 */
export function buildCjkPatterns(decomp: CjkDecomposition): string[] {
  const patterns = new Set<string>();
  // Exact substring
  patterns.add(`%${decomp.original}%`);
  // Bigrams
  for (const bg of decomp.bigrams) patterns.add(`%${bg}%`);
  // Unigrams (for fuzzy single-character matching)
  for (const ug of decomp.unigrams) patterns.add(`%${ug}%`);
  return Array.from(patterns);
}

/**
 * Build a SQL scoring expression for CJK content.
 *
 * Returns a parameterized SQL fragment and the corresponding parameter values.
 * The score is normalized to [0, 1] range.
 *
 * @param contentColumn - The SQL column expression to score against (e.g., "d.content")
 * @param decomp - The CJK decomposition of the query
 * @param startParamIndex - The starting $N parameter index
 * @returns [sqlFragment, params, nextParamIndex]
 */
export function buildCjkScoreSql(
  contentColumn: string,
  decomp: CjkDecomposition,
  startParamIndex: number,
): [string, Array<string | number>, number] {
  const params: Array<string | number> = [];
  let idx = startParamIndex;
  const caseParts: string[] = [];

  // Exact match (highest weight)
  const exactPattern = `%${decomp.original}%`;
  caseParts.push(`CASE WHEN lower(${contentColumn}) ILIKE $${idx} THEN 5 ELSE 0 END`);
  params.push(exactPattern);
  idx++;

  // Bigram matches
  for (const bg of decomp.bigrams) {
    caseParts.push(`CASE WHEN lower(${contentColumn}) ILIKE $${idx} THEN 3 ELSE 0 END`);
    params.push(`%${bg}%`);
    idx++;
  }

  // Unigram matches
  for (const ug of decomp.unigrams) {
    caseParts.push(`CASE WHEN lower(${contentColumn}) ILIKE $${idx} THEN 1 ELSE 0 END`);
    params.push(`%${ug}%`);
    idx++;
  }

  const rawScore = caseParts.join(" + ");
  const sql = `(${rawScore})::real / ${decomp.maxScore}::real`;

  return [sql, params, idx];
}

/**
 * Maximum number of ILIKE patterns to emit in a single WHERE expression.
 * Bounded so the generated SQL stays manageable even for very long queries.
 */
const CJK_PREFILTER_PATTERN_CAP = 20;

/**
 * Build a SQL WHERE condition that matches any CJK term.
 *
 * The pre-filter prefers jieba-backed multi-character terms such as
 * `管家`/`茶室`/`怀表`, then falls back to unigrams for shorter or less
 * segmentable queries. This keeps the SQL candidate set narrow without
 * relying on the old sliding character-bigram path.
 *
 *  - Prefer multi-character terms (higher information density per token)
 *  - Fall back to unigrams for very short (single-char) queries
 *  - Cap total patterns at CJK_PREFILTER_PATTERN_CAP
 */
export function buildCjkWhereSql(
  contentColumn: string,
  decomp: CjkDecomposition,
  startParamIndex: number,
): [string, string[], number] {
  const params: string[] = [];
  let idx = startParamIndex;

  const filterPatterns: string[] = [`%${decomp.original}%`];
  const grams =
    decomp.bigrams.length > 0 ? decomp.bigrams : decomp.unigrams;
  for (const g of grams) {
    if (filterPatterns.length >= CJK_PREFILTER_PATTERN_CAP) break;
    filterPatterns.push(`%${g}%`);
  }

  const conditions = filterPatterns.map((p) => {
    params.push(p);
    return `lower(${contentColumn}) ILIKE $${idx++}`;
  });

  return [`(${conditions.join(" OR ")})`, params, idx];
}
