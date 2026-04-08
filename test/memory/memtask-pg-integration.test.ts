import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { CognitionSearchService } from "../../src/memory/cognition/cognition-search.js";
import { CognitionRepository } from "../../src/memory/cognition/cognition-repo.js";
import { RelationBuilder } from "../../src/memory/cognition/relation-builder.js";
import { CoreMemoryService } from "../../src/memory/core-memory.js";
import { EmbeddingService } from "../../src/memory/embeddings.js";
import { ExplicitSettlementProcessor } from "../../src/memory/explicit-settlement-processor.js";
import { PgTransactionBatcher } from "../../src/memory/pg-transaction-batcher.js";
import { RetrievalOrchestrator } from "../../src/memory/retrieval/retrieval-orchestrator.js";
import { RetrievalService } from "../../src/memory/retrieval.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import {
  MemoryTaskAgent,
  type MemoryFlushRequest,
  type MemoryTaskModelProvider,
} from "../../src/memory/task-agent.js";
import type { TurnSettlementPayload } from "../../src/interaction/contracts.js";
import type { NodeRef, ViewerContext } from "../../src/memory/types.js";
import { NarrativeSearchService } from "../../src/memory/narrative/narrative-search.js";
import { PgAreaWorldProjectionRepo } from "../../src/storage/domain-repos/pg/area-world-projection-repo.js";
import { PgCognitionEventRepo } from "../../src/storage/domain-repos/pg/cognition-event-repo.js";
import { PgCognitionProjectionRepo } from "../../src/storage/domain-repos/pg/cognition-projection-repo.js";
import { PgCognitionSearchRepo } from "../../src/storage/domain-repos/pg/cognition-search-repo.js";
import { PgCoreMemoryBlockRepo } from "../../src/storage/domain-repos/pg/core-memory-block-repo.js";
import { PgEmbeddingRepo } from "../../src/storage/domain-repos/pg/embedding-repo.js";
import { PgEpisodeRepo } from "../../src/storage/domain-repos/pg/episode-repo.js";
import { PgGraphMutableStoreRepo } from "../../src/storage/domain-repos/pg/graph-mutable-store-repo.js";
import { PgGraphReadQueryRepo } from "../../src/storage/domain-repos/pg/graph-read-query-repo.js";
import { PgNarrativeSearchRepo } from "../../src/storage/domain-repos/pg/narrative-search-repo.js";
import { PgNodeScoreRepo } from "../../src/storage/domain-repos/pg/node-score-repo.js";
import { PgNodeScoringQueryRepo } from "../../src/storage/domain-repos/pg/node-scoring-query-repo.js";
import { PgPromotionQueryRepo } from "../../src/storage/domain-repos/pg/promotion-query-repo.js";
import { PgRelationReadRepo } from "../../src/storage/domain-repos/pg/relation-read-repo.js";
import { PgRelationWriteRepo } from "../../src/storage/domain-repos/pg/relation-write-repo.js";
import { PgRetrievalReadRepo } from "../../src/storage/domain-repos/pg/retrieval-read-repo.js";
import { PgSearchProjectionRepo } from "../../src/storage/domain-repos/pg/search-projection-repo.js";
import { PgSemanticEdgeRepo } from "../../src/storage/domain-repos/pg/semantic-edge-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import type { JobEntry, JobPersistence } from "../../src/jobs/persistence.js";
import {
  createTestPgAppPool,
  ensureTestPgAppDb,
  teardownAppPool,
  withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

const TX_ROLLBACK = Symbol("tx_rollback");

const ref = (value: string): NodeRef => value as NodeRef;

async function bootstrapAllSchemas(sql: postgres.Sql): Promise<void> {
  await bootstrapTruthSchema(sql);
  await bootstrapOpsSchema(sql);
  await bootstrapDerivedSchema(sql);
}

async function withRollbackTx(
  sql: postgres.Sql,
  fn: (tx: postgres.Sql) => Promise<void>,
): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx as unknown as postgres.Sql);
      throw TX_ROLLBACK;
    });
  } catch (error) {
    if (error !== TX_ROLLBACK) {
      throw error;
    }
  }
}

function makeViewerContext(agentId: string): ViewerContext {
  return {
    viewer_agent_id: agentId,
    viewer_role: "rp_agent",
    session_id: "session-t13",
    current_area_id: 1,
  };
}

