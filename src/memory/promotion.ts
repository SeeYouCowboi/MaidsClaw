import { AreaWorldProjectionRepo } from "./projection/area-world-projection-repo.js";
import { makeNodeRef } from "./schema.js";
import type { GraphStorageService } from "./storage.js";
import type {
  EventNode,
  IPromotionService,
  NodeRef,
  ProjectedWrite,
  PromotionClass,
  PromotionCandidate,
  ReferenceResolution,
} from "./types.js";
import type {
  PromotionQueryRepo,
} from "../storage/domain-repos/contracts/promotion-query-repo.js";


type EventCandidateCriteria = {
  spoken?: boolean;
  stable?: boolean;
};

export type FactCandidate = PromotionCandidate & {
  evidence_count: number;
  predicate: string;
};

type FactCandidateCriteria = {
  minEvidence?: number;
};

export interface PromotionModelProvider {
  normalizePromotionSummary?(summary: string): string;
}

const STABLE_FACT_PATTERNS = [
  /\bowns\b/i,
  /\blikes\b/i,
  /\bis\s+(clean|open|closed|ready|safe)\b/i,
] as const;

export class PromotionService implements IPromotionService {
  private readonly projectionRepo: AreaWorldProjectionRepo;
  private readonly queryRepo: PromotionQueryRepo;

  constructor(
    _dbInput: unknown,
    private readonly storage: GraphStorageService,
    private readonly modelProvider?: PromotionModelProvider,
    projectionRepo?: AreaWorldProjectionRepo,
    queryRepo?: PromotionQueryRepo,
  ) {
    if (!projectionRepo) {
      throw new Error("PromotionService requires projectionRepo");
    }
    this.projectionRepo = projectionRepo;

    if (!queryRepo) {
      throw new Error("PromotionService requires queryRepo");
    }
    this.queryRepo = queryRepo;
  }

  identifyEventCandidates(criteria: EventCandidateCriteria = {}): EventNode[] {
    const records = this.resolveNow(
      this.queryRepo.findPromotionEventCandidates({
        spokenOnly: criteria.spoken ?? true,
        stableOnly: criteria.stable ?? true,
      }),
    );
    return records.map((record) => this.toEventNode(record));
  }

  identifyFactCandidates(criteria: FactCandidateCriteria = {}): FactCandidate[] {
    const records = this.resolveNow(
      this.queryRepo.findStableFactCandidates({
        minEvidence: Math.max(1, criteria.minEvidence ?? 2),
      }),
    );
    return records.map((record) => ({
      source_ref: record.sourceEventRef,
      target_scope: record.targetScope,
      summary: record.summary,
      entity_refs: record.entityRefs,
      evidence_count: record.evidenceCount,
      predicate: record.predicate,
    }));
  }

  resolveReferences(candidate: PromotionCandidate): ReferenceResolution[] {
    if (candidate.source_ref.startsWith("assertion:")) {
      return [
        {
          source_ref: candidate.source_ref,
          action: "block",
          reason: "assertion cannot be crystallized directly",
        },
      ];
    }

    const timestamp = this.resolveNow(this.queryRepo.resolveCandidateTimestamp(candidate.source_ref));
    const resolutions: ReferenceResolution[] = [];
    const seen = new Set<string>();

    for (const entityRef of candidate.entity_refs) {
      if (seen.has(entityRef)) {
        continue;
      }
      seen.add(entityRef);

      if (!entityRef.startsWith("entity:")) {
        resolutions.push({
          source_ref: entityRef,
          action: "block",
          reason: `unsupported reference kind: ${entityRef}`,
        });
        continue;
      }

      const decision = this.resolveNow(
        this.queryRepo.resolvePublicEntityDecision({
          sourceEntityRef: entityRef,
          timestamp,
          isLocation: false,
        }),
      );

      if (decision.action === "block") {
        resolutions.push({
          source_ref: entityRef,
          action: "block",
          reason: decision.reason,
        });
        continue;
      }

      if (decision.action === "reuse_shared") {
        resolutions.push({
          source_ref: entityRef,
          action: "reuse",
          resolved_entity_id: this.parseNodeRefId(decision.resolvedEntityRef, "entity"),
        });
        continue;
      }

      if (decision.action === "promote_placeholder") {
        const placeholderId = this.storage.upsertEntity({
          pointerKey: decision.placeholderPointerKey,
          displayName: decision.displayName,
          entityType: decision.entityType,
          memoryScope: "shared_public",
        });
        resolutions.push({
          source_ref: entityRef,
          action: "promote_placeholder",
          resolved_entity_id: placeholderId,
          placeholder_pointer_key: decision.placeholderPointerKey,
        });
        continue;
      }

      const promotedId = this.storage.upsertEntity({
        pointerKey: decision.sourceEntity.pointerKey,
        displayName: decision.sourceEntity.displayName,
        entityType: decision.sourceEntity.entityType,
        summary: decision.sourceEntity.summary ?? undefined,
        memoryScope: "shared_public",
        canonicalEntityId:
          decision.sourceEntity.canonicalEntityRef
            ? this.parseNodeRefId(decision.sourceEntity.canonicalEntityRef, "entity")
            : this.parseNodeRefId(decision.sourceEntity.entityRef, "entity"),
      });
      resolutions.push({ source_ref: entityRef, action: "promote_full", resolved_entity_id: promotedId });
    }

    return resolutions;
  }

