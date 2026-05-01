/**
 * Layered query tokenizer.
 *
 * Two layers are exposed:
 *
 *   tokenizeSurface(text)  — Latin words + jieba CJK words. No bigrams.
 *                            Use this when you only want real lexical
 *                            content (entity alias resolution, simple
 *                            token counting that should ignore sub-word
 *                            fragments).
 *
 *   tokenizeAnalyzer(text) — surface tokens + bridge bigrams when jieba
 *                            is available; full CJK runs + sliding
 *                            bigrams as a legacy fallback when the
 *                            segmenter is disabled. Use this for
 *                            word-overlap scoring and BM25-style
 *                            relevance signals that benefit from
 *                            sub-word fragments.
 *
 *   tokenizeQuery(text)    — historical alias of tokenizeAnalyzer kept
 *                            so existing callers (graph-organizer,
 *                            retrieval-orchestrator, pg-search-backend
 *                            routing decision, anti-drift) and tests
 *                            keep working.
 *
 * Override jieba via MAIDSCLAW_CJK_SEGMENTER=off (forces fallback path).
 */

import { segmentCjk } from "./cjk-segmenter.js";

const CJK_CHAR_RE = /[一-鿿㐀-䶿豈-﫿]/;

const NOISE_TOKEN_RE = /^[\s\p{P}]+$/u;

const CJK_STOPWORDS = new Set([
  "的", "了", "是", "在", "和", "也", "就", "都",
  "有", "着", "把", "被", "让", "给", "从", "到",
  "对", "向", "跟", "比", "而", "又", "或", "但",
  "与", "之", "以", "为", "于", "则", "其", "所",
  "这", "那", "什", "么", "个", "们", "不", "没",
]);

const LATIN_CHUNK_RE = /^[a-zA-Z0-9_@:-]+$/;
const LATIN_SPLIT_RE = /([a-zA-Z0-9_@:-]+)/;

function* iterateChunks(text: string): Iterable<string> {
  for (const segment of text.split(LATIN_SPLIT_RE)) {
    const trimmed = segment.trim();
    if (trimmed) yield trimmed;
  }
}

function emitLatin(tokens: string[], chunk: string): void {
  if (chunk.length > 1) tokens.push(chunk);
}

function emitJiebaWords(tokens: string[], jiebaSegments: string[]): void {
  for (const seg of jiebaSegments) {
    if (seg.length >= 2 && !NOISE_TOKEN_RE.test(seg)) tokens.push(seg);
  }
}

function emitBridgeBigrams(tokens: string[], jiebaSegments: string[]): void {
  for (let i = 0; i < jiebaSegments.length; i++) {
    const seg = jiebaSegments[i];
    if (seg.length !== 1 || !CJK_CHAR_RE.test(seg)) continue;
    if (CJK_STOPWORDS.has(seg) || NOISE_TOKEN_RE.test(seg)) continue;
    if (i + 1 < jiebaSegments.length) {
      const next = jiebaSegments[i + 1];
      const nextFirst = [...next][0];
      if (nextFirst && CJK_CHAR_RE.test(nextFirst)) {
        tokens.push(seg + nextFirst);
      }
    }
    if (i > 0) {
      const prev = jiebaSegments[i - 1];
      const prevChars = [...prev];
      const prevLast = prevChars[prevChars.length - 1];
      if (prevLast && CJK_CHAR_RE.test(prevLast)) {
        tokens.push(prevLast + seg);
      }
    }
  }
}

function extractCjkRuns(chunk: string): string[] {
  const runs: string[] = [];
  let run = "";
  for (const ch of chunk) {
    if (CJK_CHAR_RE.test(ch)) {
      run += ch;
    } else if (run) {
      runs.push(run);
      run = "";
    }
  }
  if (run) runs.push(run);
  return runs;
}

function emitFallbackRuns(tokens: string[], chunk: string): void {
  for (const run of extractCjkRuns(chunk)) {
    if (run.length >= 2) tokens.push(run);
  }
}

function emitFallbackSlidingBigrams(tokens: string[], chunk: string): void {
  for (const run of extractCjkRuns(chunk)) {
    const chars = [...run];
    for (let i = 0; i < chars.length - 1; i++) {
      const a = chars[i];
      const b = chars[i + 1];
      if (!CJK_STOPWORDS.has(a) || !CJK_STOPWORDS.has(b)) {
        tokens.push(a + b);
      }
    }
  }
}

export function tokenizeSurface(text: string): string[] {
  const tokens: string[] = [];
  for (const chunk of iterateChunks(text)) {
    if (LATIN_CHUNK_RE.test(chunk)) {
      emitLatin(tokens, chunk);
    } else {
      const jiebaSegments = segmentCjk(chunk);
      if (jiebaSegments !== null) {
        emitJiebaWords(tokens, jiebaSegments);
      } else {
        emitFallbackRuns(tokens, chunk);
      }
    }
  }
  return [...new Set(tokens)];
}

export function tokenizeAnalyzer(text: string): string[] {
  const tokens: string[] = [];
  for (const chunk of iterateChunks(text)) {
    if (LATIN_CHUNK_RE.test(chunk)) {
      emitLatin(tokens, chunk);
    } else {
      const jiebaSegments = segmentCjk(chunk);
      if (jiebaSegments !== null) {
        emitJiebaWords(tokens, jiebaSegments);
        emitBridgeBigrams(tokens, jiebaSegments);
      } else {
        emitFallbackRuns(tokens, chunk);
        emitFallbackSlidingBigrams(tokens, chunk);
      }
    }
  }
  return [...new Set(tokens)];
}

export const tokenizeQuery = tokenizeAnalyzer;

export function containsCjk(text: string): boolean {
  return CJK_CHAR_RE.test(text);
}
