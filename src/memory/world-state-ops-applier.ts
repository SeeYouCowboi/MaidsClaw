import type { TurnSettlementPayload } from "../interaction/contracts.js";
import type { WorldStateOp } from "../runtime/rp-turn-contract.js";
import type { GraphMutableStoreRepo } from "../storage/domain-repos/contracts/graph-mutable-store-repo.js";
import type { UnresolvedWorldStateOpsRepo } from "../storage/domain-repos/contracts/unresolved-world-state-ops-repo.js";

// Internal viewer snapshot shape used during world-state op resolution.
// Each field is optional individually so callers can supply only what they
// have without losing the rest. The strict Talker-emitted TurnSettlementPayload
// shape is a structural subtype of this.
export type WorldStateOpsViewerSnapshot = {
  selfPointerKey?: string;
  userPointerKey?: string;
  currentLocationEntityId?: number;
};

type ViewerSnapshot = WorldStateOpsViewerSnapshot;
// Re-export the original Talker payload type for callers that already have
// the strict shape; the applier accepts both.
export type TurnSettlementViewerSnapshot = TurnSettlementPayload["viewerSnapshot"];

export type GraphStoreRepoForWorldStateOps = Pick<
  GraphMutableStoreRepo,
  | "resolveEntityByPointerKey"
  | "createWorldStateFactEdge"
  | "upsertEntity"
>;

type UnresolvedOpsRepoForWorldStateOps = Pick<
  UnresolvedWorldStateOpsRepo,
  "enqueueOp"
>;

export type WorldStateEntityResolveResult =
  | {
      ok: true;
      entityId: number;
    }
  | {
      ok: false;
      kind: "pointer_unresolved" | "special_unresolved";
      pointerKey?: string;
      warning: string;
    };

export type ApplyWorldStateOpsForSettlementParams = {
  settlementId: string;
  sessionId: string;
  agentId: string;
  settlementPayload?: Pick<TurnSettlementPayload, "worldStateOps">;
  worldStateOps?: WorldStateOp[];
  viewerSnapshot?: ViewerSnapshot;
  graphStoreRepo: GraphStoreRepoForWorldStateOps;
  unresolvedOpsRepo: UnresolvedOpsRepoForWorldStateOps;
  settledAt?: number;
};

export type ApplyWorldStateOpsForSettlementResult = {
  disabled: boolean;
  processedOps: number;
  writtenOps: number;
  enqueuedOps: number;
  skippedOps: number;
  failedOps: number;
};

export function isWorldStateOpsProcessingEnabled(): boolean {
  return process.env.MAIDSCLAW_WORLDSTATE_OPS_ENABLED !== "0";
}

export async function ensureSyntheticAgentEntity(
  graphStoreRepo: GraphStoreRepoForWorldStateOps,
  agentId: string,
): Promise<number> {
  const withPrivateMethod = graphStoreRepo as GraphStoreRepoForWorldStateOps & {
    ensureSyntheticAgentEntity?: (id: string) => Promise<number>;
  };
  if (typeof withPrivateMethod.ensureSyntheticAgentEntity === "function") {
    return withPrivateMethod.ensureSyntheticAgentEntity(agentId);
  }

  return graphStoreRepo.upsertEntity({
    pointerKey: `__agent__:${agentId}`,
    displayName: agentId,
    entityType: "agent",
    memoryScope: "private_overlay",
    ownerAgentId: agentId,
  });
}

export async function resolveWorldStateEntityRef(params: {
  ref: WorldStateOp["subject"] | WorldStateOp["object"];
  viewerSnapshot: ViewerSnapshot | undefined;
  agentId: string;
  graphStoreRepo: GraphStoreRepoForWorldStateOps;
  settlementId: string;
  opIndex: number;
  endpoint: "subject" | "object";
}): Promise<WorldStateEntityResolveResult> {
  const {
    ref,
    viewerSnapshot,
    agentId,
    graphStoreRepo,
    settlementId,
    opIndex,
    endpoint,
  } = params;

  if (ref.kind === "pointer_key") {
    const pointerKey = ref.value.normalize("NFC");
    const resolved = await graphStoreRepo.resolveEntityByPointerKey(
      pointerKey,
      agentId,
    );
    if (resolved === null) {
      return {
        ok: false,
        kind: "pointer_unresolved",
        pointerKey,
        warning: `[world-state-ops] unresolved pointer_key ${endpoint} ref skipped for enqueue: settlement=${settlementId} opIndex=${opIndex} pointerKey=${pointerKey}`,
      };
    }
    return { ok: true, entityId: resolved };
  }

  if (ref.value === "self") {
    const selfPointerKey = viewerSnapshot?.selfPointerKey;
    if (selfPointerKey) {
      const resolved = await graphStoreRepo.resolveEntityByPointerKey(
        selfPointerKey,
        agentId,
      );
      if (resolved !== null) {
        return { ok: true, entityId: resolved };
      }
    }

    const syntheticId = await ensureSyntheticAgentEntity(graphStoreRepo, agentId);
    return { ok: true, entityId: syntheticId };
  }

  if (ref.value === "user") {
    const userPointerKey = viewerSnapshot?.userPointerKey;
    if (!userPointerKey) {
      return {
        ok: false,
        kind: "special_unresolved",
        warning: `[world-state-ops] unresolved special:user skipped (no viewerSnapshot.userPointerKey): settlement=${settlementId} opIndex=${opIndex}`,
      };
    }

    const resolved = await graphStoreRepo.resolveEntityByPointerKey(
      userPointerKey,
      agentId,
    );
    if (resolved === null) {
      return {
        ok: false,
        kind: "special_unresolved",
        warning: `[world-state-ops] unresolved special:user skipped (user pointer key not found): settlement=${settlementId} opIndex=${opIndex} pointerKey=${userPointerKey}`,
      };
    }

    return { ok: true, entityId: resolved };
  }

  const currentLocationEntityId = viewerSnapshot?.currentLocationEntityId;
  if (typeof currentLocationEntityId !== "number") {
    return {
      ok: false,
      kind: "special_unresolved",
      warning: `[world-state-ops] unresolved special:current_location skipped (no viewerSnapshot.currentLocationEntityId): settlement=${settlementId} opIndex=${opIndex}`,
    };
  }
  return { ok: true, entityId: currentLocationEntityId };
}

