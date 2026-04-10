import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { PgGraphMutableStoreRepo } from "../../src/storage/domain-repos/pg/graph-mutable-store-repo.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

const PG_MAX_BIGINT = "9223372036854775807";

describe.skipIf(skipPgTests)(
  "PgGraphMutableStoreRepo",
  () => {
    let pool: postgres.Sql;

    beforeAll(async () => {
      await ensureTestPgAppDb();
      pool = createTestPgAppPool();
    });

    afterAll(async () => {
      await teardownAppPool(pool);
    });

    it("createProjectedEvent returns numeric id", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapTruthSchema(sql);
        const repo = new PgGraphMutableStoreRepo(sql);

        const id = await repo.createProjectedEvent({
          sessionId: "sess-1",
          summary: "Projected",
          timestamp: 1000,
          participants: "[]",
          locationEntityId: 42,
          eventCategory: "observation",
          origin: "runtime_projection",
        });

        expect(typeof id).toBe("number");
        expect(id).toBeGreaterThan(0);
      });
    });

    it("upsertEntity supports shared_public and private_overlay scopes", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapTruthSchema(sql);
        const repo = new PgGraphMutableStoreRepo(sql);

        const shared1 = await repo.upsertEntity({
          pointerKey: "user:alice",
          displayName: "Alice",
          entityType: "person",
          summary: "first",
          memoryScope: "shared_public",
        });

        const shared2 = await repo.upsertEntity({
          pointerKey: "user:alice",
          displayName: "Alice",
          entityType: "person",
          summary: "updated",
          memoryScope: "shared_public",
        });

        expect(shared2).toBe(shared1);

        const privateA = await repo.upsertEntity({
          pointerKey: "user:alice",
          displayName: "Alice private",
          entityType: "person",
          memoryScope: "private_overlay",
          ownerAgentId: "agent-a",
        });

        const resolvedA = await repo.resolveEntityByPointerKey("user:alice", "agent-a");
        const resolvedB = await repo.resolveEntityByPointerKey("user:alice", "agent-b");

        expect(resolvedA).toBe(privateA);
        expect(resolvedB).toBe(shared1);
      });
    });

    it("createFact inserts fact edge and invalidateFact updates t_invalid", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapTruthSchema(sql);
        const repo = new PgGraphMutableStoreRepo(sql);

        const sourceId = await repo.upsertEntity({
          pointerKey: "entity:source",
          displayName: "Source",
          entityType: "thing",
          memoryScope: "shared_public",
        });
        const targetId = await repo.upsertEntity({
          pointerKey: "entity:target",
          displayName: "Target",
          entityType: "thing",
          memoryScope: "shared_public",
        });

        const factId = await repo.createFact(sourceId, targetId, "related_to");
        expect(factId).toBeGreaterThan(0);

        const before = await sql`
          SELECT t_invalid FROM fact_edges WHERE id = ${factId}
        `;
        expect(String(before[0].t_invalid)).toBe(PG_MAX_BIGINT);

        await repo.invalidateFact(factId);

        const after = await sql`
          SELECT t_invalid FROM fact_edges WHERE id = ${factId}
        `;
        expect(String(after[0].t_invalid)).not.toBe(PG_MAX_BIGINT);
      });
    });

    it("createLogicEdge inserts edge row", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapTruthSchema(sql);
        const repo = new PgGraphMutableStoreRepo(sql);

        const e1 = await repo.createProjectedEvent({
          sessionId: "sess-logic",
          summary: "first",
          timestamp: 1000,
          participants: "[]",
          locationEntityId: 1,
          eventCategory: "action",
          origin: "runtime_projection",
        });
        const e2 = await repo.createProjectedEvent({
          sessionId: "sess-logic",
          summary: "second",
          timestamp: 2000,
          participants: "[]",
          locationEntityId: 1,
          eventCategory: "action",
          origin: "runtime_projection",
        });

        const edgeId = await repo.createLogicEdge(e1, e2, "causal");
        expect(edgeId).toBeGreaterThan(0);

        const rows = await sql`
          SELECT source_event_id, target_event_id, relation_type, weight
          FROM logic_edges
          WHERE id = ${edgeId}
        `;
        expect(Number(rows[0].source_event_id)).toBe(e1);
        expect(Number(rows[0].target_event_id)).toBe(e2);
        expect(rows[0].relation_type).toBe("causal");
        // Weight is optional; unspecified → stored as NULL.
        expect(rows[0].weight).toBeNull();

        // Explicit weight round-trips through INSERT/SELECT.
        const weightedEdgeId = await repo.createLogicEdge(e1, e2, "contradict", 0.85);
        const weightedRows = await sql`
          SELECT relation_type, weight
          FROM logic_edges
          WHERE id = ${weightedEdgeId}
        `;
        expect(weightedRows[0].relation_type).toBe("contradict");
        expect(Number(weightedRows[0].weight)).toBeCloseTo(0.85, 5);
      });
    });

    it("upsertExplicitAssertion writes active explicit_assertion fact edge", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapTruthSchema(sql);
        const repo = new PgGraphMutableStoreRepo(sql);

        await repo.upsertEntity({
          pointerKey: "source:alice",
          displayName: "Alice",
          entityType: "person",
          memoryScope: "shared_public",
        });
        await repo.upsertEntity({
          pointerKey: "target:bob",
          displayName: "Bob",
          entityType: "person",
          memoryScope: "shared_public",
        });

        const first = await repo.upsertExplicitAssertion({
          agentId: "agent-1",
          cognitionKey: "assert:1",
          settlementId: "stl-1",
          opIndex: 0,
          sourcePointerKey: "source:alice",
          predicate: "knows",
          targetPointerKey: "target:bob",
          stance: "accepted",
          basis: "belief",
        });

        const second = await repo.upsertExplicitAssertion({
          agentId: "agent-1",
          cognitionKey: "assert:1",
          settlementId: "stl-2",
          opIndex: 1,
          sourcePointerKey: "source:alice",
          predicate: "knows",
          targetPointerKey: "target:bob",
          stance: "confirmed",
          basis: "first_hand",
        });

        expect(String(first.ref)).toBe(`assertion:${first.id}`);
        expect(String(second.ref)).toBe(`assertion:${second.id}`);

        const activeRows = await sql`
          SELECT fe.id, fe.predicate, fe.t_invalid, fe.source_event_id, pce.cognition_key
          FROM fact_edges fe
          JOIN private_cognition_events pce ON pce.id = fe.source_event_id
          WHERE fe.predicate = 'explicit_assertion'
            AND pce.agent_id = 'agent-1'
            AND pce.cognition_key = 'assert:1'
            AND fe.t_invalid = ${PG_MAX_BIGINT}
          ORDER BY fe.id DESC
        `;

        expect(activeRows).toHaveLength(1);
        expect(Number(activeRows[0].id)).toBe(second.id);
      });
    });
  },
);
