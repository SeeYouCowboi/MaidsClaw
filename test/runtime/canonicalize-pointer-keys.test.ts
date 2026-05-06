import { describe, expect, it } from "bun:test";
import {
  canonicalizePointerKeysInCognitionOps,
  canonicalizePointerKeysInEpisodes,
} from "../../src/runtime/canonicalize-pointer-keys.js";
import type { CognitionOp } from "../../src/runtime/rp-turn-contract.js";
import {
  DEFAULT_ALIAS_SEEDS,
  backfillCanonicalAliases,
  type AliasSeed,
} from "../../src/migration/alias-backfill.js";
import type {
  AliasLifecycleCreate,
  AliasLifecycleStatus,
  AliasRepo,
} from "../../src/storage/domain-repos/contracts/alias-repo.js";
import type { EntityAlias } from "../../src/memory/types.js";

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

type FakeEntity = {
  id: number;
  pointer_key: string;
  memory_scope: string;
  owner_agent_id: string | null;
};

type FakeAliasRow = {
  id: number;
  canonical_id: number;
  alias: string;
  alias_type: string | null;
  owner_agent_id: string | null;
  status: "active" | "pending_review" | "conflicted" | "deprecated";
  conflict_group_key: string | null;
  source_kind: string | null;
  source_ref: string | null;
};

class InMemoryAliasRepo implements AliasRepo {
  readonly entities: FakeEntity[] = [];
  readonly aliases: FakeAliasRow[] = [];
  private nextEntityId = 1;
  private nextAliasId = 1;

  addEntity(pointerKey: string, scope = "shared_public", ownerAgentId: string | null = null): FakeEntity {
    const entity: FakeEntity = {
      id: this.nextEntityId++,
      pointer_key: pointerKey,
      memory_scope: scope,
      owner_agent_id: ownerAgentId,
    };
    this.entities.push(entity);
    return entity;
  }

  private normalizeAlias(alias: string): string {
    return alias.normalize("NFKC").trim();
  }

  async resolveAlias(alias: string, ownerAgentId?: string): Promise<number | null> {
    const lookup = this.normalizeAlias(alias);
    if (lookup.length === 0) return null;
    const ownerMatches = (row: FakeAliasRow) =>
      ownerAgentId !== undefined
        ? row.owner_agent_id === ownerAgentId
        : row.owner_agent_id === null;
    const match = this.aliases.find(
      (row) =>
        row.status === "active" &&
        ownerMatches(row) &&
        (row.alias === lookup || row.alias.toLowerCase() === lookup.toLowerCase()),
    );
    if (match) return match.canonical_id;
    if (ownerAgentId !== undefined) {
      const sharedMatch = this.aliases.find(
        (row) =>
          row.status === "active" &&
          row.owner_agent_id === null &&
          (row.alias === lookup || row.alias.toLowerCase() === lookup.toLowerCase()),
      );
      if (sharedMatch) return sharedMatch.canonical_id;
    }
    return null;
  }

