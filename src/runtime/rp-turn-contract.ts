import type {
  AreaFactExposureScope,
  SceneFactSourceKind,
  WorldFactExposureScope,
} from "../storage/domain-repos/contracts/area-world-projection-repo.js";
import { normalizeEntityMentions } from "../memory/entity-mentions.js";

export type CognitionEntityRef =
  | { kind: "pointer_key"; value: string }
  | { kind: "special"; value: "self" | "user" | "current_location" };

/**
 * Entities related to a private episode artifact, used for retrieval indexing.
 * Mirrors {@link CognitionEntityRef} in shape but kept as a separate type so
 * episode-side validation, prompt guidance, and downstream resolvers can
 * evolve independently from cognition's holder/claim semantics.
 */
export type EpisodeEntityRef =
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

export type AssertionGroundingKind =
  | "user_message"
  | "cognitive_sketch"
  | "private_episode"
  | "existing_cognition";

export type AssertionGroundingRef = {
  kind: AssertionGroundingKind;
  /** Exact prefix rule: user_message→"request:<requestId>", cognitive_sketch→"settlement:<id>",
   *  private_episode→"episode:<localRef>", existing_cognition→"cognition:<key>" */
  ref: string;
  /** Optional excerpt from the source, max 160 chars (trim to 160 if longer) */
  excerpt?: string;
};

export type AssertionProvenance =
  | "user_stated"
  | "talker_sketch_explicit"
  | "talker_sketch_auto"
  | "thinker_inferred"
  | "explicit_settlement"
  | "legacy_unknown";

export type AssertionVerificationLevel =
  | "unverified"
  | "context_verified"
  | "strong_verified";

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
  claimedGroundingRefs?: AssertionGroundingRef[];
  verifiedGroundingRefs?: AssertionGroundingRef[];
  groundingVerificationLevel?: AssertionVerificationLevel;
  sceneFactBinding?: {
    scope: "area" | "world";
    factKey: string;
    areaId?: number;
    expectedValue: unknown;
  };
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

export type ActionCommitmentEffect = "move" | "possession" | "status_change";

export type AreaCommit = {
  scope: "area";
  exposureScope: "area_visible" | "system_only";
  factKey: string;
  value: unknown;
};

export type WorldCommit = {
  scope: "world";
  exposureScope: "world_public" | "system_only";
  factKey: string;
  value: unknown;
};

export type SceneCommit = AreaCommit | WorldCommit;

export type ActionCommitment = {
  effect: ActionCommitmentEffect;
  summary: string;
  commits: SceneCommit[];
};

/**
 * WorldStateOp — entity→entity world-state fact edge asserted by an RP turn.
 *
 * MVP semantics (assert-only):
 * - Every op asserts a NEW current fact (no `op` discriminator field).
 * - Old-current invalidation is expressed via `contradictedFactEdgeIds` only;
 *   processors must never call an LLM to detect contradictions synchronously.
 * - `visibility` defaults to `"private_overlay"` for agent-private RP facts.
 *
 * Predicate is free-form natural language; do not enforce a closed vocabulary.
 * factText is the human-readable form of the fact (conversation language).
 */
export type WorldStateOp = {
  localRef?: string;
  subject: { kind: "pointer_key" | "special"; value: string };
  predicate: string;
  object: { kind: "pointer_key" | "special"; value: string };
  factText: string;
  contradictedFactEdgeIds?: number[];
  validTime?: number;
  visibility?: "shared_public" | "private_overlay";
};

export interface SceneFactCommit {
  scope: "area" | "world";
  areaId?: number;
  factKey: string;
  value: unknown;
  sourceKind: SceneFactSourceKind;
  exposureScope: AreaFactExposureScope | WorldFactExposureScope;
}

export type PinnedSummaryProposal = {
  proposedText: string;
  rationale?: string;
};

export type PrivateEpisodeArtifact = {
  localRef?: LocalRef;
  /** In batch mode, the settlementId of the turn this episode belongs to. */
  settlementId?: string;
  category: "speech" | "action" | "observation" | "state_change";
  summary: string;
  privateNotes?: string;
  locationText?: string;
  validTime?: number;
  /**
   * People, places, and items involved in this episode. Used as the
   * retrieval-index surface for "do you remember <entity>" recall — episodes
   * with a matching entity ref get scored above pure full-text candidates.
   * Empty/omitted means "no structured anchor"; the summary text is still
   * indexed.
   */
  entityRefs?: EpisodeEntityRef[];
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
  entityMentions?: string[];
  privateCognition?: PrivateCognitionCommitV4;
  privateEpisodes?: PrivateEpisodeArtifact[];
  publications?: PublicationDeclaration[];
  pinnedSummaryProposal?: PinnedSummaryProposal;
  relationIntents?: RelationIntent[];
  conflictFactors?: ConflictFactor[];
  actionCommitments?: ActionCommitment[];
  worldStateOps?: WorldStateOp[];
};

