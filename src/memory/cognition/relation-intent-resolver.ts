import { MaidsClawError } from "../../core/errors.js";
import type { CanonicalRpTurnOutcome, CognitionKind, ConflictFactor, RelationIntent } from "../../runtime/rp-turn-contract.js";
import { parseGraphNodeRef } from "../contracts/graph-node-ref.js";
import type { RelationWriteRepo } from "../../storage/domain-repos/contracts/relation-write-repo.js";
import type { CognitionProjectionRepo } from "../../storage/domain-repos/contracts/cognition-projection-repo.js";

type LocalRefKind = "episode" | "publication" | "cognition" | "proposal";

/**
 * Strip common prefixes the model adds to refs.
 * "episode:door_evidence" → "door_evidence", "cognition:trust/player" → "trust/player"
 */
function stripRefPrefix(ref: string): string {
  if (ref.startsWith("episode:")) return ref.slice("episode:".length);
  if (ref.startsWith("cognition:")) return ref.slice("cognition:".length);
  if (ref.startsWith("publication:")) return ref.slice("publication:".length);
  return ref;
}

type ResolvedEndpoint = {
  kind: LocalRefKind | "assertion" | "evaluation" | "commitment";
  nodeRef: string;
  origin: "local_ref" | "cognition_key";
};

export type SettledArtifacts = {
  settlementId: string;
  agentId: string;
  localRefIndex: Map<string, { kind: LocalRefKind; nodeRef: string }>;
  cognitionByKey: Map<string, { kind: CognitionKind; nodeRef: string }>;
};

export type ResolvedLocalRefs = {
  settlementId: string;
  agentId: string;
  localRefIndex: Map<string, { kind: LocalRefKind; nodeRef: string }>;
  cognitionByKey: Map<string, { kind: CognitionKind; nodeRef: string }>;
};

type MaterializableIntent = {
  intent: "supports" | "triggered";
  source: ResolvedEndpoint;
  target: ResolvedEndpoint;
};

export type ResolvedConflictFactor = {
  kind: string;
  ref: string;
  note?: string;
  nodeRef: string;
};

export type UnresolvedConflictFactor = {
  factor: ConflictFactor;
  reason: string;
};

type ResolveConflictFactorOptions = {
  settledRefs?: ResolvedLocalRefs;
  settlementId?: string;
  agentId?: string;
};

const ALLOWED_INTENTS = new Set(["supports", "triggered"]);
const COGNITION_KEY_PREFIX = "cognition_key" + ":";

export function prevalidateRelationIntents(outcome: CanonicalRpTurnOutcome): void {
  if (!outcome.relationIntents || outcome.relationIntents.length === 0) {
    return;
  }

  const localRefKinds = new Map<string, LocalRefKind>();
  for (const episode of outcome.privateEpisodes) {
    if (episode.localRef) {
      localRefKinds.set(episode.localRef, "episode");
    }
  }
  for (const publication of outcome.publications) {
    if (publication.localRef) {
      localRefKinds.set(publication.localRef, "publication");
    }
  }

  const cognitionKinds = new Map<string, CognitionKind>();
  for (const op of outcome.privateCognition?.ops ?? []) {
    if (op.op === "upsert") {
      cognitionKinds.set(op.record.key, op.record.kind);
    }
  }

  const validIntents: RelationIntent[] = [];
  for (const intent of outcome.relationIntents) {
    if (!ALLOWED_INTENTS.has(intent.intent)) {
      continue;
    }
    // Strip prefixes: model often writes "episode:foo" instead of just "foo"
    const sourceKey = stripRefPrefix(intent.sourceRef);
    const targetKey = stripRefPrefix(intent.targetRef);
    const sourceKind = localRefKinds.get(sourceKey);
    if (sourceKind !== "episode") {
      continue;
    }

    const targetLocalKind = localRefKinds.get(targetKey);
    const targetCognitionKind = cognitionKinds.get(targetKey);
    if (!targetLocalKind && !targetCognitionKind) {
      continue;
    }

    if (intent.intent === "supports") {
      if (targetCognitionKind === undefined && targetLocalKind !== "cognition") {
        continue;
      }
      validIntents.push(intent);
      continue;
    }

    if (targetCognitionKind !== "evaluation" && targetCognitionKind !== "commitment") {
      continue;
    }
    validIntents.push(intent);
  }
  outcome.relationIntents = validIntents;
}

