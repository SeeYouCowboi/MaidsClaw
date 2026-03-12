import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentLoop, AgentRunRequest } from "../../src/core/agent-loop.js";
import type { Chunk } from "../../src/core/chunk.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import { FlushSelector } from "../../src/interaction/flush-selector.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import type {
	MemoryFlushRequest,
	MemoryTaskAgent,
} from "../../src/memory/task-agent.js";
import { TurnService } from "../../src/runtime/turn-service.js";
import { SessionService } from "../../src/session/service.js";
import {
	closeDatabaseGracefully,
	type Db,
	openDatabase,
} from "../../src/storage/database.js";

function makeAgentLoop(chunks: Chunk[]): {
	run: (request: AgentRunRequest) => AsyncGenerator<Chunk>;
} {
	return {
		async *run(_request: AgentRunRequest): AsyncGenerator<Chunk> {
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	};
}

function makeThrowingAgentLoop(error: unknown): {
	run: (request: AgentRunRequest) => AsyncGenerator<Chunk>;
} {
	return {
		async *run(_request: AgentRunRequest): AsyncGenerator<Chunk> {
			for (const chunk of [] as Chunk[]) {
				yield chunk;
			}
			throw error;
		},
	};
}

function makeMemoryTaskAgent(
	runMigrate: (request: MemoryFlushRequest) => Promise<unknown>,
): MemoryTaskAgent {
	return {
		runMigrate,
	} as unknown as MemoryTaskAgent;
}

async function collectChunks(stream: AsyncGenerator<Chunk>): Promise<Chunk[]> {
	const chunks: Chunk[] = [];
	for await (const chunk of stream) {
		chunks.push(chunk);
	}
	return chunks;
}

describe("TurnService", () => {
	let db: Db;
	let store: InteractionStore;
	let commitService: CommitService;
	let flushSelector: FlushSelector;
	let sessionService: SessionService;

	beforeEach(() => {
		db = openDatabase({ path: ":memory:" });
		runInteractionMigrations(db);
		store = new InteractionStore(db);
		commitService = new CommitService(store);
		flushSelector = new FlushSelector(store);
		sessionService = new SessionService();
	});

	it("success settlement commits canonical assistant message", async () => {
		const session = sessionService.createSession("rp:alice");
		const chunks: Chunk[] = [
			{ type: "text_delta", text: "Hello" },
			{ type: "text_delta", text: " there" },
			{ type: "message_end", stopReason: "end_turn" },
		];

		const turnService = new TurnService(
			makeAgentLoop(chunks) as unknown as AgentLoop,
			commitService,
			store,
			flushSelector,
			null,
			sessionService,
		);

		try {
			const runChunks = await collectChunks(
				turnService.run({
					sessionId: session.sessionId,
					requestId: "req-1",
					messages: [{ role: "user", content: "Good evening" }],
				}),
			);

			expect(runChunks).toEqual(chunks);
			const records = store.getBySession(session.sessionId);
			expect(records).toHaveLength(2);
			expect(records[0]?.actorType).toBe("user");
			expect(records[0]?.recordType).toBe("message");
			expect(records[0]?.correlatedTurnId).toBe("req-1");
			expect(records[0]?.payload).toEqual({
				role: "user",
				content: "Good evening",
			});
			expect(records[1]?.actorType).toBe("rp_agent");
			expect(records[1]?.recordType).toBe("message");
			expect(records[1]?.correlatedTurnId).toBe("req-1");
			expect(records[1]?.payload).toEqual({
				role: "assistant",
				content: "Hello there",
			});
			expect(sessionService.isRecoveryRequired(session.sessionId)).toBe(false);
		} finally {
			closeDatabaseGracefully(db);
		}
	});

	it("success with no assistant text does not commit empty assistant message", async () => {
		const session = sessionService.createSession("rp:alice");
		const chunks: Chunk[] = [
			{ type: "message_end", stopReason: "end_turn" },
		];

		const turnService = new TurnService(
			makeAgentLoop(chunks) as unknown as AgentLoop,
			commitService,
			store,
			flushSelector,
			null,
			sessionService,
		);

		try {
			const runChunks = await collectChunks(
				turnService.run({
					sessionId: session.sessionId,
					requestId: "req-empty",
					messages: [{ role: "user", content: "hello" }],
				}),
			);

			expect(runChunks).toEqual(chunks);
			const records = store.getBySession(session.sessionId);
			expect(records).toHaveLength(1);
			expect(records[0]?.actorType).toBe("user");
			expect(records[0]?.recordType).toBe("message");
			expect(sessionService.isRecoveryRequired(session.sessionId)).toBe(false);
		} finally {
			closeDatabaseGracefully(db);
		}
	});

	it("failed_no_output settlement commits status record, not assistant message", async () => {
		const session = sessionService.createSession("rp:alice");
		const chunks: Chunk[] = [
			{
				type: "error",
				code: "MODEL_ERROR",
				message: "model failed",
				retriable: true,
			},
		];

		const turnService = new TurnService(
			makeAgentLoop(chunks) as unknown as AgentLoop,
			commitService,
			store,
			flushSelector,
			null,
			sessionService,
		);

		try {
			const runChunks = await collectChunks(
				turnService.run({
					sessionId: session.sessionId,
					requestId: "req-fail-1",
					messages: [{ role: "user", content: "hello" }],
				}),
			);

			expect(runChunks).toEqual(chunks);
			const records = store.getBySession(session.sessionId);
			expect(records).toHaveLength(2);
			expect(records[0]?.recordType).toBe("message");
			expect(records[1]?.recordType).toBe("status");
			expect(records[1]?.actorType).toBe("system");
			expect(records[1]?.payload).toEqual({
				event: "turn_failure",
				details: {
					outcome: "failed_no_output",
					request_id: "req-fail-1",
					error_code: "MODEL_ERROR",
					error_message: "model failed",
					partial_text: "",
					assistant_visible_activity: false,
					committed_at: expect.any(Number),
				},
			});
			expect(sessionService.isRecoveryRequired(session.sessionId)).toBe(false);
			expect(
				store.getMinMaxUnprocessedIndex(session.sessionId),
			).toBeUndefined();
		} finally {
			closeDatabaseGracefully(db);
		}
	});

	it("failed_with_partial_output settlement commits status record and sets recovery_required", async () => {
		const session = sessionService.createSession("rp:alice");
		const chunks: Chunk[] = [
			{ type: "text_delta", text: "partial" },
			{
				type: "error",
				code: "STREAM_ABORTED",
				message: "stream aborted",
				retriable: false,
			},
		];

		const turnService = new TurnService(
			makeAgentLoop(chunks) as unknown as AgentLoop,
			commitService,
			store,
			flushSelector,
			null,
			sessionService,
		);

		try {
			const runChunks = await collectChunks(
				turnService.run({
					sessionId: session.sessionId,
					requestId: "req-fail-2",
					messages: [{ role: "user", content: "hello" }],
				}),
			);

			expect(runChunks).toEqual(chunks);
			const records = store.getBySession(session.sessionId);
			expect(records).toHaveLength(2);
			expect(records[0]?.recordType).toBe("message");
			expect(records[1]?.recordType).toBe("status");
			expect(records[1]?.payload).toEqual({
				event: "turn_failure",
				details: {
					outcome: "failed_with_partial_output",
					request_id: "req-fail-2",
					error_code: "STREAM_ABORTED",
					error_message: "stream aborted",
					partial_text: "partial",
					assistant_visible_activity: true,
					committed_at: expect.any(Number),
				},
			});
			expect(sessionService.isRecoveryRequired(session.sessionId)).toBe(true);
			expect(
				store.getMinMaxUnprocessedIndex(session.sessionId),
			).toBeUndefined();
		} finally {
			closeDatabaseGracefully(db);
		}
	});

	it("thrown exception from agent loop settles as failure and yields error chunk", async () => {
		const session = sessionService.createSession("rp:alice");

		const turnService = new TurnService(
			makeThrowingAgentLoop(new Error("loop exploded")) as unknown as AgentLoop,
			commitService,
			store,
			flushSelector,
			null,
			sessionService,
		);

		try {
			const runChunks = await collectChunks(
				turnService.run({
					sessionId: session.sessionId,
					requestId: "req-fail-3",
					messages: [{ role: "user", content: "hello" }],
				}),
			);

			// Must yield an error chunk so the gateway sees the failure
			expect(runChunks).toHaveLength(1);
			expect(runChunks[0]?.type).toBe("error");
			if (runChunks[0]?.type === "error") {
				expect(runChunks[0].code).toBe("AGENT_LOOP_EXCEPTION");
				expect(runChunks[0].message).toBe("loop exploded");
				expect(runChunks[0].retriable).toBe(false);
			}

			const records = store.getBySession(session.sessionId);
			expect(records).toHaveLength(2);
			expect(records[1]?.recordType).toBe("status");
			expect(records[1]?.payload).toEqual({
				event: "turn_failure",
				details: {
					outcome: "failed_no_output",
					request_id: "req-fail-3",
					error_code: "AGENT_LOOP_EXCEPTION",
					error_message: "loop exploded",
					partial_text: "",
					assistant_visible_activity: false,
					committed_at: expect.any(Number),
				},
			});
			expect(sessionService.isRecoveryRequired(session.sessionId)).toBe(false);
			expect(
				store.getMinMaxUnprocessedIndex(session.sessionId),
			).toBeUndefined();
		} finally {
			closeDatabaseGracefully(db);
		}
	});

	it("failed turn records are marked processed without affecting earlier unprocessed records", async () => {
		const session = sessionService.createSession("rp:alice");
		commitService.commit({
			sessionId: session.sessionId,
			actorType: "user",
			recordType: "message",
			payload: { role: "user", content: "older user" },
		});
		commitService.commit({
			sessionId: session.sessionId,
			actorType: "rp_agent",
			recordType: "message",
			payload: { role: "assistant", content: "older assistant" },
		});

		const turnService = new TurnService(
			makeAgentLoop([
				{ type: "tool_use_start", id: "tool-1", name: "search" },
				{
					type: "error",
					code: "TOOL_TIMEOUT",
					message: "tool timeout",
					retriable: true,
				},
			]) as unknown as AgentLoop,
			commitService,
			store,
			flushSelector,
			null,
			sessionService,
		);

		try {
			await collectChunks(
				turnService.run({
					sessionId: session.sessionId,
					requestId: "req-fail-4",
					messages: [{ role: "user", content: "new turn" }],
				}),
			);

			const rows = db.query<{ record_index: number; is_processed: number }>(
				"SELECT record_index, is_processed FROM interaction_records WHERE session_id = ? ORDER BY record_index ASC",
				[session.sessionId],
			);

			expect(rows).toEqual([
				{ record_index: 0, is_processed: 0 },
				{ record_index: 1, is_processed: 0 },
				{ record_index: 2, is_processed: 1 },
				{ record_index: 3, is_processed: 1 },
			]);
		} finally {
			closeDatabaseGracefully(db);
		}
	});

	it("enriches and flushes when threshold is reached, then marks range processed on success", async () => {
		const session = sessionService.createSession("rp:alice");
		for (let i = 0; i < 8; i += 1) {
			commitService.commit({
				sessionId: session.sessionId,
				actorType: "user",
				recordType: "message",
				payload: { role: "user", content: `seed ${i}` },
			});
		}

		const migrateCalls: MemoryFlushRequest[] = [];
		const memoryTaskAgent = makeMemoryTaskAgent(async (request) => {
			migrateCalls.push(request);
			return {
				batch_id: request.idempotencyKey,
				private_event_ids: [],
				private_belief_ids: [],
				entity_ids: [],
				fact_ids: [],
			};
		});

		const turnService = new TurnService(
			makeAgentLoop([
				{ type: "text_delta", text: "assistant line" },
				{ type: "message_end", stopReason: "end_turn" },
			]) as unknown as AgentLoop,
			commitService,
			store,
			flushSelector,
			memoryTaskAgent,
			sessionService,
		);

		try {
			await collectChunks(
				turnService.run({
					sessionId: session.sessionId,
					requestId: "req-2",
					messages: [{ role: "user", content: "trigger flush" }],
				}),
			);

			expect(migrateCalls).toHaveLength(1);
			expect(migrateCalls[0]?.queueOwnerAgentId).toBe("rp:alice");
			expect(migrateCalls[0]?.dialogueRecords).toHaveLength(10);
			expect(migrateCalls[0]?.rangeStart).toBe(0);
			expect(migrateCalls[0]?.rangeEnd).toBe(9);
			expect(
				store.getMinMaxUnprocessedIndex(session.sessionId),
			).toBeUndefined();
		} finally {
			closeDatabaseGracefully(db);
		}
	});

	it("does not mark processed range when migrate fails", async () => {
		const session = sessionService.createSession("rp:alice");
		for (let i = 0; i < 8; i += 1) {
			commitService.commit({
				sessionId: session.sessionId,
				actorType: "user",
				recordType: "message",
				payload: { role: "user", content: `seed ${i}` },
			});
		}

		const migrateCalls: MemoryFlushRequest[] = [];
		const memoryTaskAgent = makeMemoryTaskAgent(async (request) => {
			migrateCalls.push(request);
			throw new Error("migrate failed");
		});

		const turnService = new TurnService(
			makeAgentLoop([
				{ type: "text_delta", text: "assistant line" },
				{ type: "message_end", stopReason: "end_turn" },
			]) as unknown as AgentLoop,
			commitService,
			store,
			flushSelector,
			memoryTaskAgent,
			sessionService,
		);

		try {
			await collectChunks(
				turnService.run({
					sessionId: session.sessionId,
					requestId: "req-3",
					messages: [{ role: "user", content: "trigger flush" }],
				}),
			);

			expect(migrateCalls).toHaveLength(1);
			const range = store.getMinMaxUnprocessedIndex(session.sessionId);
			expect(range).toBeDefined();
			expect(range?.min).toBe(0);
			expect(range?.max).toBe(9);
		} finally {
			closeDatabaseGracefully(db);
		}
	});

	it("flushOnSessionClose is best effort and still attempts migrate", async () => {
		const session = sessionService.createSession("rp:alice");
		commitService.commit({
			sessionId: session.sessionId,
			actorType: "user",
			recordType: "message",
			payload: { role: "user", content: "first" },
		});
		commitService.commit({
			sessionId: session.sessionId,
			actorType: "rp_agent",
			recordType: "message",
			payload: { role: "assistant", content: "second" },
		});

		const migrateCalls: MemoryFlushRequest[] = [];
		const memoryTaskAgent = makeMemoryTaskAgent(async (request) => {
			migrateCalls.push(request);
			throw new Error("session close failure");
		});

		const turnService = new TurnService(
			makeAgentLoop([]) as unknown as AgentLoop,
			commitService,
			store,
			flushSelector,
			memoryTaskAgent,
			sessionService,
		);

		try {
			await turnService.flushOnSessionClose(session.sessionId, "rp:alice");
			expect(migrateCalls).toHaveLength(1);
			expect(migrateCalls[0]?.flushMode).toBe("session_close");
			expect(migrateCalls[0]?.queueOwnerAgentId).toBe("rp:alice");
			expect(migrateCalls[0]?.dialogueRecords).toHaveLength(2);
			expect(store.getMinMaxUnprocessedIndex(session.sessionId)).toBeDefined();
		} finally {
			closeDatabaseGracefully(db);
		}
	});
});
