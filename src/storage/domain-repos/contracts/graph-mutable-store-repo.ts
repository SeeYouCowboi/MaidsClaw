import type {
  AssertionBasis,
  AssertionStance,
  CognitionKind,
} from "../../../runtime/rp-turn-contract.js";
import type {
  EventOrigin,
  LogicEdgeType,
  MemoryScope,
  NodeRef,
  NodeRefKind,
  PrivateEventCategory,
  ProjectionClass,
  PublicEventCategory,
} from "../../../memory/types.js";

export interface GraphMutableStoreRepo {
  createProjectedEvent(params: {
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
    origin: Extract<EventOrigin, "runtime_projection" | "delayed_materialization">;
    sourceSettlementId?: string;
    sourcePubIndex?: number;
    visibilityScope?: "area_visible" | "world_public";
  }): Promise<number>;
  createPromotedEvent(params: {
    sessionId: string;
    summary: string;
    timestamp: number;
    participants: string;
    locationEntityId?: number;
    eventCategory: PublicEventCategory;
    primaryActorEntityId?: number;
    sourceEventId?: number;
  }): Promise<number>;
  createLogicEdge(
    sourceEventId: number,
    targetEventId: number,
    relationType: LogicEdgeType,
    weight?: number | null,
  ): Promise<number>;
  createTopic(name: string, description?: string): Promise<number>;
  upsertEntity(params: {
    pointerKey: string;
    displayName: string;
    entityType: string;
    summary?: string;
    memoryScope: MemoryScope;
    ownerAgentId?: string;
    canonicalEntityId?: number;
  }): Promise<number>;
  resolveEntityByPointerKey(pointerKey: string, agentId: string): Promise<number | null>;
  getEntityById(id: number): Promise<{ pointerKey: string } | null>;
  upsertExplicitAssertion(params: {
    agentId: string;
    cognitionKey?: string;
    settlementId: string;
    opIndex: number;
    holderPointerKey: string;
    claim: string;
    entityPointerKeys: string[];
    stance: AssertionStance;
    basis?: AssertionBasis;
    preContestedStance?: AssertionStance;
    provenance?: string;
  }): Promise<{ id: number; ref: NodeRef }>;
  upsertExplicitEvaluation(params: {
    agentId: string;
    cognitionKey?: string;
    settlementId: string;
    opIndex: number;
    targetEntityId?: number;
    salience?: number;
    dimensions: Array<{ name: string; value: number }>;
    emotionTags?: string[];
    notes?: string;
  }): Promise<{ id: number; ref: NodeRef }>;
  upsertExplicitCommitment(params: {
    agentId: string;
    cognitionKey?: string;
    settlementId: string;
    opIndex: number;
    targetEntityId?: number;
    salience?: number;
    mode: "goal" | "intent" | "plan" | "constraint" | "avoidance";
    target: unknown;
    status: "active" | "paused" | "fulfilled" | "abandoned";
    priority?: number;
    horizon?: "immediate" | "near" | "long";
  }): Promise<{ id: number; ref: NodeRef }>;
  retractExplicitCognition(
    agentId: string,
    cognitionKey: string,
    kind: Extract<CognitionKind, "assertion" | "evaluation" | "commitment">,
    settlementId?: string,
  ): Promise<void>;
  createEntityAlias(canonicalId: number, alias: string, aliasType?: string, ownerAgentId?: string): Promise<number>;
  createRedirect(oldName: string, newName: string, redirectType?: string, ownerAgentId?: string): Promise<number>;
  createFact(sourceEntityId: number, targetEntityId: number, predicate: string, sourceEventId?: number): Promise<number>;
  invalidateFact(factId: number): Promise<void>;
  createPrivateEvent(params: {
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
  }): Promise<number>;
  createPrivateBelief(params: {
    agentId: string;
    sourceEntityId: number;
    targetEntityId: number;
    predicate: string;
    basis: AssertionBasis;
    stance: AssertionStance;
    provenance?: string;
    sourceEventRef?: NodeRef | null;
  }): Promise<number>;
  updatePrivateEventLink(privateEventId: number, publicEventId: number): Promise<void>;
  createSameEpisodeEdges(events: Array<{ id: number; session_id: string; topic_id: number | null; timestamp: number }>): Promise<void>;
  runBatch(fn: () => void): Promise<void>;
}
