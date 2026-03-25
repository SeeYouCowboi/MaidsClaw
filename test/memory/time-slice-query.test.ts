import { describe, expect, it } from "bun:test";
import {
  filterProjectionRowsByTimeSlice,
  filterEvidencePathsByTimeSlice,
  isProjectionRowInTimeSlice,
  isEdgeInTimeSlice,
  summarizeTimeSlicedPaths,
  buildTimeSliceQuery,
  type TimeSliceDimension,
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
        redacted_placeholders: [{ type: "redacted", reason: "private", node_ref: "event:9" }],
      },
    ];

    const filtered = filterEvidencePathsByTimeSlice(input, { asOfCommittedTime: 300 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.redacted_placeholders).toEqual([{ type: "redacted", reason: "private", node_ref: "event:9" }]);
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

  // ---------------------------------------------------------------------------
  // buildTimeSliceQuery — dual-dimension helper
  // ---------------------------------------------------------------------------

  describe("buildTimeSliceQuery", () => {
    it("maps valid_time dimension to asOfValidTime", () => {
      const query = buildTimeSliceQuery({ dimension: "valid_time", asOf: 500 });
      expect(query.asOfValidTime).toBe(500);
      expect(query.asOfCommittedTime).toBeUndefined();
    });

    it("maps committed_time dimension to asOfCommittedTime", () => {
      const query = buildTimeSliceQuery({ dimension: "committed_time", asOf: 700 });
      expect(query.asOfCommittedTime).toBe(700);
      expect(query.asOfValidTime).toBeUndefined();
    });

    it("valid_time query returns correct slice — includes edges at or before asOf", () => {
      const query = buildTimeSliceQuery({ dimension: "valid_time", asOf: 200 });
      expect(isEdgeInTimeSlice({ valid_time: 150 }, query)).toBe(true);
      expect(isEdgeInTimeSlice({ valid_time: 200 }, query)).toBe(true);
      expect(isEdgeInTimeSlice({ valid_time: 250 }, query)).toBe(false);
    });

    it("committed_time query returns different result from same time point", () => {
      // Edge with valid_time=100, committed_time=300
      const edge = { valid_time: 100, committed_time: 300 };

      // "What was the world state at t=200?" — valid_time dimension
      const validQuery = buildTimeSliceQuery({ dimension: "valid_time", asOf: 200 });
      expect(isEdgeInTimeSlice(edge, validQuery)).toBe(true); // valid_time 100 <= 200

      // "What did the agent know at t=200?" — committed_time dimension
      const committedQuery = buildTimeSliceQuery({ dimension: "committed_time", asOf: 200 });
      expect(isEdgeInTimeSlice(edge, committedQuery)).toBe(false); // committed_time 300 > 200
    });
  });

  // ---------------------------------------------------------------------------
  // t_valid = 0 semantics: "no time constraint" — visible in any time slice
  // ---------------------------------------------------------------------------

  describe("t_valid=0 as no-constraint", () => {
    it("edge with valid_time=0 is visible in any valid_time slice", () => {
      const edge = { valid_time: 0, committed_time: 100 };
      expect(isEdgeInTimeSlice(edge, { asOfValidTime: 1 })).toBe(true);
      expect(isEdgeInTimeSlice(edge, { asOfValidTime: 9999 })).toBe(true);
      // committed_time=0 also treated as no-constraint
      const edge2 = { valid_time: 50, committed_time: 0 };
      expect(isEdgeInTimeSlice(edge2, { asOfCommittedTime: 1 })).toBe(true);
    });

    it("projection row with valid_time=0 is visible in any valid_time slice", () => {
      const row = { updated_at: 500, valid_time: 0, committed_time: 100 };
      expect(isProjectionRowInTimeSlice(row, { asOfValidTime: 1 })).toBe(true);
      expect(isProjectionRowInTimeSlice(row, { asOfValidTime: 9999 })).toBe(true);
    });

    it("projection row with committed_time=0 is visible in any committed_time slice", () => {
      const row = { updated_at: 500, valid_time: 100, committed_time: 0 };
      expect(isProjectionRowInTimeSlice(row, { asOfCommittedTime: 1 })).toBe(true);
    });

    it("edge with valid_time=0 still filtered by committed_time when that is set", () => {
      const edge = { valid_time: 0, committed_time: 500 };
      // valid_time=0 => no constraint on valid_time
      // but committed_time=500 > 200 => filtered out
      expect(isEdgeInTimeSlice(edge, { asOfValidTime: 200, asOfCommittedTime: 200 })).toBe(false);
    });

    it("filterEvidencePathsByTimeSlice keeps edges with valid_time=0", () => {
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
                timestamp: null,
                summary: "timeless edge",
                valid_time: 0,
                committed_time: 50,
              } as any,
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

      const filtered = filterEvidencePathsByTimeSlice(paths, { asOfValidTime: 1, asOfCommittedTime: 100 });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.path.edges).toHaveLength(1);
    });
  });
});
