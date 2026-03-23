import type { Db } from "../storage/database.js";
import { EmbeddingService } from "./embeddings.js";
import { CognitionSearchService } from "./cognition/cognition-search.js";
import type { RetrievalTemplate } from "./contracts/retrieval-template.js";
import { NarrativeSearchService } from "./narrative/narrative-search.js";
import {
  RetrievalOrchestrator,
  type RetrievalDedupContext,
  type TypedRetrievalResult,
} from "./retrieval/retrieval-orchestrator.js";
import { MAX_INTEGER } from "./schema.js";
import { TransactionBatcher } from "./transaction-batcher.js";
import type {
  AgentEventOverlay,
  EntityNode,
  EventNode,
  FactEdge,
  MemoryHint,
  NodeRef,
  NodeRefKind,
  SeedCandidate,
  Topic,
  ViewerContext,
} from "./types.js";

type SearchResult = {
  source_ref: NodeRef;
  doc_type: string;
  content: string;
  scope: "private" | "area" | "world";
  score: number;
};

type EntityReadResult = {
  entity: EntityNode | null;
  facts: FactEdge[];
  events: EventNode[];
  overlays: AgentEventOverlay[];
};

type TopicReadResult = {
  topic: Topic | null;
  events: EventNode[];
  overlays: AgentEventOverlay[];
};

export class RetrievalService {
  private readonly embeddingService: EmbeddingService;
  private readonly narrativeSearch: NarrativeSearchService;
  private readonly cognitionSearch: CognitionSearchService;
  private readonly orchestrator: RetrievalOrchestrator;

  constructor(private readonly db: Db) {
    const batcher = new TransactionBatcher(db);
    this.embeddingService = new EmbeddingService(db, batcher);
    this.narrativeSearch = new NarrativeSearchService(db);
    this.cognitionSearch = new CognitionSearchService(db);
    this.orchestrator = new RetrievalOrchestrator(
      this.narrativeSearch,
      this.cognitionSearch,
      this.cognitionSearch.createCurrentProjectionReader(),
    );
  }

  readByEntity(pointerKey: string, viewerContext: ViewerContext): EntityReadResult {
    const resolvedPointer = this.resolveRedirect(pointerKey, viewerContext.viewer_agent_id);
    const entity = this.resolveEntityByPointer(resolvedPointer, viewerContext.viewer_agent_id);
    if (!entity) {
      return { entity: null, facts: [], events: [], overlays: [] };
    }

    const facts = this.db
      .prepare(
        "SELECT * FROM fact_edges WHERE (source_entity_id=? OR target_entity_id=?) AND t_invalid=?",
      )
      .all(entity.id, entity.id, MAX_INTEGER) as FactEdge[];

    const events = viewerContext.current_area_id != null
      ? this.db
          .prepare(
            `SELECT * FROM event_nodes
             WHERE (participants LIKE ? OR primary_actor_entity_id=?)
               AND (
                 visibility_scope='world_public'
                 OR (visibility_scope='area_visible' AND location_entity_id=?)
               )`,
          )
          .all(`%entity:${entity.id}%`, entity.id, viewerContext.current_area_id) as EventNode[]
      : this.db
          .prepare(
            `SELECT * FROM event_nodes
             WHERE (participants LIKE ? OR primary_actor_entity_id=?)
               AND visibility_scope='world_public'`,
          )
          .all(`%entity:${entity.id}%`, entity.id) as EventNode[];

    const eventIds = events.map((event) => event.id);
    const overlays = eventIds.length > 0
      ? (this.db
          .prepare(
            `SELECT * FROM agent_event_overlay
             WHERE agent_id=? AND (event_id IN (${eventIds.map(() => "?").join(",")}) OR primary_actor_entity_id=?)`,
          )
          .all(viewerContext.viewer_agent_id, ...eventIds, entity.id) as AgentEventOverlay[])
      : (this.db
          .prepare(
            "SELECT * FROM agent_event_overlay WHERE agent_id=? AND primary_actor_entity_id=?",
          )
          .all(viewerContext.viewer_agent_id, entity.id) as AgentEventOverlay[]);

    return { entity, facts, events, overlays };
  }

