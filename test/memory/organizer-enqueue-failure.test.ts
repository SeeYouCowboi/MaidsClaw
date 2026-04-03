import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { MemoryTaskAgent, type GraphOrganizerJob } from "../../src/memory/task-agent.js";
import type { JobPersistence } from "../../src/jobs/persistence.js";
import type { NodeRef } from "../../src/memory/types.js";

function makeThrowingJobPersistence(error: Error): JobPersistence {
  return {
    enqueue: async () => { throw error; },
    claim: async () => false,
    complete: async () => {},
    fail: async () => {},
    retry: async () => false,
    listPending: async () => [],
    listRetryable: async () => [],
    countByStatus: async () => 0,
  };
}

function makeStubAgent(opts: {
  strictDurableMode: boolean;
  jobPersistence?: JobPersistence;
}): MemoryTaskAgent {
  const agent = Object.create(MemoryTaskAgent.prototype) as MemoryTaskAgent;
  const a = agent as unknown as Record<string, unknown>;

  // Provide a mock sqlFactory so runMigrateInternal takes the PG path.
  // The begin() callback receives an empty tx object — PG repo constructors just
  // store it, and all data-access methods are overridden on the stub below.
  a.sqlFactory = () => ({
    begin: (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  });
  a.modelProvider = {
    defaultEmbeddingModelId: "test-embed",
    chat: async () => [],
    embed: async () => [],
  };
  a.ingestionPolicy = {
    buildMigrateInput: () => ({
      batchId: "b1",
      agentId: "a1",
      sessionId: "s1",
      dialogue: [],
      attachments: [],
      explicitSettlements: [],
    }),
  };
  a.explicitSettlementProcessor = { process: async () => {} };
  a.coreMemoryIndexUpdater = { updateIndex: async () => {} };
  a.materialization = { materializeDelayed: () => {} };
  a.graphOrganizer = { run: async () => ({}) };
  a.storage = {};
  a.coreMemory = {};
  a.embeddings = {};
  a.jobPersistence = opts.jobPersistence;
  a.strictDurableMode = opts.strictDurableMode;
  a.migrateTail = Promise.resolve();
  a.organizeTail = Promise.resolve();

  return agent;
}

const STUB_FLUSH_REQUEST = {
  sessionId: "s1",
  agentId: "a1",
  rangeStart: 0,
  rangeEnd: 1,
  flushMode: "manual" as const,
  idempotencyKey: "batch-1",
};

describe("organizer enqueue failure behavior", () => {
  let errorSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    errorSpy?.mockRestore();
  });

  it("strictDurableMode=true: re-throws enqueue failure without background fallback", async () => {
    const enqueueError = new Error("enqueue boom");
    const persistence = makeThrowingJobPersistence(enqueueError);
    const agent = makeStubAgent({ strictDurableMode: true, jobPersistence: persistence });
    const a = agent as unknown as Record<string, unknown>;

    a.assertQueueOwnership = () => {};
    a.loadExistingContext = () => ({});
    a.applyCallOneToolCalls = (_req: unknown, _call: unknown, created: { changedNodeRefs: string[] }) => {
      created.changedNodeRefs.push("entity:e1");
      return [];
    };
    a.createSameEpisodeEdgesForBatch = () => {};

    let backgroundCalled = false;
    a.launchBackgroundOrganize = () => { backgroundCalled = true; };

    await expect(agent.runMigrate(STUB_FLUSH_REQUEST)).rejects.toThrow("enqueue boom");
    expect(backgroundCalled).toBe(false);
  });

  it("strictDurableMode=false: falls back to background with structured error log", async () => {
    const enqueueError = new Error("enqueue boom");
    const persistence = makeThrowingJobPersistence(enqueueError);
    const agent = makeStubAgent({ strictDurableMode: false, jobPersistence: persistence });
    const a = agent as unknown as Record<string, unknown>;

    a.assertQueueOwnership = () => {};
    a.loadExistingContext = () => ({});
    a.applyCallOneToolCalls = (_req: unknown, _call: unknown, created: { changedNodeRefs: string[] }) => {
      created.changedNodeRefs.push("entity:e1");
      return [];
    };
    a.createSameEpisodeEdgesForBatch = () => {};

    let backgroundJob: GraphOrganizerJob | undefined;
    a.launchBackgroundOrganize = (job: GraphOrganizerJob) => { backgroundJob = job; };

    errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const result = await agent.runMigrate(STUB_FLUSH_REQUEST);

    expect(result).toBeDefined();
    expect(result.batch_id).toBe("batch-1");
    expect(backgroundJob).toBeDefined();
    expect(backgroundJob!.agentId).toBe("a1");

    expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const enqueueCall = errorSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("organizer enqueue failed"),
    );
    expect(enqueueCall).toBeDefined();
    const ctx = enqueueCall![1] as Record<string, string>;
    expect(ctx.operation).toBe("runMigrateInternal");
    expect(ctx.jobType).toBe("graph_organizer");
    expect(ctx.batchId).toBe("batch-1");
    expect(ctx.agentId).toBe("a1");
    expect(ctx.error).toBe("enqueue boom");
  });

  it("strictDurableMode=true + no jobPersistence: throws instead of background fallback", async () => {
    const agent = makeStubAgent({ strictDurableMode: true });
    const a = agent as unknown as Record<string, unknown>;

    a.assertQueueOwnership = () => {};
    a.loadExistingContext = () => ({});
    a.applyCallOneToolCalls = (_req: unknown, _call: unknown, created: { changedNodeRefs: string[] }) => {
      created.changedNodeRefs.push("entity:e1");
      return [];
    };
    a.createSameEpisodeEdgesForBatch = () => {};

    let backgroundCalled = false;
    a.launchBackgroundOrganize = () => { backgroundCalled = true; };

    await expect(agent.runMigrate(STUB_FLUSH_REQUEST)).rejects.toThrow(
      "strictDurableMode requires jobPersistence",
    );
    expect(backgroundCalled).toBe(false);
  });

  it("strictDurableMode=false + no jobPersistence: deprecated fallback with structured warning", async () => {
    const agent = makeStubAgent({ strictDurableMode: false });
    const a = agent as unknown as Record<string, unknown>;

    a.assertQueueOwnership = () => {};
    a.loadExistingContext = () => ({});
    a.applyCallOneToolCalls = (_req: unknown, _call: unknown, created: { changedNodeRefs: string[] }) => {
      created.changedNodeRefs.push("entity:e1");
      return [];
    };
    a.createSameEpisodeEdgesForBatch = () => {};

    let backgroundJob: GraphOrganizerJob | undefined;
    a.launchBackgroundOrganize = (job: GraphOrganizerJob) => { backgroundJob = job; };

    errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const result = await agent.runMigrate(STUB_FLUSH_REQUEST);

    expect(result).toBeDefined();
    expect(result.batch_id).toBe("batch-1");
    expect(backgroundJob).toBeDefined();

    const deprecatedCall = errorSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("deprecated background fallback"),
    );
    expect(deprecatedCall).toBeDefined();
    const ctx = deprecatedCall![1] as Record<string, string>;
    expect(ctx.operation).toBe("runMigrateInternal");
    expect(ctx.jobType).toBe("graph_organizer");
    expect(ctx.batchId).toBe("batch-1");
    expect(ctx.agentId).toBe("a1");
  });
});
