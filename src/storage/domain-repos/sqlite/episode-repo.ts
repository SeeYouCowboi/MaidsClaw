import { EpisodeRepository } from "../../../memory/episode/episode-repo.js";
import type {
  EpisodeAppendParams,
  EpisodeRow,
} from "../../../memory/episode/episode-repo.js";
import type { EpisodeRepo } from "../contracts/episode-repo.js";

export class SqliteEpisodeRepoAdapter implements EpisodeRepo {
  constructor(private readonly impl: EpisodeRepository) {}

  async append(params: EpisodeAppendParams & Record<string, unknown>): Promise<number> {
    return Promise.resolve(this.impl.append(params));
  }

  async readBySettlement(settlementId: string, agentId: string): Promise<EpisodeRow[]> {
    return Promise.resolve(this.impl.readBySettlement(settlementId, agentId));
  }

  async readByAgent(agentId: string, limit?: number): Promise<EpisodeRow[]> {
    return Promise.resolve(this.impl.readByAgent(agentId, limit));
  }
}
