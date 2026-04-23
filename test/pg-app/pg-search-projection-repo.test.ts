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

  it("updateCognitionSearchDocStanceBySourceRef updates only stance column", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql);
      const repo = new PgSearchProjectionRepo(sql);

      const docId = await repo.upsertCognitionDoc({
        sourceRef: "assertion:50" as NodeRef,
        agentId: "agent-x",
        kind: "assertion",
        basis: "first_hand",
        stance: "tentative",
        content: "The sky is blue according to observations",
      });
      expect(docId).toBeGreaterThan(0);

      const now = Date.now();
      await repo.updateCognitionSearchDocStanceBySourceRef(
        "assertion:50" as NodeRef,
        "agent-x",
        "confirmed",
        now,
      );

      // Verify stance changed, other fields preserved
      const hits = await repo.searchCognition("sky blue observations", "agent-x", 10);
      expect(hits.length).toBe(1);
      expect(hits[0].stance).toBe("confirmed");
      expect(hits[0].basis).toBe("first_hand");
      expect(hits[0].kind).toBe("assertion");
      expect(hits[0].content).toContain("The sky is blue");
    });
  });

  it("updateCognitionSearchDocStanceBySourceRef does not affect other agents", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql);
      const repo = new PgSearchProjectionRepo(sql);

      await repo.upsertCognitionDoc({
        sourceRef: "assertion:60" as NodeRef,
        agentId: "agent-a",
        kind: "assertion",
        stance: "tentative",
        content: "Stance update isolation test document",
      });
      await repo.upsertCognitionDoc({
        sourceRef: "assertion:60" as NodeRef,
        agentId: "agent-b",
        kind: "assertion",
        stance: "tentative",
        content: "Stance update isolation test document",
      });

      await repo.updateCognitionSearchDocStanceBySourceRef(
        "assertion:60" as NodeRef,
        "agent-a",
        "rejected",
        Date.now(),
      );

      const hitsA = await repo.searchCognition("Stance update isolation", "agent-a", 10);
      const hitsB = await repo.searchCognition("Stance update isolation", "agent-b", 10);
      expect(hitsA[0].stance).toBe("rejected");
      expect(hitsB[0].stance).toBe("tentative");
    });
  });

  it("upsert populates BM25 helper columns (content_search_text, content_ngram_text, alias_text)", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapDerivedSchema(sql);
      const repo = new PgSearchProjectionRepo(sql);

      await repo.upsertAreaDoc({
        sourceRef: "event:500" as NodeRef,
        locationEntityId: 7,
        content: "Lanterns lit in the courtyard",
        aliasText: "Courtyard 中庭",
      });
      await repo.upsertWorldDoc({
        sourceRef: "event:501" as NodeRef,
        content: "Public proclamation by the council",
        aliasText: "Council 议会",
      });
      await repo.upsertEpisodeDoc({
        sourceRef: "episode:1",
        agentId: "agent-a",
        category: "observation",
        content: "Met the librarian",
        committedAt: Date.now(),
        entityPointerKeys: ["entity:librarian", "entity:study"],
      });
      await repo.upsertCognitionDoc({
        sourceRef: "assertion:99" as NodeRef,
        agentId: "agent-a",
        kind: "assertion",
        content: "Hypothesis about the missing pendant",
        aliasText: "pendant 怀表",
      });

      const areaRow = await sql<{
        content_search_text: string;
        content_ngram_text: string;
        alias_text: string;
      }[]>`
        SELECT content_search_text, content_ngram_text, alias_text
        FROM search_docs_area WHERE source_ref = 'event:500'
      `;
      expect(areaRow[0].alias_text).toBe("Courtyard 中庭");
      expect(areaRow[0].content_search_text).toContain("Lanterns");
      expect(areaRow[0].content_search_text).toContain("Courtyard 中庭");
      expect(areaRow[0].content_ngram_text).toBe(areaRow[0].content_search_text);

      const worldRow = await sql<{
        content_search_text: string;
        alias_text: string;
      }[]>`
        SELECT content_search_text, alias_text
        FROM search_docs_world WHERE source_ref = 'event:501'
      `;
      expect(worldRow[0].alias_text).toBe("Council 议会");
      expect(worldRow[0].content_search_text).toContain("proclamation");

      const episodeRow = await sql<{
        content_search_text: string;
        alias_text: string;
      }[]>`
        SELECT content_search_text, alias_text
        FROM search_docs_episode WHERE source_ref = 'episode:1' AND agent_id = 'agent-a'
      `;
      expect(episodeRow[0].alias_text).toContain("entity:librarian");
      expect(episodeRow[0].content_search_text).toContain("librarian");

      const cognitionRow = await sql<{
        content_search_text: string;
        alias_text: string;
      }[]>`
        SELECT content_search_text, alias_text
        FROM search_docs_cognition WHERE source_ref = 'assertion:99' AND agent_id = 'agent-a'
      `;
      expect(cognitionRow[0].alias_text).toBe("pendant 怀表");
      expect(cognitionRow[0].content_search_text).toContain("pendant 怀表");
    });
  });
});
