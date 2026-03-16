import { describe, expect, it, beforeEach } from "bun:test";
import { openDatabase, closeDatabaseGracefully } from "../../src/storage/database.js";
import type { Db } from "../../src/storage/database.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import type { CommitInput } from "../../src/interaction/commit-service.js";
import { FlushSelector } from "../../src/interaction/flush-selector.js";
import type { InteractionRecord } from "../../src/interaction/contracts.js";
import { MaidsClawError } from "../../src/core/errors.js";

function createTestDb(): Db {
  return openDatabase({ path: ":memory:" });
}

function makeCommitInput(overrides?: Partial<CommitInput>): CommitInput {
  return {
    sessionId: overrides?.sessionId ?? "sess-1",
    actorType: overrides?.actorType ?? "user",
    recordType: overrides?.recordType ?? "message",
    payload: overrides?.payload ?? { role: "user", content: "hello" },
    correlatedTurnId: overrides?.correlatedTurnId,
  };
}

// ─── Schema / Migration ───────────────────────────────────────────────────────

describe("Interaction Schema", () => {
  it("creates interaction_records table with correct columns", () => {
    const db = createTestDb();
    runInteractionMigrations(db);

    const table = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='interaction_records'",
    );
    expect(table?.name).toBe("interaction_records");

    closeDatabaseGracefully(db);
  });

  it("creates required indexes", () => {
    const db = createTestDb();
    runInteractionMigrations(db);

    const indexes = db
      .query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_interaction%' ORDER BY name",
      )
      .map((r) => r.name);

    expect(indexes.includes("idx_interaction_session_index")).toBe(true);
    expect(indexes.includes("idx_interaction_session_processed")).toBe(true);

    closeDatabaseGracefully(db);
  });

  it("migrations are idempotent — running twice does not throw", () => {
    const db = createTestDb();
    runInteractionMigrations(db);

    let threw = false;
    try {
      runInteractionMigrations(db);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    closeDatabaseGracefully(db);
  });

  it("returns applied migration IDs on first run, empty on second", () => {
    const db = createTestDb();
    const applied1 = runInteractionMigrations(db);
    expect(applied1.length).toBe(2);
    expect(applied1[0]).toBe("interaction:001:create-interaction-records");
    expect(applied1[1]).toBe("interaction:002:add-turn-settlement");

    const applied2 = runInteractionMigrations(db);
    expect(applied2.length).toBe(0);

    closeDatabaseGracefully(db);
  });

  it("creates recent_cognition_slots table after migrations", () => {
    const db = createTestDb();
    runInteractionMigrations(db);

    const table = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recent_cognition_slots'",
    );
    expect(table?.name).toBe("recent_cognition_slots");

    closeDatabaseGracefully(db);
  });
});

// ─── InteractionStore ─────────────────────────────────────────────────────────

