import type { Database } from "bun:sqlite";
import type { PublicationDeclaration, PublicationKind, PublicationKindV2 } from "../runtime/rp-turn-contract.js";
import { makeNodeRef } from "./schema.js";
import type { GraphStorageService } from "./storage.js";
import type { AgentEventOverlay, PublicEventCategory } from "./types.js";

export type MaterializationResult = {
  materialized: number;
  reconciled: number;
  skipped: number;
};

type EventRow = {
  id: number;
  session_id: string;
  timestamp: number;
  topic_id: number | null;
  emotion: string | null;
};

type EntityRow = {
  id: number;
  pointer_key: string;
  display_name: string;
  entity_type: string;
  memory_scope: "shared_public" | "private_overlay";
  owner_agent_id: string | null;
  canonical_entity_id: number | null;
  summary: string | null;
};

const HIDDEN_ENTITY_MARKERS = ["unknown", "hidden", "redacted", "anonymous"] as const;

export class MaterializationService {
  constructor(
    private readonly db: Database,
    private readonly storage: GraphStorageService,
  ) {}

  materializeDelayed(privateEvents: AgentEventOverlay[], agentId: string): MaterializationResult {
    const result: MaterializationResult = { materialized: 0, reconciled: 0, skipped: 0 };

    for (const privateEvent of privateEvents) {
      if (
        privateEvent.agent_id !== agentId ||
        privateEvent.projection_class !== "area_candidate" ||
        privateEvent.event_category === "thought"
      ) {
        result.skipped += 1;
        continue;
      }

      const summary = privateEvent.projectable_summary?.trim();
      if (!summary || !privateEvent.location_entity_id) {
        result.skipped += 1;
        continue;
      }

      const existingBySource = privateEvent.source_record_id
        ? this.findPublicEventBySourceRecord(privateEvent.source_record_id)
        : null;
      if (existingBySource) {
        this.linkPrivateToPublic(privateEvent.id, existingBySource.id);
        result.reconciled += 1;
        continue;
      }

      const resolvedLocationId = this.resolveEntityForPublic(privateEvent.location_entity_id, privateEvent.created_at, true);
      if (!resolvedLocationId) {
        result.skipped += 1;
        continue;
      }

      const resolvedPrimaryActorId = privateEvent.primary_actor_entity_id
        ? this.resolveEntityForPublic(privateEvent.primary_actor_entity_id, privateEvent.created_at, false)
        : null;

      const participants = this.buildParticipantsJson(resolvedPrimaryActorId, resolvedLocationId);
      const publicEventCategory = this.toPublicEventCategory(privateEvent.event_category);
      if (!publicEventCategory) {
        result.skipped += 1;
        continue;
      }

      const baseEvent = privateEvent.event_id ? this.getEventById(privateEvent.event_id) : null;
      const sessionId = baseEvent?.session_id ?? `agent:${agentId}`;
      const timestamp = baseEvent?.timestamp ?? privateEvent.created_at;

      try {
        const publicEventId = this.storage.createProjectedEvent({
          sessionId,
          summary,
          timestamp,
          participants,
          emotion: privateEvent.emotion ?? baseEvent?.emotion ?? undefined,
          topicId: baseEvent?.topic_id ?? undefined,
          locationEntityId: resolvedLocationId,
          eventCategory: publicEventCategory,
          primaryActorEntityId: resolvedPrimaryActorId ?? undefined,
          sourceRecordId: privateEvent.source_record_id ?? undefined,
          origin: "delayed_materialization",
        });
        this.linkPrivateToPublic(privateEvent.id, publicEventId);
        result.materialized += 1;
      } catch (error) {
        if (!privateEvent.source_record_id) {
          throw error;
        }

        const reconciled = this.findPublicEventBySourceRecord(privateEvent.source_record_id);
        if (!reconciled) {
          throw error;
        }

        this.linkPrivateToPublic(privateEvent.id, reconciled.id);
        result.reconciled += 1;
      }
    }

    return result;
  }

  private findPublicEventBySourceRecord(sourceRecordId: string): { id: number } | null {
    const row = this.db
      .prepare(
        `SELECT id
         FROM event_nodes
         WHERE source_record_id = ? AND visibility_scope = 'area_visible'
         LIMIT 1`,
      )
      .get(sourceRecordId) as { id: number } | null;
    return row;
  }