export function resolveLocalRefs(
  payload: {
    relationIntents?: RelationIntent[];
    conflictFactors?: ConflictFactor[];
  },
  settledArtifacts: SettledArtifacts,
): ResolvedLocalRefs {
  const requiredLocalRefs = new Set<string>();
  for (const intent of payload.relationIntents ?? []) {
    requiredLocalRefs.add(intent.sourceRef);
    requiredLocalRefs.add(intent.targetRef);
  }
  for (const factor of payload.conflictFactors ?? []) {
    requiredLocalRefs.add(factor.ref);
  }

  return {
    settlementId: settledArtifacts.settlementId,
    agentId: settledArtifacts.agentId,
    localRefIndex: settledArtifacts.localRefIndex,
    cognitionByKey: settledArtifacts.cognitionByKey,
  };
}

export function validateRelationIntents(
  intents: RelationIntent[],
  resolvedRefs: ResolvedLocalRefs,
): MaterializableIntent[] {
  const materializable: MaterializableIntent[] = [];

  for (const intent of intents) {
    if (!ALLOWED_INTENTS.has(intent.intent)) {
      throw new MaidsClawError({
        code: "TOOL_ARGUMENT_INVALID",
        message: `unsupported relation intent: ${intent.intent}`,
        retriable: false,
        details: { intent },
      });
    }

    const source = resolveIntentRef(intent.sourceRef, resolvedRefs);
    const target = resolveIntentRef(intent.targetRef, resolvedRefs);

    if (source.kind !== "episode") {
      throw new MaidsClawError({
        code: "TOOL_ARGUMENT_INVALID",
        message: `relation source must be episode localRef: ${intent.sourceRef}`,
        retriable: false,
        details: { intent, source },
      });
    }

    if (intent.intent === "supports") {
      if (target.kind !== "assertion" && target.kind !== "evaluation" && target.kind !== "commitment") {
        throw new MaidsClawError({
          code: "TOOL_ARGUMENT_INVALID",
          message: `supports target must resolve to cognition: ${intent.targetRef}`,
          retriable: false,
          details: { intent, target },
        });
      }
      materializable.push({ intent: "supports", source, target });
      continue;
    }

    if (target.kind !== "evaluation" && target.kind !== "commitment") {
      throw new MaidsClawError({
        code: "TOOL_ARGUMENT_INVALID",
        message: `triggered target must resolve to evaluation/commitment: ${intent.targetRef}`,
        retriable: false,
        details: { intent, target },
      });
    }

    materializable.push({ intent: "triggered", source, target });
  }

  return materializable;
}

export async function materializeRelationIntents(
  intents: RelationIntent[],
  resolvedRefs: ResolvedLocalRefs,
  relationWriteRepo: Pick<RelationWriteRepo, "upsertRelation">,
): Promise<number> {
  const validated = validateRelationIntents(intents, resolvedRefs);
  if (validated.length === 0) {
    return 0;
  }

  const now = Date.now();
  let written = 0;
  for (const intent of validated) {
    if (intent.source.nodeRef === intent.target.nodeRef) {
      continue;
    }
    await relationWriteRepo.upsertRelation({
      sourceNodeRef: intent.source.nodeRef,
      targetNodeRef: intent.target.nodeRef,
      relationType: intent.intent,
      sourceKind: "turn",
      sourceRef: resolvedRefs.settlementId,
      strength: 0.8,
      directness: "direct",
      createdAt: now,
      updatedAt: now,
    });
    written += 1;
  }
  return written;
}

