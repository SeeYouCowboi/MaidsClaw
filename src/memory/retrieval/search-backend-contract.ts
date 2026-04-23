export type RetrievalSignal =
  | "alias_exact"
  | "pointer_exact"
  | "bm25_jieba"
  | "bm25_en"
  | "bm25_ngram"
  | "embedding";

export const SIGNAL_WEIGHTS: Record<RetrievalSignal, number> = {
  alias_exact: 3.0,
  pointer_exact: 2.5,
  bm25_jieba: 1.2,
  bm25_en: 1.2,
  bm25_ngram: 0.6,
  embedding: 1.2,
};

export interface SignalCandidate {
  sourceRef: string;
  signal: RetrievalSignal;
  rank: number;
  content?: string;
  scoreHint?: number;
  meta?: Record<string, unknown>;
}

export const RRF_K = 60;