  private getEventById(eventId: number): EventRow | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, timestamp, topic_id, emotion
         FROM event_nodes
         WHERE id = ?`,
      )
      .get(eventId) as EventRow | null;
    return row;
  }

  private linkPrivateToPublic(privateEventId: number, publicEventId: number): void {
    this.db.prepare(`UPDATE agent_event_overlay SET event_id = ? WHERE id = ?`).run(publicEventId, privateEventId);
  }

  private resolveEntityForPublic(entityId: number, timestamp: number, isLocation: boolean): number | null {
    const entity = this.db
      .prepare(
        `SELECT id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary
         FROM entity_nodes
         WHERE id = ?`,
      )
      .get(entityId) as EntityRow | null;

    if (!entity) {
      return null;
    }

    if (entity.memory_scope === "shared_public") {
      return entity.id;
    }

    const existingShared = this.db
      .prepare(
        `SELECT id
         FROM entity_nodes
         WHERE pointer_key = ? AND memory_scope = 'shared_public'
         LIMIT 1`,
      )
      .get(entity.pointer_key) as { id: number } | null;
    if (existingShared) {
      return existingShared.id;
    }

    if (this.isPubliclyIdentifiable(entity, isLocation)) {
      return this.storage.upsertEntity({
        pointerKey: entity.pointer_key,
        displayName: entity.display_name,
        entityType: entity.entity_type,
        summary: entity.summary ?? undefined,
        memoryScope: "shared_public",
        canonicalEntityId: entity.canonical_entity_id ?? entity.id,
      });
    }

    return this.storage.upsertEntity({
      pointerKey: `unknown_person@area:t${timestamp}`,
      displayName: "Unknown person",
      entityType: "person",
      memoryScope: "shared_public",
    });
  }

  private isPubliclyIdentifiable(entity: EntityRow, isLocation: boolean): boolean {
    if (isLocation && entity.entity_type !== "person") {
      return true;
    }

    const pointer = entity.pointer_key.toLowerCase();
    const display = entity.display_name.toLowerCase();
    for (const marker of HIDDEN_ENTITY_MARKERS) {
      if (pointer.includes(marker) || display.includes(marker)) {
        return false;
      }
    }

    return !pointer.startsWith("unknown_person@area:t");
  }

  private buildParticipantsJson(primaryActorEntityId: number | null, locationEntityId: number): string {
    const refs = new Set<string>();
    refs.add(makeNodeRef("entity", locationEntityId));
    if (primaryActorEntityId) {
      refs.add(makeNodeRef("entity", primaryActorEntityId));
    }
    return JSON.stringify(Array.from(refs));
  }

  private toPublicEventCategory(category: AgentEventOverlay["event_category"]): PublicEventCategory | null {
    if (
      category === "speech" ||
      category === "action" ||
      category === "observation" ||
      category === "state_change"
    ) {
      return category;
    }

    return null;
  }

  materializePublications(
    publications: PublicationDeclaration[],
    settlementId: string,
    ctx: {
      sessionId: string;
      locationEntityId?: number;
      timestamp?: number;
    },
  ): MaterializationResult {
    return materializePublications(this.storage, publications, settlementId, ctx);
  }
}

export function materializePublications(
  storage: GraphStorageService,
  publications: PublicationDeclaration[],
  settlementId: string,
  ctx: {
    sessionId: string;
    locationEntityId?: number;
    timestamp?: number;
  },
): MaterializationResult {
  const result: MaterializationResult = { materialized: 0, reconciled: 0, skipped: 0 };

  for (let pubIndex = 0; pubIndex < publications.length; pubIndex += 1) {
    const pub = publications[pubIndex];
    if (!pub || !pub.summary.trim()) {
      result.skipped += 1;
      continue;
    }

    const visibilityScope = publicationScopeToVisibility(pub.targetScope);

    if (visibilityScope === "area_visible" && ctx.locationEntityId === undefined) {
      // current_area publication requires a known location; skip when unavailable
      result.skipped += 1;
      continue;
    }

    let locationEntityId: number;
    if (ctx.locationEntityId !== undefined) {
      locationEntityId = ctx.locationEntityId;
    } else {
      // world_public with no concrete location — use a sentinel entity
      locationEntityId = storage.upsertEntity({
        pointerKey: "world",
        displayName: "The World",
        entityType: "location",
        memoryScope: "shared_public",
      });
    }

    const eventCategory = publicationKindToCategory(pub.kind);
    const participants = JSON.stringify([makeNodeRef("entity", locationEntityId)]);
    const timestamp = ctx.timestamp ?? Date.now();

    try {
      storage.createProjectedEvent({
        sessionId: ctx.sessionId,
        summary: pub.summary.trim(),
        timestamp,
        participants,
        locationEntityId,
        eventCategory,
        origin: "runtime_projection",
        visibilityScope,
        sourceSettlementId: settlementId,
        sourcePubIndex: pubIndex,
      });
      result.materialized += 1;
    } catch (error: unknown) {
      if (isSqliteUniqueConstraintError(error)) {
        result.reconciled += 1;
      } else {
        throw error;
      }
    }
  }

  return result;
}

const PUBLICATION_KIND_TO_CATEGORY: Record<string, PublicEventCategory> = {
  speech: "speech",
  record: "speech",
  display: "observation",
  broadcast: "speech",
  spoken: "speech",
  written: "speech",
  visual: "observation",
};

function publicationKindToCategory(kind: PublicationKind | PublicationKindV2): PublicEventCategory {
  return PUBLICATION_KIND_TO_CATEGORY[kind] ?? "speech";
}

function publicationScopeToVisibility(
  targetScope: PublicationDeclaration["targetScope"],
): "area_visible" | "world_public" {
  return targetScope === "world_public" ? "world_public" : "area_visible";
}

function isSqliteUniqueConstraintError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("unique constraint") || msg.includes("unique_constraint") || msg.includes("constraint failed");
  }
  return false;
}
