import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  ensureTestPgAppDb,
  createTestPgAppPool,
  withTestAppSchema,
  teardownAppPool,
} from "../helpers/pg-app-test-utils.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import { PgEpisodeRepo } from "../../src/storage/domain-repos/pg/episode-repo.js";
import { PgCognitionEventRepo } from "../../src/storage/domain-repos/pg/cognition-event-repo.js";

describe.skipIf(!process.env.PG_APP_TEST_URL)("PgEpisodeRepo", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("append and readBySettlement round-trip", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgEpisodeRepo(sql);

      const id = await repo.append({
        agentId: "agent-1",
        sessionId: "sess-1",
        settlementId: "stl-1",
        category: "speech",
        summary: "Hello world",
        committedTime: 1000,
        sourceLocalRef: "ref-1",
      });
      expect(id).toBeGreaterThan(0);

      await repo.append({
        agentId: "agent-1",
        sessionId: "sess-1",
        settlementId: "stl-1",
        category: "action",
        summary: "Waved hand",
        committedTime: 2000,
        sourceLocalRef: "ref-2",
      });

      const rows = await repo.readBySettlement("stl-1", "agent-1");
      expect(rows).toHaveLength(2);
      expect(rows[0].summary).toBe("Hello world");
      expect(rows[0].category).toBe("speech");
      expect(rows[0].committed_time).toBe(1000);
      expect(rows[1].summary).toBe("Waved hand");
      expect(rows[1].category).toBe("action");
    });
  });

  it("readByAgent returns rows ordered by created_at DESC", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgEpisodeRepo(sql);

      await repo.append({
        agentId: "agent-2",
        sessionId: "sess-1",
        settlementId: "stl-a",
        category: "observation",
        summary: "first",
        committedTime: 1000,
      });
      await repo.append({
        agentId: "agent-2",
        sessionId: "sess-1",
        settlementId: "stl-b",
        category: "state_change",
        summary: "second",
        committedTime: 2000,
      });

      const rows = await repo.readByAgent("agent-2");
      expect(rows).toHaveLength(2);
      expect(rows[0].summary).toBe("second");
      expect(rows[1].summary).toBe("first");
    });
  });

  it("readByAgent respects limit", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgEpisodeRepo(sql);

      for (let i = 0; i < 5; i++) {
        await repo.append({
          agentId: "agent-limit",
          sessionId: "sess-1",
          settlementId: `stl-${i}`,
          category: "speech",
          summary: `msg-${i}`,
          committedTime: 1000 + i,
        });
      }

      const rows = await repo.readByAgent("agent-limit", 3);
      expect(rows).toHaveLength(3);
    });
  });

  it("ON CONFLICT DO NOTHING — duplicate source_local_ref returns 0", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgEpisodeRepo(sql);

      const first = await repo.append({
        agentId: "agent-dup",
        sessionId: "sess-1",
        settlementId: "stl-dup",
        category: "speech",
        summary: "original",
        committedTime: 1000,
        sourceLocalRef: "dup-ref",
      });
      expect(first).toBeGreaterThan(0);

      const second = await repo.append({
        agentId: "agent-dup",
        sessionId: "sess-1",
        settlementId: "stl-dup",
        category: "action",
        summary: "duplicate attempt",
        committedTime: 2000,
        sourceLocalRef: "dup-ref",
      });
      expect(second).toBe(0);

      const rows = await repo.readBySettlement("stl-dup", "agent-dup");
      expect(rows).toHaveLength(1);
      expect(rows[0].summary).toBe("original");
    });
  });

  it("rejects thought category", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgEpisodeRepo(sql);

      expect(() =>
        repo.append({
          agentId: "agent-1",
          sessionId: "sess-1",
          settlementId: "stl-1",
          category: "thought",
          summary: "thinking",
          committedTime: 1000,
        }),
      ).toThrow('episode category "thought" is not allowed');
    });
  });

  it("rejects invalid category", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgEpisodeRepo(sql);

      expect(() =>
        repo.append({
          agentId: "agent-1",
          sessionId: "sess-1",
          settlementId: "stl-1",
          category: "invalid_cat",
          summary: "bad",
          committedTime: 1000,
        }),
      ).toThrow("invalid episode category");
    });
  });

  it("rejects forbidden fields", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgEpisodeRepo(sql);

      expect(() =>
        repo.append({
          agentId: "agent-1",
          sessionId: "sess-1",
          settlementId: "stl-1",
          category: "speech",
          summary: "ok",
          committedTime: 1000,
          cognitionKey: "forbidden",
        } as any),
      ).toThrow('field "cognitionKey" is not allowed on episode events');
    });
  });

  it("append-only trigger rejects UPDATE", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgEpisodeRepo(sql);

      await repo.append({
        agentId: "agent-trigger",
        sessionId: "sess-1",
        settlementId: "stl-trigger",
        category: "speech",
        summary: "original",
        committedTime: 1000,
      });

      await expect(
        sql.unsafe(
          `UPDATE private_episode_events SET summary = 'changed' WHERE agent_id = 'agent-trigger'`,
        ),
      ).rejects.toThrow("append-only");
    });
  });

  it("normalizes nullable fields correctly", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgEpisodeRepo(sql);

      await repo.append({
        agentId: "agent-null",
        sessionId: "sess-1",
        settlementId: "stl-null",
        category: "speech",
        summary: "test nulls",
        committedTime: 1000,
        privateNotes: "secret note",
        locationEntityId: 42,
        locationText: "garden",
        validTime: 999,
      });

      const rows = await repo.readBySettlement("stl-null", "agent-null");
      expect(rows).toHaveLength(1);

      const row = rows[0];
      expect(row.private_notes).toBe("secret note");
      expect(row.location_entity_id).toBe(42);
      expect(row.location_text).toBe("garden");
      expect(row.valid_time).toBe(999);
      expect(row.source_local_ref).toBeNull();
      expect(typeof row.created_at).toBe("number");
      expect(row.created_at).toBeGreaterThan(0);
    });
  });
});

