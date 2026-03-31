import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createAppHost } from "../../src/app/host/create-app-host.js";
import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";
import { DefaultModelServiceRegistry } from "../../src/core/models/registry.js";
import type { JobEntry, JobPersistence, PersistentJobStatus } from "../../src/jobs/persistence.js";

describe("bootstrapRuntime job persistence wiring", () => {
  const originalBackend = process.env.MAIDSCLAW_BACKEND;

  beforeEach(() => {
    process.env.MAIDSCLAW_BACKEND = "sqlite";
  });

  afterEach(() => {
    if (originalBackend === undefined) {
      delete process.env.MAIDSCLAW_BACKEND;
      return;
    }
    process.env.MAIDSCLAW_BACKEND = originalBackend;
  });

  it("exposes runtime.jobPersistence and creates sqlite persistence by default", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      expect(runtime.jobPersistence).toBeDefined();

      await runtime.jobPersistence.enqueue({
        id: "memory.organize:test",
        jobType: "memory.organize",
        payload: { settlementId: "test" },
        status: "pending",
        maxAttempts: 3,
      });

      const pending = await runtime.jobPersistence.listPending();
      expect(pending.some((entry) => entry.id === "memory.organize:test")).toBe(true);
    } finally {
      runtime.shutdown();
    }
  });

  it("uses injected jobPersistence when provided", async () => {
    const enqueued: Array<Omit<JobEntry, "attemptCount" | "createdAt" | "updatedAt">> = [];
    const injected: JobPersistence = {
      enqueue: async (entry: Omit<JobEntry, "attemptCount" | "createdAt" | "updatedAt">) => {
        enqueued.push(entry);
      },
      claim: async (_jobId: string, _claimedBy: string, _leaseDurationMs: number) => false,
      complete: async (_jobId: string) => {},
      fail: async (_jobId: string, _errorMessage: string, _retryable: boolean) => {},
      retry: async (_jobId: string) => false,
      listPending: async (_limit?: number) => [],
      listRetryable: async (_beforeTime: number, _limit?: number) => [],
      countByStatus: async (_status: PersistentJobStatus) => 0,
    };

    const modelRegistry = new DefaultModelServiceRegistry({
      chatPrefixes: [
        {
          prefix: "openai/",
          provider: {
            async *chatCompletion() {
              yield { type: "message_end", stopReason: "end_turn" };
            },
          },
        },
      ],
      embeddingPrefixes: [
        {
          prefix: "openai/",
          provider: {
            async embed(texts: string[]) {
              return texts.map(() => new Float32Array([0]));
            },
          },
        },
      ],
    });

    const runtime = bootstrapRuntime({
      databasePath: ":memory:",
      jobPersistence: injected,
      modelRegistry,
      memoryMigrationModelId: "openai/gpt-4o-mini",
      memoryEmbeddingModelId: "openai/text-embedding-3-small",
    });

    try {
      expect(runtime.jobPersistence).toBe(injected);
      expect(runtime.memoryTaskAgent).not.toBeNull();
      expect((runtime.memoryTaskAgent as unknown as { jobPersistence?: JobPersistence }).jobPersistence).toBe(injected);

      const turnServiceInternal = runtime.turnService as unknown as {
        graphStorage?: {
          syncSearchDoc?: (scope: "world", sourceRef: string, content: string) => number;
        };
      };

      runtime.db.exec("DROP TABLE search_docs_world_fts");
      turnServiceInternal.graphStorage?.syncSearchDoc?.(
        "world",
        "event:999",
        "trigger rebuild",
      );
      await Bun.sleep(0);

      expect(enqueued.some((entry) => entry.jobType === "search.rebuild")).toBe(true);
    } finally {
      runtime.shutdown();
    }
  });

  it("keeps local app host bootstrap behavior compatible", async () => {
    const host = await createAppHost({ role: "local", databasePath: ":memory:" });

    try {
      expect(host.user).toBeDefined();
      const status = await host.admin.getHostStatus();
      expect(status.backendType).toBe("sqlite");
    } finally {
      await host.shutdown();
    }
  });
});
