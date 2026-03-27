import { describe, expect, it } from "bun:test";
import { JobDedupEngine } from "../../src/jobs/dedup.js";
import { JobDispatcher } from "../../src/jobs/dispatcher.js";
import { SqliteJobPersistence } from "../../src/jobs/persistence.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { CoreMemoryService } from "../../src/memory/core-memory.js";
import { EmbeddingService } from "../../src/memory/embeddings.js";
import { MaterializationService } from "../../src/memory/materialization.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import {
  MemoryTaskAgent,
  type ChatMessage,
  type ChatToolDefinition,
  type MemoryFlushRequest,
} from "../../src/memory/task-agent.js";
import { TransactionBatcher } from "../../src/memory/transaction-batcher.js";
import type { Db } from "../../src/storage/database.js";
import { cleanupDb, createTempDb } from "../helpers/memory-test-utils.js";

const ORGANIZER_CHUNK_SIZE = 50;

type ToolCallResult = {
  name: string;
  arguments: Record<string, unknown>;
};

type DurableOrganizerPayload = {
  agentId: string;
  chunkNodeRefs: string[];
  settlementId: string;
};

type OrganizeJobRow = {
  idempotency_key: string;
  status: string;
  payload: string | null;
};

class BulkEntityModelProvider {
  readonly defaultEmbeddingModelId = "test-embed-model";
  private chatCallCount = 0;

  constructor(private readonly entityCount: number) {}

  async chat(_messages: ChatMessage[], _tools: ChatToolDefinition[]): Promise<ToolCallResult[]> {
    this.chatCallCount += 1;
    if (this.chatCallCount === 1) {
      return Array.from({ length: this.entityCount }, (_, index) => ({
        name: "create_entity",
        arguments: {
          pointer_key: `person:chunk-${index + 1}`,
          display_name: `Chunk Person ${index + 1}`,
          entity_type: "person",
          memory_scope: "private_overlay",
        },
      }));
    }

    return [{ name: "update_index_block", arguments: { new_text: "@person:chunk-1" } }];
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((_, index) => new Float32Array([index + 1, 0.25]));
  }
}

function makeFlushRequest(idempotencyKey: string): MemoryFlushRequest {
  return {
    sessionId: "session-durable-1",
    agentId: "agent-durable-1",
    rangeStart: 1,
    rangeEnd: 2,
    flushMode: "dialogue_slice",
    idempotencyKey,
    queueOwnerAgentId: "agent-durable-1",
    dialogueRecords: [
      { role: "user", content: "remember this", timestamp: 1000, recordId: "r1", recordIndex: 1 },
      { role: "assistant", content: "noted", timestamp: 1100, recordId: "r2", recordIndex: 2 },
    ],
  };
}

function listOrganizerRows(db: Db): OrganizeJobRow[] {
  return db.query<OrganizeJobRow>(
    `SELECT idempotency_key, status, payload
     FROM _memory_maintenance_jobs
     WHERE job_type = 'memory.organize'
     ORDER BY idempotency_key ASC`,
  );
}

function parsePayload(row: OrganizeJobRow): DurableOrganizerPayload {
  const parsed = row.payload ? JSON.parse(row.payload) as DurableOrganizerPayload : null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`missing payload for ${row.idempotency_key}`);
  }
  return parsed;
}

async function processNextTimes(dispatcher: JobDispatcher, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const processed = await dispatcher.processNext();
    expect(processed).toBe(true);
  }
}

async function processUntilDrained(dispatcher: JobDispatcher, max = 64): Promise<void> {
  for (let index = 0; index < max; index += 1) {
    const processed = await dispatcher.processNext();
    if (!processed) {
      return;
    }
  }
  throw new Error("dispatcher did not drain within max iterations");
}

