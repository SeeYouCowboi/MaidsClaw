export type CognitionEntityRef =
  | { kind: "pointer_key"; value: string }
  | { kind: "special"; value: "self" | "user" | "current_location" };

/**
 * @deprecated Retained only for CommitmentRecord.target union type.
 * Will be removed in a follow-up when commitments are migrated to holderId model.
 */
export type EntityProposition = {
  subject: CognitionEntityRef;
  predicate: string;
  object: { kind: "entity"; ref: CognitionEntityRef };
};

export type CognitionKind = "assertion" | "evaluation" | "commitment";

export type CognitionRecordBase = {
  kind: CognitionKind;
  key: string;
  salience?: number;
  provenance?: string;
  ttlTurns?: number;
};

export type CognitionSelector = {
  kind: CognitionKind;
  key: string;
};

export type AssertionStance =
  | "hypothetical"
  | "tentative"
  | "accepted"
  | "confirmed"
  | "contested"
  | "rejected"
  | "abandoned";

export type AssertionBasis =
  | "first_hand"
  | "hearsay"
  | "inference"
  | "introspection"
  | "belief";

export type AssertionRecordV4 = CognitionRecordBase & {
  kind: "assertion";
  /** Who holds this belief — must be a character/agent, not a location or item. */
  holderId: CognitionEntityRef;
  /** Free-text natural language proposition (e.g., "困岛是蓄意为之"). */
  claim: string;
  /** Related entities for retrieval indexing — no implied grammar role. */
  entityRefs: CognitionEntityRef[];
  stance: AssertionStance;
  basis?: AssertionBasis;
  preContestedStance?: AssertionStance;
};

export type EvaluationRecord = CognitionRecordBase & {
  kind: "evaluation";
  target: CognitionEntityRef | CognitionSelector;
  dimensions: Array<{ name: string; value: number }>;
  emotionTags?: string[];
  notes?: string;
};

export type CommitmentRecord = CognitionRecordBase & {
  kind: "commitment";
  mode: "goal" | "intent" | "plan" | "constraint" | "avoidance";
  target: EntityProposition | { action: string; target?: CognitionEntityRef };
  status: "active" | "paused" | "fulfilled" | "abandoned";
  priority?: number;
  horizon?: "immediate" | "near" | "long";
};

export type CognitionRecord =
  | AssertionRecordV4
  | EvaluationRecord
  | CommitmentRecord;

export type CognitionOp =
  | { op: "upsert"; record: CognitionRecord }
  | { op: "retract"; target: CognitionSelector };

export type PrivateCognitionCommitV4 = {
  schemaVersion: "rp_private_cognition_v4";
  localRef?: LocalRef;
  summary?: string;
  ops: CognitionOp[];
};
export type PublicationKindV2 = "spoken" | "written" | "visual";
export type PublicationTargetScope = "current_area" | "world_public";

export type LocalRef = string;

export type RelationIntent = {
  sourceRef: LocalRef;
  targetRef: LocalRef;
  intent: "supports" | "triggered";
};

export type ConflictFactor = {
  kind: string;
  ref: string;
  note?: string;
};

export type PinnedSummaryProposal = {
  proposedText: string;
  rationale?: string;
};

export type PrivateEpisodeArtifact = {
  localRef?: LocalRef;
  category: "speech" | "action" | "observation" | "state_change";
  summary: string;
  privateNotes?: string;
  locationText?: string;
  validTime?: number;
};

export type PublicationDeclaration = {
  localRef?: LocalRef;
  kind: PublicationKindV2;
  targetScope: PublicationTargetScope;
  summary: string;
};

export type RpTurnOutcomeSubmissionV5 = {
  schemaVersion: "rp_turn_outcome_v5";
  publicReply: string;
  latentScratchpad?: string;
  privateCognition?: PrivateCognitionCommitV4;
  privateEpisodes?: PrivateEpisodeArtifact[];
  publications?: PublicationDeclaration[];
  pinnedSummaryProposal?: PinnedSummaryProposal;
  relationIntents?: RelationIntent[];
  conflictFactors?: ConflictFactor[];
};

export type CanonicalRpTurnOutcome = {
  schemaVersion: "rp_turn_outcome_v5";
  publicReply: string;
  latentScratchpad?: string;
  privateCognition?: PrivateCognitionCommitV4;
  privateEpisodes: PrivateEpisodeArtifact[];
  publications: PublicationDeclaration[];
  pinnedSummaryProposal?: PinnedSummaryProposal;
  relationIntents: RelationIntent[];
  conflictFactors: ConflictFactor[];
};

