import { describe, expect, it } from "bun:test";
import { JobDedupEngine } from "../../src/jobs/dedup.js";
import { JobDispatcher } from "../../src/jobs/dispatcher.js";
import { JobQueue } from "../../src/jobs/queue.js";
import type { JobEntry } from "../../src/jobs/persistence.js";
import type { Job, JobKind } from "../../src/jobs/types.js";

function makeJob(overrides?: Partial<Job>): Job {
  return {
    jobId: overrides?.jobId ?? crypto.randomUUID(),
    jobKey: overrides?.jobKey ?? "memory.migrate:session-1:0-9",
    kind: overrides?.kind ?? "memory.migrate",
    executionClass: overrides?.executionClass ?? "background.memory_migrate",
    sessionId: overrides?.sessionId ?? "session-1",
    agentId: overrides?.agentId ?? "agent-1",
    idempotencyKey: overrides?.idempotencyKey,
    payload: overrides?.payload ?? {},
    status: overrides?.status ?? "pending",
    attempts: overrides?.attempts ?? 0,
    maxAttempts: overrides?.maxAttempts ?? 2,
    retriable: overrides?.retriable ?? true,
    createdAt: overrides?.createdAt ?? Date.now(),
    startedAt: overrides?.startedAt,
    completedAt: overrides?.completedAt,
    error: overrides?.error,
    ownershipAccepted: overrides?.ownershipAccepted ?? false,
  };
}

function createDispatcher(): { queue: JobQueue; dedup: JobDedupEngine; dispatcher: JobDispatcher } {
  const queue = new JobQueue();
  const dedup = new JobDedupEngine();
  const dispatcher = new JobDispatcher({ queue, dedup });
  return { queue, dedup, dispatcher };
}

describe("JobDedupEngine", () => {
  it("returns coalesce/drop/noop/accept based on existing job status", () => {
    const engine = new JobDedupEngine();
    const key = "memory.migrate:session-1:0-9";

    const jobs = new Map<string, Job>();
    jobs.set(key, makeJob({ status: "pending", jobKey: key }));
    expect(engine.checkDuplicate(jobs, key)).toBe("coalesce");

    jobs.set(key, makeJob({ status: "running", jobKey: key }));
    expect(engine.checkDuplicate(jobs, key)).toBe("drop");

    jobs.set(key, makeJob({ status: "completed", jobKey: key }));
    expect(engine.checkDuplicate(jobs, key)).toBe("noop");

    expect(engine.checkDuplicate(jobs, "memory.migrate:session-2:0-9")).toBe("accept");
  });
});

describe("JobQueue", () => {
  it("dequeues higher-priority execution class first", () => {
    const queue = new JobQueue();

    queue.enqueue(
      makeJob({
        kind: "memory.organize",
        executionClass: "background.memory_organize",
        jobKey: "memory.organize:global:batch-1",
        createdAt: 100,
      }),
    );
    queue.enqueue(
      makeJob({
        kind: "memory.migrate",
        executionClass: "background.memory_migrate",
        jobKey: "memory.migrate:session-1:0-9",
        createdAt: 101,
      }),
    );

    const next = queue.dequeue();
    expect(next !== undefined).toBe(true);
    if (!next) {
      throw new Error("Expected a queued job");
    }
    expect(next.kind).toBe("memory.migrate");
  });
});

