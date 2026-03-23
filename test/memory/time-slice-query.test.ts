import { describe, expect, it } from "bun:test";
import {
  filterEvidencePathsByTimeSlice,
  isEdgeInTimeSlice,
  summarizeTimeSlicedPaths,
} from "../../src/memory/time-slice-query.js";
import type { EvidencePath, NodeRef } from "../../src/memory/types.js";

describe("time-slice-query", () => {
  it("filters edges by asOfValidTime and asOfCommittedTime", () => {
    expect(isEdgeInTimeSlice({ timestamp: 100 }, { asOfValidTime: 200 })).toBe(true);
    expect(isEdgeInTimeSlice({ timestamp: 300 }, { asOfValidTime: 200 })).toBe(false);
    expect(isEdgeInTimeSlice({ committed_time: 500 }, { asOfCommittedTime: 400 })).toBe(false);
    expect(isEdgeInTimeSlice({ committed_time: 300 }, { asOfCommittedTime: 400 })).toBe(true);
  });

  it("returns only path edges inside requested time slice", () => {
    const input: EvidencePath[] = [
      {
        path: {
          seed: "event:1" as NodeRef,
          nodes: ["event:1" as NodeRef, "event:2" as NodeRef, "event:3" as NodeRef],
          edges: [
            {
              from: "event:1" as NodeRef,
              to: "event:2" as NodeRef,
              kind: "causal",
              layer: "symbolic",
              weight: 1,
              timestamp: 100,
              summary: "old",
            },
            {
              from: "event:2" as NodeRef,
              to: "event:3" as NodeRef,
              kind: "causal",
              layer: "symbolic",
              weight: 1,
              timestamp: 900,
              summary: "new",
            },
          ],
          depth: 2,
        },
        score: {
          seed_score: 0.5,
          edge_type_score: 0.5,
          temporal_consistency: 1,
          query_intent_match: 0.5,
          support_score: 0,
          recency_score: 0.5,
          hop_penalty: 0,
          redundancy_penalty: 0,
          path_score: 0.4,
        },
        supporting_nodes: ["event:2" as NodeRef, "event:3" as NodeRef],
        supporting_facts: [],
      },
    ];

    const filtered = filterEvidencePathsByTimeSlice(input, { asOfCommittedTime: 500 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.path.edges).toHaveLength(1);
    expect(filtered[0]?.path.nodes).toEqual(["event:1", "event:2"]);
  });

  it("summarizes omitted edge counts for time slicing", () => {
    const paths: EvidencePath[] = [
      {
        path: {
          seed: "event:1" as NodeRef,
          nodes: ["event:1" as NodeRef, "event:2" as NodeRef],
          edges: [
            {
              from: "event:1" as NodeRef,
              to: "event:2" as NodeRef,
              kind: "causal",
              layer: "symbolic",
              weight: 1,
              timestamp: 1000,
              summary: "late",
            },
          ],
          depth: 1,
        },
        score: {
          seed_score: 0.5,
          edge_type_score: 0.5,
          temporal_consistency: 1,
          query_intent_match: 0.5,
          support_score: 0,
          recency_score: 0.5,
          hop_penalty: 0,
          redundancy_penalty: 0,
          path_score: 0.4,
        },
        supporting_nodes: [],
        supporting_facts: [],
      },
    ];

    const summaries = summarizeTimeSlicedPaths(paths, { asOfValidTime: 900, asOfCommittedTime: 900 });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.omitted_edges).toBe(1);
    expect(summaries[0]?.has_valid_cut).toBe(true);
    expect(summaries[0]?.has_committed_cut).toBe(true);
  });
});