  executeProjectedWrite(
    candidate: PromotionCandidate,
    resolutions: ReferenceResolution[],
    targetScope: "world_public" = "world_public",
  ): ProjectedWrite | undefined {
    if (targetScope !== "world_public") {
      throw new Error(`Unsupported target scope for promotion: ${targetScope}`);
    }
    if (resolutions.some((resolution) => resolution.action === "block")) {
      return undefined;
    }

    const resolutionMap = new Map<number, number>();
    for (const resolution of resolutions) {
      if (!resolution.source_ref.startsWith("entity:") || !resolution.resolved_entity_id) {
        continue;
      }
      resolutionMap.set(this.parseNodeRefId(resolution.source_ref, "entity"), resolution.resolved_entity_id);
    }

    if (candidate.source_ref.startsWith("event:")) {
      const sourceEvent = this.resolveNow(this.queryRepo.getEventRecord(candidate.source_ref));
      if (!sourceEvent) {
        throw new Error(`Source event not found: ${candidate.source_ref}`);
      }

      const participantRefs = [...sourceEvent.participants];
      for (const ref of candidate.entity_refs) {
        if (!participantRefs.includes(ref)) {
          participantRefs.push(ref);
        }
      }

      const promotedParticipants = Array.from(
        new Set(
          participantRefs
            .map((ref) => this.resolveEntityRefToPublic(ref, resolutionMap))
            .filter((id): id is number => id !== null)
            .map((id) => makeNodeRef("entity", id)),
        ),
      );

      const promotedLocation = this.resolveEntityRefToPublic(sourceEvent.locationEntityRef, resolutionMap);
      if (promotedLocation === null) {
        throw new Error("Promotion requires a public-safe location entity");
      }

      const promotedPrimaryActor = sourceEvent.primaryActorEntityRef
        ? this.resolveEntityRefToPublic(sourceEvent.primaryActorEntityRef, resolutionMap)
        : null;

      const summary = this.normalizeSummary(candidate.summary || sourceEvent.summary || "Promoted event");
      const sourceEventId = this.parseNodeRefId(candidate.source_ref, "event");
      const promotedEventId = this.storage.createPromotedEvent({
        sessionId: sourceEvent.sessionId,
        summary,
        timestamp: sourceEvent.timestamp,
        participants: JSON.stringify(promotedParticipants),
        locationEntityId: promotedLocation,
        eventCategory: sourceEvent.eventCategory,
        primaryActorEntityId: promotedPrimaryActor ?? undefined,
        sourceEventId,
      });
      this.projectionRepo.applyPromotionProjection({
        trigger: "promotion",
        projectionKey: `promotion:event:${sourceEventId}`,
        summaryText: summary,
        payload: {
          sourceEventId,
          promotedEventId,
        },
        surfacingClassification: "public_manifestation",
        updatedAt: sourceEvent.timestamp,
      });

      return {
        target_scope: "world_public",
        source_ref: candidate.source_ref,
        created_ref: makeNodeRef("event", promotedEventId),
      };
    }

    if (candidate.source_ref.startsWith("assertion:")) {
      return undefined;
    }

    const resolvedEntities = candidate.entity_refs
      .map((ref) => this.resolveEntityRefToPublic(ref, resolutionMap))
      .filter((id): id is number => id !== null);
    if (resolvedEntities.length < 2) {
      throw new Error("Fact crystallization requires at least two resolved entities");
    }

    const predicate = this.extractStablePredicate(candidate.summary) ?? "related_to";
    const sourceEventId = candidate.source_ref.startsWith("event:")
      ? this.parseNodeRefId(candidate.source_ref, "event")
      : undefined;

    const factId = this.storage.createFact(resolvedEntities[0], resolvedEntities[1], predicate, sourceEventId);
    const summary = this.normalizeSummary(candidate.summary);
    this.storage.syncSearchDoc("world", makeNodeRef("fact", factId), summary);
    this.projectionRepo.applyPromotionProjection({
      trigger: "promotion",
      projectionKey: `promotion:fact:${factId}`,
      summaryText: summary,
      payload: {
        sourceRef: candidate.source_ref,
        factId,
        predicate,
      },
      surfacingClassification: "public_manifestation",
    });

    return {
      target_scope: "world_public",
      source_ref: candidate.source_ref,
      created_ref: makeNodeRef("fact", factId),
    };
  }

