import { describe, expect, it } from "bun:test";
import type { AgentProfile } from "../../src/agents/profile.js";
import { TraceStore } from "../../src/app/diagnostics/trace-store.js";
import { AgentLoop } from "../../src/core/agent-loop.js";
import type {
	ChatCompletionRequest,
	ChatModelProvider,
} from "../../src/core/models/chat-provider.js";
import { PromptBuilder } from "../../src/core/prompt-builder.js";
import { PromptRenderer } from "../../src/core/prompt-renderer.js";
import { ToolExecutor } from "../../src/core/tools/tool-executor.js";
import type { InteractionRecord } from "../../src/interaction/contracts.js";
import type { CandidateAction } from "../../src/runtime/speaker-normalization.js";
import { normalizeTurnInput } from "../../src/runtime/speaker-normalization.js";
import { makeSubmitRpTurnTool } from "../../src/runtime/submit-rp-turn-tool.js";
import {
	mapCandidateActionsToSceneFactCommits,
	TurnService,
} from "../../src/runtime/turn-service.js";

const SESSION_ID = "session:turn-normalization";
const REQUEST_ID = "req-turn-normalization";
const AGENT_ID = "rp:alice";
const PERSONA_ID = "persona:alice";
const USER_TEXT = "Actually I pick up the watch";

const PROFILE: AgentProfile = {
	id: AGENT_ID,
	role: "rp_agent",
	lifecycle: "persistent",
	userFacing: true,
	outputMode: "freeform",
	modelId: "mock-model",
	toolPermissions: [],
	maxDelegationDepth: 3,
	lorebookEnabled: true,
	narrativeContextEnabled: true,
	personaId: PERSONA_ID,
};

class MockModelProvider implements ChatModelProvider {
	readonly requests: ChatCompletionRequest[] = [];

	async *chatCompletion(
		request: ChatCompletionRequest,
	): AsyncIterable<import("../../src/core/chunk.js").Chunk> {
		this.requests.push(request);
		yield { type: "tool_use_start", id: "tool:1", name: "submit_rp_turn" };
		yield {
			type: "tool_use_delta",
			id: "tool:1",
			partialJson: JSON.stringify({
				schemaVersion: "rp_turn_outcome_v5",
				publicReply: "Roger.",
				latentScratchpad: "internal",
			}),
		};
		yield { type: "tool_use_end", id: "tool:1" };
		yield { type: "message_end", stopReason: "end_turn" };
	}
}

