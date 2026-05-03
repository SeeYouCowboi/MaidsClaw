import { afterEach, describe, expect, it, jest } from "bun:test";
import type postgres from "postgres";
import type { AgentProfile } from "../../src/agents/profile.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { createAppHost } from "../../src/app/host/create-app-host.js";
import type { RuntimeBootstrapResult } from "../../src/bootstrap/types.js";
import type { AgentLoop, AgentRunRequest } from "../../src/core/agent-loop.js";
import type { TurnSettlementPayload } from "../../src/interaction/contracts.js";
import type {
	CognitionThinkerJobPayload,
	DurableJobStore,
	PgJobCurrentRow,
} from "../../src/jobs/durable-store.js";
import type { JobPersistence } from "../../src/jobs/persistence.js";
import { PgJobRunner } from "../../src/jobs/pg-runner.js";
import * as contestConflictApplicatorModule from "../../src/memory/cognition/contest-conflict-applicator.js";
import type { CognitionCurrentRow } from "../../src/memory/cognition/private-cognition-current.js";
import * as relationIntentResolverModule from "../../src/memory/cognition/relation-intent-resolver.js";
import * as organizeEnqueueModule from "../../src/memory/organize-enqueue.js";
import type { ProjectionManager } from "../../src/memory/projection/projection-manager.js";
import { formatRecentCognitionFromPayload } from "../../src/memory/prompt-data.js";
import type { SettlementLedger } from "../../src/memory/settlement-ledger.js";
import * as thinkerWorkerModule from "../../src/runtime/thinker-worker.js";
import {
	createThinkerWorker,
	type ThinkerWorkerDeps,
} from "../../src/runtime/thinker-worker.js";
import type {
	InteractionRepo,
	InteractionTransactionContext,
} from "../../src/storage/domain-repos/contracts/interaction-repo.js";
import type { RecentCognitionSlotRepo } from "../../src/storage/domain-repos/contracts/recent-cognition-slot-repo.js";
import { PgCognitionProjectionRepo } from "../../src/storage/domain-repos/pg/cognition-projection-repo.js";
import { PgEpisodeRepo } from "../../src/storage/domain-repos/pg/episode-repo.js";
import {
	compactSlotEntries,
	PgRecentCognitionSlotRepo,
} from "../../src/storage/domain-repos/pg/recent-cognition-slot-repo.js";

const AGENT_ID = "rp:alice";
const SESSION_ID = "session:batch";
const FAIL_AFTER_PROMPT = "STOP_AFTER_PROMPT_CAPTURE";

type SettlementBehavior = {
	[settlementId: string]:
		| string
		| Error
		| {
				sketch: string;
				viewerLocation?: number;
				cognitiveSketchSource?: "explicit" | "auto_fallback";
				correctionSuspected?: boolean;
		  }
		| undefined;
};

type MockLedger = SettlementLedger & {
	markApplied: ReturnType<typeof jest.fn>;
	markFailed: ReturnType<typeof jest.fn>;
	markReplayedNoop: ReturnType<typeof jest.fn>;
	markThinkerProjecting: ReturnType<typeof jest.fn>;
};

type MockJobPersistence = JobPersistence;

function settlementIdFor(version: number): string {
	return `stl:req-${version}`;
}

function requestIdFromSettlement(settlementId: string): string {
	return settlementId.replace(/^stl:/, "");
}

function makeSettlementPayload(
	sessionId: string,
	settlementId: string,
	sketch: string,
	viewerLocation = 42,
	options?: {
		cognitiveSketchSource?: "explicit" | "auto_fallback";
		correctionSuspected?: boolean;
	},
): TurnSettlementPayload {
	const requestId = requestIdFromSettlement(settlementId);
	return {
		settlementId,
		requestId,
		sessionId,
		ownerAgentId: AGENT_ID,
		publicReply: "ok",
		hasPublicReply: true,
		viewerSnapshot: {
			selfPointerKey: "entity:self",
			userPointerKey: "entity:user",
			currentLocationEntityId: viewerLocation,
		},
		schemaVersion: "turn_settlement_v5",
		cognitiveSketch: sketch,
		...(options?.cognitiveSketchSource
			? { cognitiveSketchSource: options.cognitiveSketchSource }
			: {}),
		...(options?.correctionSuspected
			? { correctionSuspected: options.correctionSuspected }
			: {}),
	};
}

function makePendingRow(
	payload: CognitionThinkerJobPayload,
): PgJobCurrentRow<"cognition.thinker"> {
	return {
		job_key: `job:${payload.settlementId}`,
		payload_json: payload,
	} as unknown as PgJobCurrentRow<"cognition.thinker">;
}

function createSlotRepo(): RecentCognitionSlotRepo {
	return {
		async upsertRecentCognitionSlot() {
			return {};
		},
		async getSlotPayload() {
			return undefined;
		},
		async getBySession() {
			return undefined;
		},
		async getVersionGap() {
			return undefined;
		},
	};
}

function createInteractionRepo(params: {
	sessionId: string;
	settlementBehavior: SettlementBehavior;
	settlementCalls: string[];
}): InteractionRepo {
	return {
		async getSettlementPayload(sessionId, requestId) {
			if (sessionId !== params.sessionId) {
				return undefined;
			}
			const settlementId = `stl:${requestId}`;
			params.settlementCalls.push(settlementId);
			const behavior = params.settlementBehavior[settlementId];
			if (behavior instanceof Error) {
				throw behavior;
			}
			if (!behavior) {
				return undefined;
			}
			if (typeof behavior === "string") {
				return makeSettlementPayload(sessionId, settlementId, behavior);
			}
			return makeSettlementPayload(
				sessionId,
				settlementId,
				behavior.sketch,
				behavior.viewerLocation,
				{
					cognitiveSketchSource: behavior.cognitiveSketchSource,
					correctionSuspected: behavior.correctionSuspected,
				},
			);
		},
		async getMessageRecords(sessionId) {
			if (sessionId !== params.sessionId) {
				return [];
			}
			return [
				{
					sessionId,
					recordId: "rec:1",
					recordIndex: 0,
					actorType: "user",
					recordType: "message",
					payload: { role: "user", content: "hello" },
					committedAt: Date.now(),
				},
			];
		},
		async commit() {},
		async runInTransaction<T>(
			fn: (tx: InteractionTransactionContext) => Promise<T>,
		) {
			return fn({ interactionRepo: this });
		},
		async settlementExists() {
			return false;
		},
		async findRecordByCorrelatedTurnId() {
			return undefined;
		},
		async findSessionIdByRequestId() {
			return undefined;
		},
		async getBySession() {
			return [];
		},
		async getByRange() {
			return [];
		},
		async markProcessed() {},
		async markRangeProcessed() {},
		async countUnprocessedRpTurns() {
			return 0;
		},
		async getMinMaxUnprocessedIndex() {
			return undefined;
		},
		async getMaxIndex() {
			return undefined;
		},
		async getPendingSettlementJobState() {
			return null;
		},
		async countUnprocessedSettlements() {
			return 0;
		},
		async getUnprocessedSettlementRange() {
			return null;
		},
		async listStalePendingSettlementSessions() {
			return [];
		},
		async getUnprocessedRangeForSession() {
			return null;
		},
	};
}

function createSettlementLedger(): MockLedger {
	return {
		check: jest.fn(async () => "pending" as const),
		rawStatus: jest.fn(async () => "talker_committed" as const),
		markPending: jest.fn(async () => undefined),
		markClaimed: jest.fn(async () => undefined),
		markApplying: jest.fn(async () => undefined),
		markApplied: jest.fn(async () => undefined),
		markReplayedNoop: jest.fn(async () => undefined),
		markConflict: jest.fn(async () => undefined),
		markFailed: jest.fn(async () => undefined),
		markTalkerCommitted: jest.fn(async () => undefined),
		markThinkerProjecting: jest.fn(async () => undefined),
	};
}

function createMockJobPersistence(): MockJobPersistence {
	return {
		enqueue: jest.fn(async () => undefined),
		claim: jest.fn(async () => false),
		complete: jest.fn(async () => undefined),
		fail: jest.fn(async () => undefined),
		retry: jest.fn(async () => false),
		listPending: jest.fn(async () => []),
		listRetryable: jest.fn(async () => []),
		countByStatus: jest.fn(async () => 0),
	};
}

