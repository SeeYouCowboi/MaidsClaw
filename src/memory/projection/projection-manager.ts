import type { AgentRole } from "../../agents/profile.js";
import type { ArtifactEnforcementContext } from "../../core/tools/artifact-contract-policy.js";
import type { ArtifactContract } from "../../core/tools/tool-definition.js";
import type {
  CognitionOp,
  EpisodeEntityRef,
  PrivateEpisodeArtifact,
  PublicationDeclaration,
} from "../../runtime/rp-turn-contract.js";

import type { SettlementRepos } from "../../storage/unit-of-work.js";
import type { CognitionEventRepo } from "../../storage/domain-repos/contracts/cognition-event-repo.js";
import type { SearchProjectionRepo } from "../../storage/domain-repos/contracts/search-projection-repo.js";
import type { PrivateCognitionProjectionRepo } from "../cognition/private-cognition-current.js";
import { normalizePointerKeys } from "../contracts/pointer-key.js";
import type { WriteTemplate } from "../contracts/write-template.js";
import type { EpisodeRepository } from "../episode/episode-repo.js";
import { materializePublications } from "../materialization.js";
import type { GraphStorageService } from "../storage.js";
import type { NodeRef, NodeRefKind } from "../types.js";
import { makeNodeRef } from "../schema.js";
import type {
  AreaStateSourceType,
  AreaWorldProjectionRepo,
  SurfacingClassification,
} from "./area-world-projection-repo.js";

type MaybePromise<T> = T | Promise<T>;

type ProjectionEpisodeRepo = {
  append: (
    params: Parameters<EpisodeRepository["append"]>[0],
  ) => MaybePromise<number>;
};

type ProjectionCognitionEventRepo = {
  append: (
    params: Parameters<CognitionEventRepo["append"]>[0],
  ) => MaybePromise<number | null>;
};

type ProjectionCognitionProjectionRepo = {
  upsertFromEvent: (
    event: Parameters<PrivateCognitionProjectionRepo["upsertFromEvent"]>[0],
  ) => MaybePromise<void>;
  getCurrent?: (
    agentId: Parameters<PrivateCognitionProjectionRepo["getCurrent"]>[0],
    cognitionKey: Parameters<PrivateCognitionProjectionRepo["getCurrent"]>[1],
  ) => MaybePromise<ReturnType<PrivateCognitionProjectionRepo["getCurrent"]>>;
};

type ProjectionSearchProjectionRepo = {
  upsertCognitionSearchDoc: (params: {
    overlayId: number;
    agentId: string;
    kind: string;
    content: string;
    stance: string | null;
    basis: string | null;
    sourceRefKind: "assertion" | "evaluation" | "commitment";
    now: number;
  }) => MaybePromise<number | undefined>;
};

type ProjectionAreaWorldProjectionRepo = {
  upsertAreaState: (
    input: Parameters<AreaWorldProjectionRepo["upsertAreaState"]>[0],
  ) => MaybePromise<void>;
  applyPublicationProjection?: AreaWorldProjectionRepo["applyPublicationProjection"];
};

type ProjectionCommitRepos = Pick<
  SettlementRepos,
  | "episodeRepo"
  | "cognitionEventRepo"
  | "cognitionProjectionRepo"
  | "areaWorldProjectionRepo"
  | "recentCognitionSlotRepo"
> & {
  searchProjectionRepo?: SearchProjectionRepo | ProjectionSearchProjectionRepo;
};

export type CommitSettlementResult = {
  changedNodeRefs: NodeRef[];
};

/** Map an episode row id to the canonical `episode:N` ref. */
function toEpisodeNodeRef(id: number): NodeRef {
  return makeNodeRef("episode", id);
}

/** Build a canonical cognition ref (`assertion:N`, `evaluation:N`, `commitment:N`) from the projection row. */
function toCognitionNodeRef(kind: string, id: number): NodeRef {
  return makeNodeRef(kind as NodeRefKind, id);
}

function resolveSearchProjectionRepo(
  repo: SearchProjectionRepo | ProjectionSearchProjectionRepo,
): ProjectionSearchProjectionRepo {
  if ("upsertCognitionSearchDoc" in repo) {
    return repo;
  }

  return {
    upsertCognitionSearchDoc: (params) => {
      const result = repo.upsertCognitionDoc({
        sourceRef: `${params.sourceRefKind}:${params.overlayId}` as NodeRef,
        agentId: params.agentId,
        kind: params.kind,
        basis: params.basis,
        stance: params.stance,
        content: params.content,
        updatedAt: params.now,
        createdAt: params.now,
      });

      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(() => undefined);
      }
    },
  };
}

