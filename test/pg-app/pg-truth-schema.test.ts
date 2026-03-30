import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  ensureTestPgAppDb,
  createTestPgAppPool,
  withTestAppSchema,
  teardownAppPool,
} from "../helpers/pg-app-test-utils.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("pg-truth-schema", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("bootstrap is idempotent — calling twice produces no error", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapTruthSchema(sql);
    });
  });

  it("append-only trigger rejects UPDATE on private_episode_events", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);

      const now = Date.now();
      await sql.unsafe(`
        INSERT INTO private_episode_events
          (agent_id, session_id, settlement_id, category, summary, committed_time, created_at)
        VALUES ('agent-1', 'sess-1', 'stl-1', 'speech', 'hello', ${now}, ${now})
      `);

      await expect(
        sql.unsafe(`UPDATE private_episode_events SET summary = 'changed' WHERE agent_id = 'agent-1'`),
      ).rejects.toThrow("append-only: updates not allowed on private_episode_events");
    });
  });

  it("append-only trigger rejects DELETE on area_state_events", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);

      const now = Date.now();
      await sql.unsafe(`
        INSERT INTO area_state_events
          (agent_id, area_id, key, value_json, surfacing_classification, committed_time, settlement_id, created_at)
        VALUES ('agent-1', 1, 'pos', '"here"', 'public_manifestation', ${now}, 'stl-1', ${now})
      `);

      await expect(
        sql.unsafe(`DELETE FROM area_state_events WHERE agent_id = 'agent-1'`),
      ).rejects.toThrow("append-only: deletes not allowed on area_state_events");
    });
  });

  it("required columns present on key tables via information_schema", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);

      const expectedColumns: Record<string, string[]> = {
        settlement_processing_ledger: [
          "settlement_id", "agent_id", "payload_hash", "status",
          "attempt_count", "max_attempts", "claimed_by", "claimed_at",
          "applied_at", "error_message", "created_at", "updated_at",
        ],
        event_nodes: [
          "id", "session_id", "raw_text", "summary", "timestamp",
          "created_at", "visibility_scope", "location_entity_id",
          "event_category", "event_origin",
        ],
        fact_edges: [
          "id", "source_entity_id", "target_entity_id", "predicate",
          "t_valid", "t_invalid", "t_created", "t_expired",
        ],
        entity_nodes: [
          "id", "pointer_key", "display_name", "entity_type",
          "memory_scope", "owner_agent_id",
        ],
        memory_relations: [
          "id", "source_node_ref", "target_node_ref", "relation_type",
          "strength", "directness", "source_kind", "source_ref",
        ],
        shared_blocks: ["id", "title", "created_by_agent_id", "retrieval_only"],
        shared_block_sections: ["id", "block_id", "section_path", "title", "content"],
      };

      for (const [table, columns] of Object.entries(expectedColumns)) {
        const rows = await sql`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name = ${table}
            AND table_schema = current_schema()
        `;
        const actual = rows.map((r) => String(r.column_name));
        for (const col of columns) {
          expect(actual).toContain(col);
        }
      }
    });
  });

  it("BIGSERIAL sequences work — INSERT returns id > 0", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const now = Date.now();

      const [eventRow] = await sql.unsafe(`
        INSERT INTO event_nodes
          (session_id, timestamp, created_at, visibility_scope, location_entity_id,
           event_category, event_origin)
        VALUES ('sess-1', ${now}, ${now}, 'area_visible', 1, 'speech', 'runtime_projection')
        RETURNING id
      `);
      expect(Number(eventRow.id)).toBeGreaterThan(0);

      const [topicRow] = await sql.unsafe(`
        INSERT INTO topics (name, created_at) VALUES ('test-topic', ${now})
        RETURNING id
      `);
      expect(Number(topicRow.id)).toBeGreaterThan(0);

      const [entityRow] = await sql.unsafe(`
        INSERT INTO entity_nodes
          (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at)
        VALUES ('pk:test', 'Test Entity', 'location', 'shared_public', ${now}, ${now})
        RETURNING id
      `);
      expect(Number(entityRow.id)).toBeGreaterThan(0);
    });
  });

  it("shared_blocks CASCADE FK deletes child rows", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const now = Date.now();

      const [block] = await sql.unsafe(`
        INSERT INTO shared_blocks (title, created_by_agent_id, created_at, updated_at)
        VALUES ('test', 'agent-1', ${now}, ${now})
        RETURNING id
      `);

      await sql.unsafe(`
        INSERT INTO shared_block_sections (block_id, section_path, created_at, updated_at)
        VALUES (${block.id}, '/root', ${now}, ${now})
      `);

      await sql.unsafe(`DELETE FROM shared_blocks WHERE id = ${block.id}`);

      const remaining = await sql.unsafe(
        `SELECT count(*)::int AS cnt FROM shared_block_sections WHERE block_id = ${block.id}`,
      );
      expect(remaining[0].cnt).toBe(0);
    });
  });
});
