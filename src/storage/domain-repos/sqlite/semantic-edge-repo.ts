import { GraphStorageService } from "../../../memory/storage.js";
import type { NodeRef, SemanticEdgeType } from "../../../memory/types.js";
import type { SemanticEdgeRepo } from "../contracts/semantic-edge-repo.js";

export class SqliteSemanticEdgeRepoAdapter implements SemanticEdgeRepo {
  constructor(private readonly impl: GraphStorageService) {}

  async upsert(sourceRef: NodeRef, targetRef: NodeRef, relationType: SemanticEdgeType, weight: number): Promise<void> {
    return Promise.resolve(this.impl.upsertSemanticEdge(sourceRef, targetRef, relationType, weight));
  }
}
