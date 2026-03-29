import { GraphStorageService } from "../../../memory/storage.js";
import { executeSearchRebuild } from "../../../memory/search-rebuild-job.js";
import type { Db } from "../../database.js";
import type {
  SearchProjectionRepo,
  SearchProjectionScope,
} from "../contracts/search-projection-repo.js";
import type { NodeRef } from "../../../memory/types.js";

export class SqliteSearchProjectionRepoAdapter implements SearchProjectionRepo {
  constructor(
    private readonly impl: GraphStorageService,
    private readonly db: Db,
  ) {}

  async syncSearchDoc(
    scope: "private" | "area" | "world",
    sourceRef: NodeRef,
    content: string,
    agentId?: string,
    locationEntityId?: number,
  ): Promise<number> {
    return Promise.resolve(this.impl.syncSearchDoc(scope, sourceRef, content, agentId, locationEntityId));
  }

  async removeSearchDoc(scope: "private" | "area" | "world", sourceRef: NodeRef): Promise<void> {
    return Promise.resolve(this.impl.removeSearchDoc(scope, sourceRef));
  }

  async rebuildForScope(scope: SearchProjectionScope, agentId = "_all_agents"): Promise<void> {
    return Promise.resolve(
      executeSearchRebuild(this.db, {
        scope,
        agentId,
      }),
    );
  }
}
