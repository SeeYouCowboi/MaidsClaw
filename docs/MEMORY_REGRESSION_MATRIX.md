# Memory Regression Matrix (v4/v5 Refactor)

> Test baseline: **1273 pass, 0 fail** across 85 files (2026-03-21, after T1–T19)
> Runner: `bun test`

Each scenario lists what it proves, the test file(s) that cover it, and the key assertion or guard being validated.

---

## Scenario 1 — v5 Settlement Write + Publication Materialization

**What it proves:** A v5 RP turn with `publications[]` commits a settlement, writes canonical cognition, and materializes visible `event_nodes` with correct provenance — all in one atomic pass.

**Test files:**
- `test/runtime/memory-entry-consumption.test.ts` — mixed v3/v4/v5 settlement integration
- `test/memory/materialization-promotion.test.ts` — publication provenance, idempotency via `ux_event_nodes_publication_scope`
- `test/memory/e2e-rp-memory-pipeline.test.ts` — end-to-end RP memory pipeline

**Key assertions:**
- Each `publications[]` entry creates exactly one `event_nodes` row per `(source_settlement_id, source_pub_index, visibility_scope)`
- Duplicate publication inserts are caught by the unique index and counted as reconciled (not errors)
- `publicReply` alone never creates a publication event row
- `source_record_id` is unchanged; it handles reconciliation only, not publication lineage

---

## Scenario 2 — v3/v4/v5 Mixed-History Sweeper

**What it proves:** `PendingSettlementSweeper` processes a session containing v3, v4, and v5 settlement records without mis-routing or dropping any.

**Test files:**
- `test/runtime/memory-entry-consumption.test.ts` — sweeper mixed v3/v4/v5 coverage
- `src/memory/task-agent.test.ts` — loadExistingContext v3 legacy fallback + canonical read

**Key assertions:**
- Sweeper does not inspect `schemaVersion`; it forwards records to the processor, which handles normalization
- Range advancement (`markProcessed`) covers all records up to `rangeEnd` regardless of settlement version
- Legacy rows (NULL `stance`/`basis`) are canonicalized by `EPISTEMIC_STATUS_TO_STANCE` / `BELIEF_TYPE_TO_BASIS`

---

## Scenario 3 — Cognition State Machine: Illegal Stance Transition

**What it proves:** The 7-stance state machine rejects every illegal transition with a stable error code.

**Test files:**
- `test/memory/cognition-commit.test.ts` — full state machine coverage

**Key assertions:**
- `confirmed → tentative` fails with `COGNITION_ILLEGAL_STANCE_TRANSITION`
- `rejected → tentative` (or any non-terminal) fails with `COGNITION_TERMINAL_KEY_REUSE`
- `contested` write without `pre_contested_stance` fails with `COGNITION_MISSING_PRE_CONTESTED_STANCE`
- Basis downgrade (`first_hand → belief`) fails with `COGNITION_ILLEGAL_BASIS_DOWNGRADE`

---

## Scenario 4 — State Machine: Double-Retract Idempotent

**What it proves:** Retracting an already-retracted cognition key is a silent no-op, not an error.

**Test files:**
- `test/memory/cognition-commit.test.ts` — double-retract idempotency test

**Key assertions:**
- Second retract on `rejected` key returns normally (no exception)
- The row's `stance` remains `rejected`; no duplicate row is created
- `COGNITION_TERMINAL_KEY_REUSE` is NOT raised on retract paths (only on upsert paths)

---

## Scenario 5 — `narrative_search` / `cognition_search` Isolation

**What it proves:** The two search tools have zero scope overlap: narrative search never returns cognition hits, and cognition search never returns narrative hits.

**Test files:**
- `test/memory/retrieval-search.test.ts` — narrative/cognition separation, private docs not surfacing via narrative
- `src/memory/retrieval.test.ts` — RetrievalService delegation to NarrativeSearchService

**Key assertions:**
- `narrative_search` queries only `search_docs_area` + `search_docs_world`; `search_docs_private` and `search_docs_cognition` are never touched
- `cognition_search` queries only `search_docs_cognition`; narrative tables are never touched

---

## Scenario 6 — `memory_search` Retired

