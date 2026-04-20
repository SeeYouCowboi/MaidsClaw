import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { PgAreaWorldProjectionRepo } from "../../src/storage/domain-repos/pg/area-world-projection-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

async function bootstrapAll(pool: postgres.Sql): Promise<void> {
  await bootstrapTruthSchema(pool);
  await bootstrapDerivedSchema(pool);
}

describe.skipIf(skipPgTests)("scene-retrieval-isolation", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    sql = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(sql);
  });

  it("same-session cross-agent sharing: area fact written by agent-A is visible to agent-B in same session", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapAll(pool);
      const repo = new PgAreaWorldProjectionRepo(pool);
      const now = new Date("2026-04-20T18:00:00.000Z");

      await repo.applyAreaFactCommit({
        sessionId: "iso-sess-1",
        areaId: 5,
        factKey: "status:lamp",
        valueJson: { state: "lit" },
        sourceKind: "action_commitment",
        exposureScope: "area_visible",
        sourceSettlementId: "stl-iso-area-1",
        sourceAgentId: "agent-A",
        validTime: now,
        committedTime: now,
      });

      const rows = await repo.getVisibleAreaFacts({
        sessionId: "iso-sess-1",
        areaId: 5,
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.factKey).toBe("status:lamp");
    });
  });

  it("same-area cross-session isolation: area fact from session A is NOT visible in session B", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapAll(pool);
      const repo = new PgAreaWorldProjectionRepo(pool);
      const now = new Date("2026-04-20T18:00:01.000Z");

      await repo.applyAreaFactCommit({
        sessionId: "iso-sess-A",
        areaId: 5,
        factKey: "status:lamp",
        valueJson: { state: "lit" },
        sourceKind: "action_commitment",
        exposureScope: "area_visible",
        sourceSettlementId: "stl-iso-area-2",
        sourceAgentId: "agent-A",
        validTime: now,
        committedTime: now,
      });

      const rows = await repo.getVisibleAreaFacts({
        sessionId: "iso-sess-B",
        areaId: 5,
      });

      expect(rows).toHaveLength(0);
    });
  });

  it("same-session world fact cross-agent sharing: world fact written by agent-A is visible when queried for same session", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapAll(pool);
      const repo = new PgAreaWorldProjectionRepo(pool);
      const now = new Date("2026-04-20T18:00:02.000Z");

      await repo.applyWorldFactCommit({
        sessionId: "iso-sess-2",
        factKey: "location:crown",
        valueJson: { where: "vault" },
        sourceKind: "action_commitment",
        exposureScope: "world_public",
        sourceSettlementId: "stl-iso-world-1",
        sourceAgentId: "agent-A",
        validTime: now,
        committedTime: now,
      });

      const rows = await repo.getVisibleWorldFacts({
        sessionId: "iso-sess-2",
      });

      expect(rows).toHaveLength(1);
    });
  });

  it("cross-session world fact isolation: world fact from session A is NOT visible for session B", async () => {
    await withTestAppSchema(sql, async (pool) => {
      await bootstrapAll(pool);
      const repo = new PgAreaWorldProjectionRepo(pool);
      const now = new Date("2026-04-20T18:00:03.000Z");

      await repo.applyWorldFactCommit({
        sessionId: "iso-sess-world-A",
        factKey: "location:crown",
        valueJson: { where: "vault" },
        sourceKind: "action_commitment",
        exposureScope: "world_public",
        sourceSettlementId: "stl-iso-world-2",
        sourceAgentId: "agent-A",
        validTime: now,
        committedTime: now,
      });

      const rows = await repo.getVisibleWorldFacts({
        sessionId: "iso-sess-world-B",
      });

      expect(rows).toHaveLength(0);
    });
  });
});
