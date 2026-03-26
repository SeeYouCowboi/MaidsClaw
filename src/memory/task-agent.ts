import type { Database } from "bun:sqlite";
import type { AgentRole } from "../agents/profile.js";
import type { MemoryFlushRequest as CoreMemoryFlushRequest } from "../core/types.js";
import type { InteractionRecord, TurnSettlementPayload } from "../interaction/contracts.js";
import { SUBMIT_RP_TURN_ARTIFACT_CONTRACTS } from "../runtime/submit-rp-turn-tool.js";
import type { PrivateCognitionCommitV4 } from "../runtime/rp-turn-contract.js";
import type { WriteTemplate } from "./contracts/write-template.js";
import { CognitionRepository } from "./cognition/cognition-repo.js";
import { CoreMemoryIndexUpdater } from "./core-memory-index-updater.js";
import { ExplicitSettlementProcessor } from "./explicit-settlement-processor.js";
import { GraphOrganizer } from "./graph-organizer.js";
import { makeNodeRef } from "./schema.js";
import type { CoreMemoryService } from "./core-memory.js";
import type { EmbeddingService } from "./embeddings.js";
import type { MaterializationService } from "./materialization.js";
import type { GraphStorageService } from "./storage.js";
import type { AssertionBasis, AssertionStance } from "../runtime/rp-turn-contract.js";
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
        stance: { type: "string", enum: ["hypothetical", "tentative", "accepted", "confirmed", "contested", "rejected", "abandoned"] },
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

