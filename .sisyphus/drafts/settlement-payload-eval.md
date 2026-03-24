# Settlement Payload Extension Evaluation

**Task**: T26 — §21 Settlement Payload 扩展评估
**Date**: 2026-03-24
**Status**: COMPLETE — No extension required for V3

---

## 1. Current State

The RP turn settlement payload is defined across two layers:

### Layer 1: Agent Submission (`RpTurnOutcomeSubmissionV5` in `rp-turn-contract.ts`)

The agent submits via `submit_rp_turn` with these artifact slots:

| Artifact | Type | Scope | Ledger Policy | ArtifactContract |
|---|---|---|---|---|
| `publicReply` | `string` | world | current_state | ✅ Defined |
| `privateCognition` | `PrivateCognitionCommitV4` | private | append_only | ✅ Defined |
| `privateEpisodes` | `PrivateEpisodeArtifact[]` | private | append_only | ✅ Defined |
| `publications` | `PublicationDeclaration[]` | area | append_only | ✅ Defined |
| `pinnedSummaryProposal` | `PinnedSummaryProposal` | session | current_state | ✅ Defined |
| `relationIntents` | `RelationIntent[]` | — | — | ❌ Not in ArtifactContract |
| `conflictFactors` | `ConflictFactor[]` | — | — | ❌ Not in ArtifactContract |

**Cognition ops** support three kinds: `assertion` (with stance lifecycle), `evaluation` (dimensional scoring + emotion tags), `commitment` (goals/intents/plans/constraints/avoidances).

**Private episodes** support four categories: `speech`, `action`, `observation`, `state_change`. The `thought` category is explicitly forbidden.

**Publications** support three kinds: `spoken`, `written`, `visual` with two target scopes: `current_area`, `world_public`.

**Relation intents** link artifacts by `localRef` with `supports` or `triggered` semantics.

**Conflict factors** flag tensions with freeform `kind`/`ref`/`note` (note capped at 120 chars).

### Layer 2: Settlement Record (`TurnSettlementPayload` in `contracts.ts`)

The interaction log's settlement record extends the agent submission with system-injected fields:

| Additional Field | Source | Added By |
|---|---|---|
| `settlementId` | system-generated | settlement pipeline |
| `requestId`, `sessionId` | session context | settlement pipeline |
| `ownerAgentId` | agent identity | settlement pipeline |
| `viewerSnapshot` | viewer context | settlement pipeline |
| `areaStateArtifacts` | area state projection (T18) | system-level injection |

**Key observation**: `areaStateArtifacts` exists only in `TurnSettlementPayload`, NOT in `RpTurnOutcomeSubmissionV5`. Area state is injected by the system during settlement, not submitted by the agent. This is the correct pattern — the agent does not directly write area state via the settlement payload.

### Identified Gaps

1. **`relationIntents` and `conflictFactors` lack ArtifactContract definitions** — they are V5 additions in the schema but `SUBMIT_RP_TURN_ARTIFACT_CONTRACTS` in `submit-rp-turn-tool.ts` only covers 5 of 7 payload slots. This is a T27 concern (ArtifactContract + Capability Matrix), not a T26 concern.
2. **No `latentScratchpad` ArtifactContract** — this is intentionally ephemeral (trace-only, not a durable artifact), so no contract is needed.

---

## 2. Candidate Extensions (from §21)

### Candidate A: More Granular Publication/Promotion Request Body

**Proposal**: Extend `PublicationDeclaration` with richer metadata — e.g., `audience`, `deliveryMode`, `priority`, `contentBody` (structured content beyond summary), or promotion scheduling hints.

**V3 Task Dependency Analysis**:
- **T25** (Publication Materialization Consistency): Focuses on idempotency keys (`settlement_id + publication_index`), retry logic, and null-storage handling. Operates on the *materialization pipeline*, not the payload shape. **Does not need payload changes.**
- **T31** (Publication Second Semantic Axis RFC): Pure design document evaluating a second axis. If a second axis is approved, it would be V4 work. **Does not need payload changes now.**
- **T32** (Settlement Graph + Relation Intent Extension RFC): Pure design document. **Does not need payload changes.**

### Candidate B: Episode → Cognition Relation Payload

**Proposal**: Add explicit `episodeCognitionLinks` or extend `relationIntents` to support typed episode-to-cognition linking (e.g., "this episode triggered this assertion update").

**V3 Task Dependency Analysis**:
- **`relationIntents` already provides this capability.** An agent can emit `{ sourceRef: "ep_001", targetRef: "cog_assertion_trust", intent: "triggered" }` to link an episode to a cognition op. The `localRef` mechanism on both `PrivateEpisodeArtifact` and `PrivateCognitionCommitV4` enables cross-referencing.
- The projection layer (T13 Symbolic Relation Layer, already complete) consumes `relationIntents` to create graph edges. **No payload change needed — the mechanism already exists.**

### Candidate C: Candidate-Only / Derive-Only Artifacts