function summarizeCognitionOpContent(op: CognitionOp): string {
  if (op.op === "retract") {
    return "(retracted)";
  }

  const key = op.record.key;

  if (op.record.kind === "assertion") {
    const entityValues = op.record.entityRefs
      .map((ref) => ref.value)
      .join(", ");
    return `[${key}] [${op.record.holderId.value}] ${op.record.claim}${entityValues ? ` | entities: ${entityValues}` : ""}`;
  }

  if (op.record.kind === "evaluation") {
    return `[${key}] evaluation: ${op.record.notes ?? ""}`;
  }

  return `[${key}] ${op.record.mode}: ${JSON.stringify(op.record.target)}`;
}

function resolveSearchSourceRefKind(
  op: CognitionOp,
): "assertion" | "evaluation" | "commitment" {
  if (op.op === "upsert") {
    return op.record.kind;
  }

  return op.target.kind;
}

/**
 * Flatten an episode artifact's entityRefs into a deduplicated array of
 * canonical pointer-key strings. `special` refs are expanded into anchor
 * tokens that downstream retrieval can match against:
 *   - `self` → `self:<agentId>`
 *   - `user` → `user`
 *   - `current_location` → `location:<currentLocationEntityId>` when known,
 *     otherwise the literal `current_location`.
 * `pointer_key` refs pass through unchanged.
 */
function resolveEpisodeEntityPointerKeys(
  refs: EpisodeEntityRef[] | undefined,
  agentId: string,
  currentLocationEntityId: number | undefined,
): string[] {
  if (!refs || refs.length === 0) {
    return [];
  }
  const raw: string[] = [];
  for (const ref of refs) {
    if (ref.kind === "pointer_key") {
      raw.push(ref.value);
    } else if (ref.kind === "special") {
      switch (ref.value) {
        case "self":
          raw.push(`self:${agentId}`);
          break;
        case "user":
          raw.push("user");
          break;
        case "current_location":
          raw.push(
            currentLocationEntityId !== undefined
              ? `location:${currentLocationEntityId}`
              : "current_location",
          );
          break;
      }
    }
  }
  return normalizePointerKeys(raw);
}

function isPromiseLike<T = unknown>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function runSeries(
  steps: Array<() => void | Promise<void>>,
  startIndex = 0,
): void | Promise<void> {
  for (let index = startIndex; index < steps.length; index += 1) {
    const result = steps[index]();

    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(() => {
        const continuation = runSeries(steps, index + 1);
        if (isPromiseLike(continuation)) {
          return continuation;
        }
      });
    }
  }

  return;
}

export type SettlementAreaStateArtifact = {
  key: string;
  value: unknown;
  surfacingClassification?: SurfacingClassification;
  sourceType?: AreaStateSourceType;
  areaId?: number;
  validTime?: number;
  committedTime?: number;
};

export type SettlementProjectionParams = {
  settlementId: string;
  sessionId: string;
  agentId: string;
  requestId?: string;
  cognitionOps: CognitionOp[];
  privateEpisodes: PrivateEpisodeArtifact[];
  publications: PublicationDeclaration[];
  viewerSnapshot?: {
    currentLocationEntityId?: number;
  };
  upsertRecentCognitionSlot?: (
    sessionId: string,
    agentId: string,
    settlementId: string,
    newEntriesJson: string,
  ) => MaybePromise<void>;
  recentCognitionSlotJson: string;
  areaStateArtifacts?: SettlementAreaStateArtifact[];
  agentRole?: AgentRole;
  writeTemplateOverride?: WriteTemplate;
  artifactContracts?: Record<string, ArtifactContract>;
  artifactEnforcementContext?: ArtifactEnforcementContext;
  /** Optional pre-generated settlement timestamp. When provided, all sync projections use this value instead of calling Date.now(). */
  committedAt?: number;
};

/**
 * Manages projection builds triggered by settlement commits.
 *
 * **Sync projections** (must complete within the caller's transaction):
 *  - Episode append           → {@link appendEpisodes}
 *  - Cognition event append   → {@link appendCognitionEvents}
 *  - private_cognition_current upsert (inside appendCognitionEvents)
 *  - Recent-cognition slot upsert
 *  - Publication materialization → {@link materializePublicationsSafe}
 *
 * **Async projections** (deferred to {@link GraphOrganizerJob} via MemoryTaskAgent):
 *  - Embedding generation
 *  - Semantic edge construction
 *  - Node scoring (salience / centrality / bridge)
 *  - Same-episode edge maintenance
 *
 * Callers must NOT move any sync projection to the async path; the data must
 * be queryable immediately after `commitSettlement` returns.
 */
