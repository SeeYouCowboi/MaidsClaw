import { describe, expect, it } from "bun:test";
import {
  canonicalizePointerKeysInCognitionOps,
  canonicalizePointerKeysInEpisodes,
} from "../../src/runtime/canonicalize-pointer-keys.js";
import type { CognitionOp } from "../../src/runtime/rp-turn-contract.js";

type AliasEntry = {
  id: number;
  canonicalPointerKey: string;
};

function createAliasRepo(entries: Record<string, AliasEntry>) {
  const idToPointer = new Map<number, string>();
  for (const entry of Object.values(entries)) {
    idToPointer.set(entry.id, entry.canonicalPointerKey);
  }
  return {
    async resolveAlias(alias: string, _ownerAgentId?: string): Promise<number | null> {
      return entries[alias]?.id ?? null;
    },
    async findEntityById(id: number) {
      const pointerKey = idToPointer.get(id);
      if (!pointerKey) {
        return null;
      }
      return {
        id,
        pointer_key: pointerKey,
        memory_scope: "shared_public",
        owner_agent_id: null,
      };
    },
  };
}

describe("canonicalizePointerKeysInCognitionOps", () => {
  it("rewrites pointer_key refs when alias is known", async () => {
    const ops: CognitionOp[] = [
      {
        op: "upsert",
        record: {
          kind: "assertion",
          key: "alice/location",
          holderId: { kind: "pointer_key", value: "greenhouse" },
          claim: "stays_in",
          entityRefs: [
            { kind: "pointer_key", value: "greenhouse" },
            { kind: "special", value: "user" },
            { kind: "pointer_key", value: "greenhouse" },
          ],
          stance: "accepted",
        },
      },
      {
        op: "upsert",
        record: {
          kind: "evaluation",
          key: "trust/greenhouse",
          target: { kind: "pointer_key", value: "greenhouse" },
          dimensions: [{ name: "threat_level", value: 2 }],
        },
      },
      {
        op: "upsert",
        record: {
          kind: "commitment",
          key: "goal/visit",
          mode: "goal",
          target: {
            action: "visit",
            target: { kind: "pointer_key", value: "greenhouse" },
          },
          status: "active",
        },
      },
    ];

    const rewritten = await canonicalizePointerKeysInCognitionOps({
      ops,
      agentId: "rp:alice",
      aliasRepo: createAliasRepo({
        greenhouse: { id: 101, canonicalPointerKey: "花房" },
      }),
    });

    const assertion = rewritten[0];
    if (assertion.op !== "upsert" || assertion.record.kind !== "assertion") {
      throw new Error("expected assertion");
    }
    expect(assertion.record.holderId).toEqual({
      kind: "pointer_key",
      value: "花房",
    });
    expect(assertion.record.entityRefs).toEqual([
      { kind: "pointer_key", value: "花房" },
      { kind: "special", value: "user" },
    ]);

    const evaluation = rewritten[1];
    if (evaluation.op !== "upsert" || evaluation.record.kind !== "evaluation") {
      throw new Error("expected evaluation");
    }
    expect(evaluation.record.target).toEqual({
      kind: "pointer_key",
      value: "花房",
    });

    const commitment = rewritten[2];
    if (commitment.op !== "upsert" || commitment.record.kind !== "commitment") {
      throw new Error("expected commitment");
    }
    expect(commitment.record.target).toEqual({
      action: "visit",
      target: { kind: "pointer_key", value: "花房" },
    });
  });

  it("keeps refs unchanged when alias is unknown", async () => {
    const ops: CognitionOp[] = [
      {
        op: "upsert",
        record: {
          kind: "assertion",
          key: "alice/location",
          holderId: { kind: "pointer_key", value: "greenhouse" },
          claim: "stays_in",
          entityRefs: [{ kind: "pointer_key", value: "greenhouse" }],
          stance: "accepted",
        },
      },
    ];

    const rewritten = await canonicalizePointerKeysInCognitionOps({
      ops,
      agentId: "rp:alice",
      aliasRepo: createAliasRepo({}),
    });

    expect(rewritten).toEqual(ops);
  });

  it("does not modify retract ops", async () => {
    const ops: CognitionOp[] = [
      {
        op: "retract",
        target: {
          kind: "assertion",
          key: "alice/location",
        },
      },
    ];

    const rewritten = await canonicalizePointerKeysInCognitionOps({
      ops,
      agentId: "rp:alice",
      aliasRepo: createAliasRepo({
        greenhouse: { id: 101, canonicalPointerKey: "花房" },
      }),
    });

    expect(rewritten).toEqual(ops);
  });
});

describe("canonicalizePointerKeysInEpisodes", () => {
  it("rewrites episode entityRefs pointer_key values", async () => {
    const episodes = [
      {
        category: "observation" as const,
        summary: "Alice is in greenhouse",
        entityRefs: [
          { kind: "pointer_key" as const, value: "greenhouse" },
          { kind: "special" as const, value: "user" },
          { kind: "pointer_key" as const, value: "greenhouse" },
        ],
      },
    ];

    const rewritten = await canonicalizePointerKeysInEpisodes({
      episodes,
      agentId: "rp:alice",
      aliasRepo: createAliasRepo({
        greenhouse: { id: 101, canonicalPointerKey: "花房" },
      }),
    });

    expect(rewritten[0]?.entityRefs).toEqual([
      { kind: "pointer_key", value: "花房" },
      { kind: "special", value: "user" },
    ]);
  });
});
