/**
 * Runtime configuration for graph-based retrieval (PPR / HippoRAG-style
 * multi-hop). All numeric defaults are chosen to keep latency low and
 * visibility bounded until operators explicitly tune them.
 */
export type GraphRetrievalConfig = {
  /** Master switch — when false the retrieval pipeline skips graph PPR entirely. */
  enabled: boolean;

  /** When true, graph retrieval emits shadow logs for every query without
   *  affecting the returned result set (safe for A/B comparison). */
  shadowLog: boolean;

  /** PPR (Personalized PageRank) hyper-parameters.
   *
   *  Damping = 0.5 is INTENTIONAL — it is the HippoRAG-style seed-proximity
   *  default. Do not change to the classical 0.85 unless you understand the
   *  impact on seed-bias vs global diffusion. */
  ppr: {
    /** HippoRAG-style seed proximity. Default 0.5 (NOT the classical 0.85). */
    damping: number;
    /** Hard ceiling on power-iteration loops. Default 20. */
    maxIterations: number;
    /** L1 convergence threshold. Default 0.0001. */
    epsilon: number;
    /** Max nodes kept in the visible sub-graph. Default 2000. */
    maxVisibleNodes: number;
    /** Max edges kept in the visible sub-graph. Default 8000. */
    maxVisibleEdges: number;
  };

  /** How seed nodes are selected from the query embedding / keyword hits. */
  seed: {
    /** Number of top embedding-similar nodes to link as seeds. Default 5. */
    linkingTopK: number;
    /** Minimum cosine similarity for a node to become a seed. Default 0.75. */
    similarityThreshold: number;
  };

  /** RRF (Reciprocal Rank Fusion) weights for blending graph PPR with
   *  surface-retrieval signals. */
  rrf: {
    /** Multiplier applied to episode-ranked PPR scores. Default 1.2. */
    episodeSignalWeight: number;
    /** Multiplier applied to cognition-ranked PPR scores. Default 1.2. */
    cognitionSignalWeight: number;
  };

  /** Budget allocator interaction.
   *
   *  `graphPprAffectsSurfaceSignals: false` is v1 safety: graph_ppr does
   *  not inflate needsEpisode / needsCognition surface signals, so the
   *  budget allocator stays deterministic regardless of whether graph
   *  retrieval is on or off. */
  budgetAllocator: {
    /** v1 safety: graph_ppr does not inflate needsEpisode/needsCognition
     *  surface signals. Default false. */
    graphPprAffectsSurfaceSignals: boolean;
    /** Maximum allowed drift in episode/cognition budget when PPR is
     *  toggled on/off. Default 1 (effectively zero drift). */
    maxPprOnOffBudgetDrift: number;
  };

  /** Co-occurrence edge weighting controls. */
  cooccurrence: {
    /** Upper bound on a single co-occurrence edge weight. Default 4.0. */
    maxWeight: number;
    /** Down-weight factor for contrastive (negative) co-occurrences.
     *  Default 0.35. */
    contrastiveMultiplier: number;
    /** Cap on node degree for co-occurrence edge creation. Default 25. */
    degreeCap: number;
  };

  /** Recency decay applied to PPR node scores. */
  recency: {
    /** Whether recency half-life is scoped to the current session or global.
     *  Default "session". */
    scope: "session" | "global";
    /** Session-scoped half-life in milliseconds.
     *  30-minute default; tune to 7_200_000 (2h) for long RP scenarios (100+ turns). */
    sessionHalfLifeMs: number;
    /** Global half-life in milliseconds. Default 86_400_000 (24h). */
    globalHalfLifeMs: number;
  };
};

export const DEFAULT_GRAPH_RETRIEVAL_CONFIG: GraphRetrievalConfig = {
  enabled: true,
  shadowLog: true,
  ppr: {
    damping: 0.5,
    maxIterations: 20,
    epsilon: 0.0001,
    maxVisibleNodes: 2000,
    maxVisibleEdges: 8000,
  },
  seed: {
    linkingTopK: 5,
    similarityThreshold: 0.75,
  },
  rrf: {
    episodeSignalWeight: 1.2,
    cognitionSignalWeight: 1.2,
  },
  budgetAllocator: {
    graphPprAffectsSurfaceSignals: false,
    maxPprOnOffBudgetDrift: 1,
  },
  cooccurrence: {
    maxWeight: 4.0,
    contrastiveMultiplier: 0.35,
    degreeCap: 25,
  },
  recency: {
    scope: "session",
    sessionHalfLifeMs: 1_800_000,
    globalHalfLifeMs: 86_400_000,
  },
};

/**
 * Deep-merge a partial override into the default graph-retrieval config.
 * Every nested object is merged individually so callers can override a
 * single field (e.g. `ppr.damping`) without losing sibling defaults.
 */
export function resolveGraphRetrievalConfig(
  partial?: Partial<GraphRetrievalConfig>,
): GraphRetrievalConfig {
  if (!partial) return DEFAULT_GRAPH_RETRIEVAL_CONFIG;
  return {
    ...DEFAULT_GRAPH_RETRIEVAL_CONFIG,
    ...partial,
    ppr: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.ppr, ...partial.ppr },
    seed: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.seed, ...partial.seed },
    rrf: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.rrf, ...partial.rrf },
    budgetAllocator: {
      ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.budgetAllocator,
      ...partial.budgetAllocator,
    },
    cooccurrence: {
      ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.cooccurrence,
      ...partial.cooccurrence,
    },
    recency: {
      ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.recency,
      ...partial.recency,
    },
  };
}