describe("InteractionStore", () => {
  let db: Db;
  let store: InteractionStore;

  beforeEach(() => {
    db = createTestDb();
    runInteractionMigrations(db);
    store = new InteractionStore(db);
  });

  it("commit: inserts a record and retrieves it", () => {
    const record: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "rec-001",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: { role: "user", content: "hello" },
      committedAt: 1000,
    };

    store.commit(record);

    const results = store.getBySession("sess-1");
    expect(results.length).toBe(1);
    expect(results[0].recordId).toBe("rec-001");
    expect(results[0].sessionId).toBe("sess-1");
    expect(results[0].recordIndex).toBe(0);
    expect(results[0].actorType).toBe("user");
    expect(results[0].recordType).toBe("message");
    expect((results[0].payload as { content: string }).content).toBe("hello");
    expect(results[0].committedAt).toBe(1000);

    closeDatabaseGracefully(db);
  });

  it("commit: preserves correlatedTurnId", () => {
    const record: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "rec-002",
      recordIndex: 0,
      actorType: "rp_agent",
      recordType: "message",
      payload: { role: "assistant", content: "hi" },
      correlatedTurnId: "turn-42",
      committedAt: 2000,
    };

    store.commit(record);
    const results = store.getBySession("sess-1");
    expect(results[0].correlatedTurnId).toBe("turn-42");

    closeDatabaseGracefully(db);
  });

  it("commit: throws INTERACTION_DUPLICATE_RECORD on duplicate recordId", () => {
    const record: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "dup-id",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: {},
      committedAt: 1000,
    };

    store.commit(record);

    let caughtError: unknown = null;
    try {
      store.commit({ ...record, recordIndex: 1 });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError !== null).toBe(true);
    expect(caughtError instanceof MaidsClawError).toBe(true);
    expect((caughtError as MaidsClawError).code).toBe("INTERACTION_DUPLICATE_RECORD");
  });

  it("runInTransaction: commits all records or none on failure", () => {
    const successSessionId = "sess-tx-ok";
    store.runInTransaction((txStore) => {
      txStore.commit({
        sessionId: successSessionId,
        recordId: "tx-ok-0",
        recordIndex: 0,
        actorType: "user",
        recordType: "message",
        payload: { value: 0 },
        committedAt: 1000,
      });
      txStore.commit({
        sessionId: successSessionId,
        recordId: "tx-ok-1",
        recordIndex: 1,
        actorType: "rp_agent",
        recordType: "message",
        payload: { value: 1 },
        committedAt: 1001,
      });
    });

    const committed = store.getBySession(successSessionId);
    expect(committed.length).toBe(2);

    const rollbackSessionId = "sess-tx-rb";
    let threw = false;
    try {
      store.runInTransaction((txStore) => {
        txStore.commit({
          sessionId: rollbackSessionId,
          recordId: "tx-rb-0",
          recordIndex: 0,
          actorType: "user",
          recordType: "message",
          payload: { value: 0 },
          committedAt: 2000,
        });
        throw new Error("force rollback");
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(store.getBySession(rollbackSessionId).length).toBe(0);

    closeDatabaseGracefully(db);
  });

  it("settlementExists: returns false before commit and true after turn_settlement commit", () => {
    const settlementId = "settlement-1";
    expect(store.settlementExists(settlementId)).toBe(false);

    store.commit({
      sessionId: "sess-settlement",
      recordId: settlementId,
      recordIndex: 0,
      actorType: "system",
      recordType: "turn_settlement",
      payload: { settlementId },
      committedAt: 3000,
    });

    expect(store.settlementExists(settlementId)).toBe(true);
    expect(store.settlementExists("missing-settlement")).toBe(false);

    closeDatabaseGracefully(db);
  });

  it("getBySession: returns records in order by recordIndex", () => {
    for (let i = 0; i < 5; i++) {
      store.commit({
        sessionId: "sess-order",
        recordId: `rec-${i}`,
        recordIndex: i,
        actorType: "user",
        recordType: "message",
        payload: { idx: i },
        committedAt: 1000 + i,
      });
    }

    const results = store.getBySession("sess-order");
    expect(results.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(results[i].recordIndex).toBe(i);
    }

    closeDatabaseGracefully(db);
  });

  it("getBySession: filters by fromIndex and toIndex", () => {
    for (let i = 0; i < 10; i++) {
      store.commit({
        sessionId: "sess-range",
        recordId: `rec-${i}`,
        recordIndex: i,
        actorType: "user",
        recordType: "message",
        payload: {},
        committedAt: 1000,
      });
    }

    const results = store.getBySession("sess-range", { fromIndex: 3, toIndex: 7 });
    expect(results.length).toBe(5);
    expect(results[0].recordIndex).toBe(3);
    expect(results[4].recordIndex).toBe(7);

    closeDatabaseGracefully(db);
  });

  it("getBySession: respects limit", () => {
    for (let i = 0; i < 10; i++) {
      store.commit({
        sessionId: "sess-limit",
        recordId: `rec-${i}`,
        recordIndex: i,
        actorType: "user",
        recordType: "message",
        payload: {},
        committedAt: 1000,
      });
    }

    const results = store.getBySession("sess-limit", { limit: 3 });
    expect(results.length).toBe(3);
    expect(results[0].recordIndex).toBe(0);
    expect(results[2].recordIndex).toBe(2);

    closeDatabaseGracefully(db);
  });

  it("getBySession: returns empty for nonexistent session", () => {
    const results = store.getBySession("no-such-session");
    expect(results.length).toBe(0);

    closeDatabaseGracefully(db);
  });

  it("getByRange: returns records within inclusive range", () => {
    for (let i = 0; i < 10; i++) {
      store.commit({
        sessionId: "sess-r",
        recordId: `r-${i}`,
        recordIndex: i,
        actorType: "system",
        recordType: "status",
        payload: {},
        committedAt: 1000,
      });
    }

    const results = store.getByRange("sess-r", 2, 5);
    expect(results.length).toBe(4);
    expect(results[0].recordIndex).toBe(2);
    expect(results[3].recordIndex).toBe(5);

    closeDatabaseGracefully(db);
  });

  it("markProcessed: marks records up to given index", () => {
    for (let i = 0; i < 5; i++) {
      store.commit({
        sessionId: "sess-mp",
        recordId: `mp-${i}`,
        recordIndex: i,
        actorType: "user",
        recordType: "message",
        payload: {},
        committedAt: 1000,
      });
    }

    store.markProcessed("sess-mp", 2);

    // Records 0-2 should be processed, 3-4 should not
    const count = store.countUnprocessedRpTurns("sess-mp");
    expect(count).toBe(2); // indices 3, 4

    closeDatabaseGracefully(db);
  });

  it("countUnprocessedRpTurns: only counts user/rp_agent message records", () => {
    // user message — should count
    store.commit({
      sessionId: "sess-count",
      recordId: "c-0",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: {},
      committedAt: 1000,
    });
    // rp_agent message — should count
    store.commit({
      sessionId: "sess-count",
      recordId: "c-1",
      recordIndex: 1,
      actorType: "rp_agent",
      recordType: "message",
      payload: {},
      committedAt: 1001,
    });
    // system status — should NOT count
    store.commit({
      sessionId: "sess-count",
      recordId: "c-2",
      recordIndex: 2,
      actorType: "system",
      recordType: "status",
      payload: {},
      committedAt: 1002,
    });
    // user tool_call — should NOT count (wrong recordType)
    store.commit({
      sessionId: "sess-count",
      recordId: "c-3",
      recordIndex: 3,
      actorType: "user",
      recordType: "tool_call",
      payload: {},
      committedAt: 1003,
    });
    // maiden message — should NOT count (wrong actorType)
    store.commit({
      sessionId: "sess-count",
      recordId: "c-4",
      recordIndex: 4,
      actorType: "maiden",
      recordType: "message",
      payload: {},
      committedAt: 1004,
    });

    const count = store.countUnprocessedRpTurns("sess-count");
    expect(count).toBe(2);

    closeDatabaseGracefully(db);
  });

  it("getMinMaxUnprocessedIndex: returns correct min/max", () => {
    for (let i = 0; i < 5; i++) {
      store.commit({
        sessionId: "sess-mm",
        recordId: `mm-${i}`,
        recordIndex: i,
        actorType: "user",
        recordType: "message",
        payload: {},
        committedAt: 1000,
      });
    }

    store.markProcessed("sess-mm", 1);

    const range = store.getMinMaxUnprocessedIndex("sess-mm");
    expect(range !== undefined).toBe(true);
    expect(range!.min).toBe(2);
    expect(range!.max).toBe(4);

    closeDatabaseGracefully(db);
  });

  it("getMinMaxUnprocessedIndex: returns undefined when all processed", () => {
    store.commit({
      sessionId: "sess-allp",
      recordId: "ap-0",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: {},
      committedAt: 1000,
    });
    store.markProcessed("sess-allp", 0);

    const range = store.getMinMaxUnprocessedIndex("sess-allp");
    expect(range).toBeUndefined();

    closeDatabaseGracefully(db);
  });

  it("getMaxIndex: returns max index for session", () => {
    for (let i = 0; i < 3; i++) {
      store.commit({
        sessionId: "sess-max",
        recordId: `max-${i}`,
        recordIndex: i,
        actorType: "user",
        recordType: "message",
        payload: {},
        committedAt: 1000,
      });
    }

    expect(store.getMaxIndex("sess-max")).toBe(2);

    closeDatabaseGracefully(db);
  });

  it("getMaxIndex: returns undefined for empty session", () => {
    expect(store.getMaxIndex("no-session")).toBeUndefined();

    closeDatabaseGracefully(db);
  });

  it("session isolation: records from different sessions don't mix", () => {
    store.commit({
      sessionId: "sess-a",
      recordId: "a-0",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: { from: "a" },
      committedAt: 1000,
    });
    store.commit({
      sessionId: "sess-b",
      recordId: "b-0",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: { from: "b" },
      committedAt: 1000,
    });

    const aRecords = store.getBySession("sess-a");
    const bRecords = store.getBySession("sess-b");
    expect(aRecords.length).toBe(1);
    expect(bRecords.length).toBe(1);
    expect((aRecords[0].payload as { from: string }).from).toBe("a");
    expect((bRecords[0].payload as { from: string }).from).toBe("b");

    closeDatabaseGracefully(db);
  });

  it("payload serialization: complex objects round-trip correctly", () => {
    const complexPayload = {
      nested: { deep: { value: 42 } },
      array: [1, "two", { three: true }],
      nullVal: null,
    };

    store.commit({
      sessionId: "sess-pl",
      recordId: "pl-0",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: complexPayload,
      committedAt: 1000,
    });

    const results = store.getBySession("sess-pl");
    const payload = results[0].payload as typeof complexPayload;
    expect(payload.nested.deep.value).toBe(42);
    expect(payload.array.length).toBe(3);
    expect(payload.nullVal).toBeNull();

    closeDatabaseGracefully(db);
  });
});

// ─── CommitService ────────────────────────────────────────────────────────────

describe("CommitService", () => {
  let db: Db;
  let store: InteractionStore;
  let service: CommitService;

  beforeEach(() => {
    db = createTestDb();
    runInteractionMigrations(db);
    store = new InteractionStore(db);
    service = new CommitService(store);
  });

  it("assigns recordId, recordIndex=0, and committedAt", () => {
    const before = Date.now();
    const record = service.commit(makeCommitInput());
    const after = Date.now();

    expect(record.recordId.length).toBeGreaterThan(0);
    expect(record.recordIndex).toBe(0);
    expect(record.committedAt >= before).toBe(true);
    expect(record.committedAt <= after).toBe(true);

    closeDatabaseGracefully(db);
  });

  it("auto-increments recordIndex per session", () => {
    const r0 = service.commit(makeCommitInput({ sessionId: "sess-ai" }));
    const r1 = service.commit(makeCommitInput({ sessionId: "sess-ai" }));
    const r2 = service.commit(makeCommitInput({ sessionId: "sess-ai" }));

    expect(r0.recordIndex).toBe(0);
    expect(r1.recordIndex).toBe(1);
    expect(r2.recordIndex).toBe(2);

    closeDatabaseGracefully(db);
  });

  it("recordIndex is session-scoped: different sessions start at 0", () => {
    const a0 = service.commit(makeCommitInput({ sessionId: "sess-x" }));
    const b0 = service.commit(makeCommitInput({ sessionId: "sess-y" }));
    const a1 = service.commit(makeCommitInput({ sessionId: "sess-x" }));

    expect(a0.recordIndex).toBe(0);
    expect(b0.recordIndex).toBe(0);
    expect(a1.recordIndex).toBe(1);

    closeDatabaseGracefully(db);
  });

  it("commitBatch: assigns consecutive recordIndex values inside one transaction", () => {
    service.commit(makeCommitInput({ sessionId: "sess-batch" }));

    const records = service.commitBatch([
      makeCommitInput({ sessionId: "sess-batch", actorType: "user", payload: { n: 0 } }),
      makeCommitInput({ sessionId: "sess-batch", actorType: "rp_agent", payload: { n: 1 } }),
      makeCommitInput({ sessionId: "sess-batch", actorType: "maiden", recordType: "status", payload: { n: 2 } }),
    ]);

    expect(records.length).toBe(3);
    expect(records[0].recordIndex).toBe(1);
    expect(records[1].recordIndex).toBe(2);
    expect(records[2].recordIndex).toBe(3);

    const persisted = store.getBySession("sess-batch");
    expect(persisted.length).toBe(4);
    expect(persisted[1].recordIndex).toBe(1);
    expect(persisted[2].recordIndex).toBe(2);
    expect(persisted[3].recordIndex).toBe(3);

    closeDatabaseGracefully(db);
  });

  it("commitWithId: accepts custom recordId for turn_settlement", () => {
    const record = service.commitWithId({
      ...makeCommitInput({
        sessionId: "sess-custom-settlement",
        actorType: "system",
        recordType: "turn_settlement",
        payload: { settlementId: "settlement-custom" },
      }),
      recordId: "settlement-custom",
    });

    expect(record.recordId).toBe("settlement-custom");
    expect(record.recordType).toBe("turn_settlement");
    expect(store.settlementExists("settlement-custom")).toBe(true);

    closeDatabaseGracefully(db);
  });

  it("commitWithId: rejects custom recordId for non-turn_settlement record type", () => {
    let caughtError: unknown = null;
    try {
      service.commitWithId({
        ...makeCommitInput({
          sessionId: "sess-custom-invalid",
          recordType: "message",
        }),
        recordId: "not-allowed",
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError !== null).toBe(true);
    expect(caughtError instanceof MaidsClawError).toBe(true);
    expect((caughtError as MaidsClawError).code).toBe("INTERACTION_INVALID_FIELD");

    closeDatabaseGracefully(db);
  });

  it("preserves correlatedTurnId when provided", () => {
    const record = service.commit(
      makeCommitInput({ correlatedTurnId: "turn-99" }),
    );
    expect(record.correlatedTurnId).toBe("turn-99");

    const fetched = store.getBySession(record.sessionId);
    expect(fetched[0].correlatedTurnId).toBe("turn-99");

    closeDatabaseGracefully(db);
  });

  it("correlatedTurnId is undefined when not provided", () => {
    const record = service.commit(makeCommitInput());
    expect(record.correlatedTurnId).toBeUndefined();

    closeDatabaseGracefully(db);
  });

  it("generates unique recordIds", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const record = service.commit(makeCommitInput({ sessionId: "sess-uid" }));
      ids.add(record.recordId);
    }
    expect(ids.size).toBe(20);

    closeDatabaseGracefully(db);
  });

  it("validates actorType: rejects invalid value", () => {
    let caughtError: unknown = null;
    try {
      service.commit(makeCommitInput({ actorType: "invalid_actor" as any }));
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError !== null).toBe(true);
    expect(caughtError instanceof MaidsClawError).toBe(true);
    expect((caughtError as MaidsClawError).code).toBe("INTERACTION_INVALID_FIELD");
  });

  it("validates recordType: rejects invalid value", () => {
    let caughtError: unknown = null;
    try {
      service.commit(makeCommitInput({ recordType: "bogus" as any }));
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError !== null).toBe(true);
    expect(caughtError instanceof MaidsClawError).toBe(true);
    expect((caughtError as MaidsClawError).code).toBe("INTERACTION_INVALID_FIELD");
  });

  it("accepts all valid actorType values", () => {
    const actorTypes = ["user", "rp_agent", "maiden", "task_agent", "system", "autonomy"] as const;
    let threw = false;
    try {
      for (const at of actorTypes) {
        service.commit(makeCommitInput({ sessionId: `sess-at-${at}`, actorType: at }));
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    closeDatabaseGracefully(db);
  });

  it("accepts all valid recordType values", () => {
    const recordTypes = [
      "message", "tool_call", "tool_result", "delegation",
      "task_result", "schedule_trigger", "status", "turn_settlement",
    ] as const;
    let threw = false;
    try {
      for (const rt of recordTypes) {
        service.commit(makeCommitInput({ sessionId: `sess-rt-${rt}`, recordType: rt }));
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    closeDatabaseGracefully(db);
  });

  it("committed record is persisted and retrievable", () => {
    const record = service.commit(makeCommitInput({ payload: { test: "value" } }));
    const fetched = store.getBySession(record.sessionId);

    expect(fetched.length).toBe(1);
    expect(fetched[0].recordId).toBe(record.recordId);
    expect((fetched[0].payload as { test: string }).test).toBe("value");

    closeDatabaseGracefully(db);
  });
});

// ─── FlushSelector ────────────────────────────────────────────────────────────

describe("FlushSelector", () => {
  let db: Db;
  let store: InteractionStore;
  let service: CommitService;
  let selector: FlushSelector;

  beforeEach(() => {
    db = createTestDb();
    runInteractionMigrations(db);
    store = new InteractionStore(db);
    service = new CommitService(store);
    selector = new FlushSelector(store);
  });

  it("shouldFlush: returns null when fewer than 10 RP dialogue turns", () => {
    for (let i = 0; i < 9; i++) {
      service.commit(makeCommitInput({
        sessionId: "sess-fl",
        actorType: i % 2 === 0 ? "user" : "rp_agent",
      }));
    }

    const result = selector.shouldFlush("sess-fl", "agent-1");
    expect(result).toBeNull();

    closeDatabaseGracefully(db);
  });

  it("shouldFlush: returns MemoryFlushRequest when 10+ RP dialogue turns", () => {
    for (let i = 0; i < 12; i++) {
      service.commit(makeCommitInput({
        sessionId: "sess-fl10",
        actorType: i % 2 === 0 ? "user" : "rp_agent",
      }));
    }

    const result = selector.shouldFlush("sess-fl10", "agent-1");
    expect(result !== null).toBe(true);
    expect(result!.sessionId).toBe("sess-fl10");
    expect(result!.agentId).toBe("agent-1");
    expect(result!.flushMode).toBe("dialogue_slice");
    expect(result!.rangeStart).toBe(0);
    expect(result!.rangeEnd).toBe(11);
    expect(result!.idempotencyKey).toBe("memory.migrate:sess-fl10:0-11");

    closeDatabaseGracefully(db);
  });

  it("shouldFlush: non-RP turns don't count toward threshold", () => {
    // 9 RP dialogue turns
    for (let i = 0; i < 9; i++) {
      service.commit(makeCommitInput({
        sessionId: "sess-non-rp",
        actorType: "user",
      }));
    }
    // Add 5 system status records — should NOT count
    for (let i = 0; i < 5; i++) {
      service.commit(makeCommitInput({
        sessionId: "sess-non-rp",
        actorType: "system",
        recordType: "status",
      }));
    }

    const result = selector.shouldFlush("sess-non-rp", "agent-1");
    expect(result).toBeNull();

    closeDatabaseGracefully(db);
  });

  it("shouldFlush: returns null for empty session", () => {
    const result = selector.shouldFlush("nonexistent", "agent-1");
    expect(result).toBeNull();

    closeDatabaseGracefully(db);
  });

  it("shouldFlush: already-processed turns don't count", () => {
    for (let i = 0; i < 12; i++) {
      service.commit(makeCommitInput({
        sessionId: "sess-proc",
        actorType: "user",
      }));
    }
    // Mark first 5 as processed
    store.markProcessed("sess-proc", 4);

    // Now only 7 unprocessed user messages (indices 5-11)
    const result = selector.shouldFlush("sess-proc", "agent-1");
    expect(result).toBeNull();

    closeDatabaseGracefully(db);
  });

  it("buildSessionCloseFlush: returns flush for any unprocessed records", () => {
    service.commit(makeCommitInput({ sessionId: "sess-close", actorType: "system", recordType: "status" }));
    service.commit(makeCommitInput({ sessionId: "sess-close", actorType: "user" }));

    const result = selector.buildSessionCloseFlush("sess-close", "agent-2");
    expect(result !== null).toBe(true);
    expect(result!.sessionId).toBe("sess-close");
    expect(result!.agentId).toBe("agent-2");
    expect(result!.flushMode).toBe("session_close");
    expect(result!.rangeStart).toBe(0);
    expect(result!.rangeEnd).toBe(1);
    expect(result!.idempotencyKey).toBe("memory.migrate:sess-close:0-1");

    closeDatabaseGracefully(db);
  });

  it("buildSessionCloseFlush: returns null when all records processed", () => {
    service.commit(makeCommitInput({ sessionId: "sess-all-done" }));
    store.markProcessed("sess-all-done", 0);

    const result = selector.buildSessionCloseFlush("sess-all-done", "agent-1");
    expect(result).toBeNull();

    closeDatabaseGracefully(db);
  });

  it("buildSessionCloseFlush: returns null for empty session", () => {
    const result = selector.buildSessionCloseFlush("nonexistent", "agent-1");
    expect(result).toBeNull();

    closeDatabaseGracefully(db);
  });

  it("idempotencyKey format matches job key pattern", () => {
    for (let i = 0; i < 10; i++) {
      service.commit(makeCommitInput({
        sessionId: "sess-key",
        actorType: "user",
      }));
    }

    const result = selector.shouldFlush("sess-key", "agent-1");
    expect(result !== null).toBe(true);
    // Pattern: memory.migrate:{sessionId}:{rangeStart}-{rangeEnd}
    const keyRegex = /^memory\.migrate:sess-key:\d+-\d+$/;
    expect(keyRegex.test(result!.idempotencyKey)).toBe(true);

    closeDatabaseGracefully(db);
  });
});

// ─── Append-Only Invariant ────────────────────────────────────────────────────

describe("Append-Only Invariant", () => {
  it("committed records persist across multiple reads", () => {
    const db = createTestDb();
    runInteractionMigrations(db);
    const store = new InteractionStore(db);
    const service = new CommitService(store);

    const r0 = service.commit(makeCommitInput({ sessionId: "sess-inv" }));
    const r1 = service.commit(makeCommitInput({ sessionId: "sess-inv" }));

    // Read multiple times — same result
    const read1 = store.getBySession("sess-inv");
    const read2 = store.getBySession("sess-inv");
    expect(read1.length).toBe(2);
    expect(read2.length).toBe(2);
    expect(read1[0].recordId).toBe(r0.recordId);
    expect(read2[0].recordId).toBe(r0.recordId);

    closeDatabaseGracefully(db);
  });

  it("markProcessed does not delete records", () => {
    const db = createTestDb();
    runInteractionMigrations(db);
    const store = new InteractionStore(db);
    const service = new CommitService(store);

    for (let i = 0; i < 5; i++) {
      service.commit(makeCommitInput({ sessionId: "sess-nodl" }));
    }

    store.markProcessed("sess-nodl", 4);

    // All records still retrievable
    const results = store.getBySession("sess-nodl");
    expect(results.length).toBe(5);

    closeDatabaseGracefully(db);
  });
});

// ─── Integration ──────────────────────────────────────────────────────────────

describe("Integration: CommitService + FlushSelector", () => {
  it("end-to-end: commit dialogue, trigger flush, mark processed, no re-flush", () => {
    const db = createTestDb();
    runInteractionMigrations(db);
    const store = new InteractionStore(db);
    const service = new CommitService(store);
    const selector = new FlushSelector(store);

    // Commit 10 dialogue turns (user/rp_agent alternating)
    for (let i = 0; i < 10; i++) {
      service.commit(makeCommitInput({
        sessionId: "sess-e2e",
        actorType: i % 2 === 0 ? "user" : "rp_agent",
      }));
    }

    // Should trigger flush
    const flush1 = selector.shouldFlush("sess-e2e", "agent-e2e");
    expect(flush1 !== null).toBe(true);
    expect(flush1!.rangeStart).toBe(0);
    expect(flush1!.rangeEnd).toBe(9);

    // Mark as processed
    store.markProcessed("sess-e2e", flush1!.rangeEnd);

    // Should no longer trigger
    const flush2 = selector.shouldFlush("sess-e2e", "agent-e2e");
    expect(flush2).toBeNull();

    // Session close should also return null — all processed
    const closeFlush = selector.buildSessionCloseFlush("sess-e2e", "agent-e2e");
    expect(closeFlush).toBeNull();

    closeDatabaseGracefully(db);
  });

  it("end-to-end: partial processing leaves remaining for session close", () => {
    const db = createTestDb();
    runInteractionMigrations(db);
    const store = new InteractionStore(db);
    const service = new CommitService(store);
    const selector = new FlushSelector(store);

    for (let i = 0; i < 5; i++) {
      service.commit(makeCommitInput({
        sessionId: "sess-partial",
        actorType: "user",
      }));
    }

    // Mark first 2 processed
    store.markProcessed("sess-partial", 1);

    // Not enough for dialogue flush (only 3 unprocessed)
    const flush = selector.shouldFlush("sess-partial", "agent-p");
    expect(flush).toBeNull();

    // But session close should pick up remaining
    const closeFlush = selector.buildSessionCloseFlush("sess-partial", "agent-p");
    expect(closeFlush !== null).toBe(true);
    expect(closeFlush!.rangeStart).toBe(2);
    expect(closeFlush!.rangeEnd).toBe(4);
    expect(closeFlush!.flushMode).toBe("session_close");

    closeDatabaseGracefully(db);
  });
});
