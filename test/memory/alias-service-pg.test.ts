import { beforeEach, describe, expect, it } from "bun:test";
import type { AliasRepo } from "../../src/storage/domain-repos/contracts/alias-repo.js";
import type { EntityAlias } from "../../src/memory/types.js";
import { AliasService } from "../../src/memory/alias.js";

/**
 * Stub implementation of AliasRepo for testing AliasService.
 * Maintains in-memory state to simulate database operations.
 */
class StubAliasRepo implements AliasRepo {
  private aliases: Array<{
    id: number;
    canonical_id: number;
    alias: string;
    alias_type: string | null;
    owner_agent_id: string | null;
  }> = [];

  private entities: Array<{
    id: number;
    pointer_key: string;
    memory_scope: string;
    owner_agent_id: string | null;
  }> = [];

  private nextAliasId = 1;
  private nextEntityId = 1;

  async resolveAlias(alias: string, ownerAgentId?: string): Promise<number | null> {
    // 1. Try agent-specific alias
    if (ownerAgentId) {
      const agentAlias = this.aliases.find(
        a => a.alias === alias && a.owner_agent_id === ownerAgentId
      );
      if (agentAlias) return agentAlias.canonical_id;
    }

    // 2. Try shared alias
    const sharedAlias = this.aliases.find(
      a => a.alias === alias && a.owner_agent_id === null
    );
    if (sharedAlias) return sharedAlias.canonical_id;

    // 3. Try pointer_key (canonical entity name)
    if (ownerAgentId) {
      const privateEntity = this.entities.find(
        e => e.pointer_key === alias && e.memory_scope === "private_overlay" && e.owner_agent_id === ownerAgentId
      );
      if (privateEntity) return privateEntity.id;
    }

    const publicEntity = this.entities.find(
      e => e.pointer_key === alias && e.memory_scope === "shared_public"
    );
    if (publicEntity) return publicEntity.id;

    return null;
  }

  async resolveAliases(aliases: string[], ownerAgentId?: string): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    for (const alias of aliases) {
      result.set(alias, await this.resolveAlias(alias, ownerAgentId));
    }
    return result;
  }

  async createAlias(
    canonicalId: number,
    alias: string,
    aliasType?: string,
    ownerAgentId?: string
  ): Promise<number> {
    const existing = this.aliases.find(
      a =>
        a.canonical_id === canonicalId &&
        a.alias === alias &&
        ((a.alias_type === (aliasType ?? null)) || (a.alias_type === null && (aliasType ?? null) === null)) &&
        ((a.owner_agent_id === (ownerAgentId ?? null)) || (a.owner_agent_id === null && (ownerAgentId ?? null) === null))
    );
    if (existing) return existing.id;

    const id = this.nextAliasId++;
    this.aliases.push({
      id,
      canonical_id: canonicalId,
      alias,
      alias_type: aliasType ?? null,
      owner_agent_id: ownerAgentId ?? null,
    });
    return id;
  }

  async getAliasesForEntity(canonicalId: number, ownerAgentId?: string): Promise<EntityAlias[]> {
    return this.aliases.filter(
      a => a.canonical_id === canonicalId && (a.owner_agent_id === null || a.owner_agent_id === ownerAgentId)
    ).map(a => ({
      id: a.id,
      canonical_id: a.canonical_id,
      alias: a.alias,
      alias_type: a.alias_type,
      owner_agent_id: a.owner_agent_id,
    })) as EntityAlias[];
  }

  async findEntityById(id: number): Promise<{ id: number; pointer_key: string; memory_scope: string; owner_agent_id: string | null } | null> {
    const entity = this.entities.find(e => e.id === id);
    if (!entity) return null;
    return { ...entity };
  }

  async findEntityByPointerKey(
    pointerKey: string,
    scope: string,
    ownerAgentId?: string
  ): Promise<{ id: number; pointer_key: string; memory_scope: string; owner_agent_id: string | null } | null> {
    const entity = this.entities.find(e => {
      if (e.pointer_key !== pointerKey) return false;
      if (e.memory_scope !== scope) return false;
      if (scope === "private_overlay" && ownerAgentId) {
        return e.owner_agent_id === ownerAgentId;
      }
      return true;
    });
    if (!entity) return null;
    return { ...entity };
  }

  async listSharedAliasStrings(): Promise<string[]> {
    const seen = new Set<string>();
    for (const a of this.aliases) {
      if (a.owner_agent_id === null) seen.add(a.alias);
    }
    return [...seen];
  }

  async listPrivateAliasStrings(agentId: string): Promise<string[]> {
    const seen = new Set<string>();
    for (const a of this.aliases) {
      if (a.owner_agent_id === agentId) seen.add(a.alias);
    }
    return [...seen];
  }

  // Helper methods for test setup
  addEntity(pointerKey: string, memoryScope: string, ownerAgentId?: string): number {
    const id = this.nextEntityId++;
    this.entities.push({
      id,
      pointer_key: pointerKey,
      memory_scope: memoryScope,
      owner_agent_id: ownerAgentId ?? null,
    });
    return id;
  }
}

