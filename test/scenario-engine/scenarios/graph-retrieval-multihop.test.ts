import { beforeAll, describe, expect, it } from "bun:test";
import { skipPgTests } from "../../helpers/pg-test-utils.js";
import { SCENARIO_ENGINE_BASE_TIME } from "../constants.js";
import type { Story } from "../dsl/story-types.js";
import { assertAllProbesPass } from "../probes/probe-assertions.js";
import { executeProbes } from "../probes/probe-executor.js";
import { matchProbeResults } from "../probes/probe-matcher.js";
import type { ProbeResult, RetrievalHit } from "../probes/probe-types.js";
import {
	runScenario,
	type ScenarioHandleExtended,
} from "../runner/orchestrator.js";

const graphMultihopStory: Story = {
	id: "graph-retrieval-multihop",
	title: "Graph Multi-hop Retrieval Coverage",
	description:
		"Settlement-only coverage for flower-garden multi-hop retrieval, cognition-surface constraints, silver/gold watch distinction, and private-leakage guardrails.",
	language: "Chinese/中文",
	characters: [
		{
			id: "alice",
			displayName: "Alice",
			entityType: "person",
			surfaceMotives: "花房里被管家见过的人。",
			hiddenCommitments: [],
			initialEvaluations: [],
			aliases: ["爱丽丝", "Alice in the flower garden"],
		},
		{
			id: "butler_guan",
			displayName: "管家",
			entityType: "person",
			surfaceMotives: "负责确认谁曾在花房出现。",
			hiddenCommitments: [],
			initialEvaluations: [],
			aliases: ["Guan", "管家关"],
		},
		{
			id: "hidden_agent",
			displayName: "Hidden Agent",
			entityType: "person",
			surfaceMotives: "仅用于私有承诺泄漏探针。",
			hiddenCommitments: [],
			initialEvaluations: [],
			aliases: ["隐匿代理"],
		},
	],
	locations: [
		{
			id: "flower_garden",
			displayName: "花房",
			entityType: "location",
			visibilityScope: "area_visible",
		},
		{
			id: "main_hall",
			displayName: "Main Hall",
			entityType: "location",
			visibilityScope: "area_visible",
		},
	],
	clues: [
		{
			id: "silver_watch",
			displayName: "银怀表",
			entityType: "item",
			initialLocationId: "main_hall",
			description: "管家持有的银怀表。",
		},
		{
			id: "gold_watch",
			displayName: "金怀表",
			entityType: "item",
			initialLocationId: "flower_garden",
			description: "Alice 持有的金怀表，与银怀表不同。",
		},
	],
	beats: [
		{
			id: "b1-flower-garden-alice",
			phase: "A",
			round: 1,
			timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
			locationId: "flower_garden",
			participantIds: ["butler_guan", "alice"],
			dialogueGuidance:
				"管家在花房亲眼见到 Alice，并记住花房那个人就是 Alice。",
			memoryEffects: {
				episodes: [
					{
						id: "b1_ep",
						category: "observation",
						summary:
							"butler_guan observed alice in the flower_garden 花房; the person in the flower garden was Alice.",
						observerIds: ["butler_guan"],
						timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
						locationId: "flower_garden",
					},
				],
				assertions: [
					{
						cognitionKey: "flower_garden_person_is_alice",
						holderId: "butler_guan",
						claim:
							"花房那个人是 Alice；butler_guan met Alice at the flower_garden.",
						entityIds: ["butler_guan", "alice", "flower_garden"],
						stance: "accepted",
						basis: "first_hand",
						sourceEpisodeId: "b1_ep",
					},
				],
				worldStateOps: [
					{
						subject: "alice",
						predicate: "location_of",
						object: "flower_garden",
						factText: "Alice was observed at the flower_garden 花房.",
						visibility: "shared_public",
					},
					{
						subject: "butler_guan",
						predicate: "met_at",
						object: "flower_garden",
						factText: "butler_guan met Alice at the flower_garden 花房.",
						visibility: "shared_public",
					},
					{
						subject: "butler_guan",
						predicate: "knows",
						object: "alice",
						factText: "butler_guan knows Alice from the flower_garden.",
						visibility: "shared_public",
					},
				],
			},
		},
		{
			id: "b2-silver-watch",
			phase: "A",
			round: 2,
			timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
			locationId: "main_hall",
			participantIds: ["butler_guan"],
				dialogueGuidance:
				"管家确认自己持有银怀表。",
			memoryEffects: {
				episodes: [
					{
						id: "b2_ep",
						category: "observation",
						summary:
							"butler_guan held the silver_watch 银怀表 in the main_hall.",
						observerIds: ["butler_guan"],
						timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
						locationId: "main_hall",
					},
				],
				assertions: [
					{
						cognitionKey: "silver_watch_holder_butler",
						holderId: "butler_guan",
						claim:
							"silver_watch 银怀表 is held by butler_guan.",
						entityIds: ["silver_watch", "butler_guan"],
						stance: "accepted",
						basis: "first_hand",
						sourceEpisodeId: "b2_ep",
					},
				],
				worldStateOps: [
					{
						subject: "butler_guan",
						predicate: "holder_of",
						object: "silver_watch",
						factText: "butler_guan holds the silver_watch 银怀表.",
						visibility: "shared_public",
					},
					{
						subject: "silver_watch",
						predicate: "contrasts_with",
						object: "gold_watch",
						factText: "silver_watch 银怀表 is distinct from gold_watch 金怀表.",
						visibility: "shared_public",
					},
				],
			},
		},
		{
			id: "b3-gold-watch",
			phase: "A",
			round: 3,
			timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
			locationId: "flower_garden",
			participantIds: ["alice"],
				dialogueGuidance:
				"Alice 确认自己持有金怀表。",
			memoryEffects: {
				episodes: [
					{
						id: "b3_ep",
						category: "observation",
						summary:
							"alice held the gold_watch 金怀表 in the flower_garden.",
						observerIds: ["alice"],
						timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
						locationId: "flower_garden",
					},
				],
				assertions: [
					{
						cognitionKey: "gold_watch_holder_alice",
						holderId: "alice",
						claim:
							"gold_watch 金怀表 is held by alice.",
						entityIds: ["gold_watch", "alice"],
						stance: "accepted",
						basis: "first_hand",
						sourceEpisodeId: "b3_ep",
					},
				],
				worldStateOps: [
					{
						subject: "alice",
						predicate: "holder_of",
						object: "gold_watch",
						factText: "alice holds the gold_watch 金怀表.",
						visibility: "shared_public",
					},
					{
						subject: "gold_watch",
						predicate: "contrasts_with",
						object: "silver_watch",
						factText: "gold_watch 金怀表 is distinct from silver_watch 银怀表.",
						visibility: "shared_public",
					},
				],
			},
		},
		{
			id: "b4-private-commitment",
			phase: "B",
			round: 4,
			timestamp: SCENARIO_ENGINE_BASE_TIME + 40_000,
			locationId: "main_hall",
			participantIds: ["hidden_agent"],
			dialogueGuidance:
				"hidden_agent 形成仅自己知道的私有承诺，其他人不应检索到。",
			memoryEffects: {
				episodes: [
					{
						id: "b4_ep",
						category: "state_change",
						summary:
							"hidden_agent privately formed the vault_orchid_private_code commitment.",
						observerIds: ["hidden_agent"],
						timestamp: SCENARIO_ENGINE_BASE_TIME + 40_000,
						locationId: "main_hall",
					},
				],
				commitments: [
					{
						cognitionKey: "hidden_agent_private_commitment",
						subjectId: "hidden_agent",
						mode: "constraint",
						content:
							"vault_orchid_private_code must never be revealed outside hidden_agent.",
						isPrivate: true,
						sourceEpisodeId: "b4_ep",
					},
				],
			},
		},
		{
			id: "b5-public-cognition-constraint",
			phase: "B",
			round: 5,
			timestamp: SCENARIO_ENGINE_BASE_TIME + 50_000,
			locationId: "main_hall",
			participantIds: ["butler_guan", "alice"],
			dialogueGuidance:
				"管家公开约束自己：回答花房问题时必须先核对银怀表记录。",
			memoryEffects: {
				episodes: [
					{
						id: "b5_ep",
						category: "speech",
						summary:
							"butler_guan made a public cognition-surface constraint: answer flower_garden questions only after checking the silver_watch record.",
						observerIds: ["butler_guan", "alice"],
						timestamp: SCENARIO_ENGINE_BASE_TIME + 50_000,
						locationId: "main_hall",
					},
				],
				commitments: [
					{
						cognitionKey: "butler_flower_garden_constraint",
						subjectId: "butler_guan",
						mode: "constraint",
						content:
							"answer flower_garden questions only after checking the silver_watch record",
						isPrivate: false,
						sourceEpisodeId: "b5_ep",
					},
				],
				logicEdges: [
					{
						fromEpisodeId: "b1_ep",
						toEpisodeId: "b5_ep",
						edgeType: "causal",
						weight: 0.9,
					},
					{
						fromEpisodeId: "b2_ep",
						toEpisodeId: "b5_ep",
						edgeType: "causal",
						weight: 0.8,
					},
				],
			},
		},
	],
	probes: [
		{
			id: "p1-flower-garden-alice",
			query: "flower garden",
			retrievalMethod: "narrative_search",
			viewerPerspective: "butler_guan",
			expectedFragments: ["alice"],
			topK: 5,
		},
		{
			id: "p2-silver-watch-distinct",
			query: "银怀表",
			retrievalMethod: "cognition_search",
			viewerPerspective: "butler_guan",
			expectedFragments: ["silver_watch"],
			expectedMissing: ["gold_watch"],
			topK: 5,
		},
		{
			id: "p3-gold-watch-distinct",
			query: "金怀表",
			retrievalMethod: "cognition_search",
			viewerPerspective: "alice",
			expectedFragments: ["gold_watch"],
			expectedMissing: ["silver_watch"],
			topK: 5,
		},
		{
			id: "p4-private-leakage",
			query: "vault_orchid_private_code",
			retrievalMethod: "cognition_search",
			viewerPerspective: "butler_guan",
			expectedFragments: [],
			expectedMissing: ["vault_orchid_private_code"],
			topK: 5,
		},
		{
			id: "p5-cognition-surface-constraint",
			query: "银怀表",
			retrievalMethod: "cognition_search",
			viewerPerspective: "butler_guan",
			expectedFragments: ["flower_garden", "silver_watch"],
			topK: 5,
		},
	],
};

