import type { AgentRole } from "../../agents/profile.js";
import type { ArtifactEnforcementContext } from "../../core/tools/artifact-contract-policy.js";
import type { ArtifactContract } from "../../core/tools/tool-definition.js";
import type {
  SceneFactCommit,
  AssertionBasis,
  AssertionGroundingRef,
  AssertionProvenance,
  AssertionRecordV4,
  AssertionVerificationLevel,
  CognitionOp,
  EpisodeEntityRef,
  PrivateEpisodeArtifact,
  PublicationDeclaration,
  WorldStateOp,
} from "../../runtime/rp-turn-contract.js";

import type { SettlementRepos } from "../../storage/unit-of-work.js";
import type { CognitionEventRepo } from "../../storage/domain-repos/contracts/cognition-event-repo.js";
import type { InteractionRepo } from "../../storage/domain-repos/contracts/interaction-repo.js";
import type { SearchProjectionRepo } from "../../storage/domain-repos/contracts/search-projection-repo.js";
import type { GraphMutableStoreRepo } from "../../storage/domain-repos/contracts/graph-mutable-store-repo.js";
import type { UnresolvedWorldStateOpsRepo } from "../../storage/domain-repos/contracts/unresolved-world-state-ops-repo.js";
import type { PrivateCognitionProjectionRepo } from "../cognition/private-cognition-current.js";
import { normalizePointerKeys } from "../contracts/pointer-key.js";
import type { WriteTemplate } from "../contracts/write-template.js";
import type { EpisodeRepository } from "../episode/episode-repo.js";
import { materializePublications } from "../materialization.js";
import { applyWorldStateOpsForSettlement } from "../world-state-ops-applier.js";
import type { GraphStorageService } from "../storage.js";
import type { NodeRef, NodeRefKind } from "../types.js";
import { makeNodeRef } from "../schema.js";
import type {
  AreaFactExposureScope,
  AreaStateSourceType,
  AreaWorldProjectionRepo,
  SurfacingClassification,
  WorldFactExposureScope,
} from "./area-world-projection-repo.js";

type MaybePromise<T> = T | Promise<T>;

type ProjectionEpisodeRepo = {
  append: (
    params: Parameters<EpisodeRepository["append"]>[0],
  ) => MaybePromise<number>;
  readBySettlement?: (
    settlementId: string,
    agentId: string,
  ) => MaybePromise<Array<{ id: number; source_local_ref: string | null }>>;
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
  upsertEpisodeSearchDoc: (params: {
    episodeId: number;
    agentId: string;
    category: string;
    content: string;
    committedAt: number;
    now: number;
    entityPointerKeys: string[];
  }) => MaybePromise<number | undefined>;
};

type ProjectionAreaWorldProjectionRepo = {
  upsertAreaState: (
    input: Parameters<AreaWorldProjectionRepo["upsertAreaState"]>[0],
  ) => MaybePromise<void>;
  applyAreaFactCommit: (
    input: Parameters<AreaWorldProjectionRepo["applyAreaFactCommit"]>[0],
  ) => MaybePromise<{ eventId: bigint }>;
  applyWorldFactCommit: (
    input: Parameters<AreaWorldProjectionRepo["applyWorldFactCommit"]>[0],
  ) => MaybePromise<{ eventId: bigint }>;
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
  interactionRepo?: InteractionRepo;
  searchProjectionRepo?: SearchProjectionRepo | ProjectionSearchProjectionRepo;
  graphStoreRepo?: SettlementRepos["graphStoreRepo"];
  unresolvedOpsRepo?: SettlementRepos["unresolvedOpsRepo"];
};

export type CommitSettlementResult = {
  changedNodeRefs: NodeRef[];
};

type AssertionUpsertSnapshot = {
  opIndex: number;
  cognitionKey: string;
  record: AssertionRecordV4 & { sourceTurnVersion?: number };
};

