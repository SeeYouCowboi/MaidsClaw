import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { PgAliasRepo } from "../../src/storage/domain-repos/pg/alias-repo.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

async function bootstrapAliasSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS entity_aliases (
      id               BIGSERIAL PRIMARY KEY,
      canonical_id     BIGINT NOT NULL,
      alias            TEXT NOT NULL,
      alias_type       TEXT,
      owner_agent_id   TEXT
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS entity_nodes (
      id               BIGSERIAL PRIMARY KEY,
      pointer_key      TEXT NOT NULL,
      memory_scope     TEXT NOT NULL,
      owner_agent_id   TEXT,
      summary          TEXT,
      created_at       BIGINT NOT NULL,
      updated_at       BIGINT NOT NULL
    )
  `);
}

describe.skipIf(skipPgTests)("PgAliasRepo", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  describe("resolveAlias", () => {
    it("returns canonical_id for agent-specific alias", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        await sql`
          INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
          VALUES (100, 'my-alias', 'nickname', 'agent-a')
        `;

        const result = await repo.resolveAlias("my-alias", "agent-a");
        expect(result).toBe(100);
      });
    });

    it("returns null when agent-specific alias belongs to different agent", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        await sql`
          INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
          VALUES (100, 'my-alias', 'nickname', 'agent-a')
        `;

        const result = await repo.resolveAlias("my-alias", "agent-b");
        expect(result).toBeNull();
      });
    });

    it("returns canonical_id for shared alias (no owner)", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        await sql`
          INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
          VALUES (200, 'shared-alias', 'common', NULL)
        `;

        const result = await repo.resolveAlias("shared-alias");
        expect(result).toBe(200);
      });
    });

    it("returns canonical_id for shared alias with any agent", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        await sql`
          INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
          VALUES (200, 'shared-alias', 'common', NULL)
        `;

        const result = await repo.resolveAlias("shared-alias", "agent-a");
        expect(result).toBe(200);
      });
    });

    it("prefers agent-specific alias over shared alias", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        await sql`
          INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
          VALUES (300, 'shared-alias', 'common', NULL)
        `;
        await sql`
          INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
          VALUES (301, 'shared-alias', 'nickname', 'agent-a')
        `;

        const result = await repo.resolveAlias("shared-alias", "agent-a");
        expect(result).toBe(301);
      });
    });

    it("returns entity id for private entity by pointer_key", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        const rows = await sql`
          INSERT INTO entity_nodes (pointer_key, memory_scope, owner_agent_id, created_at, updated_at)
          VALUES ('private-entity', 'private_overlay', 'agent-a', 1, 1)
          RETURNING id
        `;
        const entityId = Number(rows[0].id);

        const result = await repo.resolveAlias("private-entity", "agent-a");
        expect(result).toBe(entityId);
      });
    });

    it("returns null for private entity when owner differs", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        await sql`
          INSERT INTO entity_nodes (pointer_key, memory_scope, owner_agent_id, created_at, updated_at)
          VALUES ('private-entity', 'private_overlay', 'agent-a', 1, 1)
        `;

        const result = await repo.resolveAlias("private-entity", "agent-b");
        expect(result).toBeNull();
      });
    });

    it("returns entity id for public entity by pointer_key", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        const rows = await sql`
          INSERT INTO entity_nodes (pointer_key, memory_scope, owner_agent_id, created_at, updated_at)
          VALUES ('public-entity', 'shared_public', NULL, 1, 1)
          RETURNING id
        `;
        const entityId = Number(rows[0].id);

        const result = await repo.resolveAlias("public-entity");
        expect(result).toBe(entityId);
      });
    });

    it("returns null when alias not found anywhere", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        const result = await repo.resolveAlias("nonexistent-alias");
        expect(result).toBeNull();
      });
    });
  });

  describe("resolveAliases", () => {
    it("returns Map of aliases to entity IDs (bulk resolution)", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        await sql`
          INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
          VALUES (100, 'alias-a', 'common', NULL),
                 (200, 'alias-b', 'common', NULL)
        `;

        const result = await repo.resolveAliases(["alias-a", "alias-b", "alias-c"]);
        expect(result.get("alias-a")).toBe(100);
        expect(result.get("alias-b")).toBe(200);
        expect(result.get("alias-c")).toBeNull();
      });
    });

    it("respects ownerAgentId for bulk resolution", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        await sql`
          INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
          VALUES (100, 'alias-a', 'common', 'agent-a')
        `;

        const result = await repo.resolveAliases(["alias-a"], "agent-b");
        expect(result.get("alias-a")).toBeNull();
      });
    });
  });

  describe("createAlias", () => {
    it("creates a new alias and returns its id", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        const aliasId = await repo.createAlias(100, "new-alias", "nickname", "agent-a");
        expect(typeof aliasId).toBe("number");
        expect(aliasId).toBeGreaterThan(0);

        const rows = await sql`SELECT * FROM entity_aliases WHERE id = ${aliasId}`;
        expect(rows.length).toBe(1);
        const row = rows[0];
        expect(row).toBeDefined();
        if (!row) {
          throw new Error("expected alias row");
        }
        expect(row.canonical_id).toBe(100);
        expect(row.alias).toBe("new-alias");
        expect(row.alias_type).toBe("nickname");
        expect(row.owner_agent_id).toBe("agent-a");
      });
    });

    it("returns existing alias id when duplicate detected (check-then-insert)", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        const aliasId1 = await repo.createAlias(100, "existing-alias", "nickname", "agent-a");
        const aliasId2 = await repo.createAlias(100, "existing-alias", "nickname", "agent-a");

        expect(aliasId1).toBe(aliasId2);

        const count = await sql`SELECT COUNT(*) FROM entity_aliases WHERE canonical_id = 100 AND alias = 'existing-alias'`;
        expect(Number(count[0].count)).toBe(1);
      });
    });

    it("allows same alias for different canonical entities", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        const aliasId1 = await repo.createAlias(100, "shared-name", "nickname", "agent-a");
        const aliasId2 = await repo.createAlias(200, "shared-name", "nickname", "agent-a");

        expect(aliasId1).not.toBe(aliasId2);
      });
    });

    it("allows same alias for different owners", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        const aliasId1 = await repo.createAlias(100, "owner-specific", "nickname", "agent-a");
        const aliasId2 = await repo.createAlias(100, "owner-specific", "nickname", "agent-b");

        expect(aliasId1).not.toBe(aliasId2);
      });
    });

    it("handles null alias_type and owner_agent_id", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        const aliasId = await repo.createAlias(100, "minimal-alias");
        expect(typeof aliasId).toBe("number");

        const rows = await sql`SELECT * FROM entity_aliases WHERE id = ${aliasId}`;
        expect(rows.length).toBe(1);
        const row = rows[0];
        expect(row).toBeDefined();
        if (!row) {
          throw new Error("expected alias row");
        }
        expect(row.alias_type).toBeNull();
        expect(row.owner_agent_id).toBeNull();
      });
    });
  });

  describe("getAliasesForEntity", () => {
    it("returns all aliases for a canonical entity", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        await sql`
          INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
          VALUES (100, 'alias-1', 'nickname', NULL),
                 (100, 'alias-2', 'acronym', 'agent-a'),
                 (100, 'alias-3', 'initials', 'agent-b')
        `;

        const aliases = await repo.getAliasesForEntity(100);
        expect(aliases.length).toBe(3);
        const aliasNames = aliases.map((a: { alias: string }) => a.alias).sort();
        expect(aliasNames).toEqual(['alias-1', 'alias-2', 'alias-3']);
      });
    });

    it("returns shared aliases and agent's aliases when ownerAgentId provided", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        await sql`
          INSERT INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
          VALUES (100, 'shared-alias', 'common', NULL),
                 (100, 'agent-alias', 'nickname', 'agent-a'),
                 (100, 'other-agent-alias', 'nickname', 'agent-b')
        `;

        const aliases = await repo.getAliasesForEntity(100, "agent-a");
        expect(aliases.length).toBe(2);
        const aliasNames = aliases.map((a: { alias: string }) => a.alias).sort();
        expect(aliasNames).toEqual(['agent-alias', 'shared-alias']);
      });
    });

    it("returns empty array when entity has no aliases", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        const aliases = await repo.getAliasesForEntity(999);
        expect(aliases).toEqual([]);
      });
    });
  });

  describe("findEntityById", () => {
    it("returns entity node when found", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        const rows = await sql`
          INSERT INTO entity_nodes (pointer_key, memory_scope, owner_agent_id, created_at, updated_at)
          VALUES ('test-entity', 'shared_public', NULL, 1000, 2000)
          RETURNING id
        `;
        const entityId = Number(rows[0].id);

        const entity = await repo.findEntityById(entityId);
        expect(entity).not.toBeNull();
        if (!entity) {
          throw new Error("expected entity");
        }
        expect(entity.id).toBe(entityId);
        expect(entity.pointer_key).toBe("test-entity");
        expect(entity.memory_scope).toBe("shared_public");
      });
    });

    it("returns null when entity not found", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        const entity = await repo.findEntityById(99999);
        expect(entity).toBeNull();
      });
    });
  });

  describe("findEntityByPointerKey", () => {
    it("returns public entity by pointer_key", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        await sql`
          INSERT INTO entity_nodes (pointer_key, memory_scope, owner_agent_id, created_at, updated_at)
          VALUES ('public-entity', 'shared_public', NULL, 1000, 2000)
        `;

        const entity = await repo.findEntityByPointerKey("public-entity", "shared_public");
        expect(entity).not.toBeNull();
        if (!entity) {
          throw new Error("expected entity");
        }
        expect(entity.pointer_key).toBe("public-entity");
      });
    });

    it("returns private entity by pointer_key with owner", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        await sql`
          INSERT INTO entity_nodes (pointer_key, memory_scope, owner_agent_id, created_at, updated_at)
          VALUES ('private-entity', 'private_overlay', 'agent-a', 1000, 2000)
        `;

        const entity = await repo.findEntityByPointerKey("private-entity", "private_overlay", "agent-a");
        expect(entity).not.toBeNull();
        if (!entity) {
          throw new Error("expected entity");
        }
        expect(entity.pointer_key).toBe("private-entity");
      });
    });

    it("returns null for private entity when owner differs", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        await sql`
          INSERT INTO entity_nodes (pointer_key, memory_scope, owner_agent_id, created_at, updated_at)
          VALUES ('private-entity', 'private_overlay', 'agent-a', 1000, 2000)
        `;

        const entity = await repo.findEntityByPointerKey("private-entity", "private_overlay", "agent-b");
        expect(entity).toBeNull();
      });
    });

    it("returns null when pointer_key not found", async () => {
      await withTestAppSchema(pool, async (sql) => {
        await bootstrapAliasSchema(sql);
        const repo = new PgAliasRepo(sql);

        const entity = await repo.findEntityByPointerKey("nonexistent", "shared_public");
        expect(entity).toBeNull();
      });
    });
  });
});
