import type {
  EpisodeAppendParams,
  EpisodeRow,
} from "../../../memory/episode/episode-repo.js";

export interface EpisodeRepo {
  append(params: EpisodeAppendParams & Record<string, unknown>): Promise<number>;
  readById(id: number): Promise<EpisodeRow | null>;
  readBySettlement(settlementId: string, agentId: string): Promise<EpisodeRow[]>;
  readPublicationsBySettlement(
    settlementId: string,
  ): Promise<Array<{ id: number; source_pub_index: number | null }>>;
  readByAgent(agentId: string, limit?: number): Promise<EpisodeRow[]>;
}
