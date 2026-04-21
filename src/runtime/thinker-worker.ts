import type postgres from "postgres";
import type { AgentRegistry } from "../agents/registry.js";
import type { AgentLoop, AgentRunRequest } from "../core/agent-loop.js";
import type { ChatMessage } from "../core/models/chat-provider.js";
import {
	getSketchFromSettlement,
	type InteractionRecord,
	type TurnSettlementPayload,
} from "../interaction/contracts.js";
import type {
	CognitionThinkerJobPayload,
	DurableJobStore,
} from "../jobs/durable-store.js";
import type { JobPersistence } from "../jobs/persistence.js";
import { applyContestConflictFactors } from "../memory/cognition/contest-conflict-applicator.js";
import { RelationBuilder } from "../memory/cognition/relation-builder.js";
import {
	materializeRelationIntents,
	resolveConflictFactors,
	resolveLocalRefs,
	type SettledArtifacts,
} from "../memory/cognition/relation-intent-resolver.js";
import {
	TERMINAL_STANCES,
	validateSceneFactBindingForRevision,
} from "../memory/cognition/belief-revision.js";
import type { CoreMemoryIndexUpdater } from "../memory/core-memory-index-updater.js";
import { enqueueOrganizerJobs } from "../memory/organize-enqueue.js";
import type {
	ProjectionManager,
	SettlementProjectionParams,
} from "../memory/projection/projection-manager.js";
import type { SettlementLedger } from "../memory/settlement-ledger.js";
import { CALL_TWO_TOOLS, type CreatedState } from "../memory/task-agent.js";
import type { NodeRef } from "../memory/types.js";
import type { MemoryTaskModelProvider } from "../memory/task-agent.js";
import type { CognitionProjectionRepo } from "../storage/domain-repos/contracts/cognition-projection-repo.js";
import type { EmbeddingRepo } from "../storage/domain-repos/contracts/embedding-repo.js";
import type { InteractionRepo } from "../storage/domain-repos/contracts/interaction-repo.js";
import type { RecentCognitionSlotRepo } from "../storage/domain-repos/contracts/recent-cognition-slot-repo.js";
import type { RelationWriteRepo } from "../storage/domain-repos/contracts/relation-write-repo.js";
import { PgAreaWorldProjectionRepo } from "../storage/domain-repos/pg/area-world-projection-repo.js";
import { PgCognitionEventRepo } from "../storage/domain-repos/pg/cognition-event-repo.js";
import { PgCognitionProjectionRepo } from "../storage/domain-repos/pg/cognition-projection-repo.js";
import { PgEpisodeRepo } from "../storage/domain-repos/pg/episode-repo.js";
import { PgRecentCognitionSlotRepo } from "../storage/domain-repos/pg/recent-cognition-slot-repo.js";
import { PgRelationReadRepo } from "../storage/domain-repos/pg/relation-read-repo.js";
import { PgRelationWriteRepo } from "../storage/domain-repos/pg/relation-write-repo.js";
import { PgSearchProjectionRepo } from "../storage/domain-repos/pg/search-projection-repo.js";
import { PgSettlementLedgerRepo } from "../storage/domain-repos/pg/settlement-ledger-repo.js";

import {
	type ActionCommitment,
	type AssertionBasis,
	type AssertionProvenance,
	type AssertionRecordV4,
	type CanonicalRpTurnOutcome,
	type CognitionEntityRef,
	type CognitionKind,
	type CognitionOp,
	type CognitionSelector,
	type CommitmentRecord,
	type ConflictFactor,
	type EvaluationRecord,
	isValidSceneFactKey,
	normalizeRpTurnOutcome,
	type PrivateEpisodeArtifact,
	type RelationIntent,
	type SceneFactCommit,
} from "./rp-turn-contract.js";
import type { NormalizedTurnInput } from "./speaker-normalization.js";
import type { CognitionCurrentRow } from "../memory/cognition/private-cognition-current.js";

export const THINKER_RELATION_AND_CONFLICT_INSTRUCTIONS = `## Thinker Structured Output Rules for submit_rp_turn

### A. Cognition Hygiene (MANDATORY — apply BEFORE generating new ops)

1. KEY REUSE: Before creating any new assertion/commitment, scan existingCognition for a key covering the SAME topic. If found, upsert that SAME key with updated stance/proposition. NEVER create a variant key (e.g. "player/alibi_v2", "case/corpse_location_conflict").

2. MANDATORY RETRACT: For every upsert you generate, check if it supersedes or invalidates any existing key. If so, include { op: "retract" } for each superseded key. Typical retract triggers:
   - A hypothesis is now confirmed or rejected → retract the old hypothetical
   - A new assertion covers the same fact with better evidence → retract the weaker version
   - A constraint/intent has been fulfilled by actions this turn → retract and re-add as fulfilled
   Example: if you upsert "case/third_person_exists" with stance "confirmed", retract "case/third_person_hypothesis" and "case/third_person_involvement".

3. COMMITMENT LIFECYCLE: Scan existingCognition commitments each turn:
   - If a goal/intent/constraint has been ACHIEVED by events → change status to "fulfilled" via upsert
   - If a goal is no longer relevant → change status to "abandoned" via upsert
   - If duplicate commitments express the same intent → retract all but one, keep the most specific
   Example: "intent/verify_storeroom_evidence" once verified → upsert with status "fulfilled"

4. EVALUATION STABILITY: For trust/X evaluations, the key MUST be exactly "trust/{entity}" (e.g. "trust/player"). NEVER create variant keys like "trust/player_revised". Upsert the same key.

### B. Grounding refs vs relation edges (STRICT SEPARATION)

claimedGroundingRefs belongs to assertion records and is ONLY evidence/source trace for the claim itself.
- Use request:<id>, settlement:<id>, episode:<localRef>, cognition:<key> prefixes exactly.
- claimedGroundingRefs is NOT a same-turn structure graph.

relationIntents is ONLY same-turn artifact structure linking turn-local episodes to cognition writes.
- Array of { sourceRef, targetRef, intent }.
- sourceRef: "episode:{local_key}" — MUST match a privateEpisode localRef generated THIS turn.
- targetRef: "cognition:{key}" — MUST match an assertion/evaluation/commitment key upserted THIS turn.
- intent: "supports" | "triggered".

Rules:
- Every privateEpisode MUST have at least one relationIntent with sourceRef pointing to it.
- Every new assertion MUST have at least one relationIntent with targetRef pointing to it.
- localRef in episodes and sourceRef MUST use the SAME token.

### C. v1 cross-turn revision contract

For v1, cross-turn revision is ONLY:
1) KEY REUSE (same cognition key for same topic), and
2) MANDATORY RETRACT of superseded keys.

Do NOT emit extra advisory revision labels/fields.

### D. conflictFactors

Array of { kind, ref, note? }:
- kind: "contradicts" | "supersedes"
- ref: exact cognition key from existingCognition that conflicts
- When generating stance="contested", MUST include at least one conflictFactor`;

const V1_ASSERTION_PROVENANCE = new Set<AssertionProvenance>([
	"user_stated",
	"talker_sketch_explicit",
	"talker_sketch_auto",
	"thinker_inferred",
	"explicit_settlement",
	"legacy_unknown",
]);

function normalizeThinkerProvenanceFromSettlement(
	rawProvenance: string | undefined,
	cognitiveSketchSource: TurnSettlementPayload["cognitiveSketchSource"] | undefined,
): AssertionProvenance {
	const normalized = V1_ASSERTION_PROVENANCE.has(
		rawProvenance as AssertionProvenance,
	)
		? (rawProvenance as AssertionProvenance)
		: "legacy_unknown";

	if (cognitiveSketchSource === "auto_fallback") {
		return "talker_sketch_auto";
	}

	if (cognitiveSketchSource === "explicit") {
		if (normalized === "user_stated") {
			return "user_stated";
		}
		return "talker_sketch_explicit";
	}

	return normalized;
}

function capAssertionBasisAtInference(
	basis: AssertionBasis | undefined,
): AssertionBasis | undefined {
	if (!basis) {
		return basis;
	}

	if (
		basis === "first_hand" ||
		basis === "introspection" ||
		basis === "hearsay"
	) {
		return "inference";
	}

	return basis;
}