const V4_ASSERTION_STANCES: ReadonlySet<AssertionStance> = new Set([
  "hypothetical",
  "tentative",
  "accepted",
  "confirmed",
  "contested",
  "rejected",
  "abandoned",
]);

/** Stances that can appear as preContestedStance — only forward-progress stances. */
const V4_PRE_CONTESTABLE_STANCES: ReadonlySet<AssertionStance> = new Set([
  "hypothetical",
  "tentative",
  "accepted",
  "confirmed",
]);

const V4_ASSERTION_BASES: ReadonlySet<AssertionBasis> = new Set([
  "first_hand",
  "hearsay",
  "inference",
  "introspection",
  "belief",
]);



export type RpBufferedExecutionResult =
  | { outcome: CanonicalRpTurnOutcome }
  | { error: string };

export function detectOutcomeVersion(raw: unknown): "v5" | "unknown" {
  if (!raw || typeof raw !== "object") return "unknown";
  const schemaVersion = (raw as Record<string, unknown>).schemaVersion;
  if (schemaVersion === "rp_turn_outcome_v5") {
    return "v5";
  }
  if (schemaVersion === "rp_turn_outcome_v3" || schemaVersion === "rp_turn_outcome_v4") {
    throw new Error(`Unsupported schemaVersion: ${JSON.stringify(schemaVersion)} — only rp_turn_outcome_v5 is supported`);
  }
  return "unknown";
}

export function normalizeRpTurnOutcome(raw: unknown): CanonicalRpTurnOutcome {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error("rp_turn_outcome must be a non-null object");
  }

  const obj = raw as Record<string, unknown>;
  if (typeof obj.schemaVersion !== "string" || obj.schemaVersion.trim() === "") {
    throw new Error(
      `schemaVersion must be a non-empty string, got ${JSON.stringify(obj.schemaVersion)}`
    );
  }

  if (obj.schemaVersion !== "rp_turn_outcome_v5") {
    throw new Error(`Unsupported schemaVersion: ${JSON.stringify(obj.schemaVersion)} — only rp_turn_outcome_v5 is supported`);
  }

  if (typeof obj.publicReply !== "string") {
    throw new Error(
      `publicReply must be a string, got ${typeof obj.publicReply}`
    );
  }

  return normalizeV5Submission(obj);
}

export function validateRpTurnOutcome(raw: unknown): CanonicalRpTurnOutcome {
  return normalizeRpTurnOutcome(raw);
}

function normalizeV5Submission(obj: Record<string, unknown>): CanonicalRpTurnOutcome {
  const publicReply = obj.publicReply as string;
  const latentScratchpad = typeof obj.latentScratchpad === "string"
    ? obj.latentScratchpad
    : undefined;

  const privateCognition = normalizePrivateCommit(obj.privateCognition);
  const publications = normalizePublicationsV5(obj.publications);
  const privateEpisodes = normalizePrivateEpisodes(obj.privateEpisodes);
  const pinnedSummaryProposal = normalizePinnedSummaryProposal(obj.pinnedSummaryProposal);
  const relationIntents = normalizeRelationIntents(obj.relationIntents);
  const conflictFactors = normalizeConflictFactors(obj.conflictFactors);

  const hasContent = publicReply !== ""
    || (privateCognition && privateCognition.ops.length > 0)
    || publications.length > 0
    || privateEpisodes.length > 0;

  if (!hasContent) {
    throw new Error(
      "empty turn: publicReply is empty and privateCognition has no ops"
    );
  }

  return {
    schemaVersion: "rp_turn_outcome_v5",
    publicReply,
    ...(latentScratchpad !== undefined ? { latentScratchpad } : {}),
    ...(privateCognition ? { privateCognition } : {}),
    privateEpisodes,
    publications,
    ...(pinnedSummaryProposal ? { pinnedSummaryProposal } : {}),
    relationIntents,
    conflictFactors,
  };
}

