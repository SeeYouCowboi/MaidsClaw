import { describe, expect, it } from "bun:test";
import {
  DEFAULT_GRAPH_RETRIEVAL_CONFIG,
  resolveGraphRetrievalConfig,
} from "../../src/memory/retrieval/graph-retrieval-config.js";
import {
  redactTraceForPublic,
  type GraphRetrievalTrace,
} from "../../src/memory/retrieval/graph-retrieval-trace.js";

describe("graph retrieval config", () => {
  it("resolveGraphRetrievalConfig() returns all defaults when called with no args", () => {
    const cfg = resolveGraphRetrievalConfig();
    expect(cfg).toStrictEqual(DEFAULT_GRAPH_RETRIEVAL_CONFIG);
  });

  it("setting enabled: false produces config with enabled: false", () => {
    const cfg = resolveGraphRetrievalConfig({ enabled: false });
    expect(cfg.enabled).toBe(false);
    expect(cfg.shadowLog).toBe(DEFAULT_GRAPH_RETRIEVAL_CONFIG.shadowLog);
    expect(cfg.ppr.damping).toBe(DEFAULT_GRAPH_RETRIEVAL_CONFIG.ppr.damping);
  });

  it("budget allocator parity: graphPprAffectsSurfaceSignals defaults to false", () => {
    const cfg = resolveGraphRetrievalConfig();
    expect(cfg.budgetAllocator.graphPprAffectsSurfaceSignals).toBe(false);
  });

  it("recency defaults: scope=session, sessionHalfLifeMs=1_800_000", () => {
    const cfg = resolveGraphRetrievalConfig();
    expect(cfg.recency.scope).toBe("session");
    expect(cfg.recency.sessionHalfLifeMs).toBe(1_800_000);
  });
});

describe("graph retrieval trace redaction", () => {
  it("removes private: prefixed refs and viewerAgentId", () => {
    const trace: GraphRetrievalTrace = {
      enabled: true,
      seedRefs: ["private:node-1", "public:node-2"],
      visibleNodeCount: 100,
      visibleEdgeCount: 200,
      pprParams: { damping: 0.5, maxIterations: 20, epsilon: 0.0001 },
      topPprNodes: [
        { ref: "private:node-1", score: 0.9 },
        { ref: "public:node-2", score: 0.8 },
      ],
      topPprEpisodes: [
        { ref: "private:episode-1", score: 0.7 },
        { ref: "public:episode-2", score: 0.6 },
      ],
      topPprCognitions: [
        { ref: "private:cognition-1", score: 0.5 },
        { ref: "public:cognition-2", score: 0.4 },
      ],
      rrfContribution: [],
      budgetBefore: { episode: 10, cognition: 10 },
      budgetAfter: { episode: 10, cognition: 10 },
      factEdgesCountAtQueryTime: 50,
      sessionId: "sess-123",
      viewerAgentId: "agent-42",
    };

    const redacted = redactTraceForPublic(trace);

    expect(redacted.topPprNodes).toStrictEqual([
      { ref: "public:node-2", score: 0.8 },
    ]);
    expect(redacted.topPprEpisodes).toStrictEqual([
      { ref: "public:episode-2", score: 0.6 },
    ]);
    expect(redacted.topPprCognitions).toStrictEqual([
      { ref: "public:cognition-2", score: 0.4 },
    ]);
    expect(redacted.viewerAgentId).toBeUndefined();
    expect(redacted.enabled).toBe(true);
    expect(redacted.seedRefs).toStrictEqual(trace.seedRefs);
    expect(redacted.sessionId).toBe("sess-123");
  });
});
