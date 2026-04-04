import { afterEach, describe, expect, it, jest } from "bun:test";
import type postgres from "postgres";
import type { AgentProfile } from "../../src/agents/profile.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import type { AgentLoop, AgentRunRequest } from "../../src/core/agent-loop.js";
import type { TurnSettlementPayload } from "../../src/interaction/contracts.js";
import type {
	CognitionThinkerJobPayload,
	DurableJobStore,
	PgJobCurrentRow,
} from "../../src/jobs/durable-store.js";
import type { ProjectionManager } from "../../src/memory/projection/projection-manager.js";
import {
	createThinkerWorker,
	type ThinkerWorkerDeps,
} from "../../src/runtime/thinker-worker.js";
import type {
	InteractionRepo,
	InteractionTransactionContext,
} from "../../src/storage/domain-repos/contracts/interaction-repo.js";
import type { RecentCognitionSlotRepo } from "../../src/storage/domain-repos/contracts/recent-cognition-slot-repo.js";

const AGENT_ID = "rp:alice";
const SESSION_ID = "session:batch";
const FAIL_AFTER_PROMPT = "STOP_AFTER_PROMPT_CAPTURE";

type SettlementBehavior = {
	[settlementId: string]: string | Error | undefined;
};

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
			currentLocationEntityId: 42,
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
			if (typeof behavior !== "string") {
				return undefined;
			}
			return makeSettlementPayload(sessionId, settlementId, behavior);
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
}) {
	const settlementCalls: string[] = [];
	let capturedRequest: AgentRunRequest | undefined;
	const runBuffered = jest.fn(async (request: AgentRunRequest) => {
		capturedRequest = request;
		return { error: FAIL_AFTER_PROMPT };
	});

	const listPendingByKindAndPayload = jest.fn(async () => {
		return (params.pendingPayloads ?? []).map(makePendingRow);
	});

	const durableJobStore =
		params.withDurableJobStore === false
			? undefined
			: ({
					listPendingByKindAndPayload,
				} as unknown as DurableJobStore);

	const payload: CognitionThinkerJobPayload = {
		sessionId: SESSION_ID,
		agentId: AGENT_ID,
		settlementId: settlementIdFor(params.claimedVersion),
		talkerTurnVersion: params.claimedVersion,
	};

	const interactionRepo = createInteractionRepo({
		sessionId: SESSION_ID,
		settlementBehavior: params.settlementBehavior,
		settlementCalls,
	});

	const deps: ThinkerWorkerDeps = {
		sql: {
			begin: async () => {
				throw new Error("sql.begin should not execute in prompt tests");
			},
		} as unknown as postgres.Sql,
		projectionManager: {} as ProjectionManager,
		interactionRepo,
		recentCognitionSlotRepo: createSlotRepo(),
		agentRegistry: createRegistry(),
		createAgentLoop: () => ({ runBuffered }) as unknown as AgentLoop,
		durableJobStore,
	};

	return {
		worker: createThinkerWorker(deps),
		payload,
		runBuffered,
		listPendingByKindAndPayload,
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
});
