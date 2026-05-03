import { describe, expect, it } from "bun:test";
import type { ViewerContext } from "../../src/core/contracts/viewer-context.js";
import {
	MemoryAdapter,
	WEAK_MEMORY_INTERPRETATION_GUIDANCE,
} from "../../src/core/prompt-data-adapters/memory-adapter.js";
import type { PromptDataRepos } from "../../src/memory/prompt-data.js";
import type { RetrievalService } from "../../src/memory/retrieval.js";

const OPTIONAL_WORLD_STATE_REPOS = {
	aliasRepo: {
		resolveAlias: async () => null,
		resolveAliases: async (aliases: string[]) =>
			new Map(aliases.map((a) => [a, null])),
		createAlias: async () => 1,
		getAliasesForEntity: async () => [],
		findEntityById: async () => null,
		findEntityByPointerKey: async () => null,
		listSharedAliasStrings: async () => [],
		listPrivateAliasStrings: async () => [],
	} as unknown as NonNullable<PromptDataRepos["aliasRepo"]>,
	unifiedEdgeReadRepo: {
		edgesFrom: async () => [],
		edgesTo: async () => [],
		edgesAround: async () => [],
		worldStateOf: async () => [],
		cognitiveContextOf: async () => [],
		narrativeChainOf: async () => [],
		semanticNeighborsOf: async () => [],
		evidencePathTo: async () => [],
	} as unknown as NonNullable<PromptDataRepos["unifiedEdgeReadRepo"]>,
};

describe("MemoryAdapter", () => {
	const stubRepos: PromptDataRepos = {
		coreMemoryBlockRepo: {
			getAllBlocks: async () => [],
		} as unknown as PromptDataRepos["coreMemoryBlockRepo"],
		recentCognitionSlotRepo: {
			getSlotPayload: async () => undefined,
		} as unknown as PromptDataRepos["recentCognitionSlotRepo"],
		interactionRepo: {
			getMessageRecords: async () => [],
			getBySession: async () => [],
			getMaxIndex: async () => undefined,
		} as unknown as PromptDataRepos["interactionRepo"],
		sharedBlockRepo: {
			getAttachedBlockIds: async () => [],
		} as unknown as PromptDataRepos["sharedBlockRepo"],
		...OPTIONAL_WORLD_STATE_REPOS,
	};

	const stubRetrievalService: RetrievalService = {
		generateTypedRetrieval: async () => ({
			scene_area: [],
			scene_world: [],
			narrative: [],
			cognition: [],
			conflict_notes: [],
			episode: [],
		}),
		resolveEntityByPointer: async () => null,
	} as unknown as RetrievalService;

	const stubViewerContext: ViewerContext = {
		viewer_agent_id: "test-agent",
		viewer_role: "rp_agent",
		session_id: "test-session",
	};

	it("should instantiate with repos only (retrievalService optional)", () => {
		const adapter = new MemoryAdapter(stubRepos);
		expect(adapter).toBeDefined();
	});

	it("should instantiate with both repos and retrievalService", () => {
		const adapter = new MemoryAdapter(stubRepos, stubRetrievalService);
		expect(adapter).toBeDefined();
	});

	it("should have getPinnedBlocks method", async () => {
		const adapter = new MemoryAdapter(stubRepos);
		expect(typeof adapter.getPinnedBlocks).toBe("function");

		const result = await adapter.getPinnedBlocks("test-agent");
		expect(typeof result).toBe("string");
	});

	it("should have getSharedBlocks method", async () => {
		const adapter = new MemoryAdapter(stubRepos);
		expect(typeof adapter.getSharedBlocks).toBe("function");

		const result = await adapter.getSharedBlocks("test-agent");
		expect(typeof result).toBe("string");
	});

	it("should have getRecentCognition method", async () => {
		const adapter = new MemoryAdapter(stubRepos);
		expect(typeof adapter.getRecentCognition).toBe("function");

		const result = await adapter.getRecentCognition(stubViewerContext);
		expect(typeof result).toBe("string");
	});

	it("should have getAttachedSharedBlocks method", async () => {
		const adapter = new MemoryAdapter(stubRepos);
		expect(typeof adapter.getAttachedSharedBlocks).toBe("function");

		const result = await adapter.getAttachedSharedBlocks("test-agent");
		expect(typeof result).toBe("string");
	});

	it("should have getTypedRetrievalSurface method", async () => {
		const adapter = new MemoryAdapter(stubRepos, stubRetrievalService);
		expect(typeof adapter.getTypedRetrievalSurface).toBe("function");

		const result = await adapter.getTypedRetrievalSurface(
			"test message",
			stubViewerContext,
		);
		expect(typeof result).toBe("string");
	});

	it("schedules prompt-time entity sync without blocking retrieval or known-entity rendering", async () => {
		const sweepCalls: string[] = [];
		let releaseSweep: (() => void) | undefined;
		const adapter = new MemoryAdapter(
			stubRepos,
			stubRetrievalService,
			undefined,
			undefined,
			{
				runSweep: async ({ agentId, sessionId }) => {
					sweepCalls.push(`${agentId}:${sessionId}`);
					await new Promise<void>((resolve) => {
						releaseSweep = resolve;
					});
					return { skipped_due_lock: false };
				},
			},
		);

		const retrievalResult = await Promise.race([
			adapter.getTypedRetrievalSurface("test message", stubViewerContext),
			new Promise<"timeout">((resolve) =>
				setTimeout(() => resolve("timeout"), 20),
			),
		]);
		expect(retrievalResult).not.toBe("timeout");

		await adapter.getKnownEntitiesForWriting(stubViewerContext);

		expect(sweepCalls).toEqual(["test-agent:test-session"]);
		releaseSweep?.();
	});
});

