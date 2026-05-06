import { describe, expect, it } from "bun:test";

import type { MentionEdge } from "../../src/memory/retrieval/graph-loader.js";
import type { PprResult } from "../../src/memory/retrieval/graph-ppr.js";
import { runPersonalizedPageRank } from "../../src/memory/retrieval/graph-ppr.js";
import {
  DEFAULT_GRAPH_RETRIEVAL_CONFIG,
  type GraphRetrievalConfig,
} from "../../src/memory/retrieval/graph-retrieval-config.js";

function config(overrides: Partial<GraphRetrievalConfig> = {}): GraphRetrievalConfig {
  return {
    ...DEFAULT_GRAPH_RETRIEVAL_CONFIG,
    ...overrides,
    ppr: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.ppr, ...overrides.ppr },
    seed: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.seed, ...overrides.seed },
    rrf: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.rrf, ...overrides.rrf },
    budgetAllocator: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.budgetAllocator, ...overrides.budgetAllocator },
    cooccurrence: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.cooccurrence, ...overrides.cooccurrence },
    recency: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.recency, ...overrides.recency },
  };
}

function adjacency(rows: Array<[string, string, number]>): Map<string, Map<string, number>> {
  const graph = new Map<string, Map<string, number>>();
  for (const [sourceRef, targetRef, weight] of rows) {
    const outgoing = graph.get(sourceRef) ?? new Map<string, number>();
    outgoing.set(targetRef, weight);
    graph.set(sourceRef, outgoing);
  }
  return graph;
}

function run(opts: {
  nodes: string[];
  seedRefs: string[];
  adjacency?: Map<string, Map<string, number>>;
  mentionEdges?: MentionEdge[];
  config?: GraphRetrievalConfig;
}): PprResult {
  return runPersonalizedPageRank({
    adjacency: opts.adjacency ?? new Map(),
    nodes: new Set(opts.nodes),
    seedRefs: opts.seedRefs,
    mentionEdges: opts.mentionEdges ?? [],
    config: opts.config ?? config(),
  });
}

function sumScores(scores: Map<string, number>): number {
  return [...scores.values()].reduce((sum, score) => sum + score, 0);
}

function mapSnapshot(scores: Map<string, number>): Array<[string, number]> {
  return [...scores.entries()].sort(([a], [b]) => a.localeCompare(b));
}

