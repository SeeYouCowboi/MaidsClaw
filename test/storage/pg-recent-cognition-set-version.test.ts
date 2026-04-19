import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { PgRecentCognitionSlotRepo } from "../../src/storage/domain-repos/pg/recent-cognition-slot-repo.js";
import {
  createPgTestDb,
  type PgTestDb,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("pg recent cognition slot setThinkerVersion", () => {
  let testDb: PgTestDb | null = null;
  let sql: postgres.Sql;
  let repo: PgRecentCognitionSlotRepo;

  function wrapSqlWithParsedSlotPayload(base: postgres.Sql): postgres.Sql {
    return (async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<unknown[]> => {
      const rows = await (base as unknown as (
        q: TemplateStringsArray,
        ...params: unknown[]
      ) => Promise<unknown[]>)(strings, ...values);
      if (!Array.isArray(rows)) {
        return rows;
      }
      return rows.map((row) => {
        if (!row || typeof row !== "object") {
          return row;
        }
        const typed = row as { slot_payload?: unknown };
        if (typeof typed.slot_payload === "string") {
          try {
            return {
              ...typed,
              slot_payload: JSON.parse(typed.slot_payload),
            };
          } catch {
            return row;
          }
        }
        return row;
      });
    }) as unknown as postgres.Sql;
  }

  const sessionId = "session:set-version";
  const agentId = "rp:alice";

  beforeAll(async () => {
    testDb = await createPgTestDb();
    sql = testDb.pool;
    // Keep test behavior deterministic across environments where json/jsonb may
    // come back as text unless explicit parsers are configured.
    repo = new PgRecentCognitionSlotRepo(wrapSqlWithParsedSlotPayload(sql));
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE recent_cognition_slots`;
  });

  afterAll(async () => {
    if (testDb !== null) {
      await testDb.cleanup();
    }
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

  it("setThinkerVersion path preserves basis/provenance/sourceTurnVersion in merged slot payload", async () => {
    const firstBatch = JSON.stringify([
      {
        settlementId: "stl:v4",
        committedAt: 1000,
        kind: "assertion",
        key: "belief:trust",
        summary: "initial",
        status: "active",
        basis: "inference",
        provenance: "thinker_inferred",
        sourceTurnVersion: 4,
      },
    ]);
    const secondBatch = JSON.stringify([
      {
        settlementId: "stl:v6",
        committedAt: 900,
        kind: "assertion",
        key: "belief:trust",
        summary: "corrected",
        status: "active",
        basis: "first_hand",
        provenance: "user_stated",
        sourceTurnVersion: 6,
      },
    ]);

    await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:v4",
      firstBatch,
      undefined,
      4,
    );

    await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:v6",
      secondBatch,
      undefined,
      6,
    );

    const payload = await repo.getSlotPayload(sessionId, agentId);
    const entries = JSON.parse(String(payload)) as Array<{
      key?: string;
      summary?: string;
      basis?: string;
      provenance?: string;
      sourceTurnVersion?: number;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("belief:trust");
    expect(entries[0].summary).toBe("corrected");
    expect(entries[0].basis).toBe("first_hand");
    expect(entries[0].provenance).toBe("user_stated");
    expect(entries[0].sourceTurnVersion).toBe(6);
  });

  it("v1 correction continuity: setThinkerVersion merge replaces hallucinated v10 summary with user-stated v11 on canonical key", async () => {
    const key = "belief:user-location:canonical";
    await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:v10",
      JSON.stringify([
        {
          settlementId: "stl:v10",
          committedAt: 1000,
          kind: "assertion",
          key,
          summary: "hallucinated weak-basis location",
          status: "active",
          basis: "belief",
          provenance: "talker_sketch_auto",
          sourceTurnVersion: 10,
        },
      ]),
      undefined,
      10,
    );

    await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:v11",
      JSON.stringify([
        {
          settlementId: "stl:v11",
          committedAt: 1100,
          kind: "assertion",
          key,
          summary: "corrected user-stated location",
          status: "active",
          basis: "inference",
          provenance: "user_stated",
          sourceTurnVersion: 11,
        },
      ]),
      undefined,
      11,
    );

    const payload = await repo.getSlotPayload(sessionId, agentId);
    const entries = JSON.parse(String(payload)) as Array<{
      key?: string;
      summary?: string;
      provenance?: string;
      sourceTurnVersion?: number;
    }>;

    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe(key);
    expect(entries[0].summary).toBe("corrected user-stated location");
    expect(entries[0].provenance).toBe("user_stated");
    expect(entries[0].sourceTurnVersion).toBe(11);
  });

  it("v1 correction continuity: higher sourceTurnVersion correction remains winner when lower version commits late", async () => {
    const key = "belief:user-location:canonical";
    await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:v11",
      JSON.stringify([
        {
          settlementId: "stl:v11",
          committedAt: 1100,
          kind: "assertion",
          key,
          summary: "corrected user-stated location",
          status: "active",
          basis: "inference",
          provenance: "user_stated",
          sourceTurnVersion: 11,
        },
      ]),
      undefined,
      11,
    );

    await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:v10",
      JSON.stringify([
        {
          settlementId: "stl:v10",
          committedAt: 9999,
          kind: "assertion",
          key,
          summary: "late stale hallucinated summary",
          status: "active",
          basis: "belief",
          provenance: "talker_sketch_auto",
          sourceTurnVersion: 10,
        },
      ]),
      undefined,
      10,
    );

    const payload = await repo.getSlotPayload(sessionId, agentId);
    const entries = JSON.parse(String(payload)) as Array<{
      key?: string;
      summary?: string;
      provenance?: string;
      sourceTurnVersion?: number;
    }>;

    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe(key);
    expect(entries[0].summary).toBe("corrected user-stated location");
    expect(entries[0].provenance).toBe("user_stated");
    expect(entries[0].sourceTurnVersion).toBe(11);
  });

  it("lower-version late append does not regress thinkerCommittedVersion under setThinkerVersion", async () => {
    await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:v8",
      JSON.stringify([
        {
          settlementId: "stl:v8",
          committedAt: 1000,
          kind: "assertion",
          key: "belief:version-first",
          summary: "v8 winner",
          status: "active",
          sourceTurnVersion: 8,
        },
      ]),
      undefined,
      8,
    );

    await repo.upsertRecentCognitionSlot(
      sessionId,
      agentId,
      "stl:v3",
      JSON.stringify([
        {
          settlementId: "stl:v3",
          committedAt: 9000,
          kind: "assertion",
          key: "belief:version-first",
          summary: "v3 late",
          status: "active",
          sourceTurnVersion: 3,
        },
      ]),
      undefined,
      3,
    );

    const payload = await repo.getSlotPayload(sessionId, agentId);
    const entries = JSON.parse(String(payload)) as Array<{ summary?: string; sourceTurnVersion?: number }>;
    expect(entries).toHaveLength(1);
    expect(typeof entries[0].summary).toBe("string");
    expect(typeof entries[0].sourceTurnVersion).toBe("number");
    expect(await thinkerVersion()).toBe(8);
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