export class ProjectionManager {
  constructor(
    private readonly episodeRepo: ProjectionEpisodeRepo,
    private readonly cognitionEventRepo: ProjectionCognitionEventRepo,
    private readonly cognitionProjectionRepo: ProjectionCognitionProjectionRepo,
    private readonly graphStorage: GraphStorageService | null,
    private readonly areaWorldProjectionRepo: ProjectionAreaWorldProjectionRepo | null = null,
    private readonly rawDb?: unknown,
  ) {}

  /**
   * Runs all **sync projections** for a settlement within the caller's transaction.
   *
   * Every write here is synchronous and must be visible to subsequent reads
   * in the same connection immediately after this method returns.
   * Async projection work (embeddings, scoring) is handled separately by
   * {@link GraphOrganizerJob} dispatched from MemoryTaskAgent.
   */
  commitSettlement(
    params: SettlementProjectionParams,
    repoOverrides?: ProjectionCommitRepos,
  ): Promise<CommitSettlementResult> {
    const now = params.committedAt ?? Date.now();
    const episodeRepo = repoOverrides?.episodeRepo ?? this.episodeRepo;
    const cognitionEventRepo =
      repoOverrides?.cognitionEventRepo ?? this.cognitionEventRepo;
    const cognitionProjectionRepo =
      repoOverrides?.cognitionProjectionRepo ?? this.cognitionProjectionRepo;
    const searchProjectionRepo = repoOverrides?.searchProjectionRepo
      ? resolveSearchProjectionRepo(repoOverrides.searchProjectionRepo)
      : undefined;
    const areaWorldProjectionRepo =
      repoOverrides?.areaWorldProjectionRepo ?? this.areaWorldProjectionRepo;
    const recentCognitionSlotRepo = repoOverrides?.recentCognitionSlotRepo;
    const changedNodeRefs: NodeRef[] = [];
    const result = runSeries([
      () => this.appendEpisodes(params, now, episodeRepo, changedNodeRefs),
      () =>
        this.appendCognitionEvents(
          params,
          now,
          cognitionEventRepo,
          cognitionProjectionRepo,
          searchProjectionRepo,
          changedNodeRefs,
        ),
      () => {
        if (!recentCognitionSlotRepo && !params.upsertRecentCognitionSlot) {
          throw new Error(
            "ProjectionManager.commitSettlement requires recent cognition slot repo or upsert callback",
          );
        }

        const writeResult = recentCognitionSlotRepo
          ? recentCognitionSlotRepo.upsertRecentCognitionSlot(
              params.sessionId,
              params.agentId,
              params.settlementId,
              params.recentCognitionSlotJson,
            )
          : params.upsertRecentCognitionSlot?.(
              params.sessionId,
              params.agentId,
              params.settlementId,
              params.recentCognitionSlotJson,
            );

        if (isPromiseLike(writeResult)) {
          return Promise.resolve(writeResult).then(() => undefined);
        }
      },
      () => this.upsertAreaStateArtifacts(params, now, areaWorldProjectionRepo),
      () =>
        this.materializePublicationsSafe(
          params,
          now,
          areaWorldProjectionRepo,
          repoOverrides,
        ),
    ]);

    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(() => ({ changedNodeRefs }));
    }

