import type { AgentRole } from "../agents/profile.js";
import { MaidsClawError } from "../core/errors.js";
import type { MemoryFlushRequest as CoreMemoryFlushRequest } from "../core/types.js";
import type { InteractionRecord, TurnSettlementPayload } from "../interaction/contracts.js";
import { SUBMIT_RP_TURN_ARTIFACT_CONTRACTS } from "../runtime/submit-rp-turn-tool.js";
import type { PrivateCognitionCommitV4 } from "../runtime/rp-turn-contract.js";
import type { WriteTemplate } from "./contracts/write-template.js";
import { CognitionRepository } from "./cognition/cognition-repo.js";
import { CoreMemoryIndexUpdater } from "./core-memory-index-updater.js";
import {
  ExplicitSettlementProcessor,
  type ExplicitSettlementProcessorDeps,
} from "./explicit-settlement-processor.js";
import { RelationBuilder } from "./cognition/relation-builder.js";
import { GraphOrganizer } from "./graph-organizer.js";
import { makeNodeRef } from "./schema.js";
import type { SettlementLedger } from "./settlement-ledger.js";
import type { JobPersistence } from "../jobs/persistence.js";
import { JOB_MAX_ATTEMPTS } from "../jobs/types.js";
import type { CoreMemoryService } from "./core-memory.js";
import type { EmbeddingService } from "./embeddings.js";
import type { MaterializationService } from "./materialization.js";
import type { GraphStorageService } from "./storage.js";
import type { AssertionBasis, AssertionStance } from "../runtime/rp-turn-contract.js";
import type { NodeScoringQueryRepo } from "../storage/domain-repos/contracts/node-scoring-query-repo.js";
import type postgres from "postgres";
import type { GraphMutableStoreRepo } from "../storage/domain-repos/contracts/graph-mutable-store-repo.js";
import type { GraphReadQueryRepo } from "../storage/domain-repos/contracts/graph-read-query-repo.js";
import type { EpisodeRepo } from "../storage/domain-repos/contracts/episode-repo.js";
import type { PromotionQueryRepo } from "../storage/domain-repos/contracts/promotion-query-repo.js";
import type { AreaWorldProjectionRepo } from "../storage/domain-repos/contracts/area-world-projection-repo.js";
import type { CognitionProjectionRepo } from "../storage/domain-repos/contracts/cognition-projection-repo.js";
import { PgCognitionProjectionRepo } from "../storage/domain-repos/pg/cognition-projection-repo.js";
import { PgCognitionEventRepo } from "../storage/domain-repos/pg/cognition-event-repo.js";
import { PgSearchProjectionRepo } from "../storage/domain-repos/pg/search-projection-repo.js";
import { PgGraphMutableStoreRepo } from "../storage/domain-repos/pg/graph-mutable-store-repo.js";
import { PgRelationWriteRepo } from "../storage/domain-repos/pg/relation-write-repo.js";
import { PgRelationReadRepo } from "../storage/domain-repos/pg/relation-read-repo.js";
import { PgEpisodeRepo } from "../storage/domain-repos/pg/episode-repo.js";
import { PgPromotionQueryRepo } from "../storage/domain-repos/pg/promotion-query-repo.js";
import { PgAreaWorldProjectionRepo } from "../storage/domain-repos/pg/area-world-projection-repo.js";
import { PgGraphReadQueryRepo } from "../storage/domain-repos/pg/graph-read-query-repo.js";

import type {
  GraphOrganizerResult,
  MigrationResult,
  NodeRef,
  PrivateEventCategory,
  ProjectionClass,
} from "./types.js";

export type { MigrationResult, GraphOrganizerResult } from "./types.js";

export type DialogueRecord = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  recordId?: string;
  recordIndex?: number;
  correlatedTurnId?: string;
};

export type MemoryFlushRequest = CoreMemoryFlushRequest & {
  dialogueRecords?: DialogueRecord[];
  queueOwnerAgentId?: string;
  interactionRecords?: InteractionRecord[];
  agentRole?: AgentRole;
  writeTemplateOverride?: WriteTemplate;
};

export type GraphOrganizerJob = {
  agentId: string;
  sessionId: string;
  batchId: string;
  changedNodeRefs: NodeRef[];
  embeddingModelId: string;
};

export type ExplicitSettlementMeta = {
  settlementId: string;
  requestId: string;
  ownerAgentId: string;
  privateCognition: PrivateCognitionCommitV4;
};

export type IngestionAttachment = {
  recordType: "tool_call" | "tool_result" | "delegation" | "task_result" | "turn_settlement";
  payload: unknown;
  committedAt: number;
  correlatedTurnId?: string;
  explicitMeta?: ExplicitSettlementMeta;
};

export type IngestionInput = {
  batchId: string;
  agentId: string;
  sessionId: string;
  dialogue: DialogueRecord[];
  attachments: IngestionAttachment[];
  explicitSettlements: ExplicitSettlementMeta[];
};

export type ToolCallResult = {
  name: string;
  arguments: Record<string, unknown>;
};



export type ChatToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type MemoryTaskModelProvider = {
  readonly defaultEmbeddingModelId: string;
  chat(messages: ChatMessage[], tools: ChatToolDefinition[]): Promise<ToolCallResult[]>;
  embed(texts: string[], purpose: "memory_index" | "narrative_search" | "query_expansion", modelId: string): Promise<Float32Array[]>;
};

export type CreatedState = {
  episodeEventIds: number[];
  assertionIds: number[];
  entityIds: number[];
  factIds: number[];
  changedNodeRefs: NodeRef[];
};

const CREATE_EPISODE_EVENT_TOOL_NAME = "create_episode_event";
const UPSERT_ASSERTION_TOOL_NAME = "upsert_assertion";
const EPISODE_EVENT_IDS_KEY = "episode_event_ids";
const ASSERTION_IDS_KEY = "assertion_ids";
export const ORGANIZER_CHUNK_SIZE = 50;

