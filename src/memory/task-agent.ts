import type { Database } from "bun:sqlite";
import type { MemoryFlushRequest as CoreMemoryFlushRequest } from "../core/types.js";
import type { InteractionRecord } from "../interaction/contracts.js";
import { makeNodeRef } from "./schema.js";
import type { CoreMemoryService } from "./core-memory.js";
import type { EmbeddingService } from "./embeddings.js";
import type { MaterializationService } from "./materialization.js";
import type { GraphStorageService } from "./storage.js";
import type {
  AgentEventOverlay,
  BeliefType,
  EpistemicStatus,
  GraphOrganizerResult,
  MigrationResult,
  NodeRef,
  NodeRefKind,
  SemanticEdgeType,
} from "./types.js";

export type { MigrationResult, GraphOrganizerResult } from "./types.js";

export type DialogueRecord = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  recordId?: string;
  recordIndex?: number;
};

export type MemoryFlushRequest = CoreMemoryFlushRequest & {
  dialogueRecords?: DialogueRecord[];
  queueOwnerAgentId?: string;
};

export type GraphOrganizerJob = {
  agentId: string;
  sessionId: string;
  batchId: string;
  changedNodeRefs: NodeRef[];
  embeddingModelId?: string;
};

type IngestionAttachment = {
  recordType: "tool_call" | "tool_result" | "delegation" | "task_result";
  payload: unknown;
  committedAt: number;
};

type IngestionInput = {
  batchId: string;
  agentId: string;
  sessionId: string;
  dialogue: DialogueRecord[];
  attachments: IngestionAttachment[];
};

type ToolCallResult = {
  name: string;
  arguments: Record<string, unknown>;
};

type ChatToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ModelProvider = {
  chat(messages: ChatMessage[], tools: ChatToolDefinition[]): Promise<ToolCallResult[]>;
  embed(texts: string[], purpose: "memory_index" | "memory_search" | "query_expansion", modelId: string): Promise<Float32Array[]>;
};

type CreatedState = {
  privateEventIds: number[];
  privateBeliefIds: number[];
  entityIds: number[];
  factIds: number[];
  changedNodeRefs: NodeRef[];
};

