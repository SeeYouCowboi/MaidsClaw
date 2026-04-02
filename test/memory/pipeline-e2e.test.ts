import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import {
	bootstrapRuntime,
	initializePgBackendForRuntime,
} from "../../src/bootstrap/runtime.js";
import type { RuntimeBootstrapResult } from "../../src/bootstrap/types.js";
import type { ChatModelProvider } from "../../src/core/models/chat-provider.js";
import type { EmbeddingProvider } from "../../src/core/models/embedding-provider.js";
import { DefaultModelServiceRegistry } from "../../src/core/models/registry.js";
import type { MemoryFlushRequest } from "../../src/core/types.js";
import type { CommitService } from "../../src/interaction/commit-service.js";
import type { InteractionRecord } from "../../src/interaction/contracts.js";
import type { FlushSelector } from "../../src/interaction/flush-selector.js";
import type { InteractionStore } from "../../src/interaction/store.js";
import { PendingSettlementSweeper } from "../../src/memory/pending-settlement-sweeper.js";
import type { MemoryTaskAgent } from "../../src/memory/task-agent.js";
import type { MigrationResult } from "../../src/memory/types.js";
import { TurnService } from "../../src/runtime/turn-service.js";
import type {
	SessionRecord,
	SessionService,
} from "../../src/session/service.js";
import * as pgAppTestUtils from "../helpers/pg-app-test-utils.js";

const describeWithSkip = describe as typeof describe & {
	skipIf(condition: boolean): typeof describe;
};

const { skipPgTests: skipPgTestsFromPgApp } = pgAppTestUtils as {
	skipPgTests?: boolean;
};
const skipPgTests =
	skipPgTestsFromPgApp ?? typeof process.env.PG_APP_TEST_URL === "undefined";

type PgTestDb = Awaited<ReturnType<typeof pgAppTestUtils.createPgTestDb>>;

const EMPTY_MIGRATION_RESULT: MigrationResult = {
	batch_id: "memory.migrate:test",
	episode_event_ids: [],
	assertion_ids: [],
	entity_ids: [],
	fact_ids: [],
};

type TurnServicePrivateApi = {
	flushIfDue(sessionId: string, requestId?: string): Promise<void>;
};

type FlushHarnessOptions = {
	memoryTaskAgent: MemoryTaskAgent | null;
	memoryPipelineReady: boolean;
	sessionId: string;
	queueOwnerAgentId?: string;
	flushRequest: MemoryFlushRequest | null;
	records?: InteractionRecord[];
	onShouldFlush?: () => void;
	onMarkProcessed?: () => void;
};

function createMockModelRegistry(): DefaultModelServiceRegistry {
	const chatProvider: ChatModelProvider = {
		chatCompletion() {
			return {
				[Symbol.asyncIterator]() {
					return {
						async next() {
							return {
								done: true as const,
								value: undefined,
							};
						},
					};
				},
			};
		},
	};
	const embeddingProvider: EmbeddingProvider = {
		async embed(texts: string[]) {
			return texts.map(() => new Float32Array(8));
		},
	};

	return new DefaultModelServiceRegistry({
		chatExact: new Map([["test/chat", chatProvider]]),
		embeddingExact: new Map([["test/embed", embeddingProvider]]),
	});
}

function createTurnServiceFlushHarness(
	options: FlushHarnessOptions,
): TurnService {
	const agentLoop = {
		run() {
			return {
				[Symbol.asyncIterator]() {
					return {
						async next() {
							return {
								done: true as const,
								value: undefined,
							};
						},
					};
				},
			};
		},
	};

	const commitService = {
		commit() {
			throw new Error("commit should not be called in flush harness");
		},
	} as unknown as CommitService;

	const interactionStore = {
		getByRange() {
			return options.records ?? [];
		},
		markProcessed() {
			options.onMarkProcessed?.();
		},
		getPendingSettlementJobState() {
			return null;
		},
	} as unknown as InteractionStore;

	const flushSelector = {
		shouldFlush() {
			options.onShouldFlush?.();
			return options.flushRequest;
		},
		buildSessionCloseFlush() {
			return null;
		},
	} as unknown as FlushSelector;

	const sessionRecord: SessionRecord | undefined = options.queueOwnerAgentId
		? {
				sessionId: options.sessionId,
				createdAt: Date.now(),
				agentId: options.queueOwnerAgentId,
			}
		: undefined;

	const sessionService = {
		async getSession() {
			return sessionRecord;
		},
		async setRecoveryRequired() {
			return;
		},
	} as unknown as SessionService;

	return new TurnService(
		agentLoop,
		commitService,
		interactionStore,
		flushSelector,
		options.memoryTaskAgent,
		sessionService,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		null,
		options.memoryPipelineReady,
	);
}

