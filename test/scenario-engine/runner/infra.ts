import postgres from "postgres";
import type { Story } from "../dsl/story-types.js";
import { SCENARIO_EMBEDDING_DIM } from "../constants.js";
import { loadCheckpoint } from "../generators/scenario-cache.js";
import {
  createPgTestDb,
  ensureTestPgAppDb,
  type PgTestDb,
} from "../../helpers/pg-app-test-utils.js";

import { PgGraphMutableStoreRepo } from "../../../src/storage/domain-repos/pg/graph-mutable-store-repo.js";
import { PgInteractionRepo } from "../../../src/storage/domain-repos/pg/interaction-repo.js";
import { PgEpisodeRepo } from "../../../src/storage/domain-repos/pg/episode-repo.js";
import { PgCognitionProjectionRepo } from "../../../src/storage/domain-repos/pg/cognition-projection-repo.js";
import { PgSearchProjectionRepo } from "../../../src/storage/domain-repos/pg/search-projection-repo.js";
import { PgRecentCognitionSlotRepo } from "../../../src/storage/domain-repos/pg/recent-cognition-slot-repo.js";
import { PgSettlementLedgerRepo } from "../../../src/storage/domain-repos/pg/settlement-ledger-repo.js";
import { PgNarrativeSearchRepo } from "../../../src/storage/domain-repos/pg/narrative-search-repo.js";
import { PgCognitionSearchRepo } from "../../../src/storage/domain-repos/pg/cognition-search-repo.js";
import { PgGraphReadQueryRepo } from "../../../src/storage/domain-repos/pg/graph-read-query-repo.js";
import { PgRetrievalReadRepo } from "../../../src/storage/domain-repos/pg/retrieval-read-repo.js";
import { PgAliasRepo } from "../../../src/storage/domain-repos/pg/alias-repo.js";
import { PgRelationReadRepo } from "../../../src/storage/domain-repos/pg/relation-read-repo.js";
import { PgEmbeddingRepo } from "../../../src/storage/domain-repos/pg/embedding-repo.js";
import { bootstrapRegistry } from "../../../src/core/models/bootstrap.js";
import { MemoryTaskModelProviderAdapter } from "../../../src/memory/model-provider-adapter.js";

import { NarrativeSearchService, type EmbeddingFallbackConfig } from "../../../src/memory/narrative/narrative-search.js";
import { CognitionSearchService, type CognitionEmbeddingConfig } from "../../../src/memory/cognition/cognition-search.js";
import { GraphNavigator } from "../../../src/memory/navigator.js";
import { RetrievalService } from "../../../src/memory/retrieval.js";
import { AliasService } from "../../../src/memory/alias.js";
import type { EmbeddingService } from "../../../src/memory/embeddings.js";
import { RetrievalOrchestrator } from "../../../src/memory/retrieval/retrieval-orchestrator.js";

const DEFAULT_APP_TEST_URL = "postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app_test";

function getAppTestUrl(): string {
  return process.env.PG_APP_TEST_URL ?? DEFAULT_APP_TEST_URL;
}

export type RunOptions = {
  writePath: "live" | "scripted" | "settlement";
  phase?: "full" | "resume" | "probe_only";
  compareWithSettlement?: boolean;
  keepSchema?: boolean;
};

export type ScenarioInfra = {
  sql: postgres.Sql;
  entityIdMap: Map<string, number>;
  schemaName: string;
  repos: {
    graphStore: PgGraphMutableStoreRepo;
    interaction: PgInteractionRepo;
    episode: PgEpisodeRepo;
    cognition: PgCognitionProjectionRepo;
    searchProjection: PgSearchProjectionRepo;
    recentCognitionSlot: PgRecentCognitionSlotRepo;
    settlementLedger: PgSettlementLedgerRepo;
  };
  services: {
    narrativeSearch: NarrativeSearchService;
    cognitionSearch: CognitionSearchService;
    navigator: GraphNavigator;
    retrieval: RetrievalService;
  };
  _testDb: PgTestDb;
};