**Status: Retired (March 2026).** `memory_search` was removed when `EmbeddingPurpose` was renamed from `"memory_search"` to `"narrative_search"` (T2). The tool is no longer registered.

**What this scenario now tests:** `narrative_search` produces valid embeddings and returns results with the correct `EmbeddingPurpose` value.

**Test files:**
- `test/memory/retrieval-search.test.ts` — narrative search embedding and result shape

**Key assertions:**
- `narrative_search` uses `EmbeddingPurpose = "narrative_search"` (not the retired `"memory_search"` value)
- `narrative_search` schema has no cognition-specific params (`kind`, `stance`, `basis`, `active_only`)
- Tool count is 6 (not 7); `memory_search` is absent from `RP_AUTHORIZED_TOOLS`

---

## Scenario 7 — `cognition_search` by Kind / Stance / Basis

**What it proves:** Cognition search correctly filters by `kind`, `stance`, and `basis` independently and in combination.

**Test files:**
- `test/memory/retrieval-search.test.ts` — CognitionSearchService param filtering
- `test/memory/cognition-commit.test.ts` — search by kind/stance/basis after upsert

**Key assertions:**
- `kind = "commitment"` + `activeOnly = true` excludes rejected/abandoned commitments
- `stance = "contested"` returns only contested assertions
- `basis = "first_hand"` excludes inferred assertions
- Commitment sort order: `priority ASC → horizon_rank ASC → updated_at DESC`

---

## Scenario 8 — Contested Evidence Rendering

**What it proves:** Contested cognition hits include inline conflict evidence from `memory_relations`.

**Test files:**
- `test/memory/retrieval-search.test.ts` — contested evidence inline in search results
- `src/memory/prompt-data.test.ts` — `formatContestedEntry` rendering in model context

**Key assertions:**
- `upsertAssertion` with `stance = "contested"` writes a `conflicts_with` row in `memory_relations`
- `CognitionSearchService` enriches contested hits with up to 3 `conflictEvidence` strings
- `formatContestedEntry` renders `[CONTESTED: was {preContestedStance}] ... | Conflicts: {evidence}`
- `getRecentCognition()` in `prompt-data.ts` delegates contested entries to `formatContestedEntry`

---

## Scenario 9 — `memory_explore` Beam Expansion

**What it proves:** `GraphNavigator` uses narrative seeds, cognition seeds, and `memory_relations` edges in the beam expansion pass.

**Test files:**
- `src/memory/navigator.test.ts` — supplemental seed merge, relation-based expansion, graceful degradation

**Key assertions:**
- Narrative seeds are added at score 0.7; cognition seeds at score 0.6 after `localizeSeedsHybrid()`
- `getRelatedNodeRefs(nodeRef)` queries both `source_node_ref` and `target_node_ref` directions
- Relation edges appear as `kind="fact_relation"`, weight 0.6
- When `memory_relations` table is missing, `getRelatedNodeRefs` returns `[]` (no crash)
- All 6 existing query types (entity/event/why/relationship/timeline/state) remain backward-compatible

---

## Scenario 10 — Shared Blocks CRUD + Auto-Snapshot

**What it proves:** Shared block creation, section patching, permission checks, and the auto-snapshot at every 25 patches all work correctly.

**Test files:**
- `src/memory/shared-blocks/shared-blocks.test.ts` — repo, permissions, attach, patch, auto-snapshot
- `src/memory/shared-blocks/section-path-validator.test.ts` — path regex validation

**Key assertions:**
- `createBlock` writes a baseline snapshot with `snapshot_seq = 0`
- `applyPatch` increments `patch_seq` monotonically; at `patch_seq % 25 === 0` a snapshot is written automatically
- `move_section` to an existing target raises `MoveTargetConflictError` and leaves source unchanged
- Section paths with uppercase, empty segments, or leading/trailing slashes are rejected by `assertSectionPath`
- `attachBlock` is idempotent (`INSERT OR IGNORE`)
- `canEdit` requires `isAdmin`; non-admin detach is rejected

---

## Scenario 11 — `loadExistingContext` Canonical Read

**What it proves:** The context fed to the model contains only `stance`/`basis` — never `confidence` or `epistemic_status`.

