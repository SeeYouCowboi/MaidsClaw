import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentRunRequest } from "../../src/core/agent-loop.js";
import type { Chunk } from "../../src/core/chunk.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import { FlushSelector } from "../../src/interaction/flush-selector.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
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
      undefined,
      undefined,
      graphStorage,
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
      undefined,
      undefined,
      graphStorage,
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
      undefined,
      undefined,
      graphStorage,
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
        code: "RP_OUTCOME_NORMALIZATION_FAILED",
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
      undefined,
      undefined,
      graphStorage,
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

  it("RP replay with same requestId is idempotent and produces no duplicate records", async () => {
    const session = sessionService.createSession("rp:alice");

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
      undefined,
      undefined,
      graphStorage,
    );

    const firstChunks = await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-1",
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    const secondChunks = await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-1",
        messages: [{ role: "user", content: "hello" }],
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
    expect(
      records.filter(
        (record) =>
          record.recordType === "message" &&
          record.actorType === "user" &&
          record.correlatedTurnId === "req-1",
      ),
    ).toHaveLength(1);
    expect(records.filter((record) => record.recordType === "turn_settlement")).toHaveLength(1);
    expect(records.find((record) => record.recordType === "turn_settlement")?.recordId).toBe("stl:req-1");
    expect(
      records.filter(
        (record) =>
          record.recordType === "message" &&
          record.actorType === "rp_agent" &&
          (record.payload as { content?: string }).content === "Replay-safe reply",
      ),
    ).toHaveLength(1);
  });

  it("persists full privateCommit ops without settlement overlay writes", async () => {
    const session = sessionService.createSession("rp:alice");
    graphStorage.upsertEntity({
      pointerKey: "__self__",
      displayName: "Alice",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "rp:alice",
    });
    graphStorage.upsertEntity({
      pointerKey: "target:bob",
      displayName: "Bob",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "rp:alice",
    });

    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "Hello",
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            summary: "mixed ops",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "assertion",
                  key: "assert-full",
                  proposition: {
                    subject: { kind: "special", value: "self" },
                    predicate: "trusts",
                    object: { kind: "entity", ref: { kind: "pointer_key", value: "target:bob" } },
                  },
                  stance: "accepted",
                  confidence: 0.9,
                  salience: 5,
                },
              },
              {
                op: "upsert",
                record: {
                  kind: "evaluation",
                  key: "eval-full",
                  target: { kind: "pointer_key", value: "target:bob" },
                  dimensions: [{ name: "trust", value: 0.8 }],
                },
              },
              {
                op: "retract",
                target: { kind: "commitment", key: "old-commit" },
              },
            ],
          },
        },
      }),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      undefined,
      undefined,
      graphStorage,
    );

    const runChunks = await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-full-commit",
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(runChunks).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "message_end", stopReason: "end_turn" },
    ]);

    const settlement = store.getBySession(session.sessionId).find((r) => r.recordType === "turn_settlement");
    expect(settlement).toBeDefined();
    const payload = settlement!.payload as Record<string, unknown>;
    expect(payload.ownerAgentId).toBe("rp:alice");

    const commit = payload.privateCommit as { schemaVersion: string; summary: string; ops: Array<Record<string, unknown>> };
    expect(commit.schemaVersion).toBe("rp_private_cognition_v4");
    expect(commit.summary).toBe("mixed ops");
    expect(commit.ops).toHaveLength(3);
    expect(commit.ops[0]).toEqual({
      op: "upsert",
      record: {
        kind: "assertion",
        key: "assert-full",
        proposition: {
          subject: { kind: "special", value: "self" },
          predicate: "trusts",
          object: { kind: "entity", ref: { kind: "pointer_key", value: "target:bob" } },
        },
        stance: "accepted",
        salience: 5,
      },
    });
    expect(commit.ops[1]).toEqual({
      op: "upsert",
      record: {
        kind: "evaluation",
        key: "eval-full",
        target: { kind: "pointer_key", value: "target:bob" },
        dimensions: [{ name: "trust", value: 0.8 }],
      },
    });
    expect(commit.ops[2]).toEqual({
      op: "retract",
      target: { kind: "commitment", key: "old-commit" },
    });

    const factCount = db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM agent_fact_overlay WHERE agent_id = ?`,
      ["rp:alice"],
    );
    expect(factCount!.cnt).toBe(0);
    const eventCount = db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM agent_event_overlay WHERE agent_id = ?`,
      ["rp:alice"],
    );
    expect(eventCount!.cnt).toBe(0);
  });

  it("assertion upsert persists full op in settlement without overlay write", async () => {
    const session = sessionService.createSession("rp:alice");
    graphStorage.upsertEntity({
      pointerKey: "__self__",
      displayName: "Alice",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "rp:alice",
    });
    graphStorage.upsertEntity({
      pointerKey: "target:bob",
      displayName: "Bob",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "rp:alice",
    });

    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "",
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "assertion",
                  key: "assert-1",
                  proposition: {
                    subject: { kind: "special", value: "self" },
                    predicate: "trusts",
                    object: { kind: "entity", ref: { kind: "pointer_key", value: "target:bob" } },
                  },
                  stance: "accepted",
                },
              },
            ],
          },
        },
      }),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      undefined,
      undefined,
      graphStorage,
    );

    const runChunks = await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-cognition-assertion",
        messages: [{ role: "user", content: "internal" }],
      }),
    );
    expect(runChunks).toEqual([{ type: "message_end", stopReason: "end_turn" }]);

    const settlement = store.getBySession(session.sessionId).find((r) => r.recordType === "turn_settlement");
    expect(settlement).toBeDefined();
    const payload = settlement!.payload as Record<string, unknown>;
    expect(payload.ownerAgentId).toBe("rp:alice");
    const commit = payload.privateCommit as { schemaVersion: string; ops: Array<Record<string, unknown>> };
    expect(commit.schemaVersion).toBe("rp_private_cognition_v4");
    expect(commit.ops).toHaveLength(1);
    expect(commit.ops[0]).toEqual({
      op: "upsert",
      record: {
        kind: "assertion",
        key: "assert-1",
        proposition: {
          subject: { kind: "special", value: "self" },
          predicate: "trusts",
          object: { kind: "entity", ref: { kind: "pointer_key", value: "target:bob" } },
        },
        stance: "accepted",
      },
    });

    const row = db.get<{ cognition_key: string }>(
      `SELECT cognition_key FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?`,
      ["rp:alice", "assert-1"],
    );
    expect(row).toBeUndefined();
  });

  it("evaluation upsert persists full op in settlement without overlay write", async () => {
    const session = sessionService.createSession("rp:alice");
    graphStorage.upsertEntity({
      pointerKey: "target:bob",
      displayName: "Bob",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "rp:alice",
    });

    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "",
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "evaluation",
                  key: "eval-1",
                  target: { kind: "pointer_key", value: "target:bob" },
                  dimensions: [{ name: "trust", value: 0.8 }],
                },
              },
            ],
          },
        },
      }),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      undefined,
      undefined,
      graphStorage,
    );

    await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-cognition-evaluation",
        messages: [{ role: "user", content: "internal" }],
      }),
    );

    const settlement = store.getBySession(session.sessionId).find((r) => r.recordType === "turn_settlement");
    const payload = settlement!.payload as Record<string, unknown>;
    const commit = payload.privateCommit as { ops: Array<Record<string, unknown>> };
    expect(commit.ops).toHaveLength(1);
    expect((commit.ops[0] as { record: { kind: string; dimensions: unknown[] } }).record.dimensions).toEqual([{ name: "trust", value: 0.8 }]);

    const row = db.get<{ explicit_kind: string }>(
      `SELECT explicit_kind FROM agent_event_overlay WHERE agent_id = ? AND cognition_key = ?`,
      ["rp:alice", "eval-1"],
    );
    expect(row).toBeUndefined();
  });

  it("commitment upsert persists full op in settlement without overlay write", async () => {
    const session = sessionService.createSession("rp:alice");

    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "",
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "commitment",
                  key: "commit-1",
                  mode: "goal",
                  target: { action: "protect household" },
                  status: "active",
                },
              },
            ],
          },
        },
      }),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      undefined,
      undefined,
      graphStorage,
    );

    await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-cognition-commitment",
        messages: [{ role: "user", content: "internal" }],
      }),
    );

    const settlement = store.getBySession(session.sessionId).find((r) => r.recordType === "turn_settlement");
    const payload = settlement!.payload as Record<string, unknown>;
    const commit = payload.privateCommit as { ops: Array<Record<string, unknown>> };
    expect(commit.ops).toHaveLength(1);
    expect((commit.ops[0] as { record: { kind: string } }).record.kind).toBe("commitment");

    const row = db.get<{ explicit_kind: string }>(
      `SELECT explicit_kind FROM agent_event_overlay WHERE agent_id = ? AND cognition_key = ?`,
      ["rp:alice", "commit-1"],
    );
    expect(row).toBeUndefined();
  });

  it("retract op persists in settlement without modifying overlay at settlement time", async () => {
    const session = sessionService.createSession("rp:alice");
    graphStorage.upsertEntity({
      pointerKey: "__self__",
      displayName: "Alice",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "rp:alice",
    });
    graphStorage.upsertEntity({
      pointerKey: "target:bob",
      displayName: "Bob",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "rp:alice",
    });
    graphStorage.upsertExplicitAssertion({
      agentId: "rp:alice",
      cognitionKey: "assert-retract",
      settlementId: "seed-settlement",
      opIndex: 0,
      sourcePointerKey: "__self__",
      predicate: "trusts",
      targetPointerKey: "target:bob",
      stance: "accepted",
    });

    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "",
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [{ op: "retract", target: { kind: "assertion", key: "assert-retract" } }],
          },
        },
      }),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      undefined,
      undefined,
      graphStorage,
    );

    await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-cognition-retract",
        messages: [{ role: "user", content: "internal" }],
      }),
    );

    const settlement = store.getBySession(session.sessionId).find((r) => r.recordType === "turn_settlement");
    const payload = settlement!.payload as Record<string, unknown>;
    const commit = payload.privateCommit as { ops: Array<Record<string, unknown>> };
    expect(commit.ops).toHaveLength(1);
    expect(commit.ops[0]).toEqual({ op: "retract", target: { kind: "assertion", key: "assert-retract" } });

    const row = db.get<{ epistemic_status: string }>(
      `SELECT epistemic_status FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?`,
      ["rp:alice", "assert-retract"],
    );
    expect(row?.epistemic_status).toBe("confirmed");
  });

  it("current_location assertion persists full op in settlement without overlay write", async () => {
    const session = sessionService.createSession("rp:alice");

    graphStorage.upsertEntity({
      pointerKey: "__self__",
      displayName: "Alice",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "rp:alice",
    });

    const locationEntityId = graphStorage.upsertEntity({
      pointerKey: "location:garden",
      displayName: "Garden",
      entityType: "location",
      memoryScope: "private_overlay",
      ownerAgentId: "rp:alice",
    });

    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "",
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "assertion",
                  key: "location-assert-1",
                  proposition: {
                    subject: { kind: "special", value: "self" },
                    predicate: "is_at",
                    object: { kind: "entity", ref: { kind: "special", value: "current_location" } },
                  },
                  stance: "accepted",
                },
              },
            ],
          },
        },
      }),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      () => ({
        viewer_agent_id: "rp:alice",
        viewer_role: "rp_agent",
        session_id: session.sessionId,
        current_area_id: locationEntityId,
      }),
      undefined,
      graphStorage,
    );

    const runChunks = await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-current-location-snapshot",
        messages: [{ role: "user", content: "where am I?" }],
      }),
    );
    expect(runChunks).toEqual([{ type: "message_end", stopReason: "end_turn" }]);

    const settlement = store.getBySession(session.sessionId).find((r) => r.recordType === "turn_settlement");
    const payload = settlement!.payload as Record<string, unknown>;
    const commit = payload.privateCommit as { ops: Array<Record<string, unknown>> };
    expect(commit.ops).toHaveLength(1);
    expect((commit.ops[0] as { record: { key: string } }).record.key).toBe("location-assert-1");
    expect(payload.viewerSnapshot).toEqual({
      selfPointerKey: "__self__",
      userPointerKey: "__user__",
      currentLocationEntityId: locationEntityId,
    });

    const row = db.get<{ target_entity_id: number }>(
      `SELECT target_entity_id FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?`,
      ["rp:alice", "location-assert-1"],
    );
    expect(row).toBeUndefined();
  });

  it("touch op is rejected by normalizer — no settlement committed", async () => {
    const session = sessionService.createSession("rp:alice");
    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "",
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [{ op: "touch" } as unknown as never],
          },
        },
      } as unknown as RpBufferedExecutionResult),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      undefined,
      undefined,
      graphStorage,
    );

    const runChunks = await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-cognition-touch",
        messages: [{ role: "user", content: "internal" }],
      }),
    );

    const errorChunks = runChunks.filter((c) => c.type === "error");
    expect(errorChunks).toHaveLength(1);
    expect((errorChunks[0] as { code: string }).code).toBe("RP_OUTCOME_NORMALIZATION_FAILED");

    const records = store.getBySession(session.sessionId);
    expect(records.filter((record) => record.recordType === "turn_settlement")).toHaveLength(0);
  });

  it("latentScratchpad from outcome is not persisted in settlement payload", async () => {
    const session = sessionService.createSession("rp:alice");
    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "Hello with scratchpad",
          latentScratchpad: "SECRET_INTERNAL_REASONING_SHOULD_NOT_PERSIST",
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "commitment",
                  key: "scratch-test",
                  mode: "goal",
                  target: { action: "test scratchpad exclusion" },
                  status: "active",
                },
              },
            ],
          },
        },
      }),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      undefined,
      undefined,
      graphStorage,
    );

    await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-scratchpad-exclusion",
        messages: [{ role: "user", content: "think hard" }],
      }),
    );

    const settlement = store.getBySession(session.sessionId).find((r) => r.recordType === "turn_settlement");
    expect(settlement).toBeDefined();
    const payload = settlement!.payload as Record<string, unknown>;

    // latentScratchpad must NOT appear anywhere in the persisted settlement payload
    expect(payload.latentScratchpad).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("SECRET_INTERNAL_REASONING_SHOULD_NOT_PERSIST");
    expect(JSON.stringify(payload)).not.toContain("latentScratchpad");

    // Verify the rest of the settlement is well-formed
    expect(payload.publicReply).toBe("Hello with scratchpad");
    expect(payload.privateCommit).toBeDefined();
    const commit = payload.privateCommit as { ops: Array<Record<string, unknown>> };
    expect(commit.ops).toHaveLength(1);

    // Also verify raw DB content doesn't contain it
    const rawRow = db.get<{ payload: string }>(
      `SELECT payload FROM interaction_records WHERE record_type = 'turn_settlement' AND session_id = ?`,
      [session.sessionId],
    );
    expect(rawRow).toBeDefined();
    expect(rawRow!.payload).not.toContain("latentScratchpad");
    expect(rawRow!.payload).not.toContain("SECRET_INTERNAL_REASONING_SHOULD_NOT_PERSIST");
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
      undefined,
      undefined,
      graphStorage,
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
