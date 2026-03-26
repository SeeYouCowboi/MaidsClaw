import { Database } from "bun:sqlite";
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
import { createMemorySchema } from "../schema.js";
import { RelationBuilder } from "./relation-builder.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  createMemorySchema(db);
  return db;
}

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

describe("RelationBuilder.writeRelation — DB round-trip", () => {
  function readRelation(db: Database, sourceNodeRef: string, relationType: string) {
    return db
      .prepare(
        `SELECT source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref
         FROM memory_relations
         WHERE source_node_ref = ? AND relation_type = ?`,
      )
      .get(sourceNodeRef, relationType) as {
      source_node_ref: string;
      target_node_ref: string;
      relation_type: string;
      strength: number;
      directness: string;
      source_kind: string;
      source_ref: string;
    } | null;
  }

  it("writes a surfaced_as relation and reads it back", () => {
    const db = freshDb();
    const builder = new RelationBuilder(db);

    builder.writeRelation("surfaced_as", "assertion:10", "event:20", "settlement-1");

    const row = readRelation(db, "assertion:10", "surfaced_as");
    expect(row).not.toBeNull();
    expect(row!.target_node_ref).toBe("event:20");
    expect(row!.relation_type).toBe("surfaced_as");
    expect(row!.strength).toBe(0.8);
    expect(row!.directness).toBe("direct");
    expect(row!.source_kind).toBe("agent_op");
    expect(row!.source_ref).toBe("settlement-1");
  });

  it("writes a resolved_by relation and reads it back", () => {
    const db = freshDb();
    const builder = new RelationBuilder(db);

    builder.writeRelation("resolved_by", "assertion:30", "assertion:40", "resolution-5", {
      strength: 0.95,
      directness: "inferred",
      sourceKind: "system",
    });

    const row = readRelation(db, "assertion:30", "resolved_by");
    expect(row).not.toBeNull();
    expect(row!.target_node_ref).toBe("assertion:40");
    expect(row!.relation_type).toBe("resolved_by");
    expect(row!.strength).toBe(0.95);
    expect(row!.directness).toBe("inferred");
    expect(row!.source_kind).toBe("system");
    expect(row!.source_ref).toBe("resolution-5");
  });

  it("writes a downgraded_by relation and reads it back", () => {
    const db = freshDb();
    const builder = new RelationBuilder(db);

    builder.writeRelation("downgraded_by", "assertion:50", "evaluation:60", "op-77", {
      strength: 0.6,
    });

    const row = readRelation(db, "assertion:50", "downgraded_by");
    expect(row).not.toBeNull();
    expect(row!.target_node_ref).toBe("evaluation:60");
    expect(row!.relation_type).toBe("downgraded_by");
    expect(row!.strength).toBe(0.6);
    expect(row!.directness).toBe("direct");
    expect(row!.source_kind).toBe("agent_op");
    expect(row!.source_ref).toBe("op-77");
  });

  it("writeRelation accepts all 9 MEMORY_RELATION_TYPES via DB roundtrip", () => {
    const db = freshDb();
    const builder = new RelationBuilder(db);

    for (const relationType of MEMORY_RELATION_TYPES) {
      const source = `assertion:${MEMORY_RELATION_TYPES.indexOf(relationType) + 100}`;
      const target = `event:${MEMORY_RELATION_TYPES.indexOf(relationType) + 200}`;
      builder.writeRelation(relationType, source, target, `proof-${relationType}`);

      const row = readRelation(db, source, relationType);
      expect(row).not.toBeNull();
      expect(row!.relation_type).toBe(relationType);
      expect(row!.source_ref).toBe(`proof-${relationType}`);
    }

    const count = db.prepare("SELECT COUNT(*) as cnt FROM memory_relations").get() as { cnt: number };
    expect(count.cnt).toBe(MEMORY_RELATION_TYPES.length);
    db.close();
  });
});