function makeSuccessOutcome(overrides?: {
	key?: string;
	stance?: "accepted" | "contested";
	relationIntents?: Array<{
		sourceRef: string;
		targetRef: string;
		intent: "supports" | "triggered";
	}>;
	conflictFactors?: Array<{ kind: string; ref: string; note?: string }>;
}) {
	return {
		schemaVersion: "rp_turn_outcome_v5" as const,
		publicReply: "ok",
		privateCognition: {
			ops: [
				{
					op: "upsert" as const,
					record: {
						kind: "assertion" as const,
						key: overrides?.key ?? "belief:test",
						proposition: {
							subject: { kind: "special" as const, value: "self" },
							predicate: "trusts",
							object: {
								kind: "entity" as const,
								ref: { kind: "special" as const, value: "user" },
							},
						},
						stance: overrides?.stance ?? "accepted",
						basis: "first_hand" as const,
					},
				},
			],
		},
		privateEpisodes: [
			{
				category: "observation" as const,
				summary: "episode",
				localRef: "ep:test",
			},
		],
		publications: [],
		relationIntents: overrides?.relationIntents ?? [],
		conflictFactors: overrides?.conflictFactors ?? [],
	};
}

function createRegistry(): AgentRegistry {
	const registry = new AgentRegistry();
	const profile: AgentProfile = {
		id: AGENT_ID,
		role: "rp_agent",
		lifecycle: "persistent",
		userFacing: true,
		outputMode: "freeform",
		modelId: "test-model",
		toolPermissions: [],
		maxDelegationDepth: 1,
		lorebookEnabled: true,
		narrativeContextEnabled: true,
	};
	registry.register(profile);
	return registry;
}

function extractUserPrompt(request: AgentRunRequest | undefined): string {
	if (!request) {
		return "";
	}
	return request.messages
		.filter((m) => m.role === "user" && typeof m.content === "string")
		.map((m) => m.content)
		.join("\n");
}

function makeCurrentAssertionRow(params: {
	id: number;
	key: string;
	holderId: string;
	claim: string;
	entityRefs: string[];
	status?: "active" | "retracted";
	stance?:
		| "hypothetical"
		| "tentative"
		| "accepted"
		| "confirmed"
		| "contested"
		| "rejected"
		| "abandoned";
}): CognitionCurrentRow {
	return {
		id: params.id,
		agent_id: AGENT_ID,
		cognition_key: params.key,
		kind: "assertion",
		stance: params.stance ?? "accepted",
		basis: "inference",
		status: params.status ?? "active",
		pre_contested_stance: null,
		conflict_summary: null,
		conflict_factor_refs_json: null,
		summary_text: null,
		record_json: JSON.stringify({
			holderId: { kind: "pointer_key", value: params.holderId },
			claim: params.claim,
			entityRefs: params.entityRefs.map((value) => ({
				kind: "pointer_key",
				value,
			})),
		}),
		source_event_id: params.id * 10,
		updated_at: Date.now(),
	};
}

function createMockCognitionProjectionRepo(
	rows: CognitionCurrentRow[],
): NonNullable<ThinkerWorkerDeps["cognitionProjectionRepo"]> {
	return {
		async upsertFromEvent() {},
		async rebuild() {},
		async getCurrent() {
			return null;
		},
		async getAllCurrent() {
			return rows;
		},
		async updateConflictFactors() {},
		async patchRecordJsonSourceEventRef() {},
		async resolveEntityByPointerKey() {
			return null;
		},
	};
}

function createMockAssertionCanonicalizationBundle(params: {
	neighbors: Array<{ nodeRef: string; similarity: number; nodeKind?: string }>;
}): NonNullable<ThinkerWorkerDeps["assertionCanonicalization"]> {
	return {
		embeddingRepo: {
			async upsert() {},
			async query() {
				return [];
			},
			async dimensionCheck() {
				return true;
			},
			async deleteByModel() {
				return 0;
			},
			async cosineSearch() {
				return params.neighbors.map((neighbor) => ({
					nodeRef: neighbor.nodeRef as NodeRef,
					similarity: neighbor.similarity,
					nodeKind: neighbor.nodeKind ?? "assertion",
				}));
			},
		},
		modelProvider: {
			defaultEmbeddingModelId: "test/embed",
			async chat() {
				return [];
			},
			async embed() {
				return [new Float32Array([0.1, 0.2, 0.3])];
			},
		},
		embeddingModelId: "test/embed",
	};
}

function createFixture(params: {
	sessionId?: string;
	claimedVersion: number;
	settlementBehavior: SettlementBehavior;
	pendingPayloads?: CognitionThinkerJobPayload[];
	withDurableJobStore?: boolean;
	initialThinkerCommittedVersion?: number;
	agentOutcome?: unknown;
	changedNodeRefs?: string[];
	assertionCanonicalization?: ThinkerWorkerDeps["assertionCanonicalization"];
	cognitionProjectionRows?: CognitionCurrentRow[];
	canonicalizationSimilarityThreshold?: number;
	entityJudgeSweeper?: ThinkerWorkerDeps["entityJudgeSweeper"];
	entityJudgeEnabled?: ThinkerWorkerDeps["entityJudgeEnabled"];
	entityJudgeBatchIntervalMs?: ThinkerWorkerDeps["entityJudgeBatchIntervalMs"];
	replayUnresolvedWorldStateOpsFn?: ThinkerWorkerDeps["replayUnresolvedWorldStateOpsFn"];
}) {
	const sessionId = params.sessionId ?? SESSION_ID;
	const settlementCalls: string[] = [];
	let capturedRequest: AgentRunRequest | undefined;
	const settlementLedger = createSettlementLedger();
	const jobPersistence = createMockJobPersistence();
	const runBuffered = jest.fn(async (request: AgentRunRequest) => {
		capturedRequest = request;
		if (params.agentOutcome) {
			return { outcome: params.agentOutcome };
		}
		return { error: FAIL_AFTER_PROMPT };
	});
	const payload: CognitionThinkerJobPayload = {
		sessionId: sessionId,
		agentId: AGENT_ID,
		settlementId: settlementIdFor(params.claimedVersion),
		talkerTurnVersion: params.claimedVersion,
	};
	const getBySession = jest.fn(async () =>
		params.initialThinkerCommittedVersion === undefined
			? undefined
			: {
					lastSettlementId: payload.settlementId,
					slotPayload: [],
					updatedAt: Date.now(),
					talkerTurnCounter: params.initialThinkerCommittedVersion,
					thinkerCommittedVersion: params.initialThinkerCommittedVersion,
				},
	);
	const projectionManager = {
		commitSettlement: jest.fn(async (projectionParams, repoOverrides) => {
			await repoOverrides?.recentCognitionSlotRepo?.upsertRecentCognitionSlot(
				projectionParams.sessionId,
				projectionParams.agentId,
				projectionParams.settlementId,
				projectionParams.recentCognitionSlotJson,
			);
			return {
				changedNodeRefs: (params.changedNodeRefs ?? [
					"assertion:1",
				]) as string[],
			};
		}),
	} as unknown as ProjectionManager & {
		commitSettlement: ReturnType<typeof jest.fn>;
	};

	const listPendingByKindAndPayload = jest.fn(async () => {
		return (params.pendingPayloads ?? []).map(makePendingRow);
	});

	const durableJobStore =
		params.withDurableJobStore === false
			? undefined
			: ({
					listPendingByKindAndPayload,
				} as unknown as DurableJobStore);

	const interactionRepo = createInteractionRepo({
		sessionId,
		settlementBehavior: params.settlementBehavior,
		settlementCalls,
	});

	const deps: ThinkerWorkerDeps = {
		sql: {
			begin: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
		} as unknown as postgres.Sql,
		projectionManager,
		interactionRepo,
		recentCognitionSlotRepo: {
			...createSlotRepo(),
			getBySession,
		},
		agentRegistry: createRegistry(),
		createAgentLoop: () => ({ runBuffered }) as unknown as AgentLoop,
		jobPersistence,
		settlementLedger,
		durableJobStore,
		assertionCanonicalization: params.assertionCanonicalization,
		cognitionProjectionRepo: params.cognitionProjectionRows
			? createMockCognitionProjectionRepo(params.cognitionProjectionRows)
			: undefined,
		canonicalizationSimilarityThreshold:
			params.canonicalizationSimilarityThreshold,
		entityJudgeSweeper: params.entityJudgeSweeper,
		entityJudgeEnabled: params.entityJudgeEnabled,
		entityJudgeBatchIntervalMs: params.entityJudgeBatchIntervalMs,
		replayUnresolvedWorldStateOpsFn: params.replayUnresolvedWorldStateOpsFn,
	};

	const readBySettlementSpy = jest
		.spyOn(PgEpisodeRepo.prototype, "readBySettlement")
		.mockResolvedValue([] as never[]);
	const getCurrentSpy = jest
		.spyOn(PgCognitionProjectionRepo.prototype, "getCurrent")
		.mockResolvedValue(null);
	const slotUpsertSpy = jest
		.spyOn(PgRecentCognitionSlotRepo.prototype, "upsertRecentCognitionSlot")
		.mockResolvedValue({});

	return {
		worker: createThinkerWorker(deps),
		payload,
		projectionManager,
		runBuffered,
		listPendingByKindAndPayload,
		getBySession,
		jobPersistence,
		settlementLedger,
		readBySettlementSpy,
		getCurrentSpy,
		slotUpsertSpy,
		settlementCalls,
		getCapturedPrompt: () => extractUserPrompt(capturedRequest),
	};
}

