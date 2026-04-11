import type { EpisodeRow } from "../episode/episode-repo.js";
import type {
  RetrievalDedupContext,
  RetrievalQueryStrategy,
  TypedRetrievalResult,
} from "../retrieval/retrieval-orchestrator.js";
import type { RetrievalTraceCaptureHook } from "../retrieval.js";
import type {
  EntityNode,
  EventNode,
  FactEdge,
  MemoryHint,
  SeedCandidate,
  Topic,
  ViewerContext,
} from "../types.js";
import type { RetrievalTemplate } from "./retrieval-template.js";

export type RetrievalSearchResult = {
  source_ref: string;
  doc_type: string;
  content: string;
  scope: "private" | "area" | "world";
  score: number;
};

export type EntityReadResult = {
  entity: EntityNode | null;
  facts: FactEdge[];
  events: EventNode[];
  episodes: EpisodeRow[];
};

export type TopicReadResult = {
  topic: Topic | null;
  events: EventNode[];
  episodes: EpisodeRow[];
};

export interface RetrievalServiceLike {
  readByEntity(pointerKey: string, viewerContext: ViewerContext): Promise<EntityReadResult>;
  readByTopic(name: string, viewerContext: ViewerContext): Promise<TopicReadResult>;
  readByEventIds(ids: number[], viewerContext: ViewerContext): Promise<EventNode[]>;
  readByFactIds(ids: number[], viewerContext: ViewerContext): Promise<FactEdge[]>;

  resolveEntityByPointer(pointerKey: string, viewerAgentId: string): Promise<EntityNode | null>;
  resolveRedirect(name: string, ownerAgentId?: string): Promise<string>;

  searchVisibleNarrative(query: string, viewerContext: ViewerContext): Promise<RetrievalSearchResult[]>;
  generateMemoryHints(userMessage: string, viewerContext: ViewerContext, limit?: number): Promise<MemoryHint[]>;
  generateTypedRetrieval(
    query: string,
    viewerContext: ViewerContext,
    dedupContext?: RetrievalDedupContext,
    retrievalTemplate?: RetrievalTemplate,
    queryStrategy?: RetrievalQueryStrategy,
    contestedCount?: number,
    onTraceCapture?: RetrievalTraceCaptureHook,
  ): Promise<TypedRetrievalResult>;
  localizeSeedsHybrid(
    query: string,
    viewerContext: ViewerContext,
    limit?: number,
    queryEmbedding?: Float32Array,
  ): Promise<SeedCandidate[]>;
}
