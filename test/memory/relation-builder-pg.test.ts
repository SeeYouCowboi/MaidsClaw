import { describe, expect, it } from "bun:test";
import type { CognitionEventRow } from "../../src/memory/cognition/cognition-event-repo.js";
import type { CognitionCurrentRow } from "../../src/memory/cognition/private-cognition-current.js";
import { CONFLICTS_WITH, RelationBuilder } from "../../src/memory/cognition/relation-builder.js";
import type { RelationReadRepo } from "../../src/storage/domain-repos/contracts/relation-read-repo.js";
import type {
  MemoryRelationRow,
  RelationWriteRepo,
  UpsertRelationParams,
} from "../../src/storage/domain-repos/contracts/relation-write-repo.js";
import type { CognitionProjectionRepo } from "../../src/storage/domain-repos/contracts/cognition-projection-repo.js";

class MockRelationWriteRepo implements RelationWriteRepo {
  public readonly upsertCalls: UpsertRelationParams[] = [];
  public relationsBySource: MemoryRelationRow[] = [];
  public relationsForNode: MemoryRelationRow[] = [];

  async upsertRelation(params: UpsertRelationParams): Promise<void> {
    this.upsertCalls.push(params);
  }

  async getRelationsBySource(sourceNodeRef: string): Promise<MemoryRelationRow[]> {
    return this.relationsBySource.filter((row) => row.source_node_ref === sourceNodeRef);
  }

  async getRelationsForNode(nodeRef: string): Promise<MemoryRelationRow[]> {
    return this.relationsForNode.filter((row) => row.source_node_ref === nodeRef || row.target_node_ref === nodeRef);
  }
}

class MockRelationReadRepo implements RelationReadRepo {
  public readonly sourceAgentByNodeRef = new Map<string, string | null>();
  public readonly canonicalByKey = new Map<string, string | null>();

  async getConflictEvidence(): Promise<never[]> {
    return [];
  }

  async getConflictHistory(): Promise<never[]> {
    return [];
  }

  async resolveSourceAgentId(sourceNodeRef: string): Promise<string | null> {
    return this.sourceAgentByNodeRef.get(sourceNodeRef) ?? null;
  }

  async resolveCanonicalCognitionRefByKey(cognitionKey: string, sourceAgentId: string | null): Promise<string | null> {
    return this.canonicalByKey.get(`${sourceAgentId ?? "none"}::${cognitionKey}`) ?? null;
  }
}

class ThrowingCognitionProjectionRepo implements CognitionProjectionRepo {
  async upsertFromEvent(_event: CognitionEventRow): Promise<void> {}
  async rebuild(_agentId: string): Promise<void> {}
  async getCurrent(): Promise<CognitionCurrentRow | null> {
    throw new Error("cognitionProjectionRepo.getCurrent must not be used by RelationBuilder");
  }
  async getAllCurrent(): Promise<CognitionCurrentRow[]> {
    return [];
  }
  async updateConflictFactors(): Promise<void> {}
  async patchRecordJsonSourceEventRef(): Promise<void> {}
  async resolveEntityByPointerKey(): Promise<number | null> {
    return null;
  }
}

function relationRow(overrides: Partial<MemoryRelationRow>): MemoryRelationRow {
  return {
    source_node_ref: "assertion:1",
    target_node_ref: "assertion:2",
    relation_type: "conflicts_with",
    source_kind: "agent_op",
    source_ref: "settlement-1",
    strength: 0.8,
    directness: "direct",
    created_at: 100,
    updated_at: 100,
    ...overrides,
  };
}

