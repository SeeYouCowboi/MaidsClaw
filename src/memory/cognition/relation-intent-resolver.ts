import { MaidsClawError } from "../../core/errors.js";
import type { CanonicalRpTurnOutcome, CognitionKind, ConflictFactor, RelationIntent } from "../../runtime/rp-turn-contract.js";
import { parseGraphNodeRef } from "../contracts/graph-node-ref.js";

type DbLike = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
};

type LocalRefKind = "episode" | "publication" | "cognition" | "proposal";

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
    const sourceKind = localRefKinds.get(intent.sourceRef);
    if (sourceKind !== "episode") {
      continue;
    }

    const targetLocalKind = localRefKinds.get(intent.targetRef);
    const targetCognitionKind = cognitionKinds.get(intent.targetRef);
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

export function materializeRelationIntents(
  intents: RelationIntent[],
  resolvedRefs: ResolvedLocalRefs,
  db: DbLike,
): number {
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
    db.prepare(
      `INSERT INTO memory_relations
       (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'direct', 'turn', ?, ?, ?)
       ON CONFLICT(source_node_ref, target_node_ref, relation_type, source_kind, source_ref)
       DO UPDATE SET strength = excluded.strength, updated_at = excluded.updated_at`,
    ).run(
      intent.source.nodeRef,
      intent.target.nodeRef,
      intent.intent,
      0.8,
      resolvedRefs.settlementId,
      now,
      now,
    );
    written += 1;
  }
  return written;
}

export function resolveConflictFactors(
  factors: ConflictFactor[],
  db: DbLike,
  options?: ResolveConflictFactorOptions,
): { resolved: ResolvedConflictFactor[]; unresolved: UnresolvedConflictFactor[] } {
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

    const nodeRef = resolveFactorNodeRef(factor.ref, db, options);
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
  const localResolved = resolvedRefs.localRefIndex.get(ref);
  if (localResolved) {
    return {
      kind: localResolved.kind,
      nodeRef: localResolved.nodeRef,
      origin: "local_ref",
    };
  }

  const cognition = resolvedRefs.cognitionByKey.get(ref);
  if (cognition) {
    return {
      kind: cognition.kind,
      nodeRef: cognition.nodeRef,
      origin: "cognition_key",
    };
  }

  throw new MaidsClawError({
    code: "COGNITION_UNRESOLVED_REFS",
    message: `unresolved localRef/cognitionKey: ${ref}`,
    retriable: false,
    details: { ref },
  });
}

function resolveFactorNodeRef(
  ref: string,
  db: DbLike,
  options?: ResolveConflictFactorOptions,
): string | null {
  const localResolved = options?.settledRefs?.localRefIndex.get(ref);
  if (localResolved) {
    return localResolved.nodeRef;
  }

  const cognition = options?.settledRefs?.cognitionByKey.get(ref);
  if (cognition) {
    return cognition.nodeRef;
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

  const fact = db
    .prepare(
      `SELECT id FROM private_cognition_current WHERE cognition_key = ? AND kind = 'assertion' ${options?.agentId ? "AND agent_id = ?" : ""} LIMIT 1`,
    )
    .get(cognitionRef, ...(options?.agentId ? [options.agentId] : [])) as { id: number } | null;
  if (fact) {
    return `assertion:${fact.id}`;
  }

  const event = db
    .prepare(
      `SELECT id, kind FROM private_cognition_current WHERE cognition_key = ? ${options?.agentId ? "AND agent_id = ?" : ""} LIMIT 1`,
    )
    .get(cognitionRef, ...(options?.agentId ? [options.agentId] : [])) as { id: number; kind: string | null } | null;
  if (event) {
    if (event.kind === "evaluation" || event.kind === "commitment") {
      return `${event.kind}:${event.id}`;
    }
    return null;
  }

  return null;
}
