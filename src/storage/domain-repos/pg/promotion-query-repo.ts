import type postgres from "postgres";
import { makeNodeRef } from "../../../memory/schema.js";
import type {
  NodeRef,
  PrivateEventCategory,
  PromotionClass,
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

const NODE_REF_REGEX = /^(event|entity|fact|assertion|evaluation|commitment|episode):([1-9]\d*)$/;
const IDENTITY_HIDDEN_MARKERS = ["unknown", "hidden", "redacted", "anonymous", "masked"] as const;
const EXISTENCE_PRIVATE_MARKERS = ["private", "secret", "classified", "sensitive", "internal_only"] as const;
const STABLE_FACT_PATTERNS = [
  /\bowns\b/i,
  /\blikes\b/i,
  /\bis\s+(clean|open|closed|ready|safe)\b/i,
] as const;

type ParsedNodeRef = {
  kind: "event" | "entity" | "fact" | "assertion" | "evaluation" | "commitment";
  id: number;
};

function parseNodeRef(nodeRef: NodeRef): ParsedNodeRef | null {
  const match = NODE_REF_REGEX.exec(nodeRef);
  if (!match) {
    return null;
  }
  return {
    kind: match[1] as ParsedNodeRef["kind"],
    id: Number(match[2]),
  };
}

function parseParticipantRefs(participants: string | null): NodeRef[] {
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

function toPublicCategory(category: string): PublicEventCategory {
  if (
    category === "speech"
    || category === "action"
    || category === "observation"
    || category === "state_change"
  ) {
    return category;
  }
  return "observation";
}

function extractStablePredicate(summary: string): string | null {
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

function isExistencePrivate(entity: PromotionEntityRecord): boolean {
  const haystack = `${entity.pointerKey} ${entity.displayName}`.toLowerCase();
  return EXISTENCE_PRIVATE_MARKERS.some((marker) => haystack.includes(marker));
}

function shouldUsePlaceholder(entity: PromotionEntityRecord): boolean {
  if (entity.entityType !== "person") {
    return false;
  }
  const haystack = `${entity.pointerKey} ${entity.displayName}`.toLowerCase();
  if (haystack.startsWith("unknown_person@area:t")) {
    return true;
  }
  return IDENTITY_HIDDEN_MARKERS.some((marker) => haystack.includes(marker));
}

export class PgPromotionQueryRepo implements PromotionQueryRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async findPromotionEventCandidates(criteria: PromotionEventCandidateCriteria = {}): Promise<PromotionEventRecord[]> {
    const spokenOnly = criteria.spokenOnly ?? true;
    const stableOnly = criteria.stableOnly ?? true;

    const clauses = ["visibility_scope = 'area_visible'", "summary IS NOT NULL"];
    if (spokenOnly) {
      clauses.push("event_category = 'speech'");
    }
    if (stableOnly) {
      clauses.push("promotion_class = 'world_candidate'");
    }

    const rows = await this.sql.unsafe<{
      id: number | string;
      session_id: string;
      summary: string | null;
      timestamp: number | string;
      participants: string | null;
      location_entity_id: number | string;
      event_category: string;
      primary_actor_entity_id: number | string | null;
      promotion_class: PromotionClass;
      source_record_id: string | null;
    }[]>(
      `SELECT id, session_id, summary, timestamp, participants, location_entity_id, event_category, primary_actor_entity_id, promotion_class, source_record_id
       FROM event_nodes
       WHERE ${clauses.join(" AND ")}
       ORDER BY timestamp ASC, id ASC`,
    );

    return rows.map((row) => ({
      eventRef: makeNodeRef("event", Number(row.id)),
      sessionId: row.session_id,
      summary: row.summary,
      timestamp: Number(row.timestamp),
      participants: parseParticipantRefs(row.participants),
      locationEntityRef: makeNodeRef("entity", Number(row.location_entity_id)),
      eventCategory: toPublicCategory(row.event_category),
      primaryActorEntityRef:
        row.primary_actor_entity_id == null ? null : makeNodeRef("entity", Number(row.primary_actor_entity_id)),
      promotionClass: row.promotion_class,
      sourceRecordId: row.source_record_id,
    }));
  }

  async findStableFactCandidates(criteria: PromotionFactCandidateCriteria = {}): Promise<StableFactPromotionCandidate[]> {
    const minEvidence = Math.max(1, criteria.minEvidence ?? 2);

    const rows = await this.sql<{
      id: number | string;
      summary: string;
      participants: string | null;
      location_entity_id: number | string;
    }[]>`
      SELECT id, summary, participants, location_entity_id
      FROM event_nodes
      WHERE visibility_scope IN ('area_visible', 'world_public')
        AND summary IS NOT NULL
      ORDER BY timestamp ASC, id ASC
    `;

    const grouped = new Map<string, StableFactPromotionCandidate>();
    for (const row of rows) {
      const predicate = extractStablePredicate(row.summary);
      if (!predicate) {
        continue;
      }

      const refs = parseParticipantRefs(row.participants);
      if (refs.length < 2) {
        refs.push(makeNodeRef("entity", Number(row.location_entity_id)));
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
        sourceEventRef: makeNodeRef("event", Number(row.id)),
        targetScope: "world_public",
        summary: row.summary,
        entityRefs: [sourceRef, targetRef],
        predicate,
        evidenceCount: 1,
      });
    }

    return Array.from(grouped.values()).filter((candidate) => candidate.evidenceCount >= minEvidence);
  }

  async getEntityRecord(entityRef: NodeRef): Promise<PromotionEntityRecord | null> {
    const parsed = parseNodeRef(entityRef);
    if (!parsed || parsed.kind !== "entity") {
      return null;
    }

    const rows = await this.sql<{
      id: number | string;
      pointer_key: string;
      display_name: string;
      entity_type: string;
      memory_scope: "shared_public" | "private_overlay";
      canonical_entity_id: number | string | null;
      summary: string | null;
    }[]>`
      SELECT id, pointer_key, display_name, entity_type, memory_scope, canonical_entity_id, summary
      FROM entity_nodes
      WHERE id = ${parsed.id}
      LIMIT 1
    `;

    if (rows.length === 0) {
      return null;
    }

    return {
      entityRef: makeNodeRef("entity", Number(rows[0].id)),
      pointerKey: rows[0].pointer_key,
      displayName: rows[0].display_name,
      entityType: rows[0].entity_type,
      memoryScope: rows[0].memory_scope,
      canonicalEntityRef:
        rows[0].canonical_entity_id == null
          ? null
          : makeNodeRef("entity", Number(rows[0].canonical_entity_id)),
      summary: rows[0].summary,
    };
  }

  async findSharedEntityByPointerKey(pointerKey: string): Promise<NodeRef | null> {
    const rows = await this.sql<{ id: number | string }[]>`
      SELECT id
      FROM entity_nodes
      WHERE pointer_key = ${pointerKey}
        AND memory_scope = 'shared_public'
      LIMIT 1
    `;
    return rows.length > 0 ? makeNodeRef("entity", Number(rows[0].id)) : null;
  }

  async getEventRecord(eventRef: NodeRef): Promise<PromotionEventRecord | null> {
    const parsed = parseNodeRef(eventRef);
    if (!parsed || parsed.kind !== "event") {
      return null;
    }

    const rows = await this.sql<{
      id: number | string;
      session_id: string;
      summary: string | null;
      timestamp: number | string;
      participants: string | null;
      location_entity_id: number | string;
      event_category: string;
      primary_actor_entity_id: number | string | null;
      promotion_class: PromotionClass;
      source_record_id: string | null;
    }[]>`
      SELECT id, session_id, summary, timestamp, participants, location_entity_id, event_category, primary_actor_entity_id, promotion_class, source_record_id
      FROM event_nodes
      WHERE id = ${parsed.id}
      LIMIT 1
    `;

    if (rows.length === 0) {
      return null;
    }

    return {
      eventRef: makeNodeRef("event", Number(rows[0].id)),
      sessionId: rows[0].session_id,
      summary: rows[0].summary,
      timestamp: Number(rows[0].timestamp),
      participants: parseParticipantRefs(rows[0].participants),
      locationEntityRef: makeNodeRef("entity", Number(rows[0].location_entity_id)),
      eventCategory: toPublicCategory(rows[0].event_category),
      primaryActorEntityRef:
        rows[0].primary_actor_entity_id == null ? null : makeNodeRef("entity", Number(rows[0].primary_actor_entity_id)),
      promotionClass: rows[0].promotion_class,
      sourceRecordId: rows[0].source_record_id,
    };
  }

  async findPublicEventBySourceRecordId(sourceRecordId: string): Promise<NodeRef | null> {
    const rows = await this.sql<{ id: number | string }[]>`
      SELECT id
      FROM event_nodes
      WHERE source_record_id = ${sourceRecordId}
        AND visibility_scope = 'world_public'
      ORDER BY id ASC
      LIMIT 1
    `;
    return rows.length > 0 ? makeNodeRef("event", Number(rows[0].id)) : null;
  }

  async resolvePublicEntityDecision(input: {
    sourceEntityRef: NodeRef;
    timestamp: number;
    isLocation: boolean;
  }): Promise<PublicEntityResolutionDecision> {
    const entity = await this.getEntityRecord(input.sourceEntityRef);
    if (!entity) {
      return { action: "block", reason: `entity not found: ${input.sourceEntityRef}` };
    }

    if (entity.memoryScope === "shared_public") {
      return { action: "reuse_shared", resolvedEntityRef: entity.entityRef };
    }

    const sharedByPointer = await this.findSharedEntityByPointerKey(entity.pointerKey);
    if (sharedByPointer) {
      return { action: "reuse_shared", resolvedEntityRef: sharedByPointer };
    }

    if (isExistencePrivate(entity)) {
      return { action: "block", reason: "entity existence is private" };
    }

    if (!input.isLocation && shouldUsePlaceholder(entity)) {
      return {
        action: "promote_placeholder",
        placeholderPointerKey: `unknown_person@area:t${input.timestamp}`,
        displayName: "Unknown person",
        entityType: "person",
      };
    }

    return { action: "promote_full", sourceEntity: entity };
  }

  async resolveCandidateTimestamp(sourceRef: NodeRef): Promise<number> {
    if (sourceRef.startsWith("episode:")) {
      const parsed = parseNodeRef(sourceRef);
      if (!parsed) {
        return Date.now();
      }
      const rows = await this.sql<{ created_at: number | string }[]>`
        SELECT created_at
        FROM private_episode_events
        WHERE id = ${parsed.id}
        LIMIT 1
      `;
      return rows.length > 0 ? Number(rows[0].created_at) : Date.now();
    }

    if (sourceRef.startsWith("event:")) {
      const parsed = parseNodeRef(sourceRef);
      if (!parsed) {
        return Date.now();
      }
      const rows = await this.sql<{ timestamp: number | string }[]>`
        SELECT timestamp
        FROM event_nodes
        WHERE id = ${parsed.id}
        LIMIT 1
      `;
      return rows.length > 0 ? Number(rows[0].timestamp) : Date.now();
    }

    if (sourceRef.startsWith("evaluation:") || sourceRef.startsWith("commitment:")) {
      const parsed = parseNodeRef(sourceRef);
      if (!parsed) {
        return Date.now();
      }
      const rows = await this.sql<{ created_at: number | string }[]>`
        SELECT created_at
        FROM private_episode_events
        WHERE id = ${parsed.id}
        LIMIT 1
      `;
      return rows.length > 0 ? Number(rows[0].created_at) : Date.now();
    }

    return Date.now();
  }

  async toPublicEventCategory(category: PrivateEventCategory): Promise<PublicEventCategory | null> {
    return category;
  }
}