function createNoopJobPersistence(): JobPersistence {
  return {
    async enqueue(): Promise<void> {},
    async claim(): Promise<boolean> {
      return false;
    },
    async complete(): Promise<void> {},
    async fail(): Promise<void> {},
    async retry(): Promise<boolean> {
      return false;
    },
    async listPending(): Promise<JobEntry[]> {
      return [];
    },
    async listRetryable(): Promise<JobEntry[]> {
      return [];
    },
    async countByStatus(): Promise<number> {
      return 0;
    },
  };
}

function createGraphStorage(sql: postgres.Sql): GraphStorageService {
  return GraphStorageService.withDomainRepos({
    graphStoreRepo: new PgGraphMutableStoreRepo(sql),
    searchProjectionRepo: new PgSearchProjectionRepo(sql),
    embeddingRepo: new PgEmbeddingRepo(sql),
    semanticEdgeRepo: new PgSemanticEdgeRepo(sql),
    nodeScoreRepo: new PgNodeScoreRepo(sql),
    coreMemoryBlockRepo: new PgCoreMemoryBlockRepo(sql),
    episodeRepo: new PgEpisodeRepo(sql),
    cognitionEventRepo: new PgCognitionEventRepo(sql),
    cognitionProjectionRepo: new PgCognitionProjectionRepo(sql),
    areaWorldProjectionRepo: new PgAreaWorldProjectionRepo(sql),
  });
}

function createMemoryTaskAgent(
  sql: postgres.Sql,
  modelProvider: MemoryTaskModelProvider,
  sqlForFactory?: postgres.Sql,
): { agent: MemoryTaskAgent; coreMemory: CoreMemoryService } {
  const graphStorage = createGraphStorage(sql);
  const coreMemory = new CoreMemoryService(new PgCoreMemoryBlockRepo(sql));
  const embeddings = new EmbeddingService(new PgEmbeddingRepo(sql), new PgTransactionBatcher());

  const cognitionProjectionRepo = new PgCognitionProjectionRepo(sql);
  const cognitionRepo = new CognitionRepository({
    cognitionProjectionRepo,
    cognitionEventRepo: new PgCognitionEventRepo(sql),
    searchProjectionRepo: new PgSearchProjectionRepo(sql),
    entityResolver: (pointerKey: string, agentId: string) =>
      cognitionProjectionRepo.resolveEntityByPointerKey(pointerKey, agentId),
  });
  const relationBuilder = new RelationBuilder({
    relationWriteRepo: new PgRelationWriteRepo(sql),
    relationReadRepo: new PgRelationReadRepo(sql),
    cognitionProjectionRepo,
  });

  const agent = new MemoryTaskAgent(
    {
      sqlFactory: () => sqlForFactory ?? sql,
      graphMutableStoreRepo: new PgGraphMutableStoreRepo(sql),
      graphReadQueryRepo: new PgGraphReadQueryRepo(sql),
      episodeRepo: new PgEpisodeRepo(sql),
      promotionQueryRepo: new PgPromotionQueryRepo(sql),
      areaWorldProjectionRepo: new PgAreaWorldProjectionRepo(sql),
      explicitSettlement: {
        cognitionRepo,
        relationBuilder,
        relationWriteRepo: new PgRelationWriteRepo(sql),
        cognitionProjectionRepo,
        episodeRepo: new PgEpisodeRepo(sql),
      },
    },
    graphStorage,
    coreMemory,
    embeddings,
    modelProvider,
    undefined,
    createNoopJobPersistence(),
    false,
    new PgNodeScoringQueryRepo(sql),
  );

  return { agent, coreMemory };
}

