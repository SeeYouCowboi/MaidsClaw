import type { Db } from "../../database.js";
import { makeNodeRef } from "../../../memory/schema.js";
import type {
  NodeRef,
  PrivateEventCategory,
  PublicEventCategory,
} from "../../../memory/types.js";
import type {
  PromotionEntityRecord,
  PromotionEventCandidateCriteria,
  PromotionEventRecord,
  PromotionFactCandidateCriteria,
  PromotionQueryRepo,
  PublicEntityResolutionDecision,
  StableFactPromotionCandidate,
} from "../contracts/promotion-query-repo.js";

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
  promotion_class: "none" | "world_candidate";
  source_record_id: string | null;
};

const HIDDEN_ENTITY_MARKERS = ["unknown", "hidden", "redacted", "anonymous", "masked"] as const;
const PRIVATE_EXISTENCE_MARKERS = ["private", "secret", "classified", "sensitive", "internal_only"] as const;
const STABLE_FACT_PATTERNS = [
  /\bowns\b/i,
  /\blikes\b/i,
  /\bis\s+(clean|open|closed|ready|safe)\b/i,
] as const;

export class SqlitePromotionQueryRepo implements PromotionQueryRepo {
  constructor(private readonly db: Db) {}

  findPromotionEventCandidates(criteria: PromotionEventCandidateCriteria = {}): Promise<PromotionEventRecord[]> {
    const clauses = ["visibility_scope = 'area_visible'", "summary IS NOT NULL"];
    if (criteria.spokenOnly ?? true) {
      clauses.push("event_category = 'speech'");
    }
    if (criteria.stableOnly ?? true) {
      clauses.push("promotion_class = 'world_candidate'");
    }

    const rows = this.db
      .prepare(
        `SELECT id, session_id, summary, timestamp, participants, location_entity_id, event_category, primary_actor_entity_id, promotion_class, source_record_id
         FROM event_nodes
         WHERE ${clauses.join(" AND ")}
         ORDER BY timestamp ASC, id ASC`,
      )
      .all() as EventRow[];

    return Promise.resolve(rows.map((row) => this.mapEventRow(row)));
  }

  findStableFactCandidates(criteria: PromotionFactCandidateCriteria = {}): Promise<StableFactPromotionCandidate[]> {
    const minEvidence = Math.max(1, criteria.minEvidence ?? 2);
    const rows = this.db
      .prepare(
        `SELECT id, summary, participants, location_entity_id
         FROM event_nodes
         WHERE summary IS NOT NULL
         ORDER BY timestamp ASC, id ASC`,
      )
      .all() as Array<{ id: number; summary: string; participants: string | null; location_entity_id: number }>;

    const grouped = new Map<string, StableFactPromotionCandidate>();
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
        existing.evidenceCount += 1;
        continue;
      }

