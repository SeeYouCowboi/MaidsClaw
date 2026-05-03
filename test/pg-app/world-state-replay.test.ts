import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { PgGraphMutableStoreRepo } from "../../src/storage/domain-repos/pg/graph-mutable-store-repo.js";
import { PgUnresolvedWorldStateOpsRepo } from "../../src/storage/domain-repos/pg/unresolved-world-state-ops-repo.js";
import { DEAD_LETTER_THRESHOLD } from "../../src/storage/domain-repos/contracts/unresolved-world-state-ops-repo.js";
import { replayUnresolvedWorldStateOps } from "../../src/memory/world-state-ops-replayer.js";
import type { WorldStateOp } from "../../src/runtime/rp-turn-contract.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("world-state replay (PG-integrated)", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("replays a queued op once entities exist, writes fact_edge, marks resolved", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const graphStoreRepo = new PgGraphMutableStoreRepo(sql);
      const unresolvedOpsRepo = new PgUnresolvedWorldStateOpsRepo(sql);

      const op: WorldStateOp = {
        subject: { kind: "pointer_key", value: "p:alice" },
        predicate: "knows",
        object: { kind: "pointer_key", value: "p:bob" },
        factText: "Alice knows Bob",
        validTime: 5_000,
      };

      const enqueued = await unresolvedOpsRepo.enqueueOp({
        sessionId: "sess-replay",
        settlementId: "stl-replay-ok",
        opIndex: 0,
        agentId: "agent-r",
        op,
        turnTimestamp: 5_000,
      });
      expect(enqueued.created).toBe(true);

      const firstAttempt = await replayUnresolvedWorldStateOps("agent-r", {
        graphStoreRepo,
        unresolvedOpsRepo,
      });
      expect(firstAttempt.replayed).toBe(0);
      expect(firstAttempt.stillPending).toBe(1);

      await graphStoreRepo.upsertEntity({
        pointerKey: "p:alice",
        displayName: "Alice",
        entityType: "person",
        memoryScope: "shared_public",
      });
      await graphStoreRepo.upsertEntity({
        pointerKey: "p:bob",
        displayName: "Bob",
        entityType: "person",
        memoryScope: "shared_public",
      });

      const secondAttempt = await replayUnresolvedWorldStateOps("agent-r", {
        graphStoreRepo,
        unresolvedOpsRepo,
      });
      expect(secondAttempt.replayed).toBe(1);
      expect(secondAttempt.stillPending).toBe(0);

      const row = await unresolvedOpsRepo.getById(enqueued.id);
      expect(row?.status).toBe("resolved");

      const factRows = await sql`
        SELECT predicate, fact_text, owner_agent_id, source_kind, source_ref
        FROM fact_edges
        WHERE source_ref = 'stl-replay-ok:0'
      `;
      expect(factRows.length).toBe(1);
      expect(factRows[0].predicate).toBe("knows");
      expect(factRows[0].fact_text).toBe("Alice knows Bob");
      expect(factRows[0].owner_agent_id).toBe("agent-r");
      expect(factRows[0].source_kind).toBe("settlement");
    });
  });

  it("createWorldStateFactEdge replay after invalidation is a NO-OP, not a resurrection (P1-T2 regression)", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const graphStoreRepo = new PgGraphMutableStoreRepo(sql);

      const aliceId = await graphStoreRepo.upsertEntity({
        pointerKey: "p:alice",
        displayName: "Alice",
        entityType: "person",
        memoryScope: "shared_public",
      });
      const bobId = await graphStoreRepo.upsertEntity({
        pointerKey: "p:bob",
        displayName: "Bob",
        entityType: "person",
        memoryScope: "shared_public",
      });

      // Settlement A writes the canonical row.
      const writeA = await graphStoreRepo.createWorldStateFactEdge({
        sourceEntityId: aliceId,
        targetEntityId: bobId,
        predicate: "trusts",
        factText: "Alice trusts Bob",
        ownerAgentId: null,
        sourceKind: "settlement",
        sourceRef: "stl-A:0",
        tValid: 1_000,
      });
      expect(writeA.created).toBe(true);

      // Settlement B writes a contradictory current fact, invalidating A's row.
      const writeB = await graphStoreRepo.createWorldStateFactEdge({
        sourceEntityId: aliceId,
        targetEntityId: bobId,
        predicate: "distrusts",
        factText: "Alice distrusts Bob",
        ownerAgentId: null,
        sourceKind: "settlement",
        sourceRef: "stl-B:0",
        tValid: 2_000,
        contradictedFactEdgeIds: [writeA.id],
      });
      expect(writeB.created).toBe(true);

      // Settlement A is replayed (e.g., from settlement_processing_ledger
      // recovery). Pre-fix this would have inserted a new active row and
      // resurrected the stale fact. Post-fix it is a strict NO-OP returning
      // the original (now invalidated) row id.
      const replayA = await graphStoreRepo.createWorldStateFactEdge({
        sourceEntityId: aliceId,
        targetEntityId: bobId,
        predicate: "trusts",
        factText: "Alice trusts Bob",
        ownerAgentId: null,
        sourceKind: "settlement",
        sourceRef: "stl-A:0",
        tValid: 1_000,
      });
      expect(replayA.created).toBe(false);
      expect(replayA.id).toBe(writeA.id);

      // Exactly two physical rows exist (A invalidated, B active). No third.
      const allRows = await sql`
        SELECT source_ref, t_invalid
        FROM fact_edges
        WHERE source_kind = 'settlement'
        ORDER BY source_ref
      `;
      expect(allRows.length).toBe(2);

      // A is invalidated, B is the only active row.
      const PG_MAX_BIGINT = "9223372036854775807";
      const activeRows = await sql`
        SELECT source_ref FROM fact_edges
        WHERE source_kind = 'settlement' AND t_invalid = ${PG_MAX_BIGINT}
      `;
      expect(activeRows.length).toBe(1);
      expect(activeRows[0].source_ref).toBe("stl-B:0");
    });
  });

  it("flips an unresolvable op to dead_letter once retryCount crosses the threshold", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const graphStoreRepo = new PgGraphMutableStoreRepo(sql);
      const unresolvedOpsRepo = new PgUnresolvedWorldStateOpsRepo(sql);

      const op: WorldStateOp = {
        subject: { kind: "pointer_key", value: "p:ghost-s" },
        predicate: "haunts",
        object: { kind: "pointer_key", value: "p:ghost-o" },
        factText: "ghosts",
      };

      const enqueued = await unresolvedOpsRepo.enqueueOp({
        sessionId: "sess-dl",
        settlementId: "stl-dl",
        opIndex: 0,
        agentId: "agent-dl",
        op,
      });

      await sql`
        UPDATE unresolved_world_state_ops
        SET op_payload = jsonb_set(op_payload, '{retryCount}', to_jsonb(${DEAD_LETTER_THRESHOLD - 1}::int))
        WHERE id = ${enqueued.id}
      `;

      const result = await replayUnresolvedWorldStateOps("agent-dl", {
        graphStoreRepo,
        unresolvedOpsRepo,
      });
      expect(result.replayed).toBe(0);
      expect(result.stillPending).toBe(1);

      const row = await unresolvedOpsRepo.getById(enqueued.id);
      expect(row?.status).toBe("dead_letter");
      expect(row?.payload.retryCount).toBe(DEAD_LETTER_THRESHOLD);
    });
  });
});
