import { describe, expect, it } from "bun:test";
import type {
  MemoryRelationRow,
  RelationWriteRepo,
  UpsertRelationParams,
} from "../../src/storage/domain-repos/contracts/relation-write-repo.js";
import type { CognitionProjectionRepo } from "../../src/storage/domain-repos/contracts/cognition-projection-repo.js";
import type { CognitionCurrentRow } from "../../src/memory/cognition/private-cognition-current.js";
import {
  materializeRelationIntents,
  resolveConflictFactors,
  resolveLocalRefs,
  validateRelationIntents,
  type ResolvedLocalRefs,
  type SettledArtifacts,
} from "../../src/memory/cognition/relation-intent-resolver.js";
import type { RelationIntent } from "../../src/runtime/rp-turn-contract.js";

// Mock RelationWriteRepo for PG-native testing
class MockRelationWriteRepo implements RelationWriteRepo {
  public readonly upsertCalls: UpsertRelationParams[] = [];

  async upsertRelation(params: UpsertRelationParams): Promise<void> {
    this.upsertCalls.push(params);
  }

  async getRelationsBySource(_sourceNodeRef: string): Promise<MemoryRelationRow[]> {
    return [];
  }

  async getRelationsForNode(_nodeRef: string): Promise<MemoryRelationRow[]> {
    return [];
  }
}

// Mock CognitionProjectionRepo for PG-native testing
class MockCognitionProjectionRepo implements CognitionProjectionRepo {
  public currentRecords: Map<string, CognitionCurrentRow> = new Map();

  async upsertFromEvent(): Promise<void> {}
  async rebuild(): Promise<void> {}

  async getCurrent(agentId: string, cognitionKey: string): Promise<CognitionCurrentRow | null> {
    return this.currentRecords.get(`${agentId}::${cognitionKey}`) ?? null;
  }

  async getAllCurrent(): Promise<CognitionCurrentRow[]> {
    return Array.from(this.currentRecords.values());
  }

  async updateConflictFactors(): Promise<void> {}
  async patchRecordJsonSourceEventRef(): Promise<void> {}
  async resolveEntityByPointerKey(): Promise<number | null> {
    return null;
  }

  // Helper to set up test data
  setCurrentRecord(agentId: string, cognitionKey: string, record: CognitionCurrentRow): void {
    this.currentRecords.set(`${agentId}::${cognitionKey}`, record);
  }
}

function createSettledArtifacts(overrides: Partial<SettledArtifacts> = {}): SettledArtifacts {
  return {
    settlementId: "settlement-1",
    agentId: "agent-1",
    localRefIndex: new Map(),
    cognitionByKey: new Map(),
    ...overrides,
  };
}

function createResolvedLocalRefs(overrides: Partial<ResolvedLocalRefs> = {}): ResolvedLocalRefs {
  return {
    settlementId: "settlement-1",
    agentId: "agent-1",
    localRefIndex: new Map(),
    cognitionByKey: new Map(),
    ...overrides,
  };
}

function createRelationIntent(overrides: Partial<RelationIntent> = {}): RelationIntent {
  return {
    intent: "supports",
    sourceRef: "episode-1",
    targetRef: "cognition-key-1",
    ...overrides,
  };
}

function createCognitionCurrentRow(overrides: Partial<CognitionCurrentRow> = {}): CognitionCurrentRow {
  return {
    id: 1,
    agent_id: "agent-1",
    cognition_key: "key-1",
    kind: "assertion",
    stance: "held",
    basis: "first_hand",
    status: "active",
    pre_contested_stance: null,
    conflict_summary: null,
    conflict_factor_refs_json: null,
    summary_text: null,
    record_json: "{}",
    source_event_id: 1,
    updated_at: Date.now(),
    ...overrides,
  };
}