function makeEntityJudgeReport(overrides?: { created?: number; matched?: number }) {
	return {
		scanned_at: Date.now(),
		duration_ms: 1,
		model_id: "test-model",
		agent_id: AGENT_ID,
		dry_run: false,
		scope: "private_overlay" as const,
		max_candidates_per_key: 10,
		candidate_keys: 1,
		judged: 1,
		matched: overrides?.matched ?? 0,
		created: overrides?.created ?? 0,
		rejected: 0,
		skipped_due_lock: false,
		decisions: [],
	};
}

describe("Thinker Worker batch collapse (R-P3-02)", () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("batch detection finds 2 additional pending jobs and injects 3-turn sketch chain", async () => {
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(4),
					talkerTurnVersion: 4,
				},
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: "sketch-v3",
				[settlementIdFor(4)]: "sketch-v4",
				[settlementIdFor(5)]: "sketch-v5",
			},
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			FAIL_AFTER_PROMPT,
		);

		expect(fixture.listPendingByKindAndPayload.mock.calls.length).toBe(1);
		const prompt = fixture.getCapturedPrompt();
		expect(prompt).toContain("Cognitive sketches from Talker (batch)");
		expect(prompt).toContain("[Turn 3 | stl:req-3] sketch-v3");
		expect(prompt).toContain("[Turn 4 | stl:req-4] sketch-v4");
		expect(prompt).toContain("[Turn 5 | stl:req-5] sketch-v5");
	});

	it("sketch chain ordering is ascending by talkerTurnVersion", async () => {
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				},
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(3),
					talkerTurnVersion: 3,
				},
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(4),
					talkerTurnVersion: 4,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: "s3",
				[settlementIdFor(4)]: "s4",
				[settlementIdFor(5)]: "s5",
			},
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			FAIL_AFTER_PROMPT,
		);

		const prompt = fixture.getCapturedPrompt();
		const idx3 = prompt.indexOf("[Turn 3 | ");
		const idx4 = prompt.indexOf("[Turn 4 | ");
		const idx5 = prompt.indexOf("[Turn 5 | ");
		expect(idx3).toBeGreaterThanOrEqual(0);
		expect(idx4).toBeGreaterThan(idx3);
		expect(idx5).toBeGreaterThan(idx4);
	});

	it("soft cap keeps only newest 20 sketches and warns about excluded count, then batch split processes first chunk", async () => {
		const warnSpy = jest
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const pendingPayloads: CognitionThinkerJobPayload[] = [];
		const settlementBehavior: SettlementBehavior = {};

		for (let version = 1; version <= 25; version += 1) {
			settlementBehavior[settlementIdFor(version)] = `sketch-v${version}`;
			if (version > 1) {
				pendingPayloads.push({
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(version),
					talkerTurnVersion: version,
				});
			}
		}

		const fixture = createFixture({
			claimedVersion: 1,
			pendingPayloads,
			settlementBehavior,
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			FAIL_AFTER_PROMPT,
		);

		const prompt = fixture.getCapturedPrompt();
		const turnMatches = prompt.match(/\[Turn \d+ \| [^\]]+\]/g) ?? [];
		// Soft cap trims 25 → 20 (excludes oldest 5: v1-v5).
		// Batch split (threshold=3) then takes only the first 3 (v6-v8)
		// for this worker, enqueueing the rest as sub-jobs.
		expect(turnMatches).toHaveLength(3);
		expect(prompt).not.toContain("[Turn 1 | ");
		expect(prompt).not.toContain("[Turn 5 | ");
		expect(prompt).toContain("[Turn 6 | ");
		expect(prompt).toContain("[Turn 8 | ");
		// v9+ are in enqueued sub-jobs, not in this worker's prompt
		expect(prompt).not.toContain("[Turn 9 | ");
		expect(prompt).not.toContain("[Turn 25 | ");

		// Soft cap warning was emitted (5 older sketches excluded)
		expect(
			warnSpy.mock.calls.some((call) =>
				call.some(
					(part) =>
						typeof part === "string" &&
						part.includes("batch soft cap") &&
						part.includes("5"),
				),
			),
		).toBe(true);

		// Batch split enqueued sub-jobs for the remainder (v9-v25 = 17 items → 6 sub-batches)
		const enqueueCall = fixture.jobPersistence.enqueue as ReturnType<
			typeof jest.fn
		>;
		expect(enqueueCall.mock.calls.length).toBe(6);
	});

	it("contiguous prefix truncates at first sketch-load failure and excludes later turns", async () => {
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(4),
					talkerTurnVersion: 4,
				},
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: "sketch-v3",
				[settlementIdFor(4)]: new Error("boom-v4"),
				[settlementIdFor(5)]: "sketch-v5",
			},
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			FAIL_AFTER_PROMPT,
		);

		const prompt = fixture.getCapturedPrompt();
		expect(prompt).toContain("Cognitive sketch from Talker: sketch-v3");
		expect(prompt).not.toContain("Cognitive sketches from Talker (batch)");
		expect(prompt).not.toContain("[Turn 5 | ");
		expect(fixture.settlementCalls).toContain(settlementIdFor(4));
		expect(fixture.settlementCalls).not.toContain(settlementIdFor(5));
	});

	it("claimed-job sketch failure falls back to single-job error path", async () => {
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(4),
					talkerTurnVersion: 4,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: new Error("claimed-sketch-fail"),
				[settlementIdFor(4)]: "sketch-v4",
			},
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			"claimed-sketch-fail",
		);

		expect(fixture.runBuffered.mock.calls.length).toBe(0);
		expect(
			fixture.settlementCalls.filter((id) => id === settlementIdFor(3)).length,
		).toBe(2);
	});

	it("no durableJobStore keeps single-job path for backward compatibility", async () => {
		const fixture = createFixture({
			claimedVersion: 7,
			withDurableJobStore: false,
			settlementBehavior: {
				[settlementIdFor(7)]: "single-sketch-v7",
			},
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			FAIL_AFTER_PROMPT,
		);

		expect(fixture.listPendingByKindAndPayload.mock.calls.length).toBe(0);
		const prompt = fixture.getCapturedPrompt();
		expect(prompt).toContain("Cognitive sketch from Talker: single-sketch-v7");
		expect(prompt).not.toContain("Cognitive sketches from Talker (batch)");
	});

	it("commits a batch once using the effective settlement and viewer snapshot", async () => {
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(4),
					talkerTurnVersion: 4,
				},
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: { sketch: "sketch-v3", viewerLocation: 33 },
				[settlementIdFor(4)]: { sketch: "sketch-v4", viewerLocation: 44 },
				[settlementIdFor(5)]: { sketch: "sketch-v5", viewerLocation: 55 },
			},
			agentOutcome: makeSuccessOutcome(),
		});

		await fixture.worker({ payload: fixture.payload });

		expect(fixture.projectionManager.commitSettlement.mock.calls.length).toBe(
			1,
		);
		const [projectionParams] =
			fixture.projectionManager.commitSettlement.mock.calls[0];
		expect(projectionParams.settlementId).toBe(settlementIdFor(5));
		expect(projectionParams.viewerSnapshot?.currentLocationEntityId).toBe(55);
	});

	it("batch mode sets thinkerCommittedVersion via setThinkerVersion instead of versionIncrement", async () => {
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(4),
					talkerTurnVersion: 4,
				},
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: "sketch-v3",
				[settlementIdFor(4)]: "sketch-v4",
				[settlementIdFor(5)]: "sketch-v5",
			},
			agentOutcome: makeSuccessOutcome(),
		});

		await fixture.worker({ payload: fixture.payload });

		const call = fixture.slotUpsertSpy.mock.calls.at(-1);
		expect(call?.[4]).toBeUndefined();
		expect(call?.[5]).toBe(5);
	});

	it("markThinkerProjecting and markApplied are called for all batch members", async () => {
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(4),
					talkerTurnVersion: 4,
				},
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: "sketch-v3",
				[settlementIdFor(4)]: "sketch-v4",
				[settlementIdFor(5)]: "sketch-v5",
			},
			agentOutcome: makeSuccessOutcome(),
		});

		await fixture.worker({ payload: fixture.payload });

		// Effective settlement gets markThinkerProjecting first
		expect(fixture.settlementLedger.markThinkerProjecting).toHaveBeenCalledWith(
			settlementIdFor(5),
			AGENT_ID,
		);
		// All batch members get markThinkerProjecting (P1: per-settlement projection)
		expect(fixture.settlementLedger.markThinkerProjecting).toHaveBeenCalledWith(
			settlementIdFor(3),
			AGENT_ID,
		);
		expect(fixture.settlementLedger.markThinkerProjecting).toHaveBeenCalledWith(
			settlementIdFor(4),
			AGENT_ID,
		);
		// All projected members get markApplied
		expect(fixture.settlementLedger.markApplied).toHaveBeenCalledWith(
			settlementIdFor(3),
		);
		expect(fixture.settlementLedger.markApplied).toHaveBeenCalledWith(
			settlementIdFor(4),
		);
		expect(fixture.settlementLedger.markApplied).toHaveBeenCalledWith(
			settlementIdFor(5),
		);
		// markReplayedNoop not called for successfully projected members
		expect(fixture.settlementLedger.markReplayedNoop).not.toHaveBeenCalledWith(
			settlementIdFor(3),
		);
		expect(fixture.settlementLedger.markReplayedNoop).not.toHaveBeenCalledWith(
			settlementIdFor(4),
		);
	});

	it("routes post-commit reads, conflicts, and organizer jobs through effectiveSettlementId", async () => {
		const resolveConflictSpy = jest
			.spyOn(relationIntentResolverModule, "resolveConflictFactors")
			.mockResolvedValue({
				resolved: [
					{
						kind: "contradicts",
						ref: "belief:old",
						nodeRef: "assertion:existing",
					},
				],
				unresolved: [],
			});
		const applyContestSpy = jest
			.spyOn(contestConflictApplicatorModule, "applyContestConflictFactors")
			.mockResolvedValue(undefined);
		const enqueueSpy = jest
			.spyOn(organizeEnqueueModule, "enqueueOrganizerJobs")
			.mockResolvedValue(undefined);
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: "sketch-v3",
				[settlementIdFor(5)]: "sketch-v5",
			},
			agentOutcome: makeSuccessOutcome({
				key: "belief:contested",
				stance: "contested",
				conflictFactors: [{ kind: "contradicts", ref: "belief:old" }],
			}),
		});
		fixture.readBySettlementSpy.mockResolvedValue([
			{ id: 1, source_local_ref: "ep:test" },
		] as never[]);
		fixture.getCurrentSpy.mockImplementation(async (_agentId, key) => {
			if (key === "belief:contested") {
				return { id: 9, kind: "assertion" } as never;
			}
			return null as never;
		});

		await fixture.worker({ payload: fixture.payload });

		expect(fixture.readBySettlementSpy).toHaveBeenCalledWith(
			settlementIdFor(5),
			AGENT_ID,
		);
		const resolveConflictCall = resolveConflictSpy.mock.calls[0];
		expect(resolveConflictCall?.[2]).toEqual(
			expect.objectContaining({ settlementId: settlementIdFor(5) }),
		);
		const applyContestCall = applyContestSpy.mock.calls[0];
		expect(applyContestCall?.[2]).toBe(AGENT_ID);
		expect(applyContestCall?.[3]).toBe(settlementIdFor(5));
		const enqueueCall = enqueueSpy.mock.calls[0];
		expect(enqueueCall?.[0]).toBe(fixture.jobPersistence);
		expect(enqueueCall?.[1]).toBe(AGENT_ID);
		expect(enqueueCall?.[2]).toBe(settlementIdFor(5));
	});

	it("idempotency skip marks the claimed settlement as replayed_noop", async () => {
		const fixture = createFixture({
			claimedVersion: 5,
			initialThinkerCommittedVersion: 5,
			settlementBehavior: {
				[settlementIdFor(5)]: "sketch-v5",
			},
		});

		await fixture.worker({ payload: fixture.payload });

		expect(fixture.settlementLedger.markReplayedNoop).toHaveBeenCalledWith(
			settlementIdFor(5),
		);
		expect(fixture.runBuffered.mock.calls.length).toBe(0);
	});

	it("single-job mode still increments thinker version with versionIncrement", async () => {
		const fixture = createFixture({
			claimedVersion: 7,
			withDurableJobStore: false,
			settlementBehavior: {
				[settlementIdFor(7)]: {
					sketch: "single-sketch-v7",
					viewerLocation: 77,
				},
			},
			agentOutcome: makeSuccessOutcome(),
		});

		await fixture.worker({ payload: fixture.payload });

		const call = fixture.slotUpsertSpy.mock.calls.at(-1);
		expect(call?.[4]).toBe("thinker");
		expect(call?.[5]).toBeUndefined();
	});

	it("worker host wiring passes durableJobStore into createThinkerWorker", async () => {
		const createThinkerWorkerSpy = jest
			.spyOn(thinkerWorkerModule, "createThinkerWorker")
			.mockReturnValue(async () => undefined);
		let registeredHandler:
			| ((job: { payload_json: CognitionThinkerJobPayload }) => Promise<void>)
			| undefined;
		const originalRegisterWorker = PgJobRunner.prototype.registerWorker;
		const originalProcessNext = PgJobRunner.prototype.processNext;
		PgJobRunner.prototype.registerWorker = function patchedRegisterWorker(
			kind,
			handler,
		) {
			if (kind === "cognition.thinker") {
				registeredHandler = handler as typeof registeredHandler;
			}
		};
		PgJobRunner.prototype.processNext = async function patchedProcessNext() {
			if (registeredHandler) {
				await registeredHandler({
					payload_json: {
						sessionId: SESSION_ID,
						agentId: AGENT_ID,
						settlementId: settlementIdFor(1),
						talkerTurnVersion: 1,
					},
				});
				registeredHandler = undefined;
			}
			return "none_ready" as never;
		};

		const store = {
			enqueue: async () => ({
				outcome: "created" as const,
				job_key: "job",
				status: "pending" as const,
				claim_version: 1,
			}),
			claimNext: async () => ({ outcome: "none_ready" as const }),
			heartbeat: async () => ({
				outcome: "not_found" as const,
				job_key: "job",
				claim_version: 1,
			}),
			complete: async () => ({
				outcome: "not_found" as const,
				job_key: "job",
				claim_version: 1,
			}),
			fail: async () => ({
				outcome: "not_found" as const,
				job_key: "job",
				claim_version: 1,
			}),
			cancel: async () => ({
				outcome: "not_found" as const,
				job_key: "job",
				claim_version: 1,
			}),
			reclaimExpiredLeases: async () => 0,
			inspect: async () => undefined,
			listActive: async () => [],
			listPendingByKindAndPayload: async () => [],
			listExpiredLeases: async () => [],
			countByStatus: async () => ({
				pending: 0,
				running: 0,
				succeeded: 0,
				failed_terminal: 0,
				cancelled: 0,
			}),
			getHistory: async () => [],
		} as DurableJobStore;
		const runtime = {
			backendType: "pg",
			healthChecks: { bootstrap: "ok" },
			traceStore: undefined,
			sessionService: {} as RuntimeBootstrapResult["sessionService"],
			turnService: {
				setSettlementUnitOfWork: () => undefined,
			} as unknown as RuntimeBootstrapResult["turnService"],
			memoryTaskAgent: null,
			interactionRepo: {} as RuntimeBootstrapResult["interactionRepo"],
			agentRegistry: createRegistry(),
			memoryPipelineReady: false,
			memoryPipelineStatus: "missing_embedding_model",
			effectiveOrganizerEmbeddingModelId: undefined,
			migrationStatus: {
				interaction: { succeeded: true, appliedMigrations: [] },
				memory: { succeeded: true },
				succeeded: true,
			},
			projectionManager: {} as RuntimeBootstrapResult["projectionManager"],
			recentCognitionSlotRepo: createSlotRepo(),
			createAgentLoop: () => null,
			jobPersistence: createMockJobPersistence(),
			pgFactory: {
				type: "pg",
				initialize: async () => undefined,
				close: async () => undefined,
				isInitialized: () => true,
				getPool: () => ({}) as postgres.Sql,
				pool: null,
				store,
			},
			shutdown: () => undefined,
		} as unknown as RuntimeBootstrapResult;

		try {
			const host = await createAppHost({ role: "worker" }, runtime);
			await host.start();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await host.shutdown();

			expect(createThinkerWorkerSpy.mock.calls.length).toBeGreaterThan(0);
			const deps = createThinkerWorkerSpy.mock.calls[0]?.[0];
			expect(deps?.durableJobStore).toBe(store);
		} finally {
			PgJobRunner.prototype.registerWorker = originalRegisterWorker;
			PgJobRunner.prototype.processNext = originalProcessNext;
		}
	});

	it("LLM failure produces zero commits and marks both claimed and effective settlements as failed", async () => {
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(4),
					talkerTurnVersion: 4,
				},
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: "sketch-v3",
				[settlementIdFor(4)]: "sketch-v4",
				[settlementIdFor(5)]: "sketch-v5",
			},
		});

		fixture.runBuffered.mockImplementation(async () => {
			throw new Error("LLM timeout");
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			"LLM timeout",
		);

		expect(fixture.projectionManager.commitSettlement.mock.calls.length).toBe(
			0,
		);
		expect(fixture.settlementLedger.markApplied.mock.calls.length).toBe(0);
		expect(fixture.settlementLedger.markFailed).toHaveBeenCalledWith(
			settlementIdFor(3),
			"LLM timeout",
			true,
		);
		expect(fixture.settlementLedger.markFailed).toHaveBeenCalledWith(
			settlementIdFor(5),
			"LLM timeout",
			true,
		);
		expect(fixture.settlementLedger.markReplayedNoop.mock.calls.length).toBe(0);
	});

	it("partial sketch load failure truncates to contiguous prefix and commits as single-job", async () => {
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(4),
					talkerTurnVersion: 4,
				},
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: "sketch-v3",
				[settlementIdFor(4)]: new Error("v4 payload missing"),
				[settlementIdFor(5)]: "sketch-v5",
			},
			agentOutcome: makeSuccessOutcome(),
		});

		await fixture.worker({ payload: fixture.payload });

		const prompt = fixture.getCapturedPrompt();
		expect(prompt).toContain("Cognitive sketch from Talker: sketch-v3");
		expect(prompt).not.toContain("(batch)");
		expect(prompt).not.toContain("[Turn 5 | ");

		const call = fixture.slotUpsertSpy.mock.calls.at(-1);
		expect(call?.[4]).toBe("thinker");
		expect(call?.[5]).toBeUndefined();

		expect(fixture.settlementCalls).not.toContain(settlementIdFor(5));

		expect(fixture.projectionManager.commitSettlement.mock.calls.length).toBe(
			1,
		);
		const [projParams] =
			fixture.projectionManager.commitSettlement.mock.calls[0];
		expect(projParams.settlementId).toBe(settlementIdFor(3));

		expect(fixture.settlementLedger.markApplied).toHaveBeenCalledWith(
			settlementIdFor(3),
		);
		expect(fixture.settlementLedger.markReplayedNoop.mock.calls.length).toBe(0);
	});

	it("commitSettlement failure prevents ledger update and marks both settlements as failed", async () => {
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(4),
					talkerTurnVersion: 4,
				},
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: "sketch-v3",
				[settlementIdFor(4)]: "sketch-v4",
				[settlementIdFor(5)]: "sketch-v5",
			},
			agentOutcome: makeSuccessOutcome(),
		});

		fixture.projectionManager.commitSettlement.mockImplementation(async () => {
			throw new Error("DB write failed");
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			"DB write failed",
		);

		expect(fixture.settlementLedger.markApplied.mock.calls.length).toBe(0);
		expect(fixture.settlementLedger.markReplayedNoop.mock.calls.length).toBe(0);
		expect(fixture.settlementLedger.markThinkerProjecting).toHaveBeenCalledWith(
			settlementIdFor(5),
			AGENT_ID,
		);
		expect(fixture.settlementLedger.markFailed).toHaveBeenCalledWith(
			settlementIdFor(3),
			"DB write failed",
			true,
		);
		expect(fixture.settlementLedger.markFailed).toHaveBeenCalledWith(
			settlementIdFor(5),
			"DB write failed",
			true,
		);
		expect(fixture.slotUpsertSpy.mock.calls.length).toBe(0);
	});

	it("retry rebuilds batch dynamically from changed pending set", async () => {
		let pendingCallCount = 0;
		const fixture = createFixture({
			claimedVersion: 3,
			settlementBehavior: {
				[settlementIdFor(3)]: "sketch-v3",
				[settlementIdFor(4)]: "sketch-v4",
				[settlementIdFor(5)]: "sketch-v5",
			},
		});

		fixture.listPendingByKindAndPayload.mockImplementation(async () => {
			pendingCallCount++;
			if (pendingCallCount === 1) {
				return [
					makePendingRow({
						sessionId: SESSION_ID,
						agentId: AGENT_ID,
						settlementId: settlementIdFor(4),
						talkerTurnVersion: 4,
					}),
					makePendingRow({
						sessionId: SESSION_ID,
						agentId: AGENT_ID,
						settlementId: settlementIdFor(5),
						talkerTurnVersion: 5,
					}),
				];
			}
			return [
				makePendingRow({
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				}),
			];
		});

		const capturedRequests: AgentRunRequest[] = [];
		fixture.runBuffered.mockImplementation(async (request: AgentRunRequest) => {
			capturedRequests.push(request);
			if (capturedRequests.length === 1) {
				throw new Error("first fail");
			}
			return { outcome: makeSuccessOutcome() };
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			"first fail",
		);

		await fixture.worker({ payload: fixture.payload });

		expect(capturedRequests.length).toBe(2);
		const secondPrompt = capturedRequests[1].messages
			.filter((m) => m.role === "user" && typeof m.content === "string")
			.map((m) => m.content)
			.join("\n");
		expect(secondPrompt).toContain("[Turn 3 | ");
		expect(secondPrompt).toContain("[Turn 5 | ");
		expect(secondPrompt).not.toContain("[Turn 4 | ");
	});

	it("S6: version monotonicity keeps thinkerCommittedVersion at 5 when late v3 retries", async () => {
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(4),
					talkerTurnVersion: 4,
				},
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: "sketch-v3",
				[settlementIdFor(4)]: "sketch-v4",
				[settlementIdFor(5)]: "sketch-v5",
			},
			agentOutcome: makeSuccessOutcome(),
		});

		fixture.getBySession
			.mockImplementationOnce(async () => undefined)
			.mockImplementation(async () => ({
				lastSettlementId: settlementIdFor(5),
				slotPayload: [],
				updatedAt: Date.now(),
				talkerTurnCounter: 5,
				thinkerCommittedVersion: 5,
			}));

		await fixture.worker({ payload: fixture.payload });

		const firstUpsertCall = fixture.slotUpsertSpy.mock.calls.at(-1);
		expect(firstUpsertCall?.[5]).toBe(5);

		fixture.runBuffered.mockClear();
		fixture.projectionManager.commitSettlement.mockClear();
		fixture.settlementLedger.markReplayedNoop.mockClear();

		await fixture.worker({ payload: fixture.payload });

		expect(fixture.runBuffered.mock.calls.length).toBe(0);
		expect(fixture.projectionManager.commitSettlement.mock.calls.length).toBe(
			0,
		);
		expect(fixture.settlementLedger.markReplayedNoop).toHaveBeenCalledWith(
			settlementIdFor(3),
		);
	});

	it("S8: cross-session isolation batches only jobs from the claimed session", async () => {
		const sessionB = "session:other";
		const fixture = createFixture({
			claimedVersion: 3,
			settlementBehavior: {
				[settlementIdFor(3)]: "session-a-v3",
				[settlementIdFor(4)]: "session-a-v4",
				[settlementIdFor(5)]: "session-a-v5",
			},
		});

		fixture.listPendingByKindAndPayload.mockImplementation(
			async (...args: unknown[]) => {
				const filter = args[1] as
					| { sessionId?: string; agentId?: string }
					| undefined;
				if (filter?.sessionId === SESSION_ID) {
					return [
						makePendingRow({
							sessionId: SESSION_ID,
							agentId: AGENT_ID,
							settlementId: settlementIdFor(4),
							talkerTurnVersion: 4,
						}),
						makePendingRow({
							sessionId: SESSION_ID,
							agentId: AGENT_ID,
							settlementId: settlementIdFor(5),
							talkerTurnVersion: 5,
						}),
					];
				}

				return [
					makePendingRow({
						sessionId: sessionB,
						agentId: AGENT_ID,
						settlementId: "stl:req-99",
						talkerTurnVersion: 99,
					}),
				];
			},
		);

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			FAIL_AFTER_PROMPT,
		);

		expect(fixture.listPendingByKindAndPayload).toHaveBeenCalledWith(
			"cognition.thinker",
			expect.objectContaining({ sessionId: SESSION_ID, agentId: AGENT_ID }),
			expect.any(Number),
		);
		const prompt = fixture.getCapturedPrompt();
		expect(prompt).toContain("[Turn 3 | stl:req-3] session-a-v3");
		expect(prompt).toContain("[Turn 4 | stl:req-4] session-a-v4");
		expect(prompt).toContain("[Turn 5 | stl:req-5] session-a-v5");
		expect(prompt).not.toContain("session-b");
		expect(prompt).not.toContain("[Turn 99 | ");
	});

	it("worker constructs and runs without assertionCanonicalization bundle (no-op fallback)", async () => {
		const debugSpy = jest
			.spyOn(console, "debug")
			.mockImplementation(() => undefined);

		const fixture = createFixture({
			claimedVersion: 7,
			withDurableJobStore: false,
			settlementBehavior: {
				[settlementIdFor(7)]: "sketch-v7-no-canon",
			},
			agentOutcome: makeSuccessOutcome(),
		});

		await fixture.worker({ payload: fixture.payload });

		expect(fixture.projectionManager.commitSettlement.mock.calls.length).toBe(
			1,
		);

		expect(
			debugSpy.mock.calls.some((call) =>
				call.some(
					(part) =>
						typeof part === "string" &&
						part.includes("assertionCanonicalization bundle absent"),
				),
			),
		).toBe(true);
	});

	it("single-turn settlement with explicit sketch carries cognitiveSketchSource=explicit", async () => {
		const fixture = createFixture({
			claimedVersion: 7,
			withDurableJobStore: false,
			settlementBehavior: {
				[settlementIdFor(7)]: {
					sketch: "explicit-sketch-v7",
					cognitiveSketchSource: "explicit",
				},
			},
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			FAIL_AFTER_PROMPT,
		);

		const prompt = fixture.getCapturedPrompt();
		expect(prompt).toContain(
			"Cognitive sketch from Talker: explicit-sketch-v7",
		);
	});

	it("single-turn settlement with auto_fallback sketch carries cognitiveSketchSource=auto_fallback", async () => {
		const fixture = createFixture({
			claimedVersion: 7,
			withDurableJobStore: false,
			settlementBehavior: {
				[settlementIdFor(7)]: {
					sketch: "[auto-sketch] some fallback text",
					cognitiveSketchSource: "auto_fallback",
				},
			},
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			FAIL_AFTER_PROMPT,
		);

		const prompt = fixture.getCapturedPrompt();
		expect(prompt).toContain(
			"Cognitive sketch from Talker: [auto-sketch] some fallback text",
		);
	});

	it("batch chain: later corrected value wins within invocation", async () => {
		const canonicalKey = "belief:batch-chain:canonical";
		const oldClaim = "The user is in the kitchen";
		const correctedClaim = "The user is in the library";

		const fixture = createFixture({
			claimedVersion: 7,
			withDurableJobStore: false,
			settlementBehavior: {
				[settlementIdFor(7)]: {
					sketch: "single-sketch-v7",
					cognitiveSketchSource: "explicit",
				},
			},
			assertionCanonicalization: createMockAssertionCanonicalizationBundle({
				neighbors: [{ nodeRef: "assertion:991", similarity: 0.92 }],
			}),
			cognitionProjectionRows: [
				makeCurrentAssertionRow({
					id: 991,
					key: canonicalKey,
					holderId: "self",
					claim: "legacy",
					entityRefs: ["entity:user", "entity:kitchen", "entity:library"],
				}),
			],
			agentOutcome: {
				schemaVersion: "rp_turn_outcome_v5",
				publicReply: "ok",
				privateCognition: {
					ops: [
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "belief:draft:batch-chain:old",
								holderId: { kind: "special", value: "self" },
								claim: oldClaim,
								entityRefs: [
									{ kind: "pointer_key", value: "entity:user" },
									{ kind: "pointer_key", value: "entity:kitchen" },
								],
								stance: "accepted",
								basis: "first_hand",
								provenance: "user_stated",
								claimedGroundingRefs: [
									{ kind: "user_message", ref: "request:req-7" },
								],
							},
						},
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "belief:draft:batch-chain:new",
								holderId: { kind: "special", value: "self" },
								claim: correctedClaim,
								entityRefs: [
									{ kind: "pointer_key", value: "entity:user" },
									{ kind: "pointer_key", value: "entity:library" },
								],
								stance: "accepted",
								basis: "first_hand",
								provenance: "user_stated",
								claimedGroundingRefs: [
									{ kind: "user_message", ref: "request:req-7" },
								],
							},
						},
					],
				},
				privateEpisodes: [],
				publications: [],
				relationIntents: [],
				conflictFactors: [],
			},
		});

		await fixture.worker({ payload: fixture.payload });

		const [projectionParams] =
			fixture.projectionManager.commitSettlement.mock.calls[0];
		const upsertKeys = projectionParams.cognitionOps
			.filter((op: { op: string }) => op.op === "upsert")
			.map((op: { record: { key: string } }) => op.record.key);
		expect(upsertKeys).toEqual([canonicalKey]);

		const lastRecord = projectionParams.cognitionOps.find(
			(op: { op: string }) => op.op === "upsert",
		)?.record as {
			claim?: string;
			key: string;
		};
		expect(lastRecord.key).toBe(canonicalKey);
		expect(lastRecord.claim).toBe(correctedClaim);
	});

	it("batch-local canonicalization overlay reuses canonical key for silent correction in same invocation", async () => {
		const canonicalKey = "belief:batch-overlay:canonical";
		const fixture = createFixture({
			claimedVersion: 7,
			withDurableJobStore: false,
			settlementBehavior: {
				[settlementIdFor(7)]: {
					sketch: "overlay-silent-correction",
					cognitiveSketchSource: "explicit",
				},
			},
			assertionCanonicalization: createMockAssertionCanonicalizationBundle({
				neighbors: [{ nodeRef: "assertion:701", similarity: 0.93 }],
			}),
			cognitionProjectionRows: [
				makeCurrentAssertionRow({
					id: 701,
					key: canonicalKey,
					holderId: "self",
					claim: "legacy",
					entityRefs: ["entity:user", "entity:kitchen"],
				}),
			],
			agentOutcome: {
				schemaVersion: "rp_turn_outcome_v5",
				publicReply: "ok",
				privateCognition: {
					ops: [
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "belief:draft:overlay:old",
								holderId: { kind: "special", value: "self" },
								claim: "user in kitchen",
								entityRefs: [
									{ kind: "pointer_key", value: "entity:user" },
									{ kind: "pointer_key", value: "entity:kitchen" },
								],
								stance: "accepted",
								basis: "first_hand",
								provenance: "user_stated",
								claimedGroundingRefs: [
									{ kind: "user_message", ref: "request:req-7" },
								],
							},
						},
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "belief:draft:overlay:new",
								holderId: { kind: "special", value: "self" },
								claim: "user moved to library",
								entityRefs: [
									{ kind: "pointer_key", value: "entity:user" },
									{ kind: "pointer_key", value: "entity:library" },
								],
								stance: "accepted",
								basis: "first_hand",
								provenance: "user_stated",
								claimedGroundingRefs: [
									{ kind: "user_message", ref: "request:req-7" },
								],
							},
						},
					],
				},
				privateEpisodes: [],
				publications: [],
				relationIntents: [],
				conflictFactors: [],
			},
		});

		await fixture.worker({ payload: fixture.payload });

		const [projectionParams] =
			fixture.projectionManager.commitSettlement.mock.calls[0];
		const upserts = projectionParams.cognitionOps.filter(
			(op: { op: string }) => op.op === "upsert",
		) as Array<{ record: { key: string; claim?: string } }>;
		expect(upserts).toHaveLength(1);
		expect(upserts[0].record.key).toBe(canonicalKey);
		expect(upserts[0].record.claim).toBe("user moved to library");

		const keys = upserts.map((u) => u.record.key);
		expect(
			keys.some((key) => key.endsWith("_revised") || key.endsWith("_v2")),
		).toBe(false);
	});

	it("explicit sketch provenance remains non-canonicalized in v1 (known limitation)", async () => {
		const canonicalKey = "belief:known-limitation:canonical";
		const originalKey = "belief:draft:known-limitation";

		const fixture = createFixture({
			claimedVersion: 7,
			withDurableJobStore: false,
			settlementBehavior: {
				[settlementIdFor(7)]: {
					sketch: "explicit sketch path",
					cognitiveSketchSource: "explicit",
				},
			},
			assertionCanonicalization: createMockAssertionCanonicalizationBundle({
				neighbors: [{ nodeRef: "assertion:702", similarity: 0.95 }],
			}),
			cognitionProjectionRows: [
				makeCurrentAssertionRow({
					id: 702,
					key: canonicalKey,
					holderId: "self",
					claim: "legacy claim",
					entityRefs: ["entity:user", "entity:room"],
				}),
			],
			agentOutcome: {
				schemaVersion: "rp_turn_outcome_v5",
				publicReply: "ok",
				privateCognition: {
					ops: [
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: originalKey,
								holderId: { kind: "special", value: "self" },
								claim: "sketch-only correction candidate",
								entityRefs: [
									{ kind: "pointer_key", value: "entity:user" },
									{ kind: "pointer_key", value: "entity:room" },
								],
								stance: "accepted",
								basis: "belief",
								provenance: "talker_sketch_explicit",
								claimedGroundingRefs: [
									{ kind: "cognitive_sketch", ref: "settlement:stl:req-7" },
								],
							},
						},
					],
				},
				privateEpisodes: [],
				publications: [],
				relationIntents: [],
				conflictFactors: [],
			},
		});

		await fixture.worker({ payload: fixture.payload });

		const [projectionParams] =
			fixture.projectionManager.commitSettlement.mock.calls[0];
		const upserts = projectionParams.cognitionOps.filter(
			(op: { op: string }) => op.op === "upsert",
		) as Array<{ record: { key: string } }>;
		expect(upserts).toHaveLength(1);
		expect(upserts[0].record.key).toBe(originalKey);
		expect(upserts[0].record.key).not.toBe(canonicalKey);
	});

	it("v1 continuity: within-run later correction wins canonical key in slot payload and recent rendering", async () => {
		const canonicalKey = "belief:v1:correction-continuity";
		const oldClaim = "user location is kitchen";
		const correctedClaim = "user location is library";

		const fixture = createFixture({
			claimedVersion: 10,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(11),
					talkerTurnVersion: 11,
				},
			],
			settlementBehavior: {
				[settlementIdFor(10)]: {
					sketch: "turn-10 sketch",
					cognitiveSketchSource: "explicit",
				},
				[settlementIdFor(11)]: {
					sketch: "turn-11 correction sketch",
					cognitiveSketchSource: "explicit",
				},
			},
			assertionCanonicalization: createMockAssertionCanonicalizationBundle({
				neighbors: [{ nodeRef: "assertion:910", similarity: 0.94 }],
			}),
			cognitionProjectionRows: [
				makeCurrentAssertionRow({
					id: 910,
					key: canonicalKey,
					holderId: "self",
					claim: "legacy-location",
					entityRefs: ["entity:user", "entity:kitchen", "entity:library"],
				}),
			],
			agentOutcome: {
				schemaVersion: "rp_turn_outcome_v5",
				publicReply: "ok",
				privateCognition: {
					ops: [
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "belief:draft:v1:old",
								holderId: { kind: "special", value: "self" },
								claim: oldClaim,
								entityRefs: [
									{ kind: "pointer_key", value: "entity:user" },
									{ kind: "pointer_key", value: "entity:kitchen" },
								],
								stance: "accepted",
								basis: "first_hand",
								provenance: "user_stated",
								sourceTurnVersion: 10,
								claimedGroundingRefs: [
									{ kind: "user_message", ref: "request:req-10" },
								],
							},
						},
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "belief:draft:v1:new",
								holderId: { kind: "special", value: "self" },
								claim: correctedClaim,
								entityRefs: [
									{ kind: "pointer_key", value: "entity:user" },
									{ kind: "pointer_key", value: "entity:library" },
								],
								stance: "accepted",
								basis: "first_hand",
								provenance: "user_stated",
								sourceTurnVersion: 11,
								claimedGroundingRefs: [
									{ kind: "user_message", ref: "request:req-11" },
								],
							},
						},
					],
				},
				privateEpisodes: [],
				publications: [],
				relationIntents: [],
				conflictFactors: [],
			},
		});

		await fixture.worker({ payload: fixture.payload });

		const [projectionParams] = fixture.projectionManager.commitSettlement.mock
			.calls[0] as Array<{
			cognitionOps: Array<{
				op: string;
				record: { key: string; claim?: string };
			}>;
			recentCognitionSlotJson: string;
		}>;
		const upserts = projectionParams.cognitionOps.filter(
			(op) => op.op === "upsert",
		);
		expect(upserts).toHaveLength(1);
		expect(upserts[0].record.key).toBe(canonicalKey);
		expect(upserts[0].record.claim).toBe(correctedClaim);

		const slotEntries = JSON.parse(
			projectionParams.recentCognitionSlotJson,
		) as Array<{
			key: string;
			summary: string;
			sourceTurnVersion?: number;
		}>;
		expect(slotEntries).toHaveLength(1);
		expect(slotEntries[0].key).toBe(canonicalKey);
		expect(slotEntries[0].summary).toContain(correctedClaim);
		expect(slotEntries[0].summary).not.toContain(oldClaim);
		expect(slotEntries[0].sourceTurnVersion).toBe(11);
		expect(
			slotEntries.some(
				(entry) =>
					entry.key === `${canonicalKey}_revised` ||
					entry.key === `${canonicalKey}_v2`,
			),
		).toBe(false);

		const renderedRecent = formatRecentCognitionFromPayload(
			projectionParams.recentCognitionSlotJson,
		);
		expect(renderedRecent).toContain(correctedClaim);
		expect(renderedRecent).not.toContain(oldClaim);
		expect(renderedRecent).not.toContain(`${canonicalKey}_revised`);
		expect(renderedRecent).not.toContain(`${canonicalKey}_v2`);
	});

	it("v1 continuity: split sub-batches keep local metadata and converge to corrected winner after merge", async () => {
		const key = "belief:v1:split-sub-batch-location";
		const hallucinatedClaim = "user location is basement";
		const correctedClaim = "user location is observatory";

		const subBatchA = createFixture({
			claimedVersion: 10,
			withDurableJobStore: false,
			settlementBehavior: {
				[settlementIdFor(10)]: {
					sketch: "auto fallback sketch v10",
					cognitiveSketchSource: "auto_fallback",
				},
			},
			agentOutcome: {
				schemaVersion: "rp_turn_outcome_v5",
				publicReply: "ok",
				privateCognition: {
					ops: [
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key,
								holderId: { kind: "special", value: "self" },
								claim: hallucinatedClaim,
								entityRefs: [
									{ kind: "pointer_key", value: "entity:user" },
									{ kind: "pointer_key", value: "entity:basement" },
								],
								stance: "accepted",
								basis: "first_hand",
								provenance: "user_stated",
								claimedGroundingRefs: [
									{ kind: "user_message", ref: "request:req-10" },
								],
							},
						},
					],
				},
				privateEpisodes: [],
				publications: [],
				relationIntents: [],
				conflictFactors: [],
			},
		});

		await subBatchA.worker({ payload: subBatchA.payload });

		const [subBatchAParams] = subBatchA.projectionManager.commitSettlement.mock
			.calls[0] as Array<{ recentCognitionSlotJson: string }>;
		const subBatchASlot = JSON.parse(
			subBatchAParams.recentCognitionSlotJson,
		) as Array<{
			key: string;
			summary: string;
			provenance?: string;
			sourceTurnVersion?: number;
		}>;
		expect(subBatchASlot).toHaveLength(1);
		expect(subBatchASlot[0].key).toBe(key);
		expect(subBatchASlot[0].summary).toContain(hallucinatedClaim);
		expect(subBatchASlot[0].provenance).toBe("talker_sketch_auto");
		expect(subBatchASlot[0].sourceTurnVersion).toBe(10);

		const subBatchB = createFixture({
			claimedVersion: 11,
			withDurableJobStore: false,
			settlementBehavior: {
				[settlementIdFor(11)]: {
					sketch: "explicit correction sketch v11",
					cognitiveSketchSource: "explicit",
				},
			},
			agentOutcome: {
				schemaVersion: "rp_turn_outcome_v5",
				publicReply: "ok",
				privateCognition: {
					ops: [
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key,
								holderId: { kind: "special", value: "self" },
								claim: correctedClaim,
								entityRefs: [
									{ kind: "pointer_key", value: "entity:user" },
									{ kind: "pointer_key", value: "entity:observatory" },
								],
								stance: "accepted",
								basis: "first_hand",
								provenance: "user_stated",
								claimedGroundingRefs: [
									{ kind: "user_message", ref: "request:req-11" },
								],
							},
						},
					],
				},
				privateEpisodes: [],
				publications: [],
				relationIntents: [],
				conflictFactors: [],
			},
		});

		await subBatchB.worker({ payload: subBatchB.payload });

		const [subBatchBParams] = subBatchB.projectionManager.commitSettlement.mock
			.calls[0] as Array<{ recentCognitionSlotJson: string }>;
		const subBatchBSlot = JSON.parse(
			subBatchBParams.recentCognitionSlotJson,
		) as Array<{
			key: string;
			summary: string;
			provenance?: string;
			sourceTurnVersion?: number;
		}>;
		expect(subBatchBSlot).toHaveLength(1);
		expect(subBatchBSlot[0].key).toBe(key);
		expect(subBatchBSlot[0].summary).toContain(correctedClaim);
		expect(subBatchBSlot[0].provenance).toBe("user_stated");
		expect(subBatchBSlot[0].sourceTurnVersion).toBe(11);

		const merged = compactSlotEntries([
			...subBatchASlot,
			...subBatchBSlot,
		]) as Array<{ key: string; summary: string; sourceTurnVersion?: number }>;
		expect(merged).toHaveLength(1);
		expect(merged[0].key).toBe(key);
		expect(merged[0].summary).toContain(correctedClaim);
		expect(merged[0].summary).not.toContain(hallucinatedClaim);
		expect(merged[0].sourceTurnVersion).toBe(11);
	});

	it("correctionSuspected is telemetry-only and does not alter batch control flow", async () => {
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(4),
					talkerTurnVersion: 4,
				},
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: { sketch: "s3", correctionSuspected: true },
				[settlementIdFor(4)]: { sketch: "s4", correctionSuspected: true },
				[settlementIdFor(5)]: { sketch: "s5", correctionSuspected: true },
			},
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			FAIL_AFTER_PROMPT,
		);

		const prompt = fixture.getCapturedPrompt();
		expect(prompt).toContain("Cognitive sketches from Talker (batch)");
		expect(prompt).toContain("[Turn 3 | stl:req-3] s3");
		expect(prompt).toContain("[Turn 4 | stl:req-4] s4");
		expect(prompt).toContain("[Turn 5 | stl:req-5] s5");
		expect(prompt).not.toContain("correctionSuspected");
	});

	it("batch chain with mixed explicit/auto_fallback preserves per-turn cognitiveSketchSource", async () => {
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(4),
					talkerTurnVersion: 4,
				},
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: {
					sketch: "sketch-v3-explicit",
					cognitiveSketchSource: "explicit",
				},
				[settlementIdFor(4)]: {
					sketch: "sketch-v4-auto",
					cognitiveSketchSource: "auto_fallback",
				},
				[settlementIdFor(5)]: {
					sketch: "sketch-v5-explicit",
					cognitiveSketchSource: "explicit",
				},
			},
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			FAIL_AFTER_PROMPT,
		);

		const prompt = fixture.getCapturedPrompt();
		expect(prompt).toContain(
			"[Turn 3 | stl:req-3] sketch-v3-explicit [source:explicit]",
		);
		expect(prompt).toContain(
			"[Turn 4 | stl:req-4] sketch-v4-auto [source:auto_fallback]",
		);
		expect(prompt).toContain(
			"[Turn 5 | stl:req-5] sketch-v5-explicit [source:explicit]",
		);
	});

	it("settlement with correctionSuspected=true preserves the flag on payload", async () => {
		const fixture = createFixture({
			claimedVersion: 7,
			withDurableJobStore: false,
			settlementBehavior: {
				[settlementIdFor(7)]: {
					sketch: "sketch-with-correction",
					correctionSuspected: true,
				},
			},
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			FAIL_AFTER_PROMPT,
		);

		const prompt = fixture.getCapturedPrompt();
		expect(prompt).toContain(
			"Cognitive sketch from Talker: sketch-with-correction",
		);
		expect(prompt).not.toContain("correctionSuspected");
	});

	it("settlement without correction phrase omits correctionSuspected entirely", () => {
		const payload = makeSettlementPayload(
			SESSION_ID,
			settlementIdFor(7),
			"normal-sketch",
		);
		expect(payload.correctionSuspected).toBeUndefined();
		expect("correctionSuspected" in payload).toBe(false);
	});

	it("correctionSuspected never appears in thinker prompt text (batch mode)", async () => {
		const fixture = createFixture({
			claimedVersion: 3,
			pendingPayloads: [
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(4),
					talkerTurnVersion: 4,
				},
				{
					sessionId: SESSION_ID,
					agentId: AGENT_ID,
					settlementId: settlementIdFor(5),
					talkerTurnVersion: 5,
				},
			],
			settlementBehavior: {
				[settlementIdFor(3)]: {
					sketch: "sketch-v3",
					correctionSuspected: true,
				},
				[settlementIdFor(4)]: {
					sketch: "sketch-v4",
					correctionSuspected: true,
				},
				[settlementIdFor(5)]: {
					sketch: "sketch-v5",
				},
			},
		});

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			FAIL_AFTER_PROMPT,
		);

		const prompt = fixture.getCapturedPrompt();
		expect(prompt).toContain("Cognitive sketches from Talker (batch)");
		expect(prompt).not.toContain("correctionSuspected");
		expect(prompt).not.toContain("correction");
	});

	it("runs unresolved world-state replay after successful entity sweep when report created/matched > 0", async () => {
		const runSweep = jest
			.fn()
			.mockResolvedValue(makeEntityJudgeReport({ created: 1, matched: 0 }));
		const replayUnresolvedWorldStateOpsFn = jest
			.fn()
			.mockResolvedValue({ replayed: 1, stillPending: 0, deadLettered: 0 });

		const fixture = createFixture({
			sessionId: "session:replay-hook:created",
			claimedVersion: 7,
			withDurableJobStore: false,
			settlementBehavior: {
				[settlementIdFor(7)]: { sketch: "single-sketch-v7" },
			},
			agentOutcome: makeSuccessOutcome(),
			entityJudgeSweeper: {
				runSweep,
			} as unknown as ThinkerWorkerDeps["entityJudgeSweeper"],
			entityJudgeBatchIntervalMs: 1,
			replayUnresolvedWorldStateOpsFn,
		});

		await fixture.worker({ payload: fixture.payload });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(runSweep).toHaveBeenCalledTimes(1);
		expect(replayUnresolvedWorldStateOpsFn).toHaveBeenCalledTimes(1);
		expect(replayUnresolvedWorldStateOpsFn).toHaveBeenCalledWith(
			AGENT_ID,
			expect.objectContaining({
				viewerSnapshot: expect.objectContaining({
					selfPointerKey: "entity:self",
					userPointerKey: "entity:user",
				}),
			}),
		);
	});

	it("skips unresolved world-state replay when sweep reports no created/matched entities", async () => {
		const runSweep = jest
			.fn()
			.mockResolvedValue(makeEntityJudgeReport({ created: 0, matched: 0 }));
		const replayUnresolvedWorldStateOpsFn = jest
			.fn()
			.mockResolvedValue({ replayed: 1, stillPending: 0, deadLettered: 0 });

		const fixture = createFixture({
			sessionId: "session:replay-hook:none",
			claimedVersion: 8,
			withDurableJobStore: false,
			settlementBehavior: {
				[settlementIdFor(8)]: { sketch: "single-sketch-v8" },
			},
			agentOutcome: makeSuccessOutcome(),
			entityJudgeSweeper: {
				runSweep,
			} as unknown as ThinkerWorkerDeps["entityJudgeSweeper"],
			entityJudgeBatchIntervalMs: 1,
			replayUnresolvedWorldStateOpsFn,
		});

		await fixture.worker({ payload: fixture.payload });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(runSweep).toHaveBeenCalledTimes(1);
		expect(replayUnresolvedWorldStateOpsFn).not.toHaveBeenCalled();
	});

	it("skips unresolved world-state replay entirely when MAIDSCLAW_WORLDSTATE_OPS_ENABLED is 0", async () => {
		const previousFlag = process.env.MAIDSCLAW_WORLDSTATE_OPS_ENABLED;
		process.env.MAIDSCLAW_WORLDSTATE_OPS_ENABLED = "0";
		try {
			const runSweep = jest
				.fn()
				.mockResolvedValue(makeEntityJudgeReport({ created: 1, matched: 0 }));
			const replayUnresolvedWorldStateOpsFn = jest
				.fn()
				.mockResolvedValue({ replayed: 1, stillPending: 0, deadLettered: 0 });

			const fixture = createFixture({
				sessionId: "session:replay-hook:disabled",
				claimedVersion: 9,
				withDurableJobStore: false,
				settlementBehavior: {
					[settlementIdFor(9)]: { sketch: "single-sketch-v9" },
				},
				agentOutcome: makeSuccessOutcome(),
				entityJudgeSweeper: {
					runSweep,
				} as unknown as ThinkerWorkerDeps["entityJudgeSweeper"],
				entityJudgeBatchIntervalMs: 1,
				replayUnresolvedWorldStateOpsFn,
			});

			await fixture.worker({ payload: fixture.payload });
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(runSweep).toHaveBeenCalledTimes(1);
			expect(replayUnresolvedWorldStateOpsFn).not.toHaveBeenCalled();
		} finally {
			if (previousFlag === undefined) {
				delete process.env.MAIDSCLAW_WORLDSTATE_OPS_ENABLED;
			} else {
				process.env.MAIDSCLAW_WORLDSTATE_OPS_ENABLED = previousFlag;
			}
		}
	});

	it("treats replay failure as non-fatal after successful entity sweep", async () => {
		const warnSpy = jest
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const runSweep = jest
			.fn()
			.mockResolvedValue(makeEntityJudgeReport({ created: 0, matched: 1 }));
		const replayUnresolvedWorldStateOpsFn = jest
			.fn()
			.mockRejectedValue(new Error("replay boom"));

		const fixture = createFixture({
			sessionId: "session:replay-hook:nonfatal",
			claimedVersion: 12,
			withDurableJobStore: false,
			settlementBehavior: {
				[settlementIdFor(12)]: { sketch: "single-sketch-v12" },
			},
			agentOutcome: makeSuccessOutcome(),
			entityJudgeSweeper: {
				runSweep,
			} as unknown as ThinkerWorkerDeps["entityJudgeSweeper"],
			entityJudgeBatchIntervalMs: 1,
			replayUnresolvedWorldStateOpsFn,
		});

		await fixture.worker({ payload: fixture.payload });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fixture.settlementLedger.markApplied).toHaveBeenCalledWith(
			settlementIdFor(12),
		);
		expect(replayUnresolvedWorldStateOpsFn).toHaveBeenCalledTimes(1);
		expect(
			warnSpy.mock.calls.some((call) =>
				call.some(
					(part) =>
						typeof part === "string" &&
						part.includes("world-state unresolved replay failed"),
				),
			),
		).toBe(true);
	});
});