export type CanonicalRpTurnOutcome = {
  schemaVersion: "rp_turn_outcome_v5";
  publicReply: string;
  latentScratchpad?: string;
  entityMentions?: string[];
  privateCognition?: PrivateCognitionCommitV4;
  privateEpisodes: PrivateEpisodeArtifact[];
  publications: PublicationDeclaration[];
  pinnedSummaryProposal?: PinnedSummaryProposal;
  relationIntents: RelationIntent[];
  conflictFactors: ConflictFactor[];
  actionCommitments?: ActionCommitment[];
  worldStateOps: WorldStateOp[];
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

const V4_ASSERTION_GROUNDING_KINDS: ReadonlySet<AssertionGroundingKind> = new Set([
  "user_message",
  "cognitive_sketch",
  "private_episode",
  "existing_cognition",
]);

const V4_ASSERTION_PROVENANCE: ReadonlySet<AssertionProvenance> = new Set([
  "user_stated",
  "talker_sketch_explicit",
  "talker_sketch_auto",
  "thinker_inferred",
  "explicit_settlement",
  "legacy_unknown",
]);

const SCENE_FACT_KEY_RE = /^(location|holder|status):[a-z0-9_-]+$/;
const SCENE_FACT_POINTER_VALUE_RE = /^[a-z0-9_-]+$/;
const SCENE_FACT_STATUS_VALUES: ReadonlySet<string> = new Set([
  "open",
  "closed",
  "locked",
  "unlocked",
  "lit",
  "dark",
]);

const ACTION_COMMITMENT_EFFECTS: ReadonlySet<ActionCommitmentEffect> = new Set([
  "move",
  "possession",
  "status_change",
]);

type SceneFactNamespace = "location" | "holder" | "status";

export function isValidSceneFactKey(factKey: string): boolean {
  return SCENE_FACT_KEY_RE.test(factKey);
}

function getSceneFactNamespace(factKey: string): SceneFactNamespace | null {
  const match = /^(location|holder|status):/.exec(factKey);
  return match ? match[1] as SceneFactNamespace : null;
}

function isCanonicalSceneFactPointerValue(value: unknown): value is string {
  return typeof value === "string" && SCENE_FACT_POINTER_VALUE_RE.test(value);
}

function isValidSceneFactBindingExpectedValue(
  factKey: string,
  expectedValue: unknown,
): boolean {
  switch (getSceneFactNamespace(factKey)) {
    case "location":
      return isCanonicalSceneFactPointerValue(expectedValue);
    case "holder":
      return (
        expectedValue === null ||
        expectedValue === "user" ||
        isCanonicalSceneFactPointerValue(expectedValue)
      );
    case "status":
      return (
        typeof expectedValue === "string" &&
        SCENE_FACT_STATUS_VALUES.has(expectedValue)
      );
    default:
      return false;
  }
}

export function isValidSceneFactBinding(binding: {
  scope: string;
  factKey: string;
  areaId?: number;
  expectedValue: unknown;
}): boolean {
  if (binding.scope !== "area" && binding.scope !== "world") {
    return false;
  }

  if (!isValidSceneFactKey(binding.factKey)) {
    return false;
  }

  if (
    binding.areaId !== undefined &&
    (!Number.isInteger(binding.areaId) || binding.scope !== "area")
  ) {
    return false;
  }

  return isValidSceneFactBindingExpectedValue(
    binding.factKey,
    binding.expectedValue,
  );
}



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

export function normalizeRpTurnOutcome(
  raw: unknown,
  opts?: { legacyAreaStateCompat?: boolean },
): CanonicalRpTurnOutcome {
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

  return normalizeV5Submission(obj, opts);
}

export function validateRpTurnOutcome(raw: unknown): CanonicalRpTurnOutcome {
  return normalizeRpTurnOutcome(raw);
}

function normalizeV5Submission(
  obj: Record<string, unknown>,
  opts?: { legacyAreaStateCompat?: boolean },
): CanonicalRpTurnOutcome {
  const legacyAreaStateCompat = opts?.legacyAreaStateCompat ?? true;
  if (
    !legacyAreaStateCompat
    && Array.isArray(obj.areaStateArtifacts)
    && obj.areaStateArtifacts.length > 0
  ) {
    throw new Error(
      "RP_TURN_OUTCOME_INVALID: areaStateArtifacts is not allowed when legacyAreaStateCompat=false",
    );
  }

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
  const actionCommitments = normalizeActionCommitments(obj.actionCommitments);
  const worldStateOps = normalizeWorldStateOps(obj.worldStateOps);
  const entityMentions = normalizeEntityMentions(obj.entityMentions, {
    fieldName: "entityMentions",
  });

  const hasContent = publicReply !== ""
    || (privateCognition && privateCognition.ops.length > 0)
    || publications.length > 0
    || privateEpisodes.length > 0
    || actionCommitments.length > 0
    || worldStateOps.length > 0;

  if (!hasContent) {
    throw new Error(
      "empty turn: publicReply is empty and privateCognition has no ops"
    );
  }

  return {
    schemaVersion: "rp_turn_outcome_v5",
    publicReply,
    ...(latentScratchpad !== undefined ? { latentScratchpad } : {}),
    ...(entityMentions.length > 0 ? { entityMentions } : {}),
    ...(privateCognition ? { privateCognition } : {}),
    privateEpisodes,
    publications,
    ...(pinnedSummaryProposal ? { pinnedSummaryProposal } : {}),
    relationIntents,
    conflictFactors,
    ...(actionCommitments.length > 0 ? { actionCommitments } : {}),
    worldStateOps,
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

  if (obj.entityMentions !== undefined && !Array.isArray(obj.entityMentions)) {
    throw new Error("entityMentions must be an array when present");
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
    const entityRefs = normalizeEpisodeEntityRefs(ep.entityRefs);
    episodes.push({
      ...(typeof ep.localRef === "string" ? { localRef: ep.localRef } : {}),
      ...(typeof ep.settlementId === "string" ? { settlementId: ep.settlementId } : {}),
      category: ep.category as PrivateEpisodeArtifact["category"],
      summary: ep.summary,
      ...(typeof ep.privateNotes === "string" ? { privateNotes: ep.privateNotes } : {}),
      ...(typeof ep.locationText === "string" ? { locationText: ep.locationText } : {}),
      ...(typeof ep.validTime === "number" ? { validTime: ep.validTime } : {}),
      ...(entityRefs.length > 0 ? { entityRefs } : {}),
    });
  }
  return episodes;
}

const EPISODE_SPECIAL_REFS: ReadonlySet<string> = new Set([
  "self",
  "user",
  "current_location",
]);

function normalizeEpisodeEntityRefs(raw: unknown): EpisodeEntityRef[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const refs: EpisodeEntityRef[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        refs.push({ kind: "pointer_key", value: trimmed });
      }
      continue;
    }
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const value = typeof candidate.value === "string" ? candidate.value.trim() : "";
    if (value.length === 0) {
      continue;
    }
    if (candidate.kind === "special" && EPISODE_SPECIAL_REFS.has(value)) {
      refs.push({ kind: "special", value: value as "self" | "user" | "current_location" });
      continue;
    }
    refs.push({ kind: "pointer_key", value });
  }
  return refs;
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

function normalizeActionCommitments(raw: unknown): ActionCommitment[] {
  if (raw === undefined) {
    return [];
  }

  if (!Array.isArray(raw)) {
    throw new Error("actionCommitments must be an array");
  }

  return raw.map((entry, index) => normalizeActionCommitment(entry, index));
}

function cloneForNormalization<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function normalizeActionCommitment(
  raw: unknown,
  index: number,
): ActionCommitment {
  if (!raw || typeof raw !== "object") {
    throw new Error(`actionCommitments[${index}] must be an object`);
  }

  const candidate = raw as Record<string, unknown>;
  if (!ACTION_COMMITMENT_EFFECTS.has(candidate.effect as ActionCommitmentEffect)) {
    throw new Error(
      `actionCommitments[${index}].effect must be one of ${Array.from(ACTION_COMMITMENT_EFFECTS).join(", ")}`,
    );
  }

  if (typeof candidate.summary !== "string" || candidate.summary.trim() === "") {
    throw new Error(
      `actionCommitments[${index}].summary must be a non-empty string`,
    );
  }

  if (!Array.isArray(candidate.commits)) {
    throw new Error(`actionCommitments[${index}].commits must be an array`);
  }

  return {
    effect: candidate.effect as ActionCommitmentEffect,
    summary: candidate.summary.trim(),
    commits: candidate.commits.map((commit, commitIndex) =>
      normalizeSceneCommit(commit, index, commitIndex),
    ),
  };
}

function normalizeSceneCommit(
  raw: unknown,
  actionIndex: number,
  commitIndex: number,
): SceneCommit {
  if (!raw || typeof raw !== "object") {
    throw new Error(
      `actionCommitments[${actionIndex}].commits[${commitIndex}] must be an object`,
    );
  }

  const candidate = raw as Record<string, unknown>;
  const scope = candidate.scope as "area" | "world";
  if (scope !== "area" && scope !== "world") {
    throw new Error(
      `actionCommitments[${actionIndex}].commits[${commitIndex}].scope must be "area" or "world"`,
    );
  }

  const factKey =
    typeof candidate.factKey === "string" ? candidate.factKey.trim() : "";
  if (!isValidSceneFactKey(factKey)) {
    throw new Error(
      `actionCommitments[${actionIndex}].commits[${commitIndex}].factKey must use a supported scene fact namespace`,
    );
  }

  if (!("value" in candidate)) {
    throw new Error(
      `actionCommitments[${actionIndex}].commits[${commitIndex}].value is required`,
    );
  }

  if (scope === "area") {
    if (
      candidate.exposureScope !== "area_visible" &&
      candidate.exposureScope !== "system_only"
    ) {
      throw new Error(
        `actionCommitments[${actionIndex}].commits[${commitIndex}].exposureScope must be "area_visible" or "system_only" for area scope`,
      );
    }

    return {
      scope,
      exposureScope: candidate.exposureScope,
      factKey,
      value: cloneForNormalization(candidate.value),
    };
  }

  if (
    candidate.exposureScope !== "world_public" &&
    candidate.exposureScope !== "system_only"
  ) {
    throw new Error(
      `actionCommitments[${actionIndex}].commits[${commitIndex}].exposureScope must be "world_public" or "system_only" for world scope`,
    );
  }

  return {
    scope,
    exposureScope: candidate.exposureScope,
    factKey,
    value: cloneForNormalization(candidate.value),
  };
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
      }

      // Unknown op type — skip gracefully instead of killing the turn
    } catch (opError) {
      // Graceful degradation: skip malformed ops, preserve valid ones + publicReply.
      // A single bad cognition op should never kill the entire RP turn.
      const key = typeof op.record === "object" && op.record !== null
        ? (op.record as Record<string, unknown>).key ?? "?"
        : "?";
      console.warn(
        `[rp-turn-contract] skipping malformed cognition op (key=${key}): ${opError instanceof Error ? opError.message : String(opError)}`,
      );
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

  record.claimedGroundingRefs = normalizeAssertionGroundingRefs(
    record.claimedGroundingRefs,
  );

  const rawProvenance = typeof record.provenance === "string" ? record.provenance : "";
  record.provenance = V4_ASSERTION_PROVENANCE.has(rawProvenance as AssertionProvenance)
    ? rawProvenance
    : "legacy_unknown";

  // Verification is intentionally post-commit. Raw claimed refs are untrusted here.
  record.verifiedGroundingRefs = [];
  record.groundingVerificationLevel = "unverified";

  record.sceneFactBinding = normalizeSceneFactBinding(record.sceneFactBinding);

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

function normalizeSceneFactBinding(
  raw: unknown,
): AssertionRecordV4["sceneFactBinding"] | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const candidate = raw as Record<string, unknown>;
  if (candidate.scope !== "area" && candidate.scope !== "world") {
    return undefined;
  }
  const scope = candidate.scope as "area" | "world";

  const factKey = typeof candidate.factKey === "string"
    ? candidate.factKey.trim()
    : "";
  if (!("expectedValue" in candidate)) {
    return undefined;
  }

  const normalizedBinding: NonNullable<AssertionRecordV4["sceneFactBinding"]> = {
    scope,
    factKey,
    ...(typeof candidate.areaId === "number" ? { areaId: candidate.areaId } : {}),
    expectedValue: candidate.expectedValue,
  };

  return isValidSceneFactBinding(normalizedBinding)
    ? normalizedBinding
    : undefined;
}

