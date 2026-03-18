import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentRunRequest } from "../../src/core/agent-loop.js";
import type { Chunk } from "../../src/core/chunk.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import { FlushSelector } from "../../src/interaction/flush-selector.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import type { RpBufferedExecutionResult } from "../../src/runtime/rp-turn-contract.js";
import { TurnService } from "../../src/runtime/turn-service.js";
import { SessionService } from "../../src/session/service.js";
import { closeDatabaseGracefully, openDatabase, type Db } from "../../src/storage/database.js";
import type { RuntimeBootstrapResult } from "../../src/bootstrap/types.js";
import { createLocalRuntime } from "../../src/cli/local-runtime.js";
import type { TurnExecutionResult } from "../../src/cli/types.js";

type TurnServiceLoop = {
  run(request: AgentRunRequest): AsyncIterable<Chunk>;
  runBuffered?: (request: AgentRunRequest) => Promise<RpBufferedExecutionResult>;
};

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

function assertValidTurnExecutionResultShape(result: TurnExecutionResult): void {
  expect(typeof result.mode).toBe("string");
  expect(typeof result.session_id).toBe("string");
  expect(typeof result.request_id).toBe("string");
  expect(typeof result.assistant_text).toBe("string");
  expect(typeof result.has_public_reply).toBe("boolean");
  expect(typeof result.private_commit.present).toBe("boolean");
  expect(typeof result.private_commit.op_count).toBe("number");
  expect(Array.isArray(result.private_commit.kinds)).toBe(true);
  expect(typeof result.recovery_required).toBe("boolean");
  expect(Array.isArray(result.public_chunks)).toBe(true);
  expect(Array.isArray(result.tool_events)).toBe(true);
}

describe("LocalRuntime", () => {
  let db: Db;
  let sessionService: SessionService;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    runInteractionMigrations(db);
    runMemoryMigrations(db);
    sessionService = new SessionService();
  });

  afterEach(() => {
    closeDatabaseGracefully(db);
  });

  it("normalizes silent-private RP success as a valid result", async () => {
    const store = new InteractionStore(db);
    const commitService = new CommitService(store);
    const flushSelector = new FlushSelector(store);
    const graphStorage = new GraphStorageService(db);
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

    const session = sessionService.createSession("rp:alice");
    const runtime = {
      db,
      turnService,
      sessionService,
    } as unknown as RuntimeBootstrapResult;

    const result = await createLocalRuntime(runtime).executeTurn({
      sessionId: session.sessionId,
      agentId: "rp:alice",
      text: "think quietly",
    });

    assertValidTurnExecutionResultShape(result);
    expect(result.mode).toBe("local");
    expect(result.assistant_text).toBe("");
    expect(result.has_public_reply).toBe(false);
    expect(result.private_commit).toEqual({
      present: true,
      op_count: 1,
      kinds: ["assertion"],
    });
    expect(result.recovery_required).toBe(false);
    expect(result.settlement_id).toBe(`stl:${result.request_id}`);
  });

  it("normalizes public RP success with assistant text and public reply flag", async () => {
    const store = new InteractionStore(db);
    const commitService = new CommitService(store);
    const flushSelector = new FlushSelector(store);
    const graphStorage = new GraphStorageService(db);
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

    const session = sessionService.createSession("rp:alice");
    const runtime = {
      db,
      turnService,
      sessionService,
    } as unknown as RuntimeBootstrapResult;

    const result = await createLocalRuntime(runtime).executeTurn({
      sessionId: session.sessionId,
      agentId: "rp:alice",
      text: "hello",
    });

    assertValidTurnExecutionResultShape(result);
    expect(result.mode).toBe("local");
    expect(result.assistant_text).toBe("Good evening, master.");
    expect(result.has_public_reply).toBe(true);
    expect(result.private_commit).toEqual({
      present: false,
      op_count: 0,
      kinds: [],
    });
    expect(result.recovery_required).toBe(false);
    expect(result.settlement_id).toBe(`stl:${result.request_id}`);
  });
});
