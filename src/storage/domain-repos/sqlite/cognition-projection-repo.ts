import {
  PrivateCognitionProjectionRepo,
  type CognitionCurrentRow,
} from "../../../memory/cognition/private-cognition-current.js";
import type { CognitionEventRow } from "../../../memory/cognition/cognition-event-repo.js";
import type { CognitionProjectionRepo } from "../contracts/cognition-projection-repo.js";

export class SqliteCognitionProjectionRepoAdapter implements CognitionProjectionRepo {
  constructor(private readonly impl: PrivateCognitionProjectionRepo) {}

  async upsertFromEvent(event: CognitionEventRow): Promise<void> {
    return Promise.resolve(this.impl.upsertFromEvent(event));
  }

  async rebuild(agentId: string): Promise<void> {
    return Promise.resolve(this.impl.rebuild(agentId));
  }

  async getCurrent(agentId: string, cognitionKey: string): Promise<CognitionCurrentRow | null> {
    return Promise.resolve(this.impl.getCurrent(agentId, cognitionKey));
  }

  async getAllCurrent(agentId: string): Promise<CognitionCurrentRow[]> {
    return Promise.resolve(this.impl.getAllCurrent(agentId));
  }
}
