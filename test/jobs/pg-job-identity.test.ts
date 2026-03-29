import { describe, expect, it } from "bun:test";
import {
  buildOrganizeEnqueueInput,
  buildSearchRebuildEnqueueInput,
  type OrganizeJobParams,
  type SearchRebuildJobParams,
} from "../../src/jobs/pg-job-builders.js";
import { JOB_MAX_ATTEMPTS } from "../../src/jobs/types.js";

describe("memory.organize", () => {
  it("emits exact job_key pattern with settlementId and chunkOrdinal", () => {
    const params: OrganizeJobParams = {
      settlementId: "settlement_abc123",
      agentId: "agent_xyz789",
      chunkOrdinal: "0001",
      chunkNodeRefs: ["node1", "node2", "node3"],
      embeddingModelId: "text-embedding-3-small",
    };

    const input = buildOrganizeEnqueueInput(params);

    expect(input.job_key).toBe("memory.organize:settlement:settlement_abc123:chunk:0001");
  });

  it("has concurrency_key as memory.organize:global", () => {
    const params: OrganizeJobParams = {
      settlementId: "settlement_abc123",
      agentId: "agent_xyz789",
      chunkOrdinal: "0001",
      chunkNodeRefs: ["node1"],
      embeddingModelId: "text-embedding-3-small",
    };

    const input = buildOrganizeEnqueueInput(params);

    expect(input.concurrency_key).toBe("memory.organize:global");
  });

  it("does not have job_family_key field", () => {
    const params: OrganizeJobParams = {
      settlementId: "settlement_abc123",
      agentId: "agent_xyz789",
      chunkOrdinal: "0001",
      chunkNodeRefs: ["node1"],
      embeddingModelId: "text-embedding-3-small",
    };

    const input = buildOrganizeEnqueueInput(params);

    expect("job_family_key" in input).toBe(false);
  });

  it("payload contains settlementId, agentId, chunkOrdinal", () => {
    const params: OrganizeJobParams = {
      settlementId: "settlement_abc123",
      agentId: "agent_xyz789",
      chunkOrdinal: "0001",
      chunkNodeRefs: ["node1", "node2"],
      embeddingModelId: "text-embedding-3-small",
    };

    const input = buildOrganizeEnqueueInput(params);
    const payload = input.payload_json as OrganizeJobParams;

    expect(payload.settlementId).toBe("settlement_abc123");
    expect(payload.agentId).toBe("agent_xyz789");
    expect(payload.chunkOrdinal).toBe("0001");
    expect(payload.chunkNodeRefs).toEqual(["node1", "node2"]);
    expect(payload.embeddingModelId).toBe("text-embedding-3-small");
  });

  it("payload includes sourceSessionId when provided", () => {
    const params: OrganizeJobParams = {
      settlementId: "settlement_abc123",
      agentId: "agent_xyz789",
      sourceSessionId: "session_12345",
      chunkOrdinal: "0001",
      chunkNodeRefs: ["node1"],
      embeddingModelId: "text-embedding-3-small",
    };

    const input = buildOrganizeEnqueueInput(params);
    const payload = input.payload_json as OrganizeJobParams;

    expect(payload.sourceSessionId).toBe("session_12345");
  });

  it("uses correct job_type and execution_class", () => {
    const params: OrganizeJobParams = {
      settlementId: "settlement_abc123",
      agentId: "agent_xyz789",
      chunkOrdinal: "0001",
      chunkNodeRefs: ["node1"],
      embeddingModelId: "text-embedding-3-small",
    };

    const input = buildOrganizeEnqueueInput(params);

    expect(input.job_type).toBe("memory.organize");
    expect(input.execution_class).toBe("background.memory_organize");
  });

  it("uses max_attempts from JOB_MAX_ATTEMPTS (value: 4)", () => {
    const params: OrganizeJobParams = {
      settlementId: "settlement_abc123",
      agentId: "agent_xyz789",
      chunkOrdinal: "0001",
      chunkNodeRefs: ["node1"],
      embeddingModelId: "text-embedding-3-small",
    };

    const input = buildOrganizeEnqueueInput(params);

    expect(input.max_attempts).toBe(JOB_MAX_ATTEMPTS["memory.organize"]);
    expect(input.max_attempts).toBe(4);
  });
});

