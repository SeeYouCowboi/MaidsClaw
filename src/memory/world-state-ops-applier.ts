import type { TurnSettlementPayload } from "../interaction/contracts.js";
import type { WorldStateOp } from "../runtime/rp-turn-contract.js";
import type { GraphMutableStoreRepo } from "../storage/domain-repos/contracts/graph-mutable-store-repo.js";
import type { UnresolvedWorldStateOpsRepo } from "../storage/domain-repos/contracts/unresolved-world-state-ops-repo.js";

type ViewerSnapshot = TurnSettlementPayload["viewerSnapshot"];

type GraphStoreRepoForWorldStateOps = Pick<
  GraphMutableStoreRepo,
  | "resolveEntityByPointerKey"
  | "createWorldStateFactEdge"
  | "upsertEntity"
>;

type UnresolvedOpsRepoForWorldStateOps = Pick<
  UnresolvedWorldStateOpsRepo,
  "enqueueOp"
>;

type ResolveResult =
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

async function ensureSyntheticAgentEntity(
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

async function resolveEntityRef(params: {
  ref: WorldStateOp["subject"] | WorldStateOp["object"];
  viewerSnapshot: ViewerSnapshot | undefined;
  agentId: string;
  graphStoreRepo: GraphStoreRepoForWorldStateOps;
  settlementId: string;
  opIndex: number;
  endpoint: "subject" | "object";
}): Promise<ResolveResult> {
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
        resolveEntityRef({
          ref: op.subject,
          viewerSnapshot: params.viewerSnapshot,
          agentId: params.agentId,
          graphStoreRepo: params.graphStoreRepo,
          settlementId: params.settlementId,
          opIndex,
          endpoint: "subject",
        }),
        resolveEntityRef({
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
          ownerAgentId: params.agentId,
          sourceKind: "settlement",
          sourceRef: `${params.settlementId}:${opIndex}`,
          tValid: params.settledAt ?? Date.now(),
          contradictedFactEdgeIds: op.contradictedFactEdgeIds,
        });
        writtenOps += 1;
        continue;
      }

      const hasSpecialUnresolved =
        (!subject.ok && subject.kind === "special_unresolved") ||
        (!object.ok && object.kind === "special_unresolved");

      if (hasSpecialUnresolved) {
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
