/**
 * CJK-aware fuzzy search utilities for PostgreSQL.
 *
 * pg_trgm is ineffective for CJK text (trigrams operate on UTF-8 bytes,
 * producing near-zero similarity scores). This module provides bigram/unigram
 * decomposition and coverage-based scoring for Chinese text search.
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

export function isCjkQuery(text: string): boolean {
  return CJK_CHAR_RE.test(text);
}

export type CjkDecomposition = {
  /** Original query text */
  original: string;
  /** Character bigrams preserving adjacency order */
  bigrams: string[];
  /** Individual characters (excluding stopwords) */
  unigrams: string[];
  /** Maximum possible score for normalization */
  maxScore: number;
};

/**
 * Decompose a CJK string into weighted bigrams and unigrams.
 *
 * For query "储藏室":
 * - bigrams: ["储藏", "藏室"]  (weight=3 each)
 * - unigrams: ["储", "藏", "室"]  (weight=1 each, stopwords excluded)
 * - exact match weight: 5
 * - maxScore: 5 + 2*3 + 3*1 = 14
 */
export function decomposeCjk(query: string): CjkDecomposition {
  const chars = Array.from(query).filter((ch) => CJK_CHAR_RE.test(ch));

  const bigrams: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) {
    bigrams.push(chars[i] + chars[i + 1]);
  }

  const unigrams = chars.filter((ch) => !CJK_STOPWORDS.has(ch));

  const WEIGHT_EXACT = 5;
  const WEIGHT_BIGRAM = 3;
  const WEIGHT_UNIGRAM = 1;
  const maxScore = WEIGHT_EXACT + bigrams.length * WEIGHT_BIGRAM + unigrams.length * WEIGHT_UNIGRAM;

  return { original: query, bigrams, unigrams, maxScore };
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
 * Build a SQL WHERE condition that matches any CJK gram.
 * Uses a small set of non-stopword unigrams for efficient pre-filtering.
 */
export function buildCjkWhereSql(
  contentColumn: string,
  decomp: CjkDecomposition,
  startParamIndex: number,
): [string, string[], number] {
  const params: string[] = [];
  let idx = startParamIndex;

  // Use exact pattern + up to 3 unigrams for pre-filter
  const filterPatterns = [`%${decomp.original}%`];
  for (const ug of decomp.unigrams.slice(0, 3)) {
    filterPatterns.push(`%${ug}%`);
  }

  const conditions = filterPatterns.map((p) => {
    params.push(p);
    return `lower(${contentColumn}) ILIKE $${idx++}`;
  });

  return [`(${conditions.join(" OR ")})`, params, idx];
}
