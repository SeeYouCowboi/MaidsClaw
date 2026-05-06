import { describe, expect, it } from "bun:test";
import {
	formatActivateOutput,
	formatDryRunOutput,
	identifyUnknownPredicates,
} from "../../scripts/graph-retrieval-rebuild";
import { FACT_EDGE_PREDICATES } from "../../src/runtime/rp-turn-contract";

describe("graph-retrieval-rebuild helpers", () => {
	it("formatDryRunOutput returns the canonical dry_run shape", () => {
		const out = formatDryRunOutput(
			{ mention: 5, fact: 2 },
			{ shared_public: 7 },
			[{ id: 1, predicate: "weird_one", count: 3 }],
			"run-abc",
			7,
		);
		expect(out).toEqual({
			mode: "dry_run",
			edge_counts_by_kind: { mention: 5, fact: 2 },
			edge_counts_by_scope: { shared_public: 7 },
			unknown_predicate_rows: [{ id: 1, predicate: "weird_one", count: 3 }],
			active_run_id: "run-abc",
			total_edges: 7,
		});
	});

	it("identifyUnknownPredicates filters out the controlled list", () => {
		const sample = [
			"location_of",
			"weird_one",
			"trusts",
			"another_unknown",
			"weird_one",
		];
		const unknown = identifyUnknownPredicates(sample, FACT_EDGE_PREDICATES);
		expect(unknown).toEqual(["weird_one", "another_unknown"]);
	});

	it("identifyUnknownPredicates returns empty when all are controlled", () => {
		const allKnown = [...FACT_EDGE_PREDICATES];
		expect(identifyUnknownPredicates(allKnown, FACT_EDGE_PREDICATES)).toEqual(
			[],
		);
	});

	it("formatActivateOutput merges dry_run inventory with activation result", () => {
		const dryRun = formatDryRunOutput(
			{ mention: 1 },
			{ shared_public: 1 },
			[],
			"run-old",
			1,
		);
		const activation = {
			run_id: "run-new",
			mention_edges: 10,
			cooccurrence_edges: 4,
			fact_edges: 2,
			semantic_edges: 1,
			total_inserted: 17,
		};
		const out = formatActivateOutput(dryRun, activation);
		expect(out.mode).toBe("activate");
		expect(out.activation_result).toEqual(activation);
		expect(out.edge_counts_by_kind).toEqual({ mention: 1 });
		expect(out.active_run_id).toBe("run-old");
	});
});