      grouped.set(key, {
        sourceEventRef: makeNodeRef("event", row.id),
        targetScope: "world_public",
        summary: row.summary,
        entityRefs: [sourceRef, targetRef],
        evidenceCount: 1,
        predicate,
      });
    }

    return Promise.resolve(Array.from(grouped.values()).filter((candidate) => candidate.evidenceCount >= minEvidence));
  }

  getEntityRecord(entityRef: NodeRef): Promise<PromotionEntityRecord | null> {
    const entityId = this.parseNodeRefId(entityRef, "entity");
    const row = this.db
      .prepare(
        `SELECT id, pointer_key, display_name, entity_type, memory_scope, canonical_entity_id, summary
         FROM entity_nodes
         WHERE id = ?`,
      )
      .get(entityId) as EntityRow | null;

    if (!row) {
      return Promise.resolve(null);
    }

    return Promise.resolve({
      entityRef: makeNodeRef("entity", row.id),
      pointerKey: row.pointer_key,
      displayName: row.display_name,
      entityType: row.entity_type,
      memoryScope: row.memory_scope,
      canonicalEntityRef: row.canonical_entity_id ? makeNodeRef("entity", row.canonical_entity_id) : null,
      summary: row.summary,
    });
  }

  findSharedEntityByPointerKey(pointerKey: string): Promise<NodeRef | null> {
    const row = this.db
      .prepare(
        `SELECT id
         FROM entity_nodes
         WHERE pointer_key = ? AND memory_scope = 'shared_public'
         LIMIT 1`,
      )
      .get(pointerKey) as { id: number } | null;

    return Promise.resolve(row ? makeNodeRef("entity", row.id) : null);
  }

  getEventRecord(eventRef: NodeRef): Promise<PromotionEventRecord | null> {
    const eventId = this.parseNodeRefId(eventRef, "event");
    const row = this.db
      .prepare(
        `SELECT id, session_id, summary, timestamp, participants, location_entity_id, event_category, primary_actor_entity_id, promotion_class, source_record_id
         FROM event_nodes
         WHERE id = ?`,
      )
      .get(eventId) as EventRow | null;

    if (!row) {
      return Promise.resolve(null);
    }

    return Promise.resolve(this.mapEventRow(row));
  }

  findPublicEventBySourceRecordId(sourceRecordId: string): Promise<NodeRef | null> {
    const row = this.db
      .prepare(
        `SELECT id
         FROM event_nodes
         WHERE source_record_id = ? AND visibility_scope = 'area_visible'
         LIMIT 1`,
      )
      .get(sourceRecordId) as { id: number } | null;

    return Promise.resolve(row ? makeNodeRef("event", row.id) : null);
  }

  resolvePublicEntityDecision(input: {
    sourceEntityRef: NodeRef;
    timestamp: number;
    isLocation: boolean;
  }): Promise<PublicEntityResolutionDecision> {
    const sourceEntity = this.resolveNow(this.getEntityRecord(input.sourceEntityRef));
    if (!sourceEntity) {
      return Promise.resolve({ action: "block", reason: `entity not found: ${input.sourceEntityRef}` });
    }

    if (sourceEntity.memoryScope === "shared_public") {
      return Promise.resolve({ action: "reuse_shared", resolvedEntityRef: sourceEntity.entityRef });
    }

    if (this.isExistencePrivate(sourceEntity)) {
      return Promise.resolve({ action: "block", reason: "entity existence is private" });
    }

    const existingShared = this.resolveNow(this.findSharedEntityByPointerKey(sourceEntity.pointerKey));
    if (existingShared) {
      return Promise.resolve({ action: "reuse_shared", resolvedEntityRef: existingShared });
    }

    if (this.isPubliclyIdentifiable(sourceEntity, input.isLocation)) {
      return Promise.resolve({ action: "promote_full", sourceEntity });
    }

    return Promise.resolve({
      action: "promote_placeholder",
      placeholderPointerKey: `unknown_person@area:t${input.timestamp}`,
      displayName: "Unknown person",
      entityType: "person",
    });
  }

  resolveCandidateTimestamp(sourceRef: NodeRef): Promise<number> {
    if (sourceRef.startsWith("event:")) {
      const record = this.resolveNow(this.getEventRecord(sourceRef));
      return Promise.resolve(record?.timestamp ?? Date.now());
    }

    if (sourceRef.startsWith("evaluation:") || sourceRef.startsWith("commitment:")) {
      const id = Number(sourceRef.split(":")[1]);
      const row = this.db
        .prepare(`SELECT created_at FROM private_episode_events WHERE id = ?`)
        .get(id) as { created_at: number } | null;
      return Promise.resolve(row?.created_at ?? Date.now());
    }

    return Promise.resolve(Date.now());
  }

  toPublicEventCategory(category: PrivateEventCategory): Promise<PublicEventCategory | null> {
    if (
      category === "speech"
      || category === "action"
      || category === "observation"
      || category === "state_change"
    ) {
      return Promise.resolve(category);
    }

    return Promise.resolve(null);
  }

  private resolveNow<T>(value: Promise<T> | T): T {
    if (!(value instanceof Promise)) {
      return value;
    }

    const settled = Bun.peek(value);
    if (settled instanceof Promise) {
      throw new Error("SqlitePromotionQueryRepo requires synchronously-resolved promise value");
    }
    return settled;
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

  private mapEventRow(row: EventRow): PromotionEventRecord {
    return {
      eventRef: makeNodeRef("event", row.id),
      sessionId: row.session_id,
      summary: row.summary,
      timestamp: row.timestamp,
      participants: this.parseParticipantRefs(row.participants),
      locationEntityRef: makeNodeRef("entity", row.location_entity_id),
      eventCategory: row.event_category,
      primaryActorEntityRef: row.primary_actor_entity_id ? makeNodeRef("entity", row.primary_actor_entity_id) : null,
      promotionClass: row.promotion_class,
      sourceRecordId: row.source_record_id,
    };
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

  private isPubliclyIdentifiable(entity: Pick<PromotionEntityRecord, "pointerKey" | "displayName" | "entityType">, isLocation: boolean): boolean {
    if (isLocation && entity.entityType !== "person") {
      return true;
    }

    const pointer = entity.pointerKey.toLowerCase();
    const display = entity.displayName.toLowerCase();
    for (const marker of HIDDEN_ENTITY_MARKERS) {
      if (pointer.includes(marker) || display.includes(marker)) {
        return false;
      }
    }

    return !pointer.startsWith("unknown_person@area:t");
  }

  private isExistencePrivate(entity: Pick<PromotionEntityRecord, "pointerKey" | "displayName">): boolean {
    const haystack = `${entity.pointerKey} ${entity.displayName}`.toLowerCase();
    return PRIVATE_EXISTENCE_MARKERS.some((marker) => haystack.includes(marker));
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
}
