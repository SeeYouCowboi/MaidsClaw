import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest } from "../../src/core/agent-loop.js";
import type { Chunk } from "../../src/core/chunk.js";
import { TraceStore } from "../../src/app/diagnostics/trace-store.js";
import { makeSubmitRpTurnTool } from "../../src/runtime/submit-rp-turn-tool.js";
import { deriveEffectClass } from "../../src/core/tools/tool-definition.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import { FlushSelector } from "../../src/interaction/flush-selector.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import { CognitionEventRepo } from "../../src/memory/cognition/cognition-event-repo.js";
import { PrivateCognitionProjectionRepo } from "../../src/memory/cognition/private-cognition-current.js";
import { EpisodeRepository } from "../../src/memory/episode/episode-repo.js";
import { AreaWorldProjectionRepo } from "../../src/memory/projection/area-world-projection-repo.js";
import { ProjectionManager } from "../../src/memory/projection/projection-manager.js";
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

function makeRpBufferedLoop(result: unknown): TurnServiceLoop {
  return {
    async *run(_request: AgentRunRequest): AsyncGenerator<Chunk> {
      for (const chunk of [] as Chunk[]) {
        yield chunk;
      }
    },
    async runBuffered(_request: AgentRunRequest) {
      return result as RpBufferedExecutionResult;
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
          schemaVersion: "rp_turn_outcome_v5",
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
          schemaVersion: "rp_turn_outcome_v5",
          publicReply: "",
          privateCognition: {
            schemaVersion: "rp_private_cognition_v4",
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
          schemaVersion: "rp_turn_outcome_v5",
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
        message: "empty turn: publicReply is empty and privateCognition has no ops",
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
          schemaVersion: "rp_turn_outcome_v5",
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
          schemaVersion: "rp_turn_outcome_v5",
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

  it("persists full privateCommit ops without settlement projection writes", async () => {
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
          schemaVersion: "rp_turn_outcome_v5",
          publicReply: "Hello",
          privateCognition: {
            schemaVersion: "rp_private_cognition_v4",
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

    const commit = payload.privateCognition as { schemaVersion: string; summary: string; ops: Array<Record<string, unknown>> };
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
      `SELECT COUNT(*) as cnt FROM private_cognition_current WHERE agent_id = ?`,
      ["rp:alice"],
    );
    expect(factCount!.cnt).toBe(0);
    const eventCount = db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM private_cognition_events WHERE agent_id = ?`,
      ["rp:alice"],
    );
    expect(eventCount!.cnt).toBe(0);
  });

  it("assertion upsert persists full op in settlement without projection write", async () => {
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
          schemaVersion: "rp_turn_outcome_v5",
          publicReply: "",
          privateCognition: {
            schemaVersion: "rp_private_cognition_v4",
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
    const commit = payload.privateCognition as { schemaVersion: string; ops: Array<Record<string, unknown>> };
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
      `SELECT cognition_key FROM private_cognition_current WHERE agent_id = ? AND cognition_key = ? AND kind = 'assertion'`,
      ["rp:alice", "assert-1"],
    );
    expect(row).toBeUndefined();
  });

  it("evaluation upsert persists full op in settlement without projection write", async () => {
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
          schemaVersion: "rp_turn_outcome_v5",
          publicReply: "",
          privateCognition: {
            schemaVersion: "rp_private_cognition_v4",
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
    const commit = payload.privateCognition as { ops: Array<Record<string, unknown>> };
    expect(commit.ops).toHaveLength(1);
    expect((commit.ops[0] as { record: { kind: string; dimensions: unknown[] } }).record.dimensions).toEqual([{ name: "trust", value: 0.8 }]);

    const row = db.get<{ kind: string }>(
      `SELECT kind FROM private_cognition_events WHERE agent_id = ? AND cognition_key = ?`,
      ["rp:alice", "eval-1"],
    );
    expect(row).toBeUndefined();
  });

  it("commitment upsert persists full op in settlement without projection write", async () => {
    const session = sessionService.createSession("rp:alice");

    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v5",
          publicReply: "",
          privateCognition: {
            schemaVersion: "rp_private_cognition_v4",
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
    const commit = payload.privateCognition as { ops: Array<Record<string, unknown>> };
    expect(commit.ops).toHaveLength(1);
    expect((commit.ops[0] as { record: { kind: string } }).record.kind).toBe("commitment");

    const row = db.get<{ kind: string }>(
      `SELECT kind FROM private_cognition_events WHERE agent_id = ? AND cognition_key = ?`,
      ["rp:alice", "commit-1"],
    );
    expect(row).toBeUndefined();
  });

  it("retract op persists in settlement without modifying projection at settlement time", async () => {
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
          schemaVersion: "rp_turn_outcome_v5",
          publicReply: "",
          privateCognition: {
            schemaVersion: "rp_private_cognition_v4",
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
    const commit = payload.privateCognition as { ops: Array<Record<string, unknown>> };
    expect(commit.ops).toHaveLength(1);
    expect(commit.ops[0]).toEqual({ op: "retract", target: { kind: "assertion", key: "assert-retract" } });

    const row = db.get<{ stance: string }>(
      `SELECT stance FROM private_cognition_current WHERE agent_id = ? AND cognition_key = ? AND kind = 'assertion'`,
      ["rp:alice", "assert-retract"],
    );
    expect(row?.stance).toBe("accepted");
  });

  it("current_location assertion persists full op in settlement without projection write", async () => {
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
          schemaVersion: "rp_turn_outcome_v5",
          publicReply: "",
          privateCognition: {
            schemaVersion: "rp_private_cognition_v4",
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
    const commit = payload.privateCognition as { ops: Array<Record<string, unknown>> };
    expect(commit.ops).toHaveLength(1);
    expect((commit.ops[0] as { record: { key: string } }).record.key).toBe("location-assert-1");
    expect(payload.viewerSnapshot).toEqual({
      selfPointerKey: "__self__",
      userPointerKey: "__user__",
      currentLocationEntityId: locationEntityId,
    });

    const row = db.get<{ id: number }>(
      `SELECT id FROM private_cognition_current WHERE agent_id = ? AND cognition_key = ? AND kind = 'assertion'`,
      ["rp:alice", "location-assert-1"],
    );
    expect(row).toBeUndefined();
  });

  it("touch op is rejected by normalizer — no settlement committed", async () => {
    const session = sessionService.createSession("rp:alice");
    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v5",
          publicReply: "",
          privateCognition: {
            schemaVersion: "rp_private_cognition_v4",
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

  it("bad relation localRef/cognitionKey rejects settlement atomically", async () => {
    const session = sessionService.createSession("rp:alice");
    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v5",
          publicReply: "",
          privateCognition: {
            schemaVersion: "rp_private_cognition_v4",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "evaluation",
                  key: "eval:ok",
                  target: { kind: "special", value: "self" },
                  dimensions: [{ name: "trust", value: 0.4 }],
                },
              },
            ],
          },
          privateEpisodes: [
            { localRef: "ep:ok", category: "observation", summary: "saw contradiction" },
          ],
          publications: [],
          relationIntents: [
            { sourceRef: "ep:missing", targetRef: "eval:missing", intent: "triggered" },
          ],
          conflictFactors: [],
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
        requestId: "req-bad-relation-localref",
        messages: [{ role: "user", content: "internal" }],
      }),
    );

    const err = runChunks.find((chunk) => chunk.type === "error") as { type: "error"; code: string; message: string };
    expect(err.code).toBe("RP_OUTCOME_NORMALIZATION_FAILED");
    expect(err.message).toContain("invalid relation sourceRef");

    const records = store.getBySession(session.sessionId);
    expect(records.filter((record) => record.recordType === "turn_settlement")).toHaveLength(0);
  });

  it("latentScratchpad from outcome is not persisted in settlement payload", async () => {
    const session = sessionService.createSession("rp:alice");
    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v5",
          publicReply: "Hello with scratchpad",
          latentScratchpad: "SECRET_INTERNAL_REASONING_SHOULD_NOT_PERSIST",
          privateCognition: {
            schemaVersion: "rp_private_cognition_v4",
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
    expect(payload.privateCognition).toBeDefined();
    const commit = payload.privateCognition as { ops: Array<Record<string, unknown>> };
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

  it("memory migration creates private_cognition_events table", () => {
    const tableInfo = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='private_cognition_events'",
    );
    expect(tableInfo).toHaveLength(1);

    const indexInfo = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_private_cognition_events%'",
    );
    expect(indexInfo.length).toBeGreaterThanOrEqual(2);
  });

  it("settlement transaction atomicity: private_cognition_events has correct schema", () => {
    const columns = db.query<{ name: string; type: string }>(
      "PRAGMA table_info(private_cognition_events)",
    );
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain("agent_id");
    expect(columnNames).toContain("cognition_key");
    expect(columnNames).toContain("kind");
    expect(columnNames).toContain("op");
    expect(columnNames).toContain("record_json");
    expect(columnNames).toContain("settlement_id");
    expect(columnNames).toContain("committed_time");
    expect(columnNames).toContain("created_at");
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

  it("submit_rp_turn has executionContract with settlement effect_type", () => {
    const tool = makeSubmitRpTurnTool();
    expect(tool.executionContract).toBeDefined();
    expect(tool.executionContract!.effect_type).toBe("settlement");
    expect(tool.executionContract!.turn_phase).toBe("post_turn");
    expect(tool.executionContract!.cardinality).toBe("once");
    expect(tool.executionContract!.trace_visibility).toBe("private_runtime");
    expect(tool.executionContract!.capability_requirements).toEqual(["rp_settlement"]);
  });

  it("submit_rp_turn has 8 artifact contracts with correct scope/policy", () => {
    const tool = makeSubmitRpTurnTool();
    expect(tool.artifactContracts).toBeDefined();
    const contracts = tool.artifactContracts!;
    expect(Object.keys(contracts).sort()).toEqual([
      "areaStateArtifacts",
      "conflictFactors",
      "pinnedSummaryProposal",
      "privateCognition",
      "privateEpisodes",
      "publicReply",
      "publications",
      "relationIntents",
    ]);

    expect(contracts.publicReply).toEqual({
      authority_level: "agent",
      artifact_scope: "world",
      ledger_policy: "current_state",
    });
    expect(contracts.privateCognition).toEqual({
      authority_level: "agent",
      artifact_scope: "private",
      ledger_policy: "append_only",
    });
    expect(contracts.privateEpisodes).toEqual({
      authority_level: "agent",
      artifact_scope: "private",
      ledger_policy: "append_only",
    });
    expect(contracts.publications).toEqual({
      authority_level: "agent",
      artifact_scope: "area",
      ledger_policy: "append_only",
    });
    expect(contracts.pinnedSummaryProposal).toEqual({
      authority_level: "agent",
      artifact_scope: "session",
      ledger_policy: "current_state",
    });
    expect(contracts.relationIntents).toEqual({
      authority_level: "agent",
      artifact_scope: "private",
      ledger_policy: "append_only",
    });
    expect(contracts.conflictFactors).toEqual({
      authority_level: "agent",
      artifact_scope: "private",
      ledger_policy: "current_state",
    });
    expect(contracts.areaStateArtifacts).toEqual({
      authority_level: "agent",
      artifact_scope: "area",
      ledger_policy: "current_state",
    });
  });

  it("settlement effect_type derives to read_only EffectClass (backward-compatible)", () => {
    const tool = makeSubmitRpTurnTool();
    const derived = deriveEffectClass(tool.executionContract!.effect_type);
    expect(derived).toBe("read_only");
    expect(tool.effectClass).toBe("read_only");
  });

  it("trace redaction excludes private artifact kinds and includes public artifact kinds", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maidsclaw-trace-redaction-"));
    const traceStore = new TraceStore(tempDir);

    try {
      const session = sessionService.createSession("rp:alice");
      const turnService = new TurnService(
        makeRpBufferedLoop({
          outcome: {
            schemaVersion: "rp_turn_outcome_v5",
            publicReply: "Visible reply",
            privateCognition: {
              schemaVersion: "rp_private_cognition_v4",
              ops: [
                {
                  op: "upsert",
                  record: {
                    kind: "assertion",
                    key: "trace-redaction-test",
                    proposition: {
                      subject: { kind: "special", value: "self" },
                      predicate: "knows",
                      object: { kind: "entity", ref: { kind: "special", value: "user" } },
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
        traceStore,
      );

      await collectChunks(
        turnService.run({
          sessionId: session.sessionId,
          requestId: "req-trace-redaction",
          messages: [{ role: "user", content: "hello" }],
        }),
      );

      const trace = traceStore.readTrace("req-trace-redaction");
      expect(trace).not.toBeNull();
      const kinds = trace?.settlement?.kinds ?? [];

      expect(kinds).toContain("assertion");
      expect(kinds).toContain("publicReply");
      expect(kinds).toContain("publications");
      expect(kinds).toContain("pinnedSummaryProposal");
      expect(kinds).toContain("areaStateArtifacts");

      expect(kinds).not.toContain("privateCognition");
      expect(kinds).not.toContain("privateEpisodes");
      expect(kinds).not.toContain("relationIntents");
      expect(kinds).not.toContain("conflictFactors");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("TurnService with ProjectionManager", () => {
  let db: Db;
  let store: InteractionStore;
  let commitService: CommitService;
  let flushSelector: FlushSelector;
  let sessionService: SessionService;
  let graphStorage: GraphStorageService;
  let projectionManager: ProjectionManager;
  let episodeRepo: EpisodeRepository;
  let cognitionEventRepo: CognitionEventRepo;
  let cognitionProjectionRepo: PrivateCognitionProjectionRepo;
  let areaProjectionRepo: AreaWorldProjectionRepo;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    runInteractionMigrations(db);
    runMemoryMigrations(db);
    store = new InteractionStore(db);
    commitService = new CommitService(store);
    flushSelector = new FlushSelector(store);
    sessionService = new SessionService();
    graphStorage = new GraphStorageService(db);
    episodeRepo = new EpisodeRepository(db);
    cognitionEventRepo = new CognitionEventRepo(db.raw);
    cognitionProjectionRepo = new PrivateCognitionProjectionRepo(db.raw);
    areaProjectionRepo = new AreaWorldProjectionRepo(db.raw);
    projectionManager = new ProjectionManager(
      episodeRepo,
      cognitionEventRepo,
      cognitionProjectionRepo,
      graphStorage,
      areaProjectionRepo,
    );
  });

  afterEach(() => {
    closeDatabaseGracefully(db);
  });

  function makeTurnServiceWithProjection(result: unknown): TurnService {
    return new TurnService(
      makeRpBufferedLoop(result),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      undefined,
      undefined,
      graphStorage,
      undefined,
      projectionManager,
    );
  }

  it("episodes go to private_episode_events ledger, not agent_event_overlay", async () => {
    const session = sessionService.createSession("rp:alice");
    const turnService = makeTurnServiceWithProjection({
      outcome: {
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "I noticed something.",
        privateEpisodes: [
          {
            category: "observation",
            summary: "The garden gate was open",
            privateNotes: "Might be a security concern",
          },
          {
            category: "speech",
            summary: "Alice mentioned the weather to the user",
          },
        ],
        publications: [],
        relationIntents: [],
        conflictFactors: [],
      },
    });

    await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-ep-projection",
        messages: [{ role: "user", content: "what do you see?" }],
      }),
    );

    const episodes = episodeRepo.readBySettlement("stl:req-ep-projection", "rp:alice");
    expect(episodes).toHaveLength(2);
    expect(episodes[0].category).toBe("observation");
    expect(episodes[0].summary).toBe("The garden gate was open");
    expect(episodes[0].private_notes).toBe("Might be a security concern");
    expect(episodes[1].category).toBe("speech");
    expect(episodes[1].summary).toBe("Alice mentioned the weather to the user");

    const overlayCount = db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM private_cognition_events WHERE agent_id = ?`,
      ["rp:alice"],
    );
    expect(overlayCount!.cnt).toBe(0);
  });

  it("cognition ops write to event log and update current projection synchronously", async () => {
    const session = sessionService.createSession("rp:alice");
    const turnService = makeTurnServiceWithProjection({
      outcome: {
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "",
        privateCognition: {
          schemaVersion: "rp_private_cognition_v4",
          ops: [
            {
              op: "upsert",
              record: {
                kind: "assertion",
                key: "trust-user",
                proposition: {
                  subject: { kind: "special", value: "self" },
                  predicate: "trusts",
                  object: { kind: "entity", ref: { kind: "special", value: "user" } },
                },
                stance: "accepted",
              },
            },
            {
              op: "upsert",
              record: {
                kind: "commitment",
                key: "protect-master",
                mode: "goal",
                target: { action: "protect the household" },
                status: "active",
              },
            },
          ],
        },
      },
    });

    await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-cog-projection",
        messages: [{ role: "user", content: "think" }],
      }),
    );

    const events = cognitionEventRepo.readByAgent("rp:alice");
    expect(events).toHaveLength(2);
    expect(events[0].cognition_key).toBe("trust-user");
    expect(events[0].kind).toBe("assertion");
    expect(events[0].op).toBe("upsert");
    expect(events[1].cognition_key).toBe("protect-master");
    expect(events[1].kind).toBe("commitment");

    const currentAssertion = cognitionProjectionRepo.getCurrent("rp:alice", "trust-user");
    expect(currentAssertion).not.toBeNull();
    expect(currentAssertion!.kind).toBe("assertion");
    expect(currentAssertion!.status).toBe("active");

    const currentCommitment = cognitionProjectionRepo.getCurrent("rp:alice", "protect-master");
    expect(currentCommitment).not.toBeNull();
    expect(currentCommitment!.kind).toBe("commitment");

    const overlayFactCount = db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM private_cognition_current WHERE agent_id = ?`,
      ["rp:alice"],
    );
    expect(overlayFactCount!.cnt).toBe(2);

    const overlayEventCount = db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM private_cognition_events WHERE agent_id = ?`,
      ["rp:alice"],
    );
    expect(overlayEventCount!.cnt).toBe(2);
  });

  it("retract op updates current projection to retracted status", async () => {
    const session = sessionService.createSession("rp:alice");

    const turnService1 = makeTurnServiceWithProjection({
      outcome: {
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "",
        privateCognition: {
          schemaVersion: "rp_private_cognition_v4",
          ops: [
            {
              op: "upsert",
              record: {
                kind: "assertion",
                key: "old-belief",
                proposition: {
                  subject: { kind: "special", value: "self" },
                  predicate: "likes",
                  object: { kind: "entity", ref: { kind: "special", value: "user" } },
                },
                stance: "accepted",
              },
            },
          ],
        },
      },
    });

    await collectChunks(
      turnService1.run({
        sessionId: session.sessionId,
        requestId: "req-setup-belief",
        messages: [{ role: "user", content: "first" }],
      }),
    );

    const beforeRetract = cognitionProjectionRepo.getCurrent("rp:alice", "old-belief");
    expect(beforeRetract).not.toBeNull();
    expect(beforeRetract!.status).toBe("active");

    const turnService2 = makeTurnServiceWithProjection({
      outcome: {
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "",
        privateCognition: {
          schemaVersion: "rp_private_cognition_v4",
          ops: [
            { op: "retract", target: { kind: "assertion", key: "old-belief" } },
          ],
        },
      },
    });

    await collectChunks(
      turnService2.run({
        sessionId: session.sessionId,
        requestId: "req-retract-belief",
        messages: [{ role: "user", content: "second" }],
      }),
    );

    const afterRetract = cognitionProjectionRepo.getCurrent("rp:alice", "old-belief");
    expect(afterRetract).not.toBeNull();
    expect(afterRetract!.status).toBe("retracted");
  });

  it("settlement transaction rolls back all projections on failure", async () => {
    const session = sessionService.createSession("rp:alice");
    const turnService = makeTurnServiceWithProjection({
      outcome: {
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "Hello",
        privateCognition: {
          schemaVersion: "rp_private_cognition_v4",
          ops: [
            {
              op: "upsert",
              record: {
                kind: "assertion",
                key: "should-rollback",
                proposition: {
                  subject: { kind: "special", value: "self" },
                  predicate: "knows",
                  object: { kind: "entity", ref: { kind: "special", value: "user" } },
                },
                stance: "accepted",
              },
            },
          ],
        },
        privateEpisodes: [
          { category: "speech", summary: "should also rollback" },
        ],
      },
    });

    const originalUpsert = store.upsertRecentCognitionSlot.bind(store);
    store.upsertRecentCognitionSlot = () => {
      throw new Error("forced slot failure for rollback test");
    };

    const chunks = await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-rollback-test",
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    store.upsertRecentCognitionSlot = originalUpsert;

    expect(chunks[0]).toEqual({
      type: "error",
      code: "TURN_SETTLEMENT_FAILED",
      message: "forced slot failure for rollback test",
      retriable: false,
    });

    const events = cognitionEventRepo.readByAgent("rp:alice");
    expect(events).toHaveLength(0);

    const current = cognitionProjectionRepo.getCurrent("rp:alice", "should-rollback");
    expect(current).toBeNull();

    const episodes = episodeRepo.readBySettlement("stl:req-rollback-test", "rp:alice");
    expect(episodes).toHaveLength(0);
  });

  it("combined episodes + cognition + publications all commit in one transaction", async () => {
    const session = sessionService.createSession("rp:alice");

    const locationEntityId = graphStorage.upsertEntity({
      pointerKey: "location:garden",
      displayName: "Garden",
      entityType: "location",
      memoryScope: "shared_public",
    });

    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v5",
          publicReply: "Good morning from the garden.",
          privateCognition: {
            schemaVersion: "rp_private_cognition_v4",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "evaluation",
                  key: "eval-garden-mood",
                  target: { kind: "special", value: "self" },
                  dimensions: [{ name: "peace", value: 0.9 }],
                  notes: "The garden is peaceful today",
                },
              },
            ],
          },
          privateEpisodes: [
            { category: "observation", summary: "Morning dew on the roses" },
          ],
          publications: [
            { kind: "spoken", targetScope: "current_area", summary: "Good morning from the garden." },
          ],
          relationIntents: [],
          conflictFactors: [],
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
      undefined,
      projectionManager,
    );

    await collectChunks(
      turnService.run({
        sessionId: session.sessionId,
        requestId: "req-combined",
        messages: [{ role: "user", content: "good morning" }],
      }),
    );

    const episodes = episodeRepo.readBySettlement("stl:req-combined", "rp:alice");
    expect(episodes).toHaveLength(1);
    expect(episodes[0].summary).toBe("Morning dew on the roses");

    const events = cognitionEventRepo.readByAgent("rp:alice");
    expect(events).toHaveLength(1);
    expect(events[0].cognition_key).toBe("eval-garden-mood");

    const currentEval = cognitionProjectionRepo.getCurrent("rp:alice", "eval-garden-mood");
    expect(currentEval).not.toBeNull();
    expect(currentEval!.kind).toBe("evaluation");

    const publicEvents = db.query<{ summary: string }>(
      `SELECT summary FROM event_nodes WHERE source_settlement_id = ?`,
      ["stl:req-combined"],
    );
    expect(publicEvents).toHaveLength(1);
    expect(publicEvents[0].summary).toBe("Good morning from the garden.");
  });
});
