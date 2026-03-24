import { describe, expect, it } from "bun:test";
import {
  MEMORY_RELATION_TYPES,
  RELATION_DIRECTNESS_VALUES,
  RELATION_SOURCE_KINDS,
  type MemoryRelationType,
  type RelationDirectness,
  type RelationSourceKind,
  type MemoryRelationRecord,
} from "../types.js";

describe("MemoryRelationType named types", () => {
  it("MEMORY_RELATION_TYPES has exactly 9 values matching schema CHECK constraint", () => {
    const expectedTypes = ["supports", "triggered", "conflicts_with", "derived_from", "supersedes", "surfaced_as", "published_as", "resolved_by", "downgraded_by"] as const;
    
    expect(MEMORY_RELATION_TYPES).toHaveLength(9);
    expect(MEMORY_RELATION_TYPES).toEqual(expectedTypes);
    
    for (const t of expectedTypes) {
      expect(MEMORY_RELATION_TYPES).toContain(t);
    }
  });

  it("RELATION_DIRECTNESS_VALUES has exactly 3 values matching schema CHECK constraint", () => {
    // From schema.ts line 78: CHECK (directness IN ('direct', 'inferred', 'indirect'))
    const expectedDirectness = ["direct", "inferred", "indirect"] as const;
    
    expect(RELATION_DIRECTNESS_VALUES).toHaveLength(3);
    expect(RELATION_DIRECTNESS_VALUES).toEqual(expectedDirectness);
  });

  it("RELATION_SOURCE_KINDS has exactly 4 values matching schema CHECK constraint", () => {
    // From schema.ts line 78: CHECK (source_kind IN ('turn', 'job', 'agent_op', 'system'))
    const expectedSourceKinds = ["turn", "job", "agent_op", "system"] as const;
    
    expect(RELATION_SOURCE_KINDS).toHaveLength(4);
    expect(RELATION_SOURCE_KINDS).toEqual(expectedSourceKinds);
  });

  it("MemoryRelationType type accepts valid relation types", () => {
    const validTypes: MemoryRelationType[] = [
      "supports",
      "triggered", 
      "conflicts_with",
      "derived_from",
      "supersedes",
      "surfaced_as",
      "published_as",
      "resolved_by",
      "downgraded_by",
    ];
    
    for (const t of validTypes) {
      expect(MEMORY_RELATION_TYPES).toContain(t);
    }
  });

  it("RelationDirectness type accepts valid directness values", () => {
    const validDirectness: RelationDirectness[] = ["direct", "inferred", "indirect"];
    
    for (const d of validDirectness) {
      expect(RELATION_DIRECTNESS_VALUES).toContain(d);
    }
  });

  it("RelationSourceKind type accepts valid source kinds", () => {
    const validSourceKinds: RelationSourceKind[] = ["turn", "job", "agent_op", "system"];
    
    for (const s of validSourceKinds) {
      expect(RELATION_SOURCE_KINDS).toContain(s);
    }
  });

  it("MemoryRelationRecord interface has correct structure", () => {
    // Verify the interface exists and can be used
    const record: MemoryRelationRecord = {
      id: 1,
      source_node_ref: "assertion:123",
      target_node_ref: "assertion:456",
      relation_type: "conflicts_with",
      strength: 0.8,
      directness: "direct",
      source_kind: "agent_op",
      source_ref: "settlement-abc",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    
    expect(record.id).toBe(1);
    expect(record.relation_type).toBe("conflicts_with");
    expect(record.directness).toBe("direct");
    expect(record.source_kind).toBe("agent_op");
    expect(record.strength).toBe(0.8);
  });

  it("MemoryRelationRecord can have all relation types", () => {
    const allTypes: MemoryRelationType[] = [...MEMORY_RELATION_TYPES];
    
    for (const relationType of allTypes) {
      const record: MemoryRelationRecord = {
        id: 1,
        source_node_ref: "assertion:1",
        target_node_ref: "assertion:2",
        relation_type: relationType,
        strength: 0.5,
        directness: "inferred",
        source_kind: "system",
        source_ref: "test",
        created_at: 0,
        updated_at: 0,
      };
      
      expect(record.relation_type).toBe(relationType);
    }
  });
});
