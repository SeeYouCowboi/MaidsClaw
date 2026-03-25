import type { AssertionBasis, AssertionStance } from "../runtime/rp-turn-contract.js";
import type { Db } from "../storage/database.js";
import {
  CognitionRepository,
  type UpsertCommitmentParams,
  type UpsertEvaluationParams,
} from "./cognition/cognition-repo.js";
import { MAX_INTEGER, makeNodeRef } from "./schema.js";
import { TransactionBatcher } from "./transaction-batcher.js";
import type {
  AgentFactOverlay,
  EventOrigin,
  LogicEdgeType,
  MemoryScope,
  NodeRef,
  NodeRefKind,
  PrivateEventCategory,
  ProjectionClass,
  PublicEventCategory,
  SemanticEdgeType,
} from "./types.js";

const PUBLIC_EVENT_CATEGORY_SET = new Set<PublicEventCategory>([
  "speech",
  "action",
  "observation",
  "state_change",
]);

const PROJECTED_EVENT_ORIGIN_SET = new Set<EventOrigin>([
  "runtime_projection",
  "delayed_materialization",
]);

const LOGIC_EDGE_TYPE_SET = new Set<LogicEdgeType>([
  "causal",
  "temporal_prev",
  "temporal_next",
  "same_episode",
]);

const PRIVATE_EVENT_CATEGORY_SET = new Set<PrivateEventCategory>([
  "speech",
  "action",
  "thought",
  "observation",
  "state_change",
]);

const PROJECTION_CLASS_SET = new Set<ProjectionClass>(["none", "area_candidate"]);

type CreateProjectedEventInput = {
  sessionId: string;
  summary: string;
  timestamp: number;
  participants: string;
  emotion?: string;
  topicId?: number;
  locationEntityId: number;
  eventCategory: PublicEventCategory;
  primaryActorEntityId?: number;
  sourceRecordId?: string;
  origin: "runtime_projection" | "delayed_materialization";
  /** Publication provenance: settlement that declared this publication */
  sourceSettlementId?: string;
  /** Publication provenance: index within the settlement's publications[] */
  sourcePubIndex?: number;
  /** Visibility scope override; defaults to 'area_visible' */
  visibilityScope?: "area_visible" | "world_public";
};

type CreatePromotedEventInput = {
  sessionId: string;
  summary: string;
  timestamp: number;
  participants: string;
  locationEntityId?: number;
  eventCategory: PublicEventCategory;
  primaryActorEntityId?: number;
  sourceEventId?: number;
};

type UpsertEntityInput = {
  pointerKey: string;
  displayName: string;
  entityType: string;
  summary?: string;
  memoryScope: MemoryScope;
  ownerAgentId?: string;
  canonicalEntityId?: number;
};

type CreatePrivateEventInput = {
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
};

type EventSessionRow = {
  session_id: string;
};

type CreatePrivateBeliefInput = {
  agentId: string;
  sourceEntityId: number;
  targetEntityId: number;
  predicate: string;
  basis: AssertionBasis;
  stance: AssertionStance;
  provenance?: string;
  sourceEventRef?: AgentFactOverlay["source_event_ref"];
};

type UpsertExplicitAssertionInput = {
  agentId: string;
  cognitionKey?: string;
  settlementId: string;
  opIndex: number;
  sourcePointerKey: string;
  predicate: string;
  targetPointerKey: string;
  stance: AssertionStance;
  basis?: AssertionBasis;
  preContestedStance?: AssertionStance;
  provenance?: string;
};

type UpsertExplicitEvaluationInput = UpsertEvaluationParams;
type UpsertExplicitCommitmentInput = UpsertCommitmentParams;

type SearchScope = "private" | "area" | "world";
type SameEpisodeEvent = { id: number; session_id: string; topic_id: number | null; timestamp: number };

const legacyPrivateEventPrefix = "private_event:";
const legacyPrivateBeliefPrefix = "private_belief:";

export class GraphStorageService {
  private readonly batcher: TransactionBatcher;
  private readonly cognitionRepo: CognitionRepository;

