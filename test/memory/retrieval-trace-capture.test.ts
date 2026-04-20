import { describe, expect, it } from "bun:test";
import type { CognitionSearchService } from "../../src/memory/cognition/cognition-search.js";
import type { EmbeddingService } from "../../src/memory/embeddings.js";
import type { NarrativeSearchService } from "../../src/memory/narrative/narrative-search.js";
import type {
	QueryPlan,
	QueryPlanBuilder,
} from "../../src/memory/query-plan-types.js";
import type {
	QueryRoute,
	QueryRouter,
} from "../../src/memory/query-routing-types.js";
import type {
	RetrievalOrchestrator,
	TypedRetrievalResult,
} from "../../src/memory/retrieval/retrieval-orchestrator.js";
import {
	RetrievalService,
	type RetrievalTraceCaptureHook,
} from "../../src/memory/retrieval.js";
import type { ViewerContext } from "../../src/memory/types.js";
import type { RetrievalReadRepo } from "../../src/storage/domain-repos/contracts/retrieval-read-repo.js";

type TraceCapture = Parameters<RetrievalTraceCaptureHook>[0];

const viewerContext: ViewerContext = {
	viewer_agent_id: "agent-1",
	viewer_role: "rp_agent",
	session_id: "session-1",
};

function makeQueryRoute(): QueryRoute {
	return {
		originalQuery: "what happened",
		normalizedQuery: "what happened",
		intents: [],
		primaryIntent: "event",
		routeConfidence: 0.8,
		resolvedEntityIds: [],
		entityHints: [],
		relationPairs: [],
		timeConstraint: null,
		timeSignals: [],
		locationHints: [],
		asksWhy: false,
		asksChange: false,
		asksComparison: false,
		signals: {
			needsEpisode: 0,
			needsConflict: 0,
			needsTimeline: 0,
			needsRelationship: 0,
			needsCognition: 1,
			needsEntityFocus: 1,
		},
		rationale: "test",
		matchedRules: [],
		classifierVersion: "test-v1",
	};
}

function makeQueryPlan(route: QueryRoute): QueryPlan {
	return {
		route,
		surfacePlans: {
			narrative: {
				baseQuery: route.normalizedQuery,
				entityFilters: [7],
				timeWindow: { asOfCommittedTime: 1700000000000 },
				weight: 0.5,
				enabledByRole: true,
			},
			cognition: {
				baseQuery: route.normalizedQuery,
				entityFilters: [9],
				timeWindow: { asOfCommittedTime: 1700000000001 },
				weight: 0.5,
				enabledByRole: true,
				kind: "assertion",
				stance: "contested",
			},
			episode: {
				baseQuery: route.normalizedQuery,
				entityFilters: [],
				timeWindow: null,
				weight: 0.2,
				enabledByRole: true,
			},
			conflictNotes: {
				baseQuery: route.normalizedQuery,
				entityFilters: [],
				timeWindow: null,
				weight: 0.2,
				enabledByRole: true,
			},
		},
		graphPlan: {
			primaryIntent: "event",
			secondaryIntents: [],
			timeSlice: null,
			seedBias: {
				entity: 0.5,
				event: 0.5,
				episode: 0.2,
				assertion: 0.4,
				evaluation: 0,
				commitment: 0.3,
			},
			edgeBias: {},
		},
		builderVersion: "test-plan-v1",
		rationale: "test",
		matchedRules: [],
	};
}

function makeRetrievalService(
	typed: TypedRetrievalResult,
	options?: {
		queryRouter?: QueryRouter;
		queryPlanBuilder?: QueryPlanBuilder;
	},
): RetrievalService {
	const orchestrator = {
		search: async () => ({
			typed,
			narrativeHints: [],
			cognitionHits: [],
		}),
	} as unknown as RetrievalOrchestrator;

	return new RetrievalService({
		retrievalRepo: {} as unknown as RetrievalReadRepo,
		embeddingService: {} as unknown as EmbeddingService,
		narrativeSearch: {} as unknown as NarrativeSearchService,
		cognitionSearch: {} as unknown as CognitionSearchService,
		orchestrator,
		queryRouter: options?.queryRouter,
		queryPlanBuilder: options?.queryPlanBuilder,
	});
}