/** Single validator for V5 payloads — all shape checks centralized here. */
export function validateRpTurnOutcomeV5(payload: unknown): RpTurnOutcomeSubmissionV5 {
  if (!payload || typeof payload !== "object") {
    throw new Error("payload must be a non-null object");
  }
  const obj = payload as Record<string, unknown>;
  if (obj.schemaVersion !== "rp_turn_outcome_v5") {
    throw new Error(`expected schemaVersion rp_turn_outcome_v5, got ${JSON.stringify(obj.schemaVersion)}`);
  }
  if (typeof obj.publicReply !== "string") {
    throw new Error(`publicReply must be a string, got ${typeof obj.publicReply}`);
  }

  if (obj.publications !== undefined) {
    if (!Array.isArray(obj.publications)) {
      throw new Error("publications must be an array when present");
    }
    for (const pub of obj.publications) {
      if (!pub || typeof pub !== "object") throw new Error("publication must be an object");
      const p = pub as Record<string, unknown>;
      if (!["spoken", "written", "visual"].includes(p.kind as string)) {
        throw new Error(`"${p.kind}" is not a valid canonical publication kind`);
      }
    }
  }

  if (obj.relationIntents !== undefined) {
    if (!Array.isArray(obj.relationIntents)) {
      throw new Error("relationIntents must be an array when present");
    }
    const ALLOWED_INTENTS = new Set(["supports", "triggered"]);
    for (const ri of obj.relationIntents) {
      if (!ri || typeof ri !== "object") throw new Error("relationIntent must be an object");
      const r = ri as Record<string, unknown>;
      if (!ALLOWED_INTENTS.has(r.intent as string)) {
        throw new Error(`invalid relationIntent intent: ${JSON.stringify(r.intent)}, allowed: supports, triggered`);
      }
    }
  }

  if (obj.conflictFactors !== undefined) {
    if (!Array.isArray(obj.conflictFactors)) {
      throw new Error("conflictFactors must be an array when present");
    }
    for (const cf of obj.conflictFactors) {
      if (!cf || typeof cf !== "object") throw new Error("conflictFactor must be an object");
      const c = cf as Record<string, unknown>;
      if (typeof c.note === "string" && c.note.length > 120) {
        throw new Error(`conflictFactor note exceeds 120 chars (got ${c.note.length})`);
      }
    }
  }

  if (obj.pinnedSummaryProposal !== undefined) {
    if (Array.isArray(obj.pinnedSummaryProposal)) {
      throw new Error("pinnedSummaryProposal must be a single object, not an array");
    }
    if (typeof obj.pinnedSummaryProposal !== "object") {
      throw new Error("pinnedSummaryProposal must be an object");
    }
  }

  if (obj.privateEpisodes !== undefined) {
    if (!Array.isArray(obj.privateEpisodes)) {
      throw new Error("privateEpisodes must be an array when present");
    }
    for (const ep of obj.privateEpisodes) {
      if (!ep || typeof ep !== "object") throw new Error("privateEpisode must be an object");
    }
  }

  return obj as unknown as RpTurnOutcomeSubmissionV5;
}

export function normalizeToCanonicalOutcome(
  submission: RpTurnOutcomeSubmissionV5,
): CanonicalRpTurnOutcome {
  return normalizeRpTurnOutcome(submission);
}

const V5_PUBLICATION_KINDS: ReadonlySet<string> = new Set(["spoken", "written", "visual"]);

function normalizePublicationsV5(raw: unknown): PublicationDeclaration[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("publications must be an array when present");
  }
  const VALID_TARGET_SCOPES = new Set<PublicationTargetScope>(["current_area", "world_public"]);
  const publications: PublicationDeclaration[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new Error("publication must be an object");
    }
    const publication = entry as Record<string, unknown>;
    const kind = publication.kind as string;
    if (!V5_PUBLICATION_KINDS.has(kind)) {
      throw new Error(`invalid publication kind: ${JSON.stringify(publication.kind)}`);
    }
    if (!VALID_TARGET_SCOPES.has(publication.targetScope as PublicationTargetScope)) {
      throw new Error(`invalid publication targetScope: ${JSON.stringify(publication.targetScope)}`);
    }
    if (typeof publication.summary !== "string") {
      throw new Error("publication summary must be a string");
    }
    publications.push({
      ...(typeof publication.localRef === "string" ? { localRef: publication.localRef } : {}),
      kind: kind as PublicationKindV2,
      targetScope: publication.targetScope as PublicationTargetScope,
      summary: publication.summary,
    });
  }
  return publications;
}

