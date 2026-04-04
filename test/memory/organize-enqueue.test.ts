import { describe, it, expect } from "bun:test";
import { enqueueOrganizerJobs, ORGANIZER_CHUNK_SIZE } from "../../src/memory/organize-enqueue.js";
import type { JobPersistence, JobEntry } from "../../src/jobs/persistence.js";
import type { NodeRef } from "../../src/memory/types.js";

function createMockJobPersistence(opts: {
  shouldThrow?: boolean;
  errorMessage?: string;
} = {}): { persistence: JobPersistence; calls: JobEntry[] } {
  const calls: JobEntry[] = [];

  const persistence: JobPersistence = {
    enqueue: async (entry) => {
      if (opts.shouldThrow) {
        throw new Error(opts.errorMessage ?? "enqueue failed");
      }
      calls.push(entry as JobEntry);
    },
    claim: async () => false,
    complete: async () => {},
    fail: async () => {},
    retry: async () => false,
    listPending: async () => [],
    listRetryable: async () => [],
    countByStatus: async () => 0,
  };

  return { persistence, calls };
}

function generateNodeRefs(count: number): NodeRef[] {
  return Array.from({ length: count }, (_, i) => `entity:${i + 1}` as NodeRef);
}

describe("enqueueOrganizerJobs", () => {
  describe("chunking logic", () => {
    it("0 NodeRefs → enqueue() called 0 times", async () => {
      const { persistence, calls } = createMockJobPersistence();

      await enqueueOrganizerJobs(
        persistence,
        "agent-1",
        "settlement-1",
        [],
      );

      expect(calls.length).toBe(0);
    });

    it("50 NodeRefs → enqueue() called exactly 1 time", async () => {
      const { persistence, calls } = createMockJobPersistence();
      const nodeRefs = generateNodeRefs(50);

      await enqueueOrganizerJobs(
        persistence,
        "agent-1",
        "settlement-1",
        nodeRefs,
      );

      expect(calls.length).toBe(1);
      expect(calls[0].id).toBe("memory.organize:settlement-1:chunk:0001");
      expect(calls[0].jobType).toBe("memory.organize");
    });

    it("51 NodeRefs → enqueue() called exactly 2 times", async () => {
      const { persistence, calls } = createMockJobPersistence();
      const nodeRefs = generateNodeRefs(51);

      await enqueueOrganizerJobs(
        persistence,
        "agent-1",
        "settlement-1",
        nodeRefs,
      );

      expect(calls.length).toBe(2);
      expect(calls[0].id).toBe("memory.organize:settlement-1:chunk:0001");
      expect(calls[1].id).toBe("memory.organize:settlement-1:chunk:0002");
    });

    it("100 NodeRefs → enqueue() called exactly 2 times", async () => {
      const { persistence, calls } = createMockJobPersistence();
      const nodeRefs = generateNodeRefs(100);

      await enqueueOrganizerJobs(
        persistence,
        "agent-1",
        "settlement-1",
        nodeRefs,
      );

      expect(calls.length).toBe(2);
      expect(calls[0].id).toBe("memory.organize:settlement-1:chunk:0001");
      expect(calls[1].id).toBe("memory.organize:settlement-1:chunk:0002");
    });

    it("101 NodeRefs → enqueue() called exactly 3 times", async () => {
      const { persistence, calls } = createMockJobPersistence();
      const nodeRefs = generateNodeRefs(101);

      await enqueueOrganizerJobs(
        persistence,
        "agent-1",
        "settlement-1",
        nodeRefs,
      );

      expect(calls.length).toBe(3);
      expect(calls[0].id).toBe("memory.organize:settlement-1:chunk:0001");
      expect(calls[1].id).toBe("memory.organize:settlement-1:chunk:0002");
      expect(calls[2].id).toBe("memory.organize:settlement-1:chunk:0003");
    });
  });

  describe("job ID format", () => {
    it("job IDs follow format: memory.organize:{settlementId}:chunk:{ordinal}", async () => {
      const { persistence, calls } = createMockJobPersistence();
      const nodeRefs = generateNodeRefs(101);

      await enqueueOrganizerJobs(
        persistence,
        "agent-1",
        "settlement-abc",
        nodeRefs,
      );

      expect(calls[0].id).toBe("memory.organize:settlement-abc:chunk:0001");
      expect(calls[1].id).toBe("memory.organize:settlement-abc:chunk:0002");
      expect(calls[2].id).toBe("memory.organize:settlement-abc:chunk:0003");
    });
  });

  describe("deduplication", () => {
    it("removes duplicate NodeRefs before chunking", async () => {
      const { persistence, calls } = createMockJobPersistence();
      const duplicateRefs: NodeRef[] = [
        "entity:1" as NodeRef,
        "entity:2" as NodeRef,
        "entity:1" as NodeRef,
        "entity:3" as NodeRef,
        "entity:2" as NodeRef,
      ];

      await enqueueOrganizerJobs(
        persistence,
        "agent-1",
        "settlement-1",
        duplicateRefs,
      );

      expect(calls.length).toBe(1);
      const payload = calls[0].payload as { chunkNodeRefs: NodeRef[] };
      expect(payload.chunkNodeRefs.length).toBe(3);
    });
  });

  describe("error propagation", () => {
    it("enqueue() throws → error propagates (NOT swallowed)", async () => {
      const { persistence } = createMockJobPersistence({
        shouldThrow: true,
        errorMessage: "database connection lost",
      });
      const nodeRefs = generateNodeRefs(10);

      await expect(
        enqueueOrganizerJobs(
          persistence,
          "agent-1",
          "settlement-1",
          nodeRefs,
        ),
      ).rejects.toThrow("database connection lost");
    });

    it("error propagates on first chunk failure (subsequent chunks not attempted)", async () => {
      let callCount = 0;
      const persistence: JobPersistence = {
        enqueue: async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error("first chunk failed");
          }
        },
        claim: async () => false,
        complete: async () => {},
        fail: async () => {},
        retry: async () => false,
        listPending: async () => [],
        listRetryable: async () => [],
        countByStatus: async () => 0,
      };

      const nodeRefs = generateNodeRefs(100);

      await expect(
        enqueueOrganizerJobs(
          persistence,
          "agent-1",
          "settlement-1",
          nodeRefs,
        ),
      ).rejects.toThrow("first chunk failed");

      expect(callCount).toBe(1);
    });
  });

  describe("chunk size parameter", () => {
    it("uses ORGANIZER_CHUNK_SIZE (50) as default", async () => {
      expect(ORGANIZER_CHUNK_SIZE).toBe(50);
    });

    it("respects custom chunk size parameter", async () => {
      const { persistence, calls } = createMockJobPersistence();
      const nodeRefs = generateNodeRefs(10);

      await enqueueOrganizerJobs(
        persistence,
        "agent-1",
        "settlement-1",
        nodeRefs,
        3,
      );

      expect(calls.length).toBe(4);
      const p0 = calls[0].payload as { chunkNodeRefs: NodeRef[] };
      const p1 = calls[1].payload as { chunkNodeRefs: NodeRef[] };
      const p2 = calls[2].payload as { chunkNodeRefs: NodeRef[] };
      const p3 = calls[3].payload as { chunkNodeRefs: NodeRef[] };
      expect(p0.chunkNodeRefs.length).toBe(3);
      expect(p1.chunkNodeRefs.length).toBe(3);
      expect(p2.chunkNodeRefs.length).toBe(3);
      expect(p3.chunkNodeRefs.length).toBe(1);
    });
  });

  describe("job payload structure", () => {
    it("includes correct jobType and status", async () => {
      const { persistence, calls } = createMockJobPersistence();
      const nodeRefs = generateNodeRefs(10);

      await enqueueOrganizerJobs(
        persistence,
        "agent-1",
        "settlement-1",
        nodeRefs,
      );

      expect(calls[0].jobType).toBe("memory.organize");
      expect(calls[0].status).toBe("pending");
    });

    it("includes maxAttempts from JOB_MAX_ATTEMPTS", async () => {
      const { persistence, calls } = createMockJobPersistence();
      const nodeRefs = generateNodeRefs(10);

      await enqueueOrganizerJobs(
        persistence,
        "agent-1",
        "settlement-1",
        nodeRefs,
      );

      expect(calls[0].maxAttempts).toBe(4);
    });

    it("includes nextAttemptAt as current timestamp", async () => {
      const { persistence, calls } = createMockJobPersistence();
      const nodeRefs = generateNodeRefs(10);

      const before = Date.now();
      await enqueueOrganizerJobs(
        persistence,
        "agent-1",
        "settlement-1",
        nodeRefs,
      );
      const after = Date.now();

      expect(calls[0].nextAttemptAt).toBeGreaterThanOrEqual(before);
      expect(calls[0].nextAttemptAt).toBeLessThanOrEqual(after);
    });
  });
});