describe("retrieval trace capture", () => {
	it("captures query/strategy/facets/segment_count at retrieval boundary", async () => {
		const route = makeQueryRoute();
		const plan = makeQueryPlan(route);

		const queryRouter: QueryRouter = {
			route: async () => route,
		};

		const queryPlanBuilder: QueryPlanBuilder = {
			build: () => plan,
		};

		const retrievalService = makeRetrievalService(
			{
				scene_area: [],
				scene_world: [],
				narrative: [
					{
						source_ref: "event:1",
						content: "n1",
						score: 1,
						doc_type: "event",
						scope: "area",
					},
				],
				cognition: [
					{
						source_ref: "assertion:1",
						content: "c1",
						score: 1,
						kind: "assertion",
						basis: null,
						stance: "contested",
						cognitionKey: "k1",
						provenance: null,
						groundingVerificationLevel: null,
					},
				],
				conflict_notes: [
					{
						source_ref: "conflict_note:1",
						from_source_ref: "assertion:1",
						cognitionKey: "k1",
						content: "x",
						score: 1,
					},
				],
				episode: [
					{
						source_ref: "episode:1",
						content: "e1",
						score: 1,
						doc_type: "episode_event",
						scope: "private",
					},
				],
			},
			{ queryRouter, queryPlanBuilder },
		);

		let capture: TraceCapture | undefined;
		await retrievalService.generateTypedRetrieval(
			"what happened",
			viewerContext,
			undefined,
			undefined,
			"deep_explain",
			undefined,
			undefined,
			(c) => {
				capture = c;
			},
		);

		expect(capture).toEqual({
			query_string: "what happened",
			strategy: "deep_explain",
			narrative_facets_used: ["entity_filters", "time_window"],
			cognition_facets_used: [
				"entity_filters",
				"time_window",
				"kind",
				"stance",
			],
			segment_count: 4,
			segments: [
				{ source: "event:1", content: "n1", score: 1 },
				{ source: "assertion:1", content: "c1", score: 1 },
				{ source: "conflict_note:1", content: "x", score: 1 },
				{ source: "episode:1", content: "e1", score: 1 },
			],
		});
	});

	it("does not fail retrieval when trace callback throws", async () => {
		const retrievalService = makeRetrievalService({
			scene_area: [],
			scene_world: [],
			narrative: [
				{
					source_ref: "event:1",
					content: "n1",
					score: 1,
					doc_type: "event",
					scope: "area",
				},
			],
			cognition: [],
			conflict_notes: [],
			episode: [],
		});

		const typed = await retrievalService.generateTypedRetrieval(
			"hello",
			viewerContext,
			undefined,
			undefined,
			"default_retrieval",
			undefined,
			undefined,
			() => {
				throw new Error("capture failed");
			},
		);

		expect(typed.narrative).toHaveLength(1);
		expect(typed.narrative[0].content).toBe("n1");
	});

	it("captures divergence notes in trace segments without mutating cognition payloads", async () => {
		const assertionRow = {
			cognition_key: "assertion:watch_location",
			record_json: JSON.stringify({
				kind: "assertion",
				key: "assertion:watch_location",
				sceneFactBinding: {
					scope: "area",
					factKey: "location:watch",
					expectedValue: "greenhouse",
				},
			}),
		};

		const retrievalService = makeRetrievalService({
			scene_area: [],
			scene_world: [],
			narrative: [],
			cognition: [
				{
					source_ref: "assertion:watch_location",
					content: "believes the watch is in greenhouse",
					score: 1,
					kind: "assertion",
					basis: "belief",
					stance: "accepted",
					cognitionKey: "assertion:watch_location",
					provenance: null,
					groundingVerificationLevel: null,
				},
			],
			conflict_notes: [
				{
					source_ref: "divergence_note:assertion:watch_location",
					from_source_ref: "assertion:watch_location",
					cognitionKey: "assertion:watch_location",
					content:
						"Scene fact location:watch=tea_room differs from belief location:watch=greenhouse",
					score: 0,
				},
			],
			episode: [],
		});

		let capture: TraceCapture | undefined;
		const typed = await retrievalService.generateTypedRetrieval(
			"watch",
			viewerContext,
			undefined,
			undefined,
			"default_retrieval",
			undefined,
			undefined,
			(c) => {
				capture = c;
			},
		);

		expect(capture?.segment_count).toBe(2);
		expect(capture?.segments).toEqual([
			{
				source: "assertion:watch_location",
				content: "believes the watch is in greenhouse",
				score: 1,
			},
			{
				source: "divergence_note:assertion:watch_location",
				content:
					"Scene fact location:watch=tea_room differs from belief location:watch=greenhouse",
				score: 0,
			},
		]);
		expect(typed.conflict_notes).toHaveLength(1);
		expect(typed.conflict_notes[0].source_ref).toBe(
			"divergence_note:assertion:watch_location",
		);
		// Trace capture must not mutate persisted cognition payloads.
		expect(assertionRow.record_json).toContain("sceneFactBinding");
	});
});

