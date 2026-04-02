import type { EpisodeRow } from "../../../memory/episode/episode-repo.js";
import type {
  EntityNode,
  EventNode,
  FactEdge,
  Topic,
  ViewerContext,
} from "../../../memory/types.js";

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

export interface RetrievalReadRepo {
  readByEntity(pointerKey: string, viewerContext: ViewerContext): Promise<EntityReadResult>;
  readByTopic(name: string, viewerContext: ViewerContext): Promise<TopicReadResult>;
  readByEventIds(ids: number[], viewerContext: ViewerContext): Promise<EventNode[]>;
  readByFactIds(ids: number[], viewerContext: ViewerContext): Promise<FactEdge[]>;
  resolveRedirect(name: string, ownerAgentId?: string): Promise<string>;
  resolveEntityByPointer(pointerKey: string, viewerAgentId: string): Promise<EntityNode | null>;
  countNodeEmbeddings(): Promise<number>;
}
