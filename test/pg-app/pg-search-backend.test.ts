import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import postgres_ from "postgres";
import type { NodeRef } from "../../src/memory/types.js";
import { PgCognitionSearchRepo } from "../../src/storage/domain-repos/pg/cognition-search-repo.js";
import {
  buildCognitionNgramSql,
  buildCognitionWordSql,
  buildEpisodeNgramSql,
  buildEpisodeWordSql,
  decidePgSearchRouting,
  PgSearchLexicalBackend,
} from "../../src/storage/domain-repos/pg/pg-search-backend.js";
import { PgSearchProjectionRepo } from "../../src/storage/domain-repos/pg/search-projection-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
  resolvePgAppTestUrl,
  skipPgTests,
} from "../helpers/pg-app-test-utils.js";

const BASE_TS = 1_760_000_000_000;

async function installAliasBm25Indexes(sql: postgres.Sql): Promise<void> {
  await sql.unsafe("DROP INDEX IF EXISTS idx_search_docs_episode_bm25");
  await sql.unsafe("DROP INDEX IF EXISTS idx_search_docs_cognition_bm25");

  await sql.unsafe(`
    CREATE INDEX idx_search_docs_episode_bm25
    ON search_docs_episode
    USING bm25 (
      id,
      content_search_text,
      (content_search_text::pdb.unicode_words('alias=content_en')),
      (content_ngram_text::pdb.ngram(2, 3, 'alias=content_ngram')),
      alias_text,
      agent_id,
      category,
      committed_at,
      created_at
    )
    WITH (key_field='id')
  `);

  await sql.unsafe(`
    CREATE INDEX idx_search_docs_cognition_bm25
    ON search_docs_cognition
    USING bm25 (
      id,
      content_search_text,
      (content_search_text::pdb.unicode_words('alias=content_en')),
      (content_ngram_text::pdb.ngram(2, 3, 'alias=content_ngram')),
      alias_text,
      agent_id,
      kind,
      stance,
      basis,
      updated_at
    )
    WITH (key_field='id')
  `);
}

async function seedDocs(sql: postgres.Sql): Promise<void> {
  const projectionRepo = new PgSearchProjectionRepo(sql);

  await projectionRepo.upsertEpisodeDoc({
    sourceRef: "episode:1001",
    agentId: "agent-a",
    category: "observation",
    content: "Alice discussed the silver watch in the tea room",
    committedAt: BASE_TS + 100,
    createdAt: BASE_TS + 100,
    aliasText: "Alice 爱丽丝 tea room 茶室",
  });
  await projectionRepo.upsertEpisodeDoc({
    sourceRef: "episode:1002",
    agentId: "agent-a",
    category: "observation",
    content: "Alice discussed the silver watch in the tea room",
    committedAt: BASE_TS + 200,
    createdAt: BASE_TS + 200,
    aliasText: "Alice 爱丽丝 tea room 茶室",
  });
  await projectionRepo.upsertEpisodeDoc({
    sourceRef: "episode:1003",
    agentId: "agent-b",
    category: "observation",
    content: "Alice discussed the silver watch in another estate",
    committedAt: BASE_TS + 250,
    createdAt: BASE_TS + 250,
    aliasText: "Alice",
  });
  await projectionRepo.upsertEpisodeDoc({
    sourceRef: "episode:1004",
    agentId: "agent-a",
    category: "observation",
    content: "爱丽丝在茶室提到怀表",
    committedAt: BASE_TS + 300,
    createdAt: BASE_TS + 300,
    aliasText: "爱丽丝 茶室 怀表",
  });

  // ngram-only candidate: word field intentionally does not include the mixed query,
  // but ngram field does. This lets fallback rescue the hit.
  await sql`
    INSERT INTO search_docs_episode (
      doc_type,
      source_ref,
      agent_id,
      category,
      content,
      committed_at,
      created_at,
      entity_pointer_keys,
      content_search_text,
      content_ngram_text,
      alias_text
    ) VALUES (
      'episode',
      'episode:1999',
      'agent-a',
      'observation',
      'fallback ngram bridge row',
      ${BASE_TS + 320},
      ${BASE_TS + 320},
      ${[]},
      'irrelevant lexical tokens',
      'Alice怀表线索',
      ''
    )
  `;

  await projectionRepo.upsertCognitionDoc({
    sourceRef: "assertion:2001" as NodeRef,
    agentId: "agent-a",
    kind: "assertion",
    basis: "first_hand",
    stance: "accepted",
    content: "Moonlight tea evidence from Alice",
    updatedAt: BASE_TS + 100,
    createdAt: BASE_TS + 100,
    aliasText: "Alice",
  });
  await projectionRepo.upsertCognitionDoc({
    sourceRef: "assertion:2002" as NodeRef,
    agentId: "agent-a",
    kind: "assertion",
    basis: "hearsay",
    stance: "accepted",
    content: "Moonlight tea hearsay",
    updatedAt: BASE_TS + 210,
    createdAt: BASE_TS + 210,
    aliasText: "moonlight",
  });
  await projectionRepo.upsertCognitionDoc({
    sourceRef: "assertion:2003" as NodeRef,
    agentId: "agent-a",
    kind: "assertion",
    basis: "first_hand",
    stance: "rejected",
    content: "Moonlight tea rejected claim",
    updatedAt: BASE_TS + 220,
    createdAt: BASE_TS + 220,
    aliasText: "moonlight",
  });
  await projectionRepo.upsertCognitionDoc({
    sourceRef: "assertion:2004" as NodeRef,
    agentId: "agent-b",
    kind: "assertion",
    basis: "first_hand",
    stance: "accepted",
    content: "Moonlight tea from agent-b",
    updatedAt: BASE_TS + 240,
    createdAt: BASE_TS + 240,
    aliasText: "moonlight",
  });
}

