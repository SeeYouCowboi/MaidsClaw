import type { WorldStateOp } from "../runtime/rp-turn-contract.js";
import type { GraphMutableStoreRepo } from "../storage/domain-repos/contracts/graph-mutable-store-repo.js";
import {
  DEAD_LETTER_THRESHOLD,
  type UnresolvedWorldStateOp,
  type UnresolvedWorldStateOpsRepo,
} from "../storage/domain-repos/contracts/unresolved-world-state-ops-repo.js";
import {
  resolveWorldStateEntityRef,
  type WorldStateOpsViewerSnapshot,
} from "./world-state-ops-applier.js";

type GraphStoreRepoForReplay = Pick<
  GraphMutableStoreRepo,
  "resolveEntityByPointerKey" | "createWorldStateFactEdge" | "upsertEntity"
>;

type UnresolvedOpsRepoForReplay = Pick<
  UnresolvedWorldStateOpsRepo,
  "listPending" | "markResolved" | "incrementRetry" | "markDeadLetter"
>;

export type ReplayUnresolvedWorldStateOpsOptions = {
  graphStoreRepo: GraphStoreRepoForReplay;
  unresolvedOpsRepo: UnresolvedOpsRepoForReplay;
  viewerSnapshot?: WorldStateOpsViewerSnapshot;
  limit?: number;
  now?: () => number;
};

export type ReplayUnresolvedWorldStateOpsResult = {
  replayed: number;
  stillPending: number;
  deadLettered: number;
};

function getRetryCount(row: UnresolvedWorldStateOp): number {
  return typeof row.payload.retryCount === "number" ? row.payload.retryCount : 0;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function buildUnresolvedReason(params: {
  row: UnresolvedWorldStateOp;
  subjectWarning?: string;
  objectWarning?: string;
}): string {
  const details = [params.subjectWarning, params.objectWarning]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" | ");
  return (
    details ||
    `[world-state-ops] unresolved refs for queued replay: settlement=${params.row.settlementId} opIndex=${params.row.opIndex}`
  );
}

function isLegacyRetractOp(op: WorldStateOp): boolean {
  return (op as { op?: unknown }).op === "retract";
}

export async function replayUnresolvedWorldStateOps(
  agentId: string,
  opts: ReplayUnresolvedWorldStateOpsOptions,
): Promise<ReplayUnresolvedWorldStateOpsResult> {
  const now = opts.now ?? Date.now;
  const pending = await opts.unresolvedOpsRepo.listPending({
    agentId,
    ...(typeof opts.limit === "number" && opts.limit > 0
      ? { limit: opts.limit }
      : {}),
  });

  let replayed = 0;
  let stillPending = 0;
  let deadLettered = 0;

  for (const row of pending) {
    const retryCount = getRetryCount(row);
    const op = row.payload.op;

    if (retryCount >= DEAD_LETTER_THRESHOLD) {
      await opts.unresolvedOpsRepo.markDeadLetter(
        row.id,
        `[world-state-ops] dead-lettered before replay attempt: retryCount=${retryCount} threshold=${DEAD_LETTER_THRESHOLD}`,
      );
      deadLettered += 1;
      continue;
    }

    if (isLegacyRetractOp(op)) {
      console.warn(
        `[world-state-ops] queued retract op is unsupported in MVP; skipping: settlement=${row.settlementId} opIndex=${row.opIndex}`,
      );
      await opts.unresolvedOpsRepo.markResolved(row.id);
      continue;
    }

    try {
      const [subject, object] = await Promise.all([
        resolveWorldStateEntityRef({
          ref: op.subject,
          viewerSnapshot: opts.viewerSnapshot,
          agentId,
          graphStoreRepo: opts.graphStoreRepo,
          settlementId: row.settlementId,
          opIndex: row.opIndex,
          endpoint: "subject",
        }),
        resolveWorldStateEntityRef({
          ref: op.object,
          viewerSnapshot: opts.viewerSnapshot,
          agentId,
          graphStoreRepo: opts.graphStoreRepo,
          settlementId: row.settlementId,
          opIndex: row.opIndex,
          endpoint: "object",
        }),
      ]);

      if (subject.ok && object.ok) {
        const rowAgentId = asNonEmptyString(row.payload.agentId) ?? agentId;
        const tValid =
          typeof op.validTime === "number" && Number.isFinite(op.validTime)
            ? op.validTime
            : typeof row.payload.turnTimestamp === "number" &&
                Number.isFinite(row.payload.turnTimestamp)
              ? row.payload.turnTimestamp
              : now();

        await opts.graphStoreRepo.createWorldStateFactEdge({
          sourceEntityId: subject.entityId,
          targetEntityId: object.entityId,
          predicate: op.predicate,
          factText: op.factText,
          ownerAgentId: rowAgentId,
          sourceKind: "settlement",
          sourceRef: `${row.settlementId}:${row.opIndex}`,
          tValid,
          contradictedFactEdgeIds: op.contradictedFactEdgeIds,
        });
        await opts.unresolvedOpsRepo.markResolved(row.id);
        replayed += 1;
        continue;
      }

      const unresolvedReason = buildUnresolvedReason({
        row,
        subjectWarning: subject.ok ? undefined : subject.warning,
        objectWarning: object.ok ? undefined : object.warning,
      });
      await opts.unresolvedOpsRepo.incrementRetry(row.id, unresolvedReason);
      stillPending += 1;
    } catch (error) {
      const failure = `[world-state-ops] replay failed for settlement=${row.settlementId} opIndex=${row.opIndex}: ${formatFailure(error)}`;
      await opts.unresolvedOpsRepo.incrementRetry(row.id, failure);
      stillPending += 1;
    }
  }

  return { replayed, stillPending, deadLettered };
}
