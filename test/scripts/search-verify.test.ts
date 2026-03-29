import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  cleanupDb,
  createTempDb,
  seedStandardEntities,
  type Db,
} from "../helpers/memory-test-utils.js";
import { executeSearchRebuild } from "../../src/memory/search-rebuild-job.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { verifySearchSurface } from "../../scripts/memory-verify.js";

const AGENT_ID = "rp:alice";
const SESSION_ID = "search-verify-session";

describe("search surface verification", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    const tmp = createTempDb();
    db = tmp.db;
    dbPath = tmp.dbPath;
  });

  afterEach(() => {
    cleanupDb(db, dbPath);
  });

  it("returns PASS when search docs and FTS sidecars match shared authority builders", () => {
    seedSearchAuthority(db);

    const result = verifySearchSurface(db);

    expect(result.pass).toBe(true);
    expect(result.mismatches).toHaveLength(0);
    expect(result.summary).toContain("FTS sidecars match canonical sources");
  });

  it("returns FAIL when search doc content drifts while row counts remain unchanged", () => {
    const seeded = seedSearchAuthority(db);

    db.run(
      `UPDATE search_docs_cognition SET content = ? WHERE agent_id = ? AND source_ref = ?`,
      ["CORRUPTED COGNITION CONTENT", AGENT_ID, `assertion:${seeded.cognitionId}`],
    );
    db.run(
      `UPDATE search_docs_private SET content = ? WHERE agent_id = ? AND source_ref = ?`,
      ["CORRUPTED PRIVATE CONTENT", AGENT_ID, `assertion:${seeded.cognitionId}`],
    );

    const result = verifySearchSurface(db);

    expect(result.pass).toBe(false);
    expect(result.mismatches.some((m) => m.kind === "value_mismatch")).toBe(true);
    expect(
      result.mismatches.some(
        (m) =>
          m.key ===
          `search_docs_cognition:${AGENT_ID}|assertion:${seeded.cognitionId}`,
      ),
    ).toBe(true);
    expect(
      result.mismatches.some(
        (m) =>
          m.key ===
          `search_docs_private:${AGENT_ID}|assertion:${seeded.cognitionId}`,
      ),
    ).toBe(true);
  });

  it("returns FAIL when FTS sidecar row coverage drifts from the main table", () => {
    seedSearchAuthority(db);

    const privateDocId = db.get<{ id: number }>(
      `SELECT id FROM search_docs_private WHERE agent_id = ? ORDER BY id ASC LIMIT 1`,
      [AGENT_ID],
    );
    expect(privateDocId?.id).toBeDefined();

    db.run(`DELETE FROM search_docs_private_fts WHERE rowid = ?`, [
      privateDocId!.id,
    ]);

    const result = verifySearchSurface(db);

    expect(result.pass).toBe(false);
    expect(
      result.mismatches.some(
        (m) =>
          m.key === `search_docs_private_fts:rowid:${privateDocId!.id}` &&
          m.kind === "missing_from_current",
      ),
    ).toBe(true);
  });
});

function seedSearchAuthority(db: Db): { cognitionId: number } {
  const storage = new GraphStorageService(db);
  const { locationId, selfId, userId } = seedStandardEntities(db);

  storage.createProjectedEvent({
    sessionId: SESSION_ID,
    summary: "Alice entered the atrium",
    timestamp: Date.now(),
    participants: "alice",
    locationEntityId: locationId,
    eventCategory: "action",
    origin: "runtime_projection",
    visibilityScope: "area_visible",
  });

  storage.createProjectedEvent({
    sessionId: SESSION_ID,
    summary: "The manor bell rang at dusk",
    timestamp: Date.now(),
    participants: "manor bell",
    locationEntityId: locationId,
    eventCategory: "observation",
    origin: "runtime_projection",
    visibilityScope: "world_public",
  });

  storage.upsertEntity({
    pointerKey: "secret-diary",
    displayName: "Secret Diary",
    entityType: "object",
    memoryScope: "private_overlay",
    ownerAgentId: AGENT_ID,
    summary: "Contains private thoughts about the manor",
  });

  storage.createFact(selfId, userId, "trusts");

  const now = Date.now();
  db.run(
    `INSERT INTO private_cognition_current
     (agent_id, cognition_key, kind, stance, basis, status, summary_text, record_json, source_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      AGENT_ID,
      "cog:search-verify:1",
      "assertion",
      "accepted",
      "first_hand",
      "active",
      "Alice keeps a silver key",
      JSON.stringify({ provenance: "journal note" }),
      1,
      now,
    ],
  );

  const cognitionRow = db.get<{ id: number }>(
    `SELECT id FROM private_cognition_current WHERE agent_id = ? AND cognition_key = ?`,
    [AGENT_ID, "cog:search-verify:1"],
  );
  if (!cognitionRow) {
    throw new Error("failed to seed cognition row");
  }

  executeSearchRebuild(db, { agentId: AGENT_ID, scope: "all" });
  return { cognitionId: cognitionRow.id };
}
