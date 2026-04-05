import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  ensureTestPgAppDb,
  createTestPgAppPool,
  withTestAppSchema,
  teardownAppPool,
} from "../helpers/pg-app-test-utils.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { PgInteractionRepo } from "../../src/storage/domain-repos/pg/interaction-repo.js";
import { PgSessionRepo } from "../../src/storage/domain-repos/pg/session-repo.js";
import { PgRecentCognitionSlotRepo } from "../../src/storage/domain-repos/pg/recent-cognition-slot-repo.js";
import type { InteractionRecord } from "../../src/interaction/contracts.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("pg-interaction-session-repos", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    sql = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(sql);
  });

  function makeRecord(overrides: Partial<InteractionRecord> & { sessionId: string }): InteractionRecord {
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

  describe("PgInteractionRepo", () => {
    it("commits and retrieves a record", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgInteractionRepo(pool);

        await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-1', 'agent-1', ${Date.now()})`;

        const record = makeRecord({
          sessionId: "sess-1",
          payload: { role: "user", content: "Hello" },
        });
        await repo.commit(record);

        const records = await repo.getMessageRecords("sess-1");
        expect(records.length).toBe(1);
        expect(records[0].recordId).toBe(record.recordId);
        expect(records[0].payload).toEqual({ role: "user", content: "Hello" });
      });
    });

    it("rejects duplicate record IDs", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgInteractionRepo(pool);

        await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-dup', 'agent-1', ${Date.now()})`;

        const record = makeRecord({ sessionId: "sess-dup" });
        await repo.commit(record);

        try {
          await repo.commit({ ...record, recordIndex: 1 });
          expect(true).toBe(false);
        } catch (err: unknown) {
          expect((err as { code: string }).code).toBe("INTERACTION_DUPLICATE_RECORD");
        }
      });
    });

    it("getBySession with fromIndex/toIndex/limit", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgInteractionRepo(pool);

        await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-range', 'agent-1', ${Date.now()})`;

        for (let i = 0; i < 5; i++) {
          await repo.commit(
            makeRecord({ sessionId: "sess-range", recordIndex: i }),
          );
        }

        const ranged = await repo.getBySession("sess-range", { fromIndex: 1, toIndex: 3 });
        expect(ranged.length).toBe(3);
        expect(ranged[0].recordIndex).toBe(1);
        expect(ranged[2].recordIndex).toBe(3);

        const limited = await repo.getBySession("sess-range", { limit: 2 });
        expect(limited.length).toBe(2);
      });
    });

    it("markProcessed + countUnprocessedRpTurns", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgInteractionRepo(pool);

        await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-proc', 'agent-1', ${Date.now()})`;

        for (let i = 0; i < 3; i++) {
          await repo.commit(
            makeRecord({ sessionId: "sess-proc", recordIndex: i }),
          );
        }

        expect(await repo.countUnprocessedRpTurns("sess-proc")).toBe(3);

        await repo.markProcessed("sess-proc", 1);
        expect(await repo.countUnprocessedRpTurns("sess-proc")).toBe(1);
      });
    });

    it("markRangeProcessed", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgInteractionRepo(pool);

        await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-rp', 'agent-1', ${Date.now()})`;

        for (let i = 0; i < 5; i++) {
          await repo.commit(
            makeRecord({ sessionId: "sess-rp", recordIndex: i }),
          );
        }

        await repo.markRangeProcessed("sess-rp", 1, 3);
        const range = await repo.getMinMaxUnprocessedIndex("sess-rp");
        expect(range).toBeDefined();
        expect(range!.min).toBe(0);
        expect(range!.max).toBe(4);
      });
    });

    it("runInTransaction rolls back on error", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgInteractionRepo(pool);

        await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-tx', 'agent-1', ${Date.now()})`;

        try {
          await repo.runInTransaction(async ({ interactionRepo }) => {
            await interactionRepo.commit(
              makeRecord({ sessionId: "sess-tx", recordIndex: 0 }),
            );
            throw new Error("force rollback");
          });
        } catch (err: unknown) {
          expect((err as Error).message).toBe("force rollback");
        }

        const records = await repo.getBySession("sess-tx");
        expect(records.length).toBe(0);
      });
    });

    it("runInTransaction commits on success", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgInteractionRepo(pool);

        await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-tx-ok', 'agent-1', ${Date.now()})`;

        const result = await repo.runInTransaction(async ({ interactionRepo }) => {
          await interactionRepo.commit(
            makeRecord({
              sessionId: "sess-tx-ok",
              recordIndex: 0,
              payload: { role: "user", content: "committed" },
            }),
          );
          return "done";
        });

        expect(result).toBe("done");
        const records = await repo.getBySession("sess-tx-ok");
        expect(records.length).toBe(1);
        expect(records[0].payload).toEqual({ role: "user", content: "committed" });
      });
    });

    it("settlementExists", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgInteractionRepo(pool);

        await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-settle', 'agent-1', ${Date.now()})`;

        await repo.commit(
          makeRecord({
            sessionId: "sess-settle",
            recordId: "settle-1",
            actorType: "rp_agent",
            recordType: "turn_settlement",
            payload: { settlementId: "settle-1" },
          }),
        );

        expect(await repo.settlementExists("sess-settle", "settle-1")).toBe(true);
        expect(await repo.settlementExists("sess-settle", "nonexistent")).toBe(false);
      });
    });

    it("getMaxIndex", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgInteractionRepo(pool);

        expect(await repo.getMaxIndex("nonexistent")).toBeUndefined();

        await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-max', 'agent-1', ${Date.now()})`;

        for (let i = 0; i < 3; i++) {
          await repo.commit(
            makeRecord({ sessionId: "sess-max", recordIndex: i }),
          );
        }

        expect(await repo.getMaxIndex("sess-max")).toBe(2);
      });
    });

    it("getByRange", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgInteractionRepo(pool);

        await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-br', 'agent-1', ${Date.now()})`;

        for (let i = 0; i < 5; i++) {
          await repo.commit(
            makeRecord({ sessionId: "sess-br", recordIndex: i }),
          );
        }

        const range = await repo.getByRange("sess-br", 1, 3);
        expect(range.length).toBe(3);
        expect(range[0].recordIndex).toBe(1);
        expect(range[2].recordIndex).toBe(3);
      });
    });

    it("findRecordByCorrelatedTurnId", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgInteractionRepo(pool);

        await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-corr', 'agent-1', ${Date.now()})`;

        await repo.commit(
          makeRecord({
            sessionId: "sess-corr",
            correlatedTurnId: "req-123",
          }),
        );

        const found = await repo.findRecordByCorrelatedTurnId("sess-corr", "req-123", "user");
        expect(found).toBeDefined();
        expect(found!.correlatedTurnId).toBe("req-123");

        const notFound = await repo.findRecordByCorrelatedTurnId("sess-corr", "req-999", "user");
        expect(notFound).toBeUndefined();
      });
    });

    it("findSessionIdByRequestId", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgInteractionRepo(pool);

        await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-req', 'agent-1', ${Date.now()})`;

        await repo.commit(
          makeRecord({
            sessionId: "sess-req",
            correlatedTurnId: "req-find",
          }),
        );

        expect(await repo.findSessionIdByRequestId("req-find")).toBe("sess-req");
        expect(await repo.findSessionIdByRequestId("req-missing")).toBeUndefined();
      });
    });

    it("countUnprocessedSettlements + getUnprocessedSettlementRange", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgInteractionRepo(pool);

        await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-us', 'agent-1', ${Date.now()})`;

        for (let i = 0; i < 3; i++) {
          await repo.commit(
            makeRecord({
              sessionId: "sess-us",
              recordIndex: i,
              actorType: "rp_agent",
              recordType: "turn_settlement",
              payload: { settlementId: `s-${i}` },
            }),
          );
        }

        expect(await repo.countUnprocessedSettlements("sess-us")).toBe(3);

        const range = await repo.getUnprocessedSettlementRange("sess-us");
        expect(range).toEqual({ min: 0, max: 2 });

        await repo.markRangeProcessed("sess-us", 0, 1);
        expect(await repo.countUnprocessedSettlements("sess-us")).toBe(1);
      });
    });

    it("getUnprocessedRangeForSession", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgInteractionRepo(pool);

        expect(await repo.getUnprocessedRangeForSession("nonexistent")).toBeNull();

        await pool`INSERT INTO sessions (session_id, agent_id, created_at) VALUES ('sess-ur', 'agent-1', ${Date.now()})`;

        for (let i = 0; i < 3; i++) {
          await repo.commit(
            makeRecord({ sessionId: "sess-ur", recordIndex: i }),
          );
        }

        const range = await repo.getUnprocessedRangeForSession("sess-ur");
        expect(range).toEqual({ rangeStart: 0, rangeEnd: 2 });
      });
    });
  });

  describe("PgSessionRepo", () => {
    it("create and get session", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgSessionRepo(pool);

        const session = await repo.createSession("agent-1");
        expect(session.agentId).toBe("agent-1");
        expect(session.sessionId).toBeTruthy();
        expect(session.closedAt).toBeUndefined();

        const got = await repo.getSession(session.sessionId);
        expect(got).toBeDefined();
        expect(got!.agentId).toBe("agent-1");
        expect(got!.createdAt).toBe(session.createdAt);
      });
    });

    it("close session lifecycle", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgSessionRepo(pool);

        const session = await repo.createSession("agent-1");
        expect(await repo.isOpen(session.sessionId)).toBe(true);

        const closed = await repo.closeSession(session.sessionId);
        expect(closed.closedAt).toBeDefined();
        expect(await repo.isOpen(session.sessionId)).toBe(false);
      });
    });

    it("recovery required lifecycle", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgSessionRepo(pool);

        const session = await repo.createSession("agent-1");
        expect(await repo.requiresRecovery(session.sessionId)).toBe(false);

        await repo.markRecoveryRequired(session.sessionId);
        expect(await repo.requiresRecovery(session.sessionId)).toBe(true);
        expect(await repo.isRecoveryRequired(session.sessionId)).toBe(true);

        await repo.clearRecoveryRequired(session.sessionId);
        expect(await repo.requiresRecovery(session.sessionId)).toBe(false);
      });
    });

    it("setRecoveryRequired delegates to markRecoveryRequired", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgSessionRepo(pool);

        const session = await repo.createSession("agent-1");
        await repo.setRecoveryRequired(session.sessionId);
        expect(await repo.requiresRecovery(session.sessionId)).toBe(true);
      });
    });

    it("throws on close non-existent session", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgSessionRepo(pool);

        try {
          await repo.closeSession("nonexistent");
          expect(true).toBe(false);
        } catch (err: unknown) {
          expect((err as { code: string }).code).toBe("SESSION_NOT_FOUND");
        }
      });
    });

    it("throws on markRecoveryRequired for non-existent session", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgSessionRepo(pool);

        try {
          await repo.markRecoveryRequired("nonexistent");
          expect(true).toBe(false);
        } catch (err: unknown) {
          expect((err as { code: string }).code).toBe("SESSION_NOT_FOUND");
        }
      });
    });

    it("close clears recovery_required", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgSessionRepo(pool);

        const session = await repo.createSession("agent-1");
        await repo.markRecoveryRequired(session.sessionId);
        expect(await repo.requiresRecovery(session.sessionId)).toBe(true);

        await repo.closeSession(session.sessionId);
        expect(await repo.requiresRecovery(session.sessionId)).toBe(false);
      });
    });
  });

  describe("PgRecentCognitionSlotRepo", () => {
    it("upsert creates and appends entries", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgRecentCognitionSlotRepo(pool);

        await repo.upsertRecentCognitionSlot(
          "sess-cog",
          "agent-1",
          "settle-1",
          JSON.stringify([{ type: "thought", content: "thinking" }]),
        );

        const slot = await repo.getBySession("sess-cog", "agent-1");
        expect(slot).toBeDefined();
        expect(slot!.slotPayload.length).toBe(1);
        expect(slot!.lastSettlementId).toBe("settle-1");

        await repo.upsertRecentCognitionSlot(
          "sess-cog",
          "agent-1",
          "settle-2",
          JSON.stringify([{ type: "thought", content: "more thinking" }]),
        );

        const updated = await repo.getBySession("sess-cog", "agent-1");
        expect(updated!.slotPayload.length).toBe(2);
        expect(updated!.lastSettlementId).toBe("settle-2");
      });
    });

    it("deleteBySession removes all entries for session", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgRecentCognitionSlotRepo(pool);

        await repo.upsertRecentCognitionSlot("sess-del", "agent-1", "s1", "[]");
        await repo.upsertRecentCognitionSlot("sess-del", "agent-2", "s1", "[]");

        await repo.deleteBySession("sess-del");

        expect(await repo.getBySession("sess-del", "agent-1")).toBeUndefined();
        expect(await repo.getBySession("sess-del", "agent-2")).toBeUndefined();
      });
    });

    it("trims to 64 entries", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgRecentCognitionSlotRepo(pool);

        const entries = Array.from({ length: 70 }, (_, i) => ({ idx: i }));
        await repo.upsertRecentCognitionSlot("sess-trim", "agent-1", "s1", JSON.stringify(entries));

        const slot = await repo.getBySession("sess-trim", "agent-1");
        expect(slot!.slotPayload.length).toBe(64);
        expect((slot!.slotPayload[0] as { idx: number }).idx).toBe(6);
        expect((slot!.slotPayload[63] as { idx: number }).idx).toBe(69);
      });
    });

    it("handles invalid JSON gracefully", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgRecentCognitionSlotRepo(pool);

        await repo.upsertRecentCognitionSlot("sess-bad", "agent-1", "s1", "not-json");

        const slot = await repo.getBySession("sess-bad", "agent-1");
        expect(slot).toBeDefined();
        expect(slot!.slotPayload.length).toBe(0);
      });
    });

    it("talker versionIncrement increments counter without changing payload", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgRecentCognitionSlotRepo(pool);

        // First create a slot with some payload via thinker mode
        await repo.upsertRecentCognitionSlot(
          "sess-talker",
          "agent-1",
          "settle-1",
          JSON.stringify([{ type: "thought", content: "initial" }]),
          "thinker",
        );

        const slot1 = await repo.getBySession("sess-talker", "agent-1");
        expect(slot1!.talkerTurnCounter).toBe(0);
        expect(slot1!.thinkerCommittedVersion).toBe(1);
        expect(slot1!.slotPayload.length).toBe(1);

        // Now call with talker mode - counter increments, payload unchanged
        const result = await repo.upsertRecentCognitionSlot(
          "sess-talker",
          "agent-1",
          "settle-2",
          JSON.stringify([{ type: "thought", content: "new" }]),
          "talker",
        );

        expect(result.talkerTurnCounter).toBe(1);
        expect(result.thinkerCommittedVersion).toBeUndefined();

        const slot2 = await repo.getBySession("sess-talker", "agent-1");
        expect(slot2!.talkerTurnCounter).toBe(1);
        expect(slot2!.thinkerCommittedVersion).toBe(1);
        expect(slot2!.slotPayload.length).toBe(1);
        expect((slot2!.slotPayload[0] as { content: string }).content).toBe("initial");
      });
    });

    it("thinker versionIncrement increments version AND writes payload", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgRecentCognitionSlotRepo(pool);

        // First call as talker to increment counter
        await repo.upsertRecentCognitionSlot("sess-thinker", "agent-1", "settle-1", "[]", "talker");
        await repo.upsertRecentCognitionSlot("sess-thinker", "agent-1", "settle-2", "[]", "talker");

        const slot1 = await repo.getBySession("sess-thinker", "agent-1");
        expect(slot1!.talkerTurnCounter).toBe(2);
        expect(slot1!.thinkerCommittedVersion).toBe(0);

        // Now call as thinker - writes payload and increments thinker version
        const result = await repo.upsertRecentCognitionSlot(
          "sess-thinker",
          "agent-1",
          "settle-3",
          JSON.stringify([{ type: "thought", content: "committed" }]),
          "thinker",
        );

        expect(result.thinkerCommittedVersion).toBe(1);
        expect(result.talkerTurnCounter).toBeUndefined();

        const slot2 = await repo.getBySession("sess-thinker", "agent-1");
        expect(slot2!.talkerTurnCounter).toBe(2);
        expect(slot2!.thinkerCommittedVersion).toBe(1);
        expect(slot2!.slotPayload.length).toBe(1);
        expect((slot2!.slotPayload[0] as { content: string }).content).toBe("committed");
      });
    });

    it("getVersionGap returns correct gap calculation", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgRecentCognitionSlotRepo(pool);

        // No slot exists yet
        const gap0 = await repo.getVersionGap("sess-gap", "agent-1");
        expect(gap0).toBeUndefined();

        // Create slot with thinker (thinker version = 1)
        await repo.upsertRecentCognitionSlot(
          "sess-gap",
          "agent-1",
          "settle-1",
          JSON.stringify([{ type: "thought" }]),
          "thinker",
        );

        // Increment talker 3 times (talker counter = 3)
        await repo.upsertRecentCognitionSlot("sess-gap", "agent-1", "settle-2", "[]", "talker");
        await repo.upsertRecentCognitionSlot("sess-gap", "agent-1", "settle-3", "[]", "talker");
        await repo.upsertRecentCognitionSlot("sess-gap", "agent-1", "settle-4", "[]", "talker");

        const gap = await repo.getVersionGap("sess-gap", "agent-1");
        expect(gap).toBeDefined();
        expect(gap!.talkerCounter).toBe(3);
        expect(gap!.thinkerVersion).toBe(1);
        expect(gap!.gap).toBe(2); // 3 - 1 = 2
      });
    });

    it("getBySession returns version columns", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgRecentCognitionSlotRepo(pool);

        await repo.upsertRecentCognitionSlot(
          "sess-versions",
          "agent-1",
          "settle-1",
          JSON.stringify([{ type: "thought" }]),
          "thinker",
        );

        const slot = await repo.getBySession("sess-versions", "agent-1");
        expect(slot).toBeDefined();
        expect(slot!.talkerTurnCounter).toBe(0);
        expect(slot!.thinkerCommittedVersion).toBe(1);
      });
    });

    it("backwards compatible without versionIncrement", async () => {
      await withTestAppSchema(sql, async (pool) => {
        await bootstrapOpsSchema(pool);
        const repo = new PgRecentCognitionSlotRepo(pool);

        // Call without versionIncrement (old behavior)
        const result = await repo.upsertRecentCognitionSlot(
          "sess-compat",
          "agent-1",
          "settle-1",
          JSON.stringify([{ type: "thought" }]),
        );

        expect(result).toEqual({}); // No version returned when no increment specified

        const slot = await repo.getBySession("sess-compat", "agent-1");
        expect(slot).toBeDefined();
        expect(slot!.slotPayload.length).toBe(1);
      });
    });
  });
});
