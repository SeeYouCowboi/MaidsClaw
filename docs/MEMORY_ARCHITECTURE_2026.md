# Memory Architecture 2026 (v4 Refactor)

> Status: Updated 2026-03-24. Covers work completed in T1–T35 (V3 refactor).

---

## Overview

The memory subsystem was refactored from a mixed-concern monolith into a layered architecture with clear separation between narrative memory (world-visible events), cognition (private beliefs, evaluations, commitments), retrieval orchestration, and shared blocks. The refactor is compatibility-first: v3 data coexists with v4 in the same database.

---

## 1. v4 Canonical Contracts

### `src/runtime/rp-turn-contract.ts`

This file is the single source of truth for turn outcome types and the v3/v4 normalizer.

Key exports:

- `RpTurnOutcomeSubmissionV4` — v4 turn outcome shape with `publications[]` and `PrivateCognitionCommitV4`
- `PrivateCognitionCommitV4` — ops array with 7-stance assertions, 5-basis values
- `AssertionStance` — `"tentative" | "accepted" | "confirmed" | "contested" | "rejected" | "abandoned" | "superseded"`
- `AssertionBasis` — `"belief" | "inference" | "first_hand" | "introspection" | "axiom"`
- `EPISTEMIC_STATUS_TO_STANCE` — deterministic v3→v4 stance mapping constant
- `BELIEF_TYPE_TO_BASIS` — deterministic v3→v4 basis mapping constant
- `normalizeRpTurnOutcome(raw)` — single entry point; accepts v3 or v4 shape, emits `CanonicalRpTurnOutcome`
- `validateRpTurnOutcome(raw)` — backward-compat alias for `normalizeRpTurnOutcome`

**Normalizer guarantees:**
- `publications: []` and `publications: undefined` are equivalent (always normalized to `[]`)
- `publicReply = ""` with non-empty `publications[]` is valid (no empty-turn rejection)
- `confidence` is stripped; only `stance` and `basis` survive into the canonical shape
- Touch ops are rejected; every op must have a meaningful `stance`

### `src/interaction/contracts.ts` + settlement adapter

`TurnSettlementPayload` carries either a v3 or v4 private commit. The settlement adapter (`normalizeSettlementPayload`) is the single consumer-facing read path:

- `detectSettlementVersion(payload)` — returns `"v3"` if no explicit v4 marker; never guesses
- `normalizeSettlementPayload(payload)` — emits `NormalizedSettlementPayload` with `schemaVersion: "turn_settlement_v4"` and `publications: []`

All consumers (redaction, inspect, local-turn-client, runtime traces) route through the adapter. No consumer has its own v3/v4 branch logic.

---

## 2. Schema Migrations

File: `src/memory/schema.ts`

Migrations are additive `MigrationStep[]` using the `addColumnIfMissing()` pattern. Old columns are never dropped. Every migration is idempotent.