describe("organizer durable per-chunk pipeline", () => {
  it("splits changedNodeRefs into multiple memory.organize durable chunk jobs", async () => {
    const { db, dbPath } = createTempDb();

    try {
      const storage = new GraphStorageService(db);
      const coreMemory = new CoreMemoryService(db);
      const embeddings = new EmbeddingService(db, new TransactionBatcher(db));
      const materialization = new MaterializationService(db.raw, storage);
      const persistence = new SqliteJobPersistence(db);
      const provider = new BulkEntityModelProvider(121);

      coreMemory.initializeBlocks("agent-durable-1");

      const taskAgent = new MemoryTaskAgent(
        db.raw,
        storage,
        coreMemory,
        embeddings,
        materialization,
        provider,
        undefined,
        persistence,
      );

      await taskAgent.runMigrate(makeFlushRequest("queue:durable-splitting"));

      const rows = listOrganizerRows(db);
      expect(rows).toHaveLength(3);

      const parsed = rows.map(parsePayload);
      expect(parsed.every((entry) => entry.settlementId === "queue:durable-splitting")).toBe(true);
      expect(parsed.every((entry) => entry.agentId === "agent-durable-1")).toBe(true);
      expect(parsed.every((entry) => entry.chunkNodeRefs.length <= ORGANIZER_CHUNK_SIZE)).toBe(true);

      const totalRefs = parsed.reduce((sum, entry) => sum + entry.chunkNodeRefs.length, 0);
      expect(totalRefs).toBe(121);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("isolates per-chunk failures so other chunks reconcile", async () => {
    const { db, dbPath } = createTempDb();

    try {
      const storage = new GraphStorageService(db);
      const coreMemory = new CoreMemoryService(db);
      const embeddings = new EmbeddingService(db, new TransactionBatcher(db));
      const materialization = new MaterializationService(db.raw, storage);
      const persistence = new SqliteJobPersistence(db);
      const provider = new BulkEntityModelProvider(101);

      coreMemory.initializeBlocks("agent-durable-1");

      const taskAgent = new MemoryTaskAgent(
        db.raw,
        storage,
        coreMemory,
        embeddings,
        materialization,
        provider,
        undefined,
        persistence,
      );

      await taskAgent.runMigrate(makeFlushRequest("queue:durable-isolation"));
      const rows = listOrganizerRows(db);
      expect(rows.length).toBeGreaterThanOrEqual(3);

      const failTarget = rows[rows.length - 1]?.idempotency_key;
      expect(failTarget).toBeDefined();

      const queue = new JobQueue(persistence);
      const dedup = new JobDedupEngine();
      const dispatcher = new JobDispatcher({ queue, dedup, persistence });

      dispatcher.registerWorker("memory.organize", async (job) => {
        const payload = job.payload as DurableOrganizerPayload;
        if (job.idempotencyKey === failTarget) {
          throw new Error("simulated chunk crash");
        }

        await taskAgent.runOrganize({
          agentId: payload.agentId,
          sessionId: "session-durable-1",
          batchId: payload.settlementId,
          changedNodeRefs: payload.chunkNodeRefs as never,
          embeddingModelId: provider.defaultEmbeddingModelId,
        });
      });

      dispatcher.start();
      await processNextTimes(dispatcher, rows.length);

      const finalRows = listOrganizerRows(db);
      const statusById = new Map(finalRows.map((row) => [row.idempotency_key, row.status]));

      expect(statusById.get(String(failTarget))).toBe("retryable");
      const reconciledCount = finalRows.filter((row) => row.status === "reconciled").length;
      expect(reconciledCount).toBe(finalRows.length - 1);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("recovers retryable organizer chunk jobs after crash and redispatch", async () => {
    const { db, dbPath } = createTempDb();

    try {
      const storage = new GraphStorageService(db);
      const coreMemory = new CoreMemoryService(db);
      const embeddings = new EmbeddingService(db, new TransactionBatcher(db));
      const materialization = new MaterializationService(db.raw, storage);
      const persistence = new SqliteJobPersistence(db);
      const provider = new BulkEntityModelProvider(70);

      coreMemory.initializeBlocks("agent-durable-1");

      const taskAgent = new MemoryTaskAgent(
        db.raw,
        storage,
        coreMemory,
        embeddings,
        materialization,
        provider,
        undefined,
        persistence,
      );

      await taskAgent.runMigrate(makeFlushRequest("queue:durable-recovery"));
      const initialRows = listOrganizerRows(db);
      expect(initialRows.length).toBeGreaterThanOrEqual(2);

      const failOnceTarget = initialRows[0]?.idempotency_key;
      expect(failOnceTarget).toBeDefined();
      let failedOnce = false;

      const queue = new JobQueue(persistence);
      const dedup = new JobDedupEngine();
      const dispatcher = new JobDispatcher({ queue, dedup, persistence });

      dispatcher.registerWorker("memory.organize", async (job) => {
        const payload = job.payload as DurableOrganizerPayload;

        if (job.idempotencyKey === failOnceTarget && !failedOnce) {
          failedOnce = true;
          throw new Error("transient organizer crash");
        }

        await taskAgent.runOrganize({
          agentId: payload.agentId,
          sessionId: "session-durable-1",
          batchId: `${payload.settlementId}:recovery`,
          changedNodeRefs: payload.chunkNodeRefs as never,
          embeddingModelId: provider.defaultEmbeddingModelId,
        });
      });

      dispatcher.start();

      const firstProcessed = await dispatcher.processNext();
      expect(firstProcessed).toBe(true);

      const afterCrash = listOrganizerRows(db);
      const crashRow = afterCrash.find((row) => row.idempotency_key === failOnceTarget);
      expect(crashRow?.status).toBe("retryable");

      await processUntilDrained(dispatcher);

      const finalRows = listOrganizerRows(db);
      expect(finalRows.every((row) => row.status === "reconciled")).toBe(true);

      const embeddingCount = db.get<{ count: number }>(
        "SELECT count(*) AS count FROM node_embeddings WHERE model_id = ?",
        [provider.defaultEmbeddingModelId],
      )?.count ?? 0;
      expect(embeddingCount).toBeGreaterThan(0);
    } finally {
      cleanupDb(db, dbPath);
    }
  });
});