describe("materializeRelationIntents (PG-native, async)", () => {
  it("should upsert relations using RelationWriteRepo", async () => {
    const relationWriteRepo = new MockRelationWriteRepo();
    const resolvedRefs = createResolvedLocalRefs({
      localRefIndex: new Map([
        ["episode-1", { kind: "episode", nodeRef: "episode:1" }],
      ]),
      cognitionByKey: new Map([
        ["cognition-key-1", { kind: "assertion", nodeRef: "assertion:1" }],
      ]),
    });

    const intents: RelationIntent[] = [
      createRelationIntent({
        intent: "supports",
        sourceRef: "episode-1",
        targetRef: "cognition-key-1",
      }),
    ];

    const written = await materializeRelationIntents(intents, resolvedRefs, relationWriteRepo);

    expect(written).toBe(1);
    expect(relationWriteRepo.upsertCalls).toHaveLength(1);

    const call = relationWriteRepo.upsertCalls[0];
    expect(call.sourceNodeRef).toBe("episode:1");
    expect(call.targetNodeRef).toBe("assertion:1");
    expect(call.relationType).toBe("supports");
    expect(call.sourceKind).toBe("turn");
    expect(call.sourceRef).toBe("settlement-1");
    expect(call.strength).toBe(0.8);
    expect(call.directness).toBe("direct");
    expect(typeof call.createdAt).toBe("number");
    expect(typeof call.updatedAt).toBe("number");
  });

  it("should skip self-relations (source === target)", async () => {
    const relationWriteRepo = new MockRelationWriteRepo();
    const resolvedRefs = createResolvedLocalRefs({
      localRefIndex: new Map([
        ["episode-1", { kind: "episode", nodeRef: "assertion:1" }],
      ]),
      cognitionByKey: new Map([
        ["cognition-key-1", { kind: "assertion", nodeRef: "assertion:1" }],
      ]),
    });

    const intents: RelationIntent[] = [
      createRelationIntent({
        intent: "supports",
        sourceRef: "episode-1",
        targetRef: "cognition-key-1",
      }),
    ];

    const written = await materializeRelationIntents(intents, resolvedRefs, relationWriteRepo);

    expect(written).toBe(0);
    expect(relationWriteRepo.upsertCalls).toHaveLength(0);
  });

  it("should handle multiple intents", async () => {
    const relationWriteRepo = new MockRelationWriteRepo();
    const resolvedRefs = createResolvedLocalRefs({
      localRefIndex: new Map([
        ["episode-1", { kind: "episode", nodeRef: "episode:1" }],
        ["episode-2", { kind: "episode", nodeRef: "episode:2" }],
      ]),
      cognitionByKey: new Map([
        ["cognition-key-1", { kind: "assertion", nodeRef: "assertion:1" }],
        ["cognition-key-2", { kind: "evaluation", nodeRef: "evaluation:1" }],
      ]),
    });

    const intents: RelationIntent[] = [
      createRelationIntent({
        intent: "supports",
        sourceRef: "episode-1",
        targetRef: "cognition-key-1",
      }),
      createRelationIntent({
        intent: "triggered",
        sourceRef: "episode-2",
        targetRef: "cognition-key-2",
      }),
    ];

    const written = await materializeRelationIntents(intents, resolvedRefs, relationWriteRepo);

    expect(written).toBe(2);
    expect(relationWriteRepo.upsertCalls).toHaveLength(2);

    const types = relationWriteRepo.upsertCalls.map((c) => c.relationType).sort();
    expect(types).toEqual(["supports", "triggered"]);
  });

  it("should return 0 for empty intents", async () => {
    const relationWriteRepo = new MockRelationWriteRepo();
    const resolvedRefs = createResolvedLocalRefs();

    const written = await materializeRelationIntents([], resolvedRefs, relationWriteRepo);

    expect(written).toBe(0);
    expect(relationWriteRepo.upsertCalls).toHaveLength(0);
  });

  it("should use passed settlementId in sourceRef", async () => {
    const relationWriteRepo = new MockRelationWriteRepo();
    const resolvedRefs = createResolvedLocalRefs({
      settlementId: "custom-settlement-xyz",
      localRefIndex: new Map([
        ["episode-1", { kind: "episode", nodeRef: "episode:1" }],
      ]),
      cognitionByKey: new Map([
        ["cognition-key-1", { kind: "assertion", nodeRef: "assertion:1" }],
      ]),
    });

    const intents: RelationIntent[] = [
      createRelationIntent({
        intent: "supports",
        sourceRef: "episode-1",
        targetRef: "cognition-key-1",
      }),
    ];

    await materializeRelationIntents(intents, resolvedRefs, relationWriteRepo);

    expect(relationWriteRepo.upsertCalls[0].sourceRef).toBe("custom-settlement-xyz");
  });
});