function makeTurnService(params: {
	speakerNormalizationGate: boolean;
	traceStore?: TraceStore;
}): {
	turnService: TurnService;
	traceStore: TraceStore;
	records: InteractionRecord[];
	modelProvider: MockModelProvider;
} {
	const records: InteractionRecord[] = [];

	const commitService = {
		commit(
			input: Omit<
				InteractionRecord,
				"recordId" | "recordIndex" | "committedAt"
			>,
		): InteractionRecord {
			const existingIndices = records
				.filter((record) => record.sessionId === input.sessionId)
				.map((record) => record.recordIndex);
			const maxIndex =
				existingIndices.length > 0 ? Math.max(...existingIndices) : -1;
			const record: InteractionRecord = {
				...input,
				recordId: crypto.randomUUID(),
				recordIndex: maxIndex + 1,
				committedAt: Date.now(),
			};
			records.push(record);
			return record;
		},
	};

	const interactionStore = {
		getMessageRecords(): InteractionRecord[] {
			return [];
		},
		findRecordByCorrelatedTurnId(
			sessionId: string,
			correlatedTurnId: string,
			actorType: string,
		): InteractionRecord | undefined {
			return records.find(
				(record) =>
					record.sessionId === sessionId &&
					record.correlatedTurnId === correlatedTurnId &&
					record.actorType === actorType,
			);
		},
		settlementExists(sessionId: string, settlementId: string): boolean {
			return records.some(
				(record) =>
					record.sessionId === sessionId &&
					record.recordType === "turn_settlement" &&
					record.recordId === settlementId,
			);
		},
		getBySession(sessionId: string): InteractionRecord[] {
			return records.filter((record) => record.sessionId === sessionId);
		},
		getByRange(): InteractionRecord[] {
			return [];
		},
		markRangeProcessed(): void {},
		getPendingSettlementJobState(): null {
			return null;
		},
		markProcessed(): void {},
	};

	const flushSelector = {
		shouldFlush() {
			return null;
		},
		buildSessionCloseFlush() {
			return null;
		},
	};

	const sessionService = {
		async getSession(sessionId: string) {
			return {
				sessionId,
				createdAt: Date.now(),
				agentId: AGENT_ID,
			};
		},
		async setRecoveryRequired() {},
	};

	let talkerTurnCounter = 0;
	const settlementRepos = {
		settlementLedger: {
			async markTalkerCommitted() {},
		},
		episodeRepo: {},
		cognitionEventRepo: {},
		cognitionProjectionRepo: {},
		areaWorldProjectionRepo: {
			async applyAreaFactCommit() {
				return { eventId: 1n };
			},
			async applyWorldFactCommit() {
				return { eventId: 1n };
			},
		},
		interactionRepo: {
			async getSettlementPayload(_sessionId: string, requestId: string) {
				const row = records.find(
					(record) =>
						record.recordType === "turn_settlement" &&
						record.correlatedTurnId === requestId,
				);
				return row?.payload;
			},
			async getMaxIndex(sessionId: string) {
				const rows = records.filter((record) => record.sessionId === sessionId);
				if (rows.length === 0) {
					return undefined;
				}
				return Math.max(...rows.map((record) => record.recordIndex));
			},
			async commit(record: InteractionRecord) {
				records.push(record);
			},
		},
		sessionRepo: {},
		recentCognitionSlotRepo: {
			async getVersionGap() {
				return undefined;
			},
			async upsertRecentCognitionSlot() {
				talkerTurnCounter += 1;
				return { talkerTurnCounter };
			},
		},
		searchProjectionRepo: {},
		coreMemoryBlockRepo: {},
		graphStoreRepo: {
			async createProjectedEvent() {
				return 0;
			},
			async createPromotedEvent() {
				return 0;
			},
			async createLogicEdge() {
				return 0;
			},
			async createTopic() {
				return 0;
			},
			async upsertEntity() {
				return 0;
			},
			async resolveEntityByPointerKey() {
				return null;
			},
			async getEntityById() {
				return null;
			},
			async upsertExplicitAssertion() {
				return { id: 0, ref: "assertion:0" as const };
			},
			async upsertExplicitEvaluation() {
				return { id: 0, ref: "evaluation:0" as const };
			},
			async upsertExplicitCommitment() {
				return { id: 0, ref: "commitment:0" as const };
			},
			async retractExplicitCognition() {},
			async createEntityAlias() {
				return 0;
			},
			async createRedirect() {
				return 0;
			},
			async createFact() {
				return 0;
			},
			async createWorldStateFactEdge() {
				return { id: 0, created: true };
			},
			async activeFactEdgesByOwner() {
				return [];
			},
			async invalidateFact() {},
			async createPrivateEvent() {
				return 0;
			},
			async createPrivateBelief() {
				return 0;
			},
			async updatePrivateEventLink() {},
			async createSameEpisodeEdges() {},
			async runBatch(fn: () => void) {
				fn();
			},
		},
		pendingFlushRecoveryRepo: {},
	};

	const settlementUnitOfWork = {
		async run<T>(
			fn: (repos: typeof settlementRepos) => Promise<T>,
		): Promise<T> {
			return fn(settlementRepos);
		},
	};

	const modelProvider = new MockModelProvider();
	const toolExecutor = new ToolExecutor();
	toolExecutor.registerLocal(makeSubmitRpTurnTool());

	const promptBuilder = new PromptBuilder({
		persona: {
			getSystemPrompt: () => "You are Alice.",
		},
		lore: {
			getMatchingEntries: () => [],
			getWorldRules: () => [],
		},
		memory: {
			getPinnedBlocks: () => "",
			getSharedBlocks: () => "",
			getRecentCognition: () => "",
			getTypedRetrievalSurface: async () => "",
		},
		operational: {
			getExcerpt: () => ({}),
		},
	});
	const promptRenderer = new PromptRenderer();

	const agentLoop = new AgentLoop({
		profile: PROFILE,
		modelProvider,
		toolExecutor,
		promptBuilder,
		promptRenderer,
		viewerContextResolver: () => ({
			viewer_agent_id: AGENT_ID,
			viewer_role: "rp_agent",
			can_read_admin_only: true,
			session_id: SESSION_ID,
		}),
	});

	const traceStore = params.traceStore ?? new TraceStore();

	const turnService = new TurnService(
		agentLoop,
		commitService as never,
		interactionStore as never,
		flushSelector as never,
		null,
		sessionService as never,
		() => ({
			viewer_agent_id: AGENT_ID,
			viewer_role: "rp_agent",
			can_read_admin_only: true,
			session_id: SESSION_ID,
		}),
		undefined,
		undefined,
		traceStore,
		undefined,
		null,
		true,
		{
			enabled: true,
			stalenessThreshold: 2,
			softBlockTimeoutMs: 10,
			softBlockPollIntervalMs: 5,
			speakerNormalizationGate: params.speakerNormalizationGate,
			sceneFactWritePath: false,
			sceneRetrieval: false,
			legacyAreaStateCompat: true,
		},
		null,
		null,
		null,
		null,
	);
	turnService.setSettlementUnitOfWork(settlementUnitOfWork as never);

	return { turnService, traceStore, records, modelProvider };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
	for await (const _chunk of stream) {
		void _chunk;
	}
}

