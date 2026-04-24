import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { PgSearchRebuilder } from "../../src/memory/search-rebuild-pg.js";
import { PgSearchProjectionRepo } from "../../src/storage/domain-repos/pg/search-projection-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("PgSearchRebuilder", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  async function bootstrapSchemas(sql: postgres.Sql): Promise<void> {
    await bootstrapTruthSchema(sql);
    await bootstrapDerivedSchema(sql);
  }

  async function insertEntityNode(
    sql: postgres.Sql,
    opts: {
      pointerKey: string;
      displayName: string;
      entityType?: string;
      memoryScope: "shared_public" | "private_overlay";
      ownerAgentId?: string | null;
      summary?: string | null;
    },
  ): Promise<number> {
    const now = Date.now();
    const rows = await sql<{ id: string | number }[]>`
      INSERT INTO entity_nodes
        (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, summary, created_at, updated_at)
      VALUES
        (${opts.pointerKey}, ${opts.displayName}, ${opts.entityType ?? "character"},
         ${opts.memoryScope}, ${opts.ownerAgentId ?? null}, ${opts.summary ?? null}, ${now}, ${now})
      RETURNING id
    `;
    return Number(rows[0]!.id);
  }

  async function insertEventNode(
    sql: postgres.Sql,
    opts: {
      sessionId?: string;
      summary: string;
      visibilityScope: "area_visible" | "world_public";
      locationEntityId: number;
      eventCategory?: string;
    },
  ): Promise<number> {
    const now = Date.now();
    const rows = await sql<{ id: string | number }[]>`
      INSERT INTO event_nodes
        (session_id, summary, timestamp, created_at, visibility_scope,
         location_entity_id, event_category, event_origin)
      VALUES
        (${opts.sessionId ?? "test-session"}, ${opts.summary}, ${now}, ${now},
         ${opts.visibilityScope}, ${opts.locationEntityId},
         ${opts.eventCategory ?? "observation"}, 'runtime_projection')
      RETURNING id
    `;
    return Number(rows[0]!.id);
  }

  async function insertFactEdge(
    sql: postgres.Sql,
    opts: {
      sourceEntityId: number;
      targetEntityId: number;
      predicate: string;
    },
  ): Promise<number> {
    const now = Date.now();
    const rows = await sql<{ id: string | number }[]>`
      INSERT INTO fact_edges
        (source_entity_id, target_entity_id, predicate, t_valid, t_created)
      VALUES
        (${opts.sourceEntityId}, ${opts.targetEntityId}, ${opts.predicate}, ${now}, ${now})
      RETURNING id
    `;
    return Number(rows[0]!.id);
  }

  async function insertCognition(
    sql: postgres.Sql,
    opts: {
      agentId: string;
      cognitionKey: string;
      kind: "assertion" | "evaluation" | "commitment";
      summaryText: string;
      status?: string;
      stance?: string | null;
      basis?: string | null;
      recordJson?: Record<string, unknown>;
    },
  ): Promise<number> {
    const now = Date.now();
    const rows = await sql<{ id: string | number }[]>`
      INSERT INTO private_cognition_current
        (agent_id, cognition_key, kind, status, stance, basis, summary_text, record_json, source_event_id, updated_at)
      VALUES
        (${opts.agentId}, ${opts.cognitionKey}, ${opts.kind}, ${opts.status ?? "active"},
         ${opts.stance ?? null}, ${opts.basis ?? null}, ${opts.summaryText},
         ${sql.json((opts.recordJson ?? {}) as never)}, ${1}, ${now})
      RETURNING id
    `;
    return Number(rows[0]!.id);
  }

  it("rebuildArea populates from area_visible event_nodes", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapSchemas(sql);
      const rebuilder = new PgSearchRebuilder(sql);
      const repo = new PgSearchProjectionRepo(sql);

      const locationId = await insertEntityNode(sql, {
        pointerKey: "loc:garden",
        displayName: "Rose Garden",
        memoryScope: "shared_public",
      });

      await insertEventNode(sql, {
        summary: "A gentle breeze carried the scent of lavender through the garden",
        visibilityScope: "area_visible",
        locationEntityId: locationId,
      });

      await insertEventNode(sql, {
        summary: "Rain began to fall on the courtyard stones",
        visibilityScope: "area_visible",
        locationEntityId: locationId,
      });

      await rebuilder.rebuildArea();

      const hits = await repo.searchArea("lavender", locationId, 10);
      expect(hits.length).toBe(1);
      expect(hits[0]!.content).toContain("lavender");
      expect(hits[0]!.locationEntityId).toBe(locationId);
    });
  });

  it("rebuildWorld populates from world_public events, shared entities, and fact_edges", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapSchemas(sql);
      const rebuilder = new PgSearchRebuilder(sql);
      const repo = new PgSearchProjectionRepo(sql);

      const entityA = await insertEntityNode(sql, {
        pointerKey: "person:duchess",
        displayName: "Duchess Valentina",
        memoryScope: "shared_public",
        summary: "Patron of the mansion arts program",
      });

      const entityB = await insertEntityNode(sql, {
        pointerKey: "place:gallery",
        displayName: "Grand Gallery",
        memoryScope: "shared_public",
        summary: "Exhibition hall on the third floor",
      });

      await insertEventNode(sql, {
        summary: "The grand ball announcement echoed through all halls",
        visibilityScope: "world_public",
        locationEntityId: entityA,
      });

      await insertFactEdge(sql, {
        sourceEntityId: entityA,
        targetEntityId: entityB,
        predicate: "patron_of",
      });

      await rebuilder.rebuildWorld();

      const eventHits = await repo.searchWorld("grand ball", 10);
      expect(eventHits.length).toBeGreaterThanOrEqual(1);

      const entityHits = await repo.searchWorld("Valentina", 10);
      expect(entityHits.length).toBeGreaterThanOrEqual(1);
      expect(entityHits[0]!.docType).toBe("entity");

      const factHits = await repo.searchWorld("patron_of", 10);
      expect(factHits.length).toBeGreaterThanOrEqual(1);
      expect(factHits[0]!.docType).toBe("fact");
    });
  });

  it("rebuildCognition populates all cognition records for agent", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapSchemas(sql);
      const rebuilder = new PgSearchRebuilder(sql);
      const repo = new PgSearchProjectionRepo(sql);

      await insertCognition(sql, {
        agentId: "agent-c",
        cognitionKey: "eval:household",
        kind: "evaluation",
        summaryText: "The household runs smoothly under current management",
        basis: "first_hand",
      });

      await insertCognition(sql, {
        agentId: "agent-c",
        cognitionKey: "assert:protocol",
        kind: "assertion",
        summaryText: "Tea service protocol must follow traditional order",
        stance: "confirmed",
        basis: "first_hand",
      });

      await rebuilder.rebuildCognition("agent-c");

      const hits = await repo.searchCognition("household", "agent-c", 10);
      expect(hits.length).toBeGreaterThanOrEqual(1);

      const teaHits = await repo.searchCognition("tea service", "agent-c", 10);
      expect(teaHits.length).toBeGreaterThanOrEqual(1);
      expect(teaHits[0]!.kind).toBe("assertion");
    });
  });

  it("rebuild('all') populates all surfaces", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapSchemas(sql);
      const rebuilder = new PgSearchRebuilder(sql);
      const repo = new PgSearchProjectionRepo(sql);

      const locId = await insertEntityNode(sql, {
        pointerKey: "loc:kitchen",
        displayName: "Main Kitchen",
        memoryScope: "shared_public",
        summary: "Central preparation area",
      });

      await insertEventNode(sql, {
        summary: "Dinner preparations commenced in the kitchen",
        visibilityScope: "area_visible",
        locationEntityId: locId,
      });

      await insertEventNode(sql, {
        summary: "A worldwide celebration was declared",
        visibilityScope: "world_public",
        locationEntityId: locId,
      });

      await insertCognition(sql, {
        agentId: "agent-d",
        cognitionKey: "eval:skill",
        kind: "evaluation",
        summaryText: "Pastry skills need improvement",
        basis: "introspection",
      });

      await rebuilder.rebuild({ scope: "all", agentId: "agent-d" });

      const areaHits = await repo.searchArea("dinner", locId, 10);
      expect(areaHits.length).toBeGreaterThanOrEqual(1);

      const worldHits = await repo.searchWorld("celebration", 10);
      expect(worldHits.length).toBeGreaterThanOrEqual(1);

      const cognHits = await repo.searchCognition("pastry", "agent-d", 10);
      expect(cognHits.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("rebuild clears stale docs before repopulating", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapSchemas(sql);
      const rebuilder = new PgSearchRebuilder(sql);
      const repo = new PgSearchProjectionRepo(sql);

      const locId = await insertEntityNode(sql, {
        pointerKey: "loc:library",
        displayName: "Library",
        memoryScope: "shared_public",
      });

      await insertEventNode(sql, {
        summary: "Old dusty books discovered in the attic room",
        visibilityScope: "area_visible",
        locationEntityId: locId,
      });

      await rebuilder.rebuildArea();
      const firstHits = await repo.searchArea("dusty books", locId, 10);
      expect(firstHits.length).toBe(1);

      await sql`DELETE FROM event_nodes WHERE visibility_scope = 'area_visible'`;

      await rebuilder.rebuildArea();
      const afterHits = await repo.searchArea("dusty books", locId, 10);
      expect(afterHits.length).toBe(0);
    });
  });

});
