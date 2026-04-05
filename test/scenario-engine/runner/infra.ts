import postgres from "postgres";
import type { Story } from "../dsl/story-types.js";
import { SCENARIO_EMBEDDING_DIM } from "../constants.js";
import {
  createPgTestDb,
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

import { NarrativeSearchService } from "../../../src/memory/narrative/narrative-search.js";
import { CognitionSearchService } from "../../../src/memory/cognition/cognition-search.js";
import { GraphNavigator } from "../../../src/memory/navigator.js";
import { RetrievalService } from "../../../src/memory/retrieval.js";
import { AliasService } from "../../../src/memory/alias.js";

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
  };
  _testDb: PgTestDb;
};

export type ScenarioRunResult = {
  entityIdMap: Map<string, number>;
  settlementCount: number;
  projectionStats: Record<string, number>;
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
  const retrieval = new RetrievalService({ retrievalRepo: new PgRetrievalReadRepo(sql) });
  const navigator = new GraphNavigator(
    new PgGraphReadQueryRepo(sql),
    retrieval,
    new AliasService(new PgAliasRepo(sql)),
    undefined,
    narrativeSearch,
    cognitionSearch,
  );

  return { narrativeSearch, cognitionSearch, navigator };
}

export async function bootstrapScenarioSchema(
  story: Story,
  options?: RunOptions,
): Promise<ScenarioInfra> {
  const writePath = options?.writePath ?? "settlement";
  const phase = options?.phase ?? "full";
  const schemaName = buildSchemaName(story.id, writePath);

  if (phase === "probe_only") {
    return probeOnlyBootstrap(story, schemaName);
  }

  if (phase === "resume") {
    return resumeBootstrap(story, schemaName);
  }

  return fullBootstrap(story, schemaName);
}

async function fullBootstrap(story: Story, _schemaName: string): Promise<ScenarioInfra> {
  const testDb = await createPgTestDb({ embeddingDim: SCENARIO_EMBEDDING_DIM });
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

  return {
    sql,
    entityIdMap,
    schemaName: testDb.schemaName,
    repos,
    services,
    _testDb: testDb,
  };
}

async function probeOnlyBootstrap(_story: Story, schemaName: string): Promise<ScenarioInfra> {
  throw new Error(
    `Schema '${schemaName}' not found — run with phase: 'full' first`,
  );
}

async function resumeBootstrap(_story: Story, schemaName: string): Promise<ScenarioInfra> {
  throw new Error(
    `Resume not yet implemented — schema '${schemaName}' and checkpoint required`,
  );
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