  constructor(private readonly db: Db) {
    this.batcher = new TransactionBatcher(db);
    this.cognitionRepo = new CognitionRepository(db);
  }

  createProjectedEvent(params: CreateProjectedEventInput): number {
    if (!PUBLIC_EVENT_CATEGORY_SET.has(params.eventCategory)) {
      throw new Error(`Invalid projected event category: ${params.eventCategory}`);
    }
    if (!PROJECTED_EVENT_ORIGIN_SET.has(params.origin)) {
      throw new Error(`Invalid projected event origin: ${params.origin}`);
    }

    const createdAt = Date.now();
    const visibilityScope = params.visibilityScope ?? "area_visible";
    const result = this.db
      .prepare(
        `INSERT INTO event_nodes (
          session_id,
          raw_text,
          summary,
          timestamp,
          created_at,
          participants,
          emotion,
          topic_id,
          visibility_scope,
          location_entity_id,
          event_category,
          primary_actor_entity_id,
          promotion_class,
          source_record_id,
          event_origin,
          source_settlement_id,
          source_pub_index
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?)`,
      )
      .run(
        params.sessionId,
        params.summary,
        params.timestamp,
        createdAt,
        params.participants,
        params.emotion ?? null,
        params.topicId ?? null,
        visibilityScope,
        params.locationEntityId,
        params.eventCategory,
        params.primaryActorEntityId ?? null,
        params.sourceRecordId ?? null,
        params.origin,
        params.sourceSettlementId ?? null,
        params.sourcePubIndex ?? null,
      );

    const eventId = Number(result.lastInsertRowid);
    const searchScope = visibilityScope === "world_public" ? "world" : "area";
    if (searchScope === "world") {
      this.syncSearchDoc("world", makeNodeRef("event", eventId), params.summary);
    } else {
      this.syncSearchDoc(
        "area",
        makeNodeRef("event", eventId),
        params.summary,
        undefined,
        params.locationEntityId,
      );
    }
    return eventId;
  }

  createPromotedEvent(params: CreatePromotedEventInput): number {
    if (!PUBLIC_EVENT_CATEGORY_SET.has(params.eventCategory)) {
      throw new Error(`Invalid promoted event category: ${params.eventCategory}`);
    }

    const locationEntityId = this.resolveLocationEntityId(params.locationEntityId, params.sourceEventId);
    const createdAt = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO event_nodes (
          session_id,
          raw_text,
          summary,
          timestamp,
          created_at,
          participants,
          emotion,
          topic_id,
          visibility_scope,
          location_entity_id,
          event_category,
          primary_actor_entity_id,
          promotion_class,
          source_record_id,
          event_origin
        ) VALUES (?, NULL, ?, ?, ?, ?, NULL, NULL, 'world_public', ?, ?, ?, 'none', NULL, 'promotion')`,
      )
      .run(
        params.sessionId,
        params.summary,
        params.timestamp,
        createdAt,
        params.participants,
        locationEntityId,
        params.eventCategory,
        params.primaryActorEntityId ?? null,
      );

    const eventId = Number(result.lastInsertRowid);
    this.syncSearchDoc("world", makeNodeRef("event", eventId), params.summary);
    return eventId;
  }

  createLogicEdge(sourceEventId: number, targetEventId: number, relationType: LogicEdgeType): number {
    if (!LOGIC_EDGE_TYPE_SET.has(relationType)) {
      throw new Error(`Invalid logic edge relation_type: ${relationType}`);
    }

    const result = this.db
      .prepare(
        `INSERT INTO logic_edges (source_event_id, target_event_id, relation_type, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sourceEventId, targetEventId, relationType, Date.now());

    return Number(result.lastInsertRowid);
  }

  createTopic(name: string, description?: string): number {
    const createdAt = Date.now();
    this.db
      .prepare(`INSERT OR IGNORE INTO topics (name, description, created_at) VALUES (?, ?, ?)`)
      .run(name, description ?? null, createdAt);

    const row = this.db.prepare(`SELECT id FROM topics WHERE name = ?`).get(name) as { id: number } | null;
    if (!row) {
      throw new Error(`Failed to create or load topic: ${name}`);
    }
    return row.id;
  }

