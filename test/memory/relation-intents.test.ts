import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelationIntent } from "../../src/runtime/rp-turn-contract.js";
import { CognitionRepository } from "../../src/memory/cognition/cognition-repo.js";
import { RelationBuilder } from "../../src/memory/cognition/relation-builder.js";
import {
  materializeRelationIntents,
  resolveConflictFactors,
  resolveLocalRefs,
  validateRelationIntents,
  type SettledArtifacts,
} from "../../src/memory/cognition/relation-intent-resolver.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { openDatabase } from "../../src/storage/database.js";

function createTempDb() {
  const dbPath = join(tmpdir(), `maidsclaw-relation-intents-${randomUUID()}.db`);
  const db = openDatabase({ path: dbPath });
  return { dbPath, db };
}

function cleanupDb(dbPath: string): void {
  try {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  } catch {
  }
}

function seedEntities(storage: GraphStorageService): void {
  storage.upsertEntity({
    pointerKey: "__self__",
    displayName: "Alice",
    entityType: "person",
    memoryScope: "shared_public",
  });
  storage.upsertEntity({
    pointerKey: "target:bob",
    displayName: "Bob",
    entityType: "person",
    memoryScope: "shared_public",
  });
}

describe("relation-intent resolver", () => {
  it("resolves localRef and materializes supports/triggered relations", () => {
    const { dbPath, db } = createTempDb();
    runMemoryMigrations(db);
    const storage = new GraphStorageService(db);
    seedEntities(storage);
    const repo = new CognitionRepository(db);

    const assertion = repo.upsertAssertion({
      agentId: "rp:alice",
      cognitionKey: "cog:assert-1",
      settlementId: "stl:ri-1",
      opIndex: 0,
      sourcePointerKey: "__self__",
      predicate: "trusts",
      targetPointerKey: "target:bob",
      stance: "accepted",
    });

    const commitment = repo.upsertCommitment({
      agentId: "rp:alice",
      cognitionKey: "cog:commit-1",
      settlementId: "stl:ri-1",
      opIndex: 1,
      mode: "goal",
      target: { action: "protect" },
      status: "active",
    });

    const now = Date.now();
    db.run(
      `INSERT INTO private_episode_events
        (agent_id, session_id, settlement_id, category, summary, committed_time, source_local_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["rp:alice", "session-1", "stl:ri-1", "observation", "noticed contradiction", now, "ep:1", now],
    );

    const settledArtifacts: SettledArtifacts = {
      settlementId: "stl:ri-1",
      agentId: "rp:alice",
      localRefIndex: new Map([["ep:1", { kind: "episode", nodeRef: "private_episode:1" }]]),
      cognitionByKey: new Map([
        ["cog:assert-1", { kind: "assertion", nodeRef: `assertion:${assertion.id}` }],
        ["cog:commit-1", { kind: "commitment", nodeRef: `commitment:${commitment.id}` }],
      ]),
    };

    const intents: RelationIntent[] = [
      { sourceRef: "ep:1", targetRef: "cog:assert-1", intent: "supports" },
      { sourceRef: "ep:1", targetRef: "cog:commit-1", intent: "triggered" },
    ];

    const resolvedRefs = resolveLocalRefs({ relationIntents: intents }, settledArtifacts);
    validateRelationIntents(intents, resolvedRefs);
    const written = materializeRelationIntents(intents, resolvedRefs, db);
    expect(written).toBe(2);

    const rows = db.query<{ relation_type: string; source_node_ref: string; target_node_ref: string }>(
      `SELECT relation_type, source_node_ref, target_node_ref FROM memory_relations ORDER BY relation_type ASC`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].relation_type).toBe("supports");
    expect(rows[1].relation_type).toBe("triggered");
    expect(rows[0].source_node_ref).toBe("private_episode:1");

    db.close();
    cleanupDb(dbPath);
  });

  it("hard-fails for illegal relation type, bad localRef, and bad cognitionKey", () => {
    const { dbPath, db } = createTempDb();
    runMemoryMigrations(db);

    const settledArtifacts: SettledArtifacts = {
      settlementId: "stl:ri-hard",
      agentId: "rp:alice",
      localRefIndex: new Map([["ep:ok", { kind: "episode", nodeRef: "private_episode:1" }]]),
      cognitionByKey: new Map([["cog:ok", { kind: "evaluation", nodeRef: "evaluation:9" }]]),
    };

    const resolved = resolveLocalRefs(
      {
        relationIntents: [
          { sourceRef: "ep:missing", targetRef: "cog:ok", intent: "supports" },
        ],
      },
      settledArtifacts,
    );

    expect(() =>
      validateRelationIntents(
        [{ sourceRef: "ep:missing", targetRef: "cog:ok", intent: "supports" }],
        resolved,
      ),
    ).toThrow();

    expect(() =>
      validateRelationIntents(
        [{ sourceRef: "ep:ok", targetRef: "cog:ok", intent: "supersedes" as "supports" }],
        resolved,
      ),
    ).toThrow();

    expect(() =>
      validateRelationIntents(
        [{ sourceRef: "ep:ok", targetRef: "cog:missing", intent: "triggered" }],
        resolved,
      ),
    ).toThrow();

    db.close();
    cleanupDb(dbPath);
  });

  it("soft-fails unresolvable conflictFactors while keeping resolvable factors", () => {
    const { dbPath, db } = createTempDb();
    runMemoryMigrations(db);
    const storage = new GraphStorageService(db);
    seedEntities(storage);
    const repo = new CognitionRepository(db);

    const assertion = repo.upsertAssertion({
      agentId: "rp:alice",
      cognitionKey: "cog:factor-assert",
      settlementId: "stl:ri-soft",
      opIndex: 0,
      sourcePointerKey: "__self__",
      predicate: "trusts",
      targetPointerKey: "target:bob",
      stance: "contested",
      preContestedStance: "accepted",
    });

    const commitment = repo.upsertCommitment({
      agentId: "rp:alice",
      cognitionKey: "cog:factor-commit",
      settlementId: "stl:ri-soft",
      opIndex: 1,
      mode: "goal",
      target: { action: "observe" },
      status: "active",
    });

    const result = resolveConflictFactors(
      [
        { kind: "cognition", ref: "cog:factor-commit" },
        { kind: "cognition", ref: "cog:not-found" },
      ],
      db,
      { settlementId: "stl:ri-soft", agentId: "rp:alice" },
    );

    expect(result.resolved).toHaveLength(1);
    expect(result.unresolved).toHaveLength(1);
		expect(result.resolved[0].nodeRef).toBe(`commitment:${commitment.id}`);

    const builder = new RelationBuilder(db);
    builder.writeContestRelations(`assertion:${assertion.id}`, result.resolved.map((item) => item.nodeRef), "stl:ri-soft");

    const relationRows = db.query<{ target_node_ref: string; relation_type: string }>(
      `SELECT target_node_ref, relation_type FROM memory_relations WHERE source_ref = 'stl:ri-soft'`,
    );
    expect(relationRows.length).toBeGreaterThanOrEqual(1);
    expect(relationRows.every((row) => row.relation_type === "conflicts_with")).toBe(true);
		expect(relationRows.some((row) => row.target_node_ref === `commitment:${commitment.id}`)).toBe(true);

    db.close();
    cleanupDb(dbPath);
  });
});
