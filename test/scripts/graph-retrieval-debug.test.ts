import { describe, expect, it } from "bun:test";
import {
	type FactEdgeRow,
	formatEmissionStatsOutput,
	formatPprDebugOutput,
	redactPrivateNodes,
} from "../../scripts/graph-retrieval-debug";
import type { GraphRetrievalTrace } from "../../src/memory/retrieval/graph-retrieval-trace";

describe("graph-retrieval-debug helpers", () => {
	it("formatEmissionStatsOutput computes predicate distribution and unresolved ratio", () => {
		const rows: FactEdgeRow[] = [
			{ predicate: "knows", source_entity_id: 1, target_entity_id: 2 },
			{ predicate: "knows", source_entity_id: 3, target_entity_id: null },
			{ predicate: "trusts", source_entity_id: null, target_entity_id: 4 },
			{ predicate: "location_of", source_entity_id: 5, target_entity_id: 6 },
		];
		const out = formatEmissionStatsOutput(rows);
		expect(out.mode).toBe("emission_stats");
		expect(out.total_fact_edges).toBe(4);
		expect(out.predicate_distribution).toEqual({
			knows: 2,
			trusts: 1,
			location_of: 1,
		});
		expect(out.unresolved_ratio).toBeCloseTo(0.5, 6);
		expect(out.warning).toBeUndefined();
	});

	it("formatEmissionStatsOutput emits zero-emission warning on empty input", () => {
		const out = formatEmissionStatsOutput([]);
		expect(out.total_fact_edges).toBe(0);
		expect(out.predicate_distribution).toEqual({});
		expect(out.unresolved_ratio).toBe(0);
		expect(out.warning).toBe("zero emissions detected — graph will be empty");
	});

	it("redactPrivateNodes strips private:-prefixed refs", () => {
		const nodes = [
			{ ref: "char:alice", score: 1 },
			{ ref: "private:agent-a:secret", score: 0.9 },
			{ ref: "loc:tea_room", score: 0.5 },
			{ ref: "private:agent-b:hidden", score: 0.1 },
		];
		const filtered = redactPrivateNodes(nodes);
		expect(filtered.map((n) => n.ref)).toEqual([
			"char:alice",
			"loc:tea_room",
		]);
	});

	it("formatPprDebugOutput surfaces rrf contribution counts and never leaks private refs", () => {
		const trace: GraphRetrievalTrace = {
			enabled: true,
			seedRefs: ["char:alice"],
			visibleNodeCount: 3,
			visibleEdgeCount: 2,
			pprParams: { damping: 0.5, maxIterations: 30, epsilon: 1e-4 },
			topPprNodes: [{ ref: "char:alice", score: 0.7 }],
			topPprEpisodes: [{ ref: "episode:fixture:tea-room", score: 0.5 }],
			topPprCognitions: [],
			rrfContribution: [
				{ signal: "graph_ppr_episode", count: 4 },
				{ signal: "graph_ppr_cognition", count: 1 },
			],
			budgetBefore: { episode: 0, cognition: 0 },
			budgetAfter: { episode: 0, cognition: 0 },
			factEdgesCountAtQueryTime: 12,
		};
		const out = formatPprDebugOutput(trace, 12);
		expect(out.mode).toBe("ppr_debug");
		expect(out.fact_edges_count_at_query_time).toBe(12);
		expect(out.rrf_contribution).toEqual({
			graph_ppr_episode: 4,
			graph_ppr_cognition: 1,
		});
		const allRefs = [
			...out.top_ppr_nodes,
			...out.top_ppr_episodes,
			...out.top_ppr_cognitions,
		].map((n) => n.ref);
		for (const ref of allRefs) {
			expect(ref.startsWith("private:")).toBe(false);
		}
	});
});