const CALL_ONE_TOOLS: ChatToolDefinition[] = [
  {
    name: "create_private_event",
    description:
      "Create private cognitive events in agent_event_overlay. Use for owner-private thoughts, observations, and public-candidate emission.",
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
    name: "create_private_belief",
    description: "Create private belief overlay edges between entities.",
    inputSchema: {
      type: "object",
      required: ["source", "target", "predicate", "belief_type", "confidence"],
      properties: {
        source: { type: ["number", "string"] },
        target: { type: ["number", "string"] },
        predicate: { type: "string" },
        belief_type: { type: ["string", "null"] },
        confidence: { type: ["number", "null"] },
        epistemic_status: { type: ["string", "null"] },
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

export class MemoryIngestionPolicy {
  constructor(private readonly interactionLogReader?: (request: MemoryFlushRequest) => InteractionRecord[]) {}

  buildMigrateInput(flushRequest: MemoryFlushRequest): IngestionInput {
    const records = this.interactionLogReader?.(flushRequest) ?? [];
    const dialogueFromFlush = (flushRequest.dialogueRecords ?? []).filter((record) => {
      if (record.recordIndex === undefined) {
        return true;
      }
      return record.recordIndex >= flushRequest.rangeStart && record.recordIndex <= flushRequest.rangeEnd;
    });

    const dialogueFromLog = records
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
        } satisfies DialogueRecord;
      })
      .filter((record): record is DialogueRecord => record !== undefined);

    const mergedDialogue = [...dialogueFromLog, ...dialogueFromFlush]
      .sort((a, b) => a.timestamp - b.timestamp)
      .filter((record) => record.content.trim().length > 0);

    const attachments = records
      .filter(
        (record) =>
          (record.recordType === "tool_call" ||
            record.recordType === "tool_result" ||
            record.recordType === "delegation" ||
            record.recordType === "task_result") &&
          record.recordIndex >= flushRequest.rangeStart &&
          record.recordIndex <= flushRequest.rangeEnd,
      )
      .map((record) => ({
        recordType: record.recordType,
        payload: record.payload,
        committedAt: record.committedAt,
      })) as IngestionAttachment[];

    return {
      batchId: flushRequest.idempotencyKey,
      agentId: flushRequest.agentId,
      sessionId: flushRequest.sessionId,
      dialogue: mergedDialogue,
      attachments,
    };
  }
}

export class MemoryTaskAgent {
  private readonly modelProvider: ModelProvider;
  private readonly ingestionPolicy: MemoryIngestionPolicy;
  private migrateTail: Promise<unknown> = Promise.resolve();
  private organizeTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly storage: GraphStorageService,
    private readonly coreMemory: CoreMemoryService,
    private readonly embeddings: EmbeddingService,
    private readonly materialization: MaterializationService,
    modelProvider?: {
      chat(messages: ChatMessage[], tools: ChatToolDefinition[]): Promise<ToolCallResult[]>;
      embed(
        texts: string[],
        purpose: "memory_index" | "memory_search" | "query_expansion",
        modelId: string,
      ): Promise<Float32Array[]>;
    },
  ) {
    this.modelProvider =
      modelProvider ??
      ({
        chat: async () => {
          throw new Error("MemoryTaskAgent requires modelProvider.chat");
        },
        embed: async () => {
          throw new Error("MemoryTaskAgent requires modelProvider.embed");
        },
      } satisfies ModelProvider);
    this.ingestionPolicy = new MemoryIngestionPolicy();
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
      privateEventIds: [],
      privateBeliefIds: [],
      entityIds: [],
      factIds: [],
      changedNodeRefs: [],
    };

    this.db.prepare("BEGIN IMMEDIATE").run();
    try {
      const callOne = await this.modelProvider.chat(
        [
          {
            role: "system",
            content:
              "You are a memory migration engine. Phase 1 Extract: identify durable events/entities/relationships. Phase 2 Compare: check current graph context for duplicates/conflicts within same scope only. Phase 3 Synthesize: keep surprising and persistent information. Classify each output as shared_public or owner_private.",
          },
          {
            role: "user",
            content: JSON.stringify({ ingest, existingContext }),
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

      const indexBlock = this.coreMemory.getBlock(flushRequest.agentId, "index");
      const callTwo = await this.modelProvider.chat(
        [
          {
            role: "system",
            content:
              "Choose index-worthy additions only. Keep concise lines with pointer addresses @pointer_key, #topic, e:id, f:id.",
          },
          {
            role: "user",
            content: JSON.stringify({
              currentIndexText: indexBlock.value,
              createdItems: {
                entityIds: created.entityIds,
                privateEventIds: created.privateEventIds,
                privateBeliefIds: created.privateBeliefIds,
                factIds: created.factIds,
              },
            }),
          },
        ],
        CALL_TWO_TOOLS,
      );

      const newIndexText = this.extractUpdatedIndex(callTwo, indexBlock.value);
      if (newIndexText !== indexBlock.value) {
        const replaced = this.coreMemory.replaceBlock(
          flushRequest.agentId,
          "index",
          indexBlock.value,
          newIndexText,
          "task-agent",
        );
        if (!replaced.success) {
          throw new Error(`Index update failed: ${replaced.reason}`);
        }
      }

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
      embeddingModelId: "memory-task-organizer-v1",
    };

    void Promise.resolve().then(() => this.runOrganize(organizeJob));

    return {
      batch_id: flushRequest.idempotencyKey,
      private_event_ids: created.privateEventIds,
      private_belief_ids: created.privateBeliefIds,
      entity_ids: created.entityIds,
      fact_ids: created.factIds,
    };
  }

  private async runOrganizeInternal(job: GraphOrganizerJob): Promise<GraphOrganizerResult> {
    const uniqueRefs = Array.from(new Set(job.changedNodeRefs));
    if (uniqueRefs.length === 0) {
      return { updated_embedding_refs: [], updated_semantic_edge_count: 0, updated_score_refs: [] };
    }

    const nodes = uniqueRefs
      .map((nodeRef) => {
        const parsed = this.parseNodeRef(nodeRef);
        if (!parsed) {
          return undefined;
        }
        const content = this.renderNodeContent(nodeRef);
        if (!content) {
          return undefined;
        }
        return { nodeRef, nodeKind: parsed.kind, content };
      })
      .filter((node): node is { nodeRef: NodeRef; nodeKind: NodeRefKind; content: string } => node !== undefined);

    if (nodes.length === 0) {
      return { updated_embedding_refs: [], updated_semantic_edge_count: 0, updated_score_refs: [] };
    }

    const embeddings = await this.modelProvider.embed(
      nodes.map((node) => node.content),
      "memory_index",
      job.embeddingModelId ?? "memory-task-organizer-v1",
    );

    const entries = nodes.map((node, index) => ({
      nodeRef: node.nodeRef,
      nodeKind: node.nodeKind,
      viewType: "primary" as const,
      modelId: job.embeddingModelId ?? "memory-task-organizer-v1",
      embedding: embeddings[index] ?? new Float32Array([0]),
    }));

    this.embeddings.batchStoreEmbeddings(entries);

    let semanticEdgeCount = 0;
    const scoreTargets = new Set<NodeRef>();

    for (let index = 0; index < entries.length; index += 1) {
      const source = entries[index];
      const sourceContent = nodes[index]?.content ?? "";
      const neighbors = this.embeddings.queryNearestNeighbors(source.embedding, {
        nodeKind: source.nodeKind,
        agentId: job.agentId,
        limit: 20,
      });

      let similarCount = 0;
      let conflictCount = 0;
      let bridgeCount = 0;

      for (const neighbor of neighbors) {
        if (neighbor.nodeRef === source.nodeRef) {
          continue;
        }

        const targetContent = this.renderNodeContent(neighbor.nodeRef) ?? "";
        const relation = this.selectSemanticRelation(
          source.nodeRef,
          source.nodeKind,
          sourceContent,
          neighbor.nodeRef,
          neighbor.nodeKind as NodeRefKind,
          targetContent,
          neighbor.similarity,
          job.agentId,
        );

        if (!relation) {
          continue;
        }

        if (relation === "semantic_similar" && similarCount >= 4) {
          continue;
        }
        if (relation === "conflict_or_update" && conflictCount >= 2) {
          continue;
        }
        if (relation === "entity_bridge" && bridgeCount >= 2) {
          continue;
        }

        this.storage.upsertSemanticEdge(source.nodeRef, neighbor.nodeRef, relation, neighbor.similarity);
        semanticEdgeCount += 1;
        scoreTargets.add(source.nodeRef);
        scoreTargets.add(neighbor.nodeRef);
        this.addOneHopNeighbors(neighbor.nodeRef, scoreTargets);

        if (relation === "semantic_similar") {
          similarCount += 1;
        }
        if (relation === "conflict_or_update") {
          conflictCount += 1;
        }
        if (relation === "entity_bridge") {
          bridgeCount += 1;
        }
      }
    }

    const scoreRefs = Array.from(scoreTargets);
    for (const nodeRef of scoreRefs) {
      const score = this.computeNodeScore(nodeRef, job.agentId);
      this.storage.upsertNodeScores(nodeRef, score.salience, score.centrality, score.bridgeScore);
    }

    for (const nodeRef of uniqueRefs) {
      this.syncSearchProjection(nodeRef, job.agentId);
    }

    return {
      updated_embedding_refs: entries.map((entry) => entry.nodeRef),
      updated_semantic_edge_count: semanticEdgeCount,
      updated_score_refs: scoreRefs,
    };
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

    const privateBeliefs = this.db
      .prepare(
        `SELECT id, source_entity_id, target_entity_id, predicate, confidence, epistemic_status
         FROM agent_fact_overlay
         WHERE agent_id = ?
         ORDER BY updated_at DESC
         LIMIT 200`,
      )
      .all(agentId);

    return { entities, privateBeliefs };
  }

  private applyCallOneToolCalls(
    flushRequest: MemoryFlushRequest,
    toolCalls: ToolCallResult[],
    created: CreatedState,
  ): AgentEventOverlay[] {
    const pointerToEntityId = new Map<string, number>();
    const privateEvents: AgentEventOverlay[] = [];

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

      if (call.name === "create_private_event") {
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
        created.privateEventIds.push(privateEventId);
        created.changedNodeRefs.push(makeNodeRef("private_event", privateEventId));
        const row = this.db.prepare(`SELECT * FROM agent_event_overlay WHERE id = ?`).get(privateEventId) as AgentEventOverlay;
        privateEvents.push(row);
        continue;
      }

      if (call.name === "create_private_belief") {
        const source = this.resolveEntityReference(call.arguments.source, flushRequest.agentId, pointerToEntityId);
        const target = this.resolveEntityReference(call.arguments.target, flushRequest.agentId, pointerToEntityId);
        if (!source || !target) {
          continue;
        }
        const beliefId = this.storage.createPrivateBelief({
          agentId: flushRequest.agentId,
          sourceEntityId: source,
          targetEntityId: target,
          predicate: this.asString(call.arguments.predicate),
          beliefType: this.asOptionalString(call.arguments.belief_type) as BeliefType | undefined,
          confidence: this.asOptionalNumber(call.arguments.confidence) ?? undefined,
          epistemicStatus: this.asOptionalString(call.arguments.epistemic_status) as EpistemicStatus | undefined,
          provenance: this.asOptionalString(call.arguments.provenance) ?? undefined,
          sourceEventRef: this.asOptionalNodeRef(call.arguments.source_event_ref),
        });
        created.privateBeliefIds.push(beliefId);
        created.changedNodeRefs.push(makeNodeRef("private_belief", beliefId));
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

  private createSameEpisodeEdgesForBatch(privateEvents: AgentEventOverlay[]): void {
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

  private extractUpdatedIndex(toolCalls: ToolCallResult[], fallback: string): string {
    for (const call of toolCalls) {
      if (call.name !== "update_index_block") {
        continue;
      }
      const newText = this.asOptionalString(call.arguments.new_text);
      if (newText !== null) {
        return newText;
      }
    }
    return fallback;
  }

  private parseNodeRef(nodeRef: NodeRef): { kind: NodeRefKind; id: number } | undefined {
    const [kindRaw, idRaw] = nodeRef.split(":");
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      return undefined;
    }
    if (
      kindRaw !== "event" &&
      kindRaw !== "entity" &&
      kindRaw !== "fact" &&
      kindRaw !== "private_event" &&
      kindRaw !== "private_belief"
    ) {
      return undefined;
    }
    return { kind: kindRaw, id };
  }

  private renderNodeContent(nodeRef: NodeRef): string | undefined {
    const parsed = this.parseNodeRef(nodeRef);
    if (!parsed) {
      return undefined;
    }

    if (parsed.kind === "entity") {
      const row = this.db
        .prepare(`SELECT display_name, summary, entity_type FROM entity_nodes WHERE id = ?`)
        .get(parsed.id) as { display_name: string; summary: string | null; entity_type: string } | null;
      if (!row) {
        return undefined;
      }
      return `${row.display_name} ${row.entity_type} ${row.summary ?? ""}`.trim();
    }

    if (parsed.kind === "event") {
      const row = this.db
        .prepare(`SELECT summary, raw_text, event_category FROM event_nodes WHERE id = ?`)
        .get(parsed.id) as { summary: string | null; raw_text: string | null; event_category: string } | null;
      if (!row) {
        return undefined;
      }
      return `${row.summary ?? ""} ${row.raw_text ?? ""} ${row.event_category}`.trim();
    }

    if (parsed.kind === "fact") {
      const row = this.db
        .prepare(`SELECT source_entity_id, predicate, target_entity_id FROM fact_edges WHERE id = ?`)
        .get(parsed.id) as { source_entity_id: number; predicate: string; target_entity_id: number } | null;
      if (!row) {
        return undefined;
      }
      return `${row.source_entity_id} ${row.predicate} ${row.target_entity_id}`;
    }

    if (parsed.kind === "private_event") {
      const row = this.db
        .prepare(`SELECT private_notes, projectable_summary, event_category FROM agent_event_overlay WHERE id = ?`)
        .get(parsed.id) as { private_notes: string | null; projectable_summary: string | null; event_category: string } | null;
      if (!row) {
        return undefined;
      }
      return `${row.private_notes ?? ""} ${row.projectable_summary ?? ""} ${row.event_category}`.trim();
    }

    const row = this.db
      .prepare(`SELECT predicate, provenance, epistemic_status FROM agent_fact_overlay WHERE id = ?`)
      .get(parsed.id) as { predicate: string; provenance: string | null; epistemic_status: string | null } | null;
    if (!row) {
      return undefined;
    }
    return `${row.predicate} ${row.provenance ?? ""} ${row.epistemic_status ?? ""}`.trim();
  }

  private selectSemanticRelation(
    sourceRef: NodeRef,
    sourceKind: NodeRefKind,
    sourceContent: string,
    targetRef: NodeRef,
    targetKind: NodeRefKind,
    targetContent: string,
    similarity: number,
    agentId: string,
  ): SemanticEdgeType | null {
    if (sourceKind === targetKind && similarity >= 0.9 && this.hasStructuralOverlap(sourceContent, targetContent)) {
      return "conflict_or_update";
    }

    if (sourceKind === targetKind && similarity >= 0.82 && this.isMutualTopFive(sourceRef, targetRef, sourceKind, agentId)) {
      return "semantic_similar";
    }

    if (sourceKind !== targetKind && similarity >= 0.78 && this.isCuratedBridgePair(sourceKind, targetKind)) {
      if (this.hasStructuralOverlap(sourceContent, targetContent)) {
        return "entity_bridge";
      }
    }

    return null;
  }

  private isMutualTopFive(sourceRef: NodeRef, targetRef: NodeRef, nodeKind: NodeRefKind, agentId: string): boolean {
    const row = this.db
      .prepare(`SELECT embedding FROM node_embeddings WHERE node_ref = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(targetRef) as { embedding: Buffer | Uint8Array } | null;
    if (!row) {
      return false;
    }
    const targetVector = this.embeddings.deserializeEmbedding(Buffer.from(row.embedding));
    const nearest = this.embeddings.queryNearestNeighbors(targetVector, {
      nodeKind,
      agentId,
      limit: 5,
    });
    return nearest.some((candidate) => candidate.nodeRef === sourceRef || candidate.nodeRef === targetRef);
  }

  private isCuratedBridgePair(a: NodeRefKind, b: NodeRefKind): boolean {
    const key = `${a}:${b}`;
    const allowed = new Set([
      "event:entity",
      "entity:event",
      "private_event:entity",
      "entity:private_event",
      "fact:entity",
      "entity:fact",
      "private_belief:entity",
      "entity:private_belief",
    ]);
    return allowed.has(key);
  }

  private hasStructuralOverlap(sourceContent: string, targetContent: string): boolean {
    const sourceTokens = new Set(sourceContent.toLowerCase().split(/\W+/).filter((token) => token.length > 2));
    const targetTokens = new Set(targetContent.toLowerCase().split(/\W+/).filter((token) => token.length > 2));
    let overlap = 0;
    for (const token of sourceTokens) {
      if (targetTokens.has(token)) {
        overlap += 1;
      }
      if (overlap >= 2) {
        return true;
      }
    }
    return false;
  }

  private addOneHopNeighbors(nodeRef: NodeRef, output: Set<NodeRef>): void {
    const rows = this.db
      .prepare(
        `SELECT source_node_ref, target_node_ref FROM semantic_edges
         WHERE source_node_ref = ? OR target_node_ref = ?`,
      )
      .all(nodeRef, nodeRef) as Array<{ source_node_ref: NodeRef; target_node_ref: NodeRef }>;

    for (const row of rows) {
      output.add(row.source_node_ref);
      output.add(row.target_node_ref);
    }
  }

  private computeNodeScore(nodeRef: NodeRef, agentId: string): { salience: number; centrality: number; bridgeScore: number } {
    const now = Date.now();
    const edgeRows = this.db
      .prepare(
        `SELECT source_node_ref, target_node_ref, weight
         FROM semantic_edges
         WHERE source_node_ref = ? OR target_node_ref = ?`,
      )
      .all(nodeRef, nodeRef) as Array<{ source_node_ref: NodeRef; target_node_ref: NodeRef; weight: number }>;

    const recurrence = Math.min(1, edgeRows.length / 10);
    const updatedAt = this.lookupNodeUpdatedAt(nodeRef) ?? now;
    const recency = Math.max(0, 1 - (now - updatedAt) / (7 * 24 * 60 * 60 * 1000));
    const indexBlock = this.coreMemory.getBlock(agentId, "index");
    const indexPresence = indexBlock.value.includes(nodeRef) ? 1 : 0;
    const persistenceRow = this.db.prepare(`SELECT node_ref FROM node_scores WHERE node_ref = ?`).get(nodeRef) as
      | { node_ref: NodeRef }
      | null;
    const persistence = persistenceRow ? 1 : 0.5;

    const salience =
      0.35 * recurrence +
      0.25 * recency +
      0.2 * indexPresence +
      0.2 * persistence;

    const semanticDegree = edgeRows.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
    const logicDegree = this.lookupLogicDegree(nodeRef);
    const centrality = semanticDegree + logicDegree;

    const sourceCluster = this.lookupTopicCluster(nodeRef);
    let crossClusterWeight = 0;
    let totalWeight = 0;
    for (const row of edgeRows) {
      const neighbor = row.source_node_ref === nodeRef ? row.target_node_ref : row.source_node_ref;
      const neighborCluster = this.lookupTopicCluster(neighbor);
      const weight = Math.max(0, row.weight);
      totalWeight += weight;
      if (sourceCluster !== neighborCluster) {
        crossClusterWeight += weight;
      }
    }
    const bridgeScore = totalWeight > 0 ? crossClusterWeight / totalWeight : 0;

    return { salience, centrality, bridgeScore };
  }

  private lookupNodeUpdatedAt(nodeRef: NodeRef): number | undefined {
    const parsed = this.parseNodeRef(nodeRef);
    if (!parsed) {
      return undefined;
    }

    if (parsed.kind === "entity") {
      const row = this.db.prepare(`SELECT updated_at FROM entity_nodes WHERE id = ?`).get(parsed.id) as
        | { updated_at: number }
        | null;
      return row?.updated_at;
    }

    if (parsed.kind === "event") {
      const row = this.db.prepare(`SELECT created_at FROM event_nodes WHERE id = ?`).get(parsed.id) as
        | { created_at: number }
        | null;
      return row?.created_at;
    }

    if (parsed.kind === "fact") {
      const row = this.db.prepare(`SELECT t_created FROM fact_edges WHERE id = ?`).get(parsed.id) as
        | { t_created: number }
        | null;
      return row?.t_created;
    }

    if (parsed.kind === "private_event") {
      const row = this.db.prepare(`SELECT created_at FROM agent_event_overlay WHERE id = ?`).get(parsed.id) as
        | { created_at: number }
        | null;
      return row?.created_at;
    }

    const row = this.db.prepare(`SELECT updated_at FROM agent_fact_overlay WHERE id = ?`).get(parsed.id) as
      | { updated_at: number }
      | null;
    return row?.updated_at;
  }

  private lookupLogicDegree(nodeRef: NodeRef): number {
    const parsed = this.parseNodeRef(nodeRef);
    if (!parsed || parsed.kind !== "event") {
      return 0;
    }

    const row = this.db
      .prepare(
        `SELECT (SELECT count(*) FROM logic_edges WHERE source_event_id = ?) +
                (SELECT count(*) FROM logic_edges WHERE target_event_id = ?) as degree`,
      )
      .get(parsed.id, parsed.id) as { degree: number };
    return row.degree;
  }

  private lookupTopicCluster(nodeRef: NodeRef): number | null {
    const parsed = this.parseNodeRef(nodeRef);
    if (!parsed) {
      return null;
    }

    if (parsed.kind === "event") {
      const row = this.db.prepare(`SELECT topic_id FROM event_nodes WHERE id = ?`).get(parsed.id) as
        | { topic_id: number | null }
        | null;
      return row?.topic_id ?? null;
    }

    if (parsed.kind === "private_event") {
      const row = this.db
        .prepare(
          `SELECT e.topic_id
           FROM agent_event_overlay a
           JOIN event_nodes e ON e.id = a.event_id
           WHERE a.id = ?`,
        )
        .get(parsed.id) as { topic_id: number | null } | null;
      return row?.topic_id ?? null;
    }

    return null;
  }

  private syncSearchProjection(nodeRef: NodeRef, agentId: string): void {
    const parsed = this.parseNodeRef(nodeRef);
    if (!parsed) {
      return;
    }

    if (parsed.kind === "event") {
      const row = this.db
        .prepare(`SELECT summary, visibility_scope, location_entity_id FROM event_nodes WHERE id = ?`)
        .get(parsed.id) as { summary: string | null; visibility_scope: string; location_entity_id: number } | null;
      if (!row || !row.summary) {
        return;
      }
      if (row.visibility_scope === "area_visible") {
        this.storage.syncSearchDoc("area", nodeRef, row.summary, undefined, row.location_entity_id);
      } else {
        this.storage.syncSearchDoc("world", nodeRef, row.summary);
      }
      return;
    }

    if (parsed.kind === "entity") {
      const row = this.db
        .prepare(`SELECT display_name, summary, memory_scope, owner_agent_id FROM entity_nodes WHERE id = ?`)
        .get(parsed.id) as {
        display_name: string;
        summary: string | null;
        memory_scope: "shared_public" | "private_overlay";
        owner_agent_id: string | null;
      } | null;
      if (!row) {
        return;
      }
      const content = `${row.display_name} ${row.summary ?? ""}`.trim();
      if (row.memory_scope === "private_overlay") {
        this.storage.syncSearchDoc("private", nodeRef, content, row.owner_agent_id ?? agentId);
      } else {
        this.storage.syncSearchDoc("world", nodeRef, content);
      }
      return;
    }

    if (parsed.kind === "private_event") {
      const row = this.db
        .prepare(`SELECT private_notes, projectable_summary, agent_id FROM agent_event_overlay WHERE id = ?`)
        .get(parsed.id) as { private_notes: string | null; projectable_summary: string | null; agent_id: string } | null;
      if (!row) {
        return;
      }
      const content = `${row.private_notes ?? ""} ${row.projectable_summary ?? ""}`.trim();
      this.storage.syncSearchDoc("private", nodeRef, content, row.agent_id);
      return;
    }

    if (parsed.kind === "private_belief") {
      const row = this.db
        .prepare(`SELECT predicate, provenance, agent_id FROM agent_fact_overlay WHERE id = ?`)
        .get(parsed.id) as { predicate: string; provenance: string | null; agent_id: string } | null;
      if (!row) {
        return;
      }
      this.storage.syncSearchDoc("private", nodeRef, `${row.predicate} ${row.provenance ?? ""}`.trim(), row.agent_id);
      return;
    }

    const row = this.db
      .prepare(`SELECT source_entity_id, predicate, target_entity_id FROM fact_edges WHERE id = ?`)
      .get(parsed.id) as { source_entity_id: number; predicate: string; target_entity_id: number } | null;
    if (!row) {
      return;
    }
    this.storage.syncSearchDoc("world", nodeRef, `${row.source_entity_id} ${row.predicate} ${row.target_entity_id}`);
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
    const parsed = this.parseNodeRef(value as NodeRef);
    if (!parsed) {
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