| # | Name | Adds |
|---|------|------|
| 001 | baseline | Core tables: `event_nodes`, `agent_fact_overlay`, `agent_event_overlay`, `logic_edges`, FTS search docs |
| 002 | alias | `alias` and `alias_history` tables |
| 003 | embeddings | `embedding_cache` table |
| 004 | overlay_v2_columns | Canonical columns on `agent_fact_overlay`: `stance`, `basis`, `pre_contested_stance`, `source_label_raw`, `updated_at` |
| 005 | event_overlay_v2 | Canonical columns on `agent_event_overlay`: `target_entity_id`, `updated_at`, `explicit_kind` |
| 006 | publication_provenance | `source_settlement_id`, `source_pub_index`, `visibility_scope` on `event_nodes`; unique index `ux_event_nodes_publication_scope` |
| 007 | relations_and_cognition_index | `memory_relations` table + `search_docs_cognition` / `search_docs_cognition_fts` FTS5 tables |
| 008 | shared_blocks | Six shared-block tables: `shared_blocks`, `shared_block_sections`, `shared_block_admins`, `shared_block_attachments`, `shared_block_patch_log`, `shared_block_snapshots` |
| 009 | widen-memory-relations-unique | Widen `memory_relations` unique constraint to 5-column (adds `source_kind`, `source_ref`); add `updated_at` |
| 010 | shared-block-audit-columns | Add `title` to `shared_block_sections`; add `before_value`, `after_value`, `source_ref` to `shared_block_patch_log` |
| 011 | add-private-episode-events | `private_episode_events` append-only ledger |
| 012 | add-private-cognition-events | `private_cognition_events` append-only ledger |
| 013 | add-private-cognition-current | `private_cognition_current` rebuildable projection table |
| 014 | add-pinned-labels | Widen `core_memory_blocks.label` CHECK to include `pinned_summary`, `pinned_index` |
| 015 | add-area-world-current-projections | `area_state_current`, `area_narrative_current`, `world_state_current`, `world_narrative_current` projection tables with `surfacing_classification` |
| 016 | widen-node-embeddings-kind-check | Expand `node_embeddings.node_kind` CHECK to include canonical cognition kinds (`assertion`, `evaluation`, `commitment`) |
| 017 | drop-agent-event-overlay | Drop `agent_event_overlay` (replaced by `private_cognition_events` + `private_episode_events`) |
| 018 | rebuild-agent-fact-overlay | Rebuild `agent_fact_overlay` without legacy columns: `belief_type`, `confidence`, `epistemic_status` |
| 019 | append-only-triggers | Append-only triggers on both event ledgers; episode idempotency index; `fact_edges` t_valid CHECK constraint |
| 020 | time-columns-to-projections | Add `valid_time` + `committed_time` to `area_state_current` and `world_state_current` (bi-temporal projection layer) |
| 021 | widen-memory-relations-type-check | Extend `memory_relations.relation_type` CHECK to include `surfaced_as`, `published_as`, `resolved_by`, `downgraded_by` |
| 022 | add-node-id-to-node-embeddings | Add `node_id` column to `node_embeddings`, backfilled from `node_ref` (enables `GraphNodeRef` structured lookup) |
| 023 | add-area-state-source-type | Add `source_type` to `area_state_current` (`system` / `gm` / `simulation` / `inferred_world`) |
| 024 | add-persona-to-core-memory-labels | Widen `core_memory_blocks.label` CHECK to include `persona` |
| 025 | add-pinned-summary-proposals-table | `pinned_summary_proposals` table for persistent proposal workflow (status: `pending` / `applied` / `rejected`) |
| 026 | add-retrieval-only-to-shared-blocks | Add `retrieval_only` flag to `shared_blocks` |

**Backfill rules (004):**
- `confirmed` → `confirmed`, `suspected` → `tentative`, `hypothetical` → `hypothetical`, `retracted` → `rejected`
- `observation` → `first_hand`, `inference` → `inference`, `suspicion` → `inference`, `intention` → `introspection`

**Constraints:**
- `agent_fact_overlay`: app-layer check that `stance = 'contested'` must have `pre_contested_stance`
- `memory_relations`: `CHECK(source_node_ref != target_node_ref)` — no self-referencing relations
- `event_nodes`: `ux_event_nodes_publication_scope` unique index for publication idempotency
- `shared_block_attachments`: `CHECK(target_kind = 'agent')` — V1 only supports agent attachment

---

## 3. Cognition Repository

File: `src/memory/cognition/cognition-repo.ts`

`CognitionRepository` is the **single write point** for all private cognition: assertions, evaluations, and commitments. All dual-read/dual-write details are encapsulated here.

### Write semantics

- `upsertAssertion(params)` — enforces 7-stance state machine, dual-writes canonical + compat columns
- `retractCognition(params)` — idempotent; double-retract on an already-retracted key is a no-op
- `syncCognitionSearchDoc(params)` — called after every upsert; keeps `search_docs_cognition` in sync

### Read semantics

- `getAssertions({ agentId, entityId?, stance?, basis? })` — reads canonical `stance`/`basis`; falls back to `epistemic_status`/`belief_type` for legacy rows via `toCanonicalAssertion()`
- `getCommitments({ agentId, mode? })` — active commitments; synthetic `stance` derived from `cognition_status`
- `toCanonicalAssertion(row)` — uses `EPISTEMIC_STATUS_TO_STANCE` / `BELIEF_TYPE_TO_BASIS` for legacy rows with NULL canonical columns

