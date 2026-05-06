import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { applyWorldStateOpsForSettlement } from "../../src/memory/world-state-ops-applier.js";
import { PgGraphMutableStoreRepo } from "../../src/storage/domain-repos/pg/graph-mutable-store-repo.js";
import { PgUnresolvedWorldStateOpsRepo } from "../../src/storage/domain-repos/pg/unresolved-world-state-ops-repo.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-app-test-utils.js";

const PG_MAX_BIGINT = "9223372036854775807";

describe.skipIf(skipPgTests)("worldStateOps fact_edges persistence", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("scripted submit_rp_turn worldStateOps create settlement fact_edges with deterministic source_ref", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const graph = new PgGraphMutableStoreRepo(sql);
      const unresolved = new PgUnresolvedWorldStateOpsRepo(sql);

      const teaRoomId = await graph.upsertEntity({
        pointerKey: "loc:tea-room",
        displayName: "Tea Room",
        entityType: "location",
        memoryScope: "shared_public",
      });
      const silverWatchId = await graph.upsertEntity({
        pointerKey: "item:silver-watch",
        displayName: "Silver Watch",
        entityType: "item",
        memoryScope: "shared_public",
      });

      const result = await applyWorldStateOpsForSettlement({
        settlementId: "stl:worldstate-scripted",
        sessionId: "sess-worldstate",
        agentId: "agent-worldstate",
        worldStateOps: [
          {
            subject: { kind: "pointer_key", value: "loc:tea-room" },
            predicate: "location_of",
            object: { kind: "pointer_key", value: "item:silver-watch" },
            factText: "The silver watch is in the tea room.",
            visibility: "shared_public",
          },
        ],
        graphStoreRepo: graph,
        unresolvedOpsRepo: unresolved,
        settledAt: 1_700_001_000_000,
      });

      expect(result.writtenOps).toBe(1);
      expect(result.enqueuedOps).toBe(0);

      const rows = await sql`
        SELECT source_entity_id, target_entity_id, predicate, fact_text,
               owner_agent_id, source_kind, source_ref, t_valid
        FROM fact_edges
        WHERE source_ref = 'stl:worldstate-scripted:0'
      `;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].source_entity_id)).toBe(teaRoomId);
      expect(Number(rows[0].target_entity_id)).toBe(silverWatchId);
      expect(rows[0].predicate).toBe("location_of");
      expect(rows[0].fact_text).toBe("The silver watch is in the tea room.");
      expect(rows[0].owner_agent_id).toBeNull();
      expect(rows[0].source_kind).toBe("settlement");
      expect(rows[0].source_ref).toBe("stl:worldstate-scripted:0");
      expect(Number(rows[0].t_valid)).toBe(1_700_001_000_000);
    });
  });

  it("unresolved pointer keys enqueue unresolved ops instead of orphan fact_edges", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const graph = new PgGraphMutableStoreRepo(sql);
      const unresolved = new PgUnresolvedWorldStateOpsRepo(sql);

      await graph.upsertEntity({
        pointerKey: "char:known",
        displayName: "Known Character",
        entityType: "person",
        memoryScope: "shared_public",
      });

      const result = await applyWorldStateOpsForSettlement({
        settlementId: "stl:worldstate-unresolved",
        sessionId: "sess-worldstate",
        agentId: "agent-worldstate",
        worldStateOps: [
          {
            subject: { kind: "pointer_key", value: "char:known" },
            predicate: "knows",
            object: { kind: "pointer_key", value: "char:missing" },
            factText: "Known character knows the missing character.",
          },
        ],
        graphStoreRepo: graph,
        unresolvedOpsRepo: unresolved,
        settledAt: 1_700_001_000_100,
      });

      expect(result.writtenOps).toBe(0);
      expect(result.enqueuedOps).toBe(1);

      const factRows = await sql`SELECT id FROM fact_edges`;
      expect(factRows).toHaveLength(0);
      const queuedRows = await sql`
        SELECT settlement_id, op_index, status, op_payload
        FROM unresolved_world_state_ops
      `;
      expect(queuedRows).toHaveLength(1);
      expect(queuedRows[0].settlement_id).toBe("stl:worldstate-unresolved");
      expect(Number(queuedRows[0].op_index)).toBe(0);
      expect(queuedRows[0].status).toBe("pending");
      expect(queuedRows[0].op_payload.objectPointerKey).toBe("char:missing");
    });
  });

  it("contradicted fact ids set t_invalid before inserting the new edge", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const graph = new PgGraphMutableStoreRepo(sql);
      const unresolved = new PgUnresolvedWorldStateOpsRepo(sql);

      const aliceId = await graph.upsertEntity({
        pointerKey: "char:alice-contradict",
        displayName: "Alice",
        entityType: "person",
        memoryScope: "shared_public",
      });
      const bobId = await graph.upsertEntity({
        pointerKey: "char:bob-contradict",
        displayName: "Bob",
        entityType: "person",
        memoryScope: "shared_public",
      });
      const oldFact = await graph.createWorldStateFactEdge({
        sourceEntityId: aliceId,
        targetEntityId: bobId,
        predicate: "trusts",
        factText: "Alice trusts Bob.",
        ownerAgentId: "agent-worldstate",
        sourceKind: "settlement",
        sourceRef: "stl:old-trust:0",
        tValid: 1_000,
      });

      const result = await applyWorldStateOpsForSettlement({
        settlementId: "stl:worldstate-contradict",
        sessionId: "sess-worldstate",
        agentId: "agent-worldstate",
        worldStateOps: [
          {
            subject: { kind: "pointer_key", value: "char:alice-contradict" },
            predicate: "conflicts_with",
            object: { kind: "pointer_key", value: "char:bob-contradict" },
            factText: "Alice is now in conflict with Bob.",
            contradictedFactEdgeIds: [oldFact.id],
          },
        ],
        graphStoreRepo: graph,
        unresolvedOpsRepo: unresolved,
        settledAt: 2_000,
      });

      expect(result.writtenOps).toBe(1);
      const rows = await sql`
        SELECT id, predicate, source_ref, t_invalid::text AS t_invalid
        FROM fact_edges
        ORDER BY id ASC
      `;
      expect(rows).toHaveLength(2);
      const oldRow = rows.find((row) => Number(row.id) === oldFact.id);
      const newRow = rows.find((row) => row.source_ref === "stl:worldstate-contradict:0");
      expect(String(oldRow?.t_invalid)).not.toBe(PG_MAX_BIGINT);
      expect(newRow?.predicate).toBe("conflicts_with");
      expect(String(newRow?.t_invalid)).toBe(PG_MAX_BIGINT);
    });
  });

  it("repeated same subject predicate object across settlements leaves exactly one active relation row", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const graph = new PgGraphMutableStoreRepo(sql);
      const unresolved = new PgUnresolvedWorldStateOpsRepo(sql);

      await graph.upsertEntity({
        pointerKey: "char:repeat-alice-pipeline",
        displayName: "Alice",
        entityType: "person",
        memoryScope: "shared_public",
      });
      await graph.upsertEntity({
        pointerKey: "char:repeat-bob-pipeline",
        displayName: "Bob",
        entityType: "person",
        memoryScope: "shared_public",
      });

      for (const [settlementId, factText, settledAt] of [
        ["stl:repeat-pipeline-1", "Alice trusts Bob.", 3_000],
        ["stl:repeat-pipeline-2", "Alice continues to trust Bob.", 4_000],
      ] as const) {
        const result = await applyWorldStateOpsForSettlement({
          settlementId,
          sessionId: "sess-worldstate",
          agentId: "agent-worldstate",
          worldStateOps: [
            {
              subject: { kind: "pointer_key", value: "char:repeat-alice-pipeline" },
              predicate: "trusts",
              object: { kind: "pointer_key", value: "char:repeat-bob-pipeline" },
              factText,
            },
          ],
          graphStoreRepo: graph,
          unresolvedOpsRepo: unresolved,
          settledAt,
        });
        expect(result.writtenOps).toBe(1);
      }

      const rows = await sql`
        SELECT predicate, fact_text, t_valid, t_created, t_invalid::text AS t_invalid
        FROM fact_edges
        WHERE predicate = 'trusts'
          AND owner_agent_id = 'agent-worldstate'
          AND t_invalid = ${PG_MAX_BIGINT}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].fact_text).toBe("Alice continues to trust Bob.");
      expect(Number(rows[0].t_valid)).toBe(4_000);
      expect(Number(rows[0].t_created)).toBeGreaterThanOrEqual(4_000);
    });
  });
});
