import type { Database } from "bun:sqlite";
import { makeNodeRef } from "./schema.js";
import type { GraphStorageService } from "./storage.js";
import type {
  EventNode,
  IPromotionService,
  NodeRef,
  ProjectedWrite,
  PromotionCandidate,
  PublicEventCategory,
  ReferenceResolution,
} from "./types.js";

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

type EntityRow = {
  id: number;
  pointer_key: string;
  display_name: string;
  entity_type: string;
  memory_scope: "shared_public" | "private_overlay";
  canonical_entity_id: number | null;
  summary: string | null;
};

type EventRow = {
  id: number;
  session_id: string;
  summary: string | null;
  timestamp: number;
  participants: string | null;
  location_entity_id: number;
  event_category: PublicEventCategory;
  primary_actor_entity_id: number | null;
  visibility_scope: "area_visible" | "world_public";
};

const IDENTITY_HIDDEN_MARKERS = ["unknown", "hidden", "redacted", "anonymous", "masked"] as const;
const EXISTENCE_PRIVATE_MARKERS = ["private", "secret", "classified", "sensitive", "internal_only"] as const;
const STABLE_FACT_PATTERNS = [
  /\bowns\b/i,
  /\blikes\b/i,
  /\bis\s+(clean|open|closed|ready|safe)\b/i,
] as const;

export class PromotionService implements IPromotionService {
  constructor(
    private readonly db: Database,
    private readonly storage: GraphStorageService,
    private readonly modelProvider?: PromotionModelProvider,
  ) {}

  identifyEventCandidates(criteria: EventCandidateCriteria = {}): EventNode[] {
    const spoken = criteria.spoken ?? true;
    const stable = criteria.stable ?? true;

    const clauses = ["visibility_scope = 'area_visible'", "summary IS NOT NULL"];
    if (spoken) {
      clauses.push("event_category = 'speech'");
    }
    if (stable) {
      clauses.push("promotion_class = 'world_candidate'");
    }

    const sql = `SELECT * FROM event_nodes WHERE ${clauses.join(" AND ")} ORDER BY timestamp ASC, id ASC`;
    return this.db.prepare(sql).all() as EventNode[];
  }

