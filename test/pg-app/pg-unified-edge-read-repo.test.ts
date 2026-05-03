import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { PgUnifiedEdgeReadRepo } from "../../src/storage/domain-repos/pg/unified-edge-read-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  seedVisibleEndpoints,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

const PG_MAX_BIGINT = "9223372036854775807";

describe.skipIf(skipPgTests)("PgUnifiedEdgeReadRepo", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("edgesFrom/edgesTo/edgesAround normalize records across all physical tables", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);
      const repo = new PgUnifiedEdgeReadRepo(sql);

      await sql.unsafe(`
        INSERT INTO logic_edges
          (source_event_id, target_event_id, relation_type, weight, created_at, source_kind, source_ref)
        VALUES (10, 11, 'causal', 0.91, 1000, 'derived', 'logic:seed')
      `);

      await sql.unsafe(`
        INSERT INTO memory_relations
          (source_node_ref, target_node_ref, relation_type, strength, source_kind, source_ref, created_at, updated_at)
        VALUES ('event:10', 'assertion:20', 'supports', 0.8, 'turn', 'turn:1:0', 1100, 1100)
      `);

      await sql.unsafe(`
        INSERT INTO semantic_edges
          (source, target, relation_type, weight, created_at, updated_at, source_kind, source_ref)
        VALUES ('event:10', 'entity:2', 'semantic_similar', 0.7, 1200, 1200, 'derived', 'semantic:seed')
      `);

      await sql.unsafe(`
        INSERT INTO fact_edges
          (source_entity_id, target_entity_id, predicate, fact_text, owner_agent_id, source_kind, source_ref, t_valid, t_invalid, t_created, t_expired, source_event_id)
        VALUES
          (2, 3, 'located_at', 'Entity 2 is at Entity 3', NULL, 'settlement', 'stl-1:0', 1300, ${PG_MAX_BIGINT}, 1300, ${PG_MAX_BIGINT}, NULL)
      `);

      await seedVisibleEndpoints(sql, [
        "event:10", "event:11", "entity:2", "entity:3", "assertion:20",
      ]);

      const aroundEvent = await repo.edgesAround("event:10", { viewerAgentId: "agent-a" });
      const aroundEntity = await repo.edgesAround("entity:2", { viewerAgentId: "agent-a" });
      const tables = new Set([...aroundEvent, ...aroundEntity].map((edge) => edge.table));

      expect(tables).toEqual(new Set(["logic_edges", "memory_relations", "semantic_edges", "fact_edges"]));

      const semantic = aroundEvent.find((edge) => edge.table === "semantic_edges");
      expect(semantic?.sourceRef).toBe("event:10");
      expect(semantic?.targetRef).toBe("entity:2");

      const fact = aroundEntity.find((edge) => edge.table === "fact_edges");
      expect(fact?.sourceRef).toBe("entity:2");
      expect(fact?.targetRef).toBe("entity:3");
      expect(fact?.sourceRefOrigin).toBe("stl-1:0");
      expect(fact?.tInvalid).toBeNull();
    });
  });

  it("worldStateOf excludes migration/internal rows and enforces owner visibility", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);
      const repo = new PgUnifiedEdgeReadRepo(sql);

      await sql.unsafe(`
        INSERT INTO fact_edges
          (source_entity_id, target_entity_id, predicate, fact_text, owner_agent_id, source_kind, source_ref, t_valid, t_invalid, t_created, t_expired, source_event_id)
        VALUES
          (5, 6, 'affinity', 'shared row', NULL, 'settlement', 'stl-2:0', 1000, ${PG_MAX_BIGINT}, 1000, ${PG_MAX_BIGINT}, NULL),
          (5, 7, 'private_owner', 'owner row', 'agent-a', 'settlement', 'stl-2:1', 1001, ${PG_MAX_BIGINT}, 1001, ${PG_MAX_BIGINT}, NULL),
          (5, 8, 'private_other', 'other owner row', 'agent-b', 'settlement', 'stl-2:2', 1002, ${PG_MAX_BIGINT}, 1002, ${PG_MAX_BIGINT}, NULL),
          (5, 9, 'explicit_assertion', 'internal assertion', 'agent-a', 'settlement', 'stl-2:3', 1003, ${PG_MAX_BIGINT}, 1003, ${PG_MAX_BIGINT}, NULL),
          (5, 10, 'migrated', 'legacy migration', NULL, 'migration', 'legacy:1', 1004, ${PG_MAX_BIGINT}, 1004, ${PG_MAX_BIGINT}, NULL),
          (5, 11, 'null_fact_text', NULL, NULL, 'settlement', 'stl-2:4', 1005, ${PG_MAX_BIGINT}, 1005, ${PG_MAX_BIGINT}, NULL)
      `);

      await seedVisibleEndpoints(sql, [
        "entity:5", "entity:6", "entity:7", "entity:8", "entity:9", "entity:10", "entity:11",
      ]);

      const ownerView = await repo.worldStateOf("entity:5", { viewerAgentId: "agent-a" });
      const nonOwnerView = await repo.worldStateOf("entity:5", { viewerAgentId: "agent-z" });

      expect(new Set(ownerView.map((edge) => edge.edgeKind))).toEqual(new Set(["affinity", "private_owner"]));
      expect(new Set(nonOwnerView.map((edge) => edge.edgeKind))).toEqual(new Set(["affinity"]));
    });
  });

  it("applies asOf semantics for world_state and created_at semantics for other layers", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);
      const repo = new PgUnifiedEdgeReadRepo(sql);

      await sql.unsafe(`
        INSERT INTO fact_edges
          (source_entity_id, target_entity_id, predicate, fact_text, owner_agent_id, source_kind, source_ref, t_valid, t_invalid, t_created, t_expired, source_event_id)
        VALUES
          (12, 13, 'phase_one', 'phase one', NULL, 'settlement', 'stl-3:0', 100, 200, 100, 200, NULL),
          (12, 14, 'phase_two', 'phase two', NULL, 'settlement', 'stl-3:1', 220, ${PG_MAX_BIGINT}, 220, ${PG_MAX_BIGINT}, NULL)
      `);

      await sql.unsafe(`
        INSERT INTO logic_edges
          (source_event_id, target_event_id, relation_type, weight, created_at, source_kind, source_ref)
        VALUES
          (77, 78, 'causal', 0.9, 100, 'derived', 'logic:old'),
          (77, 79, 'causal', 0.8, 300, 'derived', 'logic:new')
      `);

      await seedVisibleEndpoints(sql, [
        "entity:12", "entity:13", "entity:14", "event:77", "event:78", "event:79",
      ]);

      const asOf150 = await repo.worldStateOf("entity:12", { asOf: 150, viewerAgentId: "agent-a" });
      const asOf300 = await repo.worldStateOf("entity:12", { asOf: 300, viewerAgentId: "agent-a" });

      expect(asOf150.map((edge) => edge.edgeKind)).toEqual(["phase_one"]);
      expect(asOf300.map((edge) => edge.edgeKind)).toEqual(["phase_two"]);

      const earlyNarrative = await repo.edgesFrom("event:77", { asOf: 150 });
      const fullNarrative = await repo.edgesFrom("event:77", { asOf: 400 });

      expect(earlyNarrative.map((edge) => edge.targetRef)).toEqual(["event:78"]);
      expect(new Set(fullNarrative.map((edge) => edge.targetRef))).toEqual(new Set(["event:78", "event:79"]));
    });
  });

  it("endpoint visibility cascade hides edges whose endpoints are private to other agents (P1-T3 regression)", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);
      const repo = new PgUnifiedEdgeReadRepo(sql);

      const now = Date.now();
      // Public-facing entity that several edges anchor on.
      await sql`
        INSERT INTO entity_nodes
          (id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
        VALUES (200, 'e:200', 'Public', 'thing', 'shared_public', NULL, ${now}, ${now})
      `;
      // Two private-overlay entities owned by different agents.
      await sql`
        INSERT INTO entity_nodes
          (id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
        VALUES
          (201, 'e:201', 'PrivateA', 'thing', 'private_overlay', 'agent-a', ${now}, ${now}),
          (202, 'e:202', 'PrivateB', 'thing', 'private_overlay', 'agent-b', ${now}, ${now})
      `;

      // Shared world-state edge: 200 → 201 (agent-a's private endpoint)
      // Cross-agent world-state edge: 200 → 202 (agent-b's private endpoint)
      await sql.unsafe(`
        INSERT INTO fact_edges
          (source_entity_id, target_entity_id, predicate, fact_text, owner_agent_id, source_kind, source_ref, t_valid, t_invalid, t_created, t_expired, source_event_id)
        VALUES
          (200, 201, 'visits', 'public visits PrivateA', NULL, 'settlement', 'stl-cascade:0', 1, ${PG_MAX_BIGINT}, 1, ${PG_MAX_BIGINT}, NULL),
          (200, 202, 'visits', 'public visits PrivateB', NULL, 'settlement', 'stl-cascade:1', 1, ${PG_MAX_BIGINT}, 1, ${PG_MAX_BIGINT}, NULL)
      `);

      // agent-a sees only the edge whose private endpoint is theirs.
      const agentAView = await repo.edgesFrom("entity:200", { viewerAgentId: "agent-a" });
      const agentATargets = new Set(agentAView.map((edge) => edge.targetRef));
      expect(agentATargets).toEqual(new Set(["entity:201"]));

      // agent-b sees only the edge whose private endpoint is theirs.
      const agentBView = await repo.edgesFrom("entity:200", { viewerAgentId: "agent-b" });
      const agentBTargets = new Set(agentBView.map((edge) => edge.targetRef));
      expect(agentBTargets).toEqual(new Set(["entity:202"]));

      // No-viewer (system) caller bypasses cascade and sees both rows.
      const systemView = await repo.edgesFrom("entity:200");
      const systemTargets = new Set(systemView.map((edge) => edge.targetRef));
      expect(systemTargets).toEqual(new Set(["entity:201", "entity:202"]));
    });
  });

  it("endpoint cascade hides logic_edges whose source/target events are area-restricted to a different area", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);
      const repo = new PgUnifiedEdgeReadRepo(sql);

      const now = Date.now();
      // event:300 → world_public (always visible)
      // event:301 → area_visible at area 999 (viewerCurrentAreaId must match)
      // event:302 → area_visible at area 888 (different area)
      await sql`
        INSERT INTO event_nodes
          (id, session_id, timestamp, created_at, visibility_scope, location_entity_id, event_category, event_origin)
        VALUES
          (300, 'sess', ${now}, ${now}, 'world_public', 0, 'speech', 'runtime_projection'),
          (301, 'sess', ${now}, ${now}, 'area_visible', 999, 'speech', 'runtime_projection'),
          (302, 'sess', ${now}, ${now}, 'area_visible', 888, 'speech', 'runtime_projection')
      `;

      await sql.unsafe(`
        INSERT INTO logic_edges
          (source_event_id, target_event_id, relation_type, weight, created_at, source_kind, source_ref)
        VALUES
          (300, 301, 'causal', 0.9, ${now}, 'derived', 'cas:1'),
          (300, 302, 'causal', 0.9, ${now}, 'derived', 'cas:2')
      `);

      // viewer in area 999 sees the public→999 edge but not public→888.
      const inArea999 = await repo.edgesFrom("event:300", {
        viewerAgentId: "agent-a",
        viewerCurrentAreaId: 999,
      });
      const inArea999Targets = new Set(inArea999.map((edge) => edge.targetRef));
      expect(inArea999Targets).toEqual(new Set(["event:301"]));

      // viewer with no area context sees only world_public endpoints; area_visible
      // events on either end exclude the edge.
      const noArea = await repo.edgesFrom("event:300", { viewerAgentId: "agent-a" });
      expect(noArea.length).toBe(0);
    });
  });
});