  async resolveAliases(aliases: string[], ownerAgentId?: string): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    for (const a of aliases) out.set(a, await this.resolveAlias(a, ownerAgentId));
    return out;
  }

  async createAlias(canonicalId: number, alias: string, aliasType?: string, ownerAgentId?: string): Promise<number> {
    return this.createAliasWithLifecycle({ canonicalId, alias, aliasType, ownerAgentId, status: "active" });
  }

  async createAliasWithLifecycle(params: AliasLifecycleCreate): Promise<number> {
    const lookup = this.normalizeAlias(params.alias);
    const existingActive = this.aliases.find(
      (row) =>
        row.status === "active" &&
        row.owner_agent_id === (params.ownerAgentId ?? null) &&
        (row.alias === lookup || row.alias.toLowerCase() === lookup.toLowerCase()),
    );
    if (existingActive && existingActive.canonical_id === params.canonicalId && (params.status ?? "active") === "active") {
      return existingActive.id;
    }
    const hasConflict = existingActive && existingActive.canonical_id !== params.canonicalId;
    const status = hasConflict ? "conflicted" : (params.status ?? "active");
    const row: FakeAliasRow = {
      id: this.nextAliasId++,
      canonical_id: params.canonicalId,
      alias: params.alias,
      alias_type: params.aliasType ?? null,
      owner_agent_id: params.ownerAgentId ?? null,
      status,
      conflict_group_key: hasConflict ? `${lookup.toLowerCase()}:${params.ownerAgentId ?? "__shared__"}` : null,
      source_kind: params.sourceKind ?? null,
      source_ref: params.sourceRef ?? null,
    };
    this.aliases.push(row);
    return row.id;
  }

  async getAliasLifecycleStatus(alias: string, ownerAgentId?: string): Promise<AliasLifecycleStatus | null> {
    const lookup = this.normalizeAlias(alias);
    const ownerMatches = (row: FakeAliasRow) =>
      ownerAgentId !== undefined ? row.owner_agent_id === ownerAgentId : row.owner_agent_id === null;
    const matches = this.aliases.filter(
      (row) =>
        ownerMatches(row) &&
        (row.alias === lookup || row.alias.toLowerCase() === lookup.toLowerCase()),
    );
    if (matches.length === 0) return null;
    const order: Record<FakeAliasRow["status"], number> = {
      active: 0,
      conflicted: 1,
      pending_review: 2,
      deprecated: 3,
    };
    matches.sort((a, b) => order[a.status] - order[b.status] || b.id - a.id);
    const r = matches[0];
    return {
      id: r.id,
      canonicalId: r.canonical_id,
      alias: r.alias,
      aliasType: r.alias_type,
      ownerAgentId: r.owner_agent_id,
      status: r.status,
      conflictGroupKey: r.conflict_group_key,
      reviewReason: null,
      reviewedBy: null,
      reviewedAt: null,
      sourceKind: r.source_kind,
      sourceRef: r.source_ref,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  async getAliasesForEntity(canonicalId: number, _ownerAgentId?: string): Promise<EntityAlias[]> {
    return this.aliases
      .filter((r) => r.canonical_id === canonicalId)
      .map((r) => ({
        id: r.id,
        canonical_id: r.canonical_id,
        alias: r.alias,
        alias_type: r.alias_type,
        owner_agent_id: r.owner_agent_id,
      }));
  }

  async findEntityById(id: number): Promise<FakeEntity | null> {
    return this.entities.find((e) => e.id === id) ?? null;
  }

  async findEntityByPointerKey(
    pointerKey: string,
    scope: string,
    ownerAgentId?: string,
  ): Promise<FakeEntity | null> {
    return (
      this.entities.find(
        (e) =>
          e.pointer_key === pointerKey &&
          e.memory_scope === scope &&
          (scope !== "private_overlay" || e.owner_agent_id === (ownerAgentId ?? null)),
      ) ?? null
    );
  }

  async listSharedAliasStrings(): Promise<string[]> {
    return Array.from(
      new Set(
        this.aliases
          .filter((r) => r.owner_agent_id === null && r.status === "active")
          .map((r) => r.alias),
      ),
    );
  }

  async listPrivateAliasStrings(agentId: string): Promise<string[]> {
    return Array.from(
      new Set(
        this.aliases
          .filter((r) => r.owner_agent_id === agentId && r.status === "active")
          .map((r) => r.alias),
      ),
    );
  }
}

describe("alias backfill + canonicalization (flower garden, steward, watches)", () => {
  function seedWorld(): InMemoryAliasRepo {
    const repo = new InMemoryAliasRepo();
    repo.addEntity("loc:花房");
    repo.addEntity("char:管家");
    repo.addEntity("loc:茶室");
    repo.addEntity("item:银怀表");
    repo.addEntity("item:金怀表");
    return repo;
  }

  it("backfills the default seed set when all targets exist", async () => {
    const repo = seedWorld();
    const result = await backfillCanonicalAliases(repo);

    expect(result.missingTargets).toEqual([]);
    expect(result.conflicted).toEqual([]);
    expect(result.activated.length).toBe(DEFAULT_ALIAS_SEEDS.length);
  });

  it("is idempotent: running backfill twice produces no duplicate active rows", async () => {
    const repo = seedWorld();
    await backfillCanonicalAliases(repo);
    const aliasCountAfterFirst = repo.aliases.length;
    await backfillCanonicalAliases(repo);
    expect(repo.aliases.length).toBe(aliasCountAfterFirst);

    const groups = new Map<string, number>();
    for (const row of repo.aliases) {
      if (row.status !== "active") continue;
      const k = `${row.alias.toLowerCase()}|${row.owner_agent_id ?? "__shared__"}`;
      groups.set(k, (groups.get(k) ?? 0) + 1);
    }
    for (const [, count] of groups) {
      expect(count).toBe(1);
    }
  });

  it("flower-garden surface forms all canonicalize to loc:花房", async () => {
    const repo = seedWorld();
    await backfillCanonicalAliases(repo);

    const ops: CognitionOp[] = [
      {
        op: "upsert",
        record: {
          kind: "assertion",
          key: "alice/location",
          holderId: { kind: "pointer_key", value: "flower_garden" },
          claim: "stays_in",
          entityRefs: [
            { kind: "pointer_key", value: "loc:flower_garden" },
            { kind: "pointer_key", value: "花房" },
            { kind: "pointer_key", value: "flower_garden" },
            { kind: "special", value: "user" },
          ],
          stance: "accepted",
        },
      },
    ];

    const rewritten = await canonicalizePointerKeysInCognitionOps({
      ops,
      agentId: "rp:alice",
      aliasRepo: repo,
    });

    const assertion = rewritten[0];
    if (assertion.op !== "upsert" || assertion.record.kind !== "assertion") {
      throw new Error("expected assertion");
    }
    expect(assertion.record.holderId).toEqual({ kind: "pointer_key", value: "loc:花房" });
    expect(assertion.record.entityRefs).toEqual([
      { kind: "pointer_key", value: "loc:花房" },
      { kind: "special", value: "user" },
    ]);
  });

  it("gold and silver pocket watches remain DISTINCT canonical entities", async () => {
    const repo = seedWorld();
    await backfillCanonicalAliases(repo);

    const silverId = await repo.resolveAlias("silver_pocket_watch");
    const silverIdAlt = await repo.resolveAlias("银怀表");
    const silverIdLoc = await repo.resolveAlias("item:silver_pocket_watch");
    const goldId = await repo.resolveAlias("金怀表");

    expect(silverId).not.toBeNull();
    expect(goldId).not.toBeNull();
    expect(silverId).toBe(silverIdAlt!);
    expect(silverId).toBe(silverIdLoc!);
    expect(silverId).not.toBe(goldId!);

    const silverEntity = await repo.findEntityById(silverId!);
    const goldEntity = await repo.findEntityById(goldId!);
    expect(silverEntity?.pointer_key).toBe("item:银怀表");
    expect(goldEntity?.pointer_key).toBe("item:金怀表");

    const ops: CognitionOp[] = [
      {
        op: "upsert",
        record: {
          kind: "assertion",
          key: "alice/inventory",
          holderId: { kind: "special", value: "user" },
          claim: "owns",
          entityRefs: [
            { kind: "pointer_key", value: "silver_pocket_watch" },
            { kind: "pointer_key", value: "金怀表" },
          ],
          stance: "accepted",
        },
      },
    ];
    const rewritten = await canonicalizePointerKeysInCognitionOps({
      ops,
      agentId: "rp:alice",
      aliasRepo: repo,
    });
    const a = rewritten[0];
    if (a.op !== "upsert" || a.record.kind !== "assertion") throw new Error("expected assertion");
    const refValues = a.record.entityRefs.map((r) => r.value);
    expect(refValues).toContain("item:银怀表");
    expect(refValues).toContain("item:金怀表");
    expect(new Set(refValues).size).toBe(2);
  });

  it("steward (管家) aliases canonicalize to char:管家", async () => {
    const repo = seedWorld();
    await backfillCanonicalAliases(repo);

    const id1 = await repo.resolveAlias("管家");
    const id2 = await repo.resolveAlias("char:管家");
    expect(id1).not.toBeNull();
    expect(id1).toBe(id2!);
  });

  it("missing canonical target is reported and NOT inserted (no invented entity)", async () => {
    const repo = new InMemoryAliasRepo();
    repo.addEntity("loc:花房");

    const seeds: AliasSeed[] = [
      { alias: "花房", canonicalPointerKey: "loc:花房", aliasType: "loc" },
      { alias: "ghost_alias", canonicalPointerKey: "loc:does_not_exist", aliasType: "loc" },
    ];
    const result = await backfillCanonicalAliases(repo, seeds);

    expect(result.activated.map((s) => s.alias)).toEqual(["花房"]);
    expect(result.missingTargets.map((s) => s.alias)).toEqual(["ghost_alias"]);
    expect(repo.entities.length).toBe(1);
    expect(await repo.resolveAlias("ghost_alias")).toBeNull();
  });

  it("conflict path: re-seeding an alias to a different canonical entity preserves the original active mapping", async () => {
    const repo = seedWorld();
    await backfillCanonicalAliases(repo);

    const goldId = (await repo.resolveAlias("金怀表"))!;
    const silverEntity = repo.entities.find((e) => e.pointer_key === "item:银怀表")!;

    await repo.createAliasWithLifecycle({
      canonicalId: silverEntity.id,
      alias: "金怀表",
      aliasType: "item",
      status: "active",
    });

    const stillResolvedId = await repo.resolveAlias("金怀表");
    expect(stillResolvedId).toBe(goldId);

    const conflictedRows = repo.aliases.filter(
      (r) => r.alias === "金怀表" && r.status === "conflicted",
    );
    expect(conflictedRows.length).toBeGreaterThanOrEqual(1);
  });
});