  private resolveEntityRefToPublic(entityRef: string, map: Map<number, number>): number | null {
    if (!entityRef.startsWith("entity:")) {
      return null;
    }
    return this.resolveEntityIdToPublic(this.parseNodeRefId(entityRef, "entity"), map);
  }

  private resolveEntityIdToPublic(sourceEntityId: number, map: Map<number, number>): number | null {
    const resolved = map.get(sourceEntityId);
    if (resolved) {
      return resolved;
    }

    const entity = this.resolveNow(this.queryRepo.getEntityRecord(makeNodeRef("entity", sourceEntityId)));
    if (!entity) {
      return null;
    }
    if (entity.memoryScope === "shared_public") {
      return this.parseNodeRefId(entity.entityRef, "entity");
    }
    return null;
  }

  private parseNodeRefId(nodeRef: string, kind: "entity" | "event"): number {
    const prefix = `${kind}:`;
    if (!nodeRef.startsWith(prefix)) {
      throw new Error(`Invalid node ref kind for ${kind}: ${nodeRef}`);
    }
    const id = Number(nodeRef.slice(prefix.length));
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`Invalid node ref id: ${nodeRef}`);
    }
    return id;
  }

  private extractStablePredicate(summary: string): string | null {
    const normalized = summary.trim();
    if (!normalized) {
      return null;
    }
    for (const pattern of STABLE_FACT_PATTERNS) {
      const match = normalized.match(pattern);
      if (match) {
        const token = match[0].toLowerCase();
        if (token.startsWith("is ")) {
          return `is_${token.replace("is ", "").trim().replace(/\s+/g, "_")}`;
        }
        return token.replace(/\s+/g, "_");
      }
    }

    return null;
  }

  private normalizeSummary(summary: string): string {
    const trimmed = summary.trim();
    if (!trimmed) {
      return "Promoted memory";
    }

    const normalized = this.modelProvider?.normalizePromotionSummary?.(trimmed);
    return normalized?.trim() || trimmed;
  }

  private toEventNode(record: {
    eventRef: NodeRef;
    sessionId: string;
    summary: string | null;
    timestamp: number;
    participants: NodeRef[];
    locationEntityRef: NodeRef;
    eventCategory: "speech" | "action" | "observation" | "state_change";
    primaryActorEntityRef: NodeRef | null;
    promotionClass: PromotionClass;
    sourceRecordId: string | null;
  }): EventNode {
    return {
      id: this.parseNodeRefId(record.eventRef, "event"),
      session_id: record.sessionId,
      raw_text: null,
      summary: record.summary,
      timestamp: record.timestamp,
      created_at: record.timestamp,
      participants: JSON.stringify(record.participants),
      emotion: null,
      topic_id: null,
      visibility_scope: "area_visible",
      location_entity_id: this.parseNodeRefId(record.locationEntityRef, "entity"),
      event_category: record.eventCategory,
      primary_actor_entity_id: record.primaryActorEntityRef ? this.parseNodeRefId(record.primaryActorEntityRef, "entity") : null,
      promotion_class: record.promotionClass,
      source_record_id: record.sourceRecordId,
      event_origin: "runtime_projection",
    };
  }

  private resolveNow<T>(value: Promise<T> | T): T {
    if (!(value instanceof Promise)) {
      return value;
    }
    const settled = Bun.peek(value);
    if (settled instanceof Promise) {
      throw new Error("PromotionService sync path requires synchronously-resolved query repo promise");
    }
    return settled;
  }
}
