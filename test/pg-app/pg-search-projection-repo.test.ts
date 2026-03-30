import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import type { NodeRef } from "../../src/memory/types.js";
import { PgSearchProjectionRepo } from "../../src/storage/domain-repos/pg/search-projection-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("PgSearchProjectionRepo", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("upsertPrivateDoc + searchPrivate finds keyword for agent", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql);
      const repo = new PgSearchProjectionRepo(sql);

      await repo.upsertPrivateDoc({
        sourceRef: "assertion:1" as NodeRef,
        agentId: "agent-a",
        content: "Tea ceremony notes about moonlit garden",
      });
      await repo.upsertPrivateDoc({
        sourceRef: "assertion:2" as NodeRef,
        agentId: "agent-b",
        content: "Completely unrelated private notes",
      });

      const hits = await repo.searchPrivate("moonlit", "agent-a", 10);
      expect(hits.length).toBe(1);
      expect(hits[0].sourceRef).toBe("assertion:1");
      expect(hits[0].agentId).toBe("agent-a");
      expect(hits[0].content).toContain("moonlit garden");
      expect(hits[0].score).toBeGreaterThan(0);
    });
  });

  it("upsertAreaDoc + searchArea filters by location_entity_id", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql);
      const repo = new PgSearchProjectionRepo(sql);

      await repo.upsertAreaDoc({
        sourceRef: "event:100" as NodeRef,
        locationEntityId: 42,
        content: "Garden fountain started glowing at dusk",
      });
      await repo.upsertAreaDoc({
        sourceRef: "event:101" as NodeRef,
        locationEntityId: 999,
        content: "Garden fountain in another location",
      });

      const hits = await repo.searchArea("fountain", 42, 10);
      expect(hits.length).toBe(1);
      expect(hits[0].sourceRef).toBe("event:100");
      expect(hits[0].locationEntityId).toBe(42);
    });
  });

  it("deleteWorldDoc removes document from search results", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql);
      const repo = new PgSearchProjectionRepo(sql);

      await repo.upsertWorldDoc({
        sourceRef: "event:200" as NodeRef,
        content: "Aurora visible over the mansion",
      });

      const before = await repo.searchWorld("aurora", 10);
      expect(before.length).toBe(1);

      await repo.deleteWorldDoc("event:200" as NodeRef);
      const after = await repo.searchWorld("aurora", 10);
      expect(after.length).toBe(0);
    });
  });

  it("rebuildForScope('private', agentId) clears only that agent's docs", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql);
      const repo = new PgSearchProjectionRepo(sql);

      await repo.upsertPrivateDoc({
        sourceRef: "assertion:10" as NodeRef,
        agentId: "agent-a",
        content: "shared keyword for rebuild test",
      });
      await repo.upsertPrivateDoc({
        sourceRef: "assertion:11" as NodeRef,
        agentId: "agent-b",
        content: "shared keyword for rebuild test",
      });

      await repo.rebuildForScope("private", "agent-a");

      const hitsA = await repo.searchPrivate("shared keyword", "agent-a", 10);
      const hitsB = await repo.searchPrivate("shared keyword", "agent-b", 10);
      expect(hitsA.length).toBe(0);
      expect(hitsB.length).toBe(1);
      expect(hitsB[0].sourceRef).toBe("assertion:11");
    });
  });
});
