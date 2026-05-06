import { describe, expect, it } from "bun:test";
import {
	computeCrossAgentLeakageCount,
	computeGraphPprContribution,
	computeMrr,
	computePprOnOffDelta,
	computeRecallAtK,
	GRAPH_PPR_COGNITION_SIGNAL,
	GRAPH_PPR_EPISODE_SIGNAL,
	percentile,
} from "../../scripts/retrieval-benchmark";

describe("retrieval-benchmark metrics", () => {
	it("computes recall@5 and recall@10 for expected-hit cases", () => {
		const rows = [
			{
				expectedTopRef: "episode:1",
				topRefs: ["episode:x", "episode:1", "episode:y"],
			},
			{
				expectedTopRef: "episode:2",
				topRefs: ["episode:a", "episode:b", "episode:c", "episode:d", "episode:e", "episode:f", "episode:g", "episode:h", "episode:i", "episode:2"],
			},
			{
				expectedTopRef: null,
				topRefs: ["episode:noise"],
			},
		];

		expect(computeRecallAtK(rows, 5)).toBeCloseTo(0.5, 6);
		expect(computeRecallAtK(rows, 10)).toBeCloseTo(1, 6);
	});

	it("computes mean reciprocal rank", () => {
		const rows = [
			{
				expectedTopRef: "episode:1",
				topRefs: ["episode:1", "episode:x"],
			},
			{
				expectedTopRef: "episode:2",
				topRefs: ["episode:x", "episode:y", "episode:2"],
			},
			{
				expectedTopRef: null,
				topRefs: ["episode:z"],
			},
		];

		// (1 + 1/3) / 2
		expect(computeMrr(rows)).toBeCloseTo(2 / 3, 6);
	});

	it("computes p50 and p95 percentiles in ms", () => {
		const samples = [12, 30, 45, 120, 200];
		expect(percentile(samples, 50)).toBe(45);
		expect(percentile(samples, 95)).toBe(200);
	});

	it("counts cross-agent leakage rows", () => {
		const leakageRows = [
			{ leakageCount: 0 },
			{ leakageCount: 2 },
			{ leakageCount: 0 },
			{ leakageCount: 1 },
		];
		expect(computeCrossAgentLeakageCount(leakageRows)).toBe(3);
	});

	it("sums graph PPR per-signal contribution counts across traces", () => {
		const traces = [
			{
				rrfContribution: [
					{ signal: GRAPH_PPR_EPISODE_SIGNAL, count: 3 },
					{ signal: GRAPH_PPR_COGNITION_SIGNAL, count: 1 },
					{ signal: "lexical_episode", count: 5 },
				],
			},
			{
				rrfContribution: [
					{ signal: GRAPH_PPR_EPISODE_SIGNAL, count: 2 },
					{ signal: "embedding_episode", count: 4 },
				],
			},
			{ rrfContribution: [] },
		];

		expect(
			computeGraphPprContribution(traces, GRAPH_PPR_EPISODE_SIGNAL),
		).toBe(5);
		expect(
			computeGraphPprContribution(traces, GRAPH_PPR_COGNITION_SIGNAL),
		).toBe(1);
		expect(computeGraphPprContribution(traces, "unknown_signal")).toBe(0);
		expect(computeGraphPprContribution([], GRAPH_PPR_EPISODE_SIGNAL)).toBe(0);
	});

	it("computes PPR on/off recall delta", () => {
		expect(computePprOnOffDelta(0.85, 0.6)).toBeCloseTo(0.25, 6);
		expect(computePprOnOffDelta(0.5, 0.5)).toBe(0);
		expect(computePprOnOffDelta(0.4, 0.7)).toBeCloseTo(-0.3, 6);
	});
});
