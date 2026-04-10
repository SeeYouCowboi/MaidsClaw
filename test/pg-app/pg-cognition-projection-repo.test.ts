import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { PgCognitionProjectionRepo } from "../../src/storage/domain-repos/pg/cognition-projection-repo.js";
import { PgGraphMutableStoreRepo } from "../../src/storage/domain-repos/pg/graph-mutable-store-repo.js";
import type { CognitionEventRow } from "../../src/memory/cognition/cognition-event-repo.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

function makeEvent(overrides: Partial<CognitionEventRow> & { agent_id: string; cognition_key: string }): CognitionEventRow {
  return {
    id: 1,
    kind: "assertion",
    op: "upsert",
    record_json: JSON.stringify({ sourcePointerKey: "bob", predicate: "likes", targetPointerKey: "alice" }),
    settlement_id: "s-1",
    committed_time: Date.now(),
    created_at: Date.now(),
    ...overrides,
  };
}

describe.skipIf(skipPgTests)("PgCognitionProjectionRepo", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("updateConflictFactors updates conflict_summary and conflict_factor_refs_json", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);
      const repo = new PgCognitionProjectionRepo(sql);

      const event = makeEvent({
        id: 100,
        agent_id: "agent-c",
        cognition_key: "ck-conflict-1",
        record_json: JSON.stringify({
          sourcePointerKey: "bob",
          predicate: "trusts",
          targetPointerKey: "alice",
          stance: "accepted",
          basis: "first_hand",
        }),
      });
      await repo.upsertFromEvent(event);

      const before = await repo.getCurrent("agent-c", "ck-conflict-1");
      expect(before).not.toBeNull();
      expect(before!.conflict_summary).toBeNull();

      const updatedAt = Date.now();
      const factorRefs = JSON.stringify(["assertion:200", "assertion:201"]);
      await repo.updateConflictFactors(
        "agent-c",
        "ck-conflict-1",
        "contested by 2 factors",
        factorRefs,
        updatedAt,
      );

      const after = await repo.getCurrent("agent-c", "ck-conflict-1");
      expect(after).not.toBeNull();
      expect(after!.conflict_summary).toBe("contested by 2 factors");
      expect(after!.conflict_factor_refs_json).not.toBeNull();
      const parsedRefs = JSON.parse(after!.conflict_factor_refs_json!);
      expect(parsedRefs).toEqual(["assertion:200", "assertion:201"]);
      expect(after!.updated_at).toBe(updatedAt);
      expect(after!.stance).toBe("accepted");
    });
  });

  it("contested→rejected without explicit preContestedStance preserves the prior pre_contested_stance", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);
      const repo = new PgCognitionProjectionRepo(sql);
      const agentId = "agent-pre-contested";
      const cognitionKey = "ck-pre-contested";
      const base = {
        sourcePointerKey: "alice",
        predicate: "was_present_at",
        targetPointerKey: "cellar",
      };

      // 1. accepted baseline
      await repo.upsertFromEvent(
        makeEvent({
          id: 400,
          agent_id: agentId,
          cognition_key: cognitionKey,
          committed_time: 1_000,
          record_json: JSON.stringify({ ...base, stance: "accepted", basis: "first_hand" }),
        }),
      );

      // 2. contested with explicit preContestedStance = accepted
      await repo.upsertFromEvent(
        makeEvent({
          id: 401,
          agent_id: agentId,
          cognition_key: cognitionKey,
          committed_time: 2_000,
          record_json: JSON.stringify({
            ...base,
            stance: "contested",
            basis: "inference",
            preContestedStance: "accepted",
          }),
        }),
      );

      const afterContested = await repo.getCurrent(agentId, cognitionKey);
      expect(afterContested?.stance).toBe("contested");
      expect(afterContested?.pre_contested_stance).toBe("accepted");

      // 3. rejected WITHOUT explicit preContestedStance — must not clobber accepted
      await repo.upsertFromEvent(
        makeEvent({
          id: 402,
          agent_id: agentId,
          cognition_key: cognitionKey,
          committed_time: 3_000,
          record_json: JSON.stringify({ ...base, stance: "rejected", basis: "inference" }),
        }),
      );

      const afterRejected = await repo.getCurrent(agentId, cognitionKey);
      expect(afterRejected?.stance).toBe("rejected");
      // Regression guard: prior to the fix, this was literally "contested"
      // because the ON CONFLICT branch wrote `current.stance` into
      // pre_contested_stance instead of preserving `current.pre_contested_stance`.
      expect(afterRejected?.pre_contested_stance).toBe("accepted");
    });
  });

  it("patchRecordJsonSourceEventRef merges into record_json without overwriting", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);
      const repo = new PgCognitionProjectionRepo(sql);

      const originalRecord = {
        sourcePointerKey: "bob",
        predicate: "knows",
        targetPointerKey: "carol",
        stance: "tentative",
        basis: "hearsay",
      };
      const event = makeEvent({
        id: 200,
        agent_id: "agent-d",
        cognition_key: "ck-patch-1",
        record_json: JSON.stringify(originalRecord),
      });
      await repo.upsertFromEvent(event);

      const before = await repo.getCurrent("agent-d", "ck-patch-1");
      expect(before).not.toBeNull();
      const beforeJson = JSON.parse(before!.record_json);
      expect(beforeJson.sourcePointerKey).toBe("bob");
      expect(beforeJson.sourceEventRef).toBeUndefined();

      const updatedAt = Date.now();
      await repo.patchRecordJsonSourceEventRef(before!.id, "episode:42", updatedAt);

      const after = await repo.getCurrent("agent-d", "ck-patch-1");
      expect(after).not.toBeNull();
      const afterJson = JSON.parse(after!.record_json);
      expect(afterJson.sourceEventRef).toBe("episode:42");
      expect(afterJson.sourcePointerKey).toBe("bob");
      expect(afterJson.predicate).toBe("knows");
      expect(afterJson.targetPointerKey).toBe("carol");
      expect(after!.updated_at).toBe(updatedAt);
    });
  });

  it("resolveEntityByPointerKey returns private_overlay before shared_public", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);
      const repo = new PgCognitionProjectionRepo(sql);
      const storage = new PgGraphMutableStoreRepo(sql);

      const publicId = await storage.upsertEntity({
        pointerKey: "resolve-test-entity",
        displayName: "Public Entity",
        entityType: "person",
        memoryScope: "shared_public",
      });

      const privateId = await storage.upsertEntity({
        pointerKey: "resolve-test-entity",
        displayName: "Private Entity",
        entityType: "person",
        memoryScope: "private_overlay",
        ownerAgentId: "agent-e",
      });

      expect(publicId).not.toBe(privateId);

      const resolved = await repo.resolveEntityByPointerKey("resolve-test-entity", "agent-e");
      expect(resolved).toBe(privateId);
    });
  });

  it("resolveEntityByPointerKey falls back to shared_public when no private overlay", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);
      const repo = new PgCognitionProjectionRepo(sql);
      const storage = new PgGraphMutableStoreRepo(sql);

      const publicId = await storage.upsertEntity({
        pointerKey: "resolve-fallback-entity",
        displayName: "Public Only Entity",
        entityType: "person",
        memoryScope: "shared_public",
      });

      const resolved = await repo.resolveEntityByPointerKey("resolve-fallback-entity", "agent-f");
      expect(resolved).toBe(publicId);
    });
  });

  it("resolveEntityByPointerKey returns null when entity does not exist", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      await bootstrapDerivedSchema(sql);
      const repo = new PgCognitionProjectionRepo(sql);

      const resolved = await repo.resolveEntityByPointerKey("nonexistent-entity", "agent-g");
      expect(resolved).toBeNull();
    });
  });
});