export type BeatStatsSummary = {
  beatId: string;
  entitiesCreated: number;
  episodesCreated: number;
  assertionsCreated: number;
  evaluationsCreated: number;
  commitmentsCreated: number;
  errors: number;
};

export type ScenarioRunResult = {
  entityIdMap: Map<string, number>;
  settlementCount: number;
  projectionStats: Record<string, number>;
  perBeatStats: BeatStatsSummary[];
  errors: { beatId: string; error: Error }[];
  elapsedMs: number;
  schemaName: string;
  writePath: "live" | "scripted" | "settlement";
  phase: "full" | "resume" | "probe_only";
};

export type ScenarioHandle = {
  infra: ScenarioInfra;
  runResult: ScenarioRunResult;
};

function buildSchemaName(storyId: string, writePath: string): string {
  return `scenario_${storyId}_${writePath}`;
}

function collectAllPointerKeys(story: Story): Array<{ pointerKey: string; displayName: string; entityType: string }> {
  const entries: Array<{ pointerKey: string; displayName: string; entityType: string }> = [];
  for (const char of story.characters) {
    entries.push({ pointerKey: char.id, displayName: char.displayName, entityType: char.entityType });
  }
  for (const loc of story.locations) {
    entries.push({ pointerKey: loc.id, displayName: loc.displayName, entityType: loc.entityType });
  }
  for (const clue of story.clues) {
    entries.push({ pointerKey: clue.id, displayName: clue.displayName, entityType: clue.entityType });
  }
  return entries;
}

function buildRepos(sql: postgres.Sql) {
  return {
    graphStore: new PgGraphMutableStoreRepo(sql),
    interaction: new PgInteractionRepo(sql),
    episode: new PgEpisodeRepo(sql),
    cognition: new PgCognitionProjectionRepo(sql),
    searchProjection: new PgSearchProjectionRepo(sql),
    recentCognitionSlot: new PgRecentCognitionSlotRepo(sql),
    settlementLedger: new PgSettlementLedgerRepo(sql),
  };
}

function buildServices(sql: postgres.Sql) {
  const narrativeSearch = new NarrativeSearchService(new PgNarrativeSearchRepo(sql));
  const cognitionSearch = new CognitionSearchService(
    new PgCognitionSearchRepo(sql),
    new PgRelationReadRepo(sql),
    new PgCognitionProjectionRepo(sql),
  );

  const orchestrator = new RetrievalOrchestrator({
    narrativeService: narrativeSearch,
    cognitionService: cognitionSearch,
  });

  const retrieval = new RetrievalService({
    retrievalRepo: new PgRetrievalReadRepo(sql),
    embeddingService: {} as EmbeddingService,
    narrativeSearch,
    cognitionSearch,
    orchestrator,
  });

  const navigator = new GraphNavigator(
    new PgGraphReadQueryRepo(sql),
    retrieval,
    new AliasService(new PgAliasRepo(sql)),
    undefined,
    narrativeSearch,
    cognitionSearch,
  );

  return { narrativeSearch, cognitionSearch, navigator, retrieval };
}

export async function bootstrapScenarioSchema(
  story: Story,
  options?: RunOptions,
): Promise<ScenarioInfra> {
  const writePath = options?.writePath ?? "settlement";
  const phase = options?.phase ?? "full";
  const keepSchema = options?.keepSchema ?? true;
  const schemaName = buildSchemaName(story.id, writePath);

  if (phase === "probe_only") {
    return probeOnlyBootstrap(story, schemaName);
  }

  if (phase === "resume") {
    return resumeBootstrap(story, schemaName);
  }

  return fullBootstrap(story, schemaName, keepSchema);
}

