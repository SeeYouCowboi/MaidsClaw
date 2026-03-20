export type CognitionEntityRef =
  | { kind: "pointer_key"; value: string }
  | { kind: "special"; value: "self" | "user" | "current_location" };

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
  confidence?: number;
  provenance?: string;
  ttlTurns?: number;
};

export type CognitionSelector = {
  kind: CognitionKind;
  key: string;
};

export type AssertionRecord = CognitionRecordBase & {
  kind: "assertion";
  proposition: EntityProposition;
  stance: "accepted" | "tentative" | "hypothetical" | "rejected";
  basis?: "observation" | "inference" | "suspicion" | "introspection" | "communication";
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
  proposition: EntityProposition;
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
  | AssertionRecord
  | AssertionRecordV4
  | EvaluationRecord
  | CommitmentRecord;

export type CognitionOp =
  | { op: "upsert"; record: CognitionRecord }
  | { op: "retract"; target: CognitionSelector };

export type PrivateCognitionCommit = {
  schemaVersion: "rp_private_cognition_v3";
  summary?: string;
  ops: CognitionOp[];
};

export type PrivateCognitionCommitV4 = {
  schemaVersion: "rp_private_cognition_v4";
  summary?: string;
  ops: CognitionOp[];
};

export type RpTurnOutcomeSubmission = {
  schemaVersion: "rp_turn_outcome_v3";
  publicReply: string;
  latentScratchpad?: string;
  privateCommit?: PrivateCognitionCommit;
};

export type PublicationKind = "speech" | "record" | "display" | "broadcast";
export type PublicationTargetScope = "current_area" | "world_public";

export type PublicationDeclaration = {
  kind: PublicationKind;
  targetScope: PublicationTargetScope;
  summary: string;
};

export type RpTurnOutcomeSubmissionV4 = {
  schemaVersion: "rp_turn_outcome_v4";
  publicReply: string;
  latentScratchpad?: string;
  privateCommit?: PrivateCognitionCommit | PrivateCognitionCommitV4;
  publications?: PublicationDeclaration[];
};

export type CanonicalRpTurnOutcome = {
  schemaVersion: "rp_turn_outcome_v4";
  publicReply: string;
  latentScratchpad?: string;
  privateCommit?: PrivateCognitionCommitV4;
  publications: PublicationDeclaration[];
};

export const EPISTEMIC_STATUS_TO_STANCE: Record<string, AssertionStance> = {
  confirmed: "confirmed",
  suspected: "tentative",
  hypothetical: "hypothetical",
  retracted: "rejected",
};

export const BELIEF_TYPE_TO_BASIS: Record<string, AssertionBasis> = {
  observation: "first_hand",
  inference: "inference",
  suspicion: "inference",
  intention: "introspection",
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

const V4_ASSERTION_BASES: ReadonlySet<AssertionBasis> = new Set([
  "first_hand",
  "hearsay",
  "inference",
  "introspection",
  "belief",
]);

const V4_PUBLICATION_KINDS: ReadonlySet<PublicationKind> = new Set([
  "speech",
  "record",
  "display",
  "broadcast",
]);

const V4_PUBLICATION_TARGET_SCOPES: ReadonlySet<PublicationTargetScope> = new Set([
  "current_area",
  "world_public",
]);

const V3_STANCE_TO_V4_STANCE: Record<AssertionRecord["stance"], AssertionStance> = {
  accepted: "accepted",
  tentative: "tentative",
  hypothetical: "hypothetical",
  rejected: "rejected",
};

const V3_BASIS_TO_V4_BASIS: Record<NonNullable<AssertionRecord["basis"]>, AssertionBasis> = {
  observation: "first_hand",
  inference: "inference",
  suspicion: "inference",
  introspection: "introspection",
  communication: "hearsay",
};

export type RpBufferedExecutionResult =
  | { outcome: CanonicalRpTurnOutcome }
  | { error: string };

export function detectOutcomeVersion(raw: unknown): "v3" | "v4" | "unknown" {
  if (!raw || typeof raw !== "object") {
    return "unknown";
  }

  const schemaVersion = (raw as Record<string, unknown>).schemaVersion;
  if (schemaVersion === "rp_turn_outcome_v3") {
    return "v3";
  }
  if (schemaVersion === "rp_turn_outcome_v4") {
    return "v4";
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

  const version = detectOutcomeVersion(obj);
  if (version === "unknown") {
    throw new Error(`Unsupported schemaVersion: ${JSON.stringify(obj.schemaVersion)}`);
  }

  if (typeof obj.publicReply !== "string") {
    throw new Error(
      `publicReply must be a string, got ${typeof obj.publicReply}`
    );
  }

  const publicReply = obj.publicReply;
  const latentScratchpad = typeof obj.latentScratchpad === "string"
    ? obj.latentScratchpad
    : undefined;
  const privateCommit = normalizePrivateCommit(obj.privateCommit);
  const publications = normalizePublications(obj.publications);

  if (publicReply === "" && (!privateCommit || privateCommit.ops.length === 0) && publications.length === 0) {
    throw new Error(
      "empty turn: publicReply is empty and privateCommit has no ops"
    );
  }

  return {
    schemaVersion: "rp_turn_outcome_v4",
    publicReply,
    ...(latentScratchpad !== undefined ? { latentScratchpad } : {}),
    ...(privateCommit ? { privateCommit } : {}),
    publications,
  };
}

export function validateRpTurnOutcome(raw: unknown): CanonicalRpTurnOutcome {
  return normalizeRpTurnOutcome(raw);
}

function normalizePrivateCommit(raw: unknown): PrivateCognitionCommitV4 | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (raw === null || typeof raw !== "object") {
    throw new Error("privateCommit must be an object if present");
  }

  const commit = raw as Record<string, unknown>;
  if (!Array.isArray(commit.ops)) {
    throw new Error("privateCommit.ops must be an array");
  }

  const normalizedOps: CognitionOp[] = [];
  for (const op of commit.ops as Array<Record<string, unknown>>) {
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

    throw new Error(`unsupported privateCommit op: ${JSON.stringify(op.op)}`);
  }

  return {
    schemaVersion: "rp_private_cognition_v4",
    ...(typeof commit.summary === "string" ? { summary: commit.summary } : {}),
    ops: normalizedOps,
  };
}

function normalizeAssertionRecord(record: Record<string, unknown>): void {
  const proposition = record.proposition as Record<string, unknown> | undefined;
  if (proposition) {
    const object = proposition.object as Record<string, unknown> | undefined;
    if (isCognitionEntityRef(object)) {
      proposition.object = { kind: "entity", ref: object };
    } else if (!isEntityPropositionObject(object)) {
      throw new Error(
        "assertion proposition.object must be entity-based (kind: 'entity')"
      );
    }
  }

  const stance = record.stance;
  if (typeof stance !== "string") {
    throw new Error("assertion stance must be a string");
  }

  if (stance in V3_STANCE_TO_V4_STANCE) {
    record.stance = V3_STANCE_TO_V4_STANCE[stance as AssertionRecord["stance"]];
  } else if (!V4_ASSERTION_STANCES.has(stance as AssertionStance)) {
    throw new Error(`invalid assertion stance: ${stance}`);
  }

  if (record.basis !== undefined) {
    if (typeof record.basis !== "string") {
      throw new Error("assertion basis must be a string when present");
    }
    const rawBasis = record.basis as string;
    if (rawBasis in V3_BASIS_TO_V4_BASIS) {
      record.basis = V3_BASIS_TO_V4_BASIS[rawBasis as NonNullable<AssertionRecord["basis"]>];
    } else if (!V4_ASSERTION_BASES.has(rawBasis as AssertionBasis)) {
      throw new Error(`invalid assertion basis: ${rawBasis}`);
    }
  }

  if (record.stance === "contested") {
    if (typeof record.preContestedStance !== "string" || !V4_ASSERTION_STANCES.has(record.preContestedStance as AssertionStance)) {
      throw new Error("assertion preContestedStance must be a valid stance when stance is 'contested'");
    }
  }

  delete record.confidence;
}

function normalizePublications(raw: unknown): PublicationDeclaration[] {
  if (raw === undefined) {
    return [];
  }

  if (!Array.isArray(raw)) {
    throw new Error("publications must be an array when present");
  }

  const publications: PublicationDeclaration[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new Error("publication must be an object");
    }
    const publication = entry as Record<string, unknown>;
    if (!V4_PUBLICATION_KINDS.has(publication.kind as PublicationKind)) {
      throw new Error(`invalid publication kind: ${JSON.stringify(publication.kind)}`);
    }
    if (!V4_PUBLICATION_TARGET_SCOPES.has(publication.targetScope as PublicationTargetScope)) {
      throw new Error(`invalid publication targetScope: ${JSON.stringify(publication.targetScope)}`);
    }
    if (typeof publication.summary !== "string") {
      throw new Error("publication summary must be a string");
    }
    publications.push({
      kind: publication.kind as PublicationKind,
      targetScope: publication.targetScope as PublicationTargetScope,
      summary: publication.summary,
    });
  }

  return publications;
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