type AssertionVerificationOutcome = {
  basis: AssertionBasis | undefined;
  provenance: AssertionProvenance;
  verifiedGroundingRefs: AssertionGroundingRef[];
  groundingVerificationLevel: AssertionVerificationLevel;
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
    upsertEpisodeSearchDoc: (params) => {
      const result = repo.upsertEpisodeDoc({
        sourceRef: `episode:${params.episodeId}`,
        agentId: params.agentId,
        category: params.category,
        content: params.content,
        committedAt: params.committedAt,
        createdAt: params.now,
        entityPointerKeys: params.entityPointerKeys,
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

const ASSERTION_PROVENANCE_VALUES = new Set<AssertionProvenance>([
  "user_stated",
  "talker_sketch_explicit",
  "talker_sketch_auto",
  "thinker_inferred",
  "explicit_settlement",
  "legacy_unknown",
]);

type RecentCognitionSlotEntry = {
  kind?: string;
  key?: string;
  basis?: AssertionBasis | "unknown";
  provenance?: AssertionProvenance | "legacy_unknown";
  groundingVerificationLevel?: string;
};

function normalizeAssertionProvenance(value: unknown): AssertionProvenance {
  if (
    typeof value === "string" &&
    ASSERTION_PROVENANCE_VALUES.has(value as AssertionProvenance)
  ) {
    return value as AssertionProvenance;
  }
  return "legacy_unknown";
}

function normalizeAssertionGroundingRefs(
  value: unknown,
): AssertionGroundingRef[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const refs: AssertionGroundingRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.kind !== "string" || typeof candidate.ref !== "string") {
      continue;
    }
    const ref = candidate.ref.trim();
    if (ref.length === 0) {
      continue;
    }
    refs.push({
      kind: candidate.kind as AssertionGroundingRef["kind"],
      ref,
      ...(typeof candidate.excerpt === "string"
        ? { excerpt: candidate.excerpt.slice(0, 160) }
        : {}),
    });
  }
  return refs;
}

function toContextVerificationLevel(params: {
  hasVerifiedEpisodeRef: boolean;
  hasVerifiedContextRef: boolean;
}): AssertionVerificationLevel {
  if (params.hasVerifiedEpisodeRef) {
    return "strong_verified";
  }
  if (params.hasVerifiedContextRef) {
    return "context_verified";
  }
  return "unverified";
}

function toPostVerificationBasis(params: {
  basis: AssertionBasis | undefined;
  provenance: AssertionProvenance;
  hasVerifiedAnchorRef: boolean;
}): AssertionBasis | undefined {
  if (!params.hasVerifiedAnchorRef) {
    return params.basis;
  }

  if (
    params.provenance === "user_stated" ||
    params.provenance === "explicit_settlement"
  ) {
    return "first_hand";
  }

  if (
    params.provenance === "talker_sketch_explicit" ||
    params.provenance === "talker_sketch_auto"
  ) {
    if (
      params.basis === undefined ||
      params.basis === "belief" ||
      params.basis === "inference"
    ) {
      return "inference";
    }
    return "inference";
  }

  return params.basis;
}

function parseRecentCognitionSlotEntries(
  value: string,
): RecentCognitionSlotEntry[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as RecentCognitionSlotEntry[];
  } catch {
    return [];
  }
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
    selfPointerKey?: string;
    userPointerKey?: string;
    currentLocationEntityId?: number;
  };
  upsertRecentCognitionSlot?: (
    sessionId: string,
    agentId: string,
    settlementId: string,
    newEntriesJson: string,
  ) => MaybePromise<void>;
  recentCognitionSlotJson: string;
  areaStateArtifacts?: SettlementAreaStateArtifact[]; // LEGACY_COMPAT: kept for type compatibility, ignored when legacyAreaStateCompat=false
  agentRole?: AgentRole;
  writeTemplateOverride?: WriteTemplate;
  artifactContracts?: Record<string, ArtifactContract>;
  artifactEnforcementContext?: ArtifactEnforcementContext;
  /** Optional pre-generated settlement timestamp. When provided, all sync projections use this value instead of calling Date.now(). */
  committedAt?: number;
  /** Scene fact commits to write inside the same transaction as cognition/episodes/slots. */
  sceneFactCommits?: SceneFactCommit[];
  /** Rollout flag: only write scene facts when this is true */
  sceneFactWritePath?: boolean;
  /** Optional world-state ops (entity->entity fact edges) emitted by the turn. */
  worldStateOps?: WorldStateOp[];
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
    // Invariant: requestId must be derived from settlementId
    if (params.requestId && params.settlementId) {
      const expected = params.settlementId.replace(/^stl:/, "");
      if (params.requestId !== expected) {
        const msg = `[projection] requestId/settlementId mismatch: requestId=${params.requestId}, expected=${expected} (from settlementId=${params.settlementId})`;
        if (process.env.NODE_ENV !== "production") {
          throw new Error(msg);
        }
        console.error(msg);
      }
    }

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
    const interactionRepo = repoOverrides?.interactionRepo;
    const assertionUpsertSnapshots: AssertionUpsertSnapshot[] = [];
    for (let index = 0; index < params.cognitionOps.length; index += 1) {
      const op = params.cognitionOps[index];
      if (op.op !== "upsert" || op.record.kind !== "assertion") {
        continue;
      }
      assertionUpsertSnapshots.push({
        opIndex: index,
        cognitionKey: op.record.key,
        record: {
          ...op.record,
        } as AssertionRecordV4 & { sourceTurnVersion?: number },
      });
    }

    let verifiedSlotJson = params.recentCognitionSlotJson;
    const changedNodeRefs: NodeRef[] = [];
    const result = runSeries([
      () =>
        this.appendCognitionEvents(
          params,
          now,
          cognitionEventRepo,
          cognitionProjectionRepo,
          searchProjectionRepo,
          changedNodeRefs,
        ),
      () =>
        this.appendEpisodes(
          params,
          now,
          episodeRepo,
          searchProjectionRepo,
          changedNodeRefs,
        ),
      () => this.applySceneFactCommits(params, areaWorldProjectionRepo),
      () => {
        this.materializePublicationsSafe(
          params,
          now,
          areaWorldProjectionRepo,
          repoOverrides,
        );
      },
      () => {
        if (!params.worldStateOps || params.worldStateOps.length === 0) {
          return;
        }

        if (!repoOverrides?.graphStoreRepo || !repoOverrides?.unresolvedOpsRepo) {
          throw new Error(
            "ProjectionManager.commitSettlement requires graphStoreRepo and unresolvedOpsRepo when worldStateOps are provided",
          );
        }

        const viewerSnapshot =
          params.viewerSnapshot?.selfPointerKey &&
            params.viewerSnapshot?.userPointerKey
            ? {
              selfPointerKey: params.viewerSnapshot.selfPointerKey,
              userPointerKey: params.viewerSnapshot.userPointerKey,
              currentLocationEntityId:
                params.viewerSnapshot.currentLocationEntityId,
            }
            : undefined;

        const applyResult = applyWorldStateOpsForSettlement({
          settlementId: params.settlementId,
          sessionId: params.sessionId,
          agentId: params.agentId,
          worldStateOps: params.worldStateOps,
          viewerSnapshot,
          graphStoreRepo:
            repoOverrides.graphStoreRepo as Pick<
              GraphMutableStoreRepo,
              "resolveEntityByPointerKey" | "createWorldStateFactEdge" | "upsertEntity"
            >,
          unresolvedOpsRepo:
            repoOverrides.unresolvedOpsRepo as Pick<
              UnresolvedWorldStateOpsRepo,
              "enqueueOp"
            >,
          settledAt: now,
        });

        if (isPromiseLike(applyResult)) {
          return Promise.resolve(applyResult).then(() => undefined);
        }
      },
      () => {
        const verificationResult = this.runSynchronousGroundingVerification({
          params,
          now,
          interactionRepo,
          episodeRepo,
          cognitionEventRepo,
          cognitionProjectionRepo,
          searchProjectionRepo,
          assertionUpsertSnapshots,
        });

        if (isPromiseLike(verificationResult)) {
          return Promise.resolve(verificationResult).then((verificationByKey) => {
            verifiedSlotJson = this.applyVerificationResultsToRecentSlotJson(
              params.recentCognitionSlotJson,
              verificationByKey,
            );
          });
        }

        verifiedSlotJson = this.applyVerificationResultsToRecentSlotJson(
          params.recentCognitionSlotJson,
          verificationResult,
        );
      },
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
              verifiedSlotJson,
            )
          : params.upsertRecentCognitionSlot?.(
              params.sessionId,
              params.agentId,
              params.settlementId,
              verifiedSlotJson,
            );

        if (isPromiseLike(writeResult)) {
          return Promise.resolve(writeResult).then(() => undefined);
        }
      },
      () => this.upsertAreaStateArtifacts(params, now, areaWorldProjectionRepo),
    ]);

    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(() => ({ changedNodeRefs }));
    }

    return Promise.resolve({ changedNodeRefs });
  }

  // TODO(legacy-cleanup): remove in post-cutover cleanup
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
    searchProjectionRepo: ProjectionSearchProjectionRepo | undefined,
    changedNodeRefs: NodeRef[],
  ): void | Promise<void> {
    const steps = params.privateEpisodes.map((episode, index) => () => {
      const entityPointerKeys = resolveEpisodeEntityPointerKeys(
        episode.entityRefs,
        params.agentId,
        params.viewerSnapshot?.currentLocationEntityId,
      );
      const appendResult = episodeRepo.append({
        agentId: params.agentId,
        sessionId: params.sessionId,
        settlementId: params.settlementId,
        requestId: params.requestId,
        category: episode.category,
        summary: episode.summary,
        privateNotes: episode.privateNotes,
        locationEntityId: params.viewerSnapshot?.currentLocationEntityId,
        locationText: episode.locationText,
        validTime: episode.validTime,
        committedTime: now,
        sourceLocalRef: episode.localRef ?? `${params.settlementId}:_auto:${index}`,
        entityPointerKeys,
      });

      const afterAppend = (episodeId: number): void | Promise<void> => {
        if (episodeId <= 0) return; // ON CONFLICT DO NOTHING — episode already exists, skip
        if (!searchProjectionRepo) {
          changedNodeRefs.push(toEpisodeNodeRef(episodeId));
          return;
        }
        const searchResult = searchProjectionRepo.upsertEpisodeSearchDoc({
          episodeId,
          agentId: params.agentId,
          category: episode.category,
          content: episode.summary,
          committedAt: now,
          now,
          entityPointerKeys,
        });

        if (isPromiseLike(searchResult)) {
          return Promise.resolve(searchResult).then(() => {
            changedNodeRefs.push(toEpisodeNodeRef(episodeId));
          });
        }
        changedNodeRefs.push(toEpisodeNodeRef(episodeId));
      };

      if (isPromiseLike(appendResult)) {
        return Promise.resolve(appendResult).then((episodeId) => {
          const result = afterAppend(episodeId);
          if (isPromiseLike(result)) {
            return Promise.resolve(result).then(() => undefined);
          }
          return undefined;
        });
      }

      return afterAppend(appendResult);
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

  private async applySceneFactCommits(
    params: SettlementProjectionParams,
    areaWorldProjectionRepo: ProjectionAreaWorldProjectionRepo | null,
  ): Promise<void> {
    if (!params.sceneFactWritePath) return;
    if (!params.sceneFactCommits?.length) return;
    if (!areaWorldProjectionRepo) return;

    const committedTime = new Date(params.committedAt ?? Date.now());

    // Sentinel for sessions without an explicitly-tracked current area. Scene facts
    // written under this id share a single "session-root" bucket — the user can still
    // move between areas later; until then, area-scoped commits would otherwise be
    // silently dropped. 0 works because `area_id` has no FK constraint to entity_nodes.
    const SESSION_ROOT_AREA_ID = 0;

    for (const commit of params.sceneFactCommits) {
      if (commit.scope === "area") {
        const areaId =
          commit.areaId ??
          params.viewerSnapshot?.currentLocationEntityId ??
          SESSION_ROOT_AREA_ID;
        await areaWorldProjectionRepo.applyAreaFactCommit({
          sessionId: params.sessionId,
          areaId,
          factKey: commit.factKey,
          valueJson: commit.value,
          sourceKind: commit.sourceKind,
          exposureScope: commit.exposureScope as AreaFactExposureScope,
          sourceSettlementId: params.settlementId,
          sourceAgentId: params.agentId,
          validTime: committedTime,
          committedTime,
        });
      } else {
        await areaWorldProjectionRepo.applyWorldFactCommit({
          sessionId: params.sessionId,
          factKey: commit.factKey,
          valueJson: commit.value,
          sourceKind: commit.sourceKind,
          exposureScope: commit.exposureScope as WorldFactExposureScope,
          sourceSettlementId: params.settlementId,
          sourceAgentId: params.agentId,
          validTime: committedTime,
          committedTime,
        });
      }
    }
  }

  private async runSynchronousGroundingVerification(params: {
    params: SettlementProjectionParams;
    now: number;
    interactionRepo: InteractionRepo | undefined;
    episodeRepo: ProjectionEpisodeRepo;
    cognitionEventRepo: ProjectionCognitionEventRepo;
    cognitionProjectionRepo: ProjectionCognitionProjectionRepo;
    searchProjectionRepo: ProjectionSearchProjectionRepo | undefined;
    assertionUpsertSnapshots: AssertionUpsertSnapshot[];
  }): Promise<Map<string, AssertionVerificationOutcome>> {
    const outcomesByKey = new Map<string, AssertionVerificationOutcome>();
    if (params.assertionUpsertSnapshots.length === 0) {
      return outcomesByKey;
    }

    const requestVerifiedCache = new Map<string, Promise<boolean>>();
    const settlementVerifiedCache = new Map<string, Promise<boolean>>();
    const cognitionVerifiedCache = new Map<string, Promise<boolean>>();

    const verifyRequestRef = async (requestId: string): Promise<boolean> => {
      const interactionRepo = params.interactionRepo;
      if (!interactionRepo) {
        return false;
      }
      const cached = requestVerifiedCache.get(requestId);
      if (cached) {
        return cached;
      }
      const verificationPromise = (async () => {
        const sessionId = await interactionRepo.findSessionIdByRequestId(
          requestId,
        );
        if (!sessionId || sessionId !== params.params.sessionId) {
          return false;
        }
        const payload = await interactionRepo.getSettlementPayload(
          sessionId,
          requestId,
        );
        if (!payload) {
          return false;
        }
        return payload.ownerAgentId === params.params.agentId;
      })();
      requestVerifiedCache.set(requestId, verificationPromise);
      return verificationPromise;
    };

    const verifySettlementRef = async (settlementRef: string): Promise<boolean> => {
      const interactionRepo = params.interactionRepo;
      if (!interactionRepo) {
        return false;
      }
      const cached = settlementVerifiedCache.get(settlementRef);
      if (cached) {
        return cached;
      }
      const verificationPromise = (async () => {
        const settlementId = settlementRef.startsWith("stl:")
          ? settlementRef
          : `stl:${settlementRef}`;
        const requestId = settlementId.replace(/^stl:/, "");
        const sessionId = await interactionRepo.findSessionIdByRequestId(
          requestId,
        );
        if (!sessionId || sessionId !== params.params.sessionId) {
          return false;
        }
        const exists = await interactionRepo.settlementExists(
          sessionId,
          settlementId,
        );
        if (!exists) {
          return false;
        }
        const payload = await interactionRepo.getSettlementPayload(
          sessionId,
          requestId,
        );
        if (!payload) {
          return false;
        }
        return (
          payload.ownerAgentId === params.params.agentId &&
          payload.settlementId === settlementId
        );
      })();
      settlementVerifiedCache.set(settlementRef, verificationPromise);
      return verificationPromise;
    };

    const episodeRows = params.episodeRepo.readBySettlement
      ? await params.episodeRepo.readBySettlement(
          params.params.settlementId,
          params.params.agentId,
        )
      : [];
    const localRefIndex = new Map<string, number>();
    for (const row of episodeRows) {
      if (row.source_local_ref) {
        localRefIndex.set(row.source_local_ref, Number(row.id));
      }
    }

    const verifyCognitionRef = async (cognitionKey: string): Promise<boolean> => {
      if (!params.cognitionProjectionRepo.getCurrent) {
        return false;
      }
      const cached = cognitionVerifiedCache.get(cognitionKey);
      if (cached) {
        return cached;
      }
      const verificationPromise = Promise.resolve(
        params.cognitionProjectionRepo.getCurrent(
          params.params.agentId,
          cognitionKey,
        ),
      ).then((row) => Boolean(row));
      cognitionVerifiedCache.set(cognitionKey, verificationPromise);
      return verificationPromise;
    };

    for (const snapshot of params.assertionUpsertSnapshots) {
      const claimedGroundingRefs = normalizeAssertionGroundingRefs(
        snapshot.record.claimedGroundingRefs,
      );
      const verifiedGroundingRefs: AssertionGroundingRef[] = [];

      let hasVerifiedEpisodeRef = false;
      let hasVerifiedContextRef = false;
      let hasVerifiedAnchorRef = false;

      for (const ref of claimedGroundingRefs) {
        if (ref.ref.startsWith("request:")) {
          const requestId = ref.ref.slice("request:".length).trim();
          if (requestId.length > 0 && (await verifyRequestRef(requestId))) {
            verifiedGroundingRefs.push(ref);
            hasVerifiedContextRef = true;
            hasVerifiedAnchorRef = true;
          }
          continue;
        }

        if (ref.ref.startsWith("settlement:")) {
          const settlementRef = ref.ref.slice("settlement:".length).trim();
          if (
            settlementRef.length > 0 &&
            (await verifySettlementRef(settlementRef))
          ) {
            verifiedGroundingRefs.push(ref);
            hasVerifiedContextRef = true;
            hasVerifiedAnchorRef = true;
          }
          continue;
        }

        if (ref.ref.startsWith("episode:")) {
          const localRef = ref.ref.slice("episode:".length).trim();
          if (localRef.length > 0 && localRefIndex.has(localRef)) {
            verifiedGroundingRefs.push(ref);
            hasVerifiedEpisodeRef = true;
            hasVerifiedAnchorRef = true;
          }
          continue;
        }

        if (ref.ref.startsWith("cognition:")) {
          const cognitionKey = ref.ref.slice("cognition:".length).trim();
          if (cognitionKey.length > 0 && (await verifyCognitionRef(cognitionKey))) {
            verifiedGroundingRefs.push(ref);
          }
        }
      }

      const groundingVerificationLevel = toContextVerificationLevel({
        hasVerifiedEpisodeRef,
        hasVerifiedContextRef,
      });
      const provenance = normalizeAssertionProvenance(snapshot.record.provenance);
      const basis = toPostVerificationBasis({
        basis: snapshot.record.basis,
        provenance,
        hasVerifiedAnchorRef,
      });

      outcomesByKey.set(snapshot.cognitionKey, {
        basis,
        provenance,
        verifiedGroundingRefs,
        groundingVerificationLevel,
      });

      const verifiedRecord: AssertionRecordV4 & { sourceTurnVersion?: number } = {
        ...snapshot.record,
        basis,
        provenance,
        claimedGroundingRefs,
        verifiedGroundingRefs,
        groundingVerificationLevel,
        sourceTurnVersion: snapshot.record.sourceTurnVersion,
      };

      const verificationSettlementId = `${params.params.settlementId}::verification:${snapshot.opIndex}`;
      const eventId = await params.cognitionEventRepo.append({
        agentId: params.params.agentId,
        cognitionKey: snapshot.cognitionKey,
        kind: "assertion",
        op: "upsert",
        recordJson: JSON.stringify(verifiedRecord),
        settlementId: verificationSettlementId,
        committedTime: params.now,
        requestId: params.params.requestId,
      });

      if (eventId === null) {
        continue;
      }

      await params.cognitionProjectionRepo.upsertFromEvent({
        id: eventId,
        agent_id: params.params.agentId,
        cognition_key: snapshot.cognitionKey,
        kind: "assertion",
        op: "upsert",
        record_json: JSON.stringify(verifiedRecord),
        settlement_id: verificationSettlementId,
        committed_time: params.now,
        request_id: params.params.requestId ?? null,
        created_at: params.now,
      });

      if (params.searchProjectionRepo) {
        const current = params.cognitionProjectionRepo.getCurrent
          ? await params.cognitionProjectionRepo.getCurrent(
              params.params.agentId,
              snapshot.cognitionKey,
            )
          : null;
        const holderLabel = snapshot.record.holderId?.value ?? "?";
        const entityValues = Array.isArray(snapshot.record.entityRefs)
          ? snapshot.record.entityRefs
              .map((entry) => entry.value)
              .filter((value): value is string => typeof value === "string")
          : [];
        const entitySuffix =
          entityValues.length > 0
            ? ` | entities: ${entityValues.join(", ")}`
            : "";

        await params.searchProjectionRepo.upsertCognitionSearchDoc({
          overlayId: current?.id ?? eventId,
          agentId: params.params.agentId,
          kind: current?.kind ?? "assertion",
          content:
            current?.summary_text ??
            `[${snapshot.cognitionKey}] [${holderLabel}] ${snapshot.record.claim}${entitySuffix}`,
          stance: current?.stance ?? snapshot.record.stance,
          basis: current?.basis ?? basis ?? null,
          sourceRefKind: "assertion",
          now: params.now,
        });
      }
    }

    return outcomesByKey;
  }

  private applyVerificationResultsToRecentSlotJson(
    recentCognitionSlotJson: string,
    verificationByKey: Map<string, AssertionVerificationOutcome>,
  ): string {
    if (verificationByKey.size === 0) {
      return recentCognitionSlotJson;
    }
    const entries = parseRecentCognitionSlotEntries(recentCognitionSlotJson);
    for (const entry of entries) {
      if (entry.kind !== "assertion" || typeof entry.key !== "string") {
        continue;
      }
      const verification = verificationByKey.get(entry.key);
      if (!verification) {
        continue;
      }
      if (verification.basis) {
        entry.basis = verification.basis;
      }
		entry.provenance = verification.provenance;
			entry.groundingVerificationLevel = verification.groundingVerificationLevel;
		}
		return JSON.stringify(entries);
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
