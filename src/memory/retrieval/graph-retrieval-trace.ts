export type GraphRetrievalFallbackReason =
  | "disabled_by_config"
  | "no_visible_seeds"
  | "graph_too_large"
  | "timeout"
  | "error";

export type GraphRetrievalTrace = {
  /** Whether graph retrieval was enabled for this query. */
  enabled: boolean;
  /** If graph retrieval fell back to surface-only, the reason why. */
  fallbackReason?: GraphRetrievalFallbackReason;
  /** Canonical pointer keys used as PPR seed nodes. */
  seedRefs: string[];
  /** Number of nodes in the visible sub-graph at query time. */
  visibleNodeCount: number;
  /** Number of edges in the visible sub-graph at query time. */
  visibleEdgeCount: number;
  /** PPR parameters actually used for this query. */
  pprParams: { damping: number; maxIterations: number; epsilon: number };
  /** Top 10 highest-scoring PPR nodes (all types). */
  topPprNodes: { ref: string; score: number }[];
  /** Top 10 episode-ranked PPR nodes. */
  topPprEpisodes: { ref: string; score: number }[];
  /** Top 10 cognition-ranked PPR nodes. */
  topPprCognitions: { ref: string; score: number }[];
  /** Per-signal count contributed by RRF blending. */
  rrfContribution: { signal: string; count: number }[];
  /** Budget before graph PPR was applied. */
  budgetBefore: { episode: number; cognition: number };
  /** Budget after graph PPR was applied. */
  budgetAfter: { episode: number; cognition: number };
  /** Number of fact edges present in the graph at query time. */
  factEdgesCountAtQueryTime: number;
  /** Session ID for session-scoped recency decay. */
  sessionId?: string;
  /** Agent ID of the viewer (owner); only set in owner-private traces. */
  viewerAgentId?: string;
};

/**
 * Redact private node refs/scores from trace for non-owner visibility.
 * Private node refs contain 'private:' prefix or are owner-scoped.
 */
export function redactTraceForPublic(trace: GraphRetrievalTrace): GraphRetrievalTrace {
  return {
    ...trace,
    topPprNodes: trace.topPprNodes.filter((n) => !n.ref.startsWith("private:")),
    topPprEpisodes: trace.topPprEpisodes.filter((n) => !n.ref.startsWith("private:")),
    topPprCognitions: trace.topPprCognitions.filter((n) => !n.ref.startsWith("private:")),
    viewerAgentId: undefined, // always redact agent ID in public traces
  };
}