async function invokeFlushIfDue(
	turnService: TurnService,
	sessionId: string,
	requestId?: string,
): Promise<void> {
	await (turnService as unknown as TurnServicePrivateApi).flushIfDue(
		sessionId,
		requestId,
	);
}

describeWithSkip.skipIf(skipPgTests)("memory pipeline e2e wiring (PG)", () => {
	let testDb: PgTestDb;
	let runtime: RuntimeBootstrapResult;
	let originalPgAppUrl: string | undefined;
	let sweeperStartSpy: ReturnType<typeof spyOn>;

	beforeAll(async () => {
		testDb = await pgAppTestUtils.createPgTestDb();
		originalPgAppUrl = process.env.PG_APP_URL;
		process.env.PG_APP_URL =
			process.env.PG_APP_TEST_URL ??
			"postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app_test";

		sweeperStartSpy = spyOn(
			PendingSettlementSweeper.prototype,
			"start",
		).mockImplementation(() => {});

		runtime = bootstrapRuntime({
			modelRegistry: createMockModelRegistry(),
			memoryMigrationModelId: "test/chat",
			memoryEmbeddingModelId: "test/embed",
		});

		await initializePgBackendForRuntime(runtime);
	});

	afterAll(async () => {
		runtime.shutdown();
		sweeperStartSpy.mockRestore();
		if (originalPgAppUrl === undefined) {
			delete process.env.PG_APP_URL;
		} else {
			process.env.PG_APP_URL = originalPgAppUrl;
		}
		await testDb.cleanup();
	});

	it("bootstraps with mock embedding model and constructs the memory pipeline wiring", () => {
		expect(runtime.memoryTaskAgent).not.toBeNull();
		expect(runtime.memoryPipelineStatus).toBe("ready");
		expect(runtime.memoryPipelineReady).toBe(true);
		expect(sweeperStartSpy.mock.calls.length).toBe(1);
	});

	it("flushIfDue proceeds past null-agent guard when memoryTaskAgent exists", async () => {
		if (runtime.memoryTaskAgent === null) {
			throw new Error("Expected memoryTaskAgent to be constructed");
		}

		const sessionId = "session:e2e";
		const queueOwnerAgentId = "rp:e2e";
		const flushRequest: MemoryFlushRequest = {
			sessionId,
			agentId: queueOwnerAgentId,
			rangeStart: 1,
			rangeEnd: 1,
			flushMode: "dialogue_slice",
			idempotencyKey: "memory.migrate:session:e2e:1-1",
		};

		const records: InteractionRecord[] = [
			{
				sessionId,
				recordId: "msg-1",
				recordIndex: 1,
				actorType: "user",
				recordType: "message",
				payload: { role: "user", content: "hello" },
				committedAt: Date.now(),
			},
		];

		let markProcessedCalled = false;
		const turnService = createTurnServiceFlushHarness({
			memoryTaskAgent: runtime.memoryTaskAgent,
			memoryPipelineReady: true,
			sessionId,
			queueOwnerAgentId,
			flushRequest,
			records,
			onMarkProcessed: () => {
				markProcessedCalled = true;
			},
		});

		const runMigrateSpy = spyOn(
			runtime.memoryTaskAgent,
			"runMigrate",
		).mockResolvedValue(EMPTY_MIGRATION_RESULT);

		await invokeFlushIfDue(turnService, sessionId, "req:e2e");

		expect(runMigrateSpy.mock.calls.length).toBe(1);
		expect(markProcessedCalled).toBe(true);
		runMigrateSpy.mockRestore();
	});
});

describeWithSkip.skipIf(false)(
	"memory pipeline degrade path (no embedding model)",
	() => {
		it("bootstrap without embedding model keeps memoryTaskAgent null and flushIfDue short-circuits gracefully", async () => {
			const runtime = bootstrapRuntime({
				modelRegistry: createMockModelRegistry(),
				memoryMigrationModelId: "test/chat",
			});

			expect(runtime.memoryTaskAgent).toBeNull();
			expect(runtime.memoryPipelineStatus).toBe("missing_embedding_model");

			const sessionId = "session:no-model";
			const flushRequest: MemoryFlushRequest = {
				sessionId,
				agentId: "rp:no-model",
				rangeStart: 1,
				rangeEnd: 1,
				flushMode: "dialogue_slice",
				idempotencyKey: "memory.migrate:session:no-model:1-1",
			};

			let shouldFlushCalled = false;
			const turnService = createTurnServiceFlushHarness({
				memoryTaskAgent: null,
				memoryPipelineReady: true,
				sessionId,
				queueOwnerAgentId: "rp:no-model",
				flushRequest,
				onShouldFlush: () => {
					shouldFlushCalled = true;
				},
			});

			await invokeFlushIfDue(turnService, sessionId, "req:no-model");
			expect(shouldFlushCalled).toBe(false);

			runtime.shutdown();
		});
	},
);
