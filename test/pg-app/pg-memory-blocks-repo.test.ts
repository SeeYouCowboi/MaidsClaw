import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  ensureTestPgAppDb,
  createTestPgAppPool,
  withTestAppSchema,
  teardownAppPool,
} from "../helpers/pg-app-test-utils.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import { PgCoreMemoryBlockRepo } from "../../src/storage/domain-repos/pg/core-memory-block-repo.js";
import { PgSharedBlockRepo } from "../../src/storage/domain-repos/pg/shared-block-repo.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("PgCoreMemoryBlockRepo", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("initializeBlocks creates all default blocks", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCoreMemoryBlockRepo(sql);

      await repo.initializeBlocks("agent-1");
      const blocks = await repo.getAllBlocks("agent-1");

      expect(blocks.length).toBe(5);
      const labels = blocks.map((b) => b.label).sort();
      expect(labels).toEqual(["index", "persona", "pinned_index", "pinned_summary", "user"]);

      for (const block of blocks) {
        expect(block.value).toBe("");
        expect(block.chars_current).toBe(0);
        expect(block.char_limit).toBeGreaterThan(0);
      }
    });
  });

  it("initializeBlocks is idempotent (ON CONFLICT DO NOTHING)", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCoreMemoryBlockRepo(sql);

      await repo.initializeBlocks("agent-1");
      await repo.initializeBlocks("agent-1");
      const blocks = await repo.getAllBlocks("agent-1");
      expect(blocks.length).toBe(5);
    });
  });

  it("getBlock returns block with chars_current and chars_limit", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCoreMemoryBlockRepo(sql);

      await repo.initializeBlocks("agent-1");
      const block = await repo.getBlock("agent-1", "pinned_summary");

      expect(block.agent_id).toBe("agent-1");
      expect(block.label).toBe("pinned_summary");
      expect(block.chars_current).toBe(0);
      expect(block.chars_limit).toBe(4000);
      expect(block.char_limit).toBe(4000);
      expect(block.read_only).toBe(0);
    });
  });

  it("getBlock throws for missing block", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCoreMemoryBlockRepo(sql);

      let caught = false;
      try {
        await repo.getBlock("no-agent", "user");
      } catch (e: any) {
        caught = true;
        expect(e.message).toContain("Block not found");
      }
      expect(caught).toBe(true);
    });
  });

  it("appendBlock appends content and returns updated size", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCoreMemoryBlockRepo(sql);

      await repo.initializeBlocks("agent-1");
      const result = await repo.appendBlock("agent-1", "pinned_summary", "Hello world");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.chars_current).toBe(11);
      }

      const block = await repo.getBlock("agent-1", "pinned_summary");
      expect(block.value).toBe("Hello world");
    });
  });

  it("appendBlock rejects when exceeding char_limit", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCoreMemoryBlockRepo(sql);

      await repo.initializeBlocks("agent-1");
      const bigContent = "x".repeat(5000);
      const result = await repo.appendBlock("agent-1", "pinned_summary", bigContent);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.limit).toBe(4000);
      }
    });
  });

  it("appendBlock rejects read-only blocks for non-task-agent", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCoreMemoryBlockRepo(sql);

      await repo.initializeBlocks("agent-1");
      const result = await repo.appendBlock("agent-1", "index", "some text");

      expect(result.success).toBe(false);
    });
  });

  it("replaceBlock replaces first occurrence", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCoreMemoryBlockRepo(sql);

      await repo.initializeBlocks("agent-1");
      await repo.appendBlock("agent-1", "pinned_summary", "Hello world");
      const result = await repo.replaceBlock("agent-1", "pinned_summary", "world", "universe");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.chars_current).toBe(14);
      }

      const block = await repo.getBlock("agent-1", "pinned_summary");
      expect(block.value).toBe("Hello universe");
    });
  });

  it("replaceBlock fails when oldText not found", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCoreMemoryBlockRepo(sql);

      await repo.initializeBlocks("agent-1");
      const result = await repo.replaceBlock("agent-1", "pinned_summary", "nonexistent", "new");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toContain("not found");
      }
    });
  });

  it("upsert by agent+label preserves existing value on re-init", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgCoreMemoryBlockRepo(sql);

      await repo.initializeBlocks("agent-1");
      await repo.appendBlock("agent-1", "pinned_summary", "existing data");

      await repo.initializeBlocks("agent-1");
      const block = await repo.getBlock("agent-1", "pinned_summary");
      expect(block.value).toBe("existing data");
    });
  });
});

