import { describe, expect, it } from "bun:test";

import {
  materializeGraphRetrievalEdges,
  type GraphEdgeBuilderPassageInput,
} from "../../src/memory/graph-edge-builder.js";
import { DEFAULT_GRAPH_RETRIEVAL_CONFIG } from "../../src/memory/retrieval/graph-retrieval-config.js";

function privateEpisode(
  ref: string,
  entityPointerKeys: string[],
  firstSeenAt = 1_700_000_000_000,
): GraphEdgeBuilderPassageInput {
  return {
    ref,
    kind: "episode",
    entityPointerKeys,
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    visibilityScope: "private_overlay",
    ownerAgentId: "agent-a",
  };
}

describe("graph edge builder", () => {
  it("generates mention edges from episode entity pointer keys", () => {
    const result = materializeGraphRetrievalEdges({
      runId: "run-mentions",
      passages: [privateEpisode("ep:1", ["char:alice", "loc:花房", "char:alice"])],
    });

    const mentionEdges = result.edges.filter((edge) => edge.edgeKind === "mention_episode_entity");

    expect(result.mentionEdges).toBe(2);
    expect(mentionEdges.map((edge) => [edge.sourceRef, edge.targetRef])).toEqual([
      ["ep:1", "char:alice"],
      ["ep:1", "loc:花房"],
    ]);
    expect(mentionEdges.every((edge) => edge.visibilityScope === "private_overlay")).toBe(true);
    expect(mentionEdges.every((edge) => edge.ownerAgentId === "agent-a")).toBe(true);
    expect(mentionEdges[0].sourcePassageRefs).toEqual(["ep:1"]);
  });

  it("weights co-occurrence edges with log1p(count) capped at maxWeight", () => {
    const result = materializeGraphRetrievalEdges({
      runId: "run-weight",
      config: {
        ...DEFAULT_GRAPH_RETRIEVAL_CONFIG,
        cooccurrence: {
          ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.cooccurrence,
          maxWeight: 1,
        },
      },
      passages: [
        privateEpisode("ep:1", ["char:alice", "loc:花房"], 10),
        privateEpisode("ep:2", ["loc:花房", "char:alice"], 20),
        privateEpisode("ep:3", ["char:alice", "loc:花房"], 30),
      ],
    });

    const edge = result.edges.find(
      (candidate) =>
        candidate.edgeKind === "cooccurrence_associative" &&
        candidate.sourceRef === "char:alice" &&
        candidate.targetRef === "loc:花房",
    );

    expect(edge).toBeDefined();
    expect(edge?.weight).toBe(1);
    expect(edge?.firstSeenAt).toBe(10);
    expect(edge?.lastSeenAt).toBe(30);
    expect(edge?.sourcePassageRefs).toEqual(["ep:1", "ep:2", "ep:3"]);
  });

  it("applies contrastive multiplier for contrasts_with co-occurrence pairs", () => {
    const result = materializeGraphRetrievalEdges({
      runId: "run-contrast",
      passages: [privateEpisode("ep:1", ["item:金怀表", "item:银怀表"], 10)],
      facts: [
        {
          id: 42,
          sourceRef: "item:金怀表",
          targetRef: "item:银怀表",
          predicate: "contrasts_with",
          firstSeenAt: 10,
          lastSeenAt: 10,
          visibilityScope: "private_overlay",
          ownerAgentId: "agent-a",
        },
      ],
    });

    const edge = result.edges.find(
      (candidate) =>
        candidate.edgeKind === "cooccurrence_contrastive" &&
        candidate.sourceRef === "item:金怀表" &&
        candidate.targetRef === "item:银怀表",
    );

    expect(edge).toBeDefined();
    expect(edge?.weight).toBeCloseTo(Math.log1p(1) * 0.35, 8);
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        edgeKind: "fact_relation",
        sourceRef: "item:金怀表",
        targetRef: "item:银怀表",
        sourceFactEdgeIds: [42],
        weight: 0.35,
      }),
    );
  });

  it("limits outgoing co-occurrence edges by degree cap", () => {
    const result = materializeGraphRetrievalEdges({
      runId: "run-degree-cap",
      config: {
        ...DEFAULT_GRAPH_RETRIEVAL_CONFIG,
        cooccurrence: {
          ...DEFAULT_GRAPH_RETRIEVAL_CONFIG.cooccurrence,
          degreeCap: 2,
        },
      },
      passages: [
        privateEpisode("ep:1", ["char:alice", "loc:花房"], 10),
        privateEpisode("ep:2", ["char:alice", "item:金怀表"], 20),
        privateEpisode("ep:3", ["char:alice", "item:银怀表"], 30),
        privateEpisode("ep:4", ["char:alice", "loc:花房"], 40),
      ],
    });

    const outgoing = result.edges.filter(
      (edge) => edge.edgeKind === "cooccurrence_associative" && edge.sourceRef === "char:alice",
    );

    expect(outgoing).toHaveLength(2);
    expect(outgoing.map((edge) => edge.targetRef)).toEqual(["item:银怀表", "loc:花房"]);
    expect(outgoing.find((edge) => edge.targetRef === "loc:花房")?.weight).toBeCloseTo(Math.log1p(2), 8);
    expect(outgoing.find((edge) => edge.targetRef === "item:银怀表")?.weight).toBeCloseTo(Math.log1p(1), 8);
  });
});
