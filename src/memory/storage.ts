import type { JobPersistence } from "../jobs/persistence.js";
import type { AssertionBasis, AssertionStance } from "../runtime/rp-turn-contract.js";
import type {
  AreaWorldProjectionRepo,
  CognitionEventRepo,
  CognitionProjectionRepo,
  CoreMemoryBlockRepo,
  EmbeddingRepo,
  EpisodeRepo,
  GraphMutableStoreRepo,
  NodeScoreRepo,
  SearchProjectionRepo,
  SemanticEdgeRepo,
  SharedBlockRepo,
} from "../storage/domain-repos/contracts/index.js";
import { type UpsertCommitmentParams, type UpsertEvaluationParams } from "./cognition/cognition-repo.js";
import type {
  LogicEdgeType,
  MemoryScope,
  NodeRef,
  NodeRefKind,
  PrivateEventCategory,
  ProjectionClass,
  PublicEventCategory,
  SemanticEdgeType,
} from "./types.js";

type CreateProjectedEventInput = {
  sessionId: string;
  summary: string;
  timestamp: number;
  participants: string;
  emotion?: string;
  topicId?: number;
  locationEntityId: number;
  eventCategory: PublicEventCategory;
  primaryActorEntityId?: number;
  sourceRecordId?: string;
  origin: "runtime_projection" | "delayed_materialization";
  sourceSettlementId?: string;
  sourcePubIndex?: number;
  visibilityScope?: "area_visible" | "world_public";
};

type CreatePromotedEventInput = {
  sessionId: string;
  summary: string;
  timestamp: number;
  participants: string;
  locationEntityId?: number;
  eventCategory: PublicEventCategory;
  primaryActorEntityId?: number;
  sourceEventId?: number;
};

type UpsertEntityInput = {
  pointerKey: string;
  displayName: string;
  entityType: string;
  summary?: string;
  memoryScope: MemoryScope;
  ownerAgentId?: string;
  canonicalEntityId?: number;
};

type CreatePrivateEventInput = {
  eventId?: number;
  agentId: string;
  role?: string;
  privateNotes?: string;
  salience?: number;
  emotion?: string;
  eventCategory: PrivateEventCategory;
  primaryActorEntityId?: number;
  projectionClass: ProjectionClass;
  locationEntityId?: number;
  projectableSummary?: string;
  sourceRecordId?: string;
};

type CreatePrivateBeliefInput = {
  agentId: string;
  sourceEntityId: number;
  targetEntityId: number;
  predicate: string;
  basis: AssertionBasis;
  stance: AssertionStance;
  provenance?: string;
  sourceEventRef?: NodeRef | null;
};

type UpsertExplicitAssertionInput = {
  agentId: string;
  cognitionKey?: string;
  settlementId: string;
  opIndex: number;
  sourcePointerKey: string;
  predicate: string;
  targetPointerKey: string;
  stance: AssertionStance;
  basis?: AssertionBasis;
  preContestedStance?: AssertionStance;
  provenance?: string;
};

type UpsertExplicitEvaluationInput = UpsertEvaluationParams;
type UpsertExplicitCommitmentInput = UpsertCommitmentParams;

type SearchScope = "private" | "area" | "world";
type SameEpisodeEvent = { id: number; session_id: string; topic_id: number | null; timestamp: number };

export type GraphStorageDomainRepoRegistry = {
  graphStoreRepo: GraphMutableStoreRepo;
  searchProjectionRepo: SearchProjectionRepo;
  embeddingRepo: EmbeddingRepo;
  semanticEdgeRepo: SemanticEdgeRepo;
  nodeScoreRepo: NodeScoreRepo;
  coreMemoryBlockRepo?: CoreMemoryBlockRepo;
  sharedBlockRepo?: SharedBlockRepo;
  episodeRepo?: EpisodeRepo;
  cognitionEventRepo?: CognitionEventRepo;
  cognitionProjectionRepo?: CognitionProjectionRepo;
  areaWorldProjectionRepo?: AreaWorldProjectionRepo;
};

