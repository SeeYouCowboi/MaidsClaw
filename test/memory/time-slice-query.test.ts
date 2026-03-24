import { describe, expect, it } from "bun:test";
import {
  filterProjectionRowsByTimeSlice,
  filterEvidencePathsByTimeSlice,
  isProjectionRowInTimeSlice,
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

  it("time slicing keeps redacted placeholders visible for explain output", () => {
    const input: EvidencePath[] = [
      {
        path: {
          seed: "private_episode:1" as NodeRef,
          nodes: ["private_episode:1" as NodeRef, "event:2" as NodeRef],
          edges: [
            {
              from: "private_episode:1" as NodeRef,
              to: "event:2" as NodeRef,
              kind: "same_episode",
              layer: "symbolic",
              weight: 1,
              timestamp: 200,
              summary: "bridge",
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
        supporting_nodes: ["event:2" as NodeRef],
        supporting_facts: [],
        redacted_placeholders: [{ type: "redacted", reason: "private", node_ref: "private_event:9" }],
      },
    ];

    const filtered = filterEvidencePathsByTimeSlice(input, { asOfCommittedTime: 300 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.redacted_placeholders).toEqual([{ type: "redacted", reason: "private", node_ref: "private_event:9" }]);
    expect(filtered[0]?.path.nodes).toEqual(["private_episode:1", "event:2"]);
  });

  it("filters area/world projection rows by valid_time and committed_time", () => {
    const rows: Array<{ key: string; updated_at: number; valid_time: number | null; committed_time: number | null }> = [
      { key: "area:old", updated_at: 100, valid_time: 100, committed_time: 120 },
      { key: "area:new", updated_at: 500, valid_time: 500, committed_time: 520 },
      { key: "world:fallback", updated_at: 200, valid_time: null, committed_time: null },
    ];

    const filtered = filterProjectionRowsByTimeSlice(rows, { asOfValidTime: 300, asOfCommittedTime: 300 });
    expect(filtered.map((row) => row.key)).toEqual(["area:old", "world:fallback"]);
  });

  it("treats updated_at as fallback time for projection rows without explicit valid/committed times", () => {
    expect(
      isProjectionRowInTimeSlice(
        { updated_at: 250, valid_time: null, committed_time: null },
        { asOfValidTime: 300, asOfCommittedTime: 300 },
      ),
    ).toBe(true);

    expect(
      isProjectionRowInTimeSlice(
        { updated_at: 450, valid_time: null, committed_time: null },
        { asOfValidTime: 300, asOfCommittedTime: 300 },
      ),
    ).toBe(false);
  });
});