function normalizePrivateEpisodes(raw: unknown): PrivateEpisodeArtifact[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("privateEpisodes must be an array when present");
  }
  const VALID_CATEGORIES = new Set(["speech", "action", "observation", "state_change"]);
  const episodes: PrivateEpisodeArtifact[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new Error("privateEpisode must be an object");
    }
    const ep = entry as Record<string, unknown>;
    if (!VALID_CATEGORIES.has(ep.category as string)) {
      throw new Error(`invalid privateEpisode category: ${JSON.stringify(ep.category)}`);
    }
    if (typeof ep.summary !== "string") {
      throw new Error("privateEpisode summary must be a string");
    }
    episodes.push({
      ...(typeof ep.localRef === "string" ? { localRef: ep.localRef } : {}),
      category: ep.category as PrivateEpisodeArtifact["category"],
      summary: ep.summary,
      ...(typeof ep.privateNotes === "string" ? { privateNotes: ep.privateNotes } : {}),
      ...(typeof ep.locationText === "string" ? { locationText: ep.locationText } : {}),
      ...(typeof ep.validTime === "number" ? { validTime: ep.validTime } : {}),
    });
  }
  return episodes;
}

function normalizePinnedSummaryProposal(raw: unknown): PinnedSummaryProposal | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (Array.isArray(raw)) {
    throw new Error("pinnedSummaryProposal must be a single object, not an array");
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("pinnedSummaryProposal must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.proposedText !== "string") {
    throw new Error("pinnedSummaryProposal.proposedText must be a string");
  }
  return {
    proposedText: obj.proposedText,
    ...(typeof obj.rationale === "string" ? { rationale: obj.rationale } : {}),
  };
}

function normalizeRelationIntents(raw: unknown): RelationIntent[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("relationIntents must be an array when present");
  }
  const ALLOWED_INTENTS = new Set(["supports", "triggered"]);
  const intents: RelationIntent[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new Error("relationIntent must be an object");
    }
    const ri = entry as Record<string, unknown>;
    if (!ALLOWED_INTENTS.has(ri.intent as string)) {
      throw new Error(`invalid relationIntent intent: ${JSON.stringify(ri.intent)}, allowed: supports, triggered`);
    }
    if (typeof ri.sourceRef !== "string") {
      throw new Error("relationIntent sourceRef must be a string");
    }
    if (typeof ri.targetRef !== "string") {
      throw new Error("relationIntent targetRef must be a string");
    }
    intents.push({
      sourceRef: ri.sourceRef,
      targetRef: ri.targetRef,
      intent: ri.intent as RelationIntent["intent"],
    });
  }
  return intents;
}

function normalizeConflictFactors(raw: unknown): ConflictFactor[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("conflictFactors must be an array when present");
  }
  const factors: ConflictFactor[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new Error("conflictFactor must be an object");
    }
    const cf = entry as Record<string, unknown>;
    if (typeof cf.kind !== "string") {
      throw new Error("conflictFactor kind must be a string");
    }
    if (typeof cf.ref !== "string") {
      throw new Error("conflictFactor ref must be a string");
    }
    if (typeof cf.note === "string" && cf.note.length > 120) {
      throw new Error(`conflictFactor note exceeds 120 chars (got ${cf.note.length})`);
    }
    factors.push({
      kind: cf.kind,
      ref: cf.ref,
      ...(typeof cf.note === "string" ? { note: cf.note } : {}),
    });
  }
  return factors;
}

function normalizePrivateCommit(raw: unknown): PrivateCognitionCommitV4 | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (raw === null || typeof raw !== "object") {
    throw new Error("privateCognition must be an object if present");
  }

  const commit = raw as Record<string, unknown>;
  if (!Array.isArray(commit.ops)) {
    throw new Error("privateCognition.ops must be an array");
  }

  const normalizedOps: CognitionOp[] = [];
  for (const op of commit.ops as Array<Record<string, unknown>>) {
    try {
      if (op.op === "upsert") {
        const record = op.record as Record<string, unknown> | undefined;
        if (!record || typeof record !== "object") {
          throw new Error("upsert op must have a record object");
        }
        if (typeof record.key !== "string" || record.key.trim() === "") {
          throw new Error("upsert record.key must be a non-empty string");
        }
        if (record.kind === "assertion") {
          normalizeAssertionRecord(record);
        }
        normalizedOps.push({ op: "upsert", record: record as CognitionRecord });
        continue;
      }

      if (op.op === "retract") {
        const target = op.target as Record<string, unknown> | undefined;
        if (!target || typeof target.key !== "string" || target.key.trim() === "") {
          throw new Error("retract target.key must be a non-empty string");
        }
        normalizedOps.push({ op: "retract", target: target as CognitionSelector });
        continue;
      }

      // Unknown op type — skip gracefully instead of killing the turn
      continue;
    } catch (opError) {
      // Graceful degradation: skip malformed ops, preserve valid ones + publicReply.
      // A single bad cognition op should never kill the entire RP turn.
      const key = typeof op.record === "object" && op.record !== null
        ? (op.record as Record<string, unknown>).key ?? "?"
        : "?";
      console.warn(
        `[rp-turn-contract] skipping malformed cognition op (key=${key}): ${opError instanceof Error ? opError.message : String(opError)}`,
      );
      continue;
    }
  }

    // Pre-insert dedup: keep last occurrence for same (cognition_key, op) pair
  const dedupedOps = new Map<string, CognitionOp>();
  for (const op of normalizedOps) {
    const key = op.op === "upsert"
      ? `upsert:${op.record.key}`
      : `retract:${op.target.key}`;
    dedupedOps.set(key, op);
  }
  const finalOps = [...dedupedOps.values()];

  return {
    schemaVersion: "rp_private_cognition_v4",
    ...(typeof commit.summary === "string" ? { summary: commit.summary } : {}),
    ops: finalOps,
  };
}

