import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { PgGraphMutableStoreRepo } from "../../src/storage/domain-repos/pg/graph-mutable-store-repo.js";
import { PgUnresolvedWorldStateOpsRepo } from "../../src/storage/domain-repos/pg/unresolved-world-state-ops-repo.js";
import { DEAD_LETTER_THRESHOLD } from "../../src/storage/domain-repos/contracts/unresolved-world-state-ops-repo.js";
import type { WorldStateOp } from "../../src/runtime/rp-turn-contract.js";
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
          SELECT t_invalid::text AS t_invalid FROM fact_edges WHERE id = ${factId}
        `;
        expect(String(before[0].t_invalid)).toBe(PG_MAX_BIGINT);

        await repo.invalidateFact(factId);

        const after = await sql`
          SELECT t_invalid::text AS t_invalid FROM fact_edges WHERE id = ${factId}
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
          SELECT source_event_id, target_event_id, relation_type, weight, source_kind, source_ref
          FROM logic_edges
          WHERE id = ${edgeId}
        `;
        expect(Number(rows[0].source_event_id)).toBe(e1);
        expect(Number(rows[0].target_event_id)).toBe(e2);
        expect(rows[0].relation_type).toBe("causal");
        // Weight is optional; unspecified → stored as NULL.
        expect(rows[0].weight).toBeNull();
        expect(rows[0].source_kind).toBe("derived");
        expect(rows[0].source_ref).toBe("graph-mutable-store:createLogicEdge");

        // Explicit weight round-trips through INSERT/SELECT.
        const weightedEdgeId = await repo.createLogicEdge(e1, e2, "contradict", 0.85, "turn", "turn:settlement-1:3");
        const weightedRows = await sql`
          SELECT relation_type, weight, source_kind, source_ref
          FROM logic_edges
          WHERE id = ${weightedEdgeId}
        `;
        expect(weightedRows[0].relation_type).toBe("contradict");
        expect(Number(weightedRows[0].weight)).toBeCloseTo(0.85, 5);
        expect(weightedRows[0].source_kind).toBe("turn");
        expect(weightedRows[0].source_ref).toBe("turn:settlement-1:3");
      });
    });

    it("createSameEpisodeEdges writes derived provenance defaults", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapTruthSchema(sql);
        const repo = new PgGraphMutableStoreRepo(sql);

        const e1 = await repo.createProjectedEvent({
          sessionId: "sess-same-episode",
          summary: "first",
          timestamp: 1000,
          participants: "[]",
          locationEntityId: 1,
          eventCategory: "action",
          origin: "runtime_projection",
          topicId: 7,
        });
        const e2 = await repo.createProjectedEvent({
          sessionId: "sess-same-episode",
          summary: "second",
          timestamp: 2000,
          participants: "[]",
          locationEntityId: 1,
          eventCategory: "action",
          origin: "runtime_projection",
          topicId: 7,
        });

        await repo.createSameEpisodeEdges([
          { id: e1, session_id: "sess-same-episode", topic_id: 7, timestamp: 1000 },
          { id: e2, session_id: "sess-same-episode", topic_id: 7, timestamp: 2000 },
        ]);

        const rows = await sql`
          SELECT source_event_id, target_event_id, relation_type, source_kind, source_ref
          FROM logic_edges
          WHERE relation_type = 'same_episode'
          ORDER BY id ASC
        `;

        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.relation_type).toBe("same_episode");
          expect(row.source_kind).toBe("derived");
          expect(row.source_ref).toBe("same_episode:auto");
        }
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
          holderPointerKey: "source:alice",
          claim: "knows",
          entityPointerKeys: ["target:bob"],
          stance: "accepted",
          basis: "belief",
        });

        const second = await repo.upsertExplicitAssertion({
          agentId: "agent-1",
          cognitionKey: "assert:1",
          settlementId: "stl-2",
          opIndex: 1,
          holderPointerKey: "source:alice",
          claim: "knows",
          entityPointerKeys: ["target:bob"],
          stance: "confirmed",
          basis: "first_hand",
        });

        expect(String(first.ref)).toBe(`assertion:${first.id}`);
        expect(String(second.ref)).toBe(`assertion:${second.id}`);

        const activeRows = await sql`
          SELECT
            fe.id,
            fe.predicate,
            fe.t_invalid,
            fe.source_event_id,
            fe.owner_agent_id,
            fe.source_kind,
            fe.source_ref,
            fe.fact_text,
            pce.cognition_key
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
        expect(activeRows[0].owner_agent_id).toBe("agent-1");
        expect(activeRows[0].source_kind).toBe("derived");
        expect(activeRows[0].source_ref).toBe("graph-mutable-store:upsertExplicitAssertion");
        expect(activeRows[0].fact_text).toBeNull();
      });
    });

    it("createWorldStateFactEdge invalidates contradicted rows only within owner scope", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapTruthSchema(sql);
        const repo = new PgGraphMutableStoreRepo(sql);

        const sourceId = await repo.upsertEntity({
          pointerKey: "entity:ws-source",
          displayName: "World Source",
          entityType: "thing",
          memoryScope: "shared_public",
        });
        const targetId = await repo.upsertEntity({
          pointerKey: "entity:ws-target",
          displayName: "World Target",
          entityType: "thing",
          memoryScope: "shared_public",
        });

        const ownerAOld = await repo.createWorldStateFactEdge({
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          predicate: "holds",
          factText: "A old fact",
          ownerAgentId: "agent-A",
          sourceKind: "settlement",
          sourceRef: "settlement-A:0",
          tValid: 1000,
        });
        const ownerBOld = await repo.createWorldStateFactEdge({
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          predicate: "holds",
          factText: "B old fact",
          ownerAgentId: "agent-B",
          sourceKind: "settlement",
          sourceRef: "settlement-B:0",
          tValid: 1001,
        });

        const ownerANew = await repo.createWorldStateFactEdge({
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          predicate: "holds",
          factText: "A new fact",
          ownerAgentId: "agent-A",
          sourceKind: "settlement",
          sourceRef: "settlement-A:1",
          tValid: 1002,
          contradictedFactEdgeIds: [ownerAOld.id, ownerBOld.id],
        });

        expect(ownerANew.created).toBe(true);

        const oldRows = await sql`
          SELECT id, owner_agent_id, t_invalid::text AS t_invalid
          FROM fact_edges
          WHERE id IN (${ownerAOld.id}, ${ownerBOld.id})
          ORDER BY id ASC
        `;
        expect(oldRows).toHaveLength(2);
        const ownerAOldRow = oldRows.find((row) => Number(row.id) === ownerAOld.id);
        const ownerBOldRow = oldRows.find((row) => Number(row.id) === ownerBOld.id);
        expect(ownerAOldRow?.owner_agent_id).toBe("agent-A");
        expect(ownerBOldRow?.owner_agent_id).toBe("agent-B");
        expect(String(ownerAOldRow?.t_invalid)).not.toBe(PG_MAX_BIGINT);
        expect(String(ownerBOldRow?.t_invalid)).toBe(PG_MAX_BIGINT);

        const activeForA = await repo.activeFactEdgesByOwner(sourceId, "holds", targetId, "agent-A");
        const activeForB = await repo.activeFactEdgesByOwner(sourceId, "holds", targetId, "agent-B");
        expect(activeForA.map((row) => row.id)).toEqual([ownerANew.id]);
        expect(activeForB.map((row) => row.id)).toEqual([ownerBOld.id]);
      });
    });

    it("createWorldStateFactEdge is idempotent on settlement source ref retries", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapTruthSchema(sql);
        const repo = new PgGraphMutableStoreRepo(sql);

        const sourceId = await repo.upsertEntity({
          pointerKey: "entity:retry-source",
          displayName: "Retry Source",
          entityType: "thing",
          memoryScope: "shared_public",
        });
        const targetId = await repo.upsertEntity({
          pointerKey: "entity:retry-target",
          displayName: "Retry Target",
          entityType: "thing",
          memoryScope: "shared_public",
        });

        const first = await repo.createWorldStateFactEdge({
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          predicate: "knows",
          factText: "retry fact",
          ownerAgentId: "agent-retry",
          sourceKind: "settlement",
          sourceRef: "settlement-retry:4",
          tValid: 2000,
        });
        const second = await repo.createWorldStateFactEdge({
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          predicate: "knows",
          factText: "retry fact ignored on replay",
          ownerAgentId: "agent-retry",
          sourceKind: "settlement",
          sourceRef: "settlement-retry:4",
          tValid: 2001,
        });

        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.id).toBe(first.id);

        const rows = await sql`
          SELECT id, t_invalid::text AS t_invalid
          FROM fact_edges
          WHERE source_kind = 'settlement'
            AND source_ref = 'settlement-retry:4'
          ORDER BY id ASC
        `;

        expect(rows).toHaveLength(1);
        expect(Number(rows[0].id)).toBe(first.id);
        expect(String(rows[0].t_invalid)).toBe(PG_MAX_BIGINT);
      });
    });

    it("createFact and explicit cognition writers keep deterministic provenance defaults", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapTruthSchema(sql);
        const repo = new PgGraphMutableStoreRepo(sql);

        const sourceId = await repo.upsertEntity({
          pointerKey: "entity:compat-source",
          displayName: "Compat Source",
          entityType: "thing",
          memoryScope: "shared_public",
        });
        const targetId = await repo.upsertEntity({
          pointerKey: "entity:compat-target",
          displayName: "Compat Target",
          entityType: "thing",
          memoryScope: "shared_public",
        });

        const plainFactId = await repo.createFact(sourceId, targetId, "related_to");
        const plainFactRows = await sql`
          SELECT source_kind, source_ref, owner_agent_id, fact_text
          FROM fact_edges
          WHERE id = ${plainFactId}
        `;
        expect(plainFactRows[0].source_kind).toBe("derived");
        expect(plainFactRows[0].source_ref).toBe("graph-mutable-store:createFact");
        expect(plainFactRows[0].owner_agent_id).toBeNull();
        expect(plainFactRows[0].fact_text).toBeNull();

        await repo.upsertEntity({
          pointerKey: "compat:holder",
          displayName: "Holder",
          entityType: "person",
          memoryScope: "shared_public",
        });
        await repo.upsertEntity({
          pointerKey: "compat:other",
          displayName: "Other",
          entityType: "person",
          memoryScope: "shared_public",
        });

        await repo.upsertExplicitAssertion({
          agentId: "agent-compat",
          cognitionKey: "assert:compat",
          settlementId: "set-compat",
          opIndex: 0,
          holderPointerKey: "compat:holder",
          claim: "knows",
          entityPointerKeys: ["compat:other"],
          stance: "accepted",
        });
        await repo.upsertExplicitEvaluation({
          agentId: "agent-compat",
          cognitionKey: "eval:compat",
          settlementId: "set-compat",
          opIndex: 1,
          dimensions: [{ name: "confidence", value: 0.8 }],
        });
        await repo.upsertExplicitCommitment({
          agentId: "agent-compat",
          cognitionKey: "commit:compat",
          settlementId: "set-compat",
          opIndex: 2,
          mode: "goal",
          target: { type: "demo" },
          status: "active",
        });

        const cognitionRows = await sql`
          SELECT predicate, owner_agent_id, source_kind, source_ref, fact_text
          FROM fact_edges
          WHERE predicate IN ('explicit_assertion', 'explicit_evaluation', 'explicit_commitment')
          ORDER BY predicate ASC
        `;

        expect(cognitionRows).toHaveLength(3);
        expect(cognitionRows.map((row) => row.predicate)).toEqual([
          "explicit_assertion",
          "explicit_commitment",
          "explicit_evaluation",
        ]);
        for (const row of cognitionRows) {
          expect(row.owner_agent_id).toBe("agent-compat");
          expect(row.source_kind).toBe("derived");
          expect(String(row.source_ref)).toMatch(/^graph-mutable-store:upsertExplicit/);
          expect(row.fact_text).toBeNull();
        }
      });
    });

    it("PgUnresolvedWorldStateOpsRepo enqueueOp is idempotent and supports queue lifecycle", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapTruthSchema(sql);
        const queue = new PgUnresolvedWorldStateOpsRepo(sql);

        const op: WorldStateOp = {
          subject: { kind: "pointer_key", value: "p:alice" },
          predicate: "knows",
          object: { kind: "pointer_key", value: "p:bob" },
          factText: "Alice knows Bob",
        };

        const first = await queue.enqueueOp({
          sessionId: "sess-q",
          settlementId: "stl-q",
          opIndex: 0,
          agentId: "agent-q",
          op,
        });
        expect(first.created).toBe(true);

        const second = await queue.enqueueOp({
          sessionId: "sess-q",
          settlementId: "stl-q",
          opIndex: 0,
          agentId: "agent-q",
          op,
        });
        expect(second.created).toBe(false);
        expect(second.id).toBe(first.id);

        const count = await sql`SELECT COUNT(*)::int AS c FROM unresolved_world_state_ops`;
        expect(Number(count[0].c)).toBe(1);
      });
    });

    it("PgUnresolvedWorldStateOpsRepo transitions: markResolved / incrementRetry / dead-letter at threshold", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapTruthSchema(sql);
        const queue = new PgUnresolvedWorldStateOpsRepo(sql);

        const baseOp: WorldStateOp = {
          subject: { kind: "pointer_key", value: "p:s" },
          predicate: "knows",
          object: { kind: "pointer_key", value: "p:o" },
          factText: "fact",
        };

        const resolved = await queue.enqueueOp({
          sessionId: "s", settlementId: "stl-resolved", opIndex: 0,
          agentId: "agent-x", op: baseOp,
        });
        await queue.markResolved(resolved.id);
        const resolvedRow = await queue.getById(resolved.id);
        expect(resolvedRow!.status).toBe("resolved");

        const retry = await queue.enqueueOp({
          sessionId: "s", settlementId: "stl-retry", opIndex: 0,
          agentId: "agent-x", op: baseOp,
        });
        for (let i = 0; i < DEAD_LETTER_THRESHOLD - 1; i++) {
          await queue.incrementRetry(retry.id, `attempt-${i}`);
        }
        let row = await queue.getById(retry.id);
        expect(row!.status).toBe("pending");
        expect(row!.payload.retryCount).toBe(DEAD_LETTER_THRESHOLD - 1);

        await queue.incrementRetry(retry.id, "final");
        row = await queue.getById(retry.id);
        expect(row!.status).toBe("dead_letter");

        const pending = await queue.listPending({ agentId: "agent-x" });
        expect(pending.find((p) => p.id === retry.id)).toBeUndefined();
        expect(pending.find((p) => p.id === resolved.id)).toBeUndefined();
      });
    });
  },
);
