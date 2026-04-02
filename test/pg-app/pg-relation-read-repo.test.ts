import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { PgRelationReadRepo } from "../../src/storage/domain-repos/pg/relation-read-repo.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

async function bootstrapRelationSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS memory_relations (
      id              BIGSERIAL PRIMARY KEY,
      source_node_ref TEXT NOT NULL,
      target_node_ref TEXT NOT NULL,
      relation_type   TEXT NOT NULL,
      strength        REAL NOT NULL,
      directness      TEXT NOT NULL,
      source_kind     TEXT NOT NULL,
      source_ref      TEXT NOT NULL,
      created_at      BIGINT NOT NULL,
      updated_at      BIGINT NOT NULL,
      UNIQUE(source_node_ref, target_node_ref, relation_type, source_kind, source_ref)
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS private_cognition_current (
      id                         BIGSERIAL PRIMARY KEY,
      agent_id                   TEXT NOT NULL,
      cognition_key              TEXT NOT NULL,
      kind                       TEXT NOT NULL,
      stance                     TEXT,
      basis                      TEXT,
      status                     TEXT DEFAULT 'active',
      pre_contested_stance       TEXT,
      conflict_summary           TEXT,
      conflict_factor_refs_json  JSONB,
      summary_text               TEXT,
      record_json                JSONB NOT NULL,
      source_event_id            BIGINT NOT NULL,
      updated_at                 BIGINT NOT NULL,
      UNIQUE(agent_id, cognition_key)
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS private_episode_events (
      id               BIGSERIAL PRIMARY KEY,
      agent_id         TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      settlement_id    TEXT NOT NULL,
      category         TEXT NOT NULL,
      summary          TEXT NOT NULL,
      private_notes    TEXT,
      location_entity_id BIGINT,
      location_text    TEXT,
      valid_time       BIGINT,
      committed_time   BIGINT NOT NULL,
      source_local_ref TEXT,
      created_at       BIGINT NOT NULL
    )
  `);
}

describe.skipIf(skipPgTests)("PgRelationReadRepo", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  describe("resolveSourceAgentId", () => {
    it("resolves agent_id from assertion:{id}", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);
        const now = Date.now();

        const rows = await sql`
          INSERT INTO private_cognition_current (agent_id, cognition_key, kind, source_event_id, updated_at, record_json)
          VALUES ('agent-a', 'test:1', 'assertion', 1, ${now}, '{}')
          RETURNING id
        `;
        const id = Number(rows[0].id);

        const agentId = await repo.resolveSourceAgentId(`assertion:${id}`);
        expect(agentId).toBe("agent-a");
      });
    });

    it("resolves agent_id from evaluation:{id}", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);
        const now = Date.now();

        const rows = await sql`
          INSERT INTO private_cognition_current (agent_id, cognition_key, kind, source_event_id, updated_at, record_json)
          VALUES ('agent-b', 'test:2', 'evaluation', 1, ${now}, '{}')
          RETURNING id
        `;
        const id = Number(rows[0].id);

        const agentId = await repo.resolveSourceAgentId(`evaluation:${id}`);
        expect(agentId).toBe("agent-b");
      });
    });

    it("resolves agent_id from commitment:{id}", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);
        const now = Date.now();

        const rows = await sql`
          INSERT INTO private_cognition_current (agent_id, cognition_key, kind, source_event_id, updated_at, record_json)
          VALUES ('agent-c', 'test:3', 'commitment', 1, ${now}, '{}')
          RETURNING id
        `;
        const id = Number(rows[0].id);

        const agentId = await repo.resolveSourceAgentId(`commitment:${id}`);
        expect(agentId).toBe("agent-c");
      });
    });

    it("resolves agent_id from private_episode:{id}", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);
        const now = Date.now();

        const rows = await sql`
          INSERT INTO private_episode_events (agent_id, session_id, settlement_id, category, summary, committed_time, created_at)
          VALUES ('agent-d', 'sess-1', 'stl-1', 'action', 'test episode', ${now}, ${now})
          RETURNING id
        `;
        const id = Number(rows[0].id);

        const agentId = await repo.resolveSourceAgentId(`private_episode:${id}`);
        expect(agentId).toBe("agent-d");
      });
    });

    it("returns null for unknown ref formats", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);

        expect(await repo.resolveSourceAgentId("unknown:123")).toBeNull();
        expect(await repo.resolveSourceAgentId("invalid")).toBeNull();
        expect(await repo.resolveSourceAgentId("assertion:invalid")).toBeNull();
      });
    });
  });

  describe("resolveCanonicalCognitionRefByKey", () => {
    it("resolves assertion by cognition key with agent filter", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);
        const now = Date.now();

        const rows = await sql`
          INSERT INTO private_cognition_current (agent_id, cognition_key, kind, source_event_id, updated_at, record_json)
          VALUES ('agent-a', 'unique:key', 'assertion', 1, ${now}, '{}')
          RETURNING id
        `;
        const id = Number(rows[0].id);

        const resolved = await repo.resolveCanonicalCognitionRefByKey("unique:key", "agent-a");
        expect(resolved).toBe(`assertion:${id}`);
      });
    });

    it("resolves evaluation by cognition key without agent filter", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);
        const now = Date.now();

        const rows = await sql`
          INSERT INTO private_cognition_current (agent_id, cognition_key, kind, source_event_id, updated_at, record_json)
          VALUES ('agent-any', 'eval:key', 'evaluation', 1, ${now}, '{}')
          RETURNING id
        `;
        const id = Number(rows[0].id);

        const resolved = await repo.resolveCanonicalCognitionRefByKey("eval:key", null);
        expect(resolved).toBe(`evaluation:${id}`);
      });
    });

    it("resolves commitment by cognition key with agent filter", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);
        const now = Date.now();

        const rows = await sql`
          INSERT INTO private_cognition_current (agent_id, cognition_key, kind, source_event_id, updated_at, record_json)
          VALUES ('agent-b', 'commit:key', 'commitment', 1, ${now}, '{}')
          RETURNING id
        `;
        const id = Number(rows[0].id);

        const resolved = await repo.resolveCanonicalCognitionRefByKey("commit:key", "agent-b");
        expect(resolved).toBe(`commitment:${id}`);
      });
    });

    it("returns null when cognition key not found", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);

        const resolved = await repo.resolveCanonicalCognitionRefByKey("nonexistent:key", null);
        expect(resolved).toBeNull();
      });
    });

    it("returns null when agent filter excludes match", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);
        const now = Date.now();

        await sql`
          INSERT INTO private_cognition_current (agent_id, cognition_key, kind, source_event_id, updated_at, record_json)
          VALUES ('agent-a', 'agent-specific:key', 'assertion', 1, ${now}, '{}')
        `;

        const resolved = await repo.resolveCanonicalCognitionRefByKey("agent-specific:key", "agent-b");
        expect(resolved).toBeNull();
      });
    });
  });

  describe("getConflictEvidence", () => {
    it("returns conflict evidence ordered by strength desc", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);
        const now = Date.now();

        const assertionRows = await sql`
          INSERT INTO private_cognition_current (agent_id, cognition_key, kind, source_event_id, updated_at, record_json)
          VALUES ('agent-a', 'source:key', 'assertion', 1, ${now}, '{}')
          RETURNING id
        `;
        const sourceId = Number(assertionRows[0].id);
        const sourceRef = `assertion:${sourceId}`;

        await sql`
          INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
          VALUES
            (${sourceRef}, 'assertion:999', 'conflicts_with', 0.5, 'direct', 'agent_op', 'src-1', ${now}, ${now}),
            (${sourceRef}, 'assertion:998', 'conflicts_with', 0.9, 'direct', 'agent_op', 'src-2', ${now}, ${now}),
            (${sourceRef}, 'assertion:997', 'conflicts_with', 0.7, 'direct', 'agent_op', 'src-3', ${now}, ${now})
        `;

        const evidence = await repo.getConflictEvidence(sourceRef, 10);
        expect(evidence).toHaveLength(3);
        expect(evidence[0].strength).toBe(0.9);
        expect(evidence[1].strength).toBe(0.7);
        expect(evidence[2].strength).toBe(0.5);
      });
    });

    it("respects limit parameter", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);
        const now = Date.now();

        const assertionRows = await sql`
          INSERT INTO private_cognition_current (agent_id, cognition_key, kind, source_event_id, updated_at, record_json)
          VALUES ('agent-a', 'source:key2', 'assertion', 1, ${now}, '{}')
          RETURNING id
        `;
        const sourceId = Number(assertionRows[0].id);
        const sourceRef = `assertion:${sourceId}`;

        await sql`
          INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
          VALUES
            (${sourceRef}, 'assertion:996', 'conflicts_with', 0.1, 'direct', 'agent_op', 'src-1', ${now}, ${now}),
            (${sourceRef}, 'assertion:995', 'conflicts_with', 0.2, 'direct', 'agent_op', 'src-2', ${now}, ${now}),
            (${sourceRef}, 'assertion:994', 'conflicts_with', 0.3, 'direct', 'agent_op', 'src-3', ${now}, ${now})
        `;

        const evidence = await repo.getConflictEvidence(sourceRef, 2);
        expect(evidence).toHaveLength(2);
      });
    });

    it("returns empty array when no conflicts exist", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);
        const now = Date.now();

        const assertionRows = await sql`
          INSERT INTO private_cognition_current (agent_id, cognition_key, kind, source_event_id, updated_at, record_json)
          VALUES ('agent-a', 'no-conflict:key', 'assertion', 1, ${now}, '{}')
          RETURNING id
        `;
        const sourceId = Number(assertionRows[0].id);
        const sourceRef = `assertion:${sourceId}`;

        const evidence = await repo.getConflictEvidence(sourceRef, 10);
        expect(evidence).toEqual([]);
      });
    });
  });

  describe("getConflictHistory", () => {
    it("returns conflict/resolution history ordered by created_at ASC", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);

        const targetRef = "assertion:100";

        await sql`
          INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
          VALUES
            ('assertion:101', ${targetRef}, 'conflicts_with', 0.8, 'direct', 'agent_op', 'src-1', 1000, 1000),
            ('assertion:102', ${targetRef}, 'resolved_by', 0.9, 'direct', 'agent_op', 'src-2', 2000, 2000),
            ('assertion:103', ${targetRef}, 'downgraded_by', 0.7, 'direct', 'agent_op', 'src-3', 1500, 1500)
        `;

        const history = await repo.getConflictHistory(targetRef, 10);
        expect(history).toHaveLength(3);
        expect(history[0].created_at).toBe(1000);
        expect(history[1].created_at).toBe(1500);
        expect(history[2].created_at).toBe(2000);
      });
    });

    it("includes entries where node is source", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);

        const sourceRef = "assertion:200";

        await sql`
          INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
          VALUES
            (${sourceRef}, 'assertion:201', 'conflicts_with', 0.8, 'direct', 'agent_op', 'src-1', 1000, 1000),
            ('assertion:202', ${sourceRef}, 'conflicts_with', 0.7, 'direct', 'agent_op', 'src-2', 2000, 2000)
        `;

        const history = await repo.getConflictHistory(sourceRef, 10);
        expect(history).toHaveLength(2);
      });
    });

    it("filters by resolution chain types only", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);

        const targetRef = "assertion:300";

        await sql`
          INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
          VALUES
            ('assertion:301', ${targetRef}, 'conflicts_with', 0.8, 'direct', 'agent_op', 'src-1', 1000, 1000),
            ('assertion:302', ${targetRef}, 'supports', 0.9, 'direct', 'agent_op', 'src-2', 2000, 2000),
            ('assertion:303', ${targetRef}, 'resolved_by', 0.7, 'direct', 'agent_op', 'src-3', 3000, 3000)
        `;

        const history = await repo.getConflictHistory(targetRef, 10);
        expect(history).toHaveLength(2);
        const types = history.map((h) => h.relation_type);
        expect(types).toContain("conflicts_with");
        expect(types).toContain("resolved_by");
        expect(types).not.toContain("supports");
      });
    });

    it("returns empty array when no history exists", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapRelationSchema(sql);
        const repo = new PgRelationReadRepo(sql);

        const history = await repo.getConflictHistory("assertion:nonexistent", 10);
        expect(history).toEqual([]);
      });
    });
  });
});
