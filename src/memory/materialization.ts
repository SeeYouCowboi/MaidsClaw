import type { AgentRole } from "../agents/profile.js";
import type { ArtifactContract } from "../core/tools/tool-definition.js";
import { enforceArtifactContracts, type ArtifactEnforcementContext } from "../core/tools/artifact-contract-policy.js";
import type { PublicationDeclaration } from "../runtime/rp-turn-contract.js";
import { parseGraphNodeRef } from "./contracts/graph-node-ref.js";
import { enforceWriteTemplate } from "./contracts/write-template.js";
import type { WriteTemplate } from "./contracts/write-template.js";
import type { AreaWorldProjectionRepo } from "./projection/area-world-projection-repo.js";
import { makeNodeRef } from "./schema.js";
import type { GraphStorageService } from "./storage.js";
import type { PublicationRecoveryJobPayload } from "./publication-recovery-types.js";
import type { PrivateEventCategory, PublicEventCategory } from "./types.js";
import type {
  PromotionQueryRepo,
} from "../storage/domain-repos/contracts/promotion-query-repo.js";

type RecoveryJobDbLike = {
  prepare: (sql: string) => {
    run: (...params: unknown[]) => { changes?: number; lastInsertRowid?: number | bigint };
  };
};

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
  private readonly projectionRepo: AreaWorldProjectionRepo | null;
  private readonly promotionQueryRepo: PromotionQueryRepo;

  constructor(
    private readonly storage: GraphStorageService | null,
    promotionQueryRepo?: PromotionQueryRepo,
    projectionRepo?: AreaWorldProjectionRepo | null,
  ) {
    this.projectionRepo = projectionRepo ?? null;
    this.promotionQueryRepo = promotionQueryRepo ?? (() => { throw new Error("promotionQueryRepo is required"); })();
  }

  materializeDelayed(privateEvents: unknown[], agentId: string): MaterializationResult {
    const result: MaterializationResult = { materialized: 0, reconciled: 0, skipped: 0 };

    for (const event of privateEvents) {
      const privateEvent = event as MaterializablePrivateEvent;
      if (
        privateEvent.agent_id !== agentId ||
        privateEvent.projection_class !== "area_candidate"
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
      const publicEventCategory = this.resolveNow(this.promotionQueryRepo.toPublicEventCategory(privateEvent.event_category));
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
        this.projectionRepo?.applyMaterializationProjection({
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
    const resolved = this.resolveNow(this.promotionQueryRepo.findPublicEventBySourceRecordId(sourceRecordId));
    if (!resolved) {
      return null;
    }
    const parsed = parseGraphNodeRef(resolved);
    if (parsed.kind !== "event") {
      return null;
    }
    return { id: Number(parsed.id) };
  }

  private getEventById(_eventId: number): EventRow | null {
    return null;
  }

  private linkPrivateToPublic(_privateEventId: number, _publicEventId: number): void {
    // NOTE: episode→public event linkage is tracked via settlement_id in private_episode_events
  }

  private resolveEntityForPublic(entityId: number, timestamp: number, isLocation: boolean): number | null {
    const decision = this.resolveNow(
      this.promotionQueryRepo.resolvePublicEntityDecision({
        sourceEntityRef: makeNodeRef("entity", entityId),
        timestamp,
        isLocation,
      }),
    );

    if (decision.action === "block") {
      return null;
    }

    if (decision.action === "reuse_shared") {
      const parsed = parseGraphNodeRef(decision.resolvedEntityRef);
      if (parsed.kind !== "entity") {
        return null;
      }
      return Number(parsed.id);
    }

    if (!this.storage) {
      return null;
    }

    if (decision.action === "promote_full") {
      const entity = decision.sourceEntity;
      const canonicalParsed = entity.canonicalEntityRef
        ? parseGraphNodeRef(entity.canonicalEntityRef)
        : parseGraphNodeRef(entity.entityRef);
      return this.storage.upsertEntity({
        pointerKey: entity.pointerKey,
        displayName: entity.displayName,
        entityType: entity.entityType,
        summary: entity.summary ?? undefined,
        memoryScope: "shared_public",
        canonicalEntityId: canonicalParsed.kind === "entity" ? Number(canonicalParsed.id) : entityId,
      });
    }

    if (decision.action === "promote_placeholder") {
      return this.storage.upsertEntity({
        pointerKey: decision.placeholderPointerKey,
        displayName: decision.displayName,
        entityType: decision.entityType,
        memoryScope: "shared_public",
      });
    }

    return null;
  }

  private resolveNow<T>(value: Promise<T> | T): T {
    if (!(value instanceof Promise)) {
      return value;
    }

    const settledValue = Bun.peek(value);
    if (settledValue instanceof Promise) {
      throw new Error(
        "MaterializationService sync API received unresolved async repo result. "
          + "Inject adapter-style repos that resolve immediately for this call path.",
      );
    }
    return settledValue as T;
  }

  private buildParticipantsJson(primaryActorEntityId: number | null, locationEntityId: number): string {
    const refs = new Set<string>();
    refs.add(makeNodeRef("entity", locationEntityId));
    if (primaryActorEntityId) {
      refs.add(makeNodeRef("entity", primaryActorEntityId));
    }
    return JSON.stringify(Array.from(refs));
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
      projectionRepo: this.projectionRepo ?? undefined,
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
    db?: RecoveryJobDbLike;
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
        targetScope: pub.targetScope,
        sourceAgentId: options?.sourceAgentId ?? null,
        kind: pub.kind,
      },
      options?.db,
    );

    if (publicationWriteResult === "skipped") {
      result.skipped += 1;
      continue;
    }

    applyPublicationProjectionUpdate(options?.projectionRepo, {
      targetScope: pub.targetScope,
      sourceAgentId: options?.sourceAgentId,
      locationEntityId,
      settlementId,
      pubIndex,
      summary: pub.summary.trim(),
      visibilityScope,
      kind: pub.kind,
      timestamp,
    });
    if (publicationWriteResult === "reconciled") {
      result.reconciled += 1;
      continue;
    }
    result.materialized += 1;
  }

  return result;
}

export function applyPublicationProjectionUpdate(
  projectionRepo: AreaWorldProjectionRepo | null | undefined,
  input: {
    targetScope: PublicationDeclaration["targetScope"];
    sourceAgentId?: string | null;
    locationEntityId: number;
    settlementId: string;
    pubIndex: number;
    summary: string;
    visibilityScope: "area_visible" | "world_public";
    kind: string;
    timestamp: number;
  },
): void {
  if (!projectionRepo || !input.sourceAgentId) {
    return;
  }

  projectionRepo.applyPublicationProjection({
    trigger: "publication",
    targetScope: input.targetScope,
    agentId: input.sourceAgentId,
    areaId: input.locationEntityId,
    settlementId: input.settlementId,
    projectionKey: `publication:${input.settlementId}:${input.pubIndex}`,
    summaryText: input.summary,
    payload: {
      settlementId: input.settlementId,
      pubIndex: input.pubIndex,
      visibilityScope: input.visibilityScope,
      kind: input.kind,
    },
    surfacingClassification: "public_manifestation",
    updatedAt: input.timestamp,
  });
}

type PublicationWriteResult = "materialized" | "reconciled" | "skipped";

type PublicationRetryContext = {
  settlementId: string;
  pubIndex: number;
  maxRetries: number;
  targetScope: PublicationDeclaration["targetScope"];
  sourceAgentId: string | null;
  kind: string;
};

// PublicationRecoveryJobPayload imported from publication-recovery-types.ts

const PUBLICATION_RECOVERY_JOB_TYPE = "publication_recovery";

function createPublicationEventWithRetry(
  storage: GraphStorageService | null,
  params: Parameters<GraphStorageService["createProjectedEvent"]>[0],
  retryContext: PublicationRetryContext,
  db?: RecoveryJobDbLike,
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
		if (isUniqueConstraintError(error)) {
			return "reconciled";
		}

		if (!isTransientStorageError(error)) {
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
  db: RecoveryJobDbLike | undefined,
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
      targetScope: retryContext.targetScope,
      visibilityScope: params.visibilityScope ?? "area_visible",
      sessionId: params.sessionId,
      sourceAgentId: retryContext.sourceAgentId,
      kind: retryContext.kind,
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

    if ((insertResult.changes ?? 0) > 0) {
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

function isUniqueConstraintError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("unique constraint") || msg.includes("unique_constraint") || msg.includes("constraint failed");
  }
  return false;
}

function isTransientStorageError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const msg = error.message.toLowerCase();
  return (
    msg.includes("deadlock detected") ||
    msg.includes("could not serialize access") ||
    msg.includes("connection terminated") ||
    msg.includes("database is locked") ||
    msg.includes("database is busy")
  );
}