export async function applyWorldStateOpsForSettlement(
  params: ApplyWorldStateOpsForSettlementParams,
): Promise<ApplyWorldStateOpsForSettlementResult> {
  if (!isWorldStateOpsProcessingEnabled()) {
    return {
      disabled: true,
      processedOps: 0,
      writtenOps: 0,
      enqueuedOps: 0,
      skippedOps: 0,
      failedOps: 0,
    };
  }

  const normalizedOps = Array.isArray(params.worldStateOps)
    ? params.worldStateOps
    : Array.isArray(params.settlementPayload?.worldStateOps)
      ? params.settlementPayload.worldStateOps
      : [];

  if (normalizedOps.length === 0) {
    return {
      disabled: false,
      processedOps: 0,
      writtenOps: 0,
      enqueuedOps: 0,
      skippedOps: 0,
      failedOps: 0,
    };
  }

  let writtenOps = 0;
  let enqueuedOps = 0;
  let skippedOps = 0;
  let failedOps = 0;

  for (let opIndex = 0; opIndex < normalizedOps.length; opIndex += 1) {
    const op = normalizedOps[opIndex];
    try {
      const [subject, object] = await Promise.all([
        resolveWorldStateEntityRef({
          ref: op.subject,
          viewerSnapshot: params.viewerSnapshot,
          agentId: params.agentId,
          graphStoreRepo: params.graphStoreRepo,
          settlementId: params.settlementId,
          opIndex,
          endpoint: "subject",
        }),
        resolveWorldStateEntityRef({
          ref: op.object,
          viewerSnapshot: params.viewerSnapshot,
          agentId: params.agentId,
          graphStoreRepo: params.graphStoreRepo,
          settlementId: params.settlementId,
          opIndex,
          endpoint: "object",
        }),
      ]);

      if (subject.ok && object.ok) {
        await params.graphStoreRepo.createWorldStateFactEdge({
          sourceEntityId: subject.entityId,
          targetEntityId: object.entityId,
          predicate: op.predicate,
          factText: op.factText,
          ownerAgentId: op.visibility === "shared_public" ? null : params.agentId,
          sourceKind: "settlement",
          sourceRef: `${params.settlementId}:${opIndex}`,
          tValid: params.settledAt ?? Date.now(),
          contradictedFactEdgeIds: op.contradictedFactEdgeIds,
        });
        writtenOps += 1;
        continue;
      }

      // Skip-without-enqueue applies only when *every* unresolved endpoint is
      // special_unresolved — a deterministic dead-end the entity-judge sweeper
      // can never fix (special pseudo-entities are never created). When at
      // least one endpoint is pointer_unresolved, enqueue the op so the
      // sweeper has a chance to resolve the resolvable side; if the special
      // endpoint stays dead, the queue's incrementRetry → dead_letter path
      // surfaces it instead of swallowing it silently.
      const subjectPointerUnresolved =
        !subject.ok && subject.kind === "pointer_unresolved";
      const objectPointerUnresolved =
        !object.ok && object.kind === "pointer_unresolved";
      const hasPointerUnresolved =
        subjectPointerUnresolved || objectPointerUnresolved;

      if (!hasPointerUnresolved) {
        if (!subject.ok) {
          console.warn(subject.warning);
        }
        if (!object.ok) {
          console.warn(object.warning);
        }
        skippedOps += 1;
        continue;
      }

      if (!subject.ok) {
        console.warn(subject.warning);
      }
      if (!object.ok) {
        console.warn(object.warning);
      }

      await params.unresolvedOpsRepo.enqueueOp({
        sessionId: params.sessionId,
        settlementId: params.settlementId,
        opIndex,
        agentId: params.agentId,
        op,
        subjectPointerKey:
          op.subject.kind === "pointer_key" ? op.subject.value : undefined,
        objectPointerKey:
          op.object.kind === "pointer_key" ? op.object.value : undefined,
        turnTimestamp: params.settledAt,
      });
      enqueuedOps += 1;
    } catch (error) {
      failedOps += 1;
      console.error(
        `[world-state-ops] failed to process op (non-fatal): settlement=${params.settlementId} opIndex=${opIndex} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    disabled: false,
    processedOps: normalizedOps.length,
    writtenOps,
    enqueuedOps,
    skippedOps,
    failedOps,
  };
}