export class MemoryTaskAgent {
  private readonly modelProvider: MemoryTaskModelProvider;
  private readonly ingestionPolicy: MemoryIngestionPolicy;
  private readonly explicitSettlementProcessor: ExplicitSettlementProcessor;
  private readonly coreMemoryIndexUpdater: CoreMemoryIndexUpdater;
  private readonly graphOrganizer: GraphOrganizer;
  private migrateTail: Promise<unknown> = Promise.resolve();
  private organizeTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly storage: GraphStorageService,
    private readonly coreMemory: CoreMemoryService,
    private readonly embeddings: EmbeddingService,
    private readonly materialization: MaterializationService,
    modelProvider?: MemoryTaskModelProvider,
  ) {
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
    this.explicitSettlementProcessor = new ExplicitSettlementProcessor(
      this.db,
      this.storage,
      this.modelProvider,
      (agentId) => this.loadExistingContext(agentId),
      (request, toolCalls, created) => {
        this.applyCallOneToolCalls(request, toolCalls, created);
      },
    );
    this.coreMemoryIndexUpdater = new CoreMemoryIndexUpdater(this.coreMemory, this.modelProvider);
    this.graphOrganizer = new GraphOrganizer(
      this.db,
      this.storage,
      this.coreMemory,
      this.embeddings,
      this.modelProvider,
    );
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
    const existingContext = this.loadExistingContext(flushRequest.agentId);
    const created: CreatedState = {
      episodeEventIds: [],
      assertionIds: [],
      entityIds: [],
      factIds: [],
      changedNodeRefs: [],
    };

    this.db.prepare("BEGIN IMMEDIATE").run();
    try {
      await this.explicitSettlementProcessor.process(flushRequest, ingest, created, EXPLICIT_SUPPORT_TOOLS, {
        agentRole: flushRequest.agentRole,
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

      const createdPrivateEvents = this.applyCallOneToolCalls(flushRequest, callOne, created);
      const areaCandidates = createdPrivateEvents.filter((event) => event.projection_class === "area_candidate");
      if (areaCandidates.length > 0) {
        this.materialization.materializeDelayed(areaCandidates, flushRequest.agentId);
      }

      this.createSameEpisodeEdgesForBatch(createdPrivateEvents);

      await this.coreMemoryIndexUpdater.updateIndex(flushRequest.agentId, created, CALL_TWO_TOOLS);

      this.db.prepare("COMMIT").run();
    } catch (error) {
      this.db.prepare("ROLLBACK").run();
      throw error;
    }

    const organizeJob: GraphOrganizerJob = {
      agentId: flushRequest.agentId,
      sessionId: flushRequest.sessionId,
      batchId: flushRequest.idempotencyKey,
      changedNodeRefs: created.changedNodeRefs,
      embeddingModelId: this.modelProvider.defaultEmbeddingModelId,
    };

    void Promise.resolve().then(() => this.runOrganize(organizeJob)).catch((err: unknown) => {
      console.error("[MemoryTaskAgent] background organize failed", {
        batchId: organizeJob.batchId,
        sessionId: organizeJob.sessionId,
        agentId: organizeJob.agentId,
        embeddingModelId: organizeJob.embeddingModelId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

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

  private loadExistingContext(agentId: string): { entities: unknown[]; privateBeliefs: unknown[] } {
    const entities = this.db
      .prepare(
        `SELECT id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id
         FROM entity_nodes
         WHERE memory_scope = 'shared_public' OR owner_agent_id = ?
         ORDER BY updated_at DESC
         LIMIT 200`,
      )
      .all(agentId);

    const cognitionRepo = new CognitionRepository(this.db);
    const assertions = cognitionRepo.getAssertions(agentId, { activeOnly: false }).slice(0, 150);
    const commitments = cognitionRepo.getCommitments(agentId, { activeOnly: false }).slice(0, 50);

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

  private applyCallOneToolCalls(
    flushRequest: MemoryFlushRequest,
    toolCalls: ToolCallResult[],
    created: CreatedState,
  ): Array<{
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
  }> {
    const pointerToEntityId = new Map<string, number>();
    const cognitionRepo = new CognitionRepository(this.db);
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
        const entityId = this.storage.upsertEntity({
          pointerKey,
          displayName,
          entityType,
          memoryScope,
          ownerAgentId: memoryScope === "private_overlay" ? flushRequest.agentId : undefined,
        });
        pointerToEntityId.set(pointerKey, entityId);
        created.entityIds.push(entityId);
        created.changedNodeRefs.push(makeNodeRef("entity", entityId));
        continue;
      }

      if (call.name === CREATE_EPISODE_EVENT_TOOL_NAME) {
        const primaryActor = this.resolveEntityReference(
          call.arguments.primary_actor_entity_id,
          flushRequest.agentId,
          pointerToEntityId,
        );
        const location = this.resolveEntityReference(call.arguments.location_entity_id, flushRequest.agentId, pointerToEntityId);
        const eventId = this.asOptionalNumber(call.arguments.event_id);
        const privateEventId = this.storage.createPrivateEvent({
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
        });
        created.episodeEventIds.push(privateEventId);
        created.changedNodeRefs.push(makeNodeRef("evaluation", privateEventId));
        const row = this.db.prepare(
          `SELECT id, valid_time as event_id, agent_id, category, summary, private_notes, committed_time, created_at FROM private_episode_events WHERE id = ?`
        ).get(privateEventId) as {
          id: number;
          event_id: number | null;
          agent_id: string;
          category: string;
          summary: string;
          private_notes: string | null;
          committed_time: number;
          created_at: number;
        };
        privateEvents.push({
          id: row.id,
          event_id: row.event_id,
          agent_id: row.agent_id,
          role: call.arguments.role as string | null,
          private_notes: row.private_notes,
          salience: (call.arguments.salience as number) ?? null,
          emotion: (call.arguments.emotion as string) ?? null,
          event_category: row.category as PrivateEventCategory,
          primary_actor_entity_id: primaryActor ?? null,
          projection_class: call.arguments.projection_class as ProjectionClass,
          location_entity_id: location ?? null,
          projectable_summary: (call.arguments.projectable_summary as string) ?? null,
          source_record_id: (call.arguments.source_record_id as string) ?? null,
          created_at: row.created_at,
        });
        continue;
      }

      if (call.name === UPSERT_ASSERTION_TOOL_NAME) {
        const source = this.resolveEntityReference(call.arguments.source, flushRequest.agentId, pointerToEntityId);
        const target = this.resolveEntityReference(call.arguments.target, flushRequest.agentId, pointerToEntityId);
        if (!source || !target) {
          continue;
        }
        const sourcePointerKey =
          typeof call.arguments.source === "string"
            ? call.arguments.source
            : this.storage.getEntityById(source)?.pointerKey;
        const targetPointerKey =
          typeof call.arguments.target === "string"
            ? call.arguments.target
            : this.storage.getEntityById(target)?.pointerKey;
        if (!sourcePointerKey || !targetPointerKey) {
          continue;
        }

        const beliefId = cognitionRepo.upsertAssertion({
          agentId: flushRequest.agentId,
          settlementId: beliefSettlementId,
          opIndex: beliefOpIndex,
          sourcePointerKey,
          predicate: this.asString(call.arguments.predicate),
          targetPointerKey,
          basis: this.asString(call.arguments.basis) as AssertionBasis,
          stance: this.asString(call.arguments.stance) as AssertionStance,
          provenance: this.asOptionalString(call.arguments.provenance) ?? undefined,
        }).id;
        beliefOpIndex += 1;

        const sourceEventRef = this.asOptionalNodeRef(call.arguments.source_event_ref);
        if (sourceEventRef) {
          this.db
            .prepare(`UPDATE private_cognition_current SET source_event_ref = ?, updated_at = ? WHERE id = ?`)
            .run(sourceEventRef, Date.now(), beliefId);
        }

        created.assertionIds.push(beliefId);
        created.changedNodeRefs.push(makeNodeRef("assertion", beliefId));
        continue;
      }

      if (call.name === "create_alias") {
        const canonical = this.resolveEntityReference(call.arguments.canonical_id, flushRequest.agentId, pointerToEntityId);
        if (!canonical) {
          continue;
        }
        this.storage.createEntityAlias(
          canonical,
          this.asString(call.arguments.alias),
          this.asOptionalString(call.arguments.alias_type) ?? undefined,
          flushRequest.agentId,
        );
        continue;
      }

      if (call.name === "create_logic_edge") {
        const sourceEventId = this.asOptionalNumber(call.arguments.source_event_id);
        const targetEventId = this.asOptionalNumber(call.arguments.target_event_id);
        if (!sourceEventId || !targetEventId) {
          continue;
        }
        this.storage.createLogicEdge(
          sourceEventId,
          targetEventId,
          this.asLogicRelationType(this.asString(call.arguments.relation_type)),
        );
      }
    }

    return privateEvents;
  }

  private createSameEpisodeEdgesForBatch(privateEvents: Array<{ event_id: number | null }>): void {
    const linkedEventIds = privateEvents
      .map((event) => event.event_id)
      .filter((eventId): eventId is number => typeof eventId === "number" && eventId > 0);

    if (linkedEventIds.length < 2) {
      return;
    }

    const placeholders = linkedEventIds.map(() => "?").join(",");
    const events = this.db
      .prepare(
        `SELECT id, session_id, topic_id, timestamp
         FROM event_nodes
         WHERE id IN (${placeholders})`,
      )
      .all(...linkedEventIds) as Array<{ id: number; session_id: string; topic_id: number | null; timestamp: number }>;

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
    const insertStmt = this.db.prepare(
      `INSERT INTO logic_edges (source_event_id, target_event_id, relation_type, created_at)
       VALUES (?, ?, 'same_episode', ?)`,
    );

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

      const createdAt = Date.now();
      insertStmt.run(current.id, next.id, createdAt);
      insertStmt.run(next.id, current.id, createdAt);
    }
  }

  private resolveEntityReference(
    value: unknown,
    agentId: string,
    pointerMap: Map<string, number>,
  ): number | undefined {
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

    const privateRow = this.db
      .prepare(`SELECT id FROM entity_nodes WHERE pointer_key = ? AND memory_scope = 'private_overlay' AND owner_agent_id = ?`)
      .get(value, agentId) as { id: number } | null;
    if (privateRow) {
      pointerMap.set(value, privateRow.id);
      return privateRow.id;
    }

    const sharedRow = this.db
      .prepare(`SELECT id FROM entity_nodes WHERE pointer_key = ? AND memory_scope = 'shared_public'`)
      .get(value) as { id: number } | null;
    if (sharedRow) {
      pointerMap.set(value, sharedRow.id);
      return sharedRow.id;
    }

    return undefined;
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
