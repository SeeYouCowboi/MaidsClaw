import type {
  EpisodeAppendParams,
  EpisodeRow,
} from "../../../memory/episode/episode-repo.js";

export interface EpisodeRepo {
  append(params: EpisodeAppendParams & Record<string, unknown>): Promise<number>;
  readById(id: number): Promise<EpisodeRow | null>;
  /**
   * Batch-read episodes by id with an agent_id gate. Used by retrieval paths
   * that resolve node_embedding neighbors (which carry only `episode:N` refs)
   * back to their full row content while ensuring cross-agent leakage is
   * impossible. Rows whose agent_id does not match are silently omitted.
   */
  readByIds(agentId: string, ids: number[]): Promise<EpisodeRow[]>;
  readBySettlement(settlementId: string, agentId: string): Promise<EpisodeRow[]>;
  readPublicationsBySettlement(
    settlementId: string,
  ): Promise<Array<{ id: number; source_pub_index: number | null }>>;
  readByAgent(agentId: string, limit?: number): Promise<EpisodeRow[]>;
  /**
   * Returns distinct entity_pointer_keys from recent episodes in this session,
   * ordered by episode recency (most recent first). Used for cross-turn
   * entity context in query routing.
   */
  readRecentSessionEntityHints(
    agentId: string,
    sessionId: string,
    episodeLimit: number,
  ): Promise<string[]>;
}