describe.skipIf(skipPgTests)("PgSharedBlockRepo", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("createBlock returns new block with initial snapshot", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSharedBlockRepo(sql);

      const block = await repo.createBlock("Test Block", "agent-1");
      expect(block.id).toBeGreaterThan(0);
      expect(block.title).toBe("Test Block");
      expect(block.createdByAgentId).toBe("agent-1");
      expect(block.retrievalOnly).toBe(false);

      const fetched = await repo.getBlock(block.id);
      expect(fetched).toBeDefined();
      expect(fetched!.title).toBe("Test Block");
    });
  });

  it("createBlock with retrievalOnly option", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSharedBlockRepo(sql);

      const block = await repo.createBlock("RO Block", "agent-1", { retrievalOnly: true });
      expect(block.retrievalOnly).toBe(true);

      const fetched = await repo.getBlock(block.id);
      expect(fetched!.retrievalOnly).toBe(true);
    });
  });

  it("upsertSection creates and updates sections", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSharedBlockRepo(sql);

      const block = await repo.createBlock("Block", "agent-1");

      await repo.upsertSection(block.id, "/intro", "Introduction content", "Intro");
      let section = await repo.getSection(block.id, "/intro");
      expect(section).toBeDefined();
      expect(section!.content).toBe("Introduction content");
      expect(section!.title).toBe("Intro");

      await repo.upsertSection(block.id, "/intro", "Updated content", "Intro v2");
      section = await repo.getSection(block.id, "/intro");
      expect(section!.content).toBe("Updated content");
      expect(section!.title).toBe("Intro v2");
    });
  });

  it("getSections returns all sections ordered by path", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSharedBlockRepo(sql);

      const block = await repo.createBlock("Block", "agent-1");
      await repo.upsertSection(block.id, "/z-last", "Z content");
      await repo.upsertSection(block.id, "/a-first", "A content");

      const sections = await repo.getSections(block.id);
      expect(sections.length).toBe(2);
      expect(sections[0].sectionPath).toBe("/a-first");
      expect(sections[1].sectionPath).toBe("/z-last");
    });
  });

  it("deleteSection removes section and returns true", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSharedBlockRepo(sql);

      const block = await repo.createBlock("Block", "agent-1");
      await repo.upsertSection(block.id, "/temp", "Temp content");

      const deleted = await repo.deleteSection(block.id, "/temp");
      expect(deleted).toBe(true);

      const exists = await repo.sectionExists(block.id, "/temp");
      expect(exists).toBe(false);
    });
  });

  it("deleteSection returns false for nonexistent section", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSharedBlockRepo(sql);

      const block = await repo.createBlock("Block", "agent-1");
      const deleted = await repo.deleteSection(block.id, "/nope");
      expect(deleted).toBe(false);
    });
  });

  it("renameSection updates section_path", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSharedBlockRepo(sql);

      const block = await repo.createBlock("Block", "agent-1");
      await repo.upsertSection(block.id, "/old-name", "Content");

      const renamed = await repo.renameSection(block.id, "/old-name", "/new-name");
      expect(renamed).toBe(true);

      expect(await repo.sectionExists(block.id, "/old-name")).toBe(false);
      expect(await repo.sectionExists(block.id, "/new-name")).toBe(true);

      const section = await repo.getSection(block.id, "/new-name");
      expect(section!.content).toBe("Content");
    });
  });

  it("setTitle updates block title", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSharedBlockRepo(sql);

      const block = await repo.createBlock("Original", "agent-1");
      await repo.setTitle(block.id, "Renamed");

      const fetched = await repo.getBlock(block.id);
      expect(fetched!.title).toBe("Renamed");
    });
  });

  it("sectionExists returns correct boolean", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSharedBlockRepo(sql);

      const block = await repo.createBlock("Block", "agent-1");
      expect(await repo.sectionExists(block.id, "/nope")).toBe(false);

      await repo.upsertSection(block.id, "/exists", "Content");
      expect(await repo.sectionExists(block.id, "/exists")).toBe(true);
    });
  });

  it("buildSnapshotJson returns JSON of all sections", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSharedBlockRepo(sql);

      const block = await repo.createBlock("Block", "agent-1");
      await repo.upsertSection(block.id, "/a", "Alpha");
      await repo.upsertSection(block.id, "/b", "Beta");

      const json = await repo.buildSnapshotJson(block.id);
      const parsed = JSON.parse(json);
      expect(parsed).toEqual({ "/a": "Alpha", "/b": "Beta" });
    });
  });

  it("writeSnapshot persists snapshot to shared_block_snapshots", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSharedBlockRepo(sql);

      const block = await repo.createBlock("Block", "agent-1");
      await repo.upsertSection(block.id, "/a", "Alpha");

      await repo.writeSnapshot(block.id, 1);

      const rows = await sql`
        SELECT snapshot_seq, content_json
        FROM shared_block_snapshots
        WHERE block_id = ${block.id}
        ORDER BY snapshot_seq
      `;
      expect(rows.length).toBe(2);
      expect(Number(rows[0].snapshot_seq)).toBe(0);
      expect(Number(rows[1].snapshot_seq)).toBe(1);

      const snap1Content = typeof rows[1].content_json === "string"
        ? JSON.parse(rows[1].content_json)
        : rows[1].content_json;
      expect(snap1Content).toEqual({ "/a": "Alpha" });
    });
  });

  it("CASCADE FK: deleting shared_block removes child sections", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSharedBlockRepo(sql);

      const block = await repo.createBlock("Cascade Test", "agent-1");
      await repo.upsertSection(block.id, "/s1", "Content 1");
      await repo.upsertSection(block.id, "/s2", "Content 2");

      const sectionsBefore = await repo.getSections(block.id);
      expect(sectionsBefore.length).toBe(2);

      await sql`DELETE FROM shared_blocks WHERE id = ${block.id}`;

      const sectionsAfter = await sql`
        SELECT id FROM shared_block_sections WHERE block_id = ${block.id}
      `;
      expect(sectionsAfter.length).toBe(0);

      const snapshotsAfter = await sql`
        SELECT id FROM shared_block_snapshots WHERE block_id = ${block.id}
      `;
      expect(snapshotsAfter.length).toBe(0);
    });
  });

  it("getBlock returns undefined for missing block", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapTruthSchema(sql);
      const repo = new PgSharedBlockRepo(sql);

      const block = await repo.getBlock(999999);
      expect(block).toBeUndefined();
    });
  });
});