describe("PgSearchLexicalBackend SQL builder", () => {
  it("builds cognition SQL with pinned alias/score/filter syntax", () => {
    const built = buildCognitionWordSql({
      query: "moonlight tea",
      agentId: "agent-a",
      limit: 7,
      useJieba: false,
      kind: "assertion",
      stance: "accepted",
      basis: "first_hand",
      activeOnly: true,
      asOfCommittedTime: 123,
      minScore: 0.25,
    });

    expect(built.text).toContain("content_search_text::pdb.alias('content_en') ||| $2::pdb.unicode_words");
    expect(built.text).toContain("pdb.score(id) AS score");
    expect(built.text).toContain("agent_id = $1");
    expect(built.text).toContain("kind = $3");
    expect(built.text).toContain("stance = $4");
    expect(built.text).toContain("basis = $5");
    expect(built.text).toContain("updated_at <= $6");
    expect(built.text).toContain("pdb.score(id) >= $7");
    expect(built.text).toContain("ORDER BY score DESC");
    expect(built.text).not.toContain("updated_at DESC");
    expect(built.params).toEqual([
      "agent-a",
      "moonlight tea",
      "assertion",
      "accepted",
      "first_hand",
      123,
      0.25,
      7,
    ]);
  });

  it("builds episode ngram SQL with pinned alias syntax", () => {
    const built = buildEpisodeNgramSql({
      query: "Alice怀表",
      agentId: "agent-a",
      limit: 5,
      category: "observation",
      asOfCommittedTime: 999,
      minScore: 0.1,
    });

    expect(built.text).toContain("content_ngram_text::pdb.alias('content_ngram') ||| $2");
    expect(built.text).toContain("pdb.score(id) AS score");
    expect(built.text).toContain("agent_id = $1");
    expect(built.text).toContain("category = $3");
    expect(built.text).toContain("committed_at <= $4");
    expect(built.text).toContain("pdb.score(id) >= $5");
    expect(built.text).toContain("ORDER BY score DESC");
    expect(built.text).not.toContain("committed_at DESC");
    expect(built.params).toEqual(["agent-a", "Alice怀表", "observation", 999, 0.1, 5]);
  });

  it("routes ngram fallback deterministically by token/mixed/short/low-hit rules", () => {
    const noFallback = decidePgSearchRouting("Alice watch", 4, 20);
    expect(noFallback.shouldRunNgram).toBe(false);

    const shortQuery = decidePgSearchRouting("moon", 4, 20);
    expect(shortQuery.shouldRunNgram).toBe(true);

    const mixedQuery = decidePgSearchRouting("Alice怀表", 10, 20);
    expect(mixedQuery.shouldRunNgram).toBe(true);
    expect(mixedQuery.ngramLimit).toBe(10);

    const lowPrimaryHits = decidePgSearchRouting("garden mystery", 2, 50);
    expect(lowPrimaryHits.shouldRunNgram).toBe(true);
    expect(lowPrimaryHits.ngramLimit).toBe(10);

    const zeroTokens = decidePgSearchRouting("...", 4, 8);
    expect(zeroTokens.shouldRunNgram).toBe(true);
    expect(zeroTokens.ngramLimit).toBe(8);
  });

  it("build helpers cover CJK jieba and episode word query shape", () => {
    const cognitionJieba = buildCognitionWordSql({
      query: "怀表",
      agentId: "agent-a",
      limit: 5,
      useJieba: true,
    });
    expect(cognitionJieba.text).toContain("content_search_text ||| $2::pdb.jieba");

    const episodeWord = buildEpisodeWordSql({
      query: "watch",
      agentId: "agent-a",
      limit: 5,
      useJieba: false,
    });
    expect(episodeWord.text).toContain("content_search_text::pdb.alias('content_en') ||| $2::pdb.unicode_words");

    const cognitionNgram = buildCognitionNgramSql({
      query: "Alice怀表",
      agentId: "agent-a",
      limit: 5,
    });
    expect(cognitionNgram.text).toContain("content_ngram_text::pdb.alias('content_ngram') ||| $2");
  });
});