function normalizeAssertionGroundingRefs(raw: unknown): AssertionGroundingRef[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const refs: AssertionGroundingRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const candidate = entry as Record<string, unknown>;
    const kind = typeof candidate.kind === "string" ? candidate.kind : "";
    if (!V4_ASSERTION_GROUNDING_KINDS.has(kind as AssertionGroundingKind)) {
      continue;
    }

    const ref = typeof candidate.ref === "string" ? candidate.ref.trim() : "";
    if (ref.length === 0) {
      continue;
    }

    const excerpt = typeof candidate.excerpt === "string"
      ? candidate.excerpt.slice(0, 160)
      : undefined;

    refs.push({
      kind: kind as AssertionGroundingKind,
      ref,
      ...(excerpt !== undefined ? { excerpt } : {}),
    });
  }

  return refs;
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

function isWorldStateEndpoint(
  value: unknown,
): value is { kind: "pointer_key" | "special"; value: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.kind === "pointer_key" || candidate.kind === "special")
    && typeof candidate.value === "string"
    && candidate.value.length > 0
  );
}

function normalizeWorldStateOps(raw: unknown): WorldStateOp[] {
  if (raw === undefined) {
    return [];
  }

  if (!Array.isArray(raw)) {
    throw new Error("worldStateOps must be an array");
  }

  const ops: WorldStateOp[] = [];

  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];

    if (!entry || typeof entry !== "object") {
      throw new Error(`worldStateOps[${index}] must be an object`);
    }

    const candidate = entry as Record<string, unknown>;

    // MVP is assert-only. Drop ops carrying op:"retract" with a console.warn
    // so the model gets feedback but the turn is not rejected. This matches
    // the plan acceptance: drop unsupported field behavior must be tested.
    if (candidate.op === "retract") {
      console.warn(
        `worldStateOps[${index}]: op:"retract" is not supported in MVP — dropping. Use contradictedFactEdgeIds to invalidate prior facts.`,
      );
      continue;
    }

    if (candidate.op !== undefined && candidate.op !== "upsert") {
      throw new Error(
        `worldStateOps[${index}].op is not supported (MVP is assert-only); only contradictedFactEdgeIds is allowed for invalidation`,
      );
    }

    if (!isWorldStateEndpoint(candidate.subject)) {
      throw new Error(
        `worldStateOps[${index}].subject must be { kind: "pointer_key"|"special", value: string }`,
      );
    }
    if (!isWorldStateEndpoint(candidate.object)) {
      throw new Error(
        `worldStateOps[${index}].object must be { kind: "pointer_key"|"special", value: string }`,
      );
    }
    if (typeof candidate.predicate !== "string" || candidate.predicate.trim() === "") {
      throw new Error(
        `worldStateOps[${index}].predicate must be a non-empty string`,
      );
    }
    if (typeof candidate.factText !== "string" || candidate.factText.trim() === "") {
      throw new Error(
        `worldStateOps[${index}].factText must be a non-empty string`,
      );
    }

    const op: WorldStateOp = {
      subject: { kind: candidate.subject.kind, value: candidate.subject.value },
      predicate: candidate.predicate,
      object: { kind: candidate.object.kind, value: candidate.object.value },
      factText: candidate.factText,
    };

    if (typeof candidate.localRef === "string" && candidate.localRef.length > 0) {
      op.localRef = candidate.localRef;
    }
    if (Array.isArray(candidate.contradictedFactEdgeIds)) {
      const ids: number[] = [];
      for (let j = 0; j < candidate.contradictedFactEdgeIds.length; j++) {
        const id = candidate.contradictedFactEdgeIds[j];
        if (typeof id !== "number" || !Number.isFinite(id)) {
          throw new Error(
            `worldStateOps[${index}].contradictedFactEdgeIds[${j}] must be a finite number`,
          );
        }
        ids.push(id);
      }
      if (ids.length > 0) {
        op.contradictedFactEdgeIds = ids;
      }
    }
    if (typeof candidate.validTime === "number" && Number.isFinite(candidate.validTime)) {
      op.validTime = candidate.validTime;
    }
    if (candidate.visibility === "shared_public" || candidate.visibility === "private_overlay") {
      op.visibility = candidate.visibility;
    }

    ops.push(op);
  }

  return ops;
}