type GraphStorageDelegateRegistry = Pick<
  GraphStorageDomainRepoRegistry,
  "graphStoreRepo" | "searchProjectionRepo" | "embeddingRepo" | "semanticEdgeRepo" | "nodeScoreRepo"
>;

export class GraphStorageService {
  private readonly delegates: GraphStorageDelegateRegistry;

  constructor(
    _dbLikeOrRegistry: unknown,
    _jobPersistence?: JobPersistence,
    repoRegistry?: GraphStorageDomainRepoRegistry,
  ) {
    const resolved = repoRegistry
      ?? (isRepoRegistry(_dbLikeOrRegistry) ? _dbLikeOrRegistry : undefined);
    if (!resolved) {
      throw new Error("GraphStorageService requires domain repo registry");
    }
    this.delegates = {
      graphStoreRepo: resolved.graphStoreRepo,
      searchProjectionRepo: resolved.searchProjectionRepo,
      embeddingRepo: resolved.embeddingRepo,
      semanticEdgeRepo: resolved.semanticEdgeRepo,
      nodeScoreRepo: resolved.nodeScoreRepo,
    };
  }

  static withDomainRepos(
    repoRegistry: GraphStorageDomainRepoRegistry,
    _jobPersistence?: JobPersistence,
  ): GraphStorageService {
    return new GraphStorageService(repoRegistry, _jobPersistence, repoRegistry);
  }

  createProjectedEvent(params: CreateProjectedEventInput): number {
    return this.resolveNow(this.delegates.graphStoreRepo.createProjectedEvent(params));
  }

  createPromotedEvent(params: CreatePromotedEventInput): number {
    return this.resolveNow(this.delegates.graphStoreRepo.createPromotedEvent(params));
  }

  createLogicEdge(sourceEventId: number, targetEventId: number, relationType: LogicEdgeType): number {
    return this.resolveNow(this.delegates.graphStoreRepo.createLogicEdge(sourceEventId, targetEventId, relationType));
  }

  createTopic(name: string, description?: string): number {
    return this.resolveNow(this.delegates.graphStoreRepo.createTopic(name, description));
  }

  upsertEntity(params: UpsertEntityInput): number {
    return this.resolveNow(this.delegates.graphStoreRepo.upsertEntity(params));
  }

  resolveEntityByPointerKey(pointerKey: string, agentId: string): number | null {
    return this.resolveNow(this.delegates.graphStoreRepo.resolveEntityByPointerKey(pointerKey, agentId));
  }

  getEntityById(id: number): { pointerKey: string } | null {
    return this.resolveNow(this.delegates.graphStoreRepo.getEntityById(id));
  }

  upsertExplicitAssertion(params: UpsertExplicitAssertionInput): { id: number; ref: NodeRef } {
    return this.resolveNow(this.delegates.graphStoreRepo.upsertExplicitAssertion(params));
  }

  upsertExplicitEvaluation(params: UpsertExplicitEvaluationInput): { id: number; ref: NodeRef } {
    return this.resolveNow(this.delegates.graphStoreRepo.upsertExplicitEvaluation(params));
  }

  upsertExplicitCommitment(params: UpsertExplicitCommitmentInput): { id: number; ref: NodeRef } {
    return this.resolveNow(this.delegates.graphStoreRepo.upsertExplicitCommitment(params));
  }

  retractExplicitCognition(
    agentId: string,
    cognitionKey: string,
    kind: "assertion" | "evaluation" | "commitment",
    settlementId?: string,
  ): void {
    this.resolveNow(this.delegates.graphStoreRepo.retractExplicitCognition(agentId, cognitionKey, kind, settlementId));
  }

  createEntityAlias(canonicalId: number, alias: string, aliasType?: string, ownerAgentId?: string): number {
    return this.resolveNow(this.delegates.graphStoreRepo.createEntityAlias(canonicalId, alias, aliasType, ownerAgentId));
  }

