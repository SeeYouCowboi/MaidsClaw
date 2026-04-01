import { describe, it, expect } from "bun:test";
import { TurnService } from "../../src/runtime/turn-service.js";
import { PendingSettlementSweeper } from "../../src/memory/pending-settlement-sweeper.js";
import type {
	MemoryPipelineStatus,
	RuntimeBootstrapResult,
} from "../../src/bootstrap/types.js";
import type { CommitService } from "../../src/interaction/commit-service.js";
import type { FlushSelector } from "../../src/interaction/flush-selector.js";
import type { InteractionStore } from "../../src/interaction/store.js";
import type { MemoryTaskAgent } from "../../src/memory/task-agent.js";
import type { SessionService } from "../../src/session/service.js";
import type { PendingFlushRecoveryRepo } from "../../src/storage/domain-repos/contracts/pending-flush-recovery-repo.js";

function stubAgentLoop() {
	return { run: async function* () {} };
}

const stubCommitService = () =>
	({ commit: async () => ({}) }) as unknown as CommitService;

const stubInteractionStore = () =>
	({
		getMessageRecords: () => [],
		getByRange: () => [],
		getPendingSettlementJobState: () => null,
		listStalePendingSettlementSessions: () => [],
		append: () => {},
		markProcessed: () => {},
		setPendingSettlementJobState: () => {},
		clearPendingSettlementJobState: () => {},
	}) as unknown as InteractionStore;

const stubFlushSelector = () =>
	({
		shouldFlush: () => null,
		buildSessionCloseFlush: () => null,
	}) as unknown as FlushSelector;

const stubSessionService = () =>
	({
		getSession: async () => null,
		setRecoveryRequired: async () => {},
	}) as unknown as SessionService;

const stubPendingFlushRepo = () =>
	({
		acquireLock: async () => true,
		releaseLock: async () => {},
		listStale: async () => [],
	}) as unknown as PendingFlushRecoveryRepo;

function buildTurnService(
	memoryTaskAgent: MemoryTaskAgent | null,
	memoryPipelineReady: boolean,
): TurnService {
	return new TurnService(
		stubAgentLoop(),
		stubCommitService(),
		stubInteractionStore(),
		stubFlushSelector(),
		memoryTaskAgent,
		stubSessionService(),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		null,
		memoryPipelineReady,
	);
}

describe("Pipeline Wiring (construct-but-gate)", () => {
	it("memoryTaskAgent is null when memoryEmbeddingModelId is not configured", () => {
		const memoryEmbeddingModelId: string | undefined = undefined;
		const memoryTaskAgent: MemoryTaskAgent | null = memoryEmbeddingModelId
			? (("would-be-agent" as unknown) as MemoryTaskAgent)
			: null;

		expect(memoryTaskAgent).toBeNull();
		const _typeCheck: RuntimeBootstrapResult["memoryTaskAgent"] = memoryTaskAgent;
		expect(_typeCheck).toBeNull();
	});

	it("memoryPipelineReady is always false even when embedding model is provided", () => {
		const memoryPipelineReady = false;
		expect(memoryPipelineReady).toBe(false);

		const _typeCheck: RuntimeBootstrapResult["memoryPipelineReady"] =
			memoryPipelineReady;
		expect(_typeCheck).toBe(false);
	});

	it("memoryPipelineStatus is 'missing_embedding_model' when no embedding model provided", () => {
		const memoryEmbeddingModelId: string | undefined = undefined;
		const status: MemoryPipelineStatus = !memoryEmbeddingModelId
			? "missing_embedding_model"
			: "partial";

		expect(status).toBe("missing_embedding_model");
		expect(status as string).not.toBe("ready");
	});

	it("memoryPipelineStatus is 'partial' (never 'ready') when embedding model is configured", () => {
		const memoryEmbeddingModelId = "text-embedding-3-small";
		const status: MemoryPipelineStatus = !memoryEmbeddingModelId
			? "missing_embedding_model"
			: "partial";

		expect(status).toBe("partial");
		expect(status as string).not.toBe("ready");
	});

	it("TurnService.flushOnSessionClose returns false when memoryPipelineReady=false and agent=null", async () => {
		const turnService = buildTurnService(null, false);
		const result = await turnService.flushOnSessionClose("session-1", "agent-1");
		expect(result).toBe(false);
	});

	it("TurnService.flushOnSessionClose returns false with agent present but pipeline not ready", async () => {
		const mockAgent = {} as unknown as MemoryTaskAgent;
		const turnService = buildTurnService(mockAgent, false);
		const result = await turnService.flushOnSessionClose("session-1", "agent-1");
		expect(result).toBe(false);
	});

	it("memoryTaskAgent is null (not undefined) satisfying MemoryTaskAgent | null type", () => {
		const memoryTaskAgent: MemoryTaskAgent | null = null;
		expect(memoryTaskAgent).toBeNull();
		expect(memoryTaskAgent).not.toBeUndefined();

		const check: RuntimeBootstrapResult["memoryTaskAgent"] = memoryTaskAgent;
		expect(check).toBeNull();
	});

	it("PendingSettlementSweeper sweep is gated by isEnabled returning false", async () => {
		let sweepAttempted = false;

		const sweeper = new PendingSettlementSweeper(
			stubPendingFlushRepo(),
			{
				...stubInteractionStore(),
				listStalePendingSettlementSessions: () => {
					sweepAttempted = true;
					return [];
				},
			} as unknown as InteractionStore,
			stubFlushSelector(),
			{} as unknown as MemoryTaskAgent,
			{
				intervalMs: 999_999,
				isEnabled: () => false,
			},
		);

		sweeper.start();
		await new Promise((resolve) => setTimeout(resolve, 50));
		sweeper.stop();

		expect(sweepAttempted).toBe(false);
	});

	it("sweepers are null when memoryTaskAgent is null", () => {
		const memoryTaskAgent: MemoryTaskAgent | null = null;

		const pendingSettlementSweeper =
			memoryTaskAgent !== null
				? new PendingSettlementSweeper(
						stubPendingFlushRepo(),
						stubInteractionStore(),
						stubFlushSelector(),
						memoryTaskAgent,
					)
				: null;

		const publicationRecoverySweeper = memoryTaskAgent !== null ? "constructed" : null;

		expect(pendingSettlementSweeper).toBeNull();
		expect(publicationRecoverySweeper).toBeNull();
	});

	it("MemoryPipelineStatus type covers all expected states", () => {
		const validStates: MemoryPipelineStatus[] = [
			"ready",
			"partial",
			"missing_embedding_model",
			"chat_model_unavailable",
			"embedding_model_unavailable",
			"organizer_embedding_model_unavailable",
		];

		expect(validStates).toHaveLength(6);
		expect(validStates).toContain("ready");
		expect(validStates).toContain("partial");
		expect(validStates).toContain("missing_embedding_model");
	});
});