### State machine (7-stance rules)

Valid transitions enforce a directional graph. Key rules:

- Terminal stances (`rejected`, `abandoned`, `superseded`) cannot be written over with a new upsert on the same `cognition_key`
- `contested` requires `pre_contested_stance` to be persisted; the previous stance is captured automatically
- Basis can only move toward stronger evidence (`belief` → `inference` → `first_hand` / `introspection` → `axiom`); downgrades are rejected with `COGNITION_ILLEGAL_BASIS_DOWNGRADE`
- Double-retract (retract an already-rejected key) is silently idempotent

**Error codes:** `COGNITION_ILLEGAL_STANCE_TRANSITION`, `COGNITION_ILLEGAL_BASIS_DOWNGRADE`, `COGNITION_TERMINAL_KEY_REUSE`, `COGNITION_MISSING_PRE_CONTESTED_STANCE`, `COGNITION_DOUBLE_RETRACT`

### Delegation chain

`GraphStorageService` explicit methods → `CognitionRepository`
`ExplicitSettlementProcessor` → `CognitionRepository`
`MemoryTaskAgent.loadExistingContext()` → `CognitionRepository.getAssertions()` + `getCommitments()`

---

## 4. Retrieval Split: Three Layers

The old `RetrievalService` mixed narrative events and private cognition in a single search path. These are now cleanly separated.

### Narrative Layer — `src/memory/narrative/narrative-search.ts`

`NarrativeSearchService` queries only `search_docs_area` and `search_docs_world` FTS5 tables.

- Area search: only when `current_area_id != null`
- World search: always
- **Never touches** `search_docs_private` or `search_docs_cognition`
- Visibility gated on `viewer_agent_id` + `current_area_id`; `viewer_role` is not used here

### Cognition Layer — `src/memory/cognition/cognition-search.ts`

`CognitionSearchService` queries only `search_docs_cognition` and its FTS5 index.

- Accepts `{ agentId, query?, kind?, stance?, basis?, activeOnly?, limit? }`
- Returns `CognitionHit[]` with optional `conflictEvidence?: string[]` for contested hits
- Commitment default: `activeOnly = true` when `kind === "commitment"`
- Commitment sorting: `priority ASC → horizon_rank ASC → updated_at DESC`
- Contested hits are enriched via `RelationBuilder.getConflictEvidence()` (up to 3 conflict refs)

### Orchestrator Layer — `src/memory/retrieval/retrieval-orchestrator.ts`

`RetrievalOrchestrator.search()` resolves the effective `RetrievalTemplate` from `AgentProfile` and dispatches to the narrative and/or cognition layers.

- `RetrievalTemplate`: `narrativeEnabled`, `cognitionEnabled`, `maxNarrativeHits`, `maxCognitionHits`
- `WriteTemplate`: `allowPublications`, `allowCognitionWrites`
- Role-based defaults via `getDefaultTemplate(role)` and `getDefaultWriteTemplate(role)`
- Profile overrides are merged on top of defaults (partial override, not replacement)

**V3 additions to `RetrievalTemplate`:**

| Field | Type | Purpose |
|-------|------|---------|
| `episodeEnabled` | boolean | Toggle episode recall layer |
| `episodeBudget` | number | Base episode slot count |
| `conflictBoostFactor` | number | Multiplier applied when contested cognition is present |
| `queryEpisodeBoost` | number | Auto-boost episodes for queries matching `EPISODE_QUERY_TRIGGER` regex |
| `sceneEpisodeBoost` | number | Boost episodes during scene-opening turns |
| `conflictNotesBudget` | number | Baseline conflict notes slots |

**Adaptive budget (T29):** `RetrievalOrchestrator.search()` accepts an optional trailing `contestedCount` argument. Effective conflict budget = `conflictNotesBudget + min(contestedCount, 3) * conflictBoostFactor`. When `conflictBoostFactor = 0` (maiden / task_agent defaults), the effective budget equals the prior static value.

**Role defaults:**