describe("system_only scene facts are absent from trace segments", () => {
	// system_only facts are excluded upstream by SceneSearchService.getVisibleAreaFacts()
	// and SceneSearchService.getVisibleWorldFacts() via excludeSystemOnly: true.
	// The retrieval orchestrator only receives pre-filtered facts, so trace capture
	// never observes system_only values.
	it("trace capture segments do not include system_only area facts", async () => {
		const retrievalService = makeRetrievalService({
			scene_area: [
				{
					factKey: "status:door",
					value: { state: "open" },
					sourceKind: "system_event",
				},
			],
			scene_world: [],
			narrative: [],
			cognition: [],
			conflict_notes: [],
			episode: [],
		});

		let capture: TraceCapture | undefined;
		await retrievalService.generateTypedRetrieval(
			"door",
			viewerContext,
			undefined,
			undefined,
			"default_retrieval",
			undefined,
			undefined,
			(c) => {
				capture = c;
			},
		);

		const segments = capture?.segments ?? [];
		expect(segments).toEqual([
			{
				source: "scene_area:status:door",
				content: JSON.stringify({ state: "open" }),
			},
		]);
		expect(
			segments.some(
				(segment) =>
					segment.source.includes("system_only") ||
					segment.content.includes("SYSTEM_ONLY"),
			),
		).toBeFalse();
	});

	it("trace capture segments do not include system_only world facts", async () => {
		const retrievalService = makeRetrievalService({
			scene_area: [],
			scene_world: [
				{
					factKey: "location:artifact",
					value: { where: "vault" },
					sourceKind: "lore_seed",
				},
			],
			narrative: [],
			cognition: [],
			conflict_notes: [],
			episode: [],
		});

		let capture: TraceCapture | undefined;
		await retrievalService.generateTypedRetrieval(
			"artifact",
			viewerContext,
			undefined,
			undefined,
			"default_retrieval",
			undefined,
			undefined,
			(c) => {
				capture = c;
			},
		);

		const segments = capture?.segments ?? [];
		expect(segments).toEqual([
			{
				source: "scene_world:location:artifact",
				content: JSON.stringify({ where: "vault" }),
			},
		]);
		expect(
			segments.some(
				(segment) =>
					segment.source.includes("system_only") ||
					segment.content.includes("SYSTEM_ONLY"),
			),
		).toBeFalse();
	});
});
