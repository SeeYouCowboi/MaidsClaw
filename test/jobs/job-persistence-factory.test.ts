import { describe, expect, it } from "bun:test";
import type {
  CancelResult,
  ClaimNextResult,
  CompleteResult,
  DurableJobStore,
  EnqueueResult,
  FailResult,
  HeartbeatResult,
  PgJobCurrentRow,
  PgStatusCount,
} from "../../src/jobs/durable-store.js";
import { createJobPersistence } from "../../src/jobs/job-persistence-factory.js";
import { SqliteJobPersistence } from "../../src/jobs/persistence.js";
import type { JobKind } from "../../src/jobs/types.js";
import type { PgBackendFactory } from "../../src/storage/backend-types.js";
import { cleanupDb, createTempDb } from "../helpers/memory-test-utils.js";

function makeMockStore(overrides?: Partial<DurableJobStore>): DurableJobStore {
  const defaultEnqueueResult: EnqueueResult = {
    outcome: "created",
    job_key: "job-1",
    status: "pending",
    claim_version: 0,
  };
  const defaultClaimResult: ClaimNextResult = { outcome: "none_ready" };
  const defaultHeartbeatResult: HeartbeatResult = {
    outcome: "not_found",
    job_key: "job-1",
    claim_version: 0,
  };
  const defaultCompleteResult: CompleteResult = {
    outcome: "not_found",
    job_key: "job-1",
    claim_version: 0,
  };
  const defaultFailResult: FailResult = {
    outcome: "retry_scheduled",
    job_key: "job-1",
    claim_version: 0,
    next_attempt_at: Date.now() + 1_000,
  };
  const defaultCancelResult: CancelResult = {
    outcome: "not_found",
    job_key: "job-1",
    claim_version: 0,
  };
  const defaultStatusCount: PgStatusCount = {
    pending: 0,
    running: 0,
    succeeded: 0,
    failed_terminal: 0,
    cancelled: 0,
  };

  return {
    enqueue: async () => defaultEnqueueResult,
    claimNext: async () => defaultClaimResult,
    heartbeat: async () => defaultHeartbeatResult,
    complete: async () => defaultCompleteResult,
    fail: async () => defaultFailResult,
    cancel: async () => defaultCancelResult,
    reclaimExpiredLeases: async () => 0,
    inspect: async () => undefined,
    listActive: async () => [],
    listExpiredLeases: async () => [],
    countByStatus: async () => defaultStatusCount,
    getHistory: async () => [],
    ...overrides,
  };
}

describe("createJobPersistence", () => {
  it("returns SqliteJobPersistence for sqlite backend", () => {
    const { db, dbPath } = createTempDb();
    try {
      const persistence = createJobPersistence("sqlite", { db });
      expect(persistence.constructor.name).toBe("SqliteJobPersistence");
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("returns PgJobPersistence for pg backend", () => {
    const pgFactory = { store: makeMockStore() } as unknown as PgBackendFactory;

    const persistence = createJobPersistence("pg", { pgFactory });
    expect(persistence).toBeDefined();
    expect(persistence.constructor.name).not.toBe("SqliteJobPersistence");
  });

  it("throws for unknown backend type", () => {
    expect(() => createJobPersistence("unknown" as never, {})).toThrow("Unknown backend type: unknown");
  });
});

describe("PgJobPersistence lazy initialization", () => {
  it("does not call getPool() in constructor", () => {
    let getPoolCalls = 0;

    const pgFactory = {
      getPool: () => {
        getPoolCalls += 1;
        throw new Error("should not be called during constructor");
      },
      store: makeMockStore(),
    } as unknown as PgBackendFactory;

    createJobPersistence("pg", { pgFactory });
    expect(getPoolCalls).toBe(0);
  });

  it("calls store methods on first method invocation", async () => {
    let storeReads = 0;
    let listActiveCalls = 0;

    const rows: PgJobCurrentRow<JobKind>[] = [
      {
        job_key: "job-claimable",
        job_type: "memory.organize",
        execution_class: "background.memory_organize",
        concurrency_key: "memory.organize:global",
        status: "pending",
        payload_schema_version: 1,
        payload_json: { chunkNodeRefs: ["event:1"] },
        family_state_json: {},
        claim_version: 0,
        attempt_count: 0,
        max_attempts: 4,
        next_attempt_at: Date.now(),
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ];

    const store = makeMockStore({
      listActive: async () => {
        listActiveCalls += 1;
        return rows;
      },
    });

    const pgFactory = {} as PgBackendFactory;
    Object.defineProperty(pgFactory as object, "store", {
      configurable: true,
      get() {
        storeReads += 1;
        return store;
      },
    });

    const persistence = createJobPersistence("pg", { pgFactory });
    expect(storeReads).toBe(0);

    await persistence.listPending();
    expect(storeReads).toBeGreaterThan(0);
    expect(listActiveCalls).toBe(1);
  });
});
