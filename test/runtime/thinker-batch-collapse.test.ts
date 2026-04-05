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
import * as relationIntentResolverModule from "../../src/memory/cognition/relation-intent-resolver.js";
import * as organizeEnqueueModule from "../../src/memory/organize-enqueue.js";
import type { ProjectionManager } from "../../src/memory/projection/projection-manager.js";
import type { SettlementLedger } from "../../src/memory/settlement-ledger.js";
import {
	createThinkerWorker,
	type ThinkerWorkerDeps,
} from "../../src/runtime/thinker-worker.js";
import * as thinkerWorkerModule from "../../src/runtime/thinker-worker.js";
import type {
	InteractionRepo,
	InteractionTransactionContext,
} from "../../src/storage/domain-repos/contracts/interaction-repo.js";
import type { RecentCognitionSlotRepo } from "../../src/storage/domain-repos/contracts/recent-cognition-slot-repo.js";
import { PgCognitionProjectionRepo } from "../../src/storage/domain-repos/pg/cognition-projection-repo.js";
import { PgEpisodeRepo } from "../../src/storage/domain-repos/pg/episode-repo.js";
import { PgRecentCognitionSlotRepo } from "../../src/storage/domain-repos/pg/recent-cognition-slot-repo.js";

const AGENT_ID = "rp:alice";
const SESSION_ID = "session:batch";
const FAIL_AFTER_PROMPT = "STOP_AFTER_PROMPT_CAPTURE";

type SettlementBehavior = {
	[settlementId: string]: string | Error | { sketch: string; viewerLocation?: number } | undefined;
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
	relationIntents?: Array<{ sourceRef: string; targetRef: string; intent: "supports" | "triggered" }>;
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

function createFixture(params: {
	claimedVersion: number;
	settlementBehavior: SettlementBehavior;
	pendingPayloads?: CognitionThinkerJobPayload[];
	withDurableJobStore?: boolean;
	initialThinkerCommittedVersion?: number;
	agentOutcome?: ReturnType<typeof makeSuccessOutcome>;
	changedNodeRefs?: string[];
}) {
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
		sessionId: SESSION_ID,
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
				changedNodeRefs: (params.changedNodeRefs ?? ["assertion:1"]) as string[],
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
		sessionId: SESSION_ID,
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
		expect(prompt).toContain("[Turn 3] sketch-v3");
		expect(prompt).toContain("[Turn 4] sketch-v4");
		expect(prompt).toContain("[Turn 5] sketch-v5");
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
		const idx3 = prompt.indexOf("[Turn 3]");
		const idx4 = prompt.indexOf("[Turn 4]");
		const idx5 = prompt.indexOf("[Turn 5]");
		expect(idx3).toBeGreaterThanOrEqual(0);
		expect(idx4).toBeGreaterThan(idx3);
		expect(idx5).toBeGreaterThan(idx4);
	});

	it("soft cap keeps only newest 20 sketches and warns about excluded count", async () => {
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
		const turnMatches = prompt.match(/\[Turn \d+\]/g) ?? [];
		expect(turnMatches).toHaveLength(20);
		expect(prompt).not.toContain("[Turn 1]");
		expect(prompt).toContain("[Turn 25]");
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
		expect(prompt).not.toContain("[Turn 5]");
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

		expect(fixture.projectionManager.commitSettlement.mock.calls.length).toBe(1);
		const [projectionParams] = fixture.projectionManager.commitSettlement.mock.calls[0];
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

	it("markThinkerProjecting and markApplied target the effective settlement while intermediate settlements noop", async () => {
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

		expect(fixture.settlementLedger.markThinkerProjecting).toHaveBeenCalledWith(
			settlementIdFor(5),
			AGENT_ID,
		);
		expect(fixture.settlementLedger.markApplied).toHaveBeenCalledWith(
			settlementIdFor(5),
		);
		expect(fixture.settlementLedger.markReplayedNoop).toHaveBeenCalledWith(
			settlementIdFor(3),
		);
		expect(fixture.settlementLedger.markReplayedNoop).toHaveBeenCalledWith(
			settlementIdFor(4),
		);
	});

	it("routes post-commit reads, conflicts, and organizer jobs through effectiveSettlementId", async () => {
		const resolveConflictSpy = jest
			.spyOn(relationIntentResolverModule, "resolveConflictFactors")
			.mockResolvedValue({
				resolved: [{ kind: "contradicts", ref: "belief:old", nodeRef: "assertion:existing" }],
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
				[settlementIdFor(7)]: { sketch: "single-sketch-v7", viewerLocation: 77 },
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
			_kind,
			handler,
		) {
			registeredHandler = handler as typeof registeredHandler;
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
			enqueue: async () => ({ outcome: "created" as const, job_key: "job", status: "pending" as const, claim_version: 1 }),
			claimNext: async () => ({ outcome: "none_ready" as const }),
			heartbeat: async () => ({ outcome: "not_found" as const, job_key: "job", claim_version: 1 }),
			complete: async () => ({ outcome: "not_found" as const, job_key: "job", claim_version: 1 }),
			fail: async () => ({ outcome: "not_found" as const, job_key: "job", claim_version: 1 }),
			cancel: async () => ({ outcome: "not_found" as const, job_key: "job", claim_version: 1 }),
			reclaimExpiredLeases: async () => 0,
			inspect: async () => undefined,
			listActive: async () => [],
			listPendingByKindAndPayload: async () => [],
			listExpiredLeases: async () => [],
			countByStatus: async () => ({ pending: 0, running: 0, succeeded: 0, failed_terminal: 0, cancelled: 0 }),
			getHistory: async () => [],
		} as DurableJobStore;
		const runtime = {
			backendType: "pg",
			healthChecks: { bootstrap: "ok" },
			traceStore: undefined,
			sessionService: {} as RuntimeBootstrapResult["sessionService"],
			turnService: {} as RuntimeBootstrapResult["turnService"],
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

		expect(fixture.projectionManager.commitSettlement.mock.calls.length).toBe(0);
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
		expect(prompt).not.toContain("[Turn 5]");

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
		expect(
			fixture.settlementLedger.markThinkerProjecting,
		).toHaveBeenCalledWith(settlementIdFor(5), AGENT_ID);
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
		fixture.runBuffered.mockImplementation(
			async (request: AgentRunRequest) => {
				capturedRequests.push(request);
				if (capturedRequests.length === 1) {
					throw new Error("first fail");
				}
				return { outcome: makeSuccessOutcome() };
			},
		);

		await expect(fixture.worker({ payload: fixture.payload })).rejects.toThrow(
			"first fail",
		);

		await fixture.worker({ payload: fixture.payload });

		expect(capturedRequests.length).toBe(2);
		const secondPrompt = capturedRequests[1].messages
			.filter((m) => m.role === "user" && typeof m.content === "string")
			.map((m) => m.content)
			.join("\n");
		expect(secondPrompt).toContain("[Turn 3]");
		expect(secondPrompt).toContain("[Turn 5]");
		expect(secondPrompt).not.toContain("[Turn 4]");
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
		expect(fixture.projectionManager.commitSettlement.mock.calls.length).toBe(0);
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
		expect(prompt).toContain("[Turn 3] session-a-v3");
		expect(prompt).toContain("[Turn 4] session-a-v4");
		expect(prompt).toContain("[Turn 5] session-a-v5");
		expect(prompt).not.toContain("session-b");
		expect(prompt).not.toContain("[Turn 99]");
	});
});