**Test files:**
- `src/memory/task-agent.test.ts` — canonical stance/basis in context, legacy fallback, commitment inclusion

**Key assertions:**
- `loadExistingContext()` calls `CognitionRepository.getAssertions()` + `getCommitments()`, not raw SQL
- Assertions return `{ stance, basis }` only; `confidence` is absent from the output
- Legacy rows (NULL `stance`) are canonicalized via the mapping constants, not silently dropped
- Active commitments appear with synthetic `stance = "accepted"`

---

## Scenario 12 — `VisibilityPolicy` Ignores `viewer_role`

**What it proves:** `VisibilityPolicy` SQL predicates depend only on `viewer_agent_id` and `current_area_id`. `viewer_role` cannot affect visibility.

**Test files:**
- `src/memory/visibility-policy.test.ts` — two dedicated tests confirming viewer_role irrelevance

**Key assertions:**
- Changing `viewer_role` on an otherwise identical `ViewerContext` does not change which rows pass the policy
- `VisibilityPolicy` SQL contains no `viewer_role` column reference

---

## Scenario 13 — Schema Migration Idempotency

**What it proves:** Running all 8 migrations twice on the same database produces no error and no duplicate rows or columns.

**Test files:**
- `test/memory/schema.test.ts` — idempotency run, table/index count assertions

**Key assertions:**
- Non-FTS table count = 27 after all migrations (checked via `sql NOT LIKE '%fts5%'`)
- FTS5 virtual table count = 4
- Migration count = 8
- Unique constraint on `ux_event_nodes_publication_scope` blocks duplicate publication rows while allowing NULL provenance

---

## Scenario 14 — `canonical-read` Audit: No `epistemic_status` as Primary Column

**What it proves:** No source file outside the cognition repository reads `epistemic_status` as the primary canonical column. Legacy fallback reads are confined to `cognition-repo.ts` and `graph-organizer.ts` (display-only fallback).

**Test files:**
- `test/memory/schema.test.ts` — graph-organizer canonical read pattern (indirectly via integration)
- `src/memory/visibility-policy.test.ts` — confirms no role-based predicates in visibility SQL

**Key assertions:**
- `graph-organizer.ts` uses `row.stance ?? row.epistemic_status` for display; retraction check covers both fields
- `storage.ts` write path still dual-writes `epistemic_status` (compat only); this is intentional
- No runtime/retrieval/prompt path surfaces `confidence` to the model

---

## Scenario 15 — Bootstrap: All Services Wired

**What it proves:** The runtime bootstrap correctly instantiates `NarrativeSearchService`, `CognitionSearchService`, and `GraphNavigator` with all services, and all 6 RP tools are registered (`memory_search` was retired in March 2026).

**Test files:**
- `test/runtime/bootstrap.test.ts` — preset merge, agent-loader template roundtrip
- `test/runtime/tool-permissions.test.ts` — RP authorized tool count = 6

**Key assertions:**
- `RP_AUTHORIZED_TOOLS` has 6 entries including `narrative_search` and `cognition_search` (`memory_search` retired)
- `GraphNavigator` receives `narrativeSearch` and `cognitionSearch` service instances (not null)
- `AgentProfile.retrievalTemplate` / `writeTemplate` optional fields survive the `toAgentProfile()` roundtrip
- Role defaults (`rp_agent`) correctly set `canAccessCognition = true`, `canWriteCognition = true`

---

## Scenario 16 — Section-18 Architecture Acceptance (Runtime + Memory + E2E)

**What it proves:** Section-18 architecture outcomes are covered as acceptance tests across runtime/memory/e2e suites, including synchronous settlement visibility, cross-session durable recall, contested explain drill-down handoff, area/world surfacing boundary, and explain redaction visibility.

**Test files:**
- `test/runtime/memory-entry-consumption.test.ts` — synchronous settlement visibility in same turn transaction
- `test/runtime/private-thoughts-behavioral.test.ts` — cross-session durable recall + assertion/evaluation separation
- `test/memory/e2e-rp-memory-pipeline.test.ts` — hard-fail (`relationIntents/localRef`) + soft-fail (`conflictFactors[]`) tiers + contested handoff
- `test/e2e/demo-scenario.test.ts` — contested explain shell drill-down + redaction placeholder output
- `test/memory/time-slice-query.test.ts` — time-sliced explain output preserves redacted placeholders