describe.skipIf(skipPgTests)("PgSearchLexicalBackend integration (pg_search)", () => {
  let sql: postgres.Sql;
  let schemaName: string;

  beforeAll(async () => {
    sql = postgres_(resolvePgAppTestUrl(), {
      max: 2,
      connect_timeout: 10,
      onnotice() {},
    });

    schemaName = `pgs_backend_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await sql.unsafe(`SET search_path TO "${schemaName}", public`);

    await bootstrapTruthSchema(sql);
    await bootstrapOpsSchema(sql);
    await bootstrapDerivedSchema(sql);
    await installAliasBm25Indexes(sql);
    await seedDocs(sql);
  });

  afterAll(async () => {
    try {
      await sql.unsafe("SET search_path TO public");
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await sql.end();
    }
  });

  it("searchEpisode uses pg_search paths for Latin/CJK and preserves agent gate + committed ordering", async () => {
    const repo = new PgSearchProjectionRepo(sql);

    const latinHits = await repo.searchEpisode("silver watch", "agent-a", 10);
    expect(latinHits.length).toBeGreaterThanOrEqual(2);
    expect(latinHits.map((hit) => hit.agentId).every((id) => id === "agent-a")).toBe(true);
    expect(latinHits.map((hit) => hit.sourceRef)).not.toContain("episode:1003");
    // Same-content rows should be tie-broken by committed time descending.
    expect(latinHits[0].sourceRef).toBe("episode:1002");

    const cjkHits = await repo.searchEpisode("爱丽丝怀表茶室", "agent-a", 10);
    expect(cjkHits.length).toBeGreaterThanOrEqual(1);
    expect(cjkHits.map((hit) => hit.sourceRef)).toContain("episode:1004");
    expect(cjkHits.map((hit) => hit.agentId).every((id) => id === "agent-a")).toBe(true);
  });

  it("mixed query runs ngram fallback and rescues ngram-only row", async () => {
    const backend = new PgSearchLexicalBackend(sql);
    const hits = await backend.searchEpisode({
      query: "Alice怀表",
      agentId: "agent-a",
      limit: 10,
    });

    const refs = hits.map((hit) => hit.source_ref);
    expect(refs).toContain("episode:1999");
  });

  it("searchBySimilarity preserves cognition filters and agent isolation", async () => {
    const repo = new PgCognitionSearchRepo(sql);

    const hits = await repo.searchBySimilarity("Moonlight tea", "agent-a", {
      kind: "assertion",
      stance: "accepted",
      basis: "first_hand",
      activeOnly: true,
      timeWindow: { asOfCommittedTime: BASE_TS + 150 },
      minScore: 0,
      limit: 10,
    });

    expect(hits).toHaveLength(1);
    expect(String(hits[0].source_ref)).toBe("assertion:2001");

    const allRefs = new Set((await repo.searchBySimilarity("Moonlight tea", "agent-a", { limit: 10 }))
      .map((hit) => String(hit.source_ref)));
    expect(allRefs.has("assertion:2004")).toBe(false);
  });
});
