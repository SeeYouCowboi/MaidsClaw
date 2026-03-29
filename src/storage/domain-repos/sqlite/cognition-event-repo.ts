import {
  CognitionEventRepo as SqliteCognitionEventRepo,
  type CognitionEventAppendParams,
  type CognitionEventRow,
} from "../../../memory/cognition/cognition-event-repo.js";
import type { CognitionEventRepo } from "../contracts/cognition-event-repo.js";

export class SqliteCognitionEventRepoAdapter implements CognitionEventRepo {
  constructor(private readonly impl: SqliteCognitionEventRepo) {}

  async append(params: CognitionEventAppendParams): Promise<number> {
    return Promise.resolve(this.impl.append(params));
  }

  async readByAgent(agentId: string, limit?: number): Promise<CognitionEventRow[]> {
    return Promise.resolve(this.impl.readByAgent(agentId, limit));
  }

  async readByCognitionKey(agentId: string, cognitionKey: string): Promise<CognitionEventRow[]> {
    return Promise.resolve(this.impl.readByCognitionKey(agentId, cognitionKey));
  }

  async replay(agentId: string, afterTime?: number): Promise<CognitionEventRow[]> {
    return Promise.resolve(this.impl.replay(agentId, afterTime));
  }
}