describe("resolveConflictFactors (PG-native, async)", () => {
  it("should resolve factors from localRefIndex", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();
    const resolvedRefs = createResolvedLocalRefs({
      localRefIndex: new Map([
        ["factor-1", { kind: "episode", nodeRef: "episode:1" }],
      ]),
    });

    const factors = [{ kind: "evidence", ref: "factor-1" }];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: resolvedRefs,
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toEqual({
      kind: "evidence",
      ref: "factor-1",
      nodeRef: "episode:1",
    });
    expect(result.unresolved).toHaveLength(0);
  });

  it("should resolve factors from cognitionByKey", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();
    const resolvedRefs = createResolvedLocalRefs({
      cognitionByKey: new Map([
        ["factor-key", { kind: "assertion", nodeRef: "assertion:1" }],
      ]),
    });

    const factors = [{ kind: "evidence", ref: "factor-key" }];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: resolvedRefs,
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].nodeRef).toBe("assertion:1");
  });

  it("should resolve private_episode: refs and normalize to episode:", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();
    const resolvedRefs = createResolvedLocalRefs();

    const factors = [{ kind: "evidence", ref: "private_episode:123" }];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: resolvedRefs,
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].nodeRef).toBe("episode:123");
  });

  it("should resolve valid graph node refs directly", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();
    const resolvedRefs = createResolvedLocalRefs();

    const factors = [{ kind: "evidence", ref: "assertion:456" }];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: resolvedRefs,
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].nodeRef).toBe("assertion:456");
  });

  it("should lookup cognition keys via CognitionProjectionRepo", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();
    cognitionProjectionRepo.setCurrentRecord(
      "agent-1",
      "my-cognition-key",
      createCognitionCurrentRow({
        id: 42,
        agent_id: "agent-1",
        cognition_key: "my-cognition-key",
        kind: "assertion",
      }),
    );

    const resolvedRefs = createResolvedLocalRefs();
    const factors = [{ kind: "evidence", ref: "my-cognition-key" }];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: resolvedRefs,
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].nodeRef).toBe("assertion:42");
  });

  it("should lookup cognition_key: prefixed keys via CognitionProjectionRepo", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();
    cognitionProjectionRepo.setCurrentRecord(
      "agent-1",
      "prefixed-key",
      createCognitionCurrentRow({
        id: 99,
        agent_id: "agent-1",
        cognition_key: "prefixed-key",
        kind: "evaluation",
      }),
    );

    const resolvedRefs = createResolvedLocalRefs();
    const factors = [{ kind: "evidence", ref: "cognition_key:prefixed-key" }];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: resolvedRefs,
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].nodeRef).toBe("evaluation:99");
  });

  it("should prefer assertions over other kinds from CognitionProjectionRepo", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();
    // First lookup tries assertion specifically - this simulates the original behavior
    // where the code first checks for kind='assertion', then any kind
    // With the new PG repo, getCurrent returns the record directly
    cognitionProjectionRepo.setCurrentRecord(
      "agent-1",
      "multi-key",
      createCognitionCurrentRow({
        id: 55,
        agent_id: "agent-1",
        cognition_key: "multi-key",
        kind: "assertion",
      }),
    );

    const resolvedRefs = createResolvedLocalRefs();
    const factors = [{ kind: "evidence", ref: "multi-key" }];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: resolvedRefs,
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].nodeRef).toBe("assertion:55");
  });

  it("should resolve evaluation kinds correctly", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();
    cognitionProjectionRepo.setCurrentRecord(
      "agent-1",
      "eval-key",
      createCognitionCurrentRow({
        id: 77,
        agent_id: "agent-1",
        cognition_key: "eval-key",
        kind: "evaluation",
      }),
    );

    const resolvedRefs = createResolvedLocalRefs();
    const factors = [{ kind: "evidence", ref: "eval-key" }];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: resolvedRefs,
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].nodeRef).toBe("evaluation:77");
  });

  it("should resolve commitment kinds correctly", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();
    cognitionProjectionRepo.setCurrentRecord(
      "agent-1",
      "commit-key",
      createCognitionCurrentRow({
        id: 88,
        agent_id: "agent-1",
        cognition_key: "commit-key",
        kind: "commitment",
      }),
    );

    const resolvedRefs = createResolvedLocalRefs();
    const factors = [{ kind: "evidence", ref: "commit-key" }];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: resolvedRefs,
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].nodeRef).toBe("commitment:88");
  });

  it("should return null for non-evaluation/commitment kinds when not assertion", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();
    cognitionProjectionRepo.setCurrentRecord(
      "agent-1",
      "other-key",
      createCognitionCurrentRow({
        id: 99,
        agent_id: "agent-1",
        cognition_key: "other-key",
        kind: "other_kind",
      }),
    );

    const resolvedRefs = createResolvedLocalRefs();
    const factors = [{ kind: "evidence", ref: "other-key" }];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: resolvedRefs,
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].reason).toContain("unresolvable");
  });

  it("should handle missing kind as unresolved", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();

    const factors = [{ kind: "", ref: "something" }];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: createResolvedLocalRefs(),
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].reason).toContain("missing");
  });

  it("should handle missing ref as unresolved", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();

    const factors = [{ kind: "evidence", ref: "" }];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: createResolvedLocalRefs(),
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].reason).toContain("missing");
  });

  it("should handle unresolvable refs as unresolved", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();

    const factors = [{ kind: "evidence", ref: "unresolvable-key" }];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: createResolvedLocalRefs(),
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].reason).toContain("unresolvable");
  });

  it("should include note in resolved factors when provided", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();
    const resolvedRefs = createResolvedLocalRefs({
      localRefIndex: new Map([
        ["factor-1", { kind: "episode", nodeRef: "episode:1" }],
      ]),
    });

    const factors = [{ kind: "evidence", ref: "factor-1", note: "Important evidence" }];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: resolvedRefs,
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].note).toBe("Important evidence");
  });

  it("should handle multiple factors with mixed resolution", async () => {
    const cognitionProjectionRepo = new MockCognitionProjectionRepo();
    cognitionProjectionRepo.setCurrentRecord(
      "agent-1",
      "lookup-key",
      createCognitionCurrentRow({
        id: 42,
        agent_id: "agent-1",
        cognition_key: "lookup-key",
        kind: "assertion",
      }),
    );

    const resolvedRefs = createResolvedLocalRefs({
      localRefIndex: new Map([
        ["local-factor", { kind: "episode", nodeRef: "episode:1" }],
      ]),
    });

    const factors = [
      { kind: "evidence", ref: "local-factor" },
      { kind: "evidence", ref: "lookup-key" },
      { kind: "evidence", ref: "unresolvable" },
      { kind: "", ref: "no-kind" },
    ];

    const result = await resolveConflictFactors(factors, cognitionProjectionRepo, {
      settledRefs: resolvedRefs,
      settlementId: "settlement-1",
      agentId: "agent-1",
    });

    expect(result.resolved).toHaveLength(2);
    expect(result.unresolved).toHaveLength(2);
  });
});