| Field | rp_agent | maiden | task_agent |
|-------|----------|--------|------------|
| `episodeEnabled` | true | true | false |
| `conflictBoostFactor` | 1 | 0 | 0 |
| `queryEpisodeBoost` | 1 | 1 | 0 |
| `maxNarrativeHits` | 3 | 3 | 0 |
| `maxCognitionHits` | 5 | 0 | 0 |

**Episode auto-boost triggers:** queries matching temporal/recall keywords, scene transitions, and detective/investigation clue queries all receive automatic episode budget increase.

**Cross-type dedup (T29):** active `currentProjectionReader.getActiveCurrent()` rows seed `seenText` from `summary_text` before cognition surface, preventing duplicated entries across projection and cognition search paths.

**Contracts directory:** `src/memory/contracts/` — retrieval-template, write-template, visibility-policy, agent-permissions

---

## 5. Memory Tools

Registered in `src/bootstrap/tools.ts`, implemented in `src/memory/tools.ts`.

| Tool | Description |
|------|-------------|
| `narrative_search` | Searches area + world FTS. Delegates to `NarrativeSearchService`. |
| `cognition_search` | Searches private cognition by kind/stance/basis. Delegates to `CognitionSearchService`. |
| `memory_search` | Compat alias. Identical behavior to `narrative_search`; schema unchanged. |
| `memory_explore` | Beam-expansion graph walk. Upgraded `GraphNavigator` with narrative + cognition seeds and `memory_relations` edge expansion. |

`RP_AUTHORIZED_TOOLS` is 7 entries, including all four above plus `submit_rp_turn`, `memory_store_note`, `memory_flag_for_review`.

### `memory_explore` internals (`src/memory/navigator.ts`)

The `GraphNavigator` now accepts optional `narrativeSearch` and `cognitionSearch` service interfaces (duck-typed). After `localizeSeedsHybrid()`, `collectSupplementalSeeds()` adds:
- Narrative seeds (score 0.7, scope "world")
- Cognition seeds (score 0.6, scope "private")

`getRelatedNodeRefs(nodeRef)` queries `memory_relations` for both source/target directions, adding edges with `kind="fact_relation"`, weight 0.6. All three enhancement paths use try/catch with empty-result fallback.

---

## 6. Shared Blocks V1

### Schema (migration 008)

Six tables: `shared_blocks`, `shared_block_sections`, `shared_block_admins`, `shared_block_attachments`, `shared_block_patch_log`, `shared_block_snapshots`

V1 constraints:
- `target_kind = 'agent'` only (CHECK constraint on `shared_block_attachments`)
- Section paths: `^[a-z0-9_-]+(/[a-z0-9_-]+)*$` — no uppercase, no empty segments, validated by `section-path-validator.ts`
- `patch_seq` is monotonic via `COALESCE(MAX(patch_seq), 0) + 1`
- `move_section` to an existing target path raises `MoveTargetConflictError` (retryable)

### Services

| File | Responsibility |
|------|---------------|
| `src/memory/shared-blocks/shared-block-repo.ts` | CRUD: createBlock (with baseline snapshot seq=0), getBlock, getSections, upsertSection, renameSection, writeSnapshot |
| `src/memory/shared-blocks/shared-block-permissions.ts` | `isOwner`, `isAdmin` (owner or in admins table), `canEdit`, `canRead` |
| `src/memory/shared-blocks/shared-block-attach-service.ts` | `attachBlock` (admin-only, idempotent INSERT OR IGNORE), `detachBlock`, `getAttachments` |
| `src/memory/shared-blocks/shared-block-patch-service.ts` | `applyPatch` — wraps op + log + auto-snapshot in one transaction; auto-snapshot every 25 patches |

All services use duck-typed `DbLike` interfaces to avoid importing the concrete `Database` type.

---

## 7. Compatibility Guarantees

### v3/v4 coexistence

- `normalizeRpTurnOutcome()` accepts v3 or v4 shape; callers never inspect the raw shape themselves
- `detectSettlementVersion()` returns `"v3"` when the explicit v4 marker is absent — no guessing
- `PendingSettlementSweeper` forwards records without inspecting schema version; the processor handles both
- `CognitionRepository.toCanonicalAssertion()` falls back to `EPISTEMIC_STATUS_TO_STANCE` / `BELIEF_TYPE_TO_BASIS` for legacy rows with NULL canonical columns

