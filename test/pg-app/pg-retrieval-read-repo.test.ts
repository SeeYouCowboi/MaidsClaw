import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import type { ViewerContext } from "../../src/memory/types.js";
import { PgRetrievalReadRepo } from "../../src/storage/domain-repos/pg/retrieval-read-repo.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

const PG_MAX_BIGINT = "9223372036854775807";

function viewer(overrides: Partial<ViewerContext> = {}): ViewerContext {
  return {
    viewer_agent_id: "agent-a",
    viewer_role: "rp_agent",
    session_id: "session-a",
    current_area_id: 500,
    ...overrides,
  };
}

describe.skipIf(skipPgTests)("PgRetrievalReadRepo", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("readByEntity resolves redirect and returns facts/events/episodes", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgRetrievalReadRepo(sql);

      const now = Date.now();

      const privateEntityRows = await sql`
        INSERT INTO entity_nodes (
          pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at
        ) VALUES (
          ${"entity:alice"}, ${"Alice Private"}, ${"person"}, ${"private_overlay"}, ${"agent-a"}, ${null}, ${"private"}, ${now}, ${now}
        )
        RETURNING id
      `;
      const privateEntityId = Number(privateEntityRows[0].id);

      await sql`
        INSERT INTO pointer_redirects (old_name, new_name, redirect_type, owner_agent_id, created_at)
        VALUES (${"alice-old"}, ${"entity:alice"}, ${"rename"}, ${"agent-a"}, ${now})
      `;

      const targetRows = await sql`
        INSERT INTO entity_nodes (
          pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at
        ) VALUES (
          ${"entity:bob"}, ${"Bob"}, ${"person"}, ${"shared_public"}, ${null}, ${null}, ${"target"}, ${now}, ${now}
        )
        RETURNING id
      `;
      const targetEntityId = Number(targetRows[0].id);

      await sql`
        INSERT INTO fact_edges (source_entity_id, target_entity_id, predicate, t_valid, t_invalid, t_created, t_expired, source_event_id)
        VALUES
          (${privateEntityId}, ${targetEntityId}, ${"knows"}, ${1000}, ${PG_MAX_BIGINT}, ${1000}, ${PG_MAX_BIGINT}, ${null}),
          (${targetEntityId}, ${privateEntityId}, ${"met"}, ${1001}, ${PG_MAX_BIGINT}, ${1001}, ${PG_MAX_BIGINT}, ${null}),
          (${privateEntityId}, ${targetEntityId}, ${"expired"}, ${1002}, ${1003}, ${1002}, ${1003}, ${null})
      `;

      await sql`
        INSERT INTO event_nodes (
          session_id, raw_text, summary, timestamp, created_at, participants,
          emotion, topic_id, visibility_scope, location_entity_id, event_category,
          primary_actor_entity_id, promotion_class, source_record_id, event_origin
        ) VALUES
          (${"s1"}, ${null}, ${"participant match"}, ${1000}, ${now}, ${`["entity:${privateEntityId}"]`}, ${null}, ${null}, ${"world_public"}, ${1}, ${"action"}, ${null}, ${"none"}, ${null}, ${"runtime_projection"}),
          (${"s1"}, ${null}, ${"primary actor match"}, ${1001}, ${now}, ${"[]"}, ${null}, ${null}, ${"area_visible"}, ${500}, ${"action"}, ${privateEntityId}, ${"none"}, ${null}, ${"runtime_projection"}),
          (${"s1"}, ${null}, ${"hidden by area"}, ${1002}, ${now}, ${`["entity:${privateEntityId}"]`}, ${null}, ${null}, ${"area_visible"}, ${999}, ${"action"}, ${null}, ${"none"}, ${null}, ${"runtime_projection"})
      `;

      await sql`
        INSERT INTO private_episode_events (
          agent_id, session_id, settlement_id, category, summary,
          private_notes, location_entity_id, location_text,
          valid_time, committed_time, source_local_ref, created_at
        ) VALUES
          (${"agent-a"}, ${"s-ep"}, ${"st-1"}, ${"action"}, ${"episode for entity"}, ${null}, ${privateEntityId}, ${null}, ${null}, ${2000}, ${null}, ${now}),
          (${"agent-b"}, ${"s-ep"}, ${"st-2"}, ${"action"}, ${"other agent"}, ${null}, ${privateEntityId}, ${null}, ${null}, ${2000}, ${null}, ${now}),
          (${"agent-a"}, ${"s-ep"}, ${"st-3"}, ${"action"}, ${"other location"}, ${null}, ${targetEntityId}, ${null}, ${null}, ${2000}, ${null}, ${now})
      `;

      const result = await repo.readByEntity("alice-old", viewer());

      expect(result.entity).not.toBeNull();
      if (!result.entity) {
        throw new Error("expected resolved entity");
      }
      expect(result.entity.id).toBe(privateEntityId);
      expect(result.facts.length).toBe(2);
      expect(new Set(result.facts.map((f) => f.predicate))).toEqual(new Set(["knows", "met"]));
      expect(new Set(result.events.map((e) => e.summary))).toEqual(new Set(["participant match", "primary actor match"]));
      expect(result.episodes.length).toBe(1);
      expect(result.episodes[0].summary).toBe("episode for entity");
    });
  });

  it("readByTopic resolves redirect and applies event visibility; episodes stays empty", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgRetrievalReadRepo(sql);
      const now = Date.now();

      const topicRows = await sql`
        INSERT INTO topics (name, description, created_at)
        VALUES (${"alchemy"}, ${"topic"}, ${now})
        RETURNING id
      `;
      const topicId = Number(topicRows[0].id);

      await sql`
        INSERT INTO pointer_redirects (old_name, new_name, redirect_type, owner_agent_id, created_at)
        VALUES (${"old-alchemy"}, ${"alchemy"}, ${"rename"}, ${null}, ${now})
      `;

      await sql`
        INSERT INTO event_nodes (
          session_id, raw_text, summary, timestamp, created_at, participants,
          emotion, topic_id, visibility_scope, location_entity_id, event_category,
          primary_actor_entity_id, promotion_class, source_record_id, event_origin
        ) VALUES
          (${"s1"}, ${null}, ${"topic world"}, ${1000}, ${now}, ${"[]"}, ${null}, ${topicId}, ${"world_public"}, ${1}, ${"observation"}, ${null}, ${"none"}, ${null}, ${"runtime_projection"}),
          (${"s1"}, ${null}, ${"topic area visible"}, ${1001}, ${now}, ${"[]"}, ${null}, ${topicId}, ${"area_visible"}, ${500}, ${"observation"}, ${null}, ${"none"}, ${null}, ${"runtime_projection"}),
          (${"s1"}, ${null}, ${"topic hidden area"}, ${1002}, ${now}, ${"[]"}, ${null}, ${topicId}, ${"area_visible"}, ${999}, ${"observation"}, ${null}, ${"none"}, ${null}, ${"runtime_projection"})
      `;

      const result = await repo.readByTopic("old-alchemy", viewer());

      expect(result.topic).not.toBeNull();
      expect(result.events.length).toBe(2);
      expect(result.episodes).toEqual([]);
    });
  });

  it("readByEventIds and readByFactIds enforce visibility/current-fact semantics", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgRetrievalReadRepo(sql);
      const now = Date.now();

      const eventRows = await sql<{ id: number | string }[]>`
        INSERT INTO event_nodes (
          session_id, raw_text, summary, timestamp, created_at, participants,
          emotion, topic_id, visibility_scope, location_entity_id, event_category,
          primary_actor_entity_id, promotion_class, source_record_id, event_origin
        ) VALUES
          (${"s1"}, ${null}, ${"visible world"}, ${1000}, ${now}, ${"[]"}, ${null}, ${null}, ${"world_public"}, ${1}, ${"speech"}, ${null}, ${"none"}, ${null}, ${"runtime_projection"}),
          (${"s1"}, ${null}, ${"visible area"}, ${1001}, ${now}, ${"[]"}, ${null}, ${null}, ${"area_visible"}, ${500}, ${"speech"}, ${null}, ${"none"}, ${null}, ${"runtime_projection"}),
          (${"s1"}, ${null}, ${"hidden area"}, ${1002}, ${now}, ${"[]"}, ${null}, ${null}, ${"area_visible"}, ${999}, ${"speech"}, ${null}, ${"none"}, ${null}, ${"runtime_projection"})
        RETURNING id
      `;

      const factRows = await sql<{ id: number | string }[]>`
        INSERT INTO fact_edges (source_entity_id, target_entity_id, predicate, t_valid, t_invalid, t_created, t_expired, source_event_id)
        VALUES
          (${1}, ${2}, ${"active"}, ${1000}, ${PG_MAX_BIGINT}, ${1000}, ${PG_MAX_BIGINT}, ${null}),
          (${1}, ${3}, ${"expired"}, ${1001}, ${1002}, ${1001}, ${1002}, ${null})
        RETURNING id
      `;

      const events = await repo.readByEventIds(
        eventRows.map((row: { id: number | string }) => Number(row.id)),
        viewer(),
      );
      expect(new Set(events.map((e) => e.summary))).toEqual(new Set(["visible world", "visible area"]));
      expect(await repo.readByEventIds([], viewer())).toEqual([]);

      const facts = await repo.readByFactIds(
        factRows.map((row: { id: number | string }) => Number(row.id)),
        viewer(),
      );
      expect(facts.length).toBe(1);
      expect(facts[0].predicate).toBe("active");
      expect(await repo.readByFactIds([], viewer())).toEqual([]);
    });
  });

  it("resolveRedirect prioritizes agent redirect then global then passthrough", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgRetrievalReadRepo(sql);
      const now = Date.now();

      await sql`
        INSERT INTO pointer_redirects (old_name, new_name, redirect_type, owner_agent_id, created_at)
        VALUES
          (${"hero"}, ${"hero-agent"}, ${"rename"}, ${"agent-a"}, ${now}),
          (${"hero"}, ${"hero-global"}, ${"rename"}, ${null}, ${now}),
          (${"villain"}, ${"villain-global"}, ${"rename"}, ${null}, ${now})
      `;

      expect(await repo.resolveRedirect("hero", "agent-a")).toBe("hero-agent");
      expect(await repo.resolveRedirect("hero", "agent-b")).toBe("hero-global");
      expect(await repo.resolveRedirect("villain", "agent-a")).toBe("villain-global");
      expect(await repo.resolveRedirect("nobody", "agent-a")).toBe("nobody");
    });
  });

  it("resolveEntityByPointer matches private/shared pointers then aliases", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgRetrievalReadRepo(sql);
      const now = Date.now();

      const sharedRows = await sql<{ id: number | string; pointer_key: string }[]>`
        INSERT INTO entity_nodes (
          pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at
        ) VALUES
          (${"shared-key"}, ${"Shared"}, ${"person"}, ${"shared_public"}, ${null}, ${null}, ${null}, ${now}, ${now}),
          (${"alias-shared"}, ${"Alias Shared"}, ${"person"}, ${"shared_public"}, ${null}, ${null}, ${null}, ${now}, ${now})
        RETURNING id, pointer_key
      `;
      const sharedDirectId = Number(sharedRows.find((r) => r.pointer_key === "shared-key")?.id);
      const sharedAliasId = Number(sharedRows.find((r) => r.pointer_key === "alias-shared")?.id);

      const privateRows = await sql<{ id: number | string; pointer_key: string }[]>`
        INSERT INTO entity_nodes (
          pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at
        ) VALUES
          (${"private-key"}, ${"Private"}, ${"person"}, ${"private_overlay"}, ${"agent-a"}, ${null}, ${null}, ${now}, ${now}),
          (${"alias-private"}, ${"Alias Private"}, ${"person"}, ${"private_overlay"}, ${"agent-a"}, ${null}, ${null}, ${now}, ${now})
        RETURNING id, pointer_key
      `;
      const privateDirectId = Number(privateRows.find((r) => r.pointer_key === "private-key")?.id);
      const privateAliasId = Number(privateRows.find((r) => r.pointer_key === "alias-private")?.id);

      await sql`
        INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
        VALUES
          (${privateAliasId}, ${"queen"}, ${"nickname"}, ${"agent-a"}),
          (${sharedAliasId}, ${"queen"}, ${"nickname"}, ${null}),
          (${sharedAliasId}, ${"king"}, ${"nickname"}, ${null})
      `;

      const directPrivate = await repo.resolveEntityByPointer("private-key", "agent-a");
      const directShared = await repo.resolveEntityByPointer("shared-key", "agent-b");
      const aliasPrivate = await repo.resolveEntityByPointer("queen", "agent-a");
      const aliasShared = await repo.resolveEntityByPointer("king", "agent-b");
      const missing = await repo.resolveEntityByPointer("ghost", "agent-a");

      expect(directPrivate?.id).toBe(privateDirectId);
      expect(directShared?.id).toBe(sharedDirectId);
      expect(aliasPrivate?.id).toBe(privateAliasId);
      expect(aliasShared?.id).toBe(sharedAliasId);
      expect(missing).toBeNull();
    });
  });

  it("countNodeEmbeddings returns current embedding row count", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgRetrievalReadRepo(sql);

      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS node_embeddings (
          id         BIGSERIAL PRIMARY KEY,
          node_ref   TEXT NOT NULL,
          node_kind  TEXT NOT NULL,
          view_type  TEXT NOT NULL,
          model_id   TEXT NOT NULL,
          embedding  TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `);

      await sql`
        INSERT INTO node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at)
        VALUES
          (${"event:1"}, ${"event"}, ${"primary"}, ${"model-a"}, ${"[1,0,0]"}, ${1}),
          (${"event:2"}, ${"event"}, ${"primary"}, ${"model-a"}, ${"[0,1,0]"}, ${2})
      `;

      expect(await repo.countNodeEmbeddings()).toBe(2);
    });
  });
});