async function fullBootstrap(story: Story, schemaName: string, keepSchema = true): Promise<ScenarioInfra> {
  // Per plan: full phase drops existing schema first to ensure fresh state.
  await ensureTestPgAppDb();
  const dropSql = postgres(getAppTestUrl(), { max: 1 });
  try {
    await dropSql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  } finally {
    await dropSql.end();
  }

  const testDb = await createPgTestDb({ embeddingDim: SCENARIO_EMBEDDING_DIM, schemaName });
  const sql = testDb.pool;

  const repos = buildRepos(sql);
  const services = buildServices(sql);

  const entityIdMap = new Map<string, number>();
  const entitySpecs = collectAllPointerKeys(story);
  for (const spec of entitySpecs) {
    const entityId = await repos.graphStore.upsertEntity({
      pointerKey: spec.pointerKey,
      displayName: spec.displayName,
      entityType: spec.entityType,
      memoryScope: "shared_public",
    });
    entityIdMap.set(spec.pointerKey, entityId);
  }

  entityIdMap.set("__self__", testDb.entities.selfId);
  entityIdMap.set("__user__", testDb.entities.userId);
  entityIdMap.set("test-room", testDb.entities.locationId);
  entityIdMap.set("bob", testDb.entities.bobId);

  // When keepSchema is true, override cleanup to only close the pool
  // without dropping the schema — enables probe_only re-runs.
  const adjustedTestDb = keepSchema
    ? { ...testDb, cleanup: async () => { await sql.end(); } }
    : testDb;

  return {
    sql,
    entityIdMap,
    schemaName: testDb.schemaName,
    repos,
    services,
    _testDb: adjustedTestDb,
  };
}

async function probeOnlyBootstrap(_story: Story, schemaName: string): Promise<ScenarioInfra> {
  await ensureTestPgAppDb();

  const checkSql = postgres(getAppTestUrl(), { max: 1 });
  let schemaExists = false;
  try {
    const rows = await checkSql`
      SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schemaName}
    `;
    schemaExists = rows.length > 0;
  } finally {
    await checkSql.end();
  }

  if (!schemaExists) {
    throw new Error(
      `Schema '${schemaName}' not found — run with phase: 'full' first`,
    );
  }

  const sql = postgres(getAppTestUrl(), {
    max: 3,
    connection: { search_path: `${schemaName},public` },
  });

  const repos = buildRepos(sql);
  const services = buildServices(sql);

  const entityIdMap = new Map<string, number>();
  const entityRows = await sql`SELECT id, pointer_key FROM entity_nodes`;
  for (const row of entityRows) {
    entityIdMap.set(row.pointer_key as string, Number(row.id));
  }

  const testDb: PgTestDb = {
    pool: sql,
    schemaName,
    entities: {
      selfId: entityIdMap.get("__self__") ?? 0,
      userId: entityIdMap.get("__user__") ?? 0,
      locationId: entityIdMap.get("test-room") ?? 0,
      bobId: entityIdMap.get("bob") ?? 0,
    },
    cleanup: async () => { await sql.end(); },
  };

  return { sql, entityIdMap, schemaName, repos, services, _testDb: testDb };
}

