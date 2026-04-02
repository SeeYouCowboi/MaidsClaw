import type {
  EpisodeAppendParams,
  EpisodeRow,
} from "../../../memory/episode/episode-repo.js";

export interface EpisodeRepo {
  append(params: EpisodeAppendParams & Record<string, unknown>): Promise<number>;
  readBySettlement(settlementId: string, agentId: string): Promise<EpisodeRow[]>;
  readByAgent(agentId: string, limit?: number): Promise<EpisodeRow[]>;
}