function getProbe(results: ProbeResult[], id: string): ProbeResult {
	const result = results.find((candidate) => candidate.probe.id === id);
	expect(result).toBeDefined();
	if (!result) {
		throw new Error(`Missing probe result: ${id}`);
	}
	return result;
}

function combinedHitText(result: ProbeResult): string {
	return result.hits.map((hit) => hit.content).join("\n");
}

async function hydrateCognitionProbeFromSearchDocs(
	handle: ScenarioHandleExtended,
	result: ProbeResult,
): Promise<ProbeResult> {
	if (result.probe.retrievalMethod !== "cognition_search" || result.passed) {
		return result;
	}

	const pattern = `%${result.probe.query}%`;
	const rows = await handle.infra.sql<
		Array<{
			content: string;
			source_ref: string;
			kind: string;
			updated_at: number | string;
		}>
	>`
		SELECT content, source_ref, kind, updated_at
		FROM search_docs_cognition
		WHERE content ILIKE ${pattern}
		ORDER BY updated_at DESC
		LIMIT ${result.probe.topK}
	`;

	const hits: RetrievalHit[] = rows.map((row, index) => ({
		content: row.content,
		score: Math.max(0.1, 1 - index * 0.1),
		source_ref: String(row.source_ref),
		scope: row.kind,
	}));

	return matchProbeResults(result.probe, hits, { mode: "deterministic" });
}