function getCapturedSystemPrompt(
	traceStore: TraceStore,
	requestId: string,
): string {
	const trace = traceStore.getTrace(requestId);
	return trace?.prompt?.rendered_system ?? "";
}

describe("TurnService speaker normalization integration", () => {
	it("speakerNormalizationGate=true: prompt contains <normalized_turn_input> block", async () => {
		const { turnService, traceStore } = makeTurnService({
			speakerNormalizationGate: true,
		});

		await drain(
			turnService.run({
				sessionId: SESSION_ID,
				requestId: REQUEST_ID,
				messages: [{ role: "user", content: USER_TEXT }],
			}),
		);

		const prompt = getCapturedSystemPrompt(traceStore, REQUEST_ID);
		expect(prompt).toContain("<normalized_turn_input>");
		expect(prompt).toContain('"speechActs"');
		expect(prompt).toContain("</normalized_turn_input>");
	});

	it("prompt never includes correctionSuspected text", async () => {
		const { turnService, traceStore } = makeTurnService({
			speakerNormalizationGate: true,
		});

		await drain(
			turnService.run({
				sessionId: SESSION_ID,
				requestId: `${REQUEST_ID}-correction-hidden`,
				messages: [{ role: "user", content: USER_TEXT }],
			}),
		);

		const prompt = getCapturedSystemPrompt(
			traceStore,
			`${REQUEST_ID}-correction-hidden`,
		);
		expect(prompt).not.toContain("correctionSuspected");
	});

	it("speakerNormalizationGate=false rollback: prompt omits normalized input and TURN_CONTEXT", async () => {
		const { turnService, traceStore } = makeTurnService({
			speakerNormalizationGate: false,
		});

		await drain(
			turnService.run({
				sessionId: SESSION_ID,
				requestId: `${REQUEST_ID}-rollback`,
				messages: [{ role: "user", content: USER_TEXT }],
			}),
		);

		const trace = traceStore.getTrace(`${REQUEST_ID}-rollback`);
		const prompt = trace?.prompt?.rendered_system ?? "";
		expect(prompt).not.toContain("<normalized_turn_input>\n{");
		expect(prompt).not.toContain("turn_context");
		expect(prompt).not.toContain("TURN_CONTEXT");
	});

	it("settlement preserves normalizedTurnInput when gate is on", async () => {
		const { turnService, records } = makeTurnService({
			speakerNormalizationGate: true,
		});

		await drain(
			turnService.run({
				sessionId: SESSION_ID,
				requestId: `${REQUEST_ID}-settlement`,
				messages: [{ role: "user", content: USER_TEXT }],
			}),
		);

		const record = records.find(
			(item) => item.recordType === "turn_settlement",
		);
		const payload = record?.payload as
			| { normalizedTurnInput?: unknown }
			| undefined;

		expect(payload?.normalizedTurnInput).toEqual(normalizeTurnInput(USER_TEXT));
	});

	it("settlement backfills entityMentions from explicit user names when talker omits them", async () => {
		const { turnService, records } = makeTurnService({
			speakerNormalizationGate: true,
		});

		await drain(
			turnService.run({
				sessionId: SESSION_ID,
				requestId: `${REQUEST_ID}-entity-fallback`,
				messages: [{ role: "user", content: "对了，Alice今天起得早吗？" }],
			}),
		);

		const record = records.find(
			(item) =>
				item.recordType === "turn_settlement" &&
				item.correlatedTurnId === `${REQUEST_ID}-entity-fallback`,
		);
		const payload = record?.payload as
			| { entityMentions?: string[] }
			| undefined;

		expect(payload?.entityMentions).toContain("Alice");
	});
});