  readByTopic(name: string, viewerContext: ViewerContext): TopicReadResult {
    const resolvedName = this.resolveRedirect(name, viewerContext.viewer_agent_id);
    const topic = this.db.prepare("SELECT * FROM topics WHERE name=?").get(resolvedName) as Topic | null;
    if (!topic) {
      return { topic: null, events: [], overlays: [] };
    }

    const events = viewerContext.current_area_id != null
      ? this.db
          .prepare(
            `SELECT * FROM event_nodes
             WHERE topic_id=?
               AND (
                 visibility_scope='world_public'
                 OR (visibility_scope='area_visible' AND location_entity_id=?)
               )`,
          )
          .all(topic.id, viewerContext.current_area_id) as EventNode[]
      : this.db
          .prepare(
            `SELECT * FROM event_nodes
             WHERE topic_id=?
               AND visibility_scope='world_public'`,
          )
          .all(topic.id) as EventNode[];

    const eventIds = events.map((event) => event.id);
    const overlays = eventIds.length === 0
      ? []
      : (this.db
          .prepare(
            `SELECT * FROM agent_event_overlay
             WHERE agent_id=? AND event_id IN (${eventIds.map(() => "?").join(",")})`,
          )
          .all(viewerContext.viewer_agent_id, ...eventIds) as AgentEventOverlay[]);

    return { topic, events, overlays };
  }

  readByEventIds(ids: number[], viewerContext: ViewerContext): EventNode[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(",");
    return viewerContext.current_area_id != null
      ? this.db
          .prepare(
            `SELECT * FROM event_nodes
             WHERE id IN (${placeholders})
               AND (
                 visibility_scope='world_public'
                 OR (visibility_scope='area_visible' AND location_entity_id=?)
               )`,
          )
          .all(...ids, viewerContext.current_area_id) as EventNode[]
      : this.db
          .prepare(
            `SELECT * FROM event_nodes
             WHERE id IN (${placeholders})
               AND visibility_scope='world_public'`,
          )
          .all(...ids) as EventNode[];
  }