  upsertEntity(params: UpsertEntityInput): number {
    const pointerKey = params.pointerKey.normalize("NFC");
    const displayName = params.displayName.normalize("NFC");
    const now = Date.now();

    if (params.memoryScope === "shared_public") {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO entity_nodes
           (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pointerKey,
          displayName,
          params.entityType,
          "shared_public",
          null,
          params.canonicalEntityId ?? null,
          params.summary ?? null,
          now,
          now,
        );

      if (params.summary !== undefined) {
        this.db
          .prepare(
            `UPDATE entity_nodes
             SET summary = ?, updated_at = ?
             WHERE pointer_key = ? AND memory_scope = 'shared_public'`,
          )
          .run(params.summary, now, pointerKey);
      }

      const row = this.db
        .prepare(`SELECT id FROM entity_nodes WHERE pointer_key = ? AND memory_scope = 'shared_public'`)
        .get(pointerKey) as { id: number } | null;
      if (!row) {
        throw new Error(`Failed to upsert shared entity: ${pointerKey}`);
      }
      return row.id;
    }

    if (!params.ownerAgentId) {
      throw new Error("ownerAgentId is required for private_overlay entity upsert");
    }

    this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_nodes
         (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pointerKey,
        displayName,
        params.entityType,
        "private_overlay",
        params.ownerAgentId,
        params.canonicalEntityId ?? null,
        params.summary ?? null,
        now,
        now,
      );

    if (params.summary !== undefined) {
      this.db
        .prepare(
          `UPDATE entity_nodes
           SET summary = ?, updated_at = ?
           WHERE pointer_key = ? AND memory_scope = 'private_overlay' AND owner_agent_id = ?`,
        )
        .run(params.summary, now, pointerKey, params.ownerAgentId);
    }

    const row = this.db
      .prepare(
        `SELECT id
         FROM entity_nodes
         WHERE pointer_key = ? AND memory_scope = 'private_overlay' AND owner_agent_id = ?`,
      )
      .get(pointerKey, params.ownerAgentId) as { id: number } | null;

    if (!row) {
      throw new Error(`Failed to upsert private entity: ${params.ownerAgentId}/${pointerKey}`);
    }

    return row.id;
  }