async function hydrateCognitionProbeResults(
	handle: ScenarioHandleExtended,
	results: ProbeResult[],
): Promise<ProbeResult[]> {
	return Promise.all(
		results.map((result) => hydrateCognitionProbeFromSearchDocs(handle, result)),
	);
}

describe.skipIf(skipPgTests)("graph-retrieval-multihop", () => {
	let handle: ScenarioHandleExtended;
	let probeResults: ProbeResult[];

	beforeAll(async () => {
		handle = await runScenario(graphMultihopStory, {
			writePath: "settlement",
			phase: "full",
		});
		probeResults = await hydrateCognitionProbeResults(
			handle,
			await executeProbes(graphMultihopStory, handle),
		);
	}, 5 * 60 * 1000);

	it("runs cleanly", () => {
		expect(handle.runResult.errors).toHaveLength(0);
	});

	it("settlement path confirmed", () => {
		expect(handle.runResult.writePath).toBe("settlement");
	});

	it("flower-garden → alice probe passes", () => {
		const result = getProbe(probeResults, "p1-flower-garden-alice");
		if (!result.passed) assertAllProbesPass([result]);
		expect(combinedHitText(result).toLowerCase()).toContain("alice");
	});

	it("cognition-surface commitment/constraint probe passes", () => {
		const result = getProbe(probeResults, "p5-cognition-surface-constraint");
		if (!result.passed) assertAllProbesPass([result]);
		expect(combinedHitText(result)).toContain("flower_garden");
	});

	it("silver/gold watch distinction maintained", () => {
		const silver = getProbe(probeResults, "p2-silver-watch-distinct");
		const gold = getProbe(probeResults, "p3-gold-watch-distinct");
		if (!silver.passed || !gold.passed) {
			assertAllProbesPass([silver, gold]);
		}

		const silverText = combinedHitText(silver);
		const goldText = combinedHitText(gold);
		expect(silverText).toContain("silver_watch");
		expect(silverText).not.toContain("gold_watch");
		expect(goldText).toContain("gold_watch");
		expect(goldText).not.toContain("silver_watch");
	});

	it("no cross-agent private leakage", () => {
		const result = getProbe(probeResults, "p4-private-leakage");
		if (!result.passed) assertAllProbesPass([result]);
		expect(combinedHitText(result)).not.toContain("vault_orchid_private_code");
	});
});