describe.skipIf(skipPgTests)("T13 memtask PG full-chain integration", () => {
  let pool: postgres.Sql;

  beforeAll(async () => {
    await ensureTestPgAppDb();
    pool = createTestPgAppPool();
  });

  afterAll(async () => {
    await teardownAppPool(pool);
  });

  it("flush chain: entities + cognition written to PG", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);

      await withRollbackTx(sql, async (tx) => {
        const txSql = tx as unknown as postgres.Sql;
        const graphStoreRepo = new PgGraphMutableStoreRepo(txSql);
        await graphStoreRepo.upsertEntity({
          pointerKey: "__user__",
          displayName: "User",
          entityType: "person",
          memoryScope: "shared_public",
        });

        const modelProvider: MemoryTaskModelProvider = {
          defaultEmbeddingModelId: "test-embed-model",
          chat: async (_messages, tools) => {
            if (tools.some((tool) => tool.name === "update_index_block")) {
              return [];
            }
            return [
              {
                name: "create_entity",
                arguments: {
                  pointer_key: "maid:aria",
                  display_name: "Aria",
                  entity_type: "person",
                  memory_scope: "private_overlay",
                },
              },
              {
                name: "create_episode_event",
                arguments: {
                  role: "assistant",
                  private_notes: "Aria observed the room.",
                  salience: 0.75,
                  emotion: "calm",
                  event_category: "observation",
                  primary_actor_entity_id: "maid:aria",
                  projection_class: "none",
                  source_record_id: "t13-flush-record-1",
                },
              },
              {
                name: "upsert_assertion",
                arguments: {
                  source: "maid:aria",
                  target: "__user__",
                  predicate: "serves",
                  basis: "first_hand",
                  stance: "accepted",
                },
              },
            ];
          },
          embed: async () => [],
        };

        const txBeginShim = {
          begin: async <T>(fn: (innerTx: unknown) => Promise<T>): Promise<T> =>
            fn(txSql),
        } as unknown as postgres.Sql;

        const { agent, coreMemory } = createMemoryTaskAgent(
          txSql,
          modelProvider,
          txBeginShim,
        );
        await coreMemory.initializeBlocks("agent-t13");

        const flushRequest: MemoryFlushRequest = {
          sessionId: "session-t13",
          agentId: "agent-t13",
          rangeStart: 1,
          rangeEnd: 1,
          flushMode: "manual",
          idempotencyKey: "t13-flush-001",
          dialogueRecords: [
            {
              role: "user",
              content: "Please remember Aria serves the user.",
              timestamp: Date.now(),
            },
          ],
        };

        await agent.runMigrate(flushRequest);

        const entityRows = await txSql<{ c: number | string }[]>`
          SELECT COUNT(*) AS c
          FROM entity_nodes
          WHERE pointer_key = ${"maid:aria"}
        `;
        const privateEpisodeRows = await txSql<{ c: number | string }[]>`
          SELECT COUNT(*) AS c
          FROM private_episode_events
          WHERE agent_id = ${"agent-t13"}
            AND summary = ${""}
        `;
        const cognitionRows = await txSql<{ c: number | string }[]>`
          SELECT COUNT(*) AS c
          FROM private_cognition_current
          WHERE agent_id = ${"agent-t13"}
            AND kind = 'assertion'
            AND summary_text LIKE ${"serves:%"}
        `;

        expect(Number(entityRows[0].c)).toBeGreaterThan(0);
        expect(Number(privateEpisodeRows[0].c)).toBeGreaterThan(0);
        expect(Number(cognitionRows[0].c)).toBeGreaterThan(0);
      });
    });
  });

  it("settlement chain: explicit cognition ops via ExplicitSettlementProcessor", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);

      await withRollbackTx(sql, async (tx) => {
        const txSql = tx as unknown as postgres.Sql;
        const graphStoreRepo = new PgGraphMutableStoreRepo(txSql);
        await graphStoreRepo.upsertEntity({
          pointerKey: "__self__",
          displayName: "Self",
          entityType: "person",
          memoryScope: "private_overlay",
          ownerAgentId: "agent-t13-settlement",
        });
        await graphStoreRepo.upsertEntity({
          pointerKey: "__user__",
          displayName: "User",
          entityType: "person",
          memoryScope: "shared_public",
        });

        const cognitionProjectionRepo = new PgCognitionProjectionRepo(txSql);
        const cognitionRepo = new CognitionRepository({
          cognitionProjectionRepo,
          cognitionEventRepo: new PgCognitionEventRepo(txSql),
          searchProjectionRepo: new PgSearchProjectionRepo(txSql),
          entityResolver: (pointerKey: string, agentId: string) =>
            cognitionProjectionRepo.resolveEntityByPointerKey(pointerKey, agentId),
        });
        const relationBuilder = new RelationBuilder({
          relationWriteRepo: new PgRelationWriteRepo(txSql),
          relationReadRepo: new PgRelationReadRepo(txSql),
          cognitionProjectionRepo,
        });

        const processor = new ExplicitSettlementProcessor(
          {
            cognitionRepo,
            relationBuilder,
            relationWriteRepo: new PgRelationWriteRepo(txSql),
            cognitionProjectionRepo,
            episodeRepo: new PgEpisodeRepo(txSql),
          },
          {
            getEntityById: () => null,
            resolveEntityByPointerKey: () => null,
          } as unknown as GraphStorageService,
          {
            chat: async () => [],
          },
          async () => ({ entities: [], privateBeliefs: [] }),
          async () => {},
        );

        const settlementId = "t13-settlement-001";
        const requestId = "t13-request-001";

        const payload: TurnSettlementPayload = {
          settlementId,
          requestId,
          sessionId: "session-t13",
          ownerAgentId: "agent-t13-settlement",
          publicReply: "ack",
          hasPublicReply: true,
          viewerSnapshot: {
            selfPointerKey: "__self__",
            userPointerKey: "__user__",
          },
          privateCognition: {
            schemaVersion: "rp_private_cognition_v4",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "assertion",
                  key: "t13:settlement:assertion:1",
                  holderId: { kind: "special", value: "self" },
                  claim: "serves",
                  entityRefs: [
                    { kind: "special", value: "self" },
                    { kind: "special", value: "user" },
                  ],
                  stance: "accepted",
                  basis: "first_hand",
                },
              },
            ],
          },
        };

        const flushRequest: MemoryFlushRequest = {
          sessionId: "session-t13",
          agentId: "agent-t13-settlement",
          rangeStart: 1,
          rangeEnd: 1,
          flushMode: "manual",
          idempotencyKey: "t13-settlement-flush-001",
        };

        await processor.process(
          flushRequest,
          {
            batchId: "t13-batch-001",
            agentId: "agent-t13-settlement",
            sessionId: "session-t13",
            dialogue: [],
            attachments: [
              {
                recordType: "turn_settlement",
                payload,
                committedAt: Date.now(),
                correlatedTurnId: requestId,
                explicitMeta: {
                  settlementId,
                  requestId,
                  ownerAgentId: "agent-t13-settlement",
                  privateCognition: payload.privateCognition!,
                },
              },
            ],
            explicitSettlements: [
              {
                settlementId,
                requestId,
                ownerAgentId: "agent-t13-settlement",
                privateCognition: payload.privateCognition!,
              },
            ],
          },
          {
            episodeEventIds: [],
            assertionIds: [],
            entityIds: [],
            factIds: [],
            changedNodeRefs: [],
          },
          [],
          {
            agentRole: "rp_agent",
            skipEnforcement: true,
          },
        );

        const cognitionRows = await txSql<{ c: number | string }[]>`
          SELECT COUNT(*) AS c
          FROM private_cognition_current
          WHERE agent_id = ${"agent-t13-settlement"}
            AND cognition_key = ${"t13:settlement:assertion:1"}
        `;
        expect(Number(cognitionRows[0].c)).toBe(1);
      });
    });
  });

  it("vector retrieval: localizeSeedsHybrid fires semantic branch when queryEmbedding provided", async () => {
    await withTestAppSchema(pool, async (sql) => {
      await bootstrapAllSchemas(sql);

      await withRollbackTx(sql, async (tx) => {
        const txSql = tx as unknown as postgres.Sql;

        const embeddingRepo = new PgEmbeddingRepo(txSql);
        const embeddingService = new EmbeddingService(
          embeddingRepo,
          new PgTransactionBatcher(),
        );

        const narrativeSearchService = new NarrativeSearchService(
          new PgNarrativeSearchRepo(txSql),
        );
        const cognitionProjectionRepo = new PgCognitionProjectionRepo(txSql);
        const cognitionSearchService = new CognitionSearchService(
          new PgCognitionSearchRepo(txSql),
          new PgRelationReadRepo(txSql),
          cognitionProjectionRepo,
        );
        const currentProjectionReader =
          cognitionSearchService.createCurrentProjectionReader();
        const retrievalOrchestrator = new RetrievalOrchestrator({
          narrativeService: narrativeSearchService,
          cognitionService: cognitionSearchService,
          currentProjectionReader,
        });

        const retrievalService = new RetrievalService({
          retrievalRepo: new PgRetrievalReadRepo(txSql),
          embeddingService,
          narrativeSearch: narrativeSearchService,
          cognitionSearch: cognitionSearchService,
          orchestrator: retrievalOrchestrator,
        });

        const modelId = "t13-vector-model";
        const dims = 1536;
        const stored = new Float32Array(dims);
        stored[0] = 1;
        const query = new Float32Array(dims);
        query[0] = 1;

        await embeddingRepo.upsert(
          ref("event:9001"),
          "event",
          "primary",
          modelId,
          stored,
        );

        const seeds = await retrievalService.localizeSeedsHybrid(
          "semantic-only probe",
          makeViewerContext("agent-t13-vector"),
          10,
          query,
          modelId,
        );

        expect(seeds.length).toBeGreaterThan(0);
        expect(seeds.some((seed) => seed.semantic_score > 0)).toBe(true);
      });
    });
  });
});
