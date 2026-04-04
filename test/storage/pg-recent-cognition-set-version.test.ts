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
