import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentRunRequest } from "../../src/core/agent-loop.js";
import type { Chunk } from "../../src/core/chunk.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import { FlushSelector } from "../../src/interaction/flush-selector.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import type { RpBufferedExecutionResult } from "../../src/runtime/rp-turn-contract.js";
import { TurnService } from "../../src/runtime/turn-service.js";
import { SessionService } from "../../src/session/service.js";
import { closeDatabaseGracefully, type Db, openDatabase } from "../../src/storage/database.js";

type TurnServiceLoop = {
  run(request: AgentRunRequest): AsyncIterable<Chunk>;
  runBuffered?: (request: AgentRunRequest) => Promise<RpBufferedExecutionResult>;
};

function makeStreamingLoop(chunks: Chunk[]): TurnServiceLoop {
  return {
    async *run(_request: AgentRunRequest): AsyncGenerator<Chunk> {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function makeRpBufferedLoop(result: RpBufferedExecutionResult): TurnServiceLoop {
  return {
    async *run(_request: AgentRunRequest): AsyncGenerator<Chunk> {
      for (const chunk of [] as Chunk[]) {
        yield chunk;
      }
    },
    async runBuffered(_request: AgentRunRequest) {
      return result;
    },
  };
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
  let originalRandomUUID: () => string;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    runInteractionMigrations(db);
    store = new InteractionStore(db);
    commitService = new CommitService(store);
    flushSelector = new FlushSelector(store);
    sessionService = new SessionService();
    originalRandomUUID = crypto.randomUUID;
  });

  afterEach(() => {
    Object.defineProperty(crypto, "randomUUID", {
      value: originalRandomUUID,
      configurable: true,
      writable: true,
    });
    closeDatabaseGracefully(db);
  });

  it("RP success settlement writes turn_settlement and assistant message and emits synthetic text", async () => {
    const session = sessionService.createSession("rp:alice");
    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "Good evening, master.",
        },
      }),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
    );

    const runChunks = await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-rp-success",
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(runChunks).toEqual([
      { type: "text_delta", text: "Good evening, master." },
      { type: "message_end", stopReason: "end_turn" },
    ]);

    const records = store.getBySession(session.sessionId);
    expect(records).toHaveLength(3);
    expect(records[1]?.recordType).toBe("turn_settlement");
    expect(records[1]?.actorType).toBe("rp_agent");
    expect(records[2]?.recordType).toBe("message");
    expect(records[2]?.payload).toEqual({
      role: "assistant",
      content: "Good evening, master.",
      settlementId: records[1]?.recordId,
    });
  });

  it("RP silent-private turn settles without assistant message and without text_delta", async () => {
    const session = sessionService.createSession("rp:alice");
    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "",
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [{ op: "retract", target: { kind: "assertion", key: "quiet-step" } }],
          },
        },
      }),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
    );

    const runChunks = await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-rp-silent",
        messages: [{ role: "user", content: "think quietly" }],
      }),
    );

    expect(runChunks).toEqual([{ type: "message_end", stopReason: "end_turn" }]);

    const records = store.getBySession(session.sessionId);
    expect(records.filter((record) => record.recordType === "turn_settlement")).toHaveLength(1);
    expect(records.filter((record) => record.recordType === "message" && record.actorType === "rp_agent")).toHaveLength(0);
  });

  it("RP illegal empty turn emits error and writes no turn_settlement", async () => {
    const session = sessionService.createSession("rp:alice");
    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "",
        },
      }),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
    );

    const runChunks = await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-rp-illegal-empty",
        messages: [{ role: "user", content: "..." }],
      }),
    );

    expect(runChunks).toEqual([
      {
        type: "error",
        code: "RP_EMPTY_TURN",
        message: "empty turn: publicReply is empty and privateCommit has no ops",
        retriable: false,
      },
    ]);

    const records = store.getBySession(session.sessionId);
    expect(records.filter((record) => record.recordType === "turn_settlement")).toHaveLength(0);
    expect(records.filter((record) => record.recordType === "status")).toHaveLength(1);
  });

  it("RP settlement transaction failure rolls back settlement/message and marks recovery_required", async () => {
    const session = sessionService.createSession("rp:alice");
    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "I started replying",
        },
      }),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
    );

    const originalUpsert = store.upsertRecentCognitionSlot.bind(store);
    store.upsertRecentCognitionSlot = () => {
      throw new Error("slot write failed");
    };

    const runChunks = await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-rp-settlement-fail",
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    store.upsertRecentCognitionSlot = originalUpsert;

    expect(runChunks).toEqual([
      {
        type: "error",
        code: "TURN_SETTLEMENT_FAILED",
        message: "slot write failed",
        retriable: false,
      },
    ]);

    const records = store.getBySession(session.sessionId);
    expect(records.filter((record) => record.recordType === "turn_settlement")).toHaveLength(0);
    expect(
      records.filter(
        (record) =>
          record.recordType === "message" &&
          record.actorType === "rp_agent" &&
          (record.payload as { role?: string }).role === "assistant",
      ),
    ).toHaveLength(0);
    expect(sessionService.isRecoveryRequired(session.sessionId)).toBe(true);
  });

  it("RP duplicate settlementId replay is idempotent and produces no duplicate records", async () => {
    const session = sessionService.createSession("rp:alice");
    const fixedIds = [
      "fixed-user-1",
      "fixed-settlement",
      "fixed-assistant-1",
      "fixed-user-2",
      "fixed-settlement",
    ];
    Object.defineProperty(crypto, "randomUUID", {
      value: () => {
        const value = fixedIds.shift();
        if (!value) {
          return originalRandomUUID();
        }
        return value;
      },
      configurable: true,
      writable: true,
    });

    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "Replay-safe reply",
        },
      }),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
    );

    const firstChunks = await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-rp-dup-1",
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    const secondChunks = await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-rp-dup-2",
        messages: [{ role: "user", content: "hello again" }],
      }),
    );

    expect(firstChunks).toEqual([
      { type: "text_delta", text: "Replay-safe reply" },
      { type: "message_end", stopReason: "end_turn" },
    ]);
    expect(secondChunks).toEqual([
      { type: "text_delta", text: "Replay-safe reply" },
      { type: "message_end", stopReason: "end_turn" },
    ]);

    const records = store.getBySession(session.sessionId);
    expect(records.filter((record) => record.recordType === "turn_settlement")).toHaveLength(1);
    expect(
      records.filter(
        (record) =>
          record.recordType === "message" &&
          record.actorType === "rp_agent" &&
          (record.payload as { content?: string }).content === "Replay-safe reply",
      ),
    ).toHaveLength(1);
  });

  it("non-RP maiden session preserves streaming path behavior", async () => {
    const session = sessionService.createSession("maid:violet");
    const streamChunks: Chunk[] = [
      { type: "text_delta", text: "Good" },
      { type: "text_delta", text: " day" },
      { type: "message_end", stopReason: "end_turn" },
    ];
    const turnService = new TurnService(
      makeStreamingLoop(streamChunks),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
    );

    const runChunks = await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-maiden-stream",
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(runChunks).toEqual(streamChunks);

    const records = store.getBySession(session.sessionId);
    expect(records).toHaveLength(2);
    expect(records[1]?.actorType).toBe("maiden");
    expect(records[1]?.recordType).toBe("message");
    expect(records[1]?.payload).toEqual({
      role: "assistant",
      content: "Good day",
    });
  });
});