**Key assertions:**
- Synchronous settlement writes cognition/episode/publication and next-turn surfaces without sweeper dependency
- Same-agent cognition remains retrievable across session boundaries
- Contested current rows carry `pre_contested_stance` + `conflict_summary` + normalized factor refs; explain returns drill-down metadata
- `area_visible` projection updates do not auto-roll up into `world_public`
- Explain output keeps hidden hops as redacted placeholders rather than leaking private chain content

---

## Scenario 17 — Legacy Private Path Retirement Audit (Section-18 Follow-up)

> **Retirement status: COMPLETE** (March 2026). `private_event` and `private_belief` are fully removed from all production code as of the legacy-cleanup refactor. `agent_fact_overlay` has been dropped (migration 030). The scenarios below document the acceptance criteria that confirmed the retirement was safe before it was finalized.

**What it proves:** Canonical prompt/tool surface and migration acceptance no longer treat `private_event` / `private_belief` labels as frontstage naming, and new synchronous projection writes do not require legacy private overlays.

**Test files:**
- `test/e2e/demo-scenario.test.ts` — prompt/tool source audit for legacy private names
- `test/runtime/memory-entry-consumption.test.ts` — synchronous projection path visibility checks
- `test/memory/e2e-rp-memory-pipeline.test.ts` — conflict factor soft-fail behavior with stable refs

**Key assertions:**
- Prompt slot definitions and tool descriptions avoid exposing `private_event` / `private_belief` as canonical user-facing surface names (these node kinds are now fully retired from the type system)
- Synchronous projection path materializes section-18 artifacts without waiting for legacy migration loops
- Shape-valid but unresolved conflict factors degrade quality (`resolved/dropped`) instead of aborting settlement

---

## Quick Reference: Test File to Scenario Map

| Test file | Scenarios covered |
|-----------|------------------|
| `test/memory/schema.test.ts` | 13 (migration idempotency, table counts) |
| `test/memory/cognition-commit.test.ts` | 3, 4, 7 (state machine, double-retract, search filters) |
| `test/memory/retrieval-search.test.ts` | 5, 6, 7, 8 (isolation, alias, filters, contested evidence) |
| `test/memory/materialization-promotion.test.ts` | 1 (publication provenance, idempotency) |
| `test/memory/e2e-rp-memory-pipeline.test.ts` | 1 (end-to-end pipeline) |
| `test/memory/visibility-isolation.test.ts` | 5, 12 (scope isolation, viewer_role) |
| `test/runtime/memory-entry-consumption.test.ts` | 1, 2 (settlement write, mixed-history sweeper) |
| `test/runtime/private-thoughts-behavioral.test.ts` | 16 (cross-session durable recall, assertion/evaluation separation) |
| `test/runtime/turn-service.test.ts` | 1 (settlement atomicity) |
| `test/runtime/rp-turn-contract.test.ts` | 3 (normalizer, mapping constants) |
| `test/runtime/bootstrap.test.ts` | 15 (service wiring, tool count) |
| `test/runtime/tool-permissions.test.ts` | 15 (RP_AUTHORIZED_TOOLS = 6) |
| `src/memory/task-agent.test.ts` | 2, 11 (sweeper, loadExistingContext) |
| `src/memory/navigator.test.ts` | 9 (beam expansion, supplemental seeds) |
| `src/memory/prompt-data.test.ts` | 8 (contested rendering) |
| `src/memory/visibility-policy.test.ts` | 12 (viewer_role irrelevance) |
| `src/memory/shared-blocks/shared-blocks.test.ts` | 10 (CRUD, auto-snapshot) |
| `src/memory/shared-blocks/section-path-validator.test.ts` | 10 (path validation) |
| `test/memory/time-slice-query.test.ts` | 16 (time-slice explain redaction continuity) |
| `test/e2e/demo-scenario.test.ts` | 16, 17 (drill-down shell + legacy naming audit) |
