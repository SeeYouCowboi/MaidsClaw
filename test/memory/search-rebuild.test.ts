import { describe, expect, it } from "bun:test";
import { SqliteJobPersistence } from "../../src/jobs/persistence.js";
import { executeSearchRebuild, type SearchRebuildPayload } from "../../src/memory/search-rebuild-job.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { cleanupDb, createTempDb, seedStandardEntities } from "../helpers/memory-test-utils.js";

const AGENT_ID = "rp:alice";
const SESSION_ID = "test-session-1";

describe("SearchRebuildJob", () => {
  it("recovers search_docs_world after corruption via durable rebuild", () => {
    const { db, dbPath } = createTempDb();

    try {
      const storage = new GraphStorageService(db);
      const { locationId, selfId, userId } = seedStandardEntities(db);

      storage.createProjectedEvent({
        sessionId: SESSION_ID,
        summary: "Alice entered the kitchen",
        timestamp: Date.now(),
        participants: "alice",
        locationEntityId: locationId,
        eventCategory: "action",
        origin: "runtime_projection",
        visibilityScope: "world_public",
      });

      storage.createFact(selfId, userId, "trusts");

      const beforeCount = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM search_docs_world",
      );
      expect(beforeCount!.count).toBeGreaterThan(0);

      const beforeFtsCount = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM search_docs_world_fts",
      );
      expect(beforeFtsCount!.count).toBeGreaterThan(0);

      db.exec("DELETE FROM search_docs_world_fts");
      db.exec("DELETE FROM search_docs_world");

      const corruptedCount = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM search_docs_world",
      );
      expect(corruptedCount!.count).toBe(0);

      const payload: SearchRebuildPayload = { agentId: AGENT_ID, scope: "world" };
      executeSearchRebuild(db, payload);

      const afterMainCount = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM search_docs_world",
      );
      expect(afterMainCount!.count).toBeGreaterThan(0);

      const afterFtsCount = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM search_docs_world_fts",
      );
      expect(afterFtsCount!.count).toBeGreaterThan(0);

      const factDoc = db.get<{ content: string }>(
        "SELECT content FROM search_docs_world WHERE doc_type = 'fact'",
      );
      expect(factDoc).toBeDefined();
      expect(factDoc!.content).toContain("trusts");
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("recovers search_docs_private for a specific agent after corruption", () => {
    const { db, dbPath } = createTempDb();

    try {
      const storage = new GraphStorageService(db);
      seedStandardEntities(db);

      storage.upsertEntity({
        pointerKey: "secret-diary",
        displayName: "Secret Diary",
        entityType: "object",
        memoryScope: "private_overlay",
        ownerAgentId: AGENT_ID,
        summary: "Contains private thoughts about the garden",
      });

      const beforeCount = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM search_docs_private WHERE agent_id = ?",
        [AGENT_ID],
      );

      db.run("DELETE FROM search_docs_private_fts");
      db.run("DELETE FROM search_docs_private WHERE agent_id = ?", [AGENT_ID]);

      executeSearchRebuild(db, { agentId: AGENT_ID, scope: "private" });

      const afterCount = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM search_docs_private WHERE agent_id = ?",
        [AGENT_ID],
      );
      expect(afterCount!.count).toBeGreaterThanOrEqual(beforeCount!.count);

      const doc = db.get<{ content: string }>(
        "SELECT content FROM search_docs_private WHERE agent_id = ? AND doc_type = 'entity'",
        [AGENT_ID],
      );
      expect(doc).toBeDefined();
      expect(doc!.content).toContain("Secret Diary");
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("recovers search_docs_area after corruption", () => {
    const { db, dbPath } = createTempDb();

    try {
      const storage = new GraphStorageService(db);
      const { locationId } = seedStandardEntities(db);

      storage.createProjectedEvent({
        sessionId: SESSION_ID,
        summary: "The clock chimed midnight in the kitchen",
        timestamp: Date.now(),
        participants: "clock",
        locationEntityId: locationId,
        eventCategory: "observation",
        origin: "runtime_projection",
        visibilityScope: "area_visible",
      });

      db.exec("DELETE FROM search_docs_area_fts");
      db.exec("DELETE FROM search_docs_area");

      executeSearchRebuild(db, { agentId: AGENT_ID, scope: "area" });

      const afterCount = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM search_docs_area",
      );
      expect(afterCount!.count).toBeGreaterThan(0);

      const doc = db.get<{ content: string }>(
        "SELECT content FROM search_docs_area WHERE doc_type = 'event'",
      );
      expect(doc).toBeDefined();
      expect(doc!.content).toContain("clock chimed midnight");
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("rebuilds cognition search docs for all agents with _all_agents sentinel", () => {
    const { db, dbPath } = createTempDb();

    try {
      const now = Date.now();
      db.run(
        `INSERT INTO private_cognition_current
         (agent_id, cognition_key, kind, stance, basis, status, summary_text, record_json, source_event_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          AGENT_ID,
          "cog:all-agents:alice",
          "assertion",
          "accepted",
          "first_hand",
          "active",
          "Alice keeps a private silver key",
          JSON.stringify({ provenance: "first hand" }),
          1,
          now,
        ],
      );

      db.exec("DELETE FROM search_docs_cognition_fts");
      db.exec("DELETE FROM search_docs_cognition");

      executeSearchRebuild(db, { agentId: "_all_agents", scope: "cognition" });

      const row = db.get<{ agent_id: string; content: string }>(
        `SELECT agent_id, content
         FROM search_docs_cognition
         WHERE agent_id = ?
         ORDER BY id ASC
         LIMIT 1`,
        [AGENT_ID],
      );
      expect(row?.agent_id).toBe(AGENT_ID);
      expect(row?.content).toContain("silver key");

      const count = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM search_docs_cognition_fts",
      );
      expect(count?.count).toBeGreaterThan(0);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("scope=all rebuilds all four search_docs tables", () => {
    const { db, dbPath } = createTempDb();

    try {
      const storage = new GraphStorageService(db);
      const { locationId } = seedStandardEntities(db);

      storage.createProjectedEvent({
        sessionId: SESSION_ID,
        summary: "All-scope test event",
        timestamp: Date.now(),
        participants: "alice",
        locationEntityId: locationId,
        eventCategory: "action",
        origin: "runtime_projection",
        visibilityScope: "world_public",
      });

      storage.createProjectedEvent({
        sessionId: SESSION_ID,
        summary: "Area-scope test event",
        timestamp: Date.now(),
        participants: "bob",
        locationEntityId: locationId,
        eventCategory: "observation",
        origin: "runtime_projection",
        visibilityScope: "area_visible",
      });

      db.exec("DELETE FROM search_docs_world_fts");
      db.exec("DELETE FROM search_docs_world");
      db.exec("DELETE FROM search_docs_area_fts");
      db.exec("DELETE FROM search_docs_area");
      db.exec("DELETE FROM search_docs_private_fts");
      db.exec("DELETE FROM search_docs_private");
      db.exec("DELETE FROM search_docs_cognition_fts");
      db.exec("DELETE FROM search_docs_cognition");

      executeSearchRebuild(db, { agentId: AGENT_ID, scope: "all" });

      const worldCount = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM search_docs_world",
      );
      expect(worldCount!.count).toBeGreaterThan(0);

      const areaCount = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM search_docs_area",
      );
      expect(areaCount!.count).toBeGreaterThan(0);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("durable persistence: enqueue, claim, execute, complete lifecycle", async () => {
    const { db, dbPath } = createTempDb();

    try {
      const storage = new GraphStorageService(db);
      const { locationId } = seedStandardEntities(db);

      storage.createProjectedEvent({
        sessionId: SESSION_ID,
        summary: "Durable lifecycle test",
        timestamp: Date.now(),
        participants: "alice",
        locationEntityId: locationId,
        eventCategory: "action",
        origin: "runtime_projection",
        visibilityScope: "world_public",
      });

      db.exec("DELETE FROM search_docs_world_fts");
      db.exec("DELETE FROM search_docs_world");

      const persistence = new SqliteJobPersistence(db);
      const payload: SearchRebuildPayload = { agentId: AGENT_ID, scope: "world" };
      const jobId = `search.rebuild:world:${AGENT_ID}:durable-test`;

      await persistence.enqueue({
        id: jobId,
        jobType: "search.rebuild",
        payload,
        status: "pending",
        maxAttempts: 3,
        nextAttemptAt: Date.now(),
      });

      const pending = await persistence.listPending();
      expect(pending.length).toBeGreaterThanOrEqual(1);
      const found = pending.find((j) => j.id === jobId);
      expect(found).toBeDefined();

      const claimed = await persistence.claim(jobId, "worker-1", 30000);
      expect(claimed).toBe(true);

      executeSearchRebuild(db, payload);

      await persistence.complete(jobId);

      const statusRow = db.get<{ status: string }>(
        "SELECT status FROM _memory_maintenance_jobs WHERE idempotency_key = ?",
        [jobId],
      );
      expect(statusRow?.status).toBe("reconciled");

      const worldCount = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM search_docs_world",
      );
      expect(worldCount!.count).toBeGreaterThan(0);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("retry: marks job retryable on transient failure", async () => {
    const { db, dbPath } = createTempDb();

    try {
      const persistence = new SqliteJobPersistence(db);
      const jobId = `search.rebuild:world:${AGENT_ID}:retry-test`;

      await persistence.enqueue({
        id: jobId,
        jobType: "search.rebuild",
        payload: { agentId: AGENT_ID, scope: "world" },
        status: "pending",
        maxAttempts: 3,
        nextAttemptAt: Date.now(),
      });

      await persistence.claim(jobId, "worker-1", 30000);

      await persistence.fail(jobId, "Simulated transient error", true);

      const statusRow = db.get<{ status: string; attempt_count: number }>(
        "SELECT status, attempt_count FROM _memory_maintenance_jobs WHERE idempotency_key = ?",
        [jobId],
      );
      expect(statusRow?.status).toBe("retryable");
      expect(statusRow?.attempt_count).toBe(1);

      const retryable = await persistence.listRetryable(Date.now() + 1000);
      const retryJob = retryable.find((j) => j.id === jobId);
      expect(retryJob).toBeDefined();
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("retry: marks job exhausted after max attempts", async () => {
    const { db, dbPath } = createTempDb();

    try {
      const persistence = new SqliteJobPersistence(db);
      const jobId = `search.rebuild:world:${AGENT_ID}:exhaust-test`;

      await persistence.enqueue({
        id: jobId,
        jobType: "search.rebuild",
        payload: { agentId: AGENT_ID, scope: "world" },
        status: "pending",
        maxAttempts: 2,
        nextAttemptAt: Date.now(),
      });

      await persistence.claim(jobId, "worker-1", 30000);
      await persistence.fail(jobId, "fail 1", true);

      await persistence.claim(jobId, "worker-1", 30000);
      await persistence.fail(jobId, "fail 2", true);

      const statusRow = db.get<{ status: string; attempt_count: number }>(
        "SELECT status, attempt_count FROM _memory_maintenance_jobs WHERE idempotency_key = ?",
        [jobId],
      );
      expect(statusRow?.status).toBe("exhausted");
      expect(statusRow?.attempt_count).toBe(2);
    } finally {
      cleanupDb(db, dbPath);
    }
  });
});