function normalizeAssertionRecord(record: Record<string, unknown>): void {
  // Normalize holderId: must be a valid CognitionEntityRef
  if (typeof record.holderId === "string") {
    record.holderId = { kind: "pointer_key", value: record.holderId };
  } else if (!isCognitionEntityRef(record.holderId)) {
    // Backward compat: try migrating from old proposition.subject
    const proposition = record.proposition as Record<string, unknown> | undefined;
    if (proposition && isCognitionEntityRef(proposition.subject)) {
      record.holderId = proposition.subject;
    } else {
      record.holderId = { kind: "pointer_key", value: "unknown" };
    }
  }

  // Normalize claim: must be a non-empty string
  if (typeof record.claim !== "string" || record.claim.length === 0) {
    // Backward compat: try migrating from old proposition.predicate
    const proposition = record.proposition as Record<string, unknown> | undefined;
    if (proposition && typeof proposition.predicate === "string") {
      record.claim = proposition.predicate;
    } else {
      record.claim = "(unknown claim)";
    }
  }

  // Normalize entityRefs: must be an array of CognitionEntityRef
  if (!Array.isArray(record.entityRefs)) {
    // Backward compat: try migrating from old proposition.object
    const proposition = record.proposition as Record<string, unknown> | undefined;
    const refs: unknown[] = [];
    if (proposition) {
      const obj = proposition.object as Record<string, unknown> | undefined;
      if (isEntityPropositionObject(obj) && isCognitionEntityRef(obj.ref)) {
        refs.push(obj.ref);
      } else if (isCognitionEntityRef(obj)) {
        refs.push(obj);
      } else if (typeof obj === "string") {
        refs.push({ kind: "pointer_key", value: obj });
      }
    }
    record.entityRefs = refs;
  } else {
    record.entityRefs = (record.entityRefs as unknown[]).map((ref) => {
      if (typeof ref === "string") return { kind: "pointer_key", value: ref };
      if (isCognitionEntityRef(ref)) return ref;
      return { kind: "pointer_key", value: "unknown" };
    });
  }

  // Remove legacy proposition field after migration
  delete record.proposition;

  const stance = record.stance;
  if (typeof stance !== "string") {
    throw new Error("assertion stance must be a string");
  }

  if (!V4_ASSERTION_STANCES.has(stance as AssertionStance)) {
    throw new Error(`invalid assertion stance: ${stance}`);
  }

  if (record.basis !== undefined) {
    if (typeof record.basis !== "string") {
      record.basis = undefined;
    } else {
      const rawBasis = record.basis as string;
      if (!V4_ASSERTION_BASES.has(rawBasis as AssertionBasis)) {
        record.basis = undefined;
      }
    }
  }

  if (record.stance === "contested") {
    if (typeof record.preContestedStance !== "string" || !V4_PRE_CONTESTABLE_STANCES.has(record.preContestedStance as AssertionStance)) {
      record.preContestedStance = "tentative";
    }
  }
}

function isCognitionEntityRef(value: unknown): value is CognitionEntityRef {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "pointer_key") {
    return typeof candidate.value === "string" && candidate.value.trim().length > 0;
  }

  if (candidate.kind === "special") {
    return (
      candidate.value === "self"
      || candidate.value === "user"
      || candidate.value === "current_location"
    );
  }

  return false;
}

function isEntityPropositionObject(
  value: unknown,
): value is { kind: "entity"; ref: CognitionEntityRef } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.kind === "entity" && isCognitionEntityRef(candidate.ref);
}
