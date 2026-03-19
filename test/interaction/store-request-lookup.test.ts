import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MaidsClawError } from "../../src/core/errors.js";
import type { TurnSettlementPayload } from "../../src/interaction/contracts.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import { closeDatabaseGracefully, openDatabase } from "../../src/storage/database.js";
import type { Db } from "../../src/storage/database.js";

function createTestDb(): Db {
  return openDatabase({ path: ":memory:" });
}

function makeSettlementPayload(
  settlementId: string,
  requestId: string,
  sessionId: string,
): TurnSettlementPayload {
  return {
    settlementId,
    requestId,
    sessionId,
    ownerAgentId: "rp:alice",
    publicReply: "ok",
    hasPublicReply: true,
    viewerSnapshot: {
      selfPointerKey: "__self__",
      userPointerKey: "__user__",
    },
  };
}

describe("InteractionStore request/session lookup", () => {
  let db: Db;
  let store: InteractionStore;

  beforeEach(() => {
    db = createTestDb();
    runInteractionMigrations(db);
    store = new InteractionStore(db);
  });

  afterEach(() => {
    closeDatabaseGracefully(db);
  });

  it("findSessionIdByRequestId returns the unique matched session", () => {
    store.commit({
      sessionId: "sess-1",
      recordId: "msg-1",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: { role: "user", content: "hello" },
      correlatedTurnId: "req-1",
      committedAt: 1000,
    });
    store.commit({
      sessionId: "sess-1",
      recordId: "stl-1",
      recordIndex: 1,
      actorType: "system",
      recordType: "turn_settlement",
      payload: makeSettlementPayload("stl-1", "req-1", "sess-1"),
      correlatedTurnId: "req-1",
      committedAt: 1001,
    });

    expect(store.findSessionIdByRequestId("req-1")).toBe("sess-1");
  });

  it("findSessionIdByRequestId returns undefined when request is missing", () => {
    store.commit({
      sessionId: "sess-1",
      recordId: "msg-2",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: { role: "user", content: "hello" },
      correlatedTurnId: "req-other",
      committedAt: 1000,
    });

    expect(store.findSessionIdByRequestId("req-missing")).toBeUndefined();
  });

  it("findSessionIdByRequestId throws REQUEST_ID_AMBIGUOUS when request maps to multiple sessions", () => {
    store.commit({
      sessionId: "sess-a",
      recordId: "msg-a",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: { role: "user", content: "from a" },
      correlatedTurnId: "req-shared",
      committedAt: 1000,
    });
    store.commit({
      sessionId: "sess-b",
      recordId: "msg-b",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: { role: "user", content: "from b" },
      correlatedTurnId: "req-shared",
      committedAt: 1001,
    });

    let caught: unknown = null;
    try {
      store.findSessionIdByRequestId("req-shared");
    } catch (err) {
      caught = err;
    }

    expect(caught instanceof MaidsClawError).toBe(true);
    expect((caught as MaidsClawError).code).toBe("REQUEST_ID_AMBIGUOUS");
    expect((caught as MaidsClawError).message).toContain("req-shared");
  });

  it("getSettlementPayload returns latest settlement payload for session+request", () => {
    store.commit({
      sessionId: "sess-2",
      recordId: "stl-old",
      recordIndex: 0,
      actorType: "system",
      recordType: "turn_settlement",
      payload: makeSettlementPayload("stl-old", "req-2", "sess-2"),
      correlatedTurnId: "req-2",
      committedAt: 1000,
    });
    store.commit({
      sessionId: "sess-2",
      recordId: "stl-new",
      recordIndex: 1,
      actorType: "system",
      recordType: "turn_settlement",
      payload: makeSettlementPayload("stl-new", "req-2", "sess-2"),
      correlatedTurnId: "req-2",
      committedAt: 1001,
    });

    const payload = store.getSettlementPayload("sess-2", "req-2");
    expect(payload?.settlementId).toBe("stl-new");
    expect(payload?.requestId).toBe("req-2");
    expect(payload?.sessionId).toBe("sess-2");
  });

  it("getSettlementPayload returns undefined when settlement is missing", () => {
    store.commit({
      sessionId: "sess-3",
      recordId: "msg-3",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: { role: "user", content: "no settlement" },
      correlatedTurnId: "req-3",
      committedAt: 1000,
    });

    expect(store.getSettlementPayload("sess-3", "req-3")).toBeUndefined();
  });

  it("getMessageRecords returns only message records in record_index order", () => {
    store.commit({
      sessionId: "sess-4",
      recordId: "msg-1",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: { role: "user", content: "u1" },
      committedAt: 1000,
    });
    store.commit({
      sessionId: "sess-4",
      recordId: "status-1",
      recordIndex: 1,
      actorType: "system",
      recordType: "status",
      payload: { event: "tick" },
      committedAt: 1001,
    });
    store.commit({
      sessionId: "sess-4",
      recordId: "msg-2",
      recordIndex: 2,
      actorType: "rp_agent",
      recordType: "message",
      payload: { role: "assistant", content: "a1" },
      committedAt: 1002,
    });
    store.commit({
      sessionId: "sess-4",
      recordId: "stl-4",
      recordIndex: 3,
      actorType: "system",
      recordType: "turn_settlement",
      payload: makeSettlementPayload("stl-4", "req-4", "sess-4"),
      correlatedTurnId: "req-4",
      committedAt: 1003,
    });

    const messages = store.getMessageRecords("sess-4");
    expect(messages).toHaveLength(2);
    expect(messages[0].recordId).toBe("msg-1");
    expect(messages[1].recordId).toBe("msg-2");
    expect(messages[0].recordType).toBe("message");
    expect(messages[1].recordType).toBe("message");
  });
});