const CALL_ONE_TOOLS: ChatToolDefinition[] = [
  {
    name: CREATE_EPISODE_EVENT_TOOL_NAME,
    description:
      "Create private episode events. Use for owner-private thoughts, observations, and public-candidate emission.",
    inputSchema: {
      type: "object",
      required: ["role", "private_notes", "salience", "emotion", "event_category", "primary_actor_entity_id", "projection_class"],
      properties: {
        role: { type: "string" },
        private_notes: { type: "string" },
        salience: { type: "number" },
        emotion: { type: "string" },
        event_category: { type: "string" },
        primary_actor_entity_id: { type: ["number", "string", "null"] },
        projection_class: { type: "string" },
        location_entity_id: { type: ["number", "string", "null"] },
        event_id: { type: ["number", "null"] },
        projectable_summary: { type: ["string", "null"] },
        source_record_id: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_entity",
    description: "Create or upsert entity nodes in shared_public or private_overlay scopes.",
    inputSchema: {
      type: "object",
      required: ["pointer_key", "display_name", "entity_type", "memory_scope"],
      properties: {
        pointer_key: { type: "string" },
        display_name: { type: "string" },
        entity_type: { type: "string" },
        memory_scope: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: UPSERT_ASSERTION_TOOL_NAME,
    description: "Upsert private assertions between entities.",
    inputSchema: {
      type: "object",
      required: ["source", "target", "predicate", "basis", "stance"],
      properties: {
        source: { type: ["number", "string"] },
        target: { type: ["number", "string"] },
        predicate: { type: "string" },
        basis: { type: "string", enum: ["first_hand", "hearsay", "inference", "introspection", "belief"] },
        stance: { type: "string", enum: ["hypothetical", "tentative", "accepted", "confirmed", "rejected", "abandoned"] },
        provenance: { type: ["string", "null"] },
        source_event_ref: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_alias",
    description: "Create aliases that map alternative names to canonical entity IDs.",
    inputSchema: {
      type: "object",
      required: ["canonical_id", "alias", "alias_type"],
      properties: {
        canonical_id: { type: ["number", "string"] },
        alias: { type: "string" },
        alias_type: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_logic_edge",
    description: "Create causal, temporal, or same_episode links between event IDs.",
    inputSchema: {
      type: "object",
      required: ["source_event_id", "target_event_id", "relation_type"],
      properties: {
        source_event_id: { type: "number" },
        target_event_id: { type: "number" },
        relation_type: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

const CALL_TWO_TOOLS: ChatToolDefinition[] = [
  {
    name: "update_index_block",
    description: "Rewrite the memory index block using pointer addresses like @pointer_key, #topic, e:id, and f:id.",
    inputSchema: {
      type: "object",
      required: ["new_text"],
      properties: {
        new_text: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

const EXPLICIT_SUPPORT_TOOL_NAMES = new Set(["create_entity", "create_alias", "create_logic_edge"]);
const EXPLICIT_SUPPORT_TOOLS: ChatToolDefinition[] = CALL_ONE_TOOLS.filter((tool) => EXPLICIT_SUPPORT_TOOL_NAMES.has(tool.name));

export class MemoryIngestionPolicy {
  constructor(private readonly interactionLogReader?: (request: MemoryFlushRequest) => InteractionRecord[]) {}

  buildMigrateInput(flushRequest: MemoryFlushRequest): IngestionInput {
    const records = this.interactionLogReader?.(flushRequest) ?? [];
    const allRecords = [...records, ...(flushRequest.interactionRecords ?? [])];
    const dialogueFromFlush = (flushRequest.dialogueRecords ?? []).filter((record) => {
      if (record.recordIndex === undefined) {
        return true;
      }
      return record.recordIndex >= flushRequest.rangeStart && record.recordIndex <= flushRequest.rangeEnd;
    });

    const dialogueFromLog = allRecords
      .filter((record) => record.recordType === "message")
      .filter((record) => record.recordIndex >= flushRequest.rangeStart && record.recordIndex <= flushRequest.rangeEnd)
      .map((record): DialogueRecord | undefined => {
        const payload = record.payload as { role?: string; content?: string };
        if (payload.role !== "user" && payload.role !== "assistant") {
          return undefined;
        }
        return {
          role: payload.role,
          content: typeof payload.content === "string" ? payload.content : "",
          timestamp: record.committedAt,
          recordId: record.recordId,
          recordIndex: record.recordIndex,
          correlatedTurnId: record.correlatedTurnId,
        } satisfies DialogueRecord;
      })
      .filter((record): record is DialogueRecord => record !== undefined);

    const hasSettlementInRange = allRecords.some(
      (record) =>
        record.recordType === "turn_settlement" &&
        record.recordIndex >= flushRequest.rangeStart &&
        record.recordIndex <= flushRequest.rangeEnd,
    );

    const seenRecordIds = new Set<string>();
    const mergedDialogue = [...dialogueFromLog, ...dialogueFromFlush]
      .sort((a, b) => a.timestamp - b.timestamp)
      .filter((record) => {
        if (record.recordId) {
          if (seenRecordIds.has(record.recordId)) return false;
          seenRecordIds.add(record.recordId);
        }
        return true;
      })
      .filter((record) => hasSettlementInRange || record.content.trim().length > 0);

    const attachments = allRecords
      .filter(
        (record) =>
          (record.recordType === "tool_call" ||
            record.recordType === "tool_result" ||
            record.recordType === "delegation" ||
            record.recordType === "task_result" ||
            record.recordType === "turn_settlement") &&
          record.recordIndex >= flushRequest.rangeStart &&
          record.recordIndex <= flushRequest.rangeEnd,
      )
      .map((record) => ({
        recordType: record.recordType,
        payload: record.payload,
        committedAt: record.committedAt,
        correlatedTurnId: record.correlatedTurnId,
      })) as IngestionAttachment[];

    const explicitSettlements: ExplicitSettlementMeta[] = [];
    for (const attachment of attachments) {
      if (attachment.recordType !== "turn_settlement") continue;
      const p = attachment.payload as TurnSettlementPayload | undefined;
      if (!p || !p.privateCognition || !p.privateCognition.ops || p.privateCognition.ops.length === 0) continue;
      const meta: ExplicitSettlementMeta = {
        settlementId: p.settlementId,
        requestId: p.requestId,
        ownerAgentId: p.ownerAgentId,
        privateCognition: p.privateCognition,
      };
      attachment.explicitMeta = meta;
      explicitSettlements.push(meta);
    }

    return {
      batchId: flushRequest.idempotencyKey,
      agentId: flushRequest.agentId,
      sessionId: flushRequest.sessionId,
      dialogue: mergedDialogue,
      attachments,
      explicitSettlements,
    };
  }
}

type MemoryTaskDbAdapter = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  transaction?<T>(fn: () => T): T | (() => T);
};

const throwingMemoryDbAdapter: MemoryTaskDbAdapter = {
  exec(sql: string): void {
    throw new Error(
      `[MemoryTaskAgent] exec() not available without db adapter: exec("${sql}")`,
    );
  },
  prepare(sql: string) {
    throw new Error(
      `[MemoryTaskAgent] prepare() not available without db adapter: prepare("${sql}")`,
    );
  },
};

export type MemoryTaskAgentDeps = {
  db?: MemoryTaskDbAdapter;
  explicitSettlement?: ExplicitSettlementProcessorDeps;
  sqlFactory?: () => postgres.Sql;
  graphMutableStoreRepo?: GraphMutableStoreRepo;
  graphReadQueryRepo?: GraphReadQueryRepo;
  episodeRepo?: EpisodeRepo;
  promotionQueryRepo?: PromotionQueryRepo;
  areaWorldProjectionRepo?: AreaWorldProjectionRepo;
};

export class MemoryTaskAgent {
  private readonly db: MemoryTaskDbAdapter;
  private readonly sqlFactory?: () => postgres.Sql;
  private readonly graphMutableStoreRepo?: GraphMutableStoreRepo;
  private readonly graphReadQueryRepo?: GraphReadQueryRepo;
  private readonly episodeRepo?: EpisodeRepo;
  private readonly promotionQueryRepo?: PromotionQueryRepo;
  private readonly areaWorldProjectionRepo?: AreaWorldProjectionRepo;
  private readonly settlementLedger?: SettlementLedger;
  private readonly cognitionOpsRepo: Pick<CognitionRepository, "getAssertions" | "getCommitments" | "upsertAssertion">;
  private readonly modelProvider: MemoryTaskModelProvider;
  private readonly ingestionPolicy: MemoryIngestionPolicy;
  private readonly explicitSettlementProcessor: ExplicitSettlementProcessor;
  private readonly coreMemoryIndexUpdater: CoreMemoryIndexUpdater;
  private readonly graphOrganizer: GraphOrganizer;
  private readonly jobPersistence?: JobPersistence;
  private migrateTail: Promise<unknown> = Promise.resolve();
  private organizeTail: Promise<unknown> = Promise.resolve();

  constructor(
    deps: MemoryTaskAgentDeps,
    private readonly storage: GraphStorageService,
    private readonly coreMemory: CoreMemoryService,
    private readonly embeddings: EmbeddingService,
    private readonly materialization: MaterializationService,
    modelProvider?: MemoryTaskModelProvider,
    settlementLedger?: SettlementLedger,
    jobPersistence?: JobPersistence,
    private readonly strictDurableMode = false,
    nodeScoringQueryRepo?: NodeScoringQueryRepo,
  ) {
    this.db = deps.db ?? throwingMemoryDbAdapter;
    this.sqlFactory = deps.sqlFactory;
    this.graphMutableStoreRepo = deps.graphMutableStoreRepo;
    this.graphReadQueryRepo = deps.graphReadQueryRepo;
    this.episodeRepo = deps.episodeRepo;
    this.promotionQueryRepo = deps.promotionQueryRepo;
    this.areaWorldProjectionRepo = deps.areaWorldProjectionRepo;
    this.settlementLedger = settlementLedger;
    this.modelProvider =
      modelProvider ??
      ({
        defaultEmbeddingModelId: "",
        chat: async () => {
          throw new Error("MemoryTaskAgent requires modelProvider.chat");
        },
        embed: async () => {
          throw new Error("MemoryTaskAgent requires modelProvider.embed");
        },
      } satisfies MemoryTaskModelProvider);
    this.ingestionPolicy = new MemoryIngestionPolicy();
    const explicitSettlementDeps = deps.explicitSettlement ?? {
      db: this.db,
      cognitionRepo: new CognitionRepository(this.db),
      relationBuilder: new RelationBuilder(this.db),
      relationWriteRepo: {
        upsertRelation: async (): Promise<void> => { throw new Error("relationWriteRepo not configured for PG"); },
        getRelationsBySource: async (): Promise<never[]> => { throw new Error("relationWriteRepo not configured for PG"); },
        getRelationsForNode: async (): Promise<never[]> => { throw new Error("relationWriteRepo not configured for PG"); },
      },
      cognitionProjectionRepo: {
        upsertFromEvent: async (): Promise<void> => { throw new Error("cognitionProjectionRepo not configured for PG"); },
        rebuild: async (): Promise<void> => { throw new Error("cognitionProjectionRepo not configured for PG"); },
        getCurrent: async (): Promise<null> => { throw new Error("cognitionProjectionRepo not configured for PG"); },
        getAllCurrent: async (): Promise<never[]> => { throw new Error("cognitionProjectionRepo not configured for PG"); },
        updateConflictFactors: async (): Promise<void> => { throw new Error("cognitionProjectionRepo not configured for PG"); },
        patchRecordJsonSourceEventRef: async (): Promise<void> => { throw new Error("cognitionProjectionRepo not configured for PG"); },
        resolveEntityByPointerKey: async (): Promise<null> => { throw new Error("cognitionProjectionRepo not configured for PG"); },
      },
    };
    this.cognitionOpsRepo = explicitSettlementDeps.cognitionRepo;
    this.explicitSettlementProcessor = new ExplicitSettlementProcessor(
      explicitSettlementDeps,
      this.storage,
      this.modelProvider,
      (agentId) => this.loadExistingContext(agentId),
      async (request, toolCalls, created) => {
        await this.applyCallOneToolCalls(request, toolCalls, created);
      },
      settlementLedger,
    );
    this.coreMemoryIndexUpdater = new CoreMemoryIndexUpdater(this.coreMemory, this.modelProvider);
    this.graphOrganizer = new GraphOrganizer(
      nodeScoringQueryRepo ?? (() => { throw new Error("nodeScoringQueryRepo is required"); })(),
      this.storage,
      this.coreMemory,
      this.embeddings,
      this.modelProvider,
    );
    this.jobPersistence = jobPersistence;
    if (this.strictDurableMode && !this.jobPersistence) {
      console.warn(
        "[MemoryTaskAgent] strictDurableMode=true but no jobPersistence provided; durable enqueue will always throw",
      );
  }
  }

  runMigrate(flushRequest: MemoryFlushRequest): Promise<MigrationResult> {
    const queued = this.migrateTail.then(() => this.runMigrateInternal(flushRequest));
    this.migrateTail = queued.catch(() => undefined);
    return queued;
  }

  runOrganize(job: GraphOrganizerJob): Promise<GraphOrganizerResult> {
    const queued = this.organizeTail.then(() => this.runOrganizeInternal(job));
    this.organizeTail = queued.catch(() => undefined);
    return queued;
  }

  private async runMigrateInternal(flushRequest: MemoryFlushRequest): Promise<MigrationResult> {
    this.assertQueueOwnership(flushRequest);
    const ingest = this.ingestionPolicy.buildMigrateInput(flushRequest);
    const created: CreatedState = {
      episodeEventIds: [],
      assertionIds: [],
      entityIds: [],
      factIds: [],
      changedNodeRefs: [],
    };

    let areaCandidates: Array<{
      id: number;
      event_id: number | null;
      agent_id: string;
      role: string | null;
      private_notes: string | null;
      salience: number | null;
      emotion: string | null;
      event_category: PrivateEventCategory;
      primary_actor_entity_id: number | null;
      projection_class: ProjectionClass;
      location_entity_id: number | null;
      projectable_summary: string | null;
      source_record_id: string | null;
      created_at: number;
    }> = [];

    const runFlushBody = async (
      settlementProcessor: ExplicitSettlementProcessor,
      loadContext: () => Promise<{ entities: unknown[]; privateBeliefs: unknown[] }>,
      applyCalls: (toolCalls: ToolCallResult[]) => Promise<Array<{
        id: number;
        event_id: number | null;
        agent_id: string;
        role: string | null;
        private_notes: string | null;
        salience: number | null;
        emotion: string | null;
        event_category: PrivateEventCategory;
        primary_actor_entity_id: number | null;
        projection_class: ProjectionClass;
        location_entity_id: number | null;
        projectable_summary: string | null;
        source_record_id: string | null;
        created_at: number;
      }>>,
      createSameEpisodeEdges: (privateEvents: Array<{ event_id: number | null }>) => Promise<void>,
    ): Promise<void> => {
      const existingContext = await loadContext();

      await settlementProcessor.process(flushRequest, ingest, created, EXPLICIT_SUPPORT_TOOLS, {
        agentRole: flushRequest.agentRole ?? "rp_agent",
        writeTemplateOverride: flushRequest.writeTemplateOverride,
        agentId: flushRequest.agentId,
        artifactContracts: SUBMIT_RP_TURN_ARTIFACT_CONTRACTS,
      });

      const explicitRequestIds = new Set(ingest.explicitSettlements.map((meta) => meta.requestId));
      const dedupedIngest: IngestionInput = {
        ...ingest,
        dialogue: ingest.dialogue.filter(
          (row) => !row.correlatedTurnId || !explicitRequestIds.has(row.correlatedTurnId),
        ),
        attachments: ingest.attachments.filter((attachment) => {
          if (attachment.correlatedTurnId && explicitRequestIds.has(attachment.correlatedTurnId)) {
            return false;
          }
          if (attachment.recordType === "turn_settlement") {
            const payload = attachment.payload as TurnSettlementPayload | undefined;
            if (payload?.requestId && explicitRequestIds.has(payload.requestId)) {
              return false;
            }
          }
          return true;
        }),
        explicitSettlements: [],
      };

      const callOne = await this.modelProvider.chat(
        [
          {
            role: "system",
            content:
              "You are a memory migration engine. Phase 1 Extract: identify durable events/entities/relationships. Phase 2 Compare: check current graph context for duplicates/conflicts within same scope only. Phase 3 Synthesize: keep surprising and persistent information. Classify each output as shared_public or owner_private.",
          },
          {
            role: "user",
            content: JSON.stringify({ ingest: dedupedIngest, existingContext }),
          },
        ],
        CALL_ONE_TOOLS,
      );

      const createdPrivateEvents = await applyCalls(callOne);
      areaCandidates = createdPrivateEvents.filter((event) => event.projection_class === "area_candidate");
      await createSameEpisodeEdges(createdPrivateEvents);
    };

    const sql = this.sqlFactory?.();
    if (sql) {
      await sql.begin(async (tx) => {
        const txSql = tx as unknown as postgres.Sql;

        const txCognitionProjectionRepo = new PgCognitionProjectionRepo(txSql);
        const txCognitionEventRepo = new PgCognitionEventRepo(txSql);
        const txSearchProjectionRepo = new PgSearchProjectionRepo(txSql);
        const txCognitionRepo = new CognitionRepository({
          cognitionProjectionRepo: txCognitionProjectionRepo,
          cognitionEventRepo: txCognitionEventRepo,
          searchProjectionRepo: txSearchProjectionRepo,
          entityResolver: (pointerKey: string, agentId: string) =>
            txCognitionProjectionRepo.resolveEntityByPointerKey(pointerKey, agentId),
        });
        const txGraphMutableStoreRepo = new PgGraphMutableStoreRepo(txSql);
        const txGraphReadQueryRepo = new PgGraphReadQueryRepo(txSql);
        const txRelationWriteRepo = new PgRelationWriteRepo(txSql);
        const txRelationReadRepo = new PgRelationReadRepo(txSql);
        const txEpisodeRepo = new PgEpisodeRepo(txSql);

        if (this.promotionQueryRepo) {
          void new PgPromotionQueryRepo(txSql);
        }
        if (this.areaWorldProjectionRepo) {
          void new PgAreaWorldProjectionRepo(txSql);
        }

        const txRelationBuilder = new RelationBuilder({
          relationWriteRepo: txRelationWriteRepo,
          relationReadRepo: txRelationReadRepo,
          cognitionProjectionRepo: txCognitionProjectionRepo,
        });
        const txSettlementProcessor = new ExplicitSettlementProcessor(
          {
            cognitionRepo: txCognitionRepo,
            relationBuilder: txRelationBuilder,
            relationWriteRepo: txRelationWriteRepo,
            cognitionProjectionRepo: txCognitionProjectionRepo,
            episodeRepo: txEpisodeRepo,
          },
          this.storage,
          this.modelProvider,
          (agentId) => this.loadExistingContext(agentId, txGraphMutableStoreRepo, txCognitionRepo, txGraphReadQueryRepo),
          async (request, toolCalls, txCreated) => {
            await this.applyCallOneToolCalls(
              request,
              toolCalls,
              txCreated,
              txGraphMutableStoreRepo,
              txCognitionRepo,
              txEpisodeRepo,
              txCognitionProjectionRepo,
            );
          },
          this.settlementLedger,
        );

        await runFlushBody(
          txSettlementProcessor,
          () => this.loadExistingContext(flushRequest.agentId, txGraphMutableStoreRepo, txCognitionRepo, txGraphReadQueryRepo),
          (toolCalls) => this.applyCallOneToolCalls(
            flushRequest,
            toolCalls,
            created,
            txGraphMutableStoreRepo,
            txCognitionRepo,
            txEpisodeRepo,
            txCognitionProjectionRepo,
          ),
          (privateEvents) => this.createSameEpisodeEdgesForBatch(privateEvents, txGraphMutableStoreRepo, txGraphReadQueryRepo),
        );
      });

      await this.coreMemoryIndexUpdater.updateIndex(flushRequest.agentId, created, CALL_TWO_TOOLS);
    } else {
      await this.runLegacySqliteTransaction(async () => {
        await runFlushBody(
          this.explicitSettlementProcessor,
          () => this.loadExistingContext(flushRequest.agentId),
          (toolCalls) => this.applyCallOneToolCalls(flushRequest, toolCalls, created),
          (privateEvents) => this.createSameEpisodeEdgesForBatch(privateEvents),
        );
        await this.coreMemoryIndexUpdater.updateIndex(flushRequest.agentId, created, CALL_TWO_TOOLS);
      });
    }

    if (areaCandidates.length > 0) {
      this.triggerMaterialization(areaCandidates, flushRequest.agentId);
    }

    const organizeJob: GraphOrganizerJob = {
      agentId: flushRequest.agentId,
      sessionId: flushRequest.sessionId,
      batchId: flushRequest.idempotencyKey,
      changedNodeRefs: created.changedNodeRefs,
      embeddingModelId: this.modelProvider.defaultEmbeddingModelId,
    };

    if (this.jobPersistence) {
      try {
        await this.enqueueOrganizerJobs(flushRequest.agentId, flushRequest.idempotencyKey, created.changedNodeRefs);
      } catch (err) {
        if (this.strictDurableMode) {
          throw err;
        }
        console.error("[MemoryTaskAgent] organizer enqueue failed, falling back to background", {
          operation: "runMigrateInternal",
          jobType: "graph_organizer",
          batchId: organizeJob.batchId,
          agentId: organizeJob.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.launchBackgroundOrganize(organizeJob);
      }
    } else if (this.strictDurableMode) {
      throw new Error(
        `[MemoryTaskAgent] strictDurableMode requires jobPersistence for organizer dispatch (batchId=${organizeJob.batchId})`,
      );
    } else {
      /**
       * @deprecated Use durable job queue via JobPersistence instead.
       * This fire-and-forget path is preserved for backward compat when
       * no JobPersistence is configured and strictDurableMode is false.
       * Remove when all deployments supply JobPersistence.
       */
      console.error("[MemoryTaskAgent] no jobPersistence configured, using deprecated background fallback", {
        operation: "runMigrateInternal",
        jobType: "graph_organizer",
        batchId: organizeJob.batchId,
        agentId: organizeJob.agentId,
      });
      this.launchBackgroundOrganize(organizeJob);
    }

    return {
      batch_id: flushRequest.idempotencyKey,
      [EPISODE_EVENT_IDS_KEY]: created.episodeEventIds,
      [ASSERTION_IDS_KEY]: created.assertionIds,
      entity_ids: created.entityIds,
      fact_ids: created.factIds,
    };
  }
  private async runOrganizeInternal(job: GraphOrganizerJob): Promise<GraphOrganizerResult> {
    return this.graphOrganizer.run(job);
  }

  /**
   * @deprecated Use durable job queue via JobPersistence instead.
   * Preserved for backward compat when strictDurableMode is false.
   */
  private launchBackgroundOrganize(organizeJob: GraphOrganizerJob): void {
    void Promise.resolve().then(() => this.runOrganize(organizeJob)).catch((err: unknown) => {
      console.error("[MemoryTaskAgent] background organize failed", {
        batchId: organizeJob.batchId,
        sessionId: organizeJob.sessionId,
        agentId: organizeJob.agentId,
        embeddingModelId: organizeJob.embeddingModelId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async enqueueOrganizerJobs(
    agentId: string,
    settlementId: string,
    changedNodeRefs: NodeRef[],
  ): Promise<void> {
    if (!this.jobPersistence) {
      return;
    }

    const uniqueNodeRefs = Array.from(new Set(changedNodeRefs));
    if (uniqueNodeRefs.length === 0) {
      return;
    }

    const chunkCount = Math.ceil(uniqueNodeRefs.length / ORGANIZER_CHUNK_SIZE);
    const now = Date.now();
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const start = chunkIndex * ORGANIZER_CHUNK_SIZE;
      const chunkNodeRefs = uniqueNodeRefs.slice(start, start + ORGANIZER_CHUNK_SIZE);
      if (chunkNodeRefs.length === 0) {
        continue;
      }

      const ordinal = String(chunkIndex + 1).padStart(4, "0");
      await this.jobPersistence.enqueue({
        id: `memory.organize:${settlementId}:chunk:${ordinal}`,
        jobType: "memory.organize",
        payload: {
          agentId,
          chunkNodeRefs,
          settlementId,
        },
        status: "pending",
        maxAttempts: JOB_MAX_ATTEMPTS["memory.organize"],
        nextAttemptAt: now,
      });
    }
  }

  private assertQueueOwnership(flushRequest: MemoryFlushRequest): void {
    if (!flushRequest.agentId || !flushRequest.sessionId) {
      throw new Error("Invalid MemoryFlushRequest identity");
    }
    if (flushRequest.rangeStart > flushRequest.rangeEnd) {
      throw new Error("Invalid flush range");
    }
    if (flushRequest.queueOwnerAgentId && flushRequest.queueOwnerAgentId !== flushRequest.agentId) {
      throw new Error("Flush request is not queue-owned by target agent");
    }
    if (!flushRequest.idempotencyKey) {
      throw new Error("Flush request missing idempotency key");
    }
  }

  private async loadExistingContext(
    agentId: string,
    txGraphMutableStoreRepo?: GraphMutableStoreRepo,
    txCognitionRepo?: Pick<CognitionRepository, "getAssertions" | "getCommitments">,
    txGraphReadQueryRepo?: GraphReadQueryRepo,
  ): Promise<{ entities: unknown[]; privateBeliefs: unknown[] }> {
    void txGraphMutableStoreRepo;

    const graphReadQueryRepo = txGraphReadQueryRepo ?? this.graphReadQueryRepo;
    const entities = graphReadQueryRepo
      ? await graphReadQueryRepo.getEntitiesForContext(agentId, 200)
      : await this.loadEntitiesForContextSqlite(agentId);

    const cognitionRepo = txCognitionRepo ?? this.cognitionOpsRepo;
    const assertions = (await cognitionRepo.getAssertions(agentId, { activeOnly: false })).slice(0, 150);
    const commitments = (await cognitionRepo.getCommitments(agentId, { activeOnly: false })).slice(0, 50);

    const privateBeliefs = [
      ...assertions.map((row) => ({
        kind: "assertion" as const,
        id: row.id,
        source_entity_id: row.sourceEntityId,
        target_entity_id: row.targetEntityId,
        predicate: row.predicate,
        stance: row.stance,
        basis: row.basis,
        "cognition_key": row.cognitionKey,
      })),
      ...commitments.map((row) => ({
        kind: "commitment" as const,
        id: row.id,
        target_entity_id: row.targetEntityId,
        status: row.commitmentStatus,
        stance: row.status === "active" ? "accepted" : "rejected",
        basis: null,
        "cognition_key": row.cognitionKey,
      })),
    ];

    return { entities, privateBeliefs };
  }

  private async applyCallOneToolCalls(
    flushRequest: MemoryFlushRequest,
    toolCalls: ToolCallResult[],
    created: CreatedState,
    txGraphMutableStoreRepo?: GraphMutableStoreRepo,
    txCognitionRepo?: Pick<CognitionRepository, "upsertAssertion">,
    txEpisodeRepo?: EpisodeRepo,
    txCognitionProjectionRepo?: CognitionProjectionRepo,
  ): Promise<Array<{
    id: number;
    event_id: number | null;
    agent_id: string;
    role: string | null;
    private_notes: string | null;
    salience: number | null;
    emotion: string | null;
    event_category: PrivateEventCategory;
    primary_actor_entity_id: number | null;
    projection_class: ProjectionClass;
    location_entity_id: number | null;
    projectable_summary: string | null;
    source_record_id: string | null;
    created_at: number;
  }>> {
    const pointerToEntityId = new Map<string, number>();
    const cognitionRepo = txCognitionRepo ?? this.cognitionOpsRepo;
    const beliefSettlementId = `${flushRequest.idempotencyKey}:belief`;
    let beliefOpIndex = 0;
    const privateEvents: Array<{
      id: number;
      event_id: number | null;
      agent_id: string;
      role: string | null;
      private_notes: string | null;
      salience: number | null;
      emotion: string | null;
      event_category: PrivateEventCategory;
      primary_actor_entity_id: number | null;
      projection_class: ProjectionClass;
      location_entity_id: number | null;
      projectable_summary: string | null;
      source_record_id: string | null;
      created_at: number;
    }> = [];

    for (const call of toolCalls) {
      if (call.name === "create_entity") {
        const pointerKey = this.asString(call.arguments.pointer_key);
        const displayName = this.asString(call.arguments.display_name);
        const entityType = this.asString(call.arguments.entity_type);
        const memoryScopeRaw = this.asString(call.arguments.memory_scope);
        const memoryScope = memoryScopeRaw === "shared_public" ? "shared_public" : "private_overlay";
        const entityId = await this.upsertEntityCompat(
          {
            pointerKey,
            displayName,
            entityType,
            memoryScope,
            ownerAgentId: memoryScope === "private_overlay" ? flushRequest.agentId : undefined,
          },
          txGraphMutableStoreRepo,
        );
        pointerToEntityId.set(pointerKey, entityId);
        created.entityIds.push(entityId);
        created.changedNodeRefs.push(makeNodeRef("entity", entityId));
        continue;
      }

      if (call.name === CREATE_EPISODE_EVENT_TOOL_NAME) {
        const primaryActor = await this.resolveEntityReference(
          call.arguments.primary_actor_entity_id,
          flushRequest.agentId,
          pointerToEntityId,
          txGraphMutableStoreRepo,
        );
        const location = await this.resolveEntityReference(
          call.arguments.location_entity_id,
          flushRequest.agentId,
          pointerToEntityId,
          txGraphMutableStoreRepo,
        );
        const eventId = this.asOptionalNumber(call.arguments.event_id);
        const privateEventId = await this.createPrivateEventCompat({
          eventId: eventId ?? undefined,
          agentId: flushRequest.agentId,
          role: this.asString(call.arguments.role),
          privateNotes: this.asString(call.arguments.private_notes),
          salience: this.asOptionalNumber(call.arguments.salience) ?? undefined,
          emotion: this.asOptionalString(call.arguments.emotion) ?? undefined,
          eventCategory: this.asPrivateEventCategory(call.arguments.event_category),
          primaryActorEntityId: primaryActor ?? undefined,
          projectionClass: this.asProjectionClass(call.arguments.projection_class),
          locationEntityId: location ?? undefined,
          projectableSummary: this.asOptionalString(call.arguments.projectable_summary) ?? undefined,
          sourceRecordId: this.asOptionalString(call.arguments.source_record_id) ?? undefined,
        }, txGraphMutableStoreRepo);
        created.episodeEventIds.push(privateEventId);
        created.changedNodeRefs.push(makeNodeRef("evaluation", privateEventId));
        const row = await this.readPrivateEpisodeEventByIdCompat(privateEventId, txEpisodeRepo);
        const eventIdFromRow = row ? ("event_id" in row ? row.event_id : row.valid_time) : null;
        const categoryFromRow = row ? ("category" in row ? row.category : "observation") : "observation";
        privateEvents.push({
          id: row?.id ?? privateEventId,
          event_id: eventIdFromRow,
          agent_id: row?.agent_id ?? flushRequest.agentId,
          role: call.arguments.role as string | null,
          private_notes: row?.private_notes ?? null,
          salience: (call.arguments.salience as number) ?? null,
          emotion: (call.arguments.emotion as string) ?? null,
          event_category: categoryFromRow as PrivateEventCategory,
          primary_actor_entity_id: primaryActor ?? null,
          projection_class: call.arguments.projection_class as ProjectionClass,
          location_entity_id: location ?? null,
          projectable_summary: (call.arguments.projectable_summary as string) ?? null,
          source_record_id: (call.arguments.source_record_id as string) ?? null,
          created_at: row?.created_at ?? Date.now(),
        });
        continue;
      }

      if (call.name === UPSERT_ASSERTION_TOOL_NAME) {
        const stance = this.asString(call.arguments.stance);
        if (stance === "contested") {
          throw new MaidsClawError({
            code: "COGNITION_OP_UNSUPPORTED",
            message:
              "legacy upsert_assertion does not support contested writes; use submit_rp_turn with preContestedStance and conflictFactors",
            retriable: false,
            details: {
              tool: UPSERT_ASSERTION_TOOL_NAME,
              stance,
            },
          });
        }
        const source = await this.resolveEntityReference(call.arguments.source, flushRequest.agentId, pointerToEntityId, txGraphMutableStoreRepo);
        const target = await this.resolveEntityReference(call.arguments.target, flushRequest.agentId, pointerToEntityId, txGraphMutableStoreRepo);
        if (!source || !target) {
          continue;
        }
        const sourcePointerKey =
          typeof call.arguments.source === "string"
            ? call.arguments.source
            : await this.getPointerKeyByEntityIdCompat(source, txGraphMutableStoreRepo);
        const targetPointerKey =
          typeof call.arguments.target === "string"
            ? call.arguments.target
            : await this.getPointerKeyByEntityIdCompat(target, txGraphMutableStoreRepo);
        if (!sourcePointerKey || !targetPointerKey) {
          continue;
        }

        const beliefId = (await cognitionRepo.upsertAssertion({
          agentId: flushRequest.agentId,
          settlementId: beliefSettlementId,
          opIndex: beliefOpIndex,
          sourcePointerKey,
          predicate: this.asString(call.arguments.predicate),
          targetPointerKey,
          basis: this.asString(call.arguments.basis) as AssertionBasis,
          stance: stance as AssertionStance,
          provenance: this.asOptionalString(call.arguments.provenance) ?? undefined,
        })).id;
        beliefOpIndex += 1;

        const sourceEventRef = this.asOptionalNodeRef(call.arguments.source_event_ref);
        if (sourceEventRef) {
          if (txCognitionProjectionRepo) {
            await txCognitionProjectionRepo.patchRecordJsonSourceEventRef(beliefId, sourceEventRef, Date.now());
          } else {
            this.patchSourceEventRefSqlite(beliefId, sourceEventRef);
          }
        }

        created.assertionIds.push(beliefId);
        created.changedNodeRefs.push(makeNodeRef("assertion", beliefId));
        continue;
      }

      if (call.name === "create_alias") {
        const canonical = await this.resolveEntityReference(call.arguments.canonical_id, flushRequest.agentId, pointerToEntityId, txGraphMutableStoreRepo);
        if (!canonical) {
          continue;
        }
        await this.createEntityAliasCompat(
          canonical,
          this.asString(call.arguments.alias),
          this.asOptionalString(call.arguments.alias_type) ?? undefined,
          flushRequest.agentId,
          txGraphMutableStoreRepo,
        );
        continue;
      }

      if (call.name === "create_logic_edge") {
        const sourceEventId = this.asOptionalNumber(call.arguments.source_event_id);
        const targetEventId = this.asOptionalNumber(call.arguments.target_event_id);
        if (!sourceEventId || !targetEventId) {
          continue;
        }
        await this.createLogicEdgeCompat(
          sourceEventId,
          targetEventId,
          this.asLogicRelationType(this.asString(call.arguments.relation_type)),
          txGraphMutableStoreRepo,
        );
      }
    }

    return privateEvents;
  }

  private async createSameEpisodeEdgesForBatch(
    privateEvents: Array<{ event_id: number | null }>,
    txGraphMutableStoreRepo?: GraphMutableStoreRepo,
    txGraphReadQueryRepo?: GraphReadQueryRepo,
  ): Promise<void> {
    const linkedEventIds = privateEvents
      .map((event) => event.event_id)
      .filter((eventId): eventId is number => typeof eventId === "number" && eventId > 0);

    if (linkedEventIds.length < 2) {
      return;
    }

    const graphReadQueryRepo = txGraphReadQueryRepo ?? this.graphReadQueryRepo;
    const events = graphReadQueryRepo
      ? await graphReadQueryRepo.getEventsByIds(linkedEventIds)
      : await this.getEventsByIdsSqlite(linkedEventIds);

    if (events.length < 2) {
      return;
    }

    const sorted = [...events].sort((a, b) => {
      if (a.session_id !== b.session_id) {
        return a.session_id.localeCompare(b.session_id);
      }
      const topicA = a.topic_id ?? -1;
      const topicB = b.topic_id ?? -1;
      if (topicA !== topicB) {
        return topicA - topicB;
      }
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return a.id - b.id;
    });

    const dayMs = 24 * 60 * 60 * 1000;
    const insertStmt = txGraphMutableStoreRepo
      ? null
      : this.getSameEpisodeInsertStmtSqlite();

    for (let index = 0; index < sorted.length - 1; index += 1) {
      const current = sorted[index];
      const next = sorted[index + 1];
      if (current.session_id !== next.session_id) {
        continue;
      }
      if (current.topic_id !== next.topic_id) {
        continue;
      }
      if (next.timestamp - current.timestamp > dayMs) {
        continue;
      }

      if (txGraphMutableStoreRepo) {
        await txGraphMutableStoreRepo.createLogicEdge(current.id, next.id, "same_episode");
        await txGraphMutableStoreRepo.createLogicEdge(next.id, current.id, "same_episode");
      } else {
        this.insertSameEpisodeEdgeSqlite(insertStmt, current.id, next.id);
        this.insertSameEpisodeEdgeSqlite(insertStmt, next.id, current.id);
      }
    }
  }

  private async resolveEntityReference(
    value: unknown,
    agentId: string,
    pointerMap: Map<string, number>,
    txGraphMutableStoreRepo?: GraphMutableStoreRepo,
  ): Promise<number | undefined> {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
    if (typeof value !== "string" || value.length === 0) {
      return undefined;
    }

    const cached = pointerMap.get(value);
    if (cached) {
      return cached;
    }

    if (txGraphMutableStoreRepo) {
      const resolved = await txGraphMutableStoreRepo.resolveEntityByPointerKey(value, agentId);
      if (resolved) {
        pointerMap.set(value, resolved);
        return resolved;
      }
    } else {
      const resolved = this.resolveEntityReferenceSqlite(value, agentId);
      if (resolved !== undefined) {
        pointerMap.set(value, resolved);
        return resolved;
      }
    }

    return undefined;
  }

  private async runLegacySqliteTransaction(fn: () => Promise<void>): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      await fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async loadEntitiesForContextSqlite(agentId: string): Promise<unknown[]> {
    return this.db
      .prepare(
        `SELECT id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id
         FROM entity_nodes
         WHERE memory_scope = 'shared_public' OR owner_agent_id = ?
         ORDER BY updated_at DESC
         LIMIT 200`,
      )
      .all(agentId);
  }

  private async upsertEntityCompat(
    params: {
      pointerKey: string;
      displayName: string;
      entityType: string;
      memoryScope: "shared_public" | "private_overlay";
      ownerAgentId?: string;
    },
    txGraphMutableStoreRepo?: GraphMutableStoreRepo,
  ): Promise<number> {
    if (txGraphMutableStoreRepo) {
      return txGraphMutableStoreRepo.upsertEntity(params);
    }
    return this.storage.upsertEntity(params);
  }

  private async createPrivateEventCompat(
    params: {
      eventId?: number;
      agentId: string;
      role?: string;
      privateNotes?: string;
      salience?: number;
      emotion?: string;
      eventCategory: PrivateEventCategory;
      primaryActorEntityId?: number;
      projectionClass: ProjectionClass;
      locationEntityId?: number;
      projectableSummary?: string;
      sourceRecordId?: string;
    },
    txGraphMutableStoreRepo?: GraphMutableStoreRepo,
  ): Promise<number> {
    if (txGraphMutableStoreRepo) {
      return txGraphMutableStoreRepo.createPrivateEvent(params);
    }
    return this.storage.createPrivateEvent(params);
  }

  private async readPrivateEpisodeEventByIdCompat(
    id: number,
    txEpisodeRepo?: EpisodeRepo,
  ): Promise<{
    id: number;
    event_id: number | null;
    agent_id: string;
    category: string;
    private_notes: string | null;
    created_at: number;
  } | {
    id: number;
    valid_time: number | null;
    agent_id: string;
    category: string;
    private_notes: string | null;
    created_at: number;
  } | null> {
    if (txEpisodeRepo) {
      return txEpisodeRepo.readById(id);
    }
    return this.db.prepare(
      `SELECT id, valid_time as event_id, agent_id, category, summary, private_notes, committed_time, created_at FROM private_episode_events WHERE id = ?`
    ).get(id) as {
      id: number;
      event_id: number | null;
      agent_id: string;
      category: string;
      summary: string;
      private_notes: string | null;
      committed_time: number;
      created_at: number;
    } | null;
  }

  private async getPointerKeyByEntityIdCompat(
    entityId: number,
    txGraphMutableStoreRepo?: GraphMutableStoreRepo,
  ): Promise<string | undefined> {
    if (txGraphMutableStoreRepo) {
      return (await txGraphMutableStoreRepo.getEntityById(entityId))?.pointerKey;
    }
    return this.storage.getEntityById(entityId)?.pointerKey;
  }

  private patchSourceEventRefSqlite(beliefId: number, sourceEventRef: NodeRef): void {
    this.db
      .prepare(`UPDATE private_cognition_current SET source_event_ref = ?, updated_at = ? WHERE id = ?`)
      .run(sourceEventRef, Date.now(), beliefId);
  }

  private async createEntityAliasCompat(
    canonicalId: number,
    alias: string,
    aliasType: string | undefined,
    ownerAgentId: string,
    txGraphMutableStoreRepo?: GraphMutableStoreRepo,
  ): Promise<void> {
    if (txGraphMutableStoreRepo) {
      await txGraphMutableStoreRepo.createEntityAlias(canonicalId, alias, aliasType, ownerAgentId);
      return;
    }
    this.storage.createEntityAlias(canonicalId, alias, aliasType, ownerAgentId);
  }

  private async createLogicEdgeCompat(
    sourceEventId: number,
    targetEventId: number,
    relationType: "causal" | "temporal_prev" | "temporal_next" | "same_episode",
    txGraphMutableStoreRepo?: GraphMutableStoreRepo,
  ): Promise<void> {
    if (txGraphMutableStoreRepo) {
      await txGraphMutableStoreRepo.createLogicEdge(sourceEventId, targetEventId, relationType);
      return;
    }
    this.storage.createLogicEdge(sourceEventId, targetEventId, relationType);
  }

  private async getEventsByIdsSqlite(
    linkedEventIds: number[],
  ): Promise<Array<{ id: number; session_id: string; topic_id: number | null; timestamp: number }>> {
    return this.db
      .prepare(
        `SELECT id, session_id, topic_id, timestamp
         FROM event_nodes
         WHERE id IN (${linkedEventIds.map(() => "?").join(",")})`,
      )
      .all(...linkedEventIds) as Array<{ id: number; session_id: string; topic_id: number | null; timestamp: number }>;
  }

  private getSameEpisodeInsertStmtSqlite(): {
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  } {
    return this.db.prepare(
      `INSERT INTO logic_edges (source_event_id, target_event_id, relation_type, created_at)
       VALUES (?, ?, 'same_episode', ?)`,
    );
  }

  private insertSameEpisodeEdgeSqlite(
    insertStmt: { run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint } } | null,
    sourceEventId: number,
    targetEventId: number,
  ): void {
    const createdAt = Date.now();
    insertStmt?.run(sourceEventId, targetEventId, createdAt);
  }

  private resolveEntityReferenceSqlite(value: string, agentId: string): number | undefined {
    const privateRow = this.db
      .prepare(`SELECT id FROM entity_nodes WHERE pointer_key = ? AND memory_scope = 'private_overlay' AND owner_agent_id = ?`)
      .get(value, agentId) as { id: number } | null;
    if (privateRow) {
      return privateRow.id;
    }

    const sharedRow = this.db
      .prepare(`SELECT id FROM entity_nodes WHERE pointer_key = ? AND memory_scope = 'shared_public'`)
      .get(value) as { id: number } | null;
    if (sharedRow) {
      return sharedRow.id;
    }

    return undefined;
  }

  private triggerMaterialization(
    areaCandidates: Array<{
      id: number;
      event_id: number | null;
      agent_id: string;
      role: string | null;
      private_notes: string | null;
      salience: number | null;
      emotion: string | null;
      event_category: PrivateEventCategory;
      primary_actor_entity_id: number | null;
      projection_class: ProjectionClass;
      location_entity_id: number | null;
      projectable_summary: string | null;
      source_record_id: string | null;
      created_at: number;
    }>,
    agentId: string,
  ): void {
    this.materialization.materializeDelayed(areaCandidates, agentId);
  }

  private asString(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  private asOptionalString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  private asOptionalNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }

  private asOptionalNodeRef(value: unknown): NodeRef | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    if (!/^(event|entity|fact|assertion|evaluation|commitment):[1-9]\d*$/.test(value)) {
      return undefined;
    }
    return value as NodeRef;
  }

  private asPrivateEventCategory(value: unknown): "speech" | "action" | "thought" | "observation" | "state_change" {
    if (value === "speech" || value === "action" || value === "thought" || value === "observation" || value === "state_change") {
      return value;
    }
    return "observation";
  }

  private asProjectionClass(value: unknown): "none" | "area_candidate" {
    return value === "area_candidate" ? "area_candidate" : "none";
  }

  private asLogicRelationType(value: string): "causal" | "temporal_prev" | "temporal_next" | "same_episode" {
    if (value === "causal" || value === "temporal_prev" || value === "temporal_next" || value === "same_episode") {
      return value;
    }
    return "causal";
  }
}
