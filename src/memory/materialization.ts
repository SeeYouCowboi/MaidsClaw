import type { Database } from "bun:sqlite";
import type { AgentRole } from "../agents/profile.js";
import type { ArtifactContract } from "../core/tools/tool-definition.js";
import { enforceArtifactContracts, type ArtifactEnforcementContext } from "../core/tools/artifact-contract-policy.js";
import type { PublicationDeclaration } from "../runtime/rp-turn-contract.js";
import { enforceWriteTemplate } from "./contracts/write-template.js";
import type { WriteTemplate } from "./contracts/write-template.js";
import { AreaWorldProjectionRepo } from "./projection/area-world-projection-repo.js";
import { makeNodeRef, SQL_AREA_VISIBLE } from "./schema.js";
import type { GraphStorageService } from "./storage.js";
import type { PublicationRecoveryJobPayload } from "./publication-recovery-types.js";
import type { PrivateEventCategory, PublicEventCategory } from "./types.js";

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

// Minimal type for materializable private events (formerly AgentEventOverlay)
type MaterializablePrivateEvent = {
  id: number;
  event_id: number | null;
  agent_id: string;
  projection_class: string;
  event_category: PrivateEventCategory;
  projectable_summary: string | null;
  location_entity_id: number | null;
  source_record_id: string | null;
  primary_actor_entity_id: number | null;
  created_at: number;
  emotion: string | null;
};

export class MaterializationService {
  private readonly projectionRepo: AreaWorldProjectionRepo;

  constructor(
    private readonly db: Database,
    private readonly storage: GraphStorageService | null,
    projectionRepo?: AreaWorldProjectionRepo,
  ) {
    this.projectionRepo = projectionRepo ?? new AreaWorldProjectionRepo(db);
  }

