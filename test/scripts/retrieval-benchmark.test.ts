import { describe, expect, it } from "bun:test";
import {
	computeCrossAgentLeakageCount,
	computeMrr,
	computeRecallAtK,
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
});