describe("JobDispatcher", () => {
  it("requeues retriable job before maxAttempts and eventually fails when exhausted", async () => {
    const { queue, dispatcher } = createDispatcher();

    let calls = 0;
    dispatcher.registerWorker("memory.organize", async () => {
      calls += 1;
      throw new Error("temporary failure");
    });

    const submitted = dispatcher.submit({
      jobKey: "memory.organize:global:b-1",
      kind: "memory.organize",
      executionClass: "background.memory_organize",
      payload: { batchId: "b-1" },
      retriable: true,
      maxAttempts: 2,
    });

    expect(submitted !== null).toBe(true);
    await dispatcher.processNext();

    const afterFirst = queue.getByKey("memory.organize:global:b-1");
    expect(afterFirst !== undefined).toBe(true);
    if (!afterFirst) {
      throw new Error("Expected pending job after first failure");
    }
    expect(afterFirst.status).toBe("pending");
    expect(afterFirst.attempts).toBe(1);

    await dispatcher.processNext();
    const afterSecond = queue.getByKey("memory.organize:global:b-1");
    expect(afterSecond !== undefined).toBe(true);
    if (!afterSecond) {
      throw new Error("Expected failed job after retry exhaustion");
    }
    expect(afterSecond.status).toBe("failed");
    expect(afterSecond.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it("sets G4 ownershipAccepted before worker resolves", async () => {
    const { queue, dispatcher } = createDispatcher();

    let resolveWorker: (() => void) | undefined;
    const workerGate = new Promise<void>((resolve) => {
      resolveWorker = resolve;
    });

    let ownershipSeenAtStart = false;
    dispatcher.registerWorker("memory.migrate", async (job) => {
      ownershipSeenAtStart = job.ownershipAccepted;
      await workerGate;
    });

    dispatcher.submit({
      jobKey: "memory.migrate:session-g4:0-9",
      kind: "memory.migrate",
      executionClass: "background.memory_migrate",
      payload: { rangeStart: 0, rangeEnd: 9 },
      sessionId: "session-g4",
      agentId: "agent-g4",
      retriable: false,
      maxAttempts: 1,
    });

    const processing = dispatcher.processNext();
    await Bun.sleep(0);

    const running = queue.getByKey("memory.migrate:session-g4:0-9");
    expect(running !== undefined).toBe(true);
    if (!running) {
      throw new Error("Expected running job");
    }
    expect(running.status).toBe("running");
    expect(running.ownershipAccepted).toBe(true);
    expect(ownershipSeenAtStart).toBe(true);

    if (!resolveWorker) {
      throw new Error("Worker gate was not initialized");
    }
    resolveWorker();
    await processing;

    const completed = queue.getByKey("memory.migrate:session-g4:0-9");
    expect(completed !== undefined).toBe(true);
    if (!completed) {
      throw new Error("Expected completed job");
    }
    expect(completed.status).toBe("completed");
  });

  it("deduplicates duplicate memory.migrate submit in same session", () => {
    const { queue, dispatcher } = createDispatcher();

    dispatcher.registerWorker("memory.migrate", async () => {});

    const spec = {
      jobKey: "memory.migrate:session-dup:0-9",
      kind: "memory.migrate" as JobKind,
      executionClass: "background.memory_migrate" as const,
      sessionId: "session-dup",
      agentId: "agent-dup",
      payload: { rangeStart: 0, rangeEnd: 9 },
      retriable: true,
      maxAttempts: 2,
    };

    const first = dispatcher.submit(spec);
    const second = dispatcher.submit(spec);

    expect(first !== null).toBe(true);
    expect(second).toBeNull();
    expect(queue.size()).toBe(1);
  });
});

describe("search.rebuild recovery", () => {
  function createMockPersistence(entries: JobEntry[]) {
    return {
      listPending: () => entries,
      listRetryable: () => [],
    };
  }

  it("recovers search.rebuild job from persistence and maps to correct execution class", () => {
    const queue = new JobQueue();
    const dedup = new JobDedupEngine();
    const mockPersistence = createMockPersistence([
      {
        id: "search-rebuild-1",
        jobType: "search.rebuild",
        payload: {},
        status: "pending",
        attemptCount: 0,
        maxAttempts: 2,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    const dispatcher = new JobDispatcher({
      queue,
      dedup,
      persistence: mockPersistence as any,
    });

    dispatcher.start();

    const recoveredJob = queue.getByKey("search-rebuild-1");
    expect(recoveredJob !== undefined).toBe(true);
    if (recoveredJob) {
      expect(recoveredJob.kind).toBe("search.rebuild");
      expect(recoveredJob.executionClass).toBe("background.search_rebuild");
    }
  });

  it("recovers search.rebuild from retryable state", () => {
    const queue = new JobQueue();
    const dedup = new JobDedupEngine();
    const mockPersistence = {
      listPending: () => [],
      listRetryable: () => [
        {
          id: "search-rebuild-retry",
          jobType: "search.rebuild",
          payload: { batchId: "batch-1" },
          status: "retryable",
          attemptCount: 1,
          maxAttempts: 3,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          errorMessage: "Previous failure",
        },
      ],
    };

    const dispatcher = new JobDispatcher({
      queue,
      dedup,
      persistence: mockPersistence as any,
    });

    dispatcher.start();

    const recoveredJob = queue.getByKey("search-rebuild-retry");
    expect(recoveredJob !== undefined).toBe(true);
    if (recoveredJob) {
      expect(recoveredJob.kind).toBe("search.rebuild");
      expect(recoveredJob.executionClass).toBe("background.search_rebuild");
      expect(recoveredJob.attempts).toBe(1);
      expect(recoveredJob.error).toBe("Previous failure");
    }
  });

  it("does NOT drop search.rebuild job on recovery (regression test)", () => {
    const queue = new JobQueue();
    const dedup = new JobDedupEngine();
    const mockPersistence = createMockPersistence([
      {
        id: "search-rebuild-critical",
        jobType: "search.rebuild",
        payload: { indexName: "memory_idx" },
        status: "pending",
        attemptCount: 0,
        maxAttempts: 2,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    const dispatcher = new JobDispatcher({
      queue,
      dedup,
      persistence: mockPersistence as any,
    });

    dispatcher.start();

    const recoveredJob = queue.getByKey("search-rebuild-critical");
    expect(recoveredJob).toBeDefined();
    expect(queue.size()).toBe(1);
  });
});