describe("AliasService with AliasRepo", () => {
  let repo: StubAliasRepo;
  let service: AliasService;

  beforeEach(() => {
    repo = new StubAliasRepo();
    service = new AliasService(repo);
  });

  describe("resolveAlias", () => {
    it("returns canonical_id for agent-specific alias", async () => {
      await repo.createAlias(100, "my-alias", "nickname", "agent-a");

      const result = await service.resolveAlias("my-alias", "agent-a");
      expect(result).toBe(100);
    });

    it("returns null when agent-specific alias belongs to different agent", async () => {
      await repo.createAlias(100, "my-alias", "nickname", "agent-a");

      const result = await service.resolveAlias("my-alias", "agent-b");
      expect(result).toBeNull();
    });

    it("returns canonical_id for shared alias (no owner)", async () => {
      await repo.createAlias(200, "shared-alias", "common", undefined);

      const result = await service.resolveAlias("shared-alias");
      expect(result).toBe(200);
    });

    it("returns canonical_id for shared alias with any agent", async () => {
      await repo.createAlias(200, "shared-alias", "common", undefined);

      const result = await service.resolveAlias("shared-alias", "agent-a");
      expect(result).toBe(200);
    });

    it("prefers agent-specific alias over shared alias", async () => {
      await repo.createAlias(300, "shared-alias", "common", undefined);
      await repo.createAlias(301, "shared-alias", "nickname", "agent-a");

      const result = await service.resolveAlias("shared-alias", "agent-a");
      expect(result).toBe(301);
    });

    it("returns entity id for private entity by pointer_key", async () => {
      const entityId = repo.addEntity("private-entity", "private_overlay", "agent-a");

      const result = await service.resolveAlias("private-entity", "agent-a");
      expect(result).toBe(entityId);
    });

    it("returns null for private entity when owner differs", async () => {
      repo.addEntity("private-entity", "private_overlay", "agent-a");

      const result = await service.resolveAlias("private-entity", "agent-b");
      expect(result).toBeNull();
    });

    it("returns entity id for public entity by pointer_key", async () => {
      const entityId = repo.addEntity("public-entity", "shared_public");

      const result = await service.resolveAlias("public-entity");
      expect(result).toBe(entityId);
    });

    it("returns null when alias not found anywhere", async () => {
      const result = await service.resolveAlias("nonexistent-alias");
      expect(result).toBeNull();
    });
  });

  describe("resolveAliases", () => {
    it("returns Map of aliases to entity IDs (bulk resolution)", async () => {
      await repo.createAlias(100, "alias-a", "common", undefined);
      await repo.createAlias(200, "alias-b", "common", undefined);

      const result = await service.resolveAliases(["alias-a", "alias-b", "alias-c"]);
      expect(result.get("alias-a")).toBe(100);
      expect(result.get("alias-b")).toBe(200);
      expect(result.get("alias-c")).toBeNull();
    });

    it("respects ownerAgentId for bulk resolution", async () => {
      await repo.createAlias(100, "alias-a", "common", "agent-a");

      const result = await service.resolveAliases(["alias-a"], "agent-b");
      expect(result.get("alias-a")).toBeNull();
    });
  });

  describe("createAlias", () => {
    it("creates a new alias and returns its id", async () => {
      const aliasId = await service.createAlias(100, "new-alias", "nickname", "agent-a");
      expect(typeof aliasId).toBe("number");
      expect(aliasId).toBeGreaterThan(0);

      const resolved = await service.resolveAlias("new-alias", "agent-a");
      expect(resolved).toBe(100);
    });

    it("returns existing alias id when duplicate detected", async () => {
      const aliasId1 = await service.createAlias(100, "existing-alias", "nickname", "agent-a");
      const aliasId2 = await service.createAlias(100, "existing-alias", "nickname", "agent-a");

      expect(aliasId1).toBe(aliasId2);
    });

    it("allows same alias for different canonical entities", async () => {
      const aliasId1 = await service.createAlias(100, "shared-name", "nickname", "agent-a");
      const aliasId2 = await service.createAlias(200, "shared-name", "nickname", "agent-a");

      expect(aliasId1).not.toBe(aliasId2);
    });

    it("allows same alias for different owners", async () => {
      const aliasId1 = await service.createAlias(100, "owner-specific", "nickname", "agent-a");
      const aliasId2 = await service.createAlias(100, "owner-specific", "nickname", "agent-b");

      expect(aliasId1).not.toBe(aliasId2);
    });

    it("handles null alias_type and owner_agent_id", async () => {
      const aliasId = await service.createAlias(100, "minimal-alias");
      expect(typeof aliasId).toBe("number");

      const resolved = await service.resolveAlias("minimal-alias");
      expect(resolved).toBe(100);
    });
  });

  describe("getAliasesForEntity", () => {
    it("returns only shared aliases when no ownerAgentId provided", async () => {
      await repo.createAlias(100, "shared-alias-1", "nickname", undefined);
      await repo.createAlias(100, "agent-alias-1", "acronym", "agent-a");
      await repo.createAlias(100, "agent-alias-2", "initials", "agent-b");

      const aliases = await service.getAliasesForEntity(100);
      expect(aliases.length).toBe(1);
      expect(aliases[0].alias).toBe("shared-alias-1");
    });

    it("returns shared aliases and agent's aliases when ownerAgentId provided", async () => {
      await repo.createAlias(100, "shared-alias", "common", undefined);
      await repo.createAlias(100, "agent-alias", "nickname", "agent-a");
      await repo.createAlias(100, "other-agent-alias", "nickname", "agent-b");

      const aliases = await service.getAliasesForEntity(100, "agent-a");
      expect(aliases.length).toBe(2);
      const aliasNames = aliases.map((a: EntityAlias) => a.alias).sort();
      expect(aliasNames).toEqual(["agent-alias", "shared-alias"]);
    });

    it("returns empty array when entity has no aliases", async () => {
      const aliases = await service.getAliasesForEntity(999);
      expect(aliases).toEqual([]);
    });
  });

  describe("resolveParticipants", () => {
    it("returns empty array for null input", async () => {
      const result = await service.resolveParticipants(null);
      expect(result).toEqual([]);
    });

    it("returns empty array for invalid JSON", async () => {
      const result = await service.resolveParticipants("invalid json");
      expect(result).toEqual([]);
    });

    it("resolves numeric entity IDs directly", async () => {
      const entityId = repo.addEntity("test-entity", "shared_public");

      const result = await service.resolveParticipants(JSON.stringify([entityId]));
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe(String(entityId));
      expect(result[0].entityId).toBe(entityId);
    });

    it("resolves string refs via alias", async () => {
      await repo.createAlias(100, "participant-alias", "nickname", undefined);

      const result = await service.resolveParticipants(JSON.stringify(["participant-alias"]));
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe("participant-alias");
      expect(result[0].entityId).toBe(100);
    });

    it("returns null entityId for unresolved refs", async () => {
      const result = await service.resolveParticipants(JSON.stringify(["nonexistent"]));
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe("nonexistent");
      expect(result[0].entityId).toBeNull();
    });

    it("handles mixed numeric IDs and string refs", async () => {
      const entityId = repo.addEntity("test-entity", "shared_public");
      await repo.createAlias(200, "string-alias", "nickname", undefined);

      const result = await service.resolveParticipants(
        JSON.stringify([entityId, "string-alias", "unknown"])
      );
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ ref: String(entityId), entityId });
      expect(result[1]).toEqual({ ref: "string-alias", entityId: 200 });
      expect(result[2]).toEqual({ ref: "unknown", entityId: null });
    });

    it("handles empty array", async () => {
      const result = await service.resolveParticipants(JSON.stringify([]));
      expect(result).toEqual([]);
    });
  });
});