  createRedirect(oldName: string, newName: string, redirectType?: string, ownerAgentId?: string): number {
    return this.resolveNow(this.delegates.graphStoreRepo.createRedirect(oldName, newName, redirectType, ownerAgentId));
  }

  createFact(sourceEntityId: number, targetEntityId: number, predicate: string, sourceEventId?: number): number {
    return this.resolveNow(this.delegates.graphStoreRepo.createFact(sourceEntityId, targetEntityId, predicate, sourceEventId));
  }

  invalidateFact(factId: number): void {
    this.resolveNow(this.delegates.graphStoreRepo.invalidateFact(factId));
  }

  createPrivateEvent(params: CreatePrivateEventInput): number {
    return this.resolveNow(this.delegates.graphStoreRepo.createPrivateEvent(params));
  }

  createPrivateBelief(params: CreatePrivateBeliefInput): number {
    return this.resolveNow(this.delegates.graphStoreRepo.createPrivateBelief(params));
  }

  updatePrivateEventLink(privateEventId: number, publicEventId: number): void {
    this.resolveNow(this.delegates.graphStoreRepo.updatePrivateEventLink(privateEventId, publicEventId));
  }

  syncSearchDoc(
    scope: SearchScope,
    sourceRef: NodeRef,
    content: string,
    agentId?: string,
    locationEntityId?: number,
  ): number {
    return this.resolveNow(this.delegates.searchProjectionRepo.syncSearchDoc(scope, sourceRef, content, agentId, locationEntityId));
  }

  removeSearchDoc(scope: SearchScope, sourceRef: NodeRef): void {
    this.resolveNow(this.delegates.searchProjectionRepo.removeSearchDoc(scope, sourceRef));
  }

  upsertNodeEmbedding(
    nodeRef: NodeRef,
    nodeKind: NodeRefKind,
    viewType: "primary" | "keywords" | "context",
    modelId: string,
    embedding: Float32Array,
  ): void {
    this.resolveNow(this.delegates.embeddingRepo.upsert(nodeRef, nodeKind, viewType, modelId, embedding));
  }

  upsertSemanticEdge(
    sourceRef: NodeRef,
    targetRef: NodeRef,
    relationType: SemanticEdgeType,
    weight: number,
  ): void {
    this.resolveNow(this.delegates.semanticEdgeRepo.upsert(sourceRef, targetRef, relationType, weight));
  }

  upsertNodeScores(nodeRef: NodeRef, salience: number, centrality: number, bridgeScore: number): void {
    this.resolveNow(this.delegates.nodeScoreRepo.upsert(nodeRef, salience, centrality, bridgeScore));
  }

  createSameEpisodeEdges(events: SameEpisodeEvent[]): void {
    this.resolveNow(this.delegates.graphStoreRepo.createSameEpisodeEdges(events));
  }

  runBatch(fn: () => void): void {
    this.resolveNow(this.delegates.graphStoreRepo.runBatch(fn));
  }

  getEmbeddingStatsByModel(): Array<{ model_id: string; count: number; dimension: number }> {
    return this.resolveNow(this.delegates.nodeScoreRepo.getEmbeddingStatsByModel());
  }

  private resolveNow<T>(value: Promise<T> | T): T {
    if (!(value instanceof Promise)) {
      return value;
    }
    const settledValue = Bun.peek(value);
    if (settledValue instanceof Promise) {
      throw new Error("GraphStorageService sync facade received unresolved async repo result");
    }
    return settledValue as T;
  }
}

function isRepoRegistry(value: unknown): value is GraphStorageDomainRepoRegistry {
  return !!value
    && typeof value === "object"
    && "graphStoreRepo" in value
    && "searchProjectionRepo" in value
    && "embeddingRepo" in value
    && "semanticEdgeRepo" in value
    && "nodeScoreRepo" in value;
}
