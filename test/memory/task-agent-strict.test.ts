import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { JobEntry, JobPersistence, PersistentJobStatus } from "../../src/jobs/persistence.js";
import { CoreMemoryService } from "../../src/memory/core-memory.js";
import { EmbeddingService } from "../../src/memory/embeddings.js";
import { MaterializationService } from "../../src/memory/materialization.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import {
  MemoryTaskAgent,
  type ChatMessage,
  type ChatToolDefinition,
  type GraphOrganizerJob,
  type MemoryFlushRequest,
} from "../../src/memory/task-agent.js";
import { TransactionBatcher } from "../../src/memory/transaction-batcher.js";
import { cleanupDb, createTempDb } from "../helpers/memory-test-utils.js";

const AGENT_ID = "agent-strict-1";
const SESSION_ID = "session-strict-1";

type ToolCallResult = {
  name: string;
  arguments: Record<string, unknown>;
};

class MinimalModelProvider {
  readonly defaultEmbeddingModelId = "test-embed-model";
  private chatCallCount = 0;

  async chat(_messages: ChatMessage[], _tools: ChatToolDefinition[]): Promise<ToolCallResult[]> {
    this.chatCallCount += 1;
    if (this.chatCallCount === 1) {
      return [
        {
          name: "create_entity",
          arguments: {
            pointer_key: "person:strict-case",
            display_name: "Strict Case",
            entity_type: "person",
            memory_scope: "private_overlay",
          },
        },
      ];
    }

    return [{ name: "update_index_block", arguments: { new_text: "@person:strict-case" } }];
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array([1, 0.5]));
  }
}

function makeFlushRequest(idempotencyKey: string): MemoryFlushRequest {
  return {
    sessionId: SESSION_ID,
    agentId: AGENT_ID,
    rangeStart: 1,
    rangeEnd: 2,
    flushMode: "dialogue_slice",
    idempotencyKey,
    queueOwnerAgentId: AGENT_ID,
    dialogueRecords: [
      { role: "user", content: "remember strict mode", timestamp: 1000, recordId: "r1", recordIndex: 1 },
      { role: "assistant", content: "ok", timestamp: 1100, recordId: "r2", recordIndex: 2 },
    ],
  };
}

function createFailingPersistence(errorMessage: string): JobPersistence {
  return {
    async enqueue(_entry: Omit<JobEntry, "attemptCount" | "createdAt" | "updatedAt">): Promise<void> {
      throw new Error(errorMessage);
    },
    async claim(_jobId: string, _claimedBy: string, _leaseDurationMs: number): Promise<boolean> {
      return false;
    },
    async complete(_jobId: string): Promise<void> {},
    async fail(_jobId: string, _errorMessage: string, _retryable: boolean): Promise<void> {},
    async retry(_jobId: string): Promise<boolean> {
      return false;
    },
    async listPending(_limit?: number): Promise<JobEntry[]> {
      return [];
    },
    async listRetryable(_beforeTime: number, _limit?: number): Promise<JobEntry[]> {
      return [];
    },
    async countByStatus(_status: PersistentJobStatus): Promise<number> {
      return 0;
    },
  };
}

describe("MemoryTaskAgent strict durable mode", () => {
  it("throws enqueue failures in strict durable mode", async () => {
    const { db, dbPath } = createTempDb();
    let launchCallCount = 0;

    try {
      const storage = new GraphStorageService(db);
      const coreMemory = new CoreMemoryService(db);
      const embeddings = EmbeddingService.fromSqlite(db, new TransactionBatcher(db));
      const materialization = new MaterializationService(db.raw, storage);
      const provider = new MinimalModelProvider();
      const persistence = createFailingPersistence("enqueue failure strict");

      coreMemory.initializeBlocks(AGENT_ID);

      const taskAgent = new MemoryTaskAgent(
        db.raw,
        storage,
        coreMemory,
        embeddings,
        materialization,
        provider,
        undefined,
        persistence,
        true,
      );

      (taskAgent as any).launchBackgroundOrganize = (_job: GraphOrganizerJob) => {
        launchCallCount += 1;
      };

      let thrown: unknown;
      try {
        await taskAgent.runMigrate(makeFlushRequest("strict:throw"));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      expect((thrown as Error).message).toContain("enqueue failure strict");
      expect(launchCallCount).toBe(0);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("falls back to fire-and-forget organize in non-strict mode", async () => {
    const { db, dbPath } = createTempDb();
    let launchCallCount = 0;

    try {
      const storage = new GraphStorageService(db);
      const coreMemory = new CoreMemoryService(db);
      const embeddings = EmbeddingService.fromSqlite(db, new TransactionBatcher(db));
      const materialization = new MaterializationService(db.raw, storage);
      const provider = new MinimalModelProvider();
      const persistence = createFailingPersistence("enqueue failure non-strict");

      coreMemory.initializeBlocks(AGENT_ID);

      const taskAgent = new MemoryTaskAgent(
        db.raw,
        storage,
        coreMemory,
        embeddings,
        materialization,
        provider,
        undefined,
        persistence,
        false,
      );

      (taskAgent as any).launchBackgroundOrganize = (_job: GraphOrganizerJob) => {
        launchCallCount += 1;
      };

      const result = await taskAgent.runMigrate(makeFlushRequest("strict:fallback"));

      expect(result.batch_id).toBe("strict:fallback");
      expect(launchCallCount).toBe(1);
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("warns at construction when strict mode has no jobPersistence", () => {
    const { db, dbPath } = createTempDb();
    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    try {
      const storage = new GraphStorageService(db);
      const coreMemory = new CoreMemoryService(db);
      const embeddings = EmbeddingService.fromSqlite(db, new TransactionBatcher(db));
      const materialization = new MaterializationService(db.raw, storage);
      const provider = new MinimalModelProvider();

      coreMemory.initializeBlocks(AGENT_ID);

      new MemoryTaskAgent(
        db.raw,
        storage,
        coreMemory,
        embeddings,
        materialization,
        provider,
        undefined,
        undefined,
        true,
      );

      expect(warnMessages.some((message) => message.includes("strictDurableMode=true but no jobPersistence provided"))).toBe(true);
    } finally {
      console.warn = originalWarn;
      cleanupDb(db, dbPath);
    }
  });

  it("marks launchBackgroundOrganize as deprecated", () => {
    const source = readFileSync(new URL("../../src/memory/task-agent.ts", import.meta.url), "utf-8");

    expect(source).toContain("* @deprecated Use durable job queue via JobPersistence instead.");
    expect(source).toContain("* Preserved for backward compat when strictDurableMode is false.");
  });
});
