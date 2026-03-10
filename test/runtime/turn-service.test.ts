import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentLoop, AgentRunRequest } from "../../src/core/agent-loop.js";
import type { Chunk } from "../../src/core/chunk.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import { FlushSelector } from "../../src/interaction/flush-selector.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import type { MemoryFlushRequest, MemoryTaskAgent } from "../../src/memory/task-agent.js";
import { TurnService } from "../../src/runtime/turn-service.js";
import { SessionService } from "../../src/session/service.js";
import { closeDatabaseGracefully, openDatabase } from "../../src/storage/database.js";
import type { Db } from "../../src/storage/database.js";

function makeAgentLoop(chunks: Chunk[]): { run: (request: AgentRunRequest) => AsyncGenerator<Chunk> } {
  return {
    async *run(_request: AgentRunRequest): AsyncGenerator<Chunk> {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function makeMemoryTaskAgent(runMigrate: (request: MemoryFlushRequest) => Promise<unknown>): MemoryTaskAgent {
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

  it("commits user and assistant records around loop streaming", async () => {
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
      expect(records[0]?.payload).toEqual({ role: "user", content: "Good evening" });
      expect(records[1]?.actorType).toBe("rp_agent");
      expect(records[1]?.recordType).toBe("message");
      expect(records[1]?.correlatedTurnId).toBe("req-1");
      expect(records[1]?.payload).toEqual({ role: "assistant", content: "Hello there" });
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
      return { batch_id: request.idempotencyKey, private_event_ids: [], private_belief_ids: [], entity_ids: [], fact_ids: [] };
    });

    const turnService = new TurnService(
      makeAgentLoop([{ type: "text_delta", text: "assistant line" }, { type: "message_end", stopReason: "end_turn" }]) as unknown as AgentLoop,
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
      expect(store.getMinMaxUnprocessedIndex(session.sessionId)).toBeUndefined();
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
      makeAgentLoop([{ type: "text_delta", text: "assistant line" }, { type: "message_end", stopReason: "end_turn" }]) as unknown as AgentLoop,
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