### Old columns kept

Columns `belief_type`, `confidence`, `epistemic_status` remain in `agent_fact_overlay`. They are:
- Written via dual-write in `CognitionRepository` (compat path)
- Read only as fallback when `stance`/`basis` are NULL (legacy rows)
- Never used as canonical input for any new write path

### Graph organizer read pattern

`src/memory/graph-organizer.ts` reads both `stance` and `epistemic_status`, uses `row.stance ?? row.epistemic_status` for display. Retraction check covers both: `stance === "rejected" || stance === "abandoned" || epistemic_status === "retracted"`.

---

## 8. `viewer_role`: Allowed vs. Forbidden

### Allowed
- Type definition fields (e.g., `AgentProfile.role`)
- Template defaults: `getDefaultTemplate(role)` uses role to select defaults for `RetrievalTemplate` / `WriteTemplate`
- Profile selection / identity configuration

### Forbidden
- `VisibilityPolicy` SQL predicates — `VisibilityPolicy` uses only `viewer_agent_id` and `current_area_id`
- Any SQL `WHERE` clause or retrieval scope gate
- Narrative search visibility gating

This was audited in T19. The only violation found was in `graph-organizer.ts`, which was fixed to use the canonical fallback pattern.

---

## 9. Core Memory Labels (V3)

File: `src/memory/types.ts`, `src/memory/core-memory.ts`

Migration 024 added `persona`. Migration 014 added `pinned_summary` and `pinned_index`. The full label set is now:

| Label | Status | Description |
|-------|--------|-------------|
| `persona` | Canonical writable | Primary agent identity block (T21 forward). The write target for RP tools. |
| `pinned_summary` | Canonical writable | Pinned narrative summary block (T7 forward). |
| `pinned_index` | Read-only compat | Pinned index; `COMPAT_ALIAS_MAP` maps `index` to this. |
| `character` | Read-only compat | Legacy label. `COMPAT_ALIAS_MAP` maps `character` → `pinned_summary` for reads. Not writable via RP tools. |
| `user` | Read-only compat | Legacy label. Readable but no RP direct-write path. |
| `index` | Read-only compat | Legacy alias for `pinned_index`. |

**Key constants:**

- `CANONICAL_PINNED_LABELS = ["pinned_summary", "pinned_index"]` — preferred write targets
- `READ_ONLY_LABELS = ["index", "pinned_index", "character", "user"]` — no direct-write path
- `COMPAT_ALIAS_MAP = { character: "pinned_summary", index: "pinned_index" }` — maps legacy reads
- `BLOCK_DEFAULTS` (in `core-memory.ts`) — 6 entries covering all labels; `character` and `user` default to `read_only = 1`

**Tool enum:** RP tools expose only `["persona"]` as a writable target. The RP tool schema enum intentionally excludes `character`, `user`, `index`, `pinned_index`.

**`PINNED_LABELS`** (prompt-data.ts): `["pinned_summary", "persona"]` — these are rendered into the model's pinned context slot.

---

## 10. V3 New Types

File: `src/memory/types.ts`

### `ExplainDetailLevel`

```
"concise" | "standard" | "audit"
```

Controls how many evidence paths `memory_explore` returns:
- `concise` — top 3 paths only (post-assembly slice)
- `standard` — no change; backward-compatible default
- `audit` — bypasses `maxCandidates` cap in `assembleEvidence`, returning all reranked paths

Added to `MemoryExploreInput.detailLevel?: ExplainDetailLevel`. The `asExploreInput()` discriminator detects this field.

### `MemoryRelationType` + `MemoryRelationRecord`

9 relation types: `supports`, `triggered`, `conflicts_with`, `derived_from`, `supersedes`, `surfaced_as`, `published_as`, `resolved_by`, `downgraded_by`.

**Payload-safe (V3):** `supports`, `triggered` — can be expressed in `relationIntents`.

**Forbidden from payload delegation (forever):**
- `surfaced_as` — projection-assigned ID, must be system-assigned
- `supersedes` — temporal invariant; must stay atomic with settlement
- `resolved_by` — graph closure must be atomic
- `downgraded_by` — temporal mutation