function hasOnlyClaimedCognitionRefs(
	claimedGroundingRefs: AssertionRecordV4["claimedGroundingRefs"],
): boolean {
	if (!claimedGroundingRefs || claimedGroundingRefs.length === 0) {
		return false;
	}

	return claimedGroundingRefs.every((entry) =>
		typeof entry.ref === "string" && entry.ref.startsWith("cognition:"),
	);
}

function hasValidSceneFactBindingForRevision(
	binding: AssertionRecordV4["sceneFactBinding"],
): boolean {
	if (!binding) {
		return false;
	}

	return validateSceneFactBindingForRevision({
		scope: binding.scope,
		factKey: binding.factKey,
		...(typeof binding.areaId === "number" ? { areaId: binding.areaId } : {}),
		expectedValue: binding.expectedValue,
	});
}

type BindingRejectionReason =
	| "invalid_scope"
	| "invalid_fact_key"
	| "invalid_area_id"
	| "invalid_expected_value";

function classifyBindingRejectionReason(
	binding: NonNullable<AssertionRecordV4["sceneFactBinding"]>,
): BindingRejectionReason {
	if (binding.scope !== "area" && binding.scope !== "world") {
		return "invalid_scope";
	}
	if (!isValidSceneFactKey(binding.factKey)) {
		return "invalid_fact_key";
	}
	if (
		binding.areaId !== undefined &&
		(!Number.isInteger(binding.areaId) || binding.scope !== "area")
	) {
		return "invalid_area_id";
	}
	return "invalid_expected_value";
}

function warnBindingInvalidFallback(
	stage: "semantic_gate" | "projection_normalize",
	assertion: AssertionRecordV4,
	binding: NonNullable<AssertionRecordV4["sceneFactBinding"]>,
): void {
	console.warn("[thinker_worker] binding_invalid_fallback", {
		stage,
		reason: classifyBindingRejectionReason(binding),
		cognitionKey: assertion.key,
		provenance: assertion.provenance ?? null,
		rejectedBinding: binding,
	});
}

function applyNormalizedSemanticGate(
	ops: CognitionOp[],
	normalizedTurnInput: NormalizedTurnInput | undefined,
): CognitionOp[] {
	const speechActs = normalizedTurnInput?.speechActs ?? [];
	if (speechActs.length === 0) {
		return ops;
	}

	const speechActSet = new Set(speechActs);
	const hasQuestionLikeActs =
		speechActSet.has("question") ||
		speechActSet.has("hypothesis") ||
		speechActSet.has("confusion_expression");
	const hasNarratedAction = speechActSet.has("narrated_action");
	const hasCorrectionAlone =
		speechActSet.has("correction") && !hasNarratedAction;

	if (!hasQuestionLikeActs && !hasNarratedAction && !hasCorrectionAlone) {
		return ops;
	}

	const normalizedOps: CognitionOp[] = [];

	for (const op of ops) {
		if (op.op !== "upsert" || op.record.kind !== "assertion") {
			normalizedOps.push(op);
			continue;
		}

		const assertion = {
			...(op.record as AssertionRecordV4),
		};
		const binding = assertion.sceneFactBinding;
		const hasBinding = binding !== undefined && binding !== null;
		const hasValidBinding = hasValidSceneFactBindingForRevision(binding);

		if (hasBinding && !hasValidBinding) {
			warnBindingInvalidFallback("semantic_gate", assertion, binding!);
			delete assertion.sceneFactBinding;
		}

		if (hasQuestionLikeActs || hasCorrectionAlone) {
			assertion.basis = "inference";
			assertion.stance = "tentative";
			if (assertion.sceneFactBinding) {
				delete assertion.sceneFactBinding;
			}

			normalizedOps.push({
				...op,
				record: assertion,
			});
			continue;
		}

		if (hasNarratedAction) {
			if (hasValidBinding) {
				normalizedOps.push({
					...op,
					record: assertion,
				});
				continue;
			}

			assertion.basis = "inference";
			assertion.stance = "tentative";

			normalizedOps.push({
				...op,
				record: assertion,
			});
			continue;
		}

		normalizedOps.push(op);
	}

	return normalizedOps;
}

function normalizeThinkerAssertionOpsBeforeProjection(
	ops: CognitionOp[],
	cognitiveSketchSource: TurnSettlementPayload["cognitiveSketchSource"] | undefined,
	authoritativeSourceTurnVersion: number,
	normalizedTurnInput: NormalizedTurnInput | undefined,
): CognitionOp[] {
	const speechActSet = new Set(normalizedTurnInput?.speechActs ?? []);
	const hasQuestionLikeActs =
		speechActSet.has("question") ||
		speechActSet.has("hypothesis") ||
		speechActSet.has("confusion_expression");
	const hasNarratedAction = speechActSet.has("narrated_action");
	const hasCorrectionAlone =
		speechActSet.has("correction") && !hasNarratedAction;

	const normalizedOps = ops.map((op) => {
		if (op.op !== "upsert" || op.record.kind !== "assertion") {
			return op;
		}

		const assertion = {
			...(op.record as AssertionRecordV4),
		} as AssertionRecordV4 & { sourceTurnVersion?: number };

		let provenance = normalizeThinkerProvenanceFromSettlement(
			assertion.provenance,
			cognitiveSketchSource,
		);
		let basis = assertion.basis;
		const hasSceneFactBinding =
			assertion.sceneFactBinding !== undefined &&
			assertion.sceneFactBinding !== null;
		const hasValidSceneFactBinding = hasValidSceneFactBindingForRevision(
			assertion.sceneFactBinding,
		);
		if (hasSceneFactBinding && !hasValidSceneFactBinding) {
			warnBindingInvalidFallback(
				"projection_normalize",
				assertion,
				assertion.sceneFactBinding!,
			);
			delete assertion.sceneFactBinding;
		}
		const preserveNarratedActionFactualBelief =
			hasNarratedAction &&
			hasValidSceneFactBinding &&
			!hasQuestionLikeActs &&
			!hasCorrectionAlone;

		if (
			!preserveNarratedActionFactualBelief &&
			(provenance === "talker_sketch_explicit" ||
				provenance === "talker_sketch_auto")
		) {
			basis = "belief";
		}

		if (
			!preserveNarratedActionFactualBelief &&
			(provenance === "user_stated" || provenance === "explicit_settlement")
		) {
			basis = capAssertionBasisAtInference(basis);
		}

		if (hasOnlyClaimedCognitionRefs(assertion.claimedGroundingRefs)) {
			provenance = "thinker_inferred";
		}

		if (!basis) {
			basis = "belief";
		}

		let stance = assertion.stance;
		if (hasSceneFactBinding && !hasValidSceneFactBinding) {
			basis = "inference";
			stance = "tentative";
		}

		if (
			normalizedTurnInput &&
			normalizedTurnInput.speechActs.length > 0 &&
			provenance === "user_stated" &&
			!hasValidSceneFactBinding
		) {
			basis = "inference";
			stance = "tentative";
		}

		if (
			!preserveNarratedActionFactualBelief &&
			(provenance === "talker_sketch_explicit" ||
				provenance === "talker_sketch_auto") &&
			stance === "confirmed"
		) {
			stance = "tentative";
		}

		assertion.provenance = provenance;
		assertion.basis = basis;
		assertion.stance = stance;
		assertion.verifiedGroundingRefs = [];
		assertion.groundingVerificationLevel = "unverified";
		assertion.sourceTurnVersion = authoritativeSourceTurnVersion;

		return {
			...op,
			record: assertion,
		};
	});

	return applyNormalizedSemanticGate(normalizedOps, normalizedTurnInput);
}

type RecentCognitionEntry = {
	settlementId: string;
	committedAt: number;
	kind: CognitionKind;
	key: string;
	summary: string;
	status: "active" | "retracted";
	basis?: AssertionBasis | "unknown";
	provenance?: AssertionProvenance | "legacy_unknown";
	groundingVerificationLevel?: string;
	sourceTurnVersion?: number;
};

type AssertionCanonicalizationCandidate = {
	key: string;
	holderId: string;
	claim: string;
	entityRefs: string[];
	basis?: AssertionBasis;
	status: string;
	stance: AssertionRecordV4["stance"] | null;
	isTerminal: boolean;
};