describe("search.rebuild", () => {
  it("job_key starts with search.rebuild: and contains :req:", () => {
    const params: SearchRebuildJobParams = {
      scope: "private",
      targetAgentId: "agent_123",
      triggerSource: "manual_cli",
      triggerReason: "fts_repair",
    };

    const input = buildSearchRebuildEnqueueInput(params);

    expect(input.job_key.startsWith("search.rebuild:")).toBe(true);
    expect(input.job_key.includes(":req:")).toBe(true);
  });

  it("has job_family_key set matching the family fragment (without req: part)", () => {
    const params: SearchRebuildJobParams = {
      scope: "private",
      targetAgentId: "agent_123",
      triggerSource: "manual_cli",
      triggerReason: "fts_repair",
    };

    const input = buildSearchRebuildEnqueueInput(params);

    expect(input.job_family_key).toBe("search.rebuild:private:agent_123");
  });

  it("job_family_key for area scope uses scope only", () => {
    const params: SearchRebuildJobParams = {
      scope: "area",
      targetAgentId: null,
      triggerSource: "manual_cli",
      triggerReason: "full_rebuild",
    };

    const input = buildSearchRebuildEnqueueInput(params);

    expect(input.job_family_key).toBe("search.rebuild:area");
  });

  it("job_family_key for world scope uses scope only", () => {
    const params: SearchRebuildJobParams = {
      scope: "world",
      targetAgentId: null,
      triggerSource: "scheduled_maintenance",
      triggerReason: "backfill",
    };

    const input = buildSearchRebuildEnqueueInput(params);

    expect(input.job_family_key).toBe("search.rebuild:world");
  });

  it("job_family_key for cognition scope includes targetAgentId", () => {
    const params: SearchRebuildJobParams = {
      scope: "cognition",
      targetAgentId: "agent_456",
      triggerSource: "drift_detector",
      triggerReason: "drift_detected",
    };

    const input = buildSearchRebuildEnqueueInput(params);

    expect(input.job_family_key).toBe("search.rebuild:cognition:agent_456");
  });

  it("has concurrency_key as search.rebuild:global", () => {
    const params: SearchRebuildJobParams = {
      scope: "private",
      targetAgentId: "agent_123",
      triggerSource: "manual_cli",
      triggerReason: "fts_repair",
    };

    const input = buildSearchRebuildEnqueueInput(params);

    expect(input.concurrency_key).toBe("search.rebuild:global");
  });

  it("two calls with same params produce DIFFERENT job_key values (request-instance uniqueness)", () => {
    const params: SearchRebuildJobParams = {
      scope: "private",
      targetAgentId: "agent_123",
      triggerSource: "manual_cli",
      triggerReason: "fts_repair",
    };

    const input1 = buildSearchRebuildEnqueueInput(params);
    const input2 = buildSearchRebuildEnqueueInput(params);

    expect(input1.job_key).not.toBe(input2.job_key);
    expect(input1.job_family_key).toBe(input2.job_family_key);
  });

  it("throws when given scope: all as input", () => {
    const params = {
      scope: "all" as const,
      targetAgentId: "agent_123",
      triggerSource: "manual_cli",
      triggerReason: "fts_repair",
    };

    expect(() => buildSearchRebuildEnqueueInput(params as unknown as SearchRebuildJobParams)).toThrow(
      'Invalid search.rebuild scope: "all" is not allowed',
    );
  });

  it("throws when given targetAgentId: _all_agents as input", () => {
    const params = {
      scope: "private" as const,
      targetAgentId: "_all_agents",
      triggerSource: "manual_cli",
      triggerReason: "fts_repair",
    };

    expect(() => buildSearchRebuildEnqueueInput(params as SearchRebuildJobParams)).toThrow(
      'Invalid search.rebuild targetAgentId: "_all_agents" is not allowed',
    );
  });

  it("uses correct job_type and execution_class", () => {
    const params: SearchRebuildJobParams = {
      scope: "private",
      targetAgentId: "agent_123",
      triggerSource: "manual_cli",
      triggerReason: "fts_repair",
    };

    const input = buildSearchRebuildEnqueueInput(params);

    expect(input.job_type).toBe("search.rebuild");
    expect(input.execution_class).toBe("background.search_rebuild");
  });

  it("uses max_attempts from JOB_MAX_ATTEMPTS (value: 3)", () => {
    const params: SearchRebuildJobParams = {
      scope: "private",
      targetAgentId: "agent_123",
      triggerSource: "manual_cli",
      triggerReason: "fts_repair",
    };

    const input = buildSearchRebuildEnqueueInput(params);

    expect(input.max_attempts).toBe(JOB_MAX_ATTEMPTS["search.rebuild"]);
    expect(input.max_attempts).toBe(3);
  });

  it("payload includes version, scope, targetAgentId, triggerSource, triggerReason", () => {
    const params: SearchRebuildJobParams = {
      scope: "private",
      targetAgentId: "agent_123",
      triggerSource: "manual_cli",
      triggerReason: "fts_repair",
      requestedBy: "user_admin",
    };

    const input = buildSearchRebuildEnqueueInput(params);
    const payload = input.payload_json;

    expect(payload.version).toBe(1);
    expect(payload.scope).toBe("private");
    expect(payload.targetAgentId).toBe("agent_123");
    expect(payload.triggerSource).toBe("manual_cli");
    expect(payload.triggerReason).toBe("fts_repair");
    expect(payload.requestedBy).toBe("user_admin");
    expect(typeof payload.requestedAt).toBe("number");
  });

  it("payload targetAgentId is null for area scope", () => {
    const params: SearchRebuildJobParams = {
      scope: "area",
      targetAgentId: null,
      triggerSource: "manual_cli",
      triggerReason: "full_rebuild",
    };

    const input = buildSearchRebuildEnqueueInput(params);
    const payload = input.payload_json;

    expect(payload.scope).toBe("area");
    expect(payload.targetAgentId).toBeNull();
  });

  it("payload targetAgentId is null for world scope", () => {
    const params: SearchRebuildJobParams = {
      scope: "world",
      targetAgentId: null,
      triggerSource: "scheduled_maintenance",
      triggerReason: "backfill",
    };

    const input = buildSearchRebuildEnqueueInput(params);
    const payload = input.payload_json;

    expect(payload.scope).toBe("world");
    expect(payload.targetAgentId).toBeNull();
  });
});