  readByFactIds(ids: number[], _viewerContext: ViewerContext): FactEdge[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM fact_edges WHERE id IN (${placeholders}) AND t_invalid=?`)
      .all(...ids, MAX_INTEGER) as FactEdge[];
  }

  async searchVisibleNarrative(query: string, viewerContext: ViewerContext): Promise<SearchResult[]> {
    const narrativeResults = await this.narrativeSearch.searchNarrative(query, viewerContext);
    return narrativeResults.map((r) => ({
      source_ref: r.source_ref,
      doc_type: r.doc_type,
      content: r.content,
      scope: r.scope,
      score: r.score,
    }));
  }

  async generateMemoryHints(
    userMessage: string,
    viewerContext: ViewerContext,
    limit = 5,
  ): Promise<MemoryHint[]> {
    const typed = await this.generateTypedRetrieval(
      userMessage,
      viewerContext,
      undefined,
      {
        narrativeEnabled: true,
        cognitionEnabled: false,
        conflictNotesEnabled: false,
        episodeEnabled: false,
        narrativeBudget: limit,
      },
    );
    return typed.narrative.map((segment) => ({
      source_ref: segment.source_ref as MemoryHint["source_ref"],
      doc_type: segment.doc_type,
      content: segment.content,
      scope: segment.scope,
      score: segment.score,
    }));
  }

  async generateTypedRetrieval(
    query: string,
    viewerContext: ViewerContext,
    dedupContext?: RetrievalDedupContext,
    retrievalTemplate?: RetrievalTemplate,
  ): Promise<TypedRetrievalResult> {
    const result = await this.orchestrator.search(
      query,
      viewerContext,
      viewerContext.viewer_role,
      retrievalTemplate,
      dedupContext,
    );
    return result.typed;
  }

  async localizeSeedsHybrid(
    query: string,
    viewerContext: ViewerContext,
    limit = 10,
    queryEmbedding?: Float32Array,
  ): Promise<SeedCandidate[]> {
    const lexicalResults = await this.searchVisibleNarrative(query, viewerContext);

    const lexicalRankByRef = new Map<string, number>();
    for (let i = 0; i < lexicalResults.length; i += 1) {
      lexicalRankByRef.set(lexicalResults[i].source_ref, i + 1);
    }

    const semanticRankByRef = new Map<string, { rank: number; nodeKind: string }>();
    const embeddingCount = this.db.prepare("SELECT count(*) as count FROM node_embeddings").get() as {
      count: number;
    };
    if (embeddingCount.count > 0 && queryEmbedding) {
      const neighbors = this.embeddingService.queryNearestNeighbors(queryEmbedding, {
        agentId: viewerContext.viewer_agent_id,
        limit: Math.max(limit * 4, 20),
      });
      for (let i = 0; i < neighbors.length; i += 1) {
        semanticRankByRef.set(neighbors[i].nodeRef, { rank: i + 1, nodeKind: neighbors[i].nodeKind });
      }
    }

    const fused = new Map<string, SeedCandidate>();
    for (let i = 0; i < lexicalResults.length; i += 1) {
      const row = lexicalResults[i];
      const nodeKind = this.parseNodeRefKind(row.source_ref);
      if (!nodeKind) {
        continue;
      }

      const lexicalRrf = this.rrf(i + 1);
      const semanticMatch = semanticRankByRef.get(row.source_ref);
      const semanticRrf = semanticMatch ? this.rrf(semanticMatch.rank) : 0;
      const fusedScore = semanticRankByRef.size > 0 ? 0.5 * lexicalRrf + 0.5 * semanticRrf : lexicalRrf;

      fused.set(row.source_ref, {
        node_ref: row.source_ref,
        node_kind: nodeKind,
        lexical_score: lexicalRrf,
        semantic_score: semanticRrf,
        fused_score: fusedScore,
        source_scope: row.scope,
      });
    }

    for (const [nodeRef, semantic] of semanticRankByRef.entries()) {
      if (fused.has(nodeRef)) {
        continue;
      }
      const nodeKind = this.parseNodeRefKind(nodeRef);
      if (!nodeKind) {
        continue;
      }
      const semanticRrf = this.rrf(semantic.rank);
      fused.set(nodeRef, {
        node_ref: nodeRef as NodeRef,
        node_kind: nodeKind,
        lexical_score: 0,
        semantic_score: semanticRrf,
        fused_score: 0.5 * semanticRrf,
        source_scope: this.scopeFromNodeKind(nodeKind),
      });
    }

    const selected: SeedCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of Array.from(fused.values()).sort((a, b) => b.fused_score - a.fused_score)) {
      if (seen.has(candidate.node_ref)) {
        continue;
      }
      selected.push(candidate);
      seen.add(candidate.node_ref);
      if (selected.length >= limit) {
        break;
      }
    }

    return selected;
  }

  private resolveRedirect(name: string, ownerAgentId?: string): string {
    const agentRedirect = ownerAgentId
      ? (this.db
          .prepare("SELECT new_name FROM pointer_redirects WHERE old_name=? AND owner_agent_id=?")
          .get(name, ownerAgentId) as { new_name: string } | undefined)
      : undefined;

    if (agentRedirect) {
      return agentRedirect.new_name;
    }

    const globalRedirect = this.db
      .prepare("SELECT new_name FROM pointer_redirects WHERE old_name=? AND owner_agent_id IS NULL")
      .get(name) as { new_name: string } | undefined;

    return globalRedirect?.new_name ?? name;
  }

  private resolveEntityByPointer(pointerKey: string, viewerAgentId: string): EntityNode | null {
    const privateEntity = this.db
      .prepare(
        "SELECT * FROM entity_nodes WHERE pointer_key=? AND memory_scope='private_overlay' AND owner_agent_id=? LIMIT 1",
      )
      .get(pointerKey, viewerAgentId) as EntityNode | undefined;
    if (privateEntity) {
      return privateEntity;
    }

    const sharedEntity = this.db
      .prepare(
        "SELECT * FROM entity_nodes WHERE pointer_key=? AND memory_scope='shared_public' LIMIT 1",
      )
      .get(pointerKey) as EntityNode | undefined;
    if (sharedEntity) {
      return sharedEntity;
    }

    const alias = this.db
      .prepare(
        `SELECT canonical_id
         FROM entity_aliases
         WHERE alias=? AND (owner_agent_id=? OR owner_agent_id IS NULL)
         ORDER BY CASE WHEN owner_agent_id=? THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(pointerKey, viewerAgentId, viewerAgentId) as { canonical_id: number } | undefined;
    if (!alias) {
      return null;
    }

    const aliasedPrivate = this.db
      .prepare("SELECT * FROM entity_nodes WHERE id=? AND memory_scope='private_overlay' AND owner_agent_id=?")
      .get(alias.canonical_id, viewerAgentId) as EntityNode | undefined;
    if (aliasedPrivate) {
      return aliasedPrivate;
    }

    const aliasedShared = this.db
      .prepare("SELECT * FROM entity_nodes WHERE id=? AND memory_scope='shared_public'")
      .get(alias.canonical_id) as EntityNode | undefined;
    return aliasedShared ?? null;
  }

  private rrf(rank: number): number {
    return 1 / (60 + rank);
  }

  private parseNodeRefKind(nodeRef: string): NodeRefKind | null {
    const maybeKind = nodeRef.split(":")[0];
    if (
      maybeKind === "event" ||
      maybeKind === "entity" ||
      maybeKind === "fact" ||
      maybeKind === "private_event" ||
      maybeKind === "private_belief"
    ) {
      return maybeKind;
    }
    return null;
  }

  private scopeFromNodeKind(nodeKind: NodeRefKind): "private" | "area" | "world" {
    if (nodeKind === "private_event" || nodeKind === "private_belief") {
      return "private";
    }
    return "world";
  }
}