type AssertionCanonicalizationCurrentCandidate =
	AssertionCanonicalizationCandidate & {
		id: number;
	};

const CANONICALIZATION_MIN_SIMILARITY = 0.86;
const CANONICALIZATION_WEAK_BASES = new Set<AssertionBasis>([
	"belief",
	"inference",
	"introspection",
]);

function safeParseJsonObject(value: unknown): Record<string, unknown> {
	if (!value) {
		return {};
	}

	if (typeof value === "object") {
		return value as Record<string, unknown>;
	}

	if (typeof value !== "string") {
		return {};
	}

	try {
		const parsed = JSON.parse(value) as unknown;
		if (parsed && typeof parsed === "object") {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// noop
	}

	return {};
}

function extractAssertionHolderPointerKey(raw: Record<string, unknown>): string | null {
	if (typeof raw.holderPointerKey === "string" && raw.holderPointerKey.length > 0) {
		return raw.holderPointerKey;
	}
	if (typeof raw.sourcePointerKey === "string" && raw.sourcePointerKey.length > 0) {
		return raw.sourcePointerKey;
	}

	const holderId = raw.holderId;
	if (typeof holderId === "string" && holderId.length > 0) {
		return holderId;
	}
	if (
		holderId &&
		typeof holderId === "object" &&
		typeof (holderId as { value?: unknown }).value === "string"
	) {
		const value = (holderId as { value: string }).value;
		if (value.length > 0) {
			return value;
		}
	}

	return null;
}

function extractAssertionClaim(raw: Record<string, unknown>): string | null {
	if (typeof raw.claim === "string" && raw.claim.length > 0) {
		return raw.claim;
	}
	if (typeof raw.predicate === "string" && raw.predicate.length > 0) {
		return raw.predicate;
	}
	return null;
}

function normalizeEntityRefValuesFromRaw(rawEntityRefs: unknown): string[] {
	if (!Array.isArray(rawEntityRefs)) {
		return [];
	}

	const refs: string[] = [];
	for (const item of rawEntityRefs) {
		if (typeof item === "string" && item.length > 0) {
			refs.push(item);
			continue;
		}
		if (
			item &&
			typeof item === "object" &&
			typeof (item as { value?: unknown }).value === "string"
		) {
			const value = (item as { value: string }).value;
			if (value.length > 0) {
				refs.push(value);
			}
		}
	}

	return [...new Set(refs)].sort();
}

function extractAssertionEntityRefValues(raw: Record<string, unknown>): string[] {
	if (Array.isArray(raw.entityPointerKeys)) {
		return normalizeEntityRefValuesFromRaw(raw.entityPointerKeys);
	}
	if (typeof raw.targetPointerKey === "string" && raw.targetPointerKey.length > 0) {
		return [raw.targetPointerKey];
	}
	return normalizeEntityRefValuesFromRaw(raw.entityRefs);
}

function normalizeEntityRefValues(entityRefs: CognitionEntityRef[]): string[] {
	const refs: string[] = [];
	for (const ref of entityRefs) {
		if (typeof ref.value === "string" && ref.value.length > 0) {
			refs.push(ref.value);
		}
	}
	return [...new Set(refs)].sort();
}

function hasEntityOverlap(left: string[], right: string[]): boolean {
	if (left.length === 0 || right.length === 0) {
		return false;
	}

	const rightSet = new Set(right);
	for (const value of left) {
		if (rightSet.has(value)) {
			return true;
		}
	}
	return false;
}

function isCjkCodePoint(codePoint: number): boolean {
	return (
		(codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
		(codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
		(codePoint >= 0x2a700 && codePoint <= 0x2b73f) ||
		(codePoint >= 0x2b740 && codePoint <= 0x2b81f) ||
		(codePoint >= 0x2b820 && codePoint <= 0x2ceaf) ||
		(codePoint >= 0x2f800 && codePoint <= 0x2fa1f)
	);
}

function isMostlyCjkWithoutAsciiWhitespace(text: string): boolean {
	if (/[\t\n\r\f\v ]/.test(text)) {
		return false;
	}

	let total = 0;
	let cjk = 0;
	for (const char of text) {
		if (/\s/u.test(char)) {
			continue;
		}
		total += 1;
		const codePoint = char.codePointAt(0);
		if (codePoint !== undefined && isCjkCodePoint(codePoint)) {
			cjk += 1;
		}
	}

	if (total === 0) {
		return false;
	}

	return cjk / total >= 0.6;
}

function hasStrongGroundingRef(assertion: AssertionRecordV4): boolean {
	for (const entry of assertion.claimedGroundingRefs ?? []) {
		if (typeof entry.ref !== "string") {
			continue;
		}
		if (entry.ref.startsWith("request:") || entry.ref.startsWith("episode:")) {
			return true;
		}
	}
	return false;
}

function shouldSkipWeakAssertionCanonicalization(assertion: AssertionRecordV4): boolean {
	const basis = assertion.basis;
	if (!basis || !CANONICALIZATION_WEAK_BASES.has(basis)) {
		return false;
	}
	return !hasStrongGroundingRef(assertion);
}

function buildCanonicalizationQueryText(assertion: AssertionRecordV4): string {
	const holder = assertion.holderId.value;
	const entityRefs = normalizeEntityRefValues(assertion.entityRefs);
	return `holder=${holder} | claim=${assertion.claim} | entities=${entityRefs.join(",")}`;
}

function parseAssertionNodeRefId(nodeRef: string): number | null {
	const match = /^assertion:(\d+)$/.exec(nodeRef);
	if (!match) {
		return null;
	}
	const id = Number(match[1]);
	if (!Number.isInteger(id) || id <= 0) {
		return null;
	}
	return id;
}

function toCanonicalizationCandidateFromCurrent(
	row: CognitionCurrentRow,
): AssertionCanonicalizationCurrentCandidate | null {
	if (row.kind !== "assertion") {
		return null;
	}

	const record = safeParseJsonObject(row.record_json);
	const holderId = extractAssertionHolderPointerKey(record);
	const claim = extractAssertionClaim(record);
	if (!holderId || !claim) {
		return null;
	}

	const entityRefs = extractAssertionEntityRefValues(record);
	const stance = typeof row.stance === "string"
		? (row.stance as AssertionRecordV4["stance"])
		: null;
	const basis = typeof row.basis === "string"
		? (row.basis as AssertionBasis)
		: undefined;

	return {
		id: row.id,
		key: row.cognition_key,
		holderId,
		claim,
		entityRefs,
		basis,
		status: row.status,
		stance,
		isTerminal: stance !== null && TERMINAL_STANCES.has(stance),
	};
}

function toCanonicalizationCandidateFromAssertion(
	assertion: AssertionRecordV4,
): AssertionCanonicalizationCandidate {
	return {
		key: assertion.key,
		holderId: assertion.holderId.value,
		claim: assertion.claim,
		entityRefs: normalizeEntityRefValues(assertion.entityRefs),
		basis: assertion.basis,
		status: "active",
		stance: assertion.stance,
		isTerminal: TERMINAL_STANCES.has(assertion.stance),
	};
}

function collectHolderCandidates(
	holderId: string,
	currentByHolder: Map<string, Map<string, AssertionCanonicalizationCandidate>>,
	overlayByHolder: Map<string, Map<string, AssertionCanonicalizationCandidate>>,
): AssertionCanonicalizationCandidate[] {
	const merged = new Map<string, AssertionCanonicalizationCandidate>();
	for (const candidate of currentByHolder.get(holderId)?.values() ?? []) {
		merged.set(candidate.key, candidate);
	}
	for (const candidate of overlayByHolder.get(holderId)?.values() ?? []) {
		merged.set(candidate.key, candidate);
	}
	return [...merged.values()];
}

function addOverlayCandidate(
	candidate: AssertionCanonicalizationCandidate,
	overlayByKey: Map<string, AssertionCanonicalizationCandidate>,
	overlayByHolder: Map<string, Map<string, AssertionCanonicalizationCandidate>>,
): void {
	overlayByKey.set(candidate.key, candidate);
	let holderMap = overlayByHolder.get(candidate.holderId);
	if (!holderMap) {
		holderMap = new Map();
		overlayByHolder.set(candidate.holderId, holderMap);
	}
	holderMap.set(candidate.key, candidate);
}

async function canonicalizeThinkerAssertionKeysBeforeProjection(params: {
	ops: CognitionOp[];
	agentId: string;
	cognitionProjectionRepo: CognitionProjectionRepo;
	assertionCanonicalization?: AssertionCanonicalizationBundle;
	canonicalizationSimilarityThreshold?: number;
}): Promise<CognitionOp[]> {
	if (!params.assertionCanonicalization) {
		return params.ops;
	}

	const similarityThreshold =
		typeof params.canonicalizationSimilarityThreshold === "number"
			? params.canonicalizationSimilarityThreshold
			: CANONICALIZATION_MIN_SIMILARITY;

	const currentRows = await params.cognitionProjectionRepo.getAllCurrent(
		params.agentId,
	);
	const currentById = new Map<number, AssertionCanonicalizationCurrentCandidate>();
	const currentByHolder = new Map<
		string,
		Map<string, AssertionCanonicalizationCandidate>
	>();
	for (const row of currentRows) {
		const candidate = toCanonicalizationCandidateFromCurrent(row);
		if (!candidate) {
			continue;
		}
		currentById.set(candidate.id, candidate);
		let holderMap = currentByHolder.get(candidate.holderId);
		if (!holderMap) {
			holderMap = new Map();
			currentByHolder.set(candidate.holderId, holderMap);
		}
		holderMap.set(candidate.key, candidate);
	}

	const overlayByKey = new Map<string, AssertionCanonicalizationCandidate>();
	const overlayByHolder = new Map<
		string,
		Map<string, AssertionCanonicalizationCandidate>
	>();

	const canonicalizedOps: CognitionOp[] = [];
	const assertionUpsertIndexByKey = new Map<string, number>();
	const pushCanonicalizedOp = (nextOp: CognitionOp): void => {
		if (nextOp.op === "upsert" && nextOp.record.kind === "assertion") {
			const key = nextOp.record.key;
			const existingIndex = assertionUpsertIndexByKey.get(key);
			if (existingIndex !== undefined) {
				canonicalizedOps[existingIndex] = nextOp;
				return;
			}
			assertionUpsertIndexByKey.set(key, canonicalizedOps.length);
			canonicalizedOps.push(nextOp);
			return;
		}

		canonicalizedOps.push(nextOp);
	};

	for (const op of params.ops) {
		if (op.op !== "upsert" || op.record.kind !== "assertion") {
			pushCanonicalizedOp(op);
			continue;
		}

		const assertion = op.record as AssertionRecordV4;
		if (
			assertion.provenance !== "user_stated" &&
			assertion.provenance !== "explicit_settlement"
		) {
			pushCanonicalizedOp(op);
			continue;
		}

		if (shouldSkipWeakAssertionCanonicalization(assertion)) {
			pushCanonicalizedOp(op);
			continue;
		}

		const holderId = assertion.holderId.value;
		const opEntityRefs = normalizeEntityRefValues(assertion.entityRefs);
		const holderCandidates = collectHolderCandidates(
			holderId,
			currentByHolder,
			overlayByHolder,
		);

		if (
			opEntityRefs.length > 0 &&
			!holderCandidates.some((candidate) =>
				hasEntityOverlap(opEntityRefs, candidate.entityRefs),
			)
		) {
			pushCanonicalizedOp(op);
			continue;
		}

		const queryText = buildCanonicalizationQueryText(assertion);
		let neighbors: Array<{
			nodeRef: NodeRef;
			similarity: number;
			nodeKind: string;
		}> = [];
		try {
			const [queryEmbedding] = await params.assertionCanonicalization.modelProvider.embed(
				[queryText],
				"query_expansion",
				params.assertionCanonicalization.embeddingModelId,
			);
			if (!queryEmbedding || queryEmbedding.length === 0) {
				pushCanonicalizedOp(op);
				continue;
			}

			neighbors = await params.assertionCanonicalization.embeddingRepo.cosineSearch(
				queryEmbedding,
				{
					nodeKind: "assertion",
					agentId: params.agentId,
					modelId: params.assertionCanonicalization.embeddingModelId,
					limit: 12,
				},
			);
		} catch (error) {
			console.warn(
				"[thinker_worker] assertion canonicalization query failed (non-fatal):",
				error,
			);
			pushCanonicalizedOp(op);
			continue;
		}

		const requiresEntityOverlapForCjk =
			opEntityRefs.length > 0 && isMostlyCjkWithoutAsciiWhitespace(assertion.claim);
		const eligibleByKey = new Map<string, AssertionCanonicalizationCandidate>();
		for (const neighbor of neighbors) {
			if (neighbor.nodeKind !== "assertion") {
				continue;
			}
			if (neighbor.similarity < similarityThreshold) {
				continue;
			}

			const candidateId = parseAssertionNodeRefId(neighbor.nodeRef);
			if (!candidateId) {
				continue;
			}

			const currentCandidate = currentById.get(candidateId);
			if (!currentCandidate) {
				continue;
			}

			const candidate =
				overlayByKey.get(currentCandidate.key) ?? currentCandidate;
			if (candidate.holderId !== holderId) {
				continue;
			}
			if (candidate.status === "retracted") {
				continue;
			}
			if (candidate.stance === "contested") {
				continue;
			}
			if (candidate.isTerminal) {
				continue;
			}
			if (
				requiresEntityOverlapForCjk &&
				!hasEntityOverlap(opEntityRefs, candidate.entityRefs)
			) {
				continue;
			}

			eligibleByKey.set(candidate.key, candidate);
		}

		if (eligibleByKey.size !== 1) {
			pushCanonicalizedOp(op);
			continue;
		}

		const canonicalCandidate = [...eligibleByKey.values()][0];
		const canonicalKey = canonicalCandidate.key;
		const rewrittenRecord =
			assertion.key === canonicalKey
				? assertion
				: ({
					...assertion,
					key: canonicalKey,
				} as AssertionRecordV4);

		if (assertion.key !== canonicalKey) {
			pushCanonicalizedOp({
				...op,
				record: rewrittenRecord,
			});
		} else {
			pushCanonicalizedOp(op);
		}

		addOverlayCandidate(
			toCanonicalizationCandidateFromAssertion(rewrittenRecord),
			overlayByKey,
			overlayByHolder,
		);
	}

	return canonicalizedOps;
}

export type AssertionCanonicalizationBundle = {
	embeddingRepo: EmbeddingRepo;
	modelProvider: MemoryTaskModelProvider;
	embeddingModelId: string;
};

export type ThinkerWorkerDeps = {
	sql: postgres.Sql;
	projectionManager: ProjectionManager;
	interactionRepo: InteractionRepo;
	recentCognitionSlotRepo: RecentCognitionSlotRepo;
	agentRegistry: AgentRegistry;
	createAgentLoop: (agentId: string) => AgentLoop | null;
	cognitionProjectionRepo?: CognitionProjectionRepo;
	relationWriteRepo?: RelationWriteRepo;
	relationBuilder?: RelationBuilder;
	coreMemoryIndexUpdater?: CoreMemoryIndexUpdater;
	jobPersistence?: JobPersistence;
	settlementLedger?: SettlementLedger;
	durableJobStore?: DurableJobStore;
	assertionCanonicalization?: AssertionCanonicalizationBundle;
	canonicalizationSimilarityThreshold?: number;
	sceneFactWritePath?: boolean;
};

function mapActionCommitmentsToSceneFactCommits(
	actionCommitments: ActionCommitment[],
): SceneFactCommit[] {
	const commits: SceneFactCommit[] = [];
	for (const ac of actionCommitments) {
		const sceneCommits = Array.isArray(ac.commits) ? ac.commits : [];
		for (const sc of sceneCommits) {
			if (!isValidSceneFactKey(sc.factKey)) continue;
			commits.push({
				scope: sc.scope,
				// AreaCommit has no areaId; projection-manager falls back to viewerSnapshot.currentLocationEntityId
				factKey: sc.factKey,
				value: sc.value,
				sourceKind: "action_commitment",
				exposureScope: sc.exposureScope,
			});
		}
	}
	return commits;
}

function toConversationMessages(records: InteractionRecord[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const record of records) {
		if (record.recordType !== "message") {
			continue;
		}
		const payload = record.payload as { role?: unknown; content?: unknown };
		if (payload.role !== "user" && payload.role !== "assistant") {
			continue;
		}
		messages.push({
			role: payload.role,
			content:
				typeof payload.content === "string"
					? payload.content
					: String(payload.content ?? ""),
		});
	}
	return messages;
}

function refValue(ref: CognitionEntityRef | CognitionSelector): string {
	if ("value" in ref) return ref.value;
	return (ref as CognitionSelector).key;
}

function summarizeAssertion(record: AssertionRecordV4): string {
	return `[${record.holderId.value}] ${record.claim} (${record.stance})`;
}

function summarizeEvaluation(record: EvaluationRecord): string {
	const targetLabel = refValue(record.target);
	const dims = record.dimensions.map((d) => `${d.name}:${d.value}`).join(", ");
	return `eval ${targetLabel} [${dims}]`;
}

function summarizeCommitment(record: CommitmentRecord): string {
	let targetDesc: string;
	if (typeof record.target === "object" && "action" in record.target) {
		targetDesc = record.target.action;
	} else if (
		typeof record.target === "object" &&
		"predicate" in record.target
	) {
		targetDesc = (record.target as { predicate?: string }).predicate ?? "";
	} else {
		targetDesc = "";
	}
	return `${record.mode}: ${targetDesc} (${record.status})`;
}

function buildCognitionSlotPayloadForThinker(
	ops: CognitionOp[],
	settlementId: string,
	committedAt: number,
	sourceTurnVersion?: number,
): RecentCognitionEntry[] {
	const items: RecentCognitionEntry[] = [];

	for (const op of ops) {
		if (op.op === "upsert") {
			const record = op.record;
			let summary: string;
			let basis: RecentCognitionEntry["basis"] | undefined;
			let provenance: RecentCognitionEntry["provenance"] | undefined;
			switch (record.kind) {
				case "assertion": {
					const assertion = record as AssertionRecordV4;
					summary = summarizeAssertion(assertion);
					basis = assertion.basis ?? "unknown";
					provenance = (assertion.provenance as AssertionProvenance) ?? "legacy_unknown";
					break;
				}
				case "evaluation":
					summary = summarizeEvaluation(record as EvaluationRecord);
					break;
				case "commitment":
					summary = summarizeCommitment(record as CommitmentRecord);
					break;
			}
			const entry: RecentCognitionEntry = {
				settlementId,
				committedAt,
				kind: record.kind,
				key: record.key,
				summary,
				status: "active",
			};
			if (basis !== undefined) entry.basis = basis;
			if (provenance !== undefined) entry.provenance = provenance;
			if (sourceTurnVersion !== undefined) entry.sourceTurnVersion = sourceTurnVersion;
			if ((record as AssertionRecordV4).groundingVerificationLevel !== undefined) {
				entry.groundingVerificationLevel = (record as AssertionRecordV4).groundingVerificationLevel;
			}
			items.push(entry);
		} else if (op.op === "retract") {
			const entry: RecentCognitionEntry = {
				settlementId,
				committedAt,
				kind: op.target.kind,
				key: op.target.key,
				summary: "(retracted)",
				status: "retracted",
			};
			if (sourceTurnVersion !== undefined) entry.sourceTurnVersion = sourceTurnVersion;
			items.push(entry);
		}
	}

	return items;
}

function normalizeThinkerRelationIntents(raw: unknown): RelationIntent[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const intents: RelationIntent[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const candidate = entry as Record<string, unknown>;
		if (
			typeof candidate.sourceRef !== "string" ||
			typeof candidate.targetRef !== "string"
		) {
			continue;
		}
		if (candidate.intent !== "supports" && candidate.intent !== "triggered") {
			continue;
		}

		intents.push({
			sourceRef: candidate.sourceRef,
			targetRef: candidate.targetRef,
			intent: candidate.intent,
		});
	}

	return intents;
}

function normalizeThinkerConflictFactors(raw: unknown): ConflictFactor[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const factors: ConflictFactor[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const candidate = entry as Record<string, unknown>;
		if (
			typeof candidate.kind !== "string" ||
			typeof candidate.ref !== "string"
		) {
			continue;
		}
		if (typeof candidate.note === "string" && candidate.note.length > 120) {
			continue;
		}

		factors.push({
			kind: candidate.kind,
			ref: candidate.ref,
			...(typeof candidate.note === "string" ? { note: candidate.note } : {}),
		});
	}

	return factors;
}

function sanitizeThinkerOutcome(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") {
		return raw;
	}

	const outcome = raw as Record<string, unknown>;
	return {
		...outcome,
		relationIntents: normalizeThinkerRelationIntents(outcome.relationIntents),
		conflictFactors: normalizeThinkerConflictFactors(outcome.conflictFactors),
	};
}

function createThinkerSlotRepo(
	base: PgRecentCognitionSlotRepo,
	batchVersion?: number,
): RecentCognitionSlotRepo {
	return {
		upsertRecentCognitionSlot: (
			sessionId,
			agentId,
			settlementId,
			newEntriesJson,
		) => {
			if (batchVersion !== undefined) {
				return base.upsertRecentCognitionSlot(
					sessionId,
					agentId,
					settlementId,
					newEntriesJson ?? "[]",
					undefined,
					batchVersion,
				);
			}

			return base.upsertRecentCognitionSlot(
				sessionId,
				agentId,
				settlementId,
				newEntriesJson ?? "[]",
				"thinker",
			);
		},
		getSlotPayload: (sessionId, agentId) =>
			base.getSlotPayload(sessionId, agentId),
		getBySession: (sessionId, agentId) => base.getBySession(sessionId, agentId),
		getVersionGap: (sessionId, agentId) =>
			base.getVersionGap(sessionId, agentId),
	};
}

/**
 * Groups episodes by settlementId for per-settlement projection in batch mode.
 * Falls back to assigning all episodes to effectiveSettlementId if the LLM
 * did not tag episodes with settlementId.
 */
function parseEpisodesBySettlement(
	episodes: PrivateEpisodeArtifact[],
	batchMemberSettlementIds: string[],
	effectiveSettlementId: string,
): Map<string, PrivateEpisodeArtifact[]> {
	const memberSet = new Set(batchMemberSettlementIds);
	const grouped = new Map<string, PrivateEpisodeArtifact[]>();
	for (const id of batchMemberSettlementIds) {
		grouped.set(id, []);
	}

	let attributedCount = 0;
	for (const episode of episodes) {
		if (episode.settlementId && memberSet.has(episode.settlementId)) {
			const attributed = grouped.get(episode.settlementId);
			if (attributed) {
				attributed.push(episode);
			}
			attributedCount++;
		} else {
			// Unattributed episodes fall back to effectiveSettlementId
			const fallback = grouped.get(effectiveSettlementId);
			if (fallback) {
				fallback.push(episode);
			}
		}
	}

	if (episodes.length > 0) {
		console.log(
			`[thinker_worker] parseEpisodesBySettlement: ${attributedCount}/${episodes.length} episodes attributed by settlementId, ${episodes.length - attributedCount} fell back to ${effectiveSettlementId}`,
		);
	}

	return grouped;
}

export function createThinkerWorker(deps: ThinkerWorkerDeps) {
	if (!deps.assertionCanonicalization) {
		console.debug(
			"[thinker_worker] assertionCanonicalization bundle absent — canonicalization will be skipped",
		);
	}
	return async (job: { payload: unknown }): Promise<void> => {
		// Handle both object payloads and legacy double-JSON-encoded string payloads
		const rawPayload = job.payload;
		const payload = (typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload) as CognitionThinkerJobPayload;

		const slot = await deps.recentCognitionSlotRepo.getBySession(
			payload.sessionId,
			payload.agentId,
		);
		if (slot && slot.thinkerCommittedVersion >= payload.talkerTurnVersion) {
			try {
				await deps.settlementLedger?.markReplayedNoop(payload.settlementId);
			} catch (ledgerErr) {
				console.warn(
					"[thinker_worker] markReplayedNoop (idempotency skip) failed (non-fatal):",
					ledgerErr,
				);
			}
			return;
		}

		// --- Settlement-level idempotency guard (mirrors explicit-settlement-processor.ts:153-159) ---
		if (deps.settlementLedger) {
			const ledgerState = await deps.settlementLedger.check(payload.settlementId);
			if (ledgerState === "applied") {
				return;
			}
		}

		let batchMode = false;
		let sketchChain: Array<{
			version: number;
			settlementId: string;
			sketch: string;
			cognitiveSketchSource?: "explicit" | "auto_fallback";
		}> = [];
		let effectiveHighestVersion = payload.talkerTurnVersion;
		let effectiveSettlementId = payload.settlementId;
		let batchMemberSettlementIds: string[] = [payload.settlementId];

		if (deps.durableJobStore) {
			const additionalPending =
				await deps.durableJobStore.listPendingByKindAndPayload(
					"cognition.thinker",
					{ sessionId: payload.sessionId, agentId: payload.agentId },
					Date.now(),
				);

			const otherPending = additionalPending.filter((row) => {
				const raw = row.payload_json;
				const p = (typeof raw === "string" ? JSON.parse(raw) : raw) as CognitionThinkerJobPayload;
				return p.talkerTurnVersion !== payload.talkerTurnVersion;
			});

			if (otherPending.length > 0) {
				batchMode = true;
				const allJobs: Array<{ version: number; settlementId: string }> = [
					{
						version: payload.talkerTurnVersion,
						settlementId: payload.settlementId,
					},
					...otherPending.map((row) => {
						const raw = row.payload_json;
						const p = (typeof raw === "string" ? JSON.parse(raw) : raw) as CognitionThinkerJobPayload;
						return {
							version: p.talkerTurnVersion,
							settlementId: p.settlementId,
						};
					}),
				].sort((a, b) => a.version - b.version);

				for (const jobEntry of allJobs) {
					try {
						const requestId = jobEntry.settlementId.replace(/^stl:/, "");
						const sp = await deps.interactionRepo.getSettlementPayload(
							payload.sessionId,
							requestId,
						);
						if (!sp) {
							console.warn(
								`[thinker_worker] batch: settlement payload not found for v${jobEntry.version} (${jobEntry.settlementId}), truncating chain`,
							);
							break;
						}
						const rawSketch = getSketchFromSettlement(sp);
						const sketch =
							rawSketch ||
							"(no explicit sketch — derive from conversation context)";

					sketchChain.push({
						version: jobEntry.version,
						settlementId: jobEntry.settlementId,
						sketch,
						cognitiveSketchSource: sp.cognitiveSketchSource,
					});
						effectiveHighestVersion = jobEntry.version;
						effectiveSettlementId = jobEntry.settlementId;
					} catch (loadErr) {
						console.warn(
							`[thinker_worker] batch: sketch load failed for v${jobEntry.version} (${jobEntry.settlementId}), truncating chain`,
							loadErr,
						);
						break;
					}
				}

				if (sketchChain.length > 3) {
					console.warn(
						`[thinker_worker] batch: thinker falling behind — ${sketchChain.length} pending turns queued (versions ${sketchChain[0]?.version}..${sketchChain[sketchChain.length - 1]?.version})`,
					);
				}

				if (sketchChain.length <= 1) {
					batchMode = false;
					sketchChain = [];
					effectiveHighestVersion = payload.talkerTurnVersion;
					effectiveSettlementId = payload.settlementId;
				}

				if (batchMode) {
					if (sketchChain.length > 20) {
						const excluded = sketchChain.length - 20;
						console.warn(
							`[thinker_worker] batch soft cap: ${excluded} older sketches excluded (batch size ${sketchChain.length})`,
						);
						sketchChain = sketchChain.slice(sketchChain.length - 20);
					}

					// ── Batch split: if chain is large, split and enqueue remainder as parallel jobs ──
					const BATCH_SPLIT_THRESHOLD = 3;
					if (sketchChain.length > BATCH_SPLIT_THRESHOLD && deps.jobPersistence) {
						const myChain = sketchChain.slice(0, BATCH_SPLIT_THRESHOLD);
						const remainder = sketchChain.slice(BATCH_SPLIT_THRESHOLD);

						// Split remainder into sub-batches of BATCH_SPLIT_THRESHOLD
						const subBatches: typeof sketchChain[] = [];
						for (let i = 0; i < remainder.length; i += BATCH_SPLIT_THRESHOLD) {
							subBatches.push(remainder.slice(i, i + BATCH_SPLIT_THRESHOLD));
						}

						// Enqueue each sub-batch as a new thinker job keyed to its highest version
						for (const sub of subBatches) {
							const subHighest = sub[sub.length - 1];
							const subJobId = `thinker:${payload.sessionId}:${subHighest.settlementId}:split`;
							try {
								await deps.jobPersistence.enqueue({
									id: subJobId,
									jobType: "cognition.thinker" as const,
									payload: {
										sessionId: payload.sessionId,
										agentId: payload.agentId,
										settlementId: subHighest.settlementId,
										talkerTurnVersion: subHighest.version,
									},
									status: "pending" as const,
									maxAttempts: 3,
								});
								console.log(
									`[thinker_worker] batch split: enqueued sub-batch (v${sub[0].version}..${subHighest.version}) as parallel job`,
								);
							} catch (enqueueErr) {
								console.warn(
									`[thinker_worker] batch split: failed to enqueue sub-batch v${sub[0].version}..${subHighest.version}, will be processed by next worker:`,
									enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
								);
							}
						}

						// Cancel original pending jobs absorbed into sub-batches
						if (deps.jobPersistence.cancelPendingByKey) {
							for (const sub of subBatches) {
								for (const entry of sub) {
									const originalJobKey = `thinker:${payload.sessionId}:${entry.settlementId}`;
									try {
										await deps.jobPersistence.cancelPendingByKey(originalJobKey);
									} catch { /* non-fatal */ }
								}
							}
						}

						// Current worker processes only myChain
						console.log(
							`[thinker_worker] batch split: processing v${myChain[0].version}..${myChain[myChain.length - 1].version} (${myChain.length}), split off ${remainder.length} into ${subBatches.length} parallel job(s)`,
						);
						sketchChain = myChain;
						effectiveHighestVersion = myChain[myChain.length - 1].version;
						effectiveSettlementId = myChain[myChain.length - 1].settlementId;
					}

					batchMemberSettlementIds = allJobs
						.filter((j) => j.version <= effectiveHighestVersion)
						.map((j) => j.settlementId);
				}
			}
		}

		// --- Batch-mode idempotency: check effective settlement before projection ---
		if (deps.settlementLedger && batchMode) {
			const effectiveState = await deps.settlementLedger.check(effectiveSettlementId);
			if (effectiveState === "applied") {
				for (const memberId of batchMemberSettlementIds) {
					try {
						await deps.settlementLedger.markReplayedNoop(memberId);
					} catch { /* non-fatal */ }
				}
				return;
			}
		}

		try {
			let settlementPayload: TurnSettlementPayload | undefined;
			const messageRecords = await deps.interactionRepo.getMessageRecords(
				payload.sessionId,
			);
			const messages = toConversationMessages(messageRecords);

			if (batchMode) {
				const requestId = effectiveSettlementId.replace(/^stl:/, "");
				settlementPayload = await deps.interactionRepo.getSettlementPayload(
					payload.sessionId,
					requestId,
				);
				if (!settlementPayload) {
					throw new Error(
						`Settlement payload not found: session=${payload.sessionId} settlement=${effectiveSettlementId}`,
					);
				}

				const sketchChainText = sketchChain
					.map((entry) => {
						const sourceTag = entry.cognitiveSketchSource ? ` [source:${entry.cognitiveSketchSource}]` : "";
						return `[Turn ${entry.version} | ${entry.settlementId}] ${entry.sketch}${sourceTag}`;
					})
					.join("\n");
				const sketchlessCount = sketchChain.filter((e) =>
					e.sketch.startsWith("(no explicit sketch"),
				).length;
				const sketchNote =
					sketchlessCount > 0
						? `\nNote: ${sketchlessCount} of ${sketchChain.length} turns had no explicit sketch from Talker — use the conversation context to infer cognition for those turns.\n`
						: "";
				messages.push({
					role: "user",
					content:
						`[Thinker context] Cognitive sketches from Talker (batch):\n${sketchChainText}\n${sketchNote}\n` +
"Now generate full privateCognition, privateEpisodes, publications via submit_rp_turn.\n" +
					"IMPORTANT: For each privateEpisode, include the \"settlementId\" field matching the settlement of the turn it belongs to (shown in brackets above). " +
					"This is required for correct per-turn episode attribution.",
				});
			} else {
				const requestId = payload.settlementId.replace(/^stl:/, "");
				settlementPayload = await deps.interactionRepo.getSettlementPayload(
					payload.sessionId,
					requestId,
				);
				if (!settlementPayload) {
					throw new Error(
						`Settlement payload not found: session=${payload.sessionId} settlement=${payload.settlementId}`,
					);
				}

				const cognitiveSketch =
					getSketchFromSettlement(settlementPayload) ?? "";
				if (cognitiveSketch) {
					messages.push({
						role: "user",
						content:
							`[Thinker context] Cognitive sketch from Talker: ${cognitiveSketch}\n\n` +
							"Now generate full privateCognition, privateEpisodes, publications via submit_rp_turn.",
					});
				}
			}

			messages.push({
				role: "user",
				content: THINKER_RELATION_AND_CONFLICT_INSTRUCTIONS,
			});

			if (batchMode) {
				console.log(
					`[thinker_worker] batch sketch chain loaded: chain=${sketchChain.length} members=${batchMemberSettlementIds.length} highest=${effectiveHighestVersion}`,
				);
			}

			const agentLoop = deps.createAgentLoop(payload.agentId);
			if (!agentLoop) {
				throw new Error(`No agent loop for agent ${payload.agentId}`);
			}

			if (!deps.agentRegistry.get(payload.agentId)) {
				throw new Error(`Agent not found: ${payload.agentId}`);
			}

			const agentRunRequest: AgentRunRequest = {
				sessionId: payload.sessionId,
				requestId: payload.settlementId,
				messages,
				isTalkerMode: false,
			};

			const bufferedResult = await agentLoop.runBuffered(agentRunRequest);
			if ("error" in bufferedResult) {
				throw new Error(bufferedResult.error);
			}

			const canonicalOutcome = normalizeRpTurnOutcome(
				sanitizeThinkerOutcome(structuredClone(bufferedResult.outcome)),
			);

			// Scene-fact projection has moved to the Talker commit path
			// (turn-service.writeSceneFactCommitsFromTalker). The Thinker no longer
			// needs to aggregate batch-member actionCommitments for scene writes.
			const relationIntents = canonicalOutcome.relationIntents ?? [];
			const conflictFactors = canonicalOutcome.conflictFactors ?? [];

			const authoritativeSourceTurnVersion = batchMode
				? effectiveHighestVersion
				: payload.talkerTurnVersion;
			const cognitionOps = normalizeThinkerAssertionOpsBeforeProjection(
				canonicalOutcome.privateCognition?.ops ?? [],
				settlementPayload?.cognitiveSketchSource,
				authoritativeSourceTurnVersion,
				settlementPayload?.normalizedTurnInput,
			);
			const canonicalizedCognitionOps = await canonicalizeThinkerAssertionKeysBeforeProjection({
				ops: cognitionOps,
				agentId: payload.agentId,
				cognitionProjectionRepo:
					deps.cognitionProjectionRepo ?? new PgCognitionProjectionRepo(deps.sql),
				assertionCanonicalization: deps.assertionCanonicalization,
				canonicalizationSimilarityThreshold:
					deps.canonicalizationSimilarityThreshold,
			});
			const committedAt = Date.now();
			const slotEntries = buildCognitionSlotPayloadForThinker(
				canonicalizedCognitionOps,
				effectiveSettlementId,
				committedAt,
				authoritativeSourceTurnVersion,
			);
			const recentCognitionSlotJson = JSON.stringify(slotEntries);

			// --- Per-settlement episode grouping (batch mode) ---
			//
			// Ledger claim + data writes + markApplied now all happen inside the projection
			// transaction below. This replaces the previous pattern where markThinkerProjecting
			// was called outside the tx (which caused zombie `thinker_projecting` rows whenever
			// the tx rolled back). See root-cause plan for details.
			const perMemberEpisodes = new Map<string, PrivateEpisodeArtifact[]>();
			const projectedMembers = new Set<string>();
			const grouped = batchMode
				? parseEpisodesBySettlement(
						canonicalOutcome.privateEpisodes ?? [],
						batchMemberSettlementIds,
						effectiveSettlementId,
					)
				: null;
			let effectiveEpisodes = canonicalOutcome.privateEpisodes ?? [];

			const viewerSnapshot = settlementPayload.viewerSnapshot
				? {
						currentLocationEntityId:
							settlementPayload.viewerSnapshot.currentLocationEntityId,
					}
				: undefined;

			let changedNodeRefs: NodeRef[] = [];
			let leaderClaimFailed = false;
			try {
			await deps.sql.begin(async (tx) => {
				const txSql = tx as unknown as postgres.Sql;
				const txEpisodeRepo = new PgEpisodeRepo(txSql);
				const txCognitionProjectionRepo = new PgCognitionProjectionRepo(txSql);
				const txRelationWriteRepo = new PgRelationWriteRepo(txSql);
				const txLedger = new PgSettlementLedgerRepo(txSql);
				const repoOverrides = {
					episodeRepo: txEpisodeRepo,
					cognitionEventRepo: new PgCognitionEventRepo(txSql),
					cognitionProjectionRepo: txCognitionProjectionRepo,
					interactionRepo: deps.interactionRepo,
					relationWriteRepo: txRelationWriteRepo,
					searchProjectionRepo: new PgSearchProjectionRepo(txSql),
					areaWorldProjectionRepo: new PgAreaWorldProjectionRepo(txSql),
					recentCognitionSlotRepo: createThinkerSlotRepo(
						new PgRecentCognitionSlotRepo(txSql),
						batchMode ? effectiveHighestVersion : undefined,
					),
				};

				// ──── Phase 1: Claim ledger state atomically with the projection ────
				// Leader claim failure = another worker has it (or row is zombied <10min ago).
				// We set a flag and throw so the tx rolls back; the outer handler treats
				// this as "not my turn, try next wake-up" (no markFailed).
				try {
					await txLedger.markThinkerProjecting(effectiveSettlementId, payload.agentId);
					projectedMembers.add(effectiveSettlementId);
				} catch (claimErr) {
					leaderClaimFailed = true;
					throw claimErr;
				}

				// Non-leader members: soft-fail — skip this batch's handling of them
				// and merge their episodes into the leader's group so they aren't lost.
				if (batchMode && grouped) {
					for (const memberId of batchMemberSettlementIds) {
						if (memberId === effectiveSettlementId) continue;
						try {
							await txLedger.markThinkerProjecting(memberId, payload.agentId);
							projectedMembers.add(memberId);
						} catch {
							const fallback = grouped.get(memberId) ?? [];
							if (fallback.length > 0) {
								const leaderGroup = grouped.get(effectiveSettlementId);
								if (leaderGroup) leaderGroup.push(...fallback);
								grouped.set(memberId, []);
							}
						}
					}
					effectiveEpisodes = grouped.get(effectiveSettlementId) ?? [];
					for (const memberId of batchMemberSettlementIds) {
						if (memberId !== effectiveSettlementId && projectedMembers.has(memberId)) {
							const eps = grouped.get(memberId) ?? [];
							if (eps.length > 0) perMemberEpisodes.set(memberId, eps);
						}
					}
				}

				// Build params inside the tx (after episode grouping is finalized).
				const params: SettlementProjectionParams = {
					settlementId: effectiveSettlementId,
					sessionId: payload.sessionId,
					agentId: payload.agentId,
					requestId: batchMode
						? effectiveSettlementId.replace(/^stl:/, "")
						: (payload.requestId ?? effectiveSettlementId.replace(/^stl:/, "")),
					cognitionOps: canonicalizedCognitionOps,
					privateEpisodes: effectiveEpisodes,
					publications: canonicalOutcome.publications ?? [],
					areaStateArtifacts: [],
					// Scene-fact writes live on the Talker commit path
					// (turn-service.writeSceneFactCommitsFromTalker). Suppress here to
					// avoid duplicate rows in the append-only scene_area_fact_events table.
					sceneFactCommits: [],
					sceneFactWritePath: deps.sceneFactWritePath ?? false,
					recentCognitionSlotJson,
					committedAt,
					viewerSnapshot,
				};

				// ──── Phase 2: Data writes ────
				// Commit effective settlement (carries cognitionOps, publications)
				const result = await deps.projectionManager.commitSettlement(
					params,
					repoOverrides,
				);
				changedNodeRefs = result.changedNodeRefs;

				// Per-member episode commits (batch mode only)
				for (const [memberId, memberEpisodes] of perMemberEpisodes) {
					const memberParams: SettlementProjectionParams = {
						settlementId: memberId,
						sessionId: payload.sessionId,
						agentId: payload.agentId,
						requestId: memberId.replace(/^stl:/, ""),
						cognitionOps: [],
						privateEpisodes: memberEpisodes,
						publications: [],
						areaStateArtifacts: [],
						recentCognitionSlotJson: "[]",
						committedAt,
						viewerSnapshot,
					};
					const memberResult = await deps.projectionManager.commitSettlement(
						memberParams,
						repoOverrides,
					);
					changedNodeRefs.push(...memberResult.changedNodeRefs);
				}

				const episodeRows = await txEpisodeRepo.readBySettlement(
					effectiveSettlementId,
					payload.agentId,
				);
				const localRefIndex = new Map<
					string,
					{
						kind: "episode" | "publication" | "cognition" | "proposal";
						nodeRef: string;
					}
				>();
				for (const row of episodeRows) {
					if (row.source_local_ref) {
						localRefIndex.set(row.source_local_ref, {
							kind: "episode",
							nodeRef: `episode:${row.id}`,
						});
					}
				}

				const cognitionByKey = new Map<
					string,
					{ kind: CognitionKind; nodeRef: string }
				>();
				for (const op of canonicalizedCognitionOps) {
					if (op.op === "upsert") {
						const projection = await txCognitionProjectionRepo.getCurrent(
							payload.agentId,
							op.record.key,
						);
						if (
							projection &&
							(projection.kind === "assertion" ||
								projection.kind === "evaluation" ||
								projection.kind === "commitment")
						) {
							const nodeRef = `${projection.kind}:${projection.id}`;
							cognitionByKey.set(op.record.key, {
								kind: projection.kind,
								nodeRef,
							});
						}
					}
				}

				if (relationIntents.length > 0) {
					const settledArtifacts: SettledArtifacts = {
						settlementId: effectiveSettlementId,
						agentId: payload.agentId,
						localRefIndex,
						cognitionByKey,
					};
					const resolvedRefs = resolveLocalRefs(
						{ relationIntents, conflictFactors },
						settledArtifacts,
					);
					try {
						const count = await materializeRelationIntents(
							relationIntents,
							resolvedRefs,
							txRelationWriteRepo,
						);
						console.log(
							`[thinker_worker] materialized ${count} relation intents for settlement ${effectiveSettlementId}`,
						);
					} catch (intentErr) {
						console.warn(
							`[thinker_worker] materializeRelationIntents failed (non-fatal):`,
							intentErr,
						);
					}
				}

				const contestedAssertions: Array<{
					cognitionKey: string;
					nodeRef: string;
				}> = [];
				for (const op of canonicalizedCognitionOps) {
					if (
						op.op === "upsert" &&
						op.record.kind === "assertion" &&
						(op.record as AssertionRecordV4).stance === "contested"
					) {
						const projection = cognitionByKey.get(op.record.key);
						if (projection) {
							contestedAssertions.push({
								cognitionKey: op.record.key,
								nodeRef: projection.nodeRef,
							});
						}
					}
				}

				if (conflictFactors.length > 0 || contestedAssertions.length > 0) {
					try {
						const conflictResult = await resolveConflictFactors(
							conflictFactors,
							txCognitionProjectionRepo,
							{
								settlementId: effectiveSettlementId,
								agentId: payload.agentId,
							},
						);
						console.log(
							`[thinker_worker] resolved ${conflictResult.resolved.length} conflict factors (${conflictResult.unresolved.length} unresolved) for settlement ${effectiveSettlementId}`,
						);

						const txRelationBuilder = new RelationBuilder({
							relationWriteRepo: txRelationWriteRepo,
							relationReadRepo: new PgRelationReadRepo(txSql),
							cognitionProjectionRepo: txCognitionProjectionRepo,
						});
						await applyContestConflictFactors(
							txRelationBuilder,
							txCognitionProjectionRepo,
							payload.agentId,
							effectiveSettlementId,
							contestedAssertions,
							conflictResult.resolved.map((f) => f.nodeRef),
							conflictResult.unresolved.length,
						);
					} catch (conflictErr) {
						console.warn(
							`[thinker_worker] conflict factor processing failed (non-fatal):`,
							conflictErr,
						);
					}
				}

				// ──── Phase 3: Mark all projected members as applied (atomic with writes) ────
				// Any failure here rolls back the entire projection — but markApplied is a
				// simple UPDATE with no contention risk once we hold the row (set in Phase 1),
				// so failure here is unexpected and the rollback is the correct response.
				for (const memberId of projectedMembers) {
					await txLedger.markApplied(memberId);
				}
			});
			} catch (err) {
				if (leaderClaimFailed) {
					console.warn(
						`[thinker_worker] leader claim for ${effectiveSettlementId} skipped (row already held or zombied < 10min ago) — will retry on next wake-up: ${err instanceof Error ? err.message : String(err)}`,
					);
					return;
				}
				throw err;
			}
			// [T9] CoreMemoryIndexUpdater conditional trigger (outside tx, LLM call)
			const shouldUpdateIndex =
				canonicalizedCognitionOps.length >= 3 ||
				canonicalizedCognitionOps.some(
					(op) =>
						op.op === "upsert" &&
						(op.record as AssertionRecordV4).stance === "contested",
				);
			if (deps.coreMemoryIndexUpdater && shouldUpdateIndex) {
				try {
					const createdState: CreatedState = {
						episodeEventIds: [],
						assertionIds: [],
						entityIds: [],
						factIds: [],
						changedNodeRefs,
					};
					await deps.coreMemoryIndexUpdater.updateIndex(
						payload.agentId,
						createdState,
						CALL_TWO_TOOLS,
					);
				} catch (indexErr) {
					console.warn(
						"[thinker_worker] coreMemoryIndexUpdater failed (non-fatal):",
						indexErr,
					);
				}
			}
			// [T13] enqueueOrganizerJobs (outside tx)
			if (deps.jobPersistence && changedNodeRefs.length > 0) {
				try {
					await enqueueOrganizerJobs(
						deps.jobPersistence,
						payload.agentId,
						effectiveSettlementId,
						changedNodeRefs,
					);
					console.log(
						`[thinker_worker] enqueued memory.organize jobs (${changedNodeRefs.length} refs) for settlement ${effectiveSettlementId}`,
					);
				} catch (enqueueErr) {
					console.error(
						`[thinker_worker] enqueueOrganizerJobs FAILED — organizer will NOT run for these nodes. ` +
						`settlementId=${effectiveSettlementId}, nodeCount=${changedNodeRefs.length}`,
						enqueueErr,
					);
				}
			}
		} catch (thinkerError: unknown) {
			try {
				const errMsg =
					thinkerError instanceof Error
						? thinkerError.message
						: String(thinkerError);
				await deps.settlementLedger?.markFailed(
					payload.settlementId,
					errMsg,
					true,
				);
				if (batchMode && effectiveSettlementId !== payload.settlementId) {
					await deps.settlementLedger?.markFailed(
						effectiveSettlementId,
						errMsg,
						true,
					);
				}
			} catch (ledgerErr) {
				console.warn(
					"[thinker_worker] markFailed failed (non-fatal):",
					ledgerErr,
				);
			}
			throw thinkerError;
		}
	};
}
