import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializePublications } from "./materialization.js";
import { AreaWorldProjectionRepo } from "./projection/area-world-projection-repo.js";
import { PublicationRecoverySweeper } from "./publication-recovery-sweeper.js";
import { runMemoryMigrations } from "./schema.js";
import { GraphStorageService } from "./storage.js";
import { openDatabase } from "../storage/database.js";

function createTempDb() {
  const dbPath = join(tmpdir(), `maidsclaw-pub-recovery-${randomUUID()}.db`);
  const db = openDatabase({ path: dbPath });
  return { dbPath, db };
}

function cleanupDb(dbPath: string): void {
  try {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  } catch {}
}

function insertRecoveryJob(params: {
  db: ReturnType<typeof openDatabase>;
  status?: "pending" | "retrying" | "reconciled" | "exhausted";
  settlementId: string;
  pubIndex: number;
  targetScope?: "current_area" | "world_public";
  visibilityScope?: "area_visible" | "world_public";
  sessionId?: string;
  sourceAgentId?: string | null;
  kind?: string;
  summary?: string;
  timestamp?: number;
  locationEntityId?: number;
  eventCategory?: "speech" | "action" | "observation" | "state_change";
  participants?: string;
  failureCount?: number;
  lastAttemptAt?: number;
  nextAttemptAt?: number | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  updatedAt?: number;
}): void {
  const now = Date.now();
  const payload = {
    settlementId: params.settlementId,
    pubIndex: params.pubIndex,
    targetScope: params.targetScope ?? "current_area",
    visibilityScope: params.visibilityScope ?? "area_visible",
    sessionId: params.sessionId ?? "sess:recovery",
    sourceAgentId: params.sourceAgentId ?? null,
    kind: params.kind ?? "spoken",
    summary: params.summary ?? "Recovered publication",
    timestamp: params.timestamp ?? now,
    participants: params.participants ?? "[]",
    locationEntityId: params.locationEntityId ?? 1,
    eventCategory: params.eventCategory ?? "speech",
    failureCount: params.failureCount ?? 0,
    lastAttemptAt: params.lastAttemptAt ?? now,
    nextAttemptAt: params.nextAttemptAt ?? now,
    lastErrorCode: params.lastErrorCode ?? null,
    lastErrorMessage: params.lastErrorMessage ?? null,
  };

  params.db.run(
    `INSERT INTO _memory_maintenance_jobs
     (job_type, status, idempotency_key, payload, created_at, updated_at, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      "publication_recovery",
      params.status ?? "pending",
      `publication_recovery:${params.settlementId}:${params.pubIndex}`,
      JSON.stringify(payload),
      now,
      params.updatedAt ?? now,
      params.nextAttemptAt ?? now,
    ],
  );
}

describe("PublicationRecoverySweeper", () => {
  it("orphaned publication recovery recreates projections and marks job reconciled", async () => {
    const { dbPath, db } = createTempDb();
    runMemoryMigrations(db);

    const storage = new GraphStorageService(db);
    const projectionRepo = new AreaWorldProjectionRepo(db.raw);
    const locationId = storage.upsertEntity({
      pointerKey: "recovery-hall",
      displayName: "Recovery Hall",
      entityType: "location",
      memoryScope: "shared_public",
    });

    const settlementId = `stl:orphan-${randomUUID()}`;
    insertRecoveryJob({
      db,
      settlementId,
      pubIndex: 0,
      sessionId: "sess:orphan",
      summary: "Recovered by sweeper.",
      locationEntityId: locationId,
      participants: JSON.stringify([`entity:${locationId}`]),
      sourceAgentId: "rp:alice",
      timestamp: 12_345,
      nextAttemptAt: 0,
    });

    const sweeper = new PublicationRecoverySweeper(db, storage, {
      now: () => 1,
      projectionRepo,
    });

    try {
      await sweeper.sweep();

      const event = db.get<{
        source_settlement_id: string;
        source_pub_index: number;
        visibility_scope: string;
        summary: string;
      }>(
        "SELECT source_settlement_id, source_pub_index, visibility_scope, summary FROM event_nodes WHERE source_settlement_id = ? AND source_pub_index = ?",
        [settlementId, 0],
      );
      expect(event).toBeDefined();
      expect(event!.visibility_scope).toBe("area_visible");
      expect(event!.summary).toBe("Recovered by sweeper.");

      const areaState = projectionRepo.getAreaStateCurrent(
        "rp:alice",
        locationId,
        `publication:${settlementId}:0`,
      );
      expect(areaState).not.toBeNull();

      const areaNarrative = projectionRepo.getAreaNarrativeCurrent(
        "rp:alice",
        locationId,
      );
      expect(areaNarrative?.summary_text).toBe("Recovered by sweeper.");

      const job = db.get<{ status: string }>(
        "SELECT status FROM _memory_maintenance_jobs WHERE job_type = 'publication_recovery' AND idempotency_key = ?",
        [`publication_recovery:${settlementId}:0`],
      );
      expect(job?.status).toBe("reconciled");
    } finally {
      sweeper.stop();
      db.close();
      cleanupDb(dbPath);
    }
  });

  it("unique-constraint during recovery is treated as reconciled", async () => {
    const { dbPath, db } = createTempDb();
    runMemoryMigrations(db);

    const storage = new GraphStorageService(db);
    const projectionRepo = new AreaWorldProjectionRepo(db.raw);
    const locationId = storage.upsertEntity({
      pointerKey: "recovery-kitchen",
      displayName: "Recovery Kitchen",
      entityType: "location",
      memoryScope: "shared_public",
    });

    const settlementId = `stl:dup-${randomUUID()}`;
    storage.createProjectedEvent({
      sessionId: "sess:dup",
      summary: "Already materialized",
      timestamp: 200,
      participants: JSON.stringify([`entity:${locationId}`]),
      locationEntityId: locationId,
      eventCategory: "speech",
      origin: "runtime_projection",
      sourceSettlementId: settlementId,
      sourcePubIndex: 1,
      visibilityScope: "area_visible",
    });

    insertRecoveryJob({
      db,
      settlementId,
      pubIndex: 1,
      sessionId: "sess:dup",
      summary: "Already materialized",
      locationEntityId: locationId,
      participants: JSON.stringify([`entity:${locationId}`]),
      sourceAgentId: "rp:alice",
      timestamp: 200,
      nextAttemptAt: 0,
    });

    const sweeper = new PublicationRecoverySweeper(db, storage, {
      now: () => 1,
      projectionRepo,
    });

    try {
      await sweeper.sweep();

      const row = db.get<{ status: string }>(
        "SELECT status FROM _memory_maintenance_jobs WHERE job_type = 'publication_recovery' AND idempotency_key = ?",
        [`publication_recovery:${settlementId}:1`],
      );
      expect(row?.status).toBe("reconciled");

      const count = db.get<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM event_nodes WHERE source_settlement_id = ? AND source_pub_index = ?",
        [settlementId, 1],
      );
      expect(count?.cnt).toBe(1);

      const areaState = projectionRepo.getAreaStateCurrent(
        "rp:alice",
        locationId,
        `publication:${settlementId}:1`,
      );
      expect(areaState).not.toBeNull();
    } finally {
      sweeper.stop();
      db.close();
      cleanupDb(dbPath);
    }
  });

  it("materializePublications recovery jobs preserve projection metadata for sweeper replay", async () => {
    const { dbPath, db } = createTempDb();
    runMemoryMigrations(db);

    const storage = new GraphStorageService(db);
    const projectionRepo = new AreaWorldProjectionRepo(db.raw);
    const locationId = storage.upsertEntity({
      pointerKey: "recovery-library",
      displayName: "Recovery Library",
      entityType: "location",
      memoryScope: "shared_public",
    });

    const failingStorage = {
      createProjectedEvent: () => {
        const transient = new Error("database is locked");
        transient.name = "SQLiteError";
        throw transient;
      },
    } as unknown as GraphStorageService;

    const settlementId = `stl:projection-replay-${randomUUID()}`;
    const result = materializePublications(
      failingStorage,
      [{ kind: "spoken", targetScope: "current_area", summary: "Recovered through job replay." }],
      settlementId,
      {
        sessionId: "sess:projection-replay",
        locationEntityId: locationId,
        timestamp: 345,
      },
      {
        db: db.raw,
        projectionRepo,
        sourceAgentId: "rp:alice",
      },
    );

    expect(result).toEqual({ materialized: 0, reconciled: 0, skipped: 1 });

    const job = db.get<{ payload: string }>(
      "SELECT payload FROM _memory_maintenance_jobs WHERE job_type = 'publication_recovery' AND idempotency_key = ?",
      [`publication_recovery:${settlementId}:0`],
    );
    expect(job).toBeDefined();
    const payload = JSON.parse(job!.payload) as {
      nextAttemptAt: number;
      sourceAgentId: string | null;
      targetScope: string;
      kind: string;
    };
    expect(payload.sourceAgentId).toBe("rp:alice");
    expect(payload.targetScope).toBe("current_area");
    expect(payload.kind).toBe("spoken");

    const sweeper = new PublicationRecoverySweeper(db, storage, {
      now: () => payload.nextAttemptAt,
      projectionRepo,
    });

    try {
      await sweeper.sweep();

      const event = db.get<{ summary: string }>(
        "SELECT summary FROM event_nodes WHERE source_settlement_id = ? AND source_pub_index = ?",
        [settlementId, 0],
      );
      expect(event?.summary).toBe("Recovered through job replay.");

      const areaState = projectionRepo.getAreaStateCurrent(
        "rp:alice",
        locationId,
        `publication:${settlementId}:0`,
      );
      expect(areaState).not.toBeNull();

      const areaNarrative = projectionRepo.getAreaNarrativeCurrent(
        "rp:alice",
        locationId,
      );
      expect(areaNarrative?.summary_text).toBe("Recovered through job replay.");
    } finally {
      sweeper.stop();
      db.close();
      cleanupDb(dbPath);
    }
  });

  it("failed jobs transition retrying then exhausted after max retries", async () => {
    const { dbPath, db } = createTempDb();
    runMemoryMigrations(db);

    const failingStorage = {
      createProjectedEvent: () => {
        const transient = new Error("database is locked");
        transient.name = "SQLiteError";
        throw transient;
      },
    } as unknown as GraphStorageService;

    const settlementId = `stl:fail-${randomUUID()}`;
    insertRecoveryJob({
      db,
      settlementId,
      pubIndex: 0,
      nextAttemptAt: 0,
    });

    let now = 1_000;
    const sweeper = new PublicationRecoverySweeper(db, failingStorage, {
      now: () => now,
      random: () => 0,
      maxRetries: 2,
    });

    try {
      await sweeper.sweep();

      const retrying = db.get<{ status: string; payload: string }>(
        "SELECT status, payload FROM _memory_maintenance_jobs WHERE job_type = 'publication_recovery' AND idempotency_key = ?",
        [`publication_recovery:${settlementId}:0`],
      );
      expect(retrying?.status).toBe("retrying");
      const retryingPayload = JSON.parse(retrying!.payload) as { nextAttemptAt: number; failureCount: number };
      expect(retryingPayload.failureCount).toBe(1);

      now = retryingPayload.nextAttemptAt;
      await sweeper.sweep();

      const exhausted = db.get<{ status: string; payload: string }>(
        "SELECT status, payload FROM _memory_maintenance_jobs WHERE job_type = 'publication_recovery' AND idempotency_key = ?",
        [`publication_recovery:${settlementId}:0`],
      );
      expect(exhausted?.status).toBe("exhausted");

      const exhaustedPayload = JSON.parse(exhausted!.payload) as {
        failureCount: number;
        nextAttemptAt: number | null;
      };
      expect(exhaustedPayload.failureCount).toBe(2);
      expect(exhaustedPayload.nextAttemptAt).toBeNull();
    } finally {
      sweeper.stop();
      db.close();
      cleanupDb(dbPath);
    }
  });

  it("re-running sweep on reconciled job is a no-op", async () => {
    const { dbPath, db } = createTempDb();
    runMemoryMigrations(db);

    const storage = new GraphStorageService(db);
    const settlementId = `stl:noop-${randomUUID()}`;
    insertRecoveryJob({
      db,
      status: "reconciled",
      settlementId,
      pubIndex: 0,
      nextAttemptAt: null,
      updatedAt: 77,
    });

    const sweeper = new PublicationRecoverySweeper(db, storage, {
      now: () => 1_000,
    });

    try {
      await sweeper.sweep();

      const job = db.get<{ status: string; updated_at: number }>(
        "SELECT status, updated_at FROM _memory_maintenance_jobs WHERE job_type = 'publication_recovery' AND idempotency_key = ?",
        [`publication_recovery:${settlementId}:0`],
      );
      expect(job?.status).toBe("reconciled");
      expect(job?.updated_at).toBe(77);

      const count = db.get<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM event_nodes");
      expect(count?.cnt).toBe(0);
    } finally {
      sweeper.stop();
      db.close();
      cleanupDb(dbPath);
    }
  });
});