describe("MemoryAdapter — weak-memory interpretation guidance", () => {
	const stubViewerContext: ViewerContext = {
		viewer_agent_id: "test-agent",
		viewer_role: "rp_agent",
		session_id: "test-session",
	};

	function makeReposWithCognition(
		payload: string | undefined,
	): PromptDataRepos {
		return {
			coreMemoryBlockRepo: {
				getAllBlocks: async () => [],
			} as unknown as PromptDataRepos["coreMemoryBlockRepo"],
			recentCognitionSlotRepo: {
				getSlotPayload: async () => payload,
			} as unknown as PromptDataRepos["recentCognitionSlotRepo"],
			interactionRepo: {
				getMessageRecords: async () => [],
				getBySession: async () => [],
				getMaxIndex: async () => undefined,
			} as unknown as PromptDataRepos["interactionRepo"],
			sharedBlockRepo: {
				getAttachedBlockIds: async () => [],
			} as unknown as PromptDataRepos["sharedBlockRepo"],
			...OPTIONAL_WORLD_STATE_REPOS,
		};
	}

	it("includes interpretation guidance when recent cognition has content", async () => {
		const payload = JSON.stringify([
			{
				settlementId: "stl:1",
				committedAt: 1000,
				kind: "assertion",
				key: "mood",
				summary: "she seems happy",
				status: "active",
				basis: "belief",
				provenance: "talker_sketch_auto",
				groundingVerificationLevel: "unverified",
			},
		]);
		const repos = makeReposWithCognition(payload);
		const adapter = new MemoryAdapter(repos);
		const result = await adapter.getRecentCognition(stubViewerContext);

		expect(result).toContain(WEAK_MEMORY_INTERPRETATION_GUIDANCE);
		expect(result).toContain(
			"[basis=belief provenance=talker_sketch_auto verification=unverified]",
		);
	});

	it("does NOT include guidance when recent cognition is empty", async () => {
		const repos = makeReposWithCognition(undefined);
		const adapter = new MemoryAdapter(repos);
		const result = await adapter.getRecentCognition(stubViewerContext);

		expect(result).toBe("");
		expect(result).not.toContain(WEAK_MEMORY_INTERPRETATION_GUIDANCE);
	});

	it("bracket metadata appears alongside interpretation guidance (not without)", async () => {
		const payload = JSON.stringify([
			{
				settlementId: "stl:1",
				committedAt: 1000,
				kind: "assertion",
				key: "weather",
				summary: "it might rain",
				status: "active",
				basis: "inference",
				provenance: "thinker_inferred",
				groundingVerificationLevel: "context_verified",
			},
		]);
		const repos = makeReposWithCognition(payload);
		const adapter = new MemoryAdapter(repos);
		const result = await adapter.getRecentCognition(stubViewerContext);

		expect(result).toContain(
			"[basis=inference provenance=thinker_inferred verification=context_verified]",
		);
		expect(result).toContain(WEAK_MEMORY_INTERPRETATION_GUIDANCE);
	});

	it("explicitly prohibits repeating bracket metadata verbatim", async () => {
		const payload = JSON.stringify([
			{
				settlementId: "stl:1",
				committedAt: 1000,
				kind: "assertion",
				key: "name",
				summary: "her name is Alice",
				status: "active",
				basis: "unknown",
				provenance: "legacy_unknown",
				groundingVerificationLevel: "unverified",
			},
		]);
		const repos = makeReposWithCognition(payload);
		const adapter = new MemoryAdapter(repos);
		const result = await adapter.getRecentCognition(stubViewerContext);

		expect(result).toContain("do not repeat the bracketed metadata verbatim");
	});

	it("includes guidance when typed retrieval surface has content", async () => {
		const retrievalService = {
			generateTypedRetrieval: async () => ({
				scene_area: [],
				scene_world: [],
				cognition: [
					{
						source_ref: "assertion:5",
						content: "she dislikes rain",
						score: 10,
						kind: "assertion",
						basis: "first_hand",
						stance: "accepted",
						cognitionKey: "rain_opinion",
					},
				],
				narrative: [],
				conflict_notes: [],
				episode: [],
			}),
			resolveEntityByPointer: async () => null,
		} as unknown as RetrievalService;

		const repos = makeReposWithCognition(undefined);
		const adapter = new MemoryAdapter(repos, retrievalService);
		const result = await adapter.getTypedRetrievalSurface(
			"rain",
			stubViewerContext,
		);

		expect(result).toContain("she dislikes rain");
		expect(result).toContain(WEAK_MEMORY_INTERPRETATION_GUIDANCE);
	});

	it("does NOT include guidance when typed retrieval surface is empty", async () => {
		const retrievalService = {
			generateTypedRetrieval: async () => ({
				scene_area: [],
				scene_world: [],
				cognition: [],
				narrative: [],
				conflict_notes: [],
				episode: [],
			}),
			resolveEntityByPointer: async () => null,
		} as unknown as RetrievalService;

		const repos = makeReposWithCognition(undefined);
		const adapter = new MemoryAdapter(repos, retrievalService);
		const result = await adapter.getTypedRetrievalSurface(
			"hello",
			stubViewerContext,
		);

		expect(result).not.toContain(WEAK_MEMORY_INTERPRETATION_GUIDANCE);
	});

	it("guidance includes non-restatement sentence and low-confidence + strong_verified rescue rules", () => {
		expect(WEAK_MEMORY_INTERPRETATION_GUIDANCE).toContain(
			"do not repeat the bracketed metadata verbatim",
		);
		expect(WEAK_MEMORY_INTERPRETATION_GUIDANCE).toContain(
			"Treat the entry as low-confidence, fragmentary memory",
		);
		expect(WEAK_MEMORY_INTERPRETATION_GUIDANCE).toContain("strong_verified");
		expect(WEAK_MEMORY_INTERPRETATION_GUIDANCE).toContain(
			"Strong verification can rescue",
		);
	});

	it("should not surface system_only scene facts in retrieval prompt text", async () => {
		const retrievalService = {
			generateTypedRetrieval: async () => ({
				scene_area: [],
				scene_world: [],
				cognition: [],
				narrative: [],
				conflict_notes: [],
				episode: [],
			}),
			resolveEntityByPointer: async () => null,
		} as unknown as RetrievalService;

		const repos = makeReposWithCognition(undefined);
		const adapter = new MemoryAdapter(repos, retrievalService);
		const result = await adapter.getTypedRetrievalSurface(
			"gem",
			stubViewerContext,
		);

		expect(result).not.toContain("SYSTEM_ONLY");
		expect(result).not.toContain("[SYSTEM_ONLY]");
	});
});