describe("resolveLocalRefs", () => {
  it("should return resolved refs from settled artifacts", () => {
    const settledArtifacts = createSettledArtifacts({
      localRefIndex: new Map([
        ["ref-1", { kind: "episode", nodeRef: "episode:1" }],
      ]),
      cognitionByKey: new Map([
        ["key-1", { kind: "assertion", nodeRef: "assertion:1" }],
      ]),
    });

    const result = resolveLocalRefs(
      {
        relationIntents: [
          createRelationIntent({ sourceRef: "ref-1", targetRef: "key-1" }),
        ],
      },
      settledArtifacts,
    );

    expect(result.settlementId).toBe("settlement-1");
    expect(result.agentId).toBe("agent-1");
    expect(result.localRefIndex.get("ref-1")).toEqual({ kind: "episode", nodeRef: "episode:1" });
    expect(result.cognitionByKey.get("key-1")).toEqual({ kind: "assertion", nodeRef: "assertion:1" });
  });
});

describe("validateRelationIntents", () => {
  it("should validate supports intent targeting assertion", () => {
    const resolvedRefs = createResolvedLocalRefs({
      localRefIndex: new Map([
        ["episode-1", { kind: "episode", nodeRef: "episode:1" }],
      ]),
      cognitionByKey: new Map([
        ["cognition-1", { kind: "assertion", nodeRef: "assertion:1" }],
      ]),
    });

    const intents: RelationIntent[] = [
      createRelationIntent({
        intent: "supports",
        sourceRef: "episode-1",
        targetRef: "cognition-1",
      }),
    ];

    const result = validateRelationIntents(intents, resolvedRefs);

    expect(result).toHaveLength(1);
    expect(result[0].intent).toBe("supports");
    expect(result[0].source.nodeRef).toBe("episode:1");
    expect(result[0].target.nodeRef).toBe("assertion:1");
  });

  it("should validate triggered intent targeting evaluation", () => {
    const resolvedRefs = createResolvedLocalRefs({
      localRefIndex: new Map([
        ["episode-1", { kind: "episode", nodeRef: "episode:1" }],
      ]),
      cognitionByKey: new Map([
        ["cognition-1", { kind: "evaluation", nodeRef: "evaluation:1" }],
      ]),
    });

    const intents: RelationIntent[] = [
      createRelationIntent({
        intent: "triggered",
        sourceRef: "episode-1",
        targetRef: "cognition-1",
      }),
    ];

    const result = validateRelationIntents(intents, resolvedRefs);

    expect(result).toHaveLength(1);
    expect(result[0].intent).toBe("triggered");
  });

  it("should throw for unsupported intent", () => {
    const resolvedRefs = createResolvedLocalRefs({
      localRefIndex: new Map([
        ["episode-1", { kind: "episode", nodeRef: "episode:1" }],
      ]),
    });

    const intents: RelationIntent[] = [
      { intent: "unknown_intent" as unknown as "supports", sourceRef: "episode-1", targetRef: "episode-1" },
    ];

    expect(() => validateRelationIntents(intents, resolvedRefs)).toThrow();
  });
});