export async function resolveConflictFactors(
  factors: ConflictFactor[],
  cognitionProjectionRepo: Pick<CognitionProjectionRepo, "getCurrent">,
  options?: ResolveConflictFactorOptions,
): Promise<{ resolved: ResolvedConflictFactor[]; unresolved: UnresolvedConflictFactor[] }> {
  const resolved: ResolvedConflictFactor[] = [];
  const unresolved: UnresolvedConflictFactor[] = [];

  for (const factor of factors) {
    if (!factor.kind || typeof factor.kind !== "string" || factor.kind.trim().length === 0) {
      console.warn(
        `[settlement_conflict_factor_rejected] reason=missing_kind ref=${factor.ref ?? "(none)"} settlement=${options?.settlementId ?? "unknown"}`,
      );
      unresolved.push({ factor, reason: "missing or empty kind" });
      continue;
    }
    if (!factor.ref || typeof factor.ref !== "string" || factor.ref.trim().length === 0) {
      console.warn(
        `[settlement_conflict_factor_rejected] reason=missing_ref kind=${factor.kind} settlement=${options?.settlementId ?? "unknown"}`,
      );
      unresolved.push({ factor, reason: "missing or empty ref (freetext factor rejected)" });
      continue;
    }

    const nodeRef = await resolveFactorNodeRef(factor.ref, cognitionProjectionRepo, options);
    if (!nodeRef) {
      unresolved.push({ factor, reason: `unresolvable ref: ${factor.ref}` });
      continue;
    }
    resolved.push({
      kind: factor.kind,
      ref: factor.ref,
      ...(factor.note ? { note: factor.note } : {}),
      nodeRef,
    });
  }

  if (unresolved.length > 0) {
    console.warn(
      `[settlement_conflict_factors_dropped] settlement=${options?.settlementId ?? "unknown"} dropped=${unresolved.length} resolved=${resolved.length}`,
    );
  }

  return { resolved, unresolved };
}

function resolveIntentRef(ref: string, resolvedRefs: ResolvedLocalRefs): ResolvedEndpoint {
  // Try raw ref first, then stripped prefix (model often writes "episode:foo" or "cognition:bar")
  const candidates = [ref, stripRefPrefix(ref)];
  for (const candidate of candidates) {
    const localResolved = resolvedRefs.localRefIndex.get(candidate);
    if (localResolved) {
      return {
        kind: localResolved.kind,
        nodeRef: localResolved.nodeRef,
        origin: "local_ref",
      };
    }

    const cognition = resolvedRefs.cognitionByKey.get(candidate);
    if (cognition) {
      return {
        kind: cognition.kind,
        nodeRef: cognition.nodeRef,
        origin: "cognition_key",
      };
    }
  }

  throw new MaidsClawError({
    code: "COGNITION_UNRESOLVED_REFS",
    message: `unresolved localRef/cognitionKey: ${ref}`,
    retriable: false,
    details: { ref },
  });
}

async function resolveFactorNodeRef(
  ref: string,
  cognitionProjectionRepo: Pick<CognitionProjectionRepo, "getCurrent">,
  options?: ResolveConflictFactorOptions,
): Promise<string | null> {
  const candidates = [ref, stripRefPrefix(ref)];
  for (const candidate of candidates) {
    const localResolved = options?.settledRefs?.localRefIndex.get(candidate);
    if (localResolved) {
      return localResolved.nodeRef;
    }

    const cognition = options?.settledRefs?.cognitionByKey.get(candidate);
    if (cognition) {
      return cognition.nodeRef;
    }
  }

  const raw = ref.trim();
  if (raw.startsWith("private_episode:")) {
    return raw;
  }
  try {
    parseGraphNodeRef(raw);
    return raw;
  } catch {
    // not a direct node ref, try cognition key lookup
  }

  const cognitionRef = raw.startsWith(COGNITION_KEY_PREFIX)
    ? raw.slice(COGNITION_KEY_PREFIX.length).trim()
    : raw;
  if (cognitionRef.length === 0) {
    return null;
  }

  const agentId = options?.agentId;
  if (!agentId) {
    return null;
  }

  const record = await cognitionProjectionRepo.getCurrent(agentId, cognitionRef);
  if (!record) {
    return null;
  }

  if (record.kind === "assertion") {
    return `assertion:${record.id}`;
  }
  if (record.kind === "evaluation") {
    return `evaluation:${record.id}`;
  }
  if (record.kind === "commitment") {
    return `commitment:${record.id}`;
  }

  return null;
}
