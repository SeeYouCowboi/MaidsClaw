import type { RetrievalReadRepo } from "../storage/domain-repos/contracts/retrieval-read-repo.js";
import { parseGraphNodeRef } from "./contracts/graph-node-ref.js";
import type { EmbeddingService } from "./embeddings.js";
import type { CognitionSearchService } from "./cognition/cognition-search.js";
import type { RetrievalTemplate } from "./contracts/retrieval-template.js";
import type { NarrativeSearchService } from "./narrative/narrative-search.js";
import type {
  RetrievalOrchestrator,
  RetrievalDedupContext,
  RetrievalQueryStrategy,
  TypedRetrievalResult,
} from "./retrieval/retrieval-orchestrator.js";
import type { EpisodeRow } from "./episode/episode-repo.js";
import type {
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
  episodes: EpisodeRow[];
};

type TopicReadResult = {
  topic: Topic | null;
  events: EventNode[];
  episodes: EpisodeRow[];
};

type RetrievalServiceDeps = {
  retrievalRepo: RetrievalReadRepo;
  embeddingService?: EmbeddingService;
  narrativeSearch?: NarrativeSearchService;
  cognitionSearch?: CognitionSearchService;
  orchestrator?: RetrievalOrchestrator;
};

export class RetrievalService {
  private readonly retrievalRepo: RetrievalReadRepo;
  private readonly embeddingService: EmbeddingService;
  private readonly narrativeSearch: NarrativeSearchService;
  private readonly cognitionSearch: CognitionSearchService;
  private readonly orchestrator: RetrievalOrchestrator;

  constructor(deps: RetrievalServiceDeps) {
    this.retrievalRepo = deps.retrievalRepo;
    this.embeddingService = deps.embeddingService ?? (() => { throw new Error("embeddingService is required"); })();
    this.narrativeSearch = deps.narrativeSearch ?? (() => { throw new Error("narrativeSearch is required"); })();
    this.cognitionSearch = deps.cognitionSearch ?? (() => { throw new Error("cognitionSearch is required"); })();
    this.orchestrator = deps.orchestrator ?? (() => { throw new Error("orchestrator is required"); })();
  }

  async readByEntity(pointerKey: string, viewerContext: ViewerContext): Promise<EntityReadResult> {
    return this.retrievalRepo.readByEntity(pointerKey, viewerContext);
  }

  async readByTopic(name: string, viewerContext: ViewerContext): Promise<TopicReadResult> {
    return this.retrievalRepo.readByTopic(name, viewerContext);
  }

  async readByEventIds(ids: number[], viewerContext: ViewerContext): Promise<EventNode[]> {
    return this.retrievalRepo.readByEventIds(ids, viewerContext);
  }

  async readByFactIds(ids: number[], viewerContext: ViewerContext): Promise<FactEdge[]> {
    return this.retrievalRepo.readByFactIds(ids, viewerContext);
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
    queryStrategy: RetrievalQueryStrategy = "default_retrieval",
    contestedCount?: number,
  ): Promise<TypedRetrievalResult> {
    const result = await this.orchestrator.search(
      query,
      viewerContext,
      viewerContext.viewer_role,
      retrievalTemplate,
      dedupContext,
      queryStrategy,
      contestedCount,
    );
    const typed = result.typed;
    const conflictNotesBudget = retrievalTemplate?.conflictNotesBudget ?? 0;

    if (conflictNotesBudget > 0 && typed.conflict_notes.length === 0) {
      for (const hit of result.cognitionHits) {
        if (typed.conflict_notes.length >= conflictNotesBudget) {
          break;
        }
        if (hit.stance !== "contested") {
          continue;
        }
        const content = hit.conflictSummary?.trim() || "contested cognition";
        typed.conflict_notes.push({
          source_ref: `conflict_note:${String(hit.source_ref)}`,
          from_source_ref: String(hit.source_ref),
          cognitionKey: hit.cognitionKey ?? null,
          content,
          score: hit.updated_at,
        });
      }
    }

    return typed;
  }

  async localizeSeedsHybrid(
    query: string,
    viewerContext: ViewerContext,
    limit = 10,
    queryEmbedding?: Float32Array,
    modelId?: string,
  ): Promise<SeedCandidate[]> {
    const lexicalResults = await this.searchVisibleNarrative(query, viewerContext);

    const lexicalRankByRef = new Map<string, number>();
    for (let i = 0; i < lexicalResults.length; i += 1) {
      lexicalRankByRef.set(lexicalResults[i].source_ref, i + 1);
    }

    const semanticRankByRef = new Map<string, { rank: number; nodeKind: string }>();
    const embeddingCount = await this.retrievalRepo.countNodeEmbeddings();
    if (embeddingCount > 0 && queryEmbedding) {
      const neighbors = await this.embeddingService.queryNearestNeighbors(queryEmbedding, {
        agentId: viewerContext.viewer_agent_id,
        limit: Math.max(limit * 4, 20),
        modelId,
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

  async resolveRedirect(name: string, ownerAgentId?: string): Promise<string> {
    return this.retrievalRepo.resolveRedirect(name, ownerAgentId);
  }

  async resolveEntityByPointer(pointerKey: string, viewerAgentId: string): Promise<EntityNode | null> {
    return this.retrievalRepo.resolveEntityByPointer(pointerKey, viewerAgentId);
  }

  private rrf(rank: number): number {
    return 1 / (60 + rank);
  }

  private parseNodeRefKind(nodeRef: string): NodeRefKind | null {
    try {
      return parseGraphNodeRef(nodeRef).kind;
    } catch {
      return null;
    }
  }

  private scopeFromNodeKind(nodeKind: NodeRefKind): "private" | "area" | "world" {
    const kind = nodeKind as string;
    if (kind === "assertion" || kind === "evaluation" || kind === "commitment") {
      return "private";
    }
    return "world";
  }
}
