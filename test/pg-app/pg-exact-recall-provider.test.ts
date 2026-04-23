import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { PgExactRecallProvider } from "../../src/storage/domain-repos/pg/exact-recall-provider.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

/**
 * Minimal schema bootstrap for exact-recall tests. Mirrors the truth +
 * derived schema shape required by PgExactRecallProvider, without pulling
 * in the full schema bootstrap (which requires pgvector etc.).
 */
async function bootstrapExactRecallSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS entity_aliases (
      id              BIGSERIAL PRIMARY KEY,
      canonical_id    BIGINT NOT NULL,
      alias           TEXT NOT NULL,
      alias_type      TEXT,
      owner_agent_id  TEXT
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS entity_nodes (
      id                  BIGSERIAL PRIMARY KEY,
      pointer_key         TEXT NOT NULL,
      display_name        TEXT,
      entity_type         TEXT,
      memory_scope        TEXT NOT NULL,
      owner_agent_id      TEXT,
      canonical_entity_id INTEGER,
      summary             TEXT,
      created_at          BIGINT NOT NULL DEFAULT 0,
      updated_at          BIGINT NOT NULL DEFAULT 0
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS search_docs_episode (
      id                   BIGSERIAL PRIMARY KEY,
      doc_type             TEXT NOT NULL DEFAULT 'episode',
      source_ref           TEXT NOT NULL,
      agent_id             TEXT NOT NULL,
      category             TEXT NOT NULL DEFAULT 'speech',
      content              TEXT NOT NULL DEFAULT '',
      committed_at         BIGINT NOT NULL DEFAULT 0,
      created_at           BIGINT NOT NULL DEFAULT 0,
      entity_pointer_keys  TEXT[] NOT NULL DEFAULT '{}'
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS private_episode_events (
      id                   BIGSERIAL PRIMARY KEY,
      agent_id             TEXT NOT NULL,
      session_id           TEXT NOT NULL DEFAULT 'sess',
      settlement_id        TEXT NOT NULL DEFAULT 'settle',
      category             TEXT NOT NULL DEFAULT 'speech',
      summary              TEXT NOT NULL DEFAULT '',
      private_notes        TEXT,
      location_entity_id   INTEGER,
      location_text        TEXT,
      valid_time           BIGINT,
      committed_time       BIGINT NOT NULL DEFAULT 0,
      source_local_ref     TEXT,
      request_id           VARCHAR,
      created_at           BIGINT NOT NULL DEFAULT 0,
      entity_pointer_keys  TEXT[] NOT NULL DEFAULT '{}'
    )
  `);
}

describe.skipIf(skipPgTests)("PgExactRecallProvider", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("returns alias_exact candidate for shared alias hit", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapExactRecallSchema(sql);

      // Canonical entity (shared).
      await sql`
        INSERT INTO entity_nodes (id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id)
        VALUES (500, 'alice-canonical', 'Alice', 'person', 'shared_public', NULL)
      `;
      // Shared alias.
      await sql`
        INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
        VALUES (500, 'Alice', 'nickname', NULL)
      `;
      // An episode source_ref tagged with the canonical pointer key.
      await sql`
        INSERT INTO search_docs_episode
          (source_ref, agent_id, category, content, entity_pointer_keys)
        VALUES
          ('ep:alice-1', 'agent-b', 'speech', 'Alice walked in.', ARRAY['alice-canonical'])
      `;

      const provider = new PgExactRecallProvider(sql);
      const candidates = await provider.recallExact(
        ["Alice"],
        { agentId: "agent-b" },
        50,
      );

      const aliasHit = candidates.find(
        (c) => c.reason === "alias_exact" && c.pointerKey === "alice-canonical",
      );
      expect(aliasHit).toBeDefined();
      expect(aliasHit?.canonicalEntityId).toBe(500);

      // The derived pointer key should have surfaced the episode as well.
      const episodeHit = candidates.find((c) => c.sourceRef === "ep:alice-1");
      expect(episodeHit).toBeDefined();
      expect(episodeHit?.surface).toBe("episode");
    });
  });

  it("returns pointer_key_exact candidate when pointer_key matches directly", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapExactRecallSchema(sql);

      await sql`
        INSERT INTO entity_nodes (id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id)
        VALUES (600, 'tavern-room', 'Tavern', 'location', 'shared_public', NULL)
      `;
      await sql`
        INSERT INTO search_docs_episode
          (source_ref, agent_id, category, content, entity_pointer_keys)
        VALUES
          ('ep:tavern-1', 'agent-b', 'observation', 'Inside the tavern.', ARRAY['tavern-room'])
      `;

      const provider = new PgExactRecallProvider(sql);
      const candidates = await provider.recallExact(
        ["tavern-room"],
        { agentId: "agent-b" },
        50,
      );

      const pointerHit = candidates.find(
        (c) => c.reason === "pointer_key_exact" && c.pointerKey === "tavern-room",
      );
      expect(pointerHit).toBeDefined();
      expect(pointerHit?.canonicalEntityId).toBe(600);

      const episodeHit = candidates.find((c) => c.sourceRef === "ep:tavern-1");
      expect(episodeHit).toBeDefined();
    });
  });

  it("does NOT leak private-alias hits across agents", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapExactRecallSchema(sql);

      // Private entity owned by agent-a.
      await sql`
        INSERT INTO entity_nodes (id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id)
        VALUES (700, 'secret-pointer', 'Secret', 'concept', 'private_overlay', 'agent-a')
      `;
      // Private alias owned by agent-a.
      await sql`
        INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
        VALUES (700, 'PrivatePet', 'nickname', 'agent-a')
      `;
      // Private episode event (agent-a only).
      await sql`
        INSERT INTO private_episode_events
          (agent_id, session_id, settlement_id, category, summary, committed_time, created_at, entity_pointer_keys)
        VALUES
          ('agent-a', 'sess-a', 'settle-a', 'speech', 'Private log.', 0, 0, ARRAY['secret-pointer'])
      `;

      const provider = new PgExactRecallProvider(sql);

      // agent-a should see their own alias + private episode.
      const ownerHits = await provider.recallExact(
        ["PrivatePet"],
        { agentId: "agent-a" },
        50,
      );
      expect(ownerHits.length).toBeGreaterThan(0);
      expect(ownerHits.some((c) => c.reason === "alias_exact")).toBe(true);

      // agent-b must not see any of agent-a's private alias or private event.
      const otherHits = await provider.recallExact(
        ["PrivatePet"],
        { agentId: "agent-b" },
        50,
      );
      expect(otherHits.length).toBe(0);

      // Even if agent-b looked up the pointer key directly, the private
      // entity must stay hidden.
      const otherPointerHits = await provider.recallExact(
        ["secret-pointer"],
        { agentId: "agent-b" },
        50,
      );
      expect(otherPointerHits.length).toBe(0);
    });
  });
});
