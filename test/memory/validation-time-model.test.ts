import { describe, expect, it } from "bun:test";
import {
	filterEvidencePathsByTimeSlice,
	hasTimeSlice,
	isEdgeInTimeSlice,
} from "../../src/memory/time-slice-query.js";
import { EpisodeRepository } from "../../src/memory/episode/episode-repo.js";
import type { BeamEdge, EvidencePath, NodeRef, PathScore } from "../../src/memory/types.js";
import { cleanupDb, createTempDb } from "../helpers/memory-test-utils.js";

function ref(value: string): NodeRef {
	return value as NodeRef;
}

function makeScore(): PathScore {
	return {
		seed_score: 0.8,
		edge_type_score: 0.7,
		temporal_consistency: 1,
		query_intent_match: 0.6,
		support_score: 0.5,
		recency_score: 0.4,
		hop_penalty: 0,
		redundancy_penalty: 0,
		path_score: 0.75,
	};
}

function makeEdge(from: string, to: string, timestamp: number): BeamEdge {
	return {
		from: ref(from),
		to: ref(to),
		kind: "causal",
		layer: "symbolic",
		weight: 1,
		timestamp,
		summary: `${from}->${to}`,
	};
}

describe("V2 validation: time model and time-slice query", () => {
	it("hasTimeSlice detects whether either cut is provided", () => {
		expect(hasTimeSlice(undefined)).toBe(false);
		expect(hasTimeSlice({})).toBe(false);
		expect(hasTimeSlice({ asOfValidTime: 100 })).toBe(true);
		expect(hasTimeSlice({ asOfCommittedTime: 200 })).toBe(true);
		expect(hasTimeSlice({ asOfValidTime: 100, asOfCommittedTime: 200 })).toBe(true);
	});

	it("isEdgeInTimeSlice applies valid-time filter with null and timestamp fallback behavior", () => {
		expect(isEdgeInTimeSlice({ valid_time: 150 }, { asOfValidTime: 200 })).toBe(true);
		expect(isEdgeInTimeSlice({ valid_time: 150 }, { asOfValidTime: 100 })).toBe(false);

		expect(isEdgeInTimeSlice({ valid_time: null }, { asOfValidTime: 100 })).toBe(true);

		expect(isEdgeInTimeSlice({ timestamp: 150 }, { asOfValidTime: 200 })).toBe(true);
		expect(isEdgeInTimeSlice({ timestamp: 150 }, { asOfValidTime: 100 })).toBe(false);
	});

	it("isEdgeInTimeSlice applies committed-time filter and requires both cuts when both are set", () => {
		expect(isEdgeInTimeSlice({ committed_time: 150 }, { asOfCommittedTime: 200 })).toBe(true);
		expect(isEdgeInTimeSlice({ committed_time: 150 }, { asOfCommittedTime: 100 })).toBe(false);

		const edge = { valid_time: 100, committed_time: 200 };
		expect(isEdgeInTimeSlice(edge, { asOfValidTime: 150, asOfCommittedTime: 250 })).toBe(true);
		expect(isEdgeInTimeSlice(edge, { asOfValidTime: 50, asOfCommittedTime: 250 })).toBe(false);
		expect(isEdgeInTimeSlice(edge, { asOfValidTime: 150, asOfCommittedTime: 150 })).toBe(false);
	});

	it("filterEvidencePathsByTimeSlice keeps only in-slice edges and omits paths fully after cutoff", () => {
		const edge100 = { ...makeEdge("event:1", "event:2", 100), valid_time: 100 };
		const edge200 = { ...makeEdge("event:2", "event:3", 200), valid_time: 200 };
		const edge300 = { ...makeEdge("event:3", "event:4", 300), valid_time: 300 };

		const fullyLateEdge400 = { ...makeEdge("event:10", "event:11", 400), valid_time: 400 };
		const fullyLateEdge500 = { ...makeEdge("event:11", "event:12", 500), valid_time: 500 };

		const paths: EvidencePath[] = [
			{
				path: {
					seed: ref("event:1"),
					nodes: [ref("event:1"), ref("event:2"), ref("event:3"), ref("event:4")],
					edges: [edge100, edge200, edge300] as BeamEdge[],
					depth: 3,
				},
				score: makeScore(),
				supporting_nodes: [ref("event:2"), ref("event:3"), ref("event:4")],
				supporting_facts: [],
			},
			{
				path: {
					seed: ref("event:10"),
					nodes: [ref("event:10"), ref("event:11"), ref("event:12")],
					edges: [fullyLateEdge400, fullyLateEdge500] as BeamEdge[],
					depth: 2,
				},
				score: makeScore(),
				supporting_nodes: [ref("event:11"), ref("event:12")],
				supporting_facts: [],
			},
		];

		const filtered = filterEvidencePathsByTimeSlice(paths, { asOfValidTime: 250 });

		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.path.edges).toHaveLength(2);
		expect(filtered[0]?.path.nodes).toEqual(["event:1", "event:2", "event:3"]);
		expect(filtered[0]?.supporting_nodes).toEqual(["event:2", "event:3"]);
		expect(filtered[0]?.path.depth).toBe(2);
		expect(filtered.some((path) => path.path.seed === ref("event:10"))).toBe(false);
	});

	it("private_episode_events persists valid_time and committed_time with valid_time nullable", () => {
		const { db, dbPath } = createTempDb();
		const repo = new EpisodeRepository(db);

		try {
			const withValidId = repo.append({
				agentId: "rp:alice",
				sessionId: "session-time-1",
				settlementId: "stl:time-1",
				category: "speech",
				summary: "Event with both clocks",
				validTime: 1_700,
				committedTime: 1_800,
			});

			const withoutValidId = repo.append({
				agentId: "rp:alice",
				sessionId: "session-time-1",
				settlementId: "stl:time-2",
				category: "action",
				summary: "Event without valid-time",
				committedTime: 1_900,
			});

			const rows = db.query<{ id: number; valid_time: number | null; committed_time: number }>(
				`SELECT id, valid_time, committed_time FROM private_episode_events WHERE id IN (?, ?) ORDER BY id ASC`,
				[withValidId, withoutValidId],
			);

			expect(rows).toHaveLength(2);
			expect(rows[0]?.id).toBe(withValidId);
			expect(rows[0]?.valid_time).toBe(1_700);
			expect(rows[0]?.committed_time).toBe(1_800);

			expect(rows[1]?.id).toBe(withoutValidId);
			expect(rows[1]?.valid_time).toBeNull();
			expect(rows[1]?.committed_time).toBe(1_900);
		} finally {
			cleanupDb(db, dbPath);
		}
	});
});