  materializeDelayed(privateEvents: unknown[], agentId: string): MaterializationResult {
    const result: MaterializationResult = { materialized: 0, reconciled: 0, skipped: 0 };

    for (const event of privateEvents) {
      const privateEvent = event as MaterializablePrivateEvent;
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

      if (!this.storage) {
        result.skipped += 1;
        continue;
      }

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
        this.projectionRepo.applyMaterializationProjection({
          trigger: "materialization",
          agentId,
          areaId: resolvedLocationId,
          projectionKey: `materialization:${privateEvent.source_record_id ?? privateEvent.id}`,
          summaryText: summary,
          payload: {
            sourcePrivateEventId: privateEvent.id,
            projectedEventId: publicEventId,
            sourceRecordId: privateEvent.source_record_id ?? null,
          },
          surfacingClassification: "public_manifestation",
          updatedAt: timestamp,
        });
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
         WHERE source_record_id = ? AND ${SQL_AREA_VISIBLE}
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

  private linkPrivateToPublic(_privateEventId: number, _publicEventId: number): void {
    // NOTE: episode→public event linkage is tracked via settlement_id in private_episode_events
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

    if (!this.storage) {
      return null;
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

  private toPublicEventCategory(category: PrivateEventCategory): PublicEventCategory | null {
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
      sourceAgentId?: string;
      agentRole?: AgentRole;
      writeTemplateOverride?: WriteTemplate;
    },
  ): MaterializationResult {
    return materializePublications(this.storage, publications, settlementId, ctx, {
      db: this.db,
      projectionRepo: this.projectionRepo,
      sourceAgentId: ctx.sourceAgentId,
      agentRole: ctx.agentRole,
      writeTemplateOverride: ctx.writeTemplateOverride,
    });
  }
}

export function materializePublications(
  storage: GraphStorageService | null,
  publications: PublicationDeclaration[],
  settlementId: string,
  ctx: {
    sessionId: string;
    locationEntityId?: number;
    timestamp?: number;
  },
  options?: {
    db?: Database;
    projectionRepo?: AreaWorldProjectionRepo;
    sourceAgentId?: string;
    agentRole?: AgentRole;
    writeTemplateOverride?: WriteTemplate;
    artifactContracts?: Record<string, ArtifactContract>;
    artifactEnforcementContext?: ArtifactEnforcementContext;
    skipEnforcement?: boolean;
  },
): MaterializationResult {
  if (!options?.skipEnforcement) {
    if (options?.agentRole) {
      enforceWriteTemplate(options.agentRole, "publication", options.writeTemplateOverride);
    }

    if (options?.artifactContracts && options.artifactEnforcementContext) {
      enforceArtifactContracts(options.artifactContracts, options.artifactEnforcementContext);
    }
  }

  const result: MaterializationResult = { materialized: 0, reconciled: 0, skipped: 0 };
  const maxRetries = 3;

  for (let pubIndex = 0; pubIndex < publications.length; pubIndex += 1) {
    const pub = publications[pubIndex];
    if (!pub || !pub.summary.trim()) {
      result.skipped += 1;
      continue;
    }

    const visibilityScope = publicationScopeToVisibility(pub.targetScope);

    if (visibilityScope === "area_visible" && ctx.locationEntityId === undefined) {
      result.skipped += 1;
      continue;
    }

    let locationEntityId: number;
    if (ctx.locationEntityId !== undefined) {
      locationEntityId = ctx.locationEntityId;
    } else if (storage) {
      locationEntityId = storage.upsertEntity({
        pointerKey: "world",
        displayName: "The World",
        entityType: "location",
        memoryScope: "shared_public",
      });
    } else {
      result.skipped += 1;
      continue;
    }

    const eventCategory = publicationKindToCategory(pub.kind);
    const participants = JSON.stringify([makeNodeRef("entity", locationEntityId)]);
    const timestamp = ctx.timestamp ?? Date.now();

    const publicationWriteResult = createPublicationEventWithRetry(
      storage,
      {
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
      },
      {
        settlementId,
        pubIndex,
        maxRetries,
      },
      options?.db,
    );

    if (publicationWriteResult === "reconciled") {
      result.reconciled += 1;
      continue;
    }
    if (publicationWriteResult === "skipped") {
      result.skipped += 1;
      continue;
    }

    if (options?.projectionRepo && options.sourceAgentId) {
      options.projectionRepo.applyPublicationProjection({
        trigger: "publication",
        targetScope: pub.targetScope,
        agentId: options.sourceAgentId,
        areaId: locationEntityId,
        projectionKey: `publication:${settlementId}:${pubIndex}`,
        summaryText: pub.summary.trim(),
        payload: {
          settlementId,
          pubIndex,
          visibilityScope,
          kind: pub.kind,
        },
        surfacingClassification: "public_manifestation",
        updatedAt: timestamp,
      });
    }
    result.materialized += 1;
  }

  return result;
}

type PublicationWriteResult = "materialized" | "reconciled" | "skipped";

type PublicationRetryContext = {
  settlementId: string;
  pubIndex: number;
  maxRetries: number;
};

// PublicationRecoveryJobPayload imported from publication-recovery-types.ts

const PUBLICATION_RECOVERY_JOB_TYPE = "publication_recovery";

function createPublicationEventWithRetry(
  storage: GraphStorageService | null,
  params: Parameters<GraphStorageService["createProjectedEvent"]>[0],
  retryContext: PublicationRetryContext,
  db?: Database,
): PublicationWriteResult {
  if (!storage) {
    return "skipped";
  }

  let retryCount = 0;

  for (;;) {
    try {
      storage.createProjectedEvent(params);
      return "materialized";
    } catch (error: unknown) {
      if (isSqliteUniqueConstraintError(error)) {
        return "reconciled";
      }

      if (!isLikelySqliteError(error)) {
        throw error;
      }

      if (retryCount >= retryContext.maxRetries) {
        console.warn(
          `[materializePublications] failed after ${retryContext.maxRetries} retries (settlement=${retryContext.settlementId}, pubIndex=${retryContext.pubIndex})`,
          error,
        );

        writePublicationRecoveryJob(db, params, retryContext, retryCount + 1, error);
        return "skipped";
      }

      const backoffMs = 100 * 2 ** retryCount;
      Bun.sleepSync(backoffMs);
      retryCount += 1;
    }
  }
}

function writePublicationRecoveryJob(
  db: Database | undefined,
  params: Parameters<GraphStorageService["createProjectedEvent"]>[0],
  retryContext: PublicationRetryContext,
  failureCount: number,
  error: unknown,
): void {
  if (!db) {
    console.warn(
      `[materializePublications] cannot write recovery job: db handle not provided (settlement=${retryContext.settlementId}, pubIndex=${retryContext.pubIndex})`,
    );
    return;
  }

  try {
    const now = Date.now();
    const payload: PublicationRecoveryJobPayload = {
      settlementId: retryContext.settlementId,
      pubIndex: retryContext.pubIndex,
      visibilityScope: params.visibilityScope ?? "area_visible",
      sessionId: params.sessionId,
      failureCount,
      lastAttemptAt: now,
      nextAttemptAt: now,
      lastErrorCode: error instanceof Error ? error.name : null,
      lastErrorMessage: error instanceof Error ? error.message : String(error),
      summary: params.summary,
      timestamp: params.timestamp,
      participants: params.participants,
      locationEntityId: params.locationEntityId,
      eventCategory: params.eventCategory,
    };

    const idempotencyKey = `publication_recovery:${retryContext.settlementId}:${retryContext.pubIndex}`;

    const insertResult = db
      .prepare(
        `INSERT OR IGNORE INTO _memory_maintenance_jobs
         (job_type, status, idempotency_key, payload, created_at, updated_at, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        PUBLICATION_RECOVERY_JOB_TYPE,
        "pending",
        idempotencyKey,
        JSON.stringify(payload),
        now,
        now,
        payload.nextAttemptAt,
      );

    if (insertResult.changes > 0) {
      return;
    }

    db.prepare(
      `UPDATE _memory_maintenance_jobs
       SET status = ?, payload = ?, updated_at = ?, next_attempt_at = ?
       WHERE job_type = ? AND idempotency_key = ?`,
    ).run(
      "pending",
      JSON.stringify(payload),
      now,
      payload.nextAttemptAt,
      PUBLICATION_RECOVERY_JOB_TYPE,
      idempotencyKey,
    );
  } catch (recoveryError) {
    console.warn(
      `[materializePublications] recovery job write failed (settlement=${retryContext.settlementId}, pubIndex=${retryContext.pubIndex})`,
      recoveryError,
    );
  }
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

function publicationKindToCategory(kind: string): PublicEventCategory {
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

function isLikelySqliteError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const name = error.name.toLowerCase();
  const msg = error.message.toLowerCase();
  return (
    name.includes("sqlite") ||
    msg.includes("sqlite") ||
    msg.includes("database is locked") ||
    msg.includes("database is busy") ||
    msg.includes("sql logic error")
  );
}