describe("RelationBuilder (PG repos, unit)", () => {
  it("writeContestRelations uses PG repos and upserts canonical non-self targets", async () => {
    const relationWriteRepo = new MockRelationWriteRepo();
    const relationReadRepo = new MockRelationReadRepo();
    const cognitionProjectionRepo = new ThrowingCognitionProjectionRepo();

    relationReadRepo.sourceAgentByNodeRef.set("assertion:10", "agent-1");
    relationReadRepo.canonicalByKey.set("agent-1::factor:a", "assertion:21");

    const builder = new RelationBuilder({
      relationWriteRepo,
      relationReadRepo,
      cognitionProjectionRepo,
    });

    await builder.writeContestRelations(
      "assertion:10",
      [
        "cognition_key:factor:a",
        "evaluation:31",
        "assertion:10",
        "cognition_key:factor:a",
        "invalid-ref",
      ],
      "settlement-xyz",
      0.91,
    );

    expect(relationWriteRepo.upsertCalls).toHaveLength(2);
    const targets = relationWriteRepo.upsertCalls.map((call) => call.targetNodeRef).sort();
    expect(targets).toEqual(["assertion:21", "evaluation:31"]);

    for (const call of relationWriteRepo.upsertCalls) {
      expect(call.relationType).toBe(CONFLICTS_WITH);
      expect(call.sourceNodeRef).toBe("assertion:10");
      expect(call.sourceRef).toBe("settlement-xyz");
      expect(call.sourceKind).toBe("agent_op");
      expect(call.directness).toBe("direct");
      expect(call.strength).toBe(0.91);
      expect(typeof call.createdAt).toBe("number");
      expect(call.updatedAt).toBe(call.createdAt);
    }
  });

  it("getConflictEvidence reads from relationWriteRepo.getRelationsBySource and normalizes targets", async () => {
    const relationWriteRepo = new MockRelationWriteRepo();
    const relationReadRepo = new MockRelationReadRepo();

    relationReadRepo.sourceAgentByNodeRef.set("assertion:1", "agent-1");
    relationReadRepo.canonicalByKey.set("agent-1::factor:good", "assertion:88");
    relationReadRepo.canonicalByKey.set("agent-1::factor:bad", null);

    relationWriteRepo.relationsBySource = [
      relationRow({ source_node_ref: "assertion:1", target_node_ref: "cognition_key:factor:good", strength: 0.9 }),
      relationRow({ source_node_ref: "assertion:1", target_node_ref: "cognition_key:factor:bad", strength: 0.8 }),
      relationRow({ source_node_ref: "assertion:1", target_node_ref: "evaluation:3", strength: 0.7 }),
    ];

    const builder = new RelationBuilder({
      relationWriteRepo,
      relationReadRepo,
      cognitionProjectionRepo: new ThrowingCognitionProjectionRepo(),
    });

    const evidence = await builder.getConflictEvidence("assertion:1", 2);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toEqual({
      targetRef: "assertion:88",
      strength: 0.9,
      sourceKind: "agent_op",
      sourceRef: "settlement-1",
      createdAt: 100,
    });
  });

  it("getConflictHistory reads via relationWriteRepo.getRelationsForNode and returns ASC limited chain entries", async () => {
    const relationWriteRepo = new MockRelationWriteRepo();
    relationWriteRepo.relationsForNode = [
      relationRow({ relation_type: "resolved_by", source_node_ref: "assertion:1", target_node_ref: "assertion:9", created_at: 30 }),
      relationRow({ relation_type: "conflicts_with", source_node_ref: "assertion:1", target_node_ref: "assertion:7", created_at: 10 }),
      relationRow({ relation_type: "downgraded_by", source_node_ref: "assertion:3", target_node_ref: "assertion:1", created_at: 20 }),
    ];

    const builder = new RelationBuilder({
      relationWriteRepo,
      relationReadRepo: new MockRelationReadRepo(),
      cognitionProjectionRepo: new ThrowingCognitionProjectionRepo(),
    });

    const history = await builder.getConflictHistory("assertion:1", 2);
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.relation_type)).toEqual(["conflicts_with", "downgraded_by"]);
    expect(history.map((entry) => entry.created_at)).toEqual([10, 20]);
  });
});