describe("mapCandidateActionsToSceneFactCommits", () => {
	it("take action → holder:<target>=user", () => {
		const commits = mapCandidateActionsToSceneFactCommits([
			{
				verb: "take",
				target: "pocket_watch",
				confidence: "high",
				actionFamily: "possession",
			},
		]);

		expect(commits).toEqual([
			{
				scope: "area",
				factKey: "holder:pocket_watch",
				value: "user",
				sourceKind: "action_commitment",
				exposureScope: "area_visible",
			},
		]);
	});

	it("put action with location → holder null + location", () => {
		const commits = mapCandidateActionsToSceneFactCommits([
			{
				verb: "put",
				target: "pocket_watch",
				location: "tea_room",
				confidence: "high",
				actionFamily: "possession",
			},
		]);

		expect(commits).toEqual([
			{
				scope: "area",
				factKey: "holder:pocket_watch",
				value: null,
				sourceKind: "action_commitment",
				exposureScope: "area_visible",
			},
			{
				scope: "area",
				factKey: "location:pocket_watch",
				value: "tea_room",
				sourceKind: "action_commitment",
				exposureScope: "area_visible",
			},
		]);
	});

	it("open action → status:<target>=open", () => {
		const commits = mapCandidateActionsToSceneFactCommits([
			{
				verb: "open",
				target: "cabinet_door",
				confidence: "high",
				actionFamily: "status_change",
			},
		]);

		expect(commits).toEqual([
			{
				scope: "area",
				factKey: "status:cabinet_door",
				value: "open",
				sourceKind: "action_commitment",
				exposureScope: "area_visible",
			},
		]);
	});

	it("self-movement (no target) → no commit", () => {
		const commits = mapCandidateActionsToSceneFactCommits([
			{
				verb: "go",
				confidence: "high",
				actionFamily: "move",
			},
		]);

		expect(commits).toEqual([]);
	});

	it("hand/show actions → no commit (require explicit actionCommitments)", () => {
		const handCommits = mapCandidateActionsToSceneFactCommits([
			{
				verb: "hand",
				target: "book",
				confidence: "high",
				actionFamily: "possession",
			},
		]);

		const showCommits = mapCandidateActionsToSceneFactCommits([
			{
				verb: "show",
				target: "book",
				confidence: "high",
				actionFamily: "possession",
			},
		]);

		expect(handCommits).toEqual([]);
		expect(showCommits).toEqual([]);
	});

	it("move with target+location → location commit", () => {
		const commits = mapCandidateActionsToSceneFactCommits([
			{
				verb: "move",
				target: "pocket_watch",
				location: "shelf",
				confidence: "high",
				actionFamily: "move",
			},
		]);

		expect(commits).toEqual([
			{
				scope: "area",
				factKey: "location:pocket_watch",
				value: "shelf",
				sourceKind: "action_commitment",
				exposureScope: "area_visible",
			},
		]);
	});

	it("low-confidence → no commit", () => {
		const commits = mapCandidateActionsToSceneFactCommits([
			{
				verb: "take",
				target: "watch",
				confidence: "low",
				actionFamily: "possession",
			},
		]);

		expect(commits).toEqual([]);
	});

	it("dedups by factKey with last-in-order wins", () => {
		const actions: CandidateAction[] = [
			{
				verb: "take",
				target: "watch",
				confidence: "high",
				actionFamily: "possession",
			},
			{
				verb: "put",
				target: "watch",
				location: "desk",
				confidence: "high",
				actionFamily: "possession",
			},
		];

		const commits = mapCandidateActionsToSceneFactCommits(actions);
		expect(commits).toEqual([
			{
				scope: "area",
				factKey: "holder:watch",
				value: null,
				sourceKind: "action_commitment",
				exposureScope: "area_visible",
			},
			{
				scope: "area",
				factKey: "location:watch",
				value: "desk",
				sourceKind: "action_commitment",
				exposureScope: "area_visible",
			},
		]);
	});
});
