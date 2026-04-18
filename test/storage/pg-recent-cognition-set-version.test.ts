import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { PgRecentCognitionSlotRepo } from "../../src/storage/domain-repos/pg/recent-cognition-slot-repo.js";
import {
  createPgTestDb,
  type PgTestDb,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("pg recent cognition slot setThinkerVersion", () => {
  let testDb: PgTestDb;
  let sql: postgres.Sql;
  let repo: PgRecentCognitionSlotRepo;

  const sessionId = "session:set-version";
  const agentId = "rp:alice";

  beforeAll(async () => {
    testDb = await createPgTestDb();
    sql = testDb.pool;
    repo = new PgRecentCognitionSlotRepo(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE recent_cognition_slots`;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  async function thinkerVersion(): Promise<number | undefined> {
    const slot = await repo.getBySession(sessionId, agentId);
    return slot?.thinkerCommittedVersion;
  }

  it("sets thinkerCommittedVersion to explicit value 5", async () => {
    const result = await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:set-v5",
      "[]",
      undefined,
      5,
    );

    expect(result.thinkerCommittedVersion).toBe(5);
    expect(await thinkerVersion()).toBe(5);
  });

  it("keeps max version when explicit set is lower (GREATEST monotonic)", async () => {
    await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:set-v5",
      "[]",
      undefined,
      5,
    );

    const result = await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:set-v3",
      "[]",
      undefined,
      3,
    );

    expect(result.thinkerCommittedVersion).toBe(5);
    expect(await thinkerVersion()).toBe(5);
  });

  it("advances to higher explicit version after lower attempt", async () => {
    await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:set-v5",
      "[]",
      undefined,
      5,
    );
    await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:set-v3",
      "[]",
      undefined,
      3,
    );

    const result = await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:set-v7",
      "[]",
      undefined,
      7,
    );

    expect(result.thinkerCommittedVersion).toBe(7);
    expect(await thinkerVersion()).toBe(7);
  });

  it("throws when versionIncrement and setThinkerVersion are both provided", async () => {
    await expect(
      repo.upsertRecentCognitionSlot(
        sessionId,
        agentId,
        "stl:conflict",
        "[]",
        "thinker",
        5,
      ),
    ).rejects.toThrow(
      "Cannot provide both versionIncrement and setThinkerVersion simultaneously",
    );
  });

  it("preserves backward compatibility for versionIncrement='thinker'", async () => {
    const first = await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:thinker-1",
      "[]",
      "thinker",
    );
    const second = await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:thinker-2",
      "[]",
      "thinker",
    );

    expect(first.thinkerCommittedVersion).toBe(1);
    expect(second.thinkerCommittedVersion).toBe(2);
    expect(await thinkerVersion()).toBe(2);
  });
});

import { compactSlotEntries } from "../../src/storage/domain-repos/pg/recent-cognition-slot-repo.js";

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    settlementId: "stl:1",
    committedAt: 1000,
    kind: "assertion",
    key: "test/key",
    summary: "test summary",
    status: "active",
    ...overrides,
  };
}

describe("compactSlotEntries (unit)", () => {
  it("preserves enriched JSON fields (basis/provenance/sourceTurnVersion) through compaction", () => {
    const entries = [
      makeEntry({ basis: "first_hand", provenance: "user_stated", sourceTurnVersion: 3 }),
      makeEntry({ key: "other/key", basis: "inference", provenance: "thinker_inferred", sourceTurnVersion: 3 }),
    ];
    const result = compactSlotEntries(entries) as typeof entries;
    expect(result).toHaveLength(2);
    expect(result[0].basis).toBe("first_hand");
    expect(result[0].provenance).toBe("user_stated");
    expect(result[0].sourceTurnVersion).toBe(3);
    expect(result[1].basis).toBe("inference");
    expect(result[1].provenance).toBe("thinker_inferred");
  });

  it("retracted tombstones do not consume the active budget (65 active + 5 retracted)", () => {
    const active: unknown[] = [];
    for (let i = 0; i < 65; i++) {
      active.push(makeEntry({ key: `key/${i}`, committedAt: 1000 + i }));
    }
    const retracted: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      retracted.push(makeEntry({ key: `retracted/${i}`, status: "retracted", summary: "(retracted)" }));
    }
    const all = [...retracted, ...active];
    const result = compactSlotEntries(all) as Array<{ status: string; key: string }>;

    const activeResult = result.filter((e) => e.status !== "retracted");
    const retractedResult = result.filter((e) => e.status === "retracted");
    expect(activeResult).toHaveLength(64);
    expect(retractedResult).toHaveLength(5);
    expect(activeResult[0].key).toBe("key/1");
  });

  it("higher sourceTurnVersion wins over lower even when lower arrives later", () => {
    const v2Entry = makeEntry({ sourceTurnVersion: 2, committedAt: 1000, summary: "v2 wins" });
    const v1Entry = makeEntry({ sourceTurnVersion: 1, committedAt: 2000, summary: "v1 late" });
    const result = compactSlotEntries([v2Entry, v1Entry]) as Array<{ summary: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe("v2 wins");
  });

  it("falls back to committedAt when sourceTurnVersion is missing", () => {
    const older = makeEntry({ committedAt: 1000, summary: "older" });
    const newer = makeEntry({ committedAt: 2000, summary: "newer" });
    const result = compactSlotEntries([older, newer]) as Array<{ summary: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe("newer");
  });

  it("entries with explicit sourceTurnVersion beat legacy entries without version", () => {
    const legacy = makeEntry({ committedAt: 5000, summary: "legacy no version" });
    const versioned = makeEntry({ sourceTurnVersion: 1, committedAt: 1000, summary: "versioned" });
    const result = compactSlotEntries([legacy, versioned]) as Array<{ summary: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe("versioned");
  });

  it("same-key retracted entry does not evict active entry", () => {
    const active = makeEntry({ sourceTurnVersion: 2, summary: "active entry" });
    const retracted = makeEntry({ sourceTurnVersion: 3, status: "retracted", summary: "(retracted)" });
    const result = compactSlotEntries([active, retracted]) as Array<{ summary: string; status: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("retracted");
    expect(result[0].summary).toBe("(retracted)");
  });
});