**Proposal**: Introduce a `materializationPolicy` field on artifacts (e.g., `"immediate" | "candidate" | "derive_only"`) to support deferred materialization — artifacts that enter the system as candidates but don't materialize until a later confirmation step.

**V3 Task Dependency Analysis**:
- No V3 task (T25-T38) requires deferred materialization semantics.
- T25 improves materialization *reliability* (idempotency, retry), not materialization *timing*.
- Deferred/candidate patterns would require a confirmation protocol, a pending-artifacts store, and UI/agent mechanisms to confirm — all V4+ scope.
- **No current task needs this.**

---

## 3. Constraint Analysis

### Frozen Boundary: `rp-turn-contract.ts`

Per Metis G3 review, `rp-turn-contract.ts` is a frozen boundary. Modifications require:
1. Strong rationale (a V3 task is genuinely blocked without the change)
2. Backward compatibility (existing settlements remain parseable)
3. Additive-only changes (no removal or semantic change of existing fields)

**Assessment**: None of the three candidates meet criterion (1). No V3 task is blocked by the current payload surface.

### `submit_rp_turn` Focus

The tool must remain a focused settlement endpoint. Adding candidate/derive artifacts would require lifecycle management (confirmation, rejection, expiry) that belongs in a separate system, not in a single terminal settlement tool.

### Backward Compatibility

The current schema version `rp_turn_outcome_v5` is stable. Any extension would require either:
- A V6 schema bump (breaking change, requires migration)
- Optional additive fields (safe but adds complexity for no V3 benefit)

---

## 4. Recommendation

| Candidate | Decision | Rationale |
|---|---|---|
| **A: Granular publication body** | **DEFER** | No V3 task requires it. T31 (Publication Second Axis) is a design RFC that will inform V4 payload shape. Premature extension would constrain design space. |
| **B: Episode → cognition relation** | **EXCLUDE** | Already expressible via `relationIntents` + `localRef`. Adding a dedicated field would duplicate existing capability. |
| **C: Candidate-only / derive-only** | **DEFER** | No V3 task requires deferred materialization. Would need substantial infrastructure (pending store, confirmation protocol) that is V4+ scope. |

### Overall Verdict

**No settlement payload extension is necessary for V3.** The current `RpTurnOutcomeSubmissionV5` schema is sufficient for all tasks T25-T38.

The only gap identified — missing `ArtifactContract` definitions for `relationIntents` and `conflictFactors` — is metadata completeness, not a payload shape problem. This should be addressed in **T27** (ArtifactContract + Capability Matrix) which is the natural home for that work.

---

## 5. Implementation Plan

### No code changes required.

Since all candidates are DEFER or EXCLUDE, no payload extension is implemented. The frozen boundary remains untouched.

### Actions for downstream tasks:

1. **T27** should add `ArtifactContract` entries for `relationIntents` and `conflictFactors` to `SUBMIT_RP_TURN_ARTIFACT_CONTRACTS`:
   ```typescript
   relationIntents: {
     authority_level: "agent",
     artifact_scope: "private",   // relations are agent-declared, not world-visible
     ledger_policy: "append_only",
   },
   conflictFactors: {
     authority_level: "agent",
     artifact_scope: "private",
     ledger_policy: "ephemeral",  // conflict factors are per-turn signals
   },
   ```
   (These are suggestions for T27, not changes made here.)

2. **T32** (Settlement Graph RFC) should reference this evaluation when deciding which relation intent types to open — the current `supports`/`triggered` set is sufficient for V3, but T32 may recommend V4 additions.

3. **T31** (Publication Second Axis RFC) should reference this evaluation when proposing payload changes — any new publication axis is V4 scope and should be a new schema version.

### Future Work (V4 candidates)

- Publication second semantic axis (pending T31 RFC)
- Candidate/derive materialization policy (requires confirmation protocol design)
- Richer relation intent vocabulary (pending T32 RFC)
- Area state artifact submission by agent (currently system-only, by design)

---

## Appendix: ArtifactContract Coverage Matrix

| Payload Slot | In RpTurnOutcomeV5 | In TurnSettlementPayload | Has ArtifactContract | Notes |
|---|---|---|---|---|
| publicReply | ✅ | ✅ | ✅ | Core output |
| latentScratchpad | ✅ | — | — | Ephemeral/trace-only, no contract needed |
| privateCognition | ✅ | ✅ | ✅ | Cognition ops |
| privateEpisodes | ✅ | ✅ | ✅ | Episode records |
| publications | ✅ | ✅ | ✅ | Publication declarations |
| pinnedSummaryProposal | ✅ | ✅ | ✅ | Summary proposals |
| relationIntents | ✅ | ✅ | ❌ → T27 | V5 addition, needs contract |
| conflictFactors | ✅ | ✅ | ❌ → T27 | V5 addition, needs contract |
| areaStateArtifacts | — | ✅ | — | System-injected only |
| viewerSnapshot | — | ✅ | — | System metadata |
| settlementId/requestId/etc. | — | ✅ | — | System metadata |
