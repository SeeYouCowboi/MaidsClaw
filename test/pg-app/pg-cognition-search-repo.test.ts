import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import type { CognitionHit } from "../../src/memory/cognition/cognition-search.js";
import type { NodeRef } from "../../src/memory/types.js";
import type { AssertionBasis, AssertionStance, CognitionKind } from "../../src/runtime/rp-turn-contract.js";
import { PgCognitionSearchRepo } from "../../src/storage/domain-repos/pg/cognition-search-repo.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

type CurrentSeed = {
  id: number;
  agentId: string;
  cognitionKey: string;
  kind: CognitionKind;
  stance?: AssertionStance | null;
  basis?: AssertionBasis | null;
  status?: string;
  summaryText?: string | null;
  recordJson?: Record<string, unknown>;
  updatedAt?: number;
};

type SearchSeed = {
  id: number;
  agentId: string;
  sourceRef: NodeRef;
  kind: CognitionKind;
  stance?: AssertionStance | null;
  basis?: AssertionBasis | null;
  content: string;
  updatedAt?: number;
};

async function bootstrapCognitionSearchSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS private_cognition_current (
      id                         BIGSERIAL PRIMARY KEY,
      agent_id                   TEXT NOT NULL,
      cognition_key              TEXT NOT NULL,
      kind                       TEXT NOT NULL,
      stance                     TEXT,
      basis                      TEXT,
      status                     TEXT DEFAULT 'active',
      pre_contested_stance       TEXT,
      conflict_summary           TEXT,
      conflict_factor_refs_json  JSONB,
      summary_text               TEXT,
      record_json                JSONB NOT NULL,
      source_event_id            BIGINT NOT NULL,
      updated_at                 BIGINT NOT NULL,
      UNIQUE(agent_id, cognition_key)
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS search_docs_cognition (
      id         BIGSERIAL PRIMARY KEY,
      doc_type   TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      agent_id   TEXT NOT NULL,
      kind       TEXT NOT NULL,
      basis      TEXT,
      stance     TEXT,
      content    TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_cognition_content_trgm_test
      ON search_docs_cognition USING GIN (content gin_trgm_ops)
  `);
}

async function seedCurrent(sql: postgres.Sql, seed: CurrentSeed): Promise<void> {
  const recordJson = sql.json((seed.recordJson ?? {}) as never);
  await sql`
    INSERT INTO private_cognition_current (
      id,
      agent_id,
      cognition_key,
      kind,
      stance,
      basis,
      status,
      pre_contested_stance,
      conflict_summary,
      conflict_factor_refs_json,
      summary_text,
      record_json,
      source_event_id,
      updated_at
    ) VALUES (
      ${seed.id},
      ${seed.agentId},
      ${seed.cognitionKey},
      ${seed.kind},
      ${seed.stance ?? null},
      ${seed.basis ?? null},
      ${seed.status ?? "active"},
      ${null},
      ${null},
      ${null},
      ${seed.summaryText ?? null},
      ${recordJson},
      ${seed.id},
      ${seed.updatedAt ?? Date.now()}
    )
  `;
}

async function seedSearchDoc(sql: postgres.Sql, seed: SearchSeed): Promise<void> {
  await sql`
    INSERT INTO search_docs_cognition (
      id,
      doc_type,
      source_ref,
      agent_id,
      kind,
      basis,
      stance,
      content,
      updated_at,
      created_at
    ) VALUES (
      ${seed.id},
      ${seed.kind},
      ${seed.sourceRef},
      ${seed.agentId},
      ${seed.kind},
      ${seed.basis ?? null},
      ${seed.stance ?? null},
      ${seed.content},
      ${seed.updatedAt ?? Date.now()},
      ${Date.now()}
    )
  `;
}

describe.skipIf(skipPgTests)("PgCognitionSearchRepo", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("searchBySimilarity search returns relevant hits ordered by relevance", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapCognitionSearchSchema(sql);
      const repo = new PgCognitionSearchRepo(sql);

      await seedCurrent(sql, {
        id: 201,
        agentId: "agent-a",
        cognitionKey: "assertion:moonlit",
        kind: "assertion",
        stance: "accepted",
        basis: "first_hand",
        summaryText: "moonlit tea ceremony in the garden",
      });
      await seedCurrent(sql, {
        id: 202,
        agentId: "agent-a",
        cognitionKey: "assertion:chores",
        kind: "assertion",
        stance: "accepted",
        basis: "hearsay",
        summaryText: "kitchen chores and cleaning supplies",
      });

      await seedSearchDoc(sql, {
        id: 201,
        sourceRef: "assertion:201" as NodeRef,
        agentId: "agent-a",
        kind: "assertion",
        stance: "accepted",
        basis: "first_hand",
        content: "moonlit garden tea ceremony with silver lanterns",
      });
      await seedSearchDoc(sql, {
        id: 202,
        sourceRef: "assertion:202" as NodeRef,
        agentId: "agent-a",
        kind: "assertion",
        stance: "accepted",
        basis: "hearsay",
        content: "kitchen chores and pantry inventory",
      });
      await seedSearchDoc(sql, {
        id: 203,
        sourceRef: "assertion:203" as NodeRef,
        agentId: "agent-b",
        kind: "assertion",
        stance: "accepted",
        basis: "first_hand",
        content: "moonlit garden tea ceremony from another agent",
      });

      const hits = await repo.searchBySimilarity("moonlit garden tea ceremony", "agent-a", { limit: 10 });

      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(String(hits[0].source_ref)).toBe("assertion:201");
      expect(hits.map((hit) => String(hit.source_ref))).not.toContain("assertion:203");
    });
  });

  it("searchByKind filter applies kind/stance/basis/activeOnly constraints", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapCognitionSearchSchema(sql);
      const repo = new PgCognitionSearchRepo(sql);

      await seedCurrent(sql, {
        id: 301,
        agentId: "agent-a",
        cognitionKey: "assertion:301",
        kind: "assertion",
        stance: "accepted",
        basis: "first_hand",
        summaryText: "accepted first-hand assertion",
      });
      await seedCurrent(sql, {
        id: 302,
        agentId: "agent-a",
        cognitionKey: "assertion:302",
        kind: "assertion",
        stance: "accepted",
        basis: "hearsay",
        summaryText: "accepted hearsay assertion",
      });
      await seedCurrent(sql, {
        id: 303,
        agentId: "agent-a",
        cognitionKey: "assertion:303",
        kind: "assertion",
        stance: "rejected",
        basis: "first_hand",
        summaryText: "rejected first-hand assertion",
      });
      await seedCurrent(sql, {
        id: 304,
        agentId: "agent-a",
        cognitionKey: "commitment:304",
        kind: "commitment",
        status: "paused",
        summaryText: "paused commitment",
        recordJson: { priority: 1, horizon: "near" },
      });
      await seedCurrent(sql, {
        id: 305,
        agentId: "agent-a",
        cognitionKey: "commitment:305",
        kind: "commitment",
        status: "active",
        summaryText: "active commitment",
        recordJson: { priority: 1, horizon: "immediate" },
      });

      const assertionHits = await repo.searchByKind("agent-a", "assertion", {
        stance: "accepted",
        basis: "first_hand",
        activeOnly: true,
      });

      expect(assertionHits).toHaveLength(1);
      expect(String(assertionHits[0].source_ref)).toBe("assertion:301");

      const activeCommitments = await repo.searchByKind("agent-a", "commitment", {
        activeOnly: true,
      });
      expect(activeCommitments).toHaveLength(1);
      expect(String(activeCommitments[0].source_ref)).toBe("commitment:305");
    });
  });

  it("filterActiveCommitments filter excludes non-active commitments only", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapCognitionSearchSchema(sql);
      const repo = new PgCognitionSearchRepo(sql);

      await seedCurrent(sql, {
        id: 401,
        agentId: "agent-a",
        cognitionKey: "commitment:401",
        kind: "commitment",
        status: "active",
        recordJson: { priority: 2, horizon: "near" },
      });
      await seedCurrent(sql, {
        id: 402,
        agentId: "agent-a",
        cognitionKey: "commitment:402",
        kind: "commitment",
        status: "abandoned",
        recordJson: { priority: 1, horizon: "near" },
      });

      const items: CognitionHit[] = [
        {
          kind: "commitment",
          basis: null,
          stance: null,
          cognitionKey: null,
          source_ref: "commitment:401" as NodeRef,
          content: "active",
          updated_at: 100,
        },
        {
          kind: "commitment",
          basis: null,
          stance: null,
          cognitionKey: null,
          source_ref: "commitment:402" as NodeRef,
          content: "abandoned",
          updated_at: 101,
        },
        {
          kind: "assertion",
          basis: "first_hand",
          stance: "accepted",
          cognitionKey: null,
          source_ref: "assertion:499" as NodeRef,
          content: "non-commitment should stay",
          updated_at: 102,
        },
      ];

      const filtered = await repo.filterActiveCommitments(items, "agent-a");
      const refs = filtered.map((hit) => String(hit.source_ref));

      expect(refs).toContain("commitment:401");
      expect(refs).not.toContain("commitment:402");
      expect(refs).toContain("assertion:499");
    });
  });

  it("sortCommitments sort commitment order by priority/horizon/recency", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapCognitionSearchSchema(sql);
      const repo = new PgCognitionSearchRepo(sql);

      await seedCurrent(sql, {
        id: 501,
        agentId: "agent-a",
        cognitionKey: "commitment:501",
        kind: "commitment",
        status: "active",
        updatedAt: 1000,
        recordJson: { priority: 2, horizon: "long" },
      });
      await seedCurrent(sql, {
        id: 502,
        agentId: "agent-a",
        cognitionKey: "commitment:502",
        kind: "commitment",
        status: "active",
        updatedAt: 1200,
        recordJson: { priority: 1, horizon: "near" },
      });
      await seedCurrent(sql, {
        id: 503,
        agentId: "agent-a",
        cognitionKey: "commitment:503",
        kind: "commitment",
        status: "active",
        updatedAt: 1100,
        recordJson: { priority: 1, horizon: "immediate" },
      });
      await seedCurrent(sql, {
        id: 504,
        agentId: "agent-a",
        cognitionKey: "commitment:504",
        kind: "commitment",
        status: "active",
        updatedAt: 1400,
        recordJson: { priority: 1, horizon: "near" },
      });

      const items: CognitionHit[] = [501, 502, 503, 504].map((id) => ({
        kind: "commitment",
        basis: null,
        stance: null,
        cognitionKey: null,
        source_ref: `commitment:${id}` as NodeRef,
        content: `commitment ${id}`,
        updated_at: id,
      }));

      const sorted = await repo.sortCommitments(items, "agent-a");

      expect(sorted.map((hit) => String(hit.source_ref))).toEqual([
        "commitment:503",
        "commitment:504",
        "commitment:502",
        "commitment:501",
      ]);
    });
  });

  it("getActiveCurrent returns only status=active rows", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapCognitionSearchSchema(sql);
      const repo = new PgCognitionSearchRepo(sql);

      await seedCurrent(sql, {
        id: 601,
        agentId: "agent-a",
        cognitionKey: "assertion:601",
        kind: "assertion",
        status: "active",
      });
      await seedCurrent(sql, {
        id: 602,
        agentId: "agent-a",
        cognitionKey: "assertion:602",
        kind: "assertion",
        status: "retracted",
      });

      const activeRows = await repo.getActiveCurrent("agent-a");

      expect(activeRows).toHaveLength(1);
      expect(activeRows[0].id).toBe(601);
      expect(activeRows[0].status).toBe("active");
    });
  });

  it("resolveCognitionKey resolves key by source ref id", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapCognitionSearchSchema(sql);
      const repo = new PgCognitionSearchRepo(sql);

      await seedCurrent(sql, {
        id: 701,
        agentId: "agent-a",
        cognitionKey: "resolve:701",
        kind: "assertion",
      });

      const resolved = await repo.resolveCognitionKey("assertion:701" as NodeRef, "agent-a");
      const miss = await repo.resolveCognitionKey("assertion:999" as NodeRef, "agent-a");

      expect(resolved).toBe("resolve:701");
      expect(miss).toBeNull();
    });
  });
});
