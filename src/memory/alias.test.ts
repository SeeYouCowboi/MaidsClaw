import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createMemorySchema } from "./schema.js";
import { AliasService } from "./alias.js";

describe("AliasService", () => {
  let db: Database;
  let service: AliasService;

  beforeEach(() => {
    db = new Database(":memory:");
    createMemorySchema(db);
    service = new AliasService(db);
  });

  describe("resolveAlias", () => {
    it("returns canonical entity_id when alias exists", () => {
      // Create an entity first
      const entityResult = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("Bob", "Bob", "person", "shared_public", Date.now(), Date.now());
      const entityId = Number(entityResult.lastInsertRowid);

      // Create an alias for the entity
      service.createAlias(entityId, "Bobby");

      // Resolve the alias
      const resolved = service.resolveAlias("Bobby");
      expect(resolved).toBe(entityId);
    });

    it("returns null for unknown alias", () => {
      const resolved = service.resolveAlias("Unknown");
      expect(resolved).toBeNull();
    });

    it("resolves via pointer_key for canonical entity name lookup", () => {
      // Create a public entity
      db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("Alice", "Alice", "person", "shared_public", Date.now(), Date.now());

      // Should resolve by pointer_key even without explicit alias
      const resolved = service.resolveAlias("Alice");
      expect(resolved).toBe(1);
    });

    it("agent-specific alias takes priority over shared alias with same name", () => {
      // Create two entities
      const sharedResult = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("SharedEntity", "Shared Entity", "thing", "shared_public", Date.now(), Date.now());
      const sharedId = Number(sharedResult.lastInsertRowid);

      const agentResult = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      ).run("AgentEntity", "Agent Entity", "thing", "private_overlay", "agent-1", Date.now(), Date.now());
      const agentId = Number(agentResult.lastInsertRowid);

      // Create shared alias
      service.createAlias(sharedId, "MyThing", undefined);

      // Create agent-specific alias with same name
      service.createAlias(agentId, "MyThing", undefined, "agent-1");

      // Agent-specific should take priority for that agent
      const resolvedForAgent = service.resolveAlias("MyThing", "agent-1");
      expect(resolvedForAgent).toBe(agentId);

      // Shared should be returned when no agent specified
      const resolvedNoAgent = service.resolveAlias("MyThing");
      expect(resolvedNoAgent).toBe(sharedId);
    });

    it("resolves private entity via pointer_key for owner agent", () => {
      // Create a private entity
      db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      ).run("PrivateBob", "Private Bob", "person", "private_overlay", "agent-1", Date.now(), Date.now());

      // Should resolve for the owner
      const resolved = service.resolveAlias("PrivateBob", "agent-1");
      expect(resolved).toBe(1);

      // Should not resolve without owner agent id
      const resolvedNoAgent = service.resolveAlias("PrivateBob");
      expect(resolvedNoAgent).toBeNull();
    });
  });

  describe("resolveAliases", () => {
    it("returns correct Map for multiple aliases", () => {
      // Create entities
      const aliceResult = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("Alice", "Alice", "person", "shared_public", Date.now(), Date.now());
      const aliceId = Number(aliceResult.lastInsertRowid);

      const bobResult = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("Bob", "Bob", "person", "shared_public", Date.now(), Date.now());
      const bobId = Number(bobResult.lastInsertRowid);

      // Create aliases
      service.createAlias(aliceId, "Alice");
      service.createAlias(bobId, "Bob");

      // Resolve multiple
      const result = service.resolveAliases(["Alice", "Bob", "Unknown"]);

      expect(result.get("Alice")).toBe(aliceId);
      expect(result.get("Bob")).toBe(bobId);
      expect(result.get("Unknown")).toBeNull();
    });
  });

  describe("createAlias", () => {
    it("creates alias and returns id", () => {
      // Create an entity
      const entityResult = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("Entity1", "Entity 1", "thing", "shared_public", Date.now(), Date.now());
      const entityId = Number(entityResult.lastInsertRowid);

      // Create alias
      const aliasId = service.createAlias(entityId, "Alias1", "nickname");

      expect(aliasId).toBeGreaterThan(0);

      // Verify alias was created
      const resolved = service.resolveAlias("Alias1");
      expect(resolved).toBe(entityId);
    });

    it("is idempotent - second call returns same id", () => {
      // Create an entity
      const entityResult = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("Entity2", "Entity 2", "thing", "shared_public", Date.now(), Date.now());
      const entityId = Number(entityResult.lastInsertRowid);

      // Create alias twice
      const aliasId1 = service.createAlias(entityId, "Alias2");
      const aliasId2 = service.createAlias(entityId, "Alias2");

      expect(aliasId1).toBe(aliasId2);
    });

    it("multiple aliases for same entity all resolve to same canonical ID", () => {
      // Create an entity
      const entityResult = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("Hero", "The Hero", "person", "shared_public", Date.now(), Date.now());
      const entityId = Number(entityResult.lastInsertRowid);

      // Create multiple aliases
      service.createAlias(entityId, "Protagonist");
      service.createAlias(entityId, "MainCharacter");
      service.createAlias(entityId, "MC");

      // All should resolve to same entity
      expect(service.resolveAlias("Protagonist")).toBe(entityId);
      expect(service.resolveAlias("MainCharacter")).toBe(entityId);
      expect(service.resolveAlias("MC")).toBe(entityId);
    });
  });

  describe("getAliasesForEntity", () => {
    it("returns all aliases for entity", () => {
      // Create an entity
      const entityResult = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("NPC", "NPC Character", "npc", "shared_public", Date.now(), Date.now());
      const entityId = Number(entityResult.lastInsertRowid);

      // Create aliases
      service.createAlias(entityId, "AliasA", "type1");
      service.createAlias(entityId, "AliasB", "type2");

      // Get aliases
      const aliases = service.getAliasesForEntity(entityId);

      expect(aliases).toHaveLength(2);
      expect(aliases.map(a => a.alias).sort()).toEqual(["AliasA", "AliasB"]);
    });

    it("filters by owner_agent_id", () => {
      // Create an entity
      const entityResult = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("Item", "Magic Item", "item", "shared_public", Date.now(), Date.now());
      const entityId = Number(entityResult.lastInsertRowid);

      // Create shared alias
      service.createAlias(entityId, "SharedAlias", undefined);

      // Create agent-specific alias
      service.createAlias(entityId, "AgentAlias", undefined, "agent-1");

      // Get aliases for agent - should see both shared and agent-specific
      const aliasesForAgent = service.getAliasesForEntity(entityId, "agent-1");
      expect(aliasesForAgent).toHaveLength(2);

      // Get aliases without agent - should see only shared
      const aliasesNoAgent = service.getAliasesForEntity(entityId);
      expect(aliasesNoAgent).toHaveLength(1);
      expect(aliasesNoAgent[0].alias).toBe("SharedAlias");
    });
  });

  describe("resolveParticipants", () => {
    it("resolves numeric entity IDs", () => {
      // Create entities
      const entity1 = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("E1", "Entity 1", "thing", "shared_public", Date.now(), Date.now());
      const id1 = Number(entity1.lastInsertRowid);

      const entity2 = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("E2", "Entity 2", "thing", "shared_public", Date.now(), Date.now());
      const id2 = Number(entity2.lastInsertRowid);

      const result = service.resolveParticipants(`[${id1}, ${id2}]`);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ ref: String(id1), entityId: id1 });
      expect(result[1]).toEqual({ ref: String(id2), entityId: id2 });
    });

    it("returns null for non-existent numeric IDs", () => {
      const result = service.resolveParticipants("[1, 2, 999]");

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ ref: "1", entityId: null });
      expect(result[1]).toEqual({ ref: "2", entityId: null });
      expect(result[2]).toEqual({ ref: "999", entityId: null });
    });

    it("resolves string pointer_keys via alias resolution", () => {
      // Create entity with pointer_key
      const entityResult = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("HeroName", "The Hero", "person", "shared_public", Date.now(), Date.now());
      const entityId = Number(entityResult.lastInsertRowid);

      const result = service.resolveParticipants('["HeroName"]');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ ref: "HeroName", entityId });
    });

    it("returns empty array for null input", () => {
      const result = service.resolveParticipants(null);
      expect(result).toEqual([]);
    });

    it("returns empty array for invalid JSON", () => {
      const result = service.resolveParticipants("invalid json");
      expect(result).toEqual([]);
    });

    it("handles mixed numeric IDs and string refs", () => {
      // Create entity
      const entityResult = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("Alice", "Alice", "person", "shared_public", Date.now(), Date.now());
      const aliceId = Number(entityResult.lastInsertRowid);

      // Create alias for Bob
      const bobResult = db.prepare(
        "INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ).run("Bob", "Bob", "person", "shared_public", Date.now(), Date.now());
      const bobId = Number(bobResult.lastInsertRowid);
      service.createAlias(bobId, "Bobby");

      const result = service.resolveParticipants(`[${aliceId}, "Bobby", "Unknown"]`)

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ ref: String(aliceId), entityId: aliceId });
      expect(result[1]).toEqual({ ref: "Bobby", entityId: bobId });
      expect(result[2]).toEqual({ ref: "Unknown", entityId: null });
    });
  });
});