  resolveEntityByPointerKey(pointerKey: string, agentId: string): number | null {
    const normalizedPointerKey = pointerKey.normalize("NFC");
    const row = this.db
      .prepare(
        `SELECT id
         FROM entity_nodes
         WHERE pointer_key = ?
           AND (
             (memory_scope = 'private_overlay' AND owner_agent_id = ?)
             OR memory_scope = 'shared_public'
           )
         ORDER BY CASE WHEN memory_scope = 'private_overlay' THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(normalizedPointerKey, agentId) as { id: number } | null;

    return row?.id ?? null;
  }

  getEntityById(id: number): { pointerKey: string } | null {
    const row = this.db
      .prepare(
        `SELECT pointer_key
         FROM entity_nodes
         WHERE id = ?
         LIMIT 1`,
      )
      .get(id) as { pointer_key: string } | null;

    return row ? { pointerKey: row.pointer_key } : null;
  }

  upsertExplicitAssertion(params: UpsertExplicitAssertionInput): { id: number; ref: NodeRef } {
    const result = this.cognitionRepo.upsertAssertion(params);
    return { id: result.id, ref: makeNodeRef("assertion", result.id) };
  }

  upsertExplicitEvaluation(params: UpsertExplicitEvaluationInput): { id: number; ref: NodeRef } {
    const result = this.cognitionRepo.upsertEvaluation(params);
    return { id: result.id, ref: makeNodeRef("evaluation", result.id) };
  }

  upsertExplicitCommitment(params: UpsertExplicitCommitmentInput): { id: number; ref: NodeRef } {
    const result = this.cognitionRepo.upsertCommitment(params);
    return { id: result.id, ref: makeNodeRef("commitment", result.id) };
  }

  retractExplicitCognition(agentId: string, cognitionKey: string, kind: "assertion" | "evaluation" | "commitment", settlementId?: string): void {
    this.cognitionRepo.retractCognition(agentId, cognitionKey, kind, settlementId);
  }

  createEntityAlias(canonicalId: number, alias: string, aliasType?: string, ownerAgentId?: string): number {
    const existing = this.db
      .prepare(
        `SELECT id FROM entity_aliases
         WHERE canonical_id = ?
           AND alias = ?
           AND ((alias_type = ?) OR (alias_type IS NULL AND ? IS NULL))
           AND ((owner_agent_id = ?) OR (owner_agent_id IS NULL AND ? IS NULL))`,
      )
      .get(
        canonicalId,
        alias,
        aliasType ?? null,
        aliasType ?? null,
        ownerAgentId ?? null,
        ownerAgentId ?? null,
      ) as { id: number } | null;

    if (existing) {
      return existing.id;
    }

    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_aliases (canonical_id, alias, alias_type, owner_agent_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(canonicalId, alias, aliasType ?? null, ownerAgentId ?? null);

    if (result.changes > 0) {
      return Number(result.lastInsertRowid);
    }

    const row = this.db
      .prepare(
        `SELECT id FROM entity_aliases
         WHERE canonical_id = ?
           AND alias = ?
           AND ((alias_type = ?) OR (alias_type IS NULL AND ? IS NULL))
           AND ((owner_agent_id = ?) OR (owner_agent_id IS NULL AND ? IS NULL))`,
      )
      .get(
        canonicalId,
        alias,
        aliasType ?? null,
        aliasType ?? null,
        ownerAgentId ?? null,
        ownerAgentId ?? null,
      ) as { id: number } | null;
    if (!row) {
      throw new Error(`Failed to create alias: ${alias}`);
    }
    return row.id;
  }

  createRedirect(oldName: string, newName: string, redirectType?: string, ownerAgentId?: string): number {
    const result = this.db
      .prepare(
        `INSERT INTO pointer_redirects (old_name, new_name, redirect_type, owner_agent_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(oldName, newName, redirectType ?? null, ownerAgentId ?? null, Date.now());
    return Number(result.lastInsertRowid);
  }

  createFact(sourceEntityId: number, targetEntityId: number, predicate: string, sourceEventId?: number): number {
    const existing = this.db
      .prepare(
        `SELECT id FROM fact_edges
         WHERE source_entity_id = ?
           AND predicate = ?
           AND target_entity_id = ?
           AND t_invalid = ?`,
      )
      .get(sourceEntityId, predicate, targetEntityId, MAX_INTEGER) as { id: number } | null;

    if (existing) {
      this.invalidateFact(existing.id);
    }

    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO fact_edges (
          source_entity_id,
          target_entity_id,
          predicate,
          t_valid,
          t_invalid,
          t_created,
          t_expired,
          source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceEntityId,
        targetEntityId,
        predicate,
        now,
        MAX_INTEGER,
        now,
        MAX_INTEGER,
        sourceEventId ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  invalidateFact(factId: number): void {
    const now = Date.now();
    this.db.prepare(`UPDATE fact_edges SET t_invalid = ?, t_expired = ? WHERE id = ?`).run(now, now, factId);
  }

  createPrivateEvent(params: CreatePrivateEventInput): number {
    if (!PRIVATE_EVENT_CATEGORY_SET.has(params.eventCategory)) {
      throw new Error(`Invalid private event category: ${params.eventCategory}`);
    }
    if (!PROJECTION_CLASS_SET.has(params.projectionClass)) {
      throw new Error(`Invalid projection class: ${params.projectionClass}`);
    }

    const now = Date.now();
    const eventSession = params.eventId
      ? (this.db.prepare(`SELECT session_id FROM event_nodes WHERE id = ?`).get(params.eventId) as EventSessionRow | null)
      : null;
    const sessionId = eventSession?.session_id ?? `agent:${params.agentId}`;
    const settlementId = params.sourceRecordId ?? `legacy:${params.agentId}:${now}`;

    if (params.eventCategory === "thought") {
      const cognitionKey = `legacy_thought:${params.agentId}:${now}`;
      const record = {
        role: params.role ?? null,
        privateNotes: params.privateNotes ?? null,
        salience: params.salience ?? null,
        emotion: params.emotion ?? null,
        sourceEventId: params.eventId ?? null,
        primaryActorEntityId: params.primaryActorEntityId ?? null,
        projectionClass: params.projectionClass,
        locationEntityId: params.locationEntityId ?? null,
        summary: params.projectableSummary ?? null,
        sourceRecordId: params.sourceRecordId ?? null,
        category: params.eventCategory,
      };

      const eventResult = this.db
        .prepare(
          `INSERT INTO private_cognition_events (
            agent_id,
            cognition_key,
            kind,
            op,
            record_json,
            settlement_id,
            committed_time,
            created_at
          ) VALUES (?, ?, 'evaluation', 'upsert', ?, ?, ?, ?)`,
        )
        .run(params.agentId, cognitionKey, JSON.stringify(record), settlementId, now, now);

      const cognitionEventId = Number(eventResult.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO private_cognition_current (
            agent_id,
            cognition_key,
            kind,
            status,
            summary_text,
            record_json,
            source_event_id,
            updated_at
          ) VALUES (?, ?, 'evaluation', 'active', ?, ?, ?, ?)
          ON CONFLICT(agent_id, cognition_key) DO UPDATE SET
            status = 'active',
            summary_text = excluded.summary_text,
            record_json = excluded.record_json,
            source_event_id = excluded.source_event_id,
            updated_at = excluded.updated_at`,
        )
        .run(
          params.agentId,
          cognitionKey,
          params.projectableSummary ?? null,
          JSON.stringify(record),
          cognitionEventId,
          now,
        );

      return cognitionEventId;
    }

    const result = this.db
      .prepare(
        `INSERT INTO private_episode_events (
          agent_id,
          session_id,
          settlement_id,
          category,
          summary,
          private_notes,
          location_entity_id,
          location_text,
          valid_time,
          committed_time,
          source_local_ref,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.agentId,
        sessionId,
        settlementId,
        params.eventCategory,
        params.projectableSummary ?? "",
        params.privateNotes ?? null,
        params.locationEntityId ?? null,
        null,
        params.eventId ?? null,
        now,
        params.sourceRecordId ?? null,
        now,
      );

    return Number(result.lastInsertRowid);
  }

  createPrivateBelief(params: CreatePrivateBeliefInput): number {
    const source = this.getEntityById(params.sourceEntityId);
    const target = this.getEntityById(params.targetEntityId);
    if (!source || !target) {
      throw new Error(
        `Unable to resolve source/target entity pointer keys for private belief: ${params.sourceEntityId} -> ${params.targetEntityId}`,
      );
    }

    const cognitionKey = `legacy_private_belief:${params.agentId}:${params.sourceEntityId}:${params.predicate}:${params.targetEntityId}`;
    const assertion = this.cognitionRepo.upsertAssertion({
      agentId: params.agentId,
      cognitionKey,
      settlementId: `legacy:create_private_belief:${params.agentId}`,
      opIndex: 0,
      sourcePointerKey: source.pointerKey,
      predicate: params.predicate,
      targetPointerKey: target.pointerKey,
      stance: params.stance,
      basis: params.basis,
      provenance: params.provenance,
    });

    return assertion.id;
  }

  updatePrivateEventLink(_privateEventId: number, _publicEventId: number): void {
    // No-op: episode→public event linkage is tracked via settlement_id in private_episode_events
  }

  syncSearchDoc(
    scope: SearchScope,
    sourceRef: NodeRef,
    content: string,
    agentId?: string,
    locationEntityId?: number,
  ): number {
    const createdAt = Date.now();
    const docType = this.getDocTypeFromRef(sourceRef);

    if (scope === "private") {
      if (!agentId) {
        throw new Error("agentId is required for private search docs");
      }

      const existing = this.db
        .prepare(`SELECT id FROM search_docs_private WHERE source_ref = ? AND agent_id = ?`)
        .get(sourceRef, agentId) as { id: number } | null;

      const result = this.db
        .prepare(
          `INSERT OR REPLACE INTO search_docs_private (id, doc_type, source_ref, agent_id, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(existing?.id ?? null, docType, sourceRef, agentId, content, createdAt);

      const docId = existing?.id ?? Number(result.lastInsertRowid);
      this.syncFtsRow("search_docs_private_fts", docId, content);
      return docId;
    }

    if (scope === "area") {
      if (locationEntityId === undefined) {
        throw new Error("locationEntityId is required for area search docs");
      }

      const existing = this.db
        .prepare(`SELECT id FROM search_docs_area WHERE source_ref = ?`)
        .get(sourceRef) as { id: number } | null;

      const result = this.db
        .prepare(
          `INSERT OR REPLACE INTO search_docs_area (id, doc_type, source_ref, location_entity_id, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(existing?.id ?? null, docType, sourceRef, locationEntityId, content, createdAt);

      const docId = existing?.id ?? Number(result.lastInsertRowid);
      this.syncFtsRow("search_docs_area_fts", docId, content);
      return docId;
    }

    const existing = this.db
      .prepare(`SELECT id FROM search_docs_world WHERE source_ref = ?`)
      .get(sourceRef) as { id: number } | null;

    const result = this.db
      .prepare(
        `INSERT OR REPLACE INTO search_docs_world (id, doc_type, source_ref, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(existing?.id ?? null, docType, sourceRef, content, createdAt);

    const docId = existing?.id ?? Number(result.lastInsertRowid);
    this.syncFtsRow("search_docs_world_fts", docId, content);
    return docId;
  }

  removeSearchDoc(scope: SearchScope, sourceRef: NodeRef): void {
    if (scope === "private") {
      const rows = this.db
        .prepare(`SELECT id FROM search_docs_private WHERE source_ref = ?`)
        .all(sourceRef) as { id: number }[];
      this.db.prepare(`DELETE FROM search_docs_private WHERE source_ref = ?`).run(sourceRef);
      for (const row of rows) {
        this.db.prepare(`DELETE FROM search_docs_private_fts WHERE rowid = ?`).run(row.id);
      }
      return;
    }

    if (scope === "area") {
      const rows = this.db
        .prepare(`SELECT id FROM search_docs_area WHERE source_ref = ?`)
        .all(sourceRef) as { id: number }[];
      this.db.prepare(`DELETE FROM search_docs_area WHERE source_ref = ?`).run(sourceRef);
      for (const row of rows) {
        this.db.prepare(`DELETE FROM search_docs_area_fts WHERE rowid = ?`).run(row.id);
      }
      return;
    }

    const rows = this.db
      .prepare(`SELECT id FROM search_docs_world WHERE source_ref = ?`)
      .all(sourceRef) as { id: number }[];
    this.db.prepare(`DELETE FROM search_docs_world WHERE source_ref = ?`).run(sourceRef);
    for (const row of rows) {
      this.db.prepare(`DELETE FROM search_docs_world_fts WHERE rowid = ?`).run(row.id);
    }
  }

  upsertNodeEmbedding(
    nodeRef: NodeRef,
    nodeKind: NodeRefKind,
    viewType: "primary" | "keywords" | "context",
    modelId: string,
    embedding: Float32Array,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(nodeRef, nodeKind, viewType, modelId, Buffer.from(embedding.buffer), Date.now());
  }

  upsertSemanticEdge(
    sourceRef: NodeRef,
    targetRef: NodeRef,
    relationType: SemanticEdgeType,
    weight: number,
  ): void {
    this.assertPrivateAgentCompatibility(sourceRef, targetRef);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO semantic_edges
         (source_node_ref, target_node_ref, relation_type, weight, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sourceRef, targetRef, relationType, weight, now, now);
  }

  upsertNodeScores(nodeRef: NodeRef, salience: number, centrality: number, bridgeScore: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO node_scores (node_ref, salience, centrality, bridge_score, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(nodeRef, salience, centrality, bridgeScore, Date.now());
  }

  createSameEpisodeEdges(events: SameEpisodeEvent[]): void {
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
    this.batcher.runInTransaction(() => {
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
    });
  }

  runBatch(fn: () => void): void {
    this.batcher.runInTransaction(fn);
  }

  private resolveLocationEntityId(locationEntityId?: number, sourceEventId?: number): number {
    if (locationEntityId !== undefined) {
      return locationEntityId;
    }
    if (sourceEventId === undefined) {
      throw new Error("locationEntityId is required when sourceEventId is not provided");
    }

    const row = this.db
      .prepare(`SELECT location_entity_id FROM event_nodes WHERE id = ?`)
      .get(sourceEventId) as { location_entity_id: number } | null;

    if (!row) {
      throw new Error(`Source event not found: ${sourceEventId}`);
    }
    return row.location_entity_id;
  }

  private getDocTypeFromRef(sourceRef: NodeRef): string {
    const [kind] = sourceRef.split(":", 1);
    return kind || "node";
  }

  private syncFtsRow(tableName: string, rowId: number, content: string): void {
    try {
      this.db.prepare(`DELETE FROM ${tableName} WHERE rowid = ?`).run(rowId);
      this.db.prepare(`INSERT INTO ${tableName}(rowid, content) VALUES (?, ?)`).run(rowId, content);
    } catch (error) {
      console.error(`[GraphStorageService] FTS sync failed for ${tableName} rowid=${rowId}`, {
        table: tableName,
        rowId,
        contentLength: content.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private getPrivateNodeAgent(nodeRef: NodeRef): string | null {
    if (nodeRef.startsWith(legacyPrivateEventPrefix)) {
      const id = this.parseLegacyNodeRefId(nodeRef, legacyPrivateEventPrefix);
      const episodeRow = this.db.prepare(`SELECT agent_id FROM private_episode_events WHERE id = ?`).get(id) as
        | { agent_id: string }
        | null;
      if (episodeRow) {
        return episodeRow.agent_id;
      }

      const cognitionRow = this.db.prepare(`SELECT agent_id FROM private_cognition_current WHERE id = ?`).get(id) as
        | { agent_id: string }
        | null;
      return cognitionRow?.agent_id ?? null;
    }

    if (nodeRef.startsWith(legacyPrivateBeliefPrefix)) {
      const id = this.parseLegacyNodeRefId(nodeRef, legacyPrivateBeliefPrefix);
      const row = this.db.prepare(`SELECT agent_id FROM private_cognition_current WHERE id = ?`).get(id) as
        | { agent_id: string }
        | null;
      return row?.agent_id ?? null;
    }

    return null;
  }

  private assertPrivateAgentCompatibility(sourceRef: NodeRef, targetRef: NodeRef): void {
    const sourceAgent = this.getPrivateNodeAgent(sourceRef);
    const targetAgent = this.getPrivateNodeAgent(targetRef);
    if (!sourceAgent || !targetAgent) {
      return;
    }
    if (sourceAgent !== targetAgent) {
      throw new Error("Cross-agent private semantic edges are not allowed");
    }
  }

  private parseLegacyNodeRefId(nodeRef: NodeRef, prefix: string): number {
    if (!nodeRef.startsWith(prefix)) {
      throw new Error(`Invalid node ref prefix for ${prefix}: ${nodeRef}`);
    }
    const rawId = Number(nodeRef.slice(prefix.length));
    if (!Number.isInteger(rawId) || rawId <= 0) {
      throw new Error(`Invalid node ref id: ${nodeRef}`);
    }
    return rawId;
  }
}