describe.skipIf(!process.env.PG_APP_TEST_URL)("PgCognitionEventRepo", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("append and readByCognitionKey round-trip", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCognitionEventRepo(sql);

      const id = await repo.append({
        agentId: "agent-1",
        cognitionKey: "trust:user",
        kind: "assertion",
        op: "upsert",
        recordJson: JSON.stringify({ value: "high" }),
        settlementId: "stl-1",
        committedTime: 1000,
      });
      expect(id).toBeGreaterThan(0);

      await repo.append({
        agentId: "agent-1",
        cognitionKey: "trust:user",
        kind: "evaluation",
        op: "upsert",
        recordJson: JSON.stringify({ value: "medium" }),
        settlementId: "stl-2",
        committedTime: 2000,
      });

      await repo.append({
        agentId: "agent-1",
        cognitionKey: "mood:current",
        kind: "commitment",
        op: "upsert",
        recordJson: null,
        settlementId: "stl-3",
        committedTime: 3000,
      });

      const trustEvents = await repo.readByCognitionKey("agent-1", "trust:user");
      expect(trustEvents).toHaveLength(2);
      expect(trustEvents[0].kind).toBe("assertion");
      expect(trustEvents[0].committed_time).toBe(1000);
      expect(trustEvents[1].kind).toBe("evaluation");
      expect(trustEvents[1].committed_time).toBe(2000);

      const moodEvents = await repo.readByCognitionKey("agent-1", "mood:current");
      expect(moodEvents).toHaveLength(1);
      expect(moodEvents[0].record_json).toBeNull();
    });
  });

  it("readByAgent returns all events for agent", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCognitionEventRepo(sql);

      await repo.append({
        agentId: "agent-read",
        cognitionKey: "key-a",
        kind: "assertion",
        op: "upsert",
        recordJson: '{"x":1}',
        settlementId: "stl-1",
        committedTime: 100,
      });

      await repo.append({
        agentId: "agent-read",
        cognitionKey: "key-b",
        kind: "evaluation",
        op: "retract",
        recordJson: null,
        settlementId: "stl-2",
        committedTime: 200,
      });

      const rows = await repo.readByAgent("agent-read");
      expect(rows).toHaveLength(2);
      expect(rows[0].cognition_key).toBe("key-a");
      expect(rows[0].committed_time).toBe(100);
      expect(rows[1].cognition_key).toBe("key-b");
      expect(rows[1].op).toBe("retract");
    });
  });

  it("readByAgent respects limit", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCognitionEventRepo(sql);

      for (let i = 0; i < 5; i++) {
        await repo.append({
          agentId: "agent-lim",
          cognitionKey: `key-${i}`,
          kind: "assertion",
          op: "upsert",
          recordJson: null,
          settlementId: `stl-${i}`,
          committedTime: 1000 + i,
        });
      }

      const rows = await repo.readByAgent("agent-lim", 3);
      expect(rows).toHaveLength(3);
    });
  });

  it("replay returns events in committed_time ASC order", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCognitionEventRepo(sql);

      await repo.append({
        agentId: "agent-replay",
        cognitionKey: "k1",
        kind: "assertion",
        op: "upsert",
        recordJson: null,
        settlementId: "stl-1",
        committedTime: 3000,
      });

      await repo.append({
        agentId: "agent-replay",
        cognitionKey: "k2",
        kind: "evaluation",
        op: "upsert",
        recordJson: null,
        settlementId: "stl-2",
        committedTime: 1000,
      });

      await repo.append({
        agentId: "agent-replay",
        cognitionKey: "k3",
        kind: "commitment",
        op: "retract",
        recordJson: null,
        settlementId: "stl-3",
        committedTime: 2000,
      });

      const all = await repo.replay("agent-replay");
      expect(all).toHaveLength(3);
      expect(all[0].committed_time).toBe(1000);
      expect(all[1].committed_time).toBe(2000);
      expect(all[2].committed_time).toBe(3000);
    });
  });

  it("replay with afterTime filters older events", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCognitionEventRepo(sql);

      await repo.append({
        agentId: "agent-after",
        cognitionKey: "k1",
        kind: "assertion",
        op: "upsert",
        recordJson: null,
        settlementId: "stl-1",
        committedTime: 1000,
      });

      await repo.append({
        agentId: "agent-after",
        cognitionKey: "k2",
        kind: "evaluation",
        op: "upsert",
        recordJson: null,
        settlementId: "stl-2",
        committedTime: 2000,
      });

      await repo.append({
        agentId: "agent-after",
        cognitionKey: "k3",
        kind: "commitment",
        op: "upsert",
        recordJson: null,
        settlementId: "stl-3",
        committedTime: 3000,
      });

      const filtered = await repo.replay("agent-after", 1500);
      expect(filtered).toHaveLength(2);
      expect(filtered[0].committed_time).toBe(2000);
      expect(filtered[1].committed_time).toBe(3000);
    });
  });

  it("append-only trigger rejects UPDATE on cognition events", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCognitionEventRepo(sql);

      await repo.append({
        agentId: "agent-trigger",
        cognitionKey: "k1",
        kind: "assertion",
        op: "upsert",
        recordJson: null,
        settlementId: "stl-1",
        committedTime: 1000,
      });

      await expect(
        sql.unsafe(
          `UPDATE private_cognition_events SET op = 'retract' WHERE agent_id = 'agent-trigger'`,
        ),
      ).rejects.toThrow("append-only");
    });
  });

  it("append-only trigger rejects DELETE on cognition events", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCognitionEventRepo(sql);

      await repo.append({
        agentId: "agent-del",
        cognitionKey: "k1",
        kind: "assertion",
        op: "upsert",
        recordJson: null,
        settlementId: "stl-del",
        committedTime: 1000,
      });

      await expect(
        sql.unsafe(
          `DELETE FROM private_cognition_events WHERE agent_id = 'agent-del'`,
        ),
      ).rejects.toThrow("append-only");
    });
  });

  it("record_json JSONB round-trip preserves structure", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCognitionEventRepo(sql);

      const payload = { nested: { array: [1, 2, 3], flag: true } };

      await repo.append({
        agentId: "agent-json",
        cognitionKey: "json-test",
        kind: "assertion",
        op: "upsert",
        recordJson: JSON.stringify(payload),
        settlementId: "stl-json",
        committedTime: 1000,
      });

      const rows = await repo.readByCognitionKey("agent-json", "json-test");
      expect(rows).toHaveLength(1);
      const parsed = JSON.parse(rows[0].record_json!);
      expect(parsed).toEqual(payload);
    });
  });
});