describe("personalized page rank", () => {
  it("empty graph returns empty scores with fallback", () => {
    const result = run({ nodes: [], seedRefs: [] });

    expect(result.fallbackReason).toBe("no_visible_seeds");
    expect(result.entityScores.size).toBe(0);
    expect(result.episodeScores.size).toBe(0);
    expect(result.cognitionScores.size).toBe(0);
    expect(result.iterations).toBe(0);
    expect(result.converged).toBe(false);
  });

  it("single-seed single-node graph", () => {
    const result = run({ nodes: ["entity:A"], seedRefs: ["entity:A"] });

    expect(result.fallbackReason).toBeUndefined();
    expect(result.entityScores.get("entity:A")).toBe(1);
    expect(result.iterations).toBe(1);
    expect(result.converged).toBe(true);
  });

  it("two-node graph converges to expected scores", () => {
    const result = run({
      nodes: ["entity:B", "entity:A"],
      seedRefs: ["entity:A"],
      adjacency: adjacency([["entity:A", "entity:B", 1]]),
    });

    expect(result.converged).toBe(true);
    expect(result.entityScores.get("entity:A") ?? 0).toBeGreaterThan(result.entityScores.get("entity:B") ?? 0);
    expect(sumScores(result.entityScores)).toBeCloseTo(1, 9);
  });

  it("PPR is deterministic across repeated calls", () => {
    const input = {
      nodes: ["entity:C", "entity:A", "entity:B"],
      seedRefs: ["entity:A"],
      adjacency: adjacency([
        ["entity:A", "entity:C", 0.35],
        ["entity:A", "entity:B", 1],
        ["entity:B", "entity:C", 1],
      ]),
    };

    const first = mapSnapshot(run(input).entityScores);
    const second = mapSnapshot(run(input).entityScores);
    const third = mapSnapshot(run(input).entityScores);

    expect(second).toStrictEqual(first);
    expect(third).toStrictEqual(first);
  });

  it("seed gets highest score in seed-only graph", () => {
    const result = run({
      nodes: ["entity:B", "entity:A", "entity:C"],
      seedRefs: ["entity:A", "entity:C"],
    });

    expect(result.entityScores.get("entity:A")).toBeCloseTo(0.5, 9);
    expect(result.entityScores.get("entity:C")).toBeCloseTo(0.5, 9);
    expect(result.entityScores.get("entity:B")).toBe(0);
    expect(result.converged).toBe(true);
  });

  it("contrastive edge (lower weight) produces lower propagated score than associative", () => {
    const result = run({
      nodes: ["entity:A", "entity:B", "entity:C"],
      seedRefs: ["entity:A"],
      adjacency: adjacency([
        ["entity:A", "entity:B", 1],
        ["entity:A", "entity:C", 0.35],
      ]),
    });

    expect(result.entityScores.get("entity:B") ?? 0).toBeGreaterThan(result.entityScores.get("entity:C") ?? 0);
    expect(result.entityScores.get("entity:C") ?? 0).toBeGreaterThan(0);
  });

  it("episode aggregation via mention edges", () => {
    const result = run({
      nodes: ["entity:A", "entity:B"],
      seedRefs: ["entity:A"],
      adjacency: adjacency([["entity:A", "entity:B", 1]]),
      mentionEdges: [
        { passageRef: "episode:high", passageKind: "episode", entityRef: "entity:A", weight: 1 },
        { passageRef: "episode:low", passageKind: "episode", entityRef: "entity:B", weight: 1 },
      ],
    });

    expect(result.episodeScores.get("episode:high")).toBe(1);
    expect(result.episodeScores.get("episode:low") ?? 0).toBeLessThan(1);
    expect(result.episodeScores.get("episode:high") ?? 0).toBeGreaterThan(result.episodeScores.get("episode:low") ?? 0);
  });

  it("cognition aggregation via mention edges", () => {
    const result = run({
      nodes: ["entity:A", "entity:B"],
      seedRefs: ["entity:A"],
      adjacency: adjacency([["entity:A", "entity:B", 1]]),
      mentionEdges: [
        { passageRef: "cognition:high", passageKind: "cognition", entityRef: "entity:A", weight: 1 },
        { passageRef: "cognition:low", passageKind: "cognition", entityRef: "entity:B", weight: 1 },
      ],
    });

    expect(result.cognitionScores.get("cognition:high")).toBe(1);
    expect(result.cognitionScores.get("cognition:low") ?? 0).toBeLessThan(1);
    expect(result.cognitionScores.get("cognition:high") ?? 0).toBeGreaterThan(result.cognitionScores.get("cognition:low") ?? 0);
  });

  it("recency decay: newer mention edge produces higher score", () => {
    const result = run({
      nodes: ["entity:A", "entity:B"],
      seedRefs: ["entity:A"],
      adjacency: adjacency([["entity:A", "entity:B", 1]]),
      mentionEdges: [
        { passageRef: "episode:recent", passageKind: "episode", entityRef: "entity:A", weight: 2 },
        { passageRef: "episode:recent", passageKind: "episode", entityRef: "entity:B", weight: 1 },
        { passageRef: "episode:old", passageKind: "episode", entityRef: "entity:A", weight: 0.5 },
        { passageRef: "episode:old", passageKind: "episode", entityRef: "entity:B", weight: 1.5 },
      ],
    });

    expect(result.entityScores.get("entity:A") ?? 0).toBeGreaterThan(result.entityScores.get("entity:B") ?? 0);
    expect(result.episodeScores.get("episode:recent") ?? 0).toBeGreaterThan(result.episodeScores.get("episode:old") ?? 0);
  });

  it("graph respects maxIterations limit", () => {
    const result = run({
      nodes: ["entity:A", "entity:B"],
      seedRefs: ["entity:A"],
      adjacency: adjacency([["entity:A", "entity:B", 1]]),
      config: config({ ppr: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.ppr, maxIterations: 1 } }),
    });

    expect(result.iterations).toBe(1);
    expect(result.converged).toBe(false);
  });
});
