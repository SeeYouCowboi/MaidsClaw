import type { TurnSettlementPayload } from "../interaction/contracts.js";
import {
  isValidFactEdgePredicate,
  type WorldStateOp,
} from "../runtime/rp-turn-contract.js";
import type { GraphMutableStoreRepo } from "../storage/domain-repos/contracts/graph-mutable-store-repo.js";
import type { UnresolvedWorldStateOpsRepo } from "../storage/domain-repos/contracts/unresolved-world-state-ops-repo.js";
import type { WorldStateOpProcessor } from "./world-state-op-triage.js";

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

/**
 * Optional alias-based resolver. Receives a raw value (which may lack a typed
 * prefix like `item:` / `char:` or be a surface form like "金表" rather than
 * the canonical "item:金怀表") and returns the canonical entity_nodes.id, or
 * null when no mapping exists. Backed by `aliasRepo.resolveAlias` which checks
 * `entity_aliases` first and falls back to direct `entity_nodes.pointer_key`
 * lookup with case-insensitive match.
 */
export type WorldStateAliasResolver = (
  value: string,
  agentId: string,
) => Promise<number | null>;

/**
 * Optional last-resort LLM fallback. Invoked only when both the direct
 * pointer_key lookup AND the alias resolver have returned null. Receives the
 * unknown pointer_key plus the worldStateOp context (factText, predicate,
 * endpoint role) and returns a canonical pointer_key string from the catalog,
 * or null when no confident match exists. The applier then re-tries direct
 * resolution with the returned canonical key. Designed for lazy invocation —
 * happy-path resolves never call this.
 */
