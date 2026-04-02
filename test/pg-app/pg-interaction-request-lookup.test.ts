import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import type { InteractionRecord } from "../../src/interaction/contracts.js";
import { PgInteractionRepo } from "../../src/storage/domain-repos/pg/interaction-repo.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("PgInteractionRepo — request lookup & stale settlement", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    sql = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(sql);
  });

  function makeRecord(
    overrides: Partial<InteractionRecord> & { sessionId: string },
  ): InteractionRecord {
    return {
      recordId: crypto.randomUUID(),
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: { role: "user", content: "hello" },
      committedAt: Date.now(),
      ...overrides,
    };
  }

  it("getSettlementPayload returns latest settlement payload for session+request", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);
      const repo = new PgInteractionRepo(pool);

      await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-sp-1', 'agent-1', ${Date.now()})`;
      await repo.commit(
        makeRecord({
          sessionId: "sess-sp-1",
          recordId: "stl-old",
          recordIndex: 0,
          actorType: "system",
          recordType: "turn_settlement",
          payload: {
            settlementId: "stl-old",
            requestId: "req-1",
            sessionId: "sess-sp-1",
            ownerAgentId: "rp:alice",
            publicReply: "old reply",
            hasPublicReply: true,
          },
          correlatedTurnId: "req-1",
          committedAt: 1000,
        }),
      );
      await repo.commit(
        makeRecord({
          sessionId: "sess-sp-1",
          recordId: "stl-new",
          recordIndex: 1,
          actorType: "system",
          recordType: "turn_settlement",
          payload: {
            settlementId: "stl-new",
            requestId: "req-1",
            sessionId: "sess-sp-1",
            ownerAgentId: "rp:alice",
            publicReply: "new reply",
            hasPublicReply: true,
          },
          correlatedTurnId: "req-1",
          committedAt: 1001,
        }),
      );

      const payload = await repo.getSettlementPayload("sess-sp-1", "req-1");
      expect(payload).toBeDefined();
      expect(payload!.settlementId).toBe("stl-new");
      expect(payload!.requestId).toBe("req-1");
    });
  });

  it("getSettlementPayload returns undefined when settlement is missing", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);
      const repo = new PgInteractionRepo(pool);

      await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-sp-2', 'agent-1', ${Date.now()})`;

      await repo.commit(
        makeRecord({
          sessionId: "sess-sp-2",
          recordId: "msg-only",
          recordIndex: 0,
          actorType: "user",
          recordType: "message",
          payload: { role: "user", content: "no settlement" },
          correlatedTurnId: "req-2",
          committedAt: 1000,
        }),
      );

      const payload = await repo.getSettlementPayload("sess-sp-2", "req-2");
      expect(payload).toBeUndefined();
    });
  });

  it("getMessageRecords returns only message records, excluding status and settlement", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);
      const repo = new PgInteractionRepo(pool);

      await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-mr', 'agent-1', ${Date.now()})`;
      await repo.commit(
        makeRecord({
          sessionId: "sess-mr",
          recordId: "msg-1",
          recordIndex: 0,
          actorType: "user",
          recordType: "message",
          payload: { role: "user", content: "u1" },
          committedAt: 1000,
        }),
      );
      await repo.commit(
        makeRecord({
          sessionId: "sess-mr",
          recordId: "status-1",
          recordIndex: 1,
          actorType: "system",
          recordType: "status",
          payload: { event: "tick" },
          committedAt: 1001,
        }),
      );
      await repo.commit(
        makeRecord({
          sessionId: "sess-mr",
          recordId: "msg-2",
          recordIndex: 2,
          actorType: "rp_agent",
          recordType: "message",
          payload: { role: "assistant", content: "a1" },
          committedAt: 1002,
        }),
      );
      await repo.commit(
        makeRecord({
          sessionId: "sess-mr",
          recordId: "stl-1",
          recordIndex: 3,
          actorType: "system",
          recordType: "turn_settlement",
          payload: { settlementId: "stl-1" },
          committedAt: 1003,
        }),
      );

      const messages = await repo.getMessageRecords("sess-mr");
      expect(messages).toHaveLength(2);
      expect(messages[0].recordId).toBe("msg-1");
      expect(messages[1].recordId).toBe("msg-2");
      expect(messages[0].recordType).toBe("message");
      expect(messages[1].recordType).toBe("message");
      expect(messages[0].recordIndex).toBe(0);
      expect(messages[1].recordIndex).toBe(2);
    });
  });

  it("findSessionIdByRequestId throws REQUEST_ID_AMBIGUOUS when request maps to multiple sessions", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);
      const repo = new PgInteractionRepo(pool);

      await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-a', 'agent-1', ${Date.now()})`;
      await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-b', 'agent-1', ${Date.now()})`;

      await repo.commit(
        makeRecord({
          sessionId: "sess-a",
          recordId: "msg-a",
          recordIndex: 0,
          correlatedTurnId: "req-shared",
          committedAt: 1000,
        }),
      );
      await repo.commit(
        makeRecord({
          sessionId: "sess-b",
          recordId: "msg-b",
          recordIndex: 0,
          correlatedTurnId: "req-shared",
          committedAt: 1001,
        }),
      );

      let caught: unknown = null;
      try {
        await repo.findSessionIdByRequestId("req-shared");
      } catch (err) {
        caught = err;
      }

      expect(caught).not.toBeNull();
      expect((caught as { code: string }).code).toBe("REQUEST_ID_AMBIGUOUS");
    });
  });

  it("listStalePendingSettlementSessions returns sessions with stale unprocessed settlements", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);
      const repo = new PgInteractionRepo(pool);

      await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-stale', 'rp:alice', ${Date.now()})`;

      const staleCutoffMs = 5000;
      const oldTimestamp = Date.now() - staleCutoffMs - 1000;

      await repo.commit(
        makeRecord({
          sessionId: "sess-stale",
          recordId: "stl-stale-1",
          recordIndex: 0,
          actorType: "system",
          recordType: "turn_settlement",
          payload: {
            settlementId: "stl-stale-1",
            ownerAgentId: "rp:alice",
          },
          committedAt: oldTimestamp,
        }),
      );

      const stale = await repo.listStalePendingSettlementSessions(staleCutoffMs);
      expect(stale.length).toBeGreaterThanOrEqual(1);

      const entry = stale.find((s) => s.sessionId === "sess-stale");
      expect(entry).toBeDefined();
      expect(entry!.agentId).toBe("rp:alice");
      expect(entry!.oldestSettlementAt).toBe(oldTimestamp);
    });
  });

  it("listStalePendingSettlementSessions excludes recently committed settlements", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);
      const repo = new PgInteractionRepo(pool);

      await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-fresh', 'rp:alice', ${Date.now()})`;

      const staleCutoffMs = 60_000;

      await repo.commit(
        makeRecord({
          sessionId: "sess-fresh",
          recordId: "stl-fresh-1",
          recordIndex: 0,
          actorType: "system",
          recordType: "turn_settlement",
          payload: {
            settlementId: "stl-fresh-1",
            ownerAgentId: "rp:alice",
          },
          committedAt: Date.now(),
        }),
      );

      const stale = await repo.listStalePendingSettlementSessions(staleCutoffMs);
      const entry = stale.find((s) => s.sessionId === "sess-fresh");
      expect(entry).toBeUndefined();
    });
  });

  it("listStalePendingSettlementSessions ignores processed settlements", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapOpsSchema(pool);
      const repo = new PgInteractionRepo(pool);

      await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-proc', 'rp:alice', ${Date.now()})`;

      const staleCutoffMs = 5000;
      const oldTimestamp = Date.now() - staleCutoffMs - 1000;

      await repo.commit(
        makeRecord({
          sessionId: "sess-proc",
          recordId: "stl-proc-1",
          recordIndex: 0,
          actorType: "system",
          recordType: "turn_settlement",
          payload: {
            settlementId: "stl-proc-1",
            ownerAgentId: "rp:alice",
          },
          committedAt: oldTimestamp,
        }),
      );

      await repo.markProcessed("sess-proc", 0);

      const stale = await repo.listStalePendingSettlementSessions(staleCutoffMs);
      const entry = stale.find((s) => s.sessionId === "sess-proc");
      expect(entry).toBeUndefined();
    });
  });
});