async function resumeBootstrap(story: Story, schemaName: string): Promise<ScenarioInfra> {
  // Per plan: check schema exists AND checkpoint file exists.
  // If both present, connect to existing schema and load entity map.
  // If either missing, throw with clear message.
  await ensureTestPgAppDb();

  const checkSql = postgres(getAppTestUrl(), { max: 1 });
  let schemaExists = false;
  try {
    const rows = await checkSql`
      SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schemaName}
    `;
    schemaExists = rows.length > 0;
  } finally {
    await checkSql.end();
  }

  const checkpoint = loadCheckpoint(story.id);

  if (!schemaExists && !checkpoint) {
    throw new Error(
      `Resume failed: schema '${schemaName}' not found and no checkpoint for story '${story.id}'. ` +
      `Run with phase: 'full' first.`,
    );
  }
  if (!schemaExists) {
    throw new Error(
      `Resume failed: schema '${schemaName}' not found. ` +
      `The checkpoint exists but the schema was dropped. Run with phase: 'full' first.`,
    );
  }
  if (!checkpoint) {
    throw new Error(
      `Resume failed: no checkpoint found for story '${story.id}'. ` +
      `The schema '${schemaName}' exists but no checkpoint was saved. ` +
      `Run with phase: 'full' and writePath: 'live' to create a checkpoint.`,
    );
  }

  const sql = postgres(getAppTestUrl(), {
    max: 3,
    connection: { search_path: `${schemaName},public` },
  });

  const repos = buildRepos(sql);
  const services = buildServices(sql);

  const entityIdMap = new Map<string, number>();
  const entityRows = await sql`SELECT id, pointer_key FROM entity_nodes`;
  for (const row of entityRows) {
    entityIdMap.set(row.pointer_key as string, Number(row.id));
  }

  const testDb: PgTestDb = {
    pool: sql,
    schemaName,
    entities: {
      selfId: entityIdMap.get("__self__") ?? 0,
      userId: entityIdMap.get("__user__") ?? 0,
      locationId: entityIdMap.get("test-room") ?? 0,
      bobId: entityIdMap.get("bob") ?? 0,
    },
    cleanup: async () => { await sql.end(); },
  };

  return { sql, entityIdMap, schemaName, repos, services, _testDb: testDb };
}

export async function cleanupSchema(
  sql: postgres.Sql,
  storyId: string,
  writePath?: string,
): Promise<void> {
  if (writePath) {
    const target = buildSchemaName(storyId, writePath);
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${target}" CASCADE`);
  } else {
    const rows = await sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE ${"scenario_" + storyId + "_%"}
    `;
    for (const row of rows) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
    }
  }
}

export async function cleanupAllSchemas(sql: postgres.Sql): Promise<void> {
  const rows = await sql`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'scenario_%'
  `;
  for (const row of rows) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
  }
}

/**
 * Enable RRF hybrid search (pg_trgm + embedding) on the scenario services.
 * Call AFTER embeddings have been generated via `generateEmbeddings()`.
 */
export function configureEmbeddingSearch(infra: ScenarioInfra): void {
  const embeddingRepo = new PgEmbeddingRepo(infra.sql);

  // Resolve embedding model + provider
  let chatModelId: string;
  let embeddingModelId: string;
  if (process.env.ANTHROPIC_API_KEY?.trim()) chatModelId = "anthropic/claude-sonnet-4-20250514";
  else if (process.env.MINIMAX_API_KEY?.trim()) chatModelId = "minimax/MiniMax-M2.7-highspeed";
  else if (process.env.MOONSHOT_API_KEY?.trim()) chatModelId = "moonshot/kimi-k2.5";
  else if (process.env.KIMI_CODING_API_KEY?.trim()) chatModelId = "kimi-coding/kimi-for-coding";
  else if (process.env.OPENAI_API_KEY?.trim()) chatModelId = "openai/gpt-4o-mini";
  else return; // No LLM key — skip embedding config

  if (process.env.BAILIAN_API_KEY?.trim()) embeddingModelId = "bailian/text-embedding-v4";
  else if (process.env.OPENAI_API_KEY?.trim()) embeddingModelId = "openai/text-embedding-3-small";
  else embeddingModelId = chatModelId;

  const registry = bootstrapRegistry();
  const adapter = new MemoryTaskModelProviderAdapter(registry, chatModelId, embeddingModelId);

  infra.services.narrativeSearch.setEmbeddingFallback({
    embeddingRepo,
    modelProvider: adapter,
    embeddingModelId,
  });

  infra.services.cognitionSearch.setEmbeddingConfig({
    embeddingRepo,
    modelProvider: adapter,
    embeddingModelId,
    sql: infra.sql,
  });
}