export type WorldStatePointerKeyFormatFixer = (params: {
  unknownPointerKey: string;
  agentId: string;
  factText: string;
  predicate: string;
  endpoint: "subject" | "object";
}) => Promise<string | null>;

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
  /**
   * Optional alias-based fallback resolver, tried before enqueue-on-failure.
   * When omitted, behavior matches the legacy strict pointer_key-only path.
   */
  aliasResolver?: WorldStateAliasResolver;
  /**
   * Optional LLM-based last-resort fixer, invoked only after the alias
   * resolver also fails. When omitted, the applier proceeds straight to
   * enqueue-on-failure once the alias resolver returns null.
   */
  pointerKeyFormatFixer?: WorldStatePointerKeyFormatFixer;
  /**
   * Optional schema-parser-driven processor. When supplied, the applier
   * delegates the entire validate → triage → regenerate pipeline to it
   * and writes the resolved fact_edge using the processor's pre-resolved
   * subject/object entity ids. Takes priority over `aliasResolver` and
   * `pointerKeyFormatFixer`; when both are present the legacy callbacks
   * are still used inside the processor's validator (via the resolver
   * closure constructed at the bootstrap site).
   */
  worldStateOpProcessor?: WorldStateOpProcessor;
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
  aliasResolver?: WorldStateAliasResolver;
  pointerKeyFormatFixer?: WorldStatePointerKeyFormatFixer;
  factText?: string;
  predicate?: string;
}): Promise<WorldStateEntityResolveResult> {
  const {
    ref,
    viewerSnapshot,
    agentId,
    graphStoreRepo,
    settlementId,
    opIndex,
    endpoint,
    aliasResolver,
    pointerKeyFormatFixer,
    factText,
    predicate,
  } = params;

  if (ref.kind === "pointer_key") {
    const pointerKey = ref.value.normalize("NFC");

    // 1. Direct pointer_key lookup (the happy path).
    const resolved = await graphStoreRepo.resolveEntityByPointerKey(
      pointerKey,
      agentId,
    );
    if (resolved !== null) {
      return { ok: true, entityId: resolved };
    }

    // 2. Hardcoded prefix rewrites for known model malformations.
    //    Talker/thinker sometimes emits `self:rp:mei` (a synthetic prefix
    //    invented by the model) when it means the agent's own synthetic
    //    entity, which the catalog stores under `__agent__:<agentId>`.
    if (pointerKey.startsWith("self:")) {
      const rewritten = `__agent__:${agentId}`;
      const rewrittenResolved = await graphStoreRepo.resolveEntityByPointerKey(
        rewritten,
        agentId,
      );
      if (rewrittenResolved !== null) {
        return { ok: true, entityId: rewrittenResolved };
      }
    }

    // 3. Alias-table fallback. resolveAlias hits entity_aliases first
    //    (case-insensitive), then falls back to entity_nodes.pointer_key.
    //    Catches unprefixed surface forms ("管家", "alice") that map to a
    //    canonical entity ("char:管家", "char:alice"), and aliases registered
    //    by the entity-judge sweeper for synonyms ("银表" → "item:银怀表").
    if (aliasResolver) {
      try {
        const aliasResolved = await aliasResolver(pointerKey, agentId);
        if (aliasResolved !== null) {
          return { ok: true, entityId: aliasResolved };
        }
      } catch (err) {
        console.warn(
          `[world-state-ops] aliasResolver threw for pointerKey=${pointerKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 4. LLM last-resort fixer. Only triggered when the prior steps all
    //    miss — typically once per failed op rather than per-turn.
    if (pointerKeyFormatFixer) {
      try {
        const canonical = await pointerKeyFormatFixer({
          unknownPointerKey: pointerKey,
          agentId,
          factText: factText ?? "",
          predicate: predicate ?? "",
          endpoint,
        });
        if (canonical && canonical !== pointerKey) {
          const fixedResolved = await graphStoreRepo.resolveEntityByPointerKey(
            canonical.normalize("NFC"),
            agentId,
          );
          if (fixedResolved !== null) {
            return { ok: true, entityId: fixedResolved };
          }
          // The LLM proposed a key the catalog doesn't actually have.
          // Try the alias resolver one more time on the proposed canonical
          // (covers cases where the LLM returns an alias rather than the
          // canonical pointer_key — surprisingly common with shorter forms).
          if (aliasResolver) {
            const aliasFixed = await aliasResolver(canonical, agentId);
            if (aliasFixed !== null) {
              return { ok: true, entityId: aliasFixed };
            }
          }
        }
      } catch (err) {
        console.warn(
          `[world-state-ops] pointerKeyFormatFixer threw for pointerKey=${pointerKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      ok: false,
      kind: "pointer_unresolved",
      pointerKey,
      warning: `[world-state-ops] unresolved pointer_key ${endpoint} ref skipped for enqueue: settlement=${settlementId} opIndex=${opIndex} pointerKey=${pointerKey}`,
    };
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

  // Build the resolvePointerKey closure used both by the new processor's
  // validator and (when the processor is absent) by the legacy per-ref
  // resolver path. Layers direct entity_nodes lookup → alias-table fallback
  // → hardcoded `self:<agent>` rewrite, all behind one async function.
  const resolvePointerKeyForValidator = async (
    pk: string,
    agentId: string,
  ): Promise<number | null> => {
    const direct = await params.graphStoreRepo.resolveEntityByPointerKey(
      pk,
      agentId,
    );
    if (direct !== null) return direct;
    if (pk.startsWith("self:")) {
      const rewritten = `__agent__:${agentId}`;
      const id = await params.graphStoreRepo.resolveEntityByPointerKey(
        rewritten,
        agentId,
      );
      if (id !== null) return id;
    }
    if (params.aliasResolver) {
      try {
        const aliased = await params.aliasResolver(pk, agentId);
        if (aliased !== null) return aliased;
      } catch (err) {
        console.warn(
          `[world-state-ops] aliasResolver threw inside processor for "${pk}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return null;
  };

  const ensureSyntheticAgentForValidator = async (agentId: string) =>
    ensureSyntheticAgentEntity(params.graphStoreRepo, agentId);

  for (let opIndex = 0; opIndex < normalizedOps.length; opIndex += 1) {
    const op = normalizedOps[opIndex];
    try {
      // ── New schema-parser-driven path ────────────────────────────
      // When a worldStateOpProcessor is provided, delegate the entire
      // validate → triage → regenerate pipeline to it. The processor's
      // validator has already resolved subject/object entity ids, so
      // we just write fact_edge with those ids OR enqueue with the
      // last attempted op (raw or LLM-corrected) on failure.
      if (params.worldStateOpProcessor) {
        const result = await params.worldStateOpProcessor(op, {
          agentId: params.agentId,
          sessionId: params.sessionId,
          viewerSnapshot: params.viewerSnapshot,
          resolvePointerKey: resolvePointerKeyForValidator,
          ensureSyntheticAgent: ensureSyntheticAgentForValidator,
        });

        if (result.ok) {
          const v = result.validated;
          await params.graphStoreRepo.createWorldStateFactEdge({
            sourceEntityId: v.subjectEntityId,
            targetEntityId: v.objectEntityId,
            predicate: v.op.predicate,
            factText: v.op.factText,
            ownerAgentId:
              v.op.visibility === "shared_public" ? null : params.agentId,
            sourceKind: "settlement",
            sourceRef: `${params.settlementId}:${opIndex}`,
            tValid: params.settledAt ?? Date.now(),
            contradictedFactEdgeIds: v.op.contradictedFactEdgeIds,
          });
          writtenOps += 1;
          if (result.path !== "first_pass") {
            console.log(
              `[world-state-ops] op ingested via ${result.path}: settlement=${params.settlementId} opIndex=${opIndex}`,
            );
          }
          continue;
        }

        // Processor said no. Drop on triage_drop / second_validation_failed
        // when a regenerate cycle already consumed an LLM call. Only enqueue
        // raw input when the failure was unresolved_pointer + no LLM repair
        // attempt — those have a real chance of being fixed by a later
        // entity-judge sweep.
        const onlyUnresolvedPointer = result.lastErrors.every(
          (e) => e.code === "unresolved_pointer",
        );
        if (
          onlyUnresolvedPointer &&
          (result.reason.startsWith("triage_drop") === false ||
            result.reason === "triage_drop:")
        ) {
          // Defensive: if triage explicitly chose drop, honor it.
        }
        if (
          result.reason.startsWith("triage_drop") ||
          result.reason.startsWith("second_validation_failed_after_") ||
          result.reason.startsWith("regenerate_returned_null") ||
          result.reason.startsWith("fix_in_place_returned_null")
        ) {
          console.warn(
            `[world-state-ops] op dropped (${result.reason}): settlement=${params.settlementId} opIndex=${opIndex}`,
          );
          skippedOps += 1;
          continue;
        }
        // Fallback: enqueue the raw op so a future sweep can revisit.
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
        console.warn(
          `[world-state-ops] op enqueued (${result.reason}): settlement=${params.settlementId} opIndex=${opIndex}`,
        );
        continue;
      }

      // ── Legacy per-ref path (no processor configured) ───────────
      if (!isValidFactEdgePredicate(op.predicate)) {
        console.warn(
          `[world-state-ops] invalid fact_edge predicate skipped: settlement=${params.settlementId} opIndex=${opIndex} predicate=${op.predicate}`,
        );
        skippedOps += 1;
        continue;
      }

      const [subject, object] = await Promise.all([
        resolveWorldStateEntityRef({
          ref: op.subject,
          viewerSnapshot: params.viewerSnapshot,
          agentId: params.agentId,
          graphStoreRepo: params.graphStoreRepo,
          settlementId: params.settlementId,
          opIndex,
          endpoint: "subject",
          aliasResolver: params.aliasResolver,
          pointerKeyFormatFixer: params.pointerKeyFormatFixer,
          factText: op.factText,
          predicate: op.predicate,
        }),
        resolveWorldStateEntityRef({
          ref: op.object,
          viewerSnapshot: params.viewerSnapshot,
          agentId: params.agentId,
          graphStoreRepo: params.graphStoreRepo,
          settlementId: params.settlementId,
          opIndex,
          endpoint: "object",
          aliasResolver: params.aliasResolver,
          pointerKeyFormatFixer: params.pointerKeyFormatFixer,
          factText: op.factText,
          predicate: op.predicate,
        }),
      ]);

      if (subject.ok && object.ok) {
        if (op.predicate === "same_as") {
          // same_as is semantic fact data only; it must not auto-mutate
          // entity_aliases or trigger alias merges.
        }
        if (op.predicate === "contrasts_with") {
          // contrasts_with is retrieval downweight-only signal data, never a
          // hard exclusion rule.
        }

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