    return Promise.resolve({ changedNodeRefs });
  }

  private upsertAreaStateArtifacts(
    params: SettlementProjectionParams,
    now: number,
    areaWorldProjectionRepo: ProjectionAreaWorldProjectionRepo | null,
  ): void | Promise<void> {
    if (!areaWorldProjectionRepo || !params.areaStateArtifacts?.length) {
      return;
    }

    const steps = params.areaStateArtifacts.map((artifact) => () => {
      const areaId =
        artifact.areaId ?? params.viewerSnapshot?.currentLocationEntityId;
      if (areaId === undefined) {
        return;
      }

      const upsertResult = areaWorldProjectionRepo.upsertAreaState({
        agentId: params.agentId,
        areaId,
        key: artifact.key,
        value: artifact.value,
        surfacingClassification:
          artifact.surfacingClassification ?? "latent_state_update",
        sourceType: artifact.sourceType ?? "system",
        updatedAt: now,
        validTime: artifact.validTime,
        committedTime: artifact.committedTime ?? now,
        settlementId: params.settlementId,
      });

      if (isPromiseLike(upsertResult)) {
        return Promise.resolve(upsertResult);
      }
    });

    return runSeries(steps);
  }

  /** Sync projection: appends private episode rows within the settlement transaction. */
  private appendEpisodes(
    params: SettlementProjectionParams,
    now: number,
    episodeRepo: ProjectionEpisodeRepo,
    changedNodeRefs: NodeRef[],
  ): void | Promise<void> {
    const steps = params.privateEpisodes.map((episode) => () => {
      const entityPointerKeys = resolveEpisodeEntityPointerKeys(
        episode.entityRefs,
        params.agentId,
        params.viewerSnapshot?.currentLocationEntityId,
      );
      const appendResult = episodeRepo.append({
        agentId: params.agentId,
        sessionId: params.sessionId,
        settlementId: params.settlementId,
        category: episode.category,
        summary: episode.summary,
        privateNotes: episode.privateNotes,
        locationEntityId: params.viewerSnapshot?.currentLocationEntityId,
        locationText: episode.locationText,
        validTime: episode.validTime,
        committedTime: now,
        sourceLocalRef: episode.localRef,
        entityPointerKeys,
      });

      if (isPromiseLike(appendResult)) {
        return Promise.resolve(appendResult).then((episodeId) => {
          changedNodeRefs.push(toEpisodeNodeRef(episodeId));
          return undefined;
        });
      }

      changedNodeRefs.push(toEpisodeNodeRef(appendResult));
    });

    return runSeries(steps);
  }

  /** Sync projection: appends cognition events and upserts private_cognition_current within the settlement transaction. */
  private appendCognitionEvents(
    params: SettlementProjectionParams,
    now: number,
    cognitionEventRepo: ProjectionCognitionEventRepo,
    cognitionProjectionRepo: ProjectionCognitionProjectionRepo,
    searchProjectionRepo: ProjectionSearchProjectionRepo | undefined,
    changedNodeRefs: NodeRef[],
  ): void | Promise<void> {
    const steps = params.cognitionOps.map((op) => () => {
      let recordJson: string | null = null;

      if (op.op === "upsert") {
        recordJson = JSON.stringify(op.record);
      }

      const cognitionKey = op.op === "upsert" ? op.record.key : op.target.key;
      const cognitionKind =
        op.op === "upsert" ? op.record.kind : op.target.kind;
      const sourceRefKind = resolveSearchSourceRefKind(op);

      const syncSearchProjection = (eventId: number): void | Promise<void> => {
        if (!searchProjectionRepo) {
          return;
        }
        const getCurrent = cognitionProjectionRepo.getCurrent?.bind(
          cognitionProjectionRepo,
        );

        const upsertSearchDoc = (
          current: ReturnType<PrivateCognitionProjectionRepo["getCurrent"]>,
        ): void | Promise<void> => {
          const overlayId = current?.id ?? eventId;
          const searchResult = searchProjectionRepo.upsertCognitionSearchDoc({
            overlayId,
            agentId: params.agentId,
            kind: current?.kind ?? cognitionKind,
            content: current?.summary_text ?? summarizeCognitionOpContent(op),
            stance:
              current?.stance ??
              (op.op === "upsert" && op.record.kind === "assertion"
                ? op.record.stance
                : op.op === "retract" && op.target.kind === "assertion"
                  ? "rejected"
                  : null),
            basis:
              current?.basis ??
              (op.op === "upsert" && op.record.kind === "assertion"
                ? (op.record.basis ?? null)
                : null),
            sourceRefKind,
            now,
          });

          if (isPromiseLike(searchResult)) {
            return Promise.resolve(searchResult).then(() => undefined);
          }
        };

        if (!getCurrent) {
          return upsertSearchDoc(null);
        }

        const currentResult = getCurrent(params.agentId, cognitionKey);

        if (isPromiseLike(currentResult)) {
          return Promise.resolve(currentResult).then((current) =>
            upsertSearchDoc(current),
          );
        }

        return upsertSearchDoc(currentResult);
      };

      const applyProjection = (eventId: number): void | Promise<void> => {
        const upsertResult = cognitionProjectionRepo.upsertFromEvent({
          id: eventId,
          agent_id: params.agentId,
          cognition_key: cognitionKey,
          kind: cognitionKind,
          op: op.op,
          record_json: recordJson,
          settlement_id: params.settlementId,
          committed_time: now,
          request_id: params.requestId ?? null,
          created_at: now,
        });

        if (isPromiseLike(upsertResult)) {
          return Promise.resolve(upsertResult).then(() =>
            syncSearchProjection(eventId),
          );
        }

        return syncSearchProjection(eventId);
      };

      const appendResult = cognitionEventRepo.append({
        agentId: params.agentId,
        cognitionKey,
        kind: cognitionKind,
        op: op.op,
        recordJson,
        settlementId: params.settlementId,
        committedTime: now,
        requestId: params.requestId,
      });

      if (isPromiseLike<number | null>(appendResult)) {
        return Promise.resolve(appendResult).then((eventId) => {
          if (eventId === null) return;
          const afterProjection = (): void | Promise<void> => {
            if (!cognitionProjectionRepo.getCurrent) {
              return;
            }
            const currentResult = cognitionProjectionRepo.getCurrent(
              params.agentId,
              cognitionKey,
            );
            if (isPromiseLike(currentResult)) {
              return Promise.resolve(currentResult).then((row) => {
                if (row)
                  changedNodeRefs.push(toCognitionNodeRef(row.kind, row.id));
              });
            }
            if (currentResult)
              changedNodeRefs.push(
                toCognitionNodeRef(currentResult.kind, currentResult.id),
              );
          };
          const projResult = applyProjection(eventId);
          if (isPromiseLike(projResult)) {
            return Promise.resolve(projResult)
              .then(() => afterProjection())
              .then(() => undefined);
          }
          const afterResult = afterProjection();
          if (isPromiseLike(afterResult)) {
            return Promise.resolve(afterResult).then(() => undefined);
          }
        });
      }

      if (appendResult === null) return;
      const syncProjResult = applyProjection(appendResult);
      const pushCognitionRef = (): void | Promise<void> => {
        if (!cognitionProjectionRepo.getCurrent) {
          return;
        }
        const currentResult = cognitionProjectionRepo.getCurrent(
          params.agentId,
          cognitionKey,
        );
        if (isPromiseLike(currentResult)) {
          return Promise.resolve(currentResult).then((row) => {
            if (row) changedNodeRefs.push(toCognitionNodeRef(row.kind, row.id));
          });
        }
        if (currentResult)
          changedNodeRefs.push(
            toCognitionNodeRef(currentResult.kind, currentResult.id),
          );
      };
      if (isPromiseLike(syncProjResult)) {
        return Promise.resolve(syncProjResult)
          .then(() => pushCognitionRef())
          .then(() => undefined);
      }
      return pushCognitionRef();
    });

    return runSeries(steps);
  }

  /**
   * Sync projection: materializes publication declarations into graph storage within the settlement transaction.
   *
   * Publication path semantics:
   * 1) `current_area` -> `area_visible` event projected directly into the current area.
   * 2) `world_public` -> `world_public` event projected with world-level visibility.
   * 3) no publications -> fast return without any projection work.
   *
   * Safety guard: when `graphStorage` is null, publication materialization is silently skipped.
   */
  private materializePublicationsSafe(
    params: SettlementProjectionParams,
    committedAt: number,
    areaWorldProjectionRepo: ProjectionAreaWorldProjectionRepo | null,
    repoOverrides?: ProjectionCommitRepos,
  ): void {
    if (params.publications.length === 0 || !this.graphStorage) {
      return;
    }

    const supportsSyncPublicationProjection =
      repoOverrides === undefined ||
      repoOverrides.areaWorldProjectionRepo === undefined;

    materializePublications(
      this.graphStorage,
      params.publications,
      params.settlementId,
      {
        sessionId: params.sessionId,
        locationEntityId: params.viewerSnapshot?.currentLocationEntityId,
        timestamp: committedAt,
      },
      {
        db: this.rawDb as never,
        projectionRepo: supportsSyncPublicationProjection
          ? ((areaWorldProjectionRepo as AreaWorldProjectionRepo | null) ??
            undefined)
          : undefined,
        sourceAgentId: params.agentId,
        agentRole: params.agentRole,
        writeTemplateOverride: params.writeTemplateOverride,
        artifactContracts: params.artifactContracts,
        artifactEnforcementContext: params.artifactEnforcementContext,
      },
    );
  }
}
