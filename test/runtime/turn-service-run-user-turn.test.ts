import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { executeUserTurn } from "../../src/app/turn/user-turn-service.js";
import { MaidsClawError } from "../../src/core/errors.js";
import type { AgentRunRequest } from "../../src/core/agent-loop.js";
import type { Chunk } from "../../src/core/chunk.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import { FlushSelector } from "../../src/interaction/flush-selector.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { TurnService } from "../../src/runtime/turn-service.js";
import { SessionService } from "../../src/session/service.js";
import { closeDatabaseGracefully, type Db, openDatabase } from "../../src/storage/database.js";

type TurnServiceLoop = {
  run(request: AgentRunRequest): AsyncIterable<Chunk>;
};

function makeStreamingLoop(chunks: Chunk[], capture: { request?: AgentRunRequest }): TurnServiceLoop {
  return {
    async *run(request: AgentRunRequest): AsyncGenerator<Chunk> {
      capture.request = request;
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

async function collectChunks(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("run user turn wrapper", () => {
  let db: Db;
  let store: InteractionStore;
  let commitService: CommitService;
  let flushSelector: FlushSelector;
  let sessionService: SessionService;
  let graphStorage: GraphStorageService;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    runInteractionMigrations(db);
    runMemoryMigrations(db);
    store = new InteractionStore(db);
    commitService = new CommitService(store);
    flushSelector = new FlushSelector(store);
    sessionService = new SessionService();
    graphStorage = new GraphStorageService(db);
  });

  afterEach(() => {
    closeDatabaseGracefully(db);
  });

  it("throws SESSION_CLOSED for closed sessions", async () => {
    const session = await sessionService.createSession("maid:main");
    await sessionService.closeSession(session.sessionId);
    const capture: { request?: AgentRunRequest } = {};
    const turnService = new TurnService(
      makeStreamingLoop([], capture),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      undefined,
      undefined,
      graphStorage,
    );

    try {
      await executeUserTurn({
        sessionId: session.sessionId,
        userText: "hello",
        agentId: "maid:main",
      }, {
          sessionService,
          turnService,
        });
      throw new Error("expected SESSION_CLOSED");
    } catch (error) {
      expect(error instanceof MaidsClawError).toBe(true);
      expect((error as MaidsClawError).code).toBe("SESSION_CLOSED");
    }
  });

  it("throws recovery-required error when session needs recovery", async () => {
    const session = await sessionService.createSession("maid:main");
    await sessionService.markRecoveryRequired(session.sessionId);
    const capture: { request?: AgentRunRequest } = {};
    const turnService = new TurnService(
      makeStreamingLoop([], capture),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      undefined,
      undefined,
      graphStorage,
    );

    try {
      await executeUserTurn({
        sessionId: session.sessionId,
        userText: "hello",
        agentId: "maid:main",
      }, {
          sessionService,
          turnService,
        });
      throw new Error("expected recovery-required error");
    } catch (error) {
      expect(error instanceof MaidsClawError).toBe(true);
      expect((error as MaidsClawError).code).toBe("INVALID_ACTION");
      expect((error as MaidsClawError).message.includes("requires recovery")).toBe(true);
    }
  });

  it("throws AGENT_OWNERSHIP_MISMATCH when requested agent differs from owner", async () => {
    const session = await sessionService.createSession("maid:owner");
    const capture: { request?: AgentRunRequest } = {};
    const turnService = new TurnService(
      makeStreamingLoop([], capture),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      undefined,
      undefined,
      graphStorage,
    );

    try {
      await executeUserTurn({
        sessionId: session.sessionId,
        userText: "hello",
        agentId: "maid:other",
      }, {
          sessionService,
          turnService,
        });
      throw new Error("expected ownership mismatch");
    } catch (error) {
      expect(error instanceof MaidsClawError).toBe(true);
      expect((error as MaidsClawError).code).toBe("AGENT_OWNERSHIP_MISMATCH");
    }
  });

  it("streams via runUserTurn, commits user record once, and finalizes trace once", async () => {
    const session = await sessionService.createSession("maid:violet");
    commitService.commit({
      sessionId: session.sessionId,
      actorType: "user",
      recordType: "message",
      payload: { role: "user", content: "older user message" },
      correlatedTurnId: "req-older",
    });
    commitService.commit({
      sessionId: session.sessionId,
      actorType: "maiden",
      recordType: "message",
      payload: { role: "assistant", content: "older assistant message" },
      correlatedTurnId: "req-older",
    });

    const capture: { request?: AgentRunRequest } = {};
    const traceProbe = {
      initCount: 0,
      finalizeCount: 0,
      initTrace: () => {
        traceProbe.initCount += 1;
      },
      addChunk: () => {
      },
      addLogEntry: () => {
      },
      addFlushResult: () => {
      },
      finalizeTrace: () => {
        traceProbe.finalizeCount += 1;
      },
    };

    const turnService = new TurnService(
      makeStreamingLoop(
        [
          { type: "text_delta", text: "Hi" },
          { type: "message_end", stopReason: "end_turn" },
        ],
        capture,
      ),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      undefined,
      undefined,
      graphStorage,
      traceProbe as never,
    );

    const stream = await executeUserTurn({
      sessionId: session.sessionId,
      userText: "latest user message",
      requestId: "req-new",
      agentId: "maid:violet",
    }, {
      sessionService,
      turnService,
    });
    const chunks = await collectChunks(stream);

    expect(chunks).toEqual([
      { type: "text_delta", text: "Hi" },
      { type: "message_end", stopReason: "end_turn" },
    ]);
    expect(capture.request?.messages).toEqual([
      { role: "user", content: "older user message" },
      { role: "assistant", content: "older assistant message" },
      { role: "user", content: "latest user message" },
    ]);

    const records = store.getBySession(session.sessionId);
    expect(
      records.filter(
        (record) =>
          record.recordType === "message"
          && record.actorType === "user"
          && record.correlatedTurnId === "req-new",
      ),
    ).toHaveLength(1);
    expect(
      records.filter(
        (record) =>
          record.recordType === "message"
          && record.actorType === "maiden"
          && record.correlatedTurnId === "req-new",
      ),
    ).toHaveLength(1);
    expect(
      records.filter(
        (record) =>
          record.recordType === "turn_settlement"
          && record.correlatedTurnId === "req-new",
      ),
    ).toHaveLength(0);
    expect(traceProbe.initCount).toBe(1);
    expect(traceProbe.finalizeCount).toBe(1);
  });
});