`MemoryRelationRecord` is the full row type for the `memory_relations` table, including `strength`, `directness`, `source_kind`, `source_ref`.

### `CanonicalNodeRefKind` / `LEGACY_NODE_REF_KINDS`

**Canonical (write targets):** `event`, `entity`, `fact`, `assertion`, `evaluation`, `commitment`

**Legacy (read-only compat):** `private_event`, `private_belief` — deprecated in V3 §19; kept for backward-compatible DB reads only.

### `GraphNodeRef`

Structured reference using `node_kind + node_id`. Migration 022 adds a `node_id` column to `node_embeddings`, backfilled from `node_ref` by splitting on `:`. Parsed via `parseGraphNodeRef()`.

### `GraphRetrievalStrategy`

```typescript
type GraphRetrievalStrategy = {
  name: string;
  edgeWeights: Partial<Record<MemoryRelationType, number>>;
  beamWidthMultiplier: number;
};
```

4 named strategies (in `navigator.ts`):

| Strategy | Purpose |
|----------|---------|
| `default_retrieval` | Balanced default; no weight overrides |
| `deep_explain` | Up-weights `derived_from`, `supports` for causal chains |
| `time_slice_reconstruction` | Up-weights `supersedes` for temporal reconstruction |
| `conflict_exploration` | Up-weights `conflicts_with`, `downgraded_by` for opposition view |

`beamWidthMultiplier` is applied in `expandTypedBeam`: `effectiveBeamWidth = ceil(beamWidth * multiplier)`, clamped to `[1, 32]`.

The strategy is wired in three places: `compareNeighborEdges` (sort order), `preliminaryPathScore` (beam pruning), and `rerankPaths` (final ranking). The `explore()` 4th param is optional — omitting it uses `default_retrieval` with no behavior change.

---

## 11. Tool Contracts and Capability Matrix

Files: `src/core/tools/tool-definition.ts`, `src/core/tools/tool-access-policy.ts`

### `ToolExecutionContract`

Attached to `ToolSchema.executionContract`. Describes runtime enforcement metadata:

```typescript
type ToolExecutionContract = {
  effect_type: ToolEffectType;          // read_only | write_private | write_shared | write_world | settlement
  turn_phase: "pre_turn" | "in_turn" | "post_turn" | "any";
  cardinality: "once" | "multiple" | "at_most_once";
  capability_requirements?: string[];   // capability keys from CAPABILITY_MAP
  trace_visibility: TraceVisibility;    // public | debug | private_runtime
};
```

`deriveEffectClass(effectType)` converts `ToolEffectType` to the legacy `EffectClass` — the single source of truth. Tools with an `executionContract` must not set `effectClass` independently.

### `ArtifactContract`

Attached to `ToolSchema.artifactContracts` as a keyed record (one per named output field):

```typescript
type ArtifactContract = {
  authority_level: "agent" | "system" | "admin";
  artifact_scope: "private" | "session" | "area" | "world";
  ledger_policy: "append_only" | "current_state" | "ephemeral";
};
```

`submit_rp_turn` has 8 artifact contracts: `publicReply`, `privateCognition`, `privateEpisodes`, `publications`, `pinnedSummaryProposal`, `relationIntents`, `conflictFactors`, `areaStateArtifacts`.

### CAPABILITY_MAP (11 capabilities)

Maps capability string keys (used in `capability_requirements[]`) to `AgentPermissions` fields:

| Capability key | AgentPermissions field | rp_agent | maiden | task_agent |
|----------------|----------------------|----------|--------|------------|
| `cognition_read` | `canAccessCognition` | true | false | false |
| `cognition_write` | `canWriteCognition` | true | false | false |
| `admin_read` | `canReadAdminOnly` | false | true | false |
| `memory.read.private` | `canReadPrivateMemory` | true | true | false |
| `memory.read.redacted` | `canReadRedactedMemory` | false | true | false |
| `memory.write.authoritative` | `canWriteAuthoritatively` | false | true | false |
| `summary.pin.propose` | `canProposePinnedSummary` | true | false | false |
| `summary.pin.commit` | `canCommitPinnedSummary` | false | true | false |
| `shared.block.read` | `canReadSharedBlocks` | true | true | false |
| `shared.block.mutate` | `canMutateSharedBlocks` | false | true | false |
| `admin.rules.mutate` | `canMutateAdminRules` | false | true | false |

