import type { NodeRef, PrivateEventCategory, PromotionClass, PublicEventCategory } from "../../../memory/types.js";

export type PromotionEventCandidateCriteria = {
  spokenOnly?: boolean;
  stableOnly?: boolean;
};

export type PromotionFactCandidateCriteria = {
  minEvidence?: number;
};

export type PromotionEntityRecord = {
  entityRef: NodeRef;
  pointerKey: string;
  displayName: string;
  entityType: string;
  memoryScope: "shared_public" | "private_overlay";
  canonicalEntityRef: NodeRef | null;
  summary: string | null;
};

export type PromotionEventRecord = {
  eventRef: NodeRef;
  sessionId: string;
  summary: string | null;
  timestamp: number;
  participants: NodeRef[];
  locationEntityRef: NodeRef;
  eventCategory: PublicEventCategory;
  primaryActorEntityRef: NodeRef | null;
  promotionClass: PromotionClass;
  sourceRecordId: string | null;
};

export type StableFactPromotionCandidate = {
  sourceEventRef: NodeRef;
  targetScope: "world_public";
  summary: string;
  entityRefs: [NodeRef, NodeRef];
  predicate: string;
  evidenceCount: number;
};

export type PublicEntityResolutionDecision =
  | {
    action: "reuse_shared";
    resolvedEntityRef: NodeRef;
  }
  | {
    action: "promote_full";
    sourceEntity: PromotionEntityRecord;
  }
  | {
    action: "promote_placeholder";
    placeholderPointerKey: string;
    displayName: string;
    entityType: string;
  }
  | {
    action: "block";
    reason: string;
  };

export interface PromotionQueryRepo {
  /**
   * Finds area-visible event candidates that are eligible for world promotion under
   * speech/stability filters.
   */
  findPromotionEventCandidates(criteria?: PromotionEventCandidateCriteria): Promise<PromotionEventRecord[]>;

  /**
   * Finds stable fact crystallization candidates inferred from repeated event summaries.
   */
  findStableFactCandidates(criteria?: PromotionFactCandidateCriteria): Promise<StableFactPromotionCandidate[]>;

  /**
   * Loads an entity record used during promotion/materialization reference resolution.
   */
  getEntityRecord(entityRef: NodeRef): Promise<PromotionEntityRecord | null>;

  /**
   * Looks up a shared-public entity by pointer key.
   */
  findSharedEntityByPointerKey(pointerKey: string): Promise<NodeRef | null>;

  /**
   * Loads a source event used for projected-write materialization.
   */
  getEventRecord(eventRef: NodeRef): Promise<PromotionEventRecord | null>;

  /**
   * Finds an already-materialized public event by source record id for reconciliation.
   */
  findPublicEventBySourceRecordId(sourceRecordId: string): Promise<NodeRef | null>;

  /**
   * Resolves which public entity strategy should be used for an entity when projecting
   * delayed materialization or promotion output.
   */
  resolvePublicEntityDecision(input: {
    sourceEntityRef: NodeRef;
    timestamp: number;
    isLocation: boolean;
  }): Promise<PublicEntityResolutionDecision>;

  /**
   * Resolves source timestamp for promotion/materialization candidates from event-like refs.
   */
  resolveCandidateTimestamp(sourceRef: NodeRef): Promise<number>;

  /**
   * Maps private event categories into public event categories when publication is allowed.
   */
  toPublicEventCategory(category: PrivateEventCategory): Promise<PublicEventCategory | null>;
}