  identifyFactCandidates(criteria: FactCandidateCriteria = {}): FactCandidate[] {
    const minEvidence = Math.max(1, criteria.minEvidence ?? 2);
    const rows = this.db
      .prepare(
        `SELECT id, summary, participants, location_entity_id
         FROM event_nodes
         WHERE visibility_scope IN ('area_visible', 'world_public')
           AND summary IS NOT NULL
         ORDER BY timestamp ASC, id ASC`,
      )
      .all() as Array<{ id: number; summary: string; participants: string | null; location_entity_id: number }>;

    const grouped = new Map<string, FactCandidate>();
    for (const row of rows) {
      const predicate = this.extractStablePredicate(row.summary);
      if (!predicate) {
        continue;
      }

      const refs = this.parseParticipantRefs(row.participants);
      if (refs.length < 2) {
        refs.push(makeNodeRef("entity", row.location_entity_id));
      }
      if (refs.length < 2) {
        continue;
      }

      const sourceRef = refs[0];
      const targetRef = refs[1];
      const key = `${sourceRef}|${predicate}|${targetRef}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.evidence_count += 1;
        continue;
      }

      grouped.set(key, {
        source_ref: makeNodeRef("event", row.id),
        target_scope: "world_public",
        summary: row.summary,
        entity_refs: [sourceRef, targetRef],
        evidence_count: 1,
        predicate,
      });
    }

    return Array.from(grouped.values()).filter((candidate) => candidate.evidence_count >= minEvidence);
  }

  resolveReferences(candidate: PromotionCandidate): ReferenceResolution[] {
    if (candidate.source_ref.startsWith("private_belief:")) {
      return [
        {
          source_ref: candidate.source_ref,
          action: "block",
          reason: "private_belief cannot be crystallized directly",
        },
      ];
    }

    const timestamp = this.resolveCandidateTimestamp(candidate);
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

      const sourceEntityId = this.parseNodeRefId(entityRef, "entity");
      const entity = this.getEntityById(sourceEntityId);
      if (!entity) {
        resolutions.push({
          source_ref: entityRef,
          action: "block",
          reason: `entity not found: ${entityRef}`,
        });
        continue;
      }

      if (entity.memory_scope === "shared_public") {
        resolutions.push({ source_ref: entityRef, action: "reuse", resolved_entity_id: entity.id });
        continue;
      }

      const sharedByPointer = this.findSharedEntityByPointer(entity.pointer_key);
      if (sharedByPointer) {
        resolutions.push({ source_ref: entityRef, action: "reuse", resolved_entity_id: sharedByPointer.id });
        continue;
      }

      if (this.isExistencePrivate(entity)) {
        resolutions.push({
          source_ref: entityRef,
          action: "block",
          reason: "entity existence is private",
        });
        continue;
      }

      if (this.shouldUsePlaceholder(entity)) {
        const placeholderPointerKey = `unknown_person@area:t${timestamp}`;
        const placeholderId = this.storage.upsertEntity({
          pointerKey: placeholderPointerKey,
          displayName: "Unknown person",
          entityType: "person",
          memoryScope: "shared_public",
        });
        resolutions.push({
          source_ref: entityRef,
          action: "promote_placeholder",
          resolved_entity_id: placeholderId,
          placeholder_pointer_key: placeholderPointerKey,
        });
        continue;
      }

      const promotedId = this.storage.upsertEntity({
        pointerKey: entity.pointer_key,
        displayName: entity.display_name,
        entityType: entity.entity_type,
        summary: entity.summary ?? undefined,
        memoryScope: "shared_public",
        canonicalEntityId: entity.canonical_entity_id ?? entity.id,
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
      const sourceEventId = this.parseNodeRefId(candidate.source_ref, "event");
      const sourceEvent = this.getEventById(sourceEventId);
      if (!sourceEvent) {
        throw new Error(`Source event not found: ${candidate.source_ref}`);
      }

      const participantRefs = this.parseParticipantRefs(sourceEvent.participants);
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

      const promotedLocation = this.resolveEntityIdToPublic(sourceEvent.location_entity_id, resolutionMap);
      if (promotedLocation === null) {
        throw new Error("Promotion requires a public-safe location entity");
      }

      const promotedPrimaryActor = sourceEvent.primary_actor_entity_id
        ? this.resolveEntityIdToPublic(sourceEvent.primary_actor_entity_id, resolutionMap)
        : null;

      const summary = this.normalizeSummary(candidate.summary || sourceEvent.summary || "Promoted event");
      const promotedEventId = this.storage.createPromotedEvent({
        sessionId: sourceEvent.session_id,
        summary,
        timestamp: sourceEvent.timestamp,
        participants: JSON.stringify(promotedParticipants),
        locationEntityId: promotedLocation,
        eventCategory: sourceEvent.event_category,
        primaryActorEntityId: promotedPrimaryActor ?? undefined,
        sourceEventId,
      });

      return {
        target_scope: "world_public",
        source_ref: candidate.source_ref,
        created_ref: makeNodeRef("event", promotedEventId),
      };
    }

    if (candidate.source_ref.startsWith("private_belief:")) {
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
    this.storage.syncSearchDoc("world", makeNodeRef("fact", factId), this.normalizeSummary(candidate.summary));

    return {
      target_scope: "world_public",
      source_ref: candidate.source_ref,
      created_ref: makeNodeRef("fact", factId),
    };
  }

  private getEntityById(id: number): EntityRow | null {
    return this.db
      .prepare(
        `SELECT id, pointer_key, display_name, entity_type, memory_scope, canonical_entity_id, summary
         FROM entity_nodes
         WHERE id = ?`,
      )
      .get(id) as EntityRow | null;
  }

  private getEventById(id: number): EventRow | null {
    return this.db
      .prepare(
        `SELECT id, session_id, summary, timestamp, participants, location_entity_id, event_category, primary_actor_entity_id, visibility_scope
         FROM event_nodes
         WHERE id = ?`,
      )
      .get(id) as EventRow | null;
  }

  private findSharedEntityByPointer(pointerKey: string): { id: number } | null {
    return this.db
      .prepare(
        `SELECT id
         FROM entity_nodes
         WHERE pointer_key = ? AND memory_scope = 'shared_public'
         LIMIT 1`,
      )
      .get(pointerKey) as { id: number } | null;
  }

  private parseParticipantRefs(participants: string | null): NodeRef[] {
    if (!participants) {
      return [];
    }

    try {
      const parsed = JSON.parse(participants) as string[];
      return parsed
        .filter((value): value is `entity:${number}` => /^entity:\d+$/.test(value))
        .map((value) => value as NodeRef);
    } catch {
      return [];
    }
  }

  private parseNodeRefId(nodeRef: string, kind: "entity" | "event" | "private_event" | "private_belief"): number {
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

  private resolveCandidateTimestamp(candidate: PromotionCandidate): number {
    if (candidate.source_ref.startsWith("event:")) {
      const source = this.getEventById(this.parseNodeRefId(candidate.source_ref, "event"));
      return source?.timestamp ?? Date.now();
    }

    if (candidate.source_ref.startsWith("private_event:")) {
      const row = this.db
        .prepare(`SELECT created_at FROM agent_event_overlay WHERE id = ?`)
        .get(this.parseNodeRefId(candidate.source_ref, "private_event")) as { created_at: number } | null;
      return row?.created_at ?? Date.now();
    }

    return Date.now();
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

    const row = this.getEntityById(sourceEntityId);
    if (!row) {
      return null;
    }
    if (row.memory_scope === "shared_public") {
      return row.id;
    }
    return null;
  }

  private extractStablePredicate(summary: string): string | null {
    const normalized = summary.trim();
    if (!normalized) {
      return null;
    }
    if (/\bprivate[_\s-]?belief\b/i.test(normalized)) {
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

  private isExistencePrivate(entity: EntityRow): boolean {
    const haystack = `${entity.pointer_key} ${entity.display_name}`.toLowerCase();
    return EXISTENCE_PRIVATE_MARKERS.some((marker) => haystack.includes(marker));
  }

  private shouldUsePlaceholder(entity: EntityRow): boolean {
    if (entity.entity_type !== "person") {
      return false;
    }
    const haystack = `${entity.pointer_key} ${entity.display_name}`.toLowerCase();
    if (haystack.startsWith("unknown_person@area:t")) {
      return true;
    }
    return IDENTITY_HIDDEN_MARKERS.some((marker) => haystack.includes(marker));
  }

  private normalizeSummary(summary: string): string {
    const trimmed = summary.trim();
    if (!trimmed) {
      return "Promoted memory";
    }

    const normalized = this.modelProvider?.normalizePromotionSummary?.(trimmed);
    return normalized?.trim() || trimmed;
  }
}
