import { GraphStorageService } from "../../../memory/storage.js";
import type { GraphMutableStoreRepo } from "../contracts/graph-mutable-store-repo.js";

export class SqliteGraphMutableStoreRepoAdapter implements GraphMutableStoreRepo {
  constructor(private readonly impl: GraphStorageService) {}

  async createProjectedEvent(params: Parameters<GraphStorageService["createProjectedEvent"]>[0]): Promise<number> {
    return Promise.resolve(this.impl.createProjectedEvent(params));
  }

  async createPromotedEvent(params: Parameters<GraphStorageService["createPromotedEvent"]>[0]): Promise<number> {
    return Promise.resolve(this.impl.createPromotedEvent(params));
  }

  async createLogicEdge(sourceEventId: number, targetEventId: number, relationType: Parameters<GraphStorageService["createLogicEdge"]>[2]): Promise<number> {
    return Promise.resolve(this.impl.createLogicEdge(sourceEventId, targetEventId, relationType));
  }

  async createTopic(name: string, description?: string): Promise<number> {
    return Promise.resolve(this.impl.createTopic(name, description));
  }

  async upsertEntity(params: Parameters<GraphStorageService["upsertEntity"]>[0]): Promise<number> {
    return Promise.resolve(this.impl.upsertEntity(params));
  }

  async resolveEntityByPointerKey(pointerKey: string, agentId: string): Promise<number | null> {
    return Promise.resolve(this.impl.resolveEntityByPointerKey(pointerKey, agentId));
  }

  async getEntityById(id: number): Promise<{ pointerKey: string } | null> {
    return Promise.resolve(this.impl.getEntityById(id));
  }

  async upsertExplicitAssertion(params: Parameters<GraphStorageService["upsertExplicitAssertion"]>[0]): Promise<{ id: number; ref: ReturnType<GraphStorageService["upsertExplicitAssertion"]>["ref"] }> {
    return Promise.resolve(this.impl.upsertExplicitAssertion(params));
  }

  async upsertExplicitEvaluation(params: Parameters<GraphStorageService["upsertExplicitEvaluation"]>[0]): Promise<{ id: number; ref: ReturnType<GraphStorageService["upsertExplicitEvaluation"]>["ref"] }> {
    return Promise.resolve(this.impl.upsertExplicitEvaluation(params));
  }

  async upsertExplicitCommitment(params: Parameters<GraphStorageService["upsertExplicitCommitment"]>[0]): Promise<{ id: number; ref: ReturnType<GraphStorageService["upsertExplicitCommitment"]>["ref"] }> {
    return Promise.resolve(this.impl.upsertExplicitCommitment(params));
  }

  async retractExplicitCognition(
    agentId: string,
    cognitionKey: string,
    kind: Parameters<GraphStorageService["retractExplicitCognition"]>[2],
    settlementId?: string,
  ): Promise<void> {
    return Promise.resolve(this.impl.retractExplicitCognition(agentId, cognitionKey, kind, settlementId));
  }

  async createEntityAlias(canonicalId: number, alias: string, aliasType?: string, ownerAgentId?: string): Promise<number> {
    return Promise.resolve(this.impl.createEntityAlias(canonicalId, alias, aliasType, ownerAgentId));
  }

  async createRedirect(oldName: string, newName: string, redirectType?: string, ownerAgentId?: string): Promise<number> {
    return Promise.resolve(this.impl.createRedirect(oldName, newName, redirectType, ownerAgentId));
  }

  async createFact(sourceEntityId: number, targetEntityId: number, predicate: string, sourceEventId?: number): Promise<number> {
    return Promise.resolve(this.impl.createFact(sourceEntityId, targetEntityId, predicate, sourceEventId));
  }

  async invalidateFact(factId: number): Promise<void> {
    return Promise.resolve(this.impl.invalidateFact(factId));
  }

  async createPrivateEvent(params: Parameters<GraphStorageService["createPrivateEvent"]>[0]): Promise<number> {
    return Promise.resolve(this.impl.createPrivateEvent(params));
  }

  async createPrivateBelief(params: Parameters<GraphStorageService["createPrivateBelief"]>[0]): Promise<number> {
    return Promise.resolve(this.impl.createPrivateBelief(params));
  }

  async updatePrivateEventLink(privateEventId: number, publicEventId: number): Promise<void> {
    return Promise.resolve(this.impl.updatePrivateEventLink(privateEventId, publicEventId));
  }

  async createSameEpisodeEdges(events: Parameters<GraphStorageService["createSameEpisodeEdges"]>[0]): Promise<void> {
    return Promise.resolve(this.impl.createSameEpisodeEdges(events));
  }

  async runBatch(fn: () => void): Promise<void> {
    return Promise.resolve(this.impl.runBatch(fn));
  }
}