**Two-layer enforcement for `canMutateSharedBlocks`:** the capability gate fires in `tool-access-policy.ts` (tool dispatch level); `SharedBlockPermissions.canEdit(blockId, agentId)` fires inside `SharedBlockPatchService.applyPatch()` (object level). Both must pass.

**Execution gate flow:** `canExecuteTool()` checks three layers in order: (1) allowlist gate, (2) capability requirements via `CAPABILITY_MAP`, (3) cardinality enforcement (`once` / `at_most_once` tools rejected on second call within a turn).

---

## Key File Map

```
src/runtime/
  rp-turn-contract.ts          v4 contracts, normalizer, mapping constants
  submit-rp-turn-tool.ts       tool schema (accepts v3/v4); 8 ArtifactContracts

src/interaction/
  contracts.ts                 TurnSettlementPayload + NormalizedSettlementPayload

src/memory/
  schema.ts                    DDL, migrations 001-026
  storage.ts                   Central write path, dual-write compat
  cognition-op-committer.ts    Legacy committer (now delegates to CognitionRepository)
  explicit-settlement-processor.ts  Settlement flush → CognitionRepository
  task-agent.ts                loadExistingContext via CognitionRepository
  materialization.ts           Publication hot-path materialization (transient retry, 3x backoff)
  pending-settlement-sweeper.ts  Mixed-history flush (version-agnostic)
  retrieval.ts                 Legacy retrieval (narrative path now delegates to NarrativeSearchService)
  navigator.ts                 GraphNavigator, memory_explore beam expansion, GraphRetrievalStrategy
  prompt-data.ts               Renders cognition for model context (PINNED_LABELS = [pinned_summary, persona])
  tools.ts                     narrative_search, cognition_search, memory_search, memory_explore
  graph-organizer.ts           Canonical-read fallback pattern for display
  types.ts                     All memory types: ExplainDetailLevel, MemoryRelationType, GraphNodeRef,
                               CanonicalNodeRefKind, LEGACY_NODE_REF_KINDS, CORE_MEMORY_LABELS,
                               READ_ONLY_LABELS, COMPAT_ALIAS_MAP

  cognition/
    cognition-repo.ts          Single write point for all cognition
    cognition-search.ts        Private cognition FTS search
    relation-builder.ts        conflict_with relations for contested evidence

  narrative/
    narrative-search.ts        Area + world FTS search only

  retrieval/
    retrieval-orchestrator.ts  Template-driven dispatch; adaptive budget (conflictBoostFactor);
                               episode auto-boost; cross-type dedup via projection seeding

  contracts/
    retrieval-template.ts      RetrievalTemplate (V3: episodeBudget, conflictBoostFactor, queryEpisodeBoost)
                               + getDefaultTemplate + resolveTemplate
    write-template.ts          WriteTemplate + getDefaultWriteTemplate
    visibility-policy.ts       Re-export only
    agent-permissions.ts       AgentPermissions (11 fields) + getDefaultPermissions

  shared-blocks/
    section-path-validator.ts  Path regex + assertSectionPath
    shared-block-repo.ts       CRUD + snapshots
    shared-block-permissions.ts  isOwner, isAdmin, canEdit, canRead, canGrantAdmin, isMember,
                               getRole, isRetrievalOnly
    shared-block-attach-service.ts  Attach/detach
    shared-block-patch-service.ts  applyPatch + auto-snapshot (PatchSeqConflictError retryable)

  pinned-summary/
    pinned-summary-proposal-service.ts  PinnedSummaryProposalService (DB-backed, markRejected)

src/core/tools/
  tool-definition.ts           ToolExecutionContract, ArtifactContract, ToolEffectType, deriveEffectClass
  tool-access-policy.ts        CAPABILITY_MAP (11 entries), getFilteredSchemas, canExecuteTool (3-layer)

src/bootstrap/
  tools.ts                     Instantiates all services, registers tools
  runtime.ts                   Assembles MemoryTaskAgent, TurnService, sweeper
```
