# Memory V3 Hardening and Final Cutover

## TL;DR
> **Summary**: Finish the remaining Memory V3 hardening work as a verification-first cutover. Audit the real gaps, produce a surface authority matrix, harden only the parts that still fail the audit, complete the residual §19 cleanup work, and align the regression suite with the final canonical architecture. Explicitly out of scope: organizer durability, search/FTS repair contracts, settlement single-timestamp enforcement, area/world historical ledgers.
>
> **Deliverables**:
> - One preflight audit matrix covering §19, §15, §6, §12, and §5, plus a surface authority matrix classifying every data surface
> - At most two new memory migrations, only if the audit proves they are required
> - Graph relation semantics (§6), time-slice read accuracy (§5), and publication convergence (§12) verified or corrected for in-scope surfaces only (not organizer-derived or search/FTS surfaces)
> - Residual §19 cutover artifacts completed (`memory-replay`, `memory-verify` with documented coverage boundaries, delete-readiness checklist, dead-type cleanup)
> - Test suite rewritten/cleaned so no kept test depends on removed legacy code
>
> **Effort**: Large
> **Parallel**: YES - 5 waves
> **Critical Path**: 1 → 2 → (3,4,5) → 6 → 7 → F1-F4

## Context

### Original Request
Generate a complete executable plan for the remaining Memory V3 hardening/cutover work. The plan must cover the five identified chains — §19 legacy cleanup, §15 DB integrity, §6 graph edge view unification, §12 publication/materialization consistency, and §5 time-slice productization — and it must also align/clean tests that still depend on removed legacy code.

### Interview Summary
- The user first asked whether the deferred Memory V3 items were truly necessary.
- Repo-grounded discussion identified five concrete chains that still matter for correctness and cutover safety.
- The user then asked for deep code-level examples and upstream/downstream chain maps for each issue.
- Final direction: produce one executable plan, not more discussion, and include test cleanup wherever old tests still encode removed legacy behavior.

### Metis Review (gaps addressed)
- Reframed this as a **completion + verification** plan, not a fresh implementation plan.
- Confirmed that much of §6/§12/§5/§15 appears already implemented; the plan must therefore be **audit-first** and change code only where the audit still finds a real gap.
- Re-scoped §19 to current reality: `agent_fact_overlay` has already been dropped, so remaining work is replay/integrity/checklist/dead-compat cleanup rather than old dual-write migration work.
- Added guardrails: no reimplementation of already-completed V3 work, no new event bus, no gateway/CLI/persona/lore changes, no more than two new migrations, and no test deletion without proof that the corresponding production path is intentionally gone.

## Work Objectives

### Core Objective
Produce a decision-complete hardening/cutover sequence that leaves the memory stack's **in-scope surfaces** in one canonical, test-backed state: no stale legacy fallback dependencies, no unresolved integrity/idempotency gaps in canonical ledger and sync projection surfaces, no graph relation semantic drift (§6) or time-slice read leaks (§5) in the navigator runtime path, no publication convergence gaps (§12), and no regression tests anchored to removed internals. Explicitly deferred to future plans: organizer-derived surface durability, search/FTS repair contracts, settlement single-timestamp convergence, area/world historical ledger capability.

### Deliverables
- Preflight audit artifact for all five chains with GREEN/AMBER/RED status
- Integrity/idempotency fixes only where the audit proves a real gap
- Graph relation semantics preserved end-to-end where the audit proves a loss point
- Time-slice reads made fully query-time-aware where the audit proves current/projection bypasses
- Publication live path and recovery path converged on one idempotent observable outcome where the audit proves inconsistency
- Residual §19 completion artifacts: replay verification, projection integrity verification, delete-readiness checklist, dead compat cleanup
- Regression suite aligned with final behavior; legacy-dependent tests either rewritten or deleted with proof

### Definition of Done (verifiable conditions with commands)
- [ ] `bun test` passes with 0 failures
- [ ] `bun run build` passes with 0 type errors
- [ ] `bun run check:legacy-memory-surface` passes
- [ ] `bun test test/memory/schema.test.ts` passes
- [ ] `bun test test/memory/validation-publication-pipeline.test.ts` passes
- [ ] `bun test test/memory/materialization-promotion.test.ts` passes
- [ ] `bun test test/memory/validation-turn-settlement.test.ts` passes
- [ ] `bun test src/memory/publication-recovery-sweeper.test.ts` passes
- [ ] `bun test test/memory/e2e-rp-memory-pipeline.test.ts` passes
- [ ] `bun test src/memory/stress-time-slice.test.ts` passes
- [ ] `bun test test/memory/time-slice-query.test.ts` passes
- [ ] `bun test test/memory/validation-time-model.test.ts` passes
- [ ] Grep `agent_fact_overlay` in `src/**/*.ts` excluding `src/memory/schema.ts` returns 0 matches
- [ ] Grep `AgentFactOverlay` in `src/**/*.ts` returns 0 matches (already true — only occurrence is in guard test `test/memory/legacy-literal-gate.test.ts:21` which is intentionally kept)
- [ ] Grep `relation_type as NavigatorEdgeKind` in `src/memory/navigator.ts:expandRelationEdges` returns 0 matches (only the memory_relations coercion; logic_edges/semantic_edges casts are type-safe and out of scope)
- [ ] Grep `\.skip\(|\.todo\(` in `test/**/*.ts` returns 0 matches

### Must Have
- Preflight audit runs before any production mutation
- Next migration number is discovered from `src/memory/schema.ts` before adding any migration
- No more than two new memory migrations are added, and only if Task 1 proves they are necessary
- Append-only ledger guarantees from `memory:019` remain intact
- Graph relation semantics stay typed end-to-end wherever `memory_relations.relation_type` is consumed
- Time-slice filtering is applied at query/read time for all in-scope current/projection reads, not only after broad retrieval
- Publication live path and recovery path share one idempotency story
- Each code-changing task updates directly dependent tests in the same task
- Any deleted test is mapped to a removed production path or a rewritten replacement

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Must NOT re-implement already completed V3/legacy-cleanup/review-remediation work unless Task 1 proves a real regression
- Must NOT reference `agent_fact_overlay` as a live table or restore any overlay dual-read/dual-write path
- Must NOT create a new event bus, new projection subsystem, or new graph abstraction layer
- Must NOT touch gateway, CLI, persona, lore, or agent lifecycle code
- Must NOT remove the `legacy:` settlement-id prefix in `src/memory/storage.ts` during this plan
- Must NOT remove backward-compatible `asOfValidTime` / `asOfCommittedTime` tool support during this plan
- Must NOT remove snake_case compat handling in `src/memory/navigator.ts` unless zero-dependency proof is captured first
- Must NOT remove the contested-write safety rejection in `src/memory/task-agent.ts` during this plan
- Must NOT delete tests before replacement coverage or proof-of-removal is captured
- Must NOT wire graph-organizer into durable retry / job dispatcher in this cutover (the fire-and-forget pattern at task-agent.ts:456 is a known durability gap, and the job dispatcher infrastructure at jobs/dispatcher.ts exists, but connecting them is new feature work beyond hardening scope — classify in Task 1's authority matrix as "async derived, not durable" and leave for a future plan)
- Must NOT enforce single-timestamp for settlement commits (projection-manager.ts:90/:202 and store.ts:246 use separate Date.now() — classify the settlement clock concern in Task 1's authority matrix but do not change the settlement pipeline)
- Must NOT define or implement a search/FTS repair contract in this cutover (search_docs_* tables have mixed sync/async write paths per the authority matrix — some are sync-maintained by CognitionRepository and GraphStorageService, some are async-refreshed by graph-organizer. Defining a unified repair path and handling syncFtsRow failures are future work; this cutover only classifies write paths in the authority matrix)

## Verification Strategy
> ZERO HUMAN INTERVENTION — all verification is agent-executed.
- Test decision: tests-after with mandatory baseline-before-change on every task
- QA policy: every task includes one happy-path and one failure/edge-path scenario
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.txt`
- Baseline gate for every code-changing task:
  - `bun run build`
  - `bun run check:legacy-memory-surface`
  - module-specific `bun test ...` commands listed in that task

## Execution Strategy

### Parallel Execution Waves
> This is intentionally a small-wave hardening plan. Do NOT split further: the remaining work edits overlapping memory files, migrations must stay sequential, and several tasks collapse to evidence-only if Task 1 returns GREEN.

Wave 1:
- Task 1 — Preflight audit and gap matrix

Wave 2:
- Task 2 — DB integrity and idempotency hardening

Wave 3:
- Task 3 — Graph edge semantic preservation
- Task 4 — Time-slice current/projection correctness
- Task 5 — Publication/materialization convergence

Wave 4:
- Task 6 — Residual §19 cutover completion and dead compat cleanup

Wave 5:
- Task 7 — Test alignment and legacy-dependent test cleanup

### Dependency Matrix (full, all tasks)

| Task | Depends On | Blocks | Wave |
|------|------------|--------|------|
| 1 | — | 2,3,4,5,6,7 | 1 |
| 2 | 1 | 5,6,7 | 2 |
| 3 | 1 | 6,7 | 3 |
| 4 | 1 | 6,7 | 3 |
| 5 | 1,2 | 6,7 | 3 |
| 6 | 1,2,3,4,5 | 7 | 4 |
| 7 | 1,2,3,4,5,6 | F1-F4 | 5 |

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 1 task → `deep`
- Wave 2 → 1 task → `deep`
- Wave 3 → 3 tasks → `unspecified-high`, `deep`, `deep`
- Wave 4 → 1 task → `unspecified-high`
- Wave 5 → 1 task → `unspecified-high`

## TODOs
> Implementation + Test = ONE task. Never separate.
> Every task begins with a baseline run of the listed commands before changing code.

- [x] 1. Run preflight audit, produce gap matrix, and produce surface authority matrix

  **What to do**: Run a zero-mutation preflight across the five target chains and record an explicit GREEN/AMBER/RED matrix before touching production code. The audit must verify the current reality of §19, §15, §6, §12, and §5, discover the current highest migration number in `src/memory/schema.ts`, and classify each chain as `no-code-change-needed`, `test-only`, or `code+test required`.

  **Additionally, produce a Surface Authority Matrix** classifying every memory and interaction-layer data surface into exactly one category:
  - **Canonical ledger**: append-only truth source, protected by triggers (e.g. `private_cognition_events`, `private_episode_events` — schema.ts:100-112 enforces no-update/no-delete)
  - **Canonical mutable store**: authoritative truth source that supports upserts/soft-deletes, NOT rebuildable from another surface (e.g. `event_nodes` :51, `entity_nodes` :63, `fact_edges` :60 with bitemporality via `t_valid`/`t_invalid`, `memory_relations` :76, `core_memory_blocks` :70, `shared_blocks` :117, `logic_edges` :56, `topics` :59)
  - **Sync projection**: deterministically rebuildable from ledger in same transaction (e.g. `private_cognition_current` — rebuildable from `private_cognition_events`)
  - **Async derived**: produced by fire-and-forget post-commit work, not currently durable (e.g. `node_scores`, `node_embeddings`, `semantic_edges` — populated by graph-organizer which runs as void Promise after COMMIT at task-agent.ts:456)
  - **Mixed sync/async search surface**: search_docs tables have MULTIPLE write paths — do NOT classify under a single blanket. Specifically: `search_docs_cognition` is sync-maintained by `CognitionRepository.syncCognitionSearchDoc()` (cognition-repo.ts:981-1021); `search_docs_area`/`search_docs_world`/`search_docs_private` have sync write paths via `GraphStorageService.syncSearchDoc()` at event creation (storage.ts:206-214) and promotion (promotion.ts:334-336), PLUS async refresh via graph-organizer (graph-organizer.ts:398-401). Classify each table individually with its write paths listed.
  - **Cache / prompt surface**: append+trim convenience surface, not canonical (e.g. `recent_cognition_slots` in interaction/schema.ts:66 — trim-to-64 prompt cache, rebuildable from `private_cognition_current` + settlement data)
  - **Repair/maintenance infra**: internal scheduling/state tables (e.g. `_memory_maintenance_jobs`, `_memory_runtime_state`, `_migrations`)
  - **Current-only projection**: overwrite-in-place without historical ledger (e.g. `area_state_current`, `area_narrative_current`, `world_state_current`, `world_narrative_current` — migration 020 only added time columns, not a history ledger)

  For each surface: record its authority class, upstream truth source, whether it allows eventual consistency, whether it must be rebuildable, current replay/verify coverage (YES/NO), **clock source / time semantics** (which `Date.now()` or passed-in timestamp populates its time columns — this is critical because settlement currently uses multiple independent clocks: projection-manager.ts:90, :202; turn-service.ts:1029; store.ts:246), and known gaps.

  This matrix is a **mandatory prerequisite** for Tasks 4, 5, 6 — they depend on knowing which surfaces are authoritative vs derived vs disposable.

  Save all findings to `.sisyphus/evidence/task-1-preflight-audit.txt` and update the work log with concrete file references for every AMBER/RED finding.
  **Must NOT do**: Must NOT change source, tests, or migrations. Must NOT assume old plan state; discover current state from code.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: cross-cutting audit across migrations, retrieval, projection, and test infrastructure
  - Skills: []
  - Omitted: [`git-master`] — no git work required in the audit itself

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 2,3,4,5,6,7 | Blocked By: none

  **References**:
  - Pattern: `src/memory/schema.ts` — discover actual migration count, existing 028-032 cutover work, and full DDL for authority classification (canonical tables at :51-:98, projections at :106, search surfaces at :81-:92, maintenance at :48)
  - Pattern: `src/memory/schema.ts:535` — migration 020: added time columns to area/world current, confirms current-only (no historical ledger)
  - Pattern: `src/interaction/schema.ts:66` — `recent_cognition_slots` DDL: session+agent keyed, trim-to-64 prompt cache
  - Pattern: `src/memory/navigator.ts` — verify graph semantic preservation and time-slice loss points
  - Pattern: `src/memory/graph-edge-view.ts` — verify current read semantics and failure behavior
  - Pattern: `src/memory/materialization.ts` — verify publication live-path / retry-path consistency
  - Pattern: `src/memory/projection/projection-manager.ts` — verify settlement/materialization boundary; note multi-clock: `Date.now()` at :90 and separate `Date.now()` at :202
  - Pattern: `src/memory/projection/area-world-projection-repo.ts` — verify current/projection time-slice behavior
  - Pattern: `src/memory/task-agent.ts:456` — fire-and-forget organizer call after COMMIT; classify graph-organizer outputs as async-derived
  - Pattern: `src/interaction/store.ts:214-246` — `upsertRecentCognitionSlot`: append+trim cache with its own `Date.now()` at :246
  - Test: `test/memory/schema.test.ts` — migration and append-only integrity baseline
  - Test: `test/memory/legacy-literal-gate.test.ts` — legacy-surface baseline gate
  - Test: `test/memory/validation-publication-pipeline.test.ts` — publication routing baseline

  **Acceptance Criteria**:
  - [ ] `bun run build` succeeds before any code changes
  - [ ] `bun run check:legacy-memory-surface` succeeds
  - [ ] `bun test test/memory/schema.test.ts` succeeds
  - [ ] `bun test test/memory/validation-publication-pipeline.test.ts` succeeds
  - [ ] `bun test test/memory/materialization-promotion.test.ts` succeeds
  - [ ] `bun test test/memory/validation-turn-settlement.test.ts` succeeds
  - [ ] `bun test src/memory/stress-time-slice.test.ts` succeeds
  - [ ] Evidence file records current migration count and explicit GREEN/AMBER/RED status for §19, §15, §6, §12, §5
  - [ ] §6 assessment distinguishes the 3 `as NavigatorEdgeKind` sites: `expandRelationEdges` (the real §6 issue) vs `expandEventFrontier`/`expandSemanticEdges` (type-safe, out of scope)
  - [ ] Evidence file includes a **Surface Authority Matrix** covering every memory + interaction-layer table with columns: authority class (canonical ledger / canonical mutable store / sync projection / async derived / mixed sync+async search surface / cache / repair infra / current-only projection), upstream truth source, allows eventual consistency (Y/N), must be rebuildable (Y/N), current replay/verify coverage (Y/N), clock source / time semantics, known gaps. This matrix is required before Tasks 4, 5, 6 proceed.
  - [ ] Authority matrix explicitly classifies `recent_cognition_slots` as prompt cache (not canonical projection), with note on rebuild path from `private_cognition_current` + settlement data
  - [ ] Authority matrix explicitly classifies graph-organizer-only outputs (`node_scores`, `node_embeddings`, `semantic_edges`) as async-derived / fire-and-forget / not currently durable, with note that the job infrastructure at `jobs/dispatcher.ts` exists but is not yet wired to organizer
  - [ ] Authority matrix classifies each `search_docs_*` table INDIVIDUALLY (not as a blanket wildcard): `search_docs_cognition` as mixed with sync path via CognitionRepository; `search_docs_area`/`world`/`private` as mixed with sync path via GraphStorageService.syncSearchDoc() + async refresh via graph-organizer. Each entry lists its specific write paths.
  - [ ] Evidence file includes script coverage gap assessment for Task 6: which tables `memory-replay.ts` / `memory-verify.ts` cover, which they skip, and whether extension is needed for cutover safety — cross-referenced against the authority matrix
  - [ ] Evidence file lists every remaining legacy-dependent test candidate with disposition: keep / rewrite / delete

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Baseline memory stack is green
    Tool: Bash
    Steps: Run `bun run build && bun run check:legacy-memory-surface && bun test test/memory/schema.test.ts && bun test test/memory/validation-publication-pipeline.test.ts && bun test test/memory/materialization-promotion.test.ts && bun test test/memory/validation-turn-settlement.test.ts && bun test src/memory/stress-time-slice.test.ts`
    Expected: All commands pass without editing the repo
    Evidence: .sisyphus/evidence/task-1-preflight-audit.txt

  Scenario: Audit catches real red flags instead of assuming old plan state
    Tool: Grep + AST grep
    Steps:
      1. Search for `agent_fact_overlay`, `AgentFactOverlay`, and `.skip(` / `.todo(` in current source/test files
      2. Search for `relation_type as NavigatorEdgeKind` in `src/memory/navigator.ts` — expect 3 hits. Classify each:
         - `expandRelationEdges` (~line 1127): §6 expected AMBER — MemoryRelationType coerced to NavigatorEdgeKind (no literal overlap). Runtime value is preserved (navigator.test.ts:547 and :683 pass), but static types and downstream scoring (edgePriorityScore, calculateQueryIntentMatch, calculateSupportScore) are misaligned
         - `expandEventFrontier` (~line 650): §6 GREEN — LogicEdgeType is subset of NavigatorEdgeKind (safe cast)
         - `expandSemanticEdges` (~line 1153): §6 GREEN — SemanticEdgeType is subset of NavigatorEdgeKind (safe cast)
      3. Assess `scripts/memory-replay.ts` and `scripts/memory-verify.ts` coverage scope for Task 6:
         - Record which tables each script covers vs skips
         - Note `memory-verify.ts` LIMIT 10 and row-count-only verification
         - Determine if publication/materialization/projection domains need script coverage for cutover safety
    Expected: Evidence records exact match counts, file paths, per-hit §6 classification, and script coverage gap assessment
    Evidence: .sisyphus/evidence/task-1-preflight-audit.txt
  ```

  **Commit**: NO | Message: `verify(memory): baseline audit` | Files: `.sisyphus/evidence/task-1-preflight-audit.txt`

- [x] 2. Enforce DB integrity and idempotency only for audit-proven gaps

  **What to do**: If Task 1 reports AMBER/RED on §15 or idempotency prerequisites for §12, tighten the minimum necessary database invariants. Work in this order: (1) add/extend an audit test that reproduces the exact integrity/idempotency gap, (2) repair or normalize existing data in code/migration-safe form, (3) add constraints/indexes/triggers only after the repair path exists, (4) update tests and evidence. If Task 1 reports §15 GREEN, convert this task into an evidence-only verification task and do not add a migration. Discover the next migration number from `src/memory/schema.ts` before creating any new migration.
  **Must NOT do**: Must NOT add more than one migration in this task unless Task 1 proves both repair and enforcement cannot fit safely into one step. Must NOT weaken append-only triggers. Must NOT enforce FK/unique constraints before handling violating rows or proving zero violators.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: data-shape safety, migration sequencing, and rollback-sensitive integrity work
  - Skills: []
  - Omitted: [`git-master`] — implementation focus, not git workflow

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: 5,6,7 | Blocked By: 1

  **References**:
  - Pattern: `src/memory/schema.ts: memory:019 and later migrations` — existing append-only and cutover migration patterns
  - Pattern: `src/storage/database.ts` — foreign-key runtime behavior and DB bootstrap assumptions
  - Pattern: `src/memory/cognition/cognition-event-repo.ts` — event append path that must remain legal
  - Pattern: `src/memory/cognition/cognition-repo.ts` — projection/update paths affected by constraints
  - Test: `test/memory/schema.test.ts` — place to add failing/green migration and constraint assertions
  - Script: `scripts/memory-verify.ts` — candidate location for integrity verification reuse

  **Acceptance Criteria**:
  - [ ] Baseline commands from Task 1 pass before edits
  - [ ] If a new migration is added, its number is the next sequential `memory:NNN` discovered from current schema state
  - [ ] `bun test test/memory/schema.test.ts` contains a failing case for the exact integrity/idempotency gap before the fix, then passes after the fix
  - [ ] `bun run build` passes after changes
  - [ ] `bun run check:legacy-memory-surface` still passes
  - [ ] Evidence file records whether this task was code-changing or verification-only and why

  **QA Scenarios**:
  ```
  Scenario: Invalid duplicate/orphan shape is rejected or repaired deterministically
    Tool: Bash
    Steps: Run the targeted schema/integrity test file that seeds the offending row shape discovered by Task 1
    Expected: Before fix it fails for the intended reason; after fix it either repairs safely or rejects deterministically
    Evidence: .sisyphus/evidence/task-2-db-integrity.txt

  Scenario: Append-only behavior remains intact
    Tool: Bash
    Steps: Run `bun test test/memory/schema.test.ts` covering update/delete rejection on event ledgers
    Expected: Existing append-only checks remain green after any new integrity enforcement
    Evidence: .sisyphus/evidence/task-2-db-integrity.txt
  ```

  **Commit**: YES | Message: `harden(memory): enforce integrity and idempotency invariants` | Files: `src/memory/schema.ts`, `test/memory/schema.test.ts`, optional integrity helper/test files

- [x] 3. Preserve graph relation semantics end-to-end

  **What to do**: §6 is expected to be **AMBER, not pure RED**: existing runtime tests (`navigator.test.ts:547` — "preserves memory relation semantic kind" and `navigator.test.ts:683` — "conflict_exploration strategy upweights conflicts_with edges") already pass green because the runtime value of `edge.kind` is the original `MemoryRelationType` literal despite the incorrect static type. The real issues are: (a) the static type `BeamEdge.kind: NavigatorEdgeKind` is a lie, and (b) downstream scoring functions (`edgePriorityScore` at line 1334, `calculateQueryIntentMatch` at line 1484, `calculateSupportScore` at line 1493) silently penalize or ignore memory relation edges because their `kind` values don't appear in `QUERY_TYPE_PRIORITY`.

  Only if Task 1 confirms this AMBER assessment, fix the type/scoring misalignment **specifically in `expandRelationEdges`** (navigator.ts ~line 1127) where `memory_relations.relation_type` (`MemoryRelationType`: `supports`, `conflicts_with`, `triggered`, `derived_from`, `supersedes`, `surfaced_as`, `published_as`, `resolved_by`, `downgraded_by`) is coerced via `as NavigatorEdgeKind` into a type that contains none of those literals. The fix scope is the `memory_relations` → `InternalBeamEdge.kind` path only: `GraphEdgeView.readMemoryRelations()` → `GraphNavigator.expandRelationEdges()` → ranking → explain output. Add/adjust tests to prove that the runtime distinguishes `supports`, `conflicts_with`, and other in-scope relation types at the read/rank/explain layer, and that downstream scoring no longer penalizes them to floor. If Task 1 reports §6 GREEN, keep this task as evidence-only and do not mutate source.
  **Must NOT do**: Must NOT invent a new graph taxonomy or a new edge subsystem. Must NOT touch the `as NavigatorEdgeKind` casts in `expandEventFrontier` (line 650, logic_edges) or `expandSemanticEdges` (line 1153, semantic_edges) — those source types (`LogicEdgeType`, `SemanticEdgeType`) are already subsets of `NavigatorEdgeKind` and the casts there are type-safe. Must NOT degrade existing `logic_edges` / `semantic_edges` handling while fixing `memory_relations` semantics.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: focused semantic preservation across existing navigator/view code
  - Skills: []
  - Omitted: [`git-master`] — not needed for code reasoning

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 6,7 | Blocked By: 1

  **References**:
  - Pattern: `src/memory/graph-edge-view.ts:readMemoryRelations` — canonical relation_type read surface; returns `GraphEdgeReadResult` with `relation_type: string` (the MemoryRelationType literal is preserved here)
  - Pattern: `src/memory/navigator.ts:expandRelationEdges` (~line 1110-1136) — THE coercion site; `edge.relation_type as NavigatorEdgeKind` at line 1127 discards the MemoryRelationType literal
  - Pattern: `src/memory/types.ts:BeamEdge` (line 305-313) — `kind: NavigatorEdgeKind` needs widening to accept MemoryRelationType. This is the type that all downstream consumers read
  - Pattern: `src/memory/types.ts:NavigatorEdgeKind` (line 53-65) — the 10-member union that does NOT include any MemoryRelationType literal
  - Pattern: `src/memory/types.ts:MemoryRelationType` (line 200-202) — the 9-member union (`supports`, `conflicts_with`, etc.) that IS the §6 target
  - Impact: `src/memory/navigator.ts:edgePriorityScore` (line 1334-1341) — downstream scoring function. Takes `NavigatorEdgeKind`, looks up in `QUERY_TYPE_PRIORITY`. Memory relation kinds currently fall through to default score 0.1 because indexOf returns -1
  - Impact: `src/memory/navigator.ts:QUERY_TYPE_PRIORITY` (line 124-132) — priority map typed as `Record<QueryType, NavigatorEdgeKind[]>`. Contains no MemoryRelationType values. Memory relation edges always miss intent matching
  - Impact: `src/memory/navigator.ts:calculateSupportScore` (line 1493-1519) — corroboration logic hard-codes checks against specific NavigatorEdgeKind values. Memory relation edges pass through without contributing to corroboration
  - Impact: `src/memory/navigator.ts:calculateQueryIntentMatch` (line 1484-1490) — creates `Set<NavigatorEdgeKind>` from QUERY_TYPE_PRIORITY; memory relation edges never match, dragging down intent score
  - Impact: `src/memory/navigator.ts:compareNeighborEdges` (line 1208-1220) — already casts `edge.kind as MemoryRelationType` for strategy weight lookup (lines 1214-1215), confirming that the data flow expects MemoryRelationType at runtime despite the type lie
  - Config: `src/memory/navigator.ts:GRAPH_RETRIEVAL_STRATEGIES` (line 101-122) — `edgeWeights` keyed by MemoryRelationType (`supports`, `conflicts_with`, etc.). These weights only take effect because the runtime value is the original literal despite the incorrect static type
  - Pattern: `src/memory/tools.ts` — `memory_explore` public surface affected by explain output
  - Test: `src/memory/cognition/memory-relation-types.test.ts` — existing relation-type coverage to extend
  - Test: `src/memory/navigator.test.ts:547` — "preserves memory relation semantic kind" — ALREADY GREEN, proves runtime `edge.kind` holds MemoryRelationType literal despite static type lie
  - Test: `src/memory/navigator.test.ts:683` — "conflict_exploration strategy upweights conflicts_with edges" — ALREADY GREEN, proves strategy weights apply at runtime
  - Test: relevant `memory_explore` / navigator tests discovered by Task 1

  **Acceptance Criteria**:
  - [ ] Baseline commands for affected files pass before edits
  - [ ] A failing test demonstrates the current semantic loss (or evidence file proves no loss exists)
  - [ ] `bun test src/memory/cognition/memory-relation-types.test.ts` passes after the fix
  - [ ] Any navigator/explain tests touched by this task pass after the fix
  - [ ] The `as NavigatorEdgeKind` cast in `expandRelationEdges` (navigator.ts ~line 1127) is removed or replaced with a type-safe mapping that preserves `MemoryRelationType` literals (`supports`, `conflicts_with`, etc.) through to `InternalBeamEdge.kind`. The two casts in `expandEventFrontier` (line 650, logic_edges) and `expandSemanticEdges` (line 1153, semantic_edges) are OUT OF SCOPE — those source types (`LogicEdgeType`, `SemanticEdgeType`) are already subsets of `NavigatorEdgeKind` and their casts are type-safe.
  - [ ] `bun run build` and `bun run check:legacy-memory-surface` pass

  **QA Scenarios**:
  ```
  Scenario: MemoryRelationType literal survives through BeamEdge.kind to explain output
    Tool: Bash
    Preconditions: Test DB with at least one `conflicts_with` and one `supports` memory_relation row
    Steps:
      1. Run targeted navigator test that calls `explore()` with a seed that triggers `expandRelationEdges`
      2. Inspect the returned `evidence_paths[*].path.edges[*].kind` values for edges originating from `readMemoryRelations()`
      3. Assert that the `.kind` field holds the original MemoryRelationType literal (e.g. `"conflicts_with"`, `"supports"`), NOT a NavigatorEdgeKind value or `undefined`
    Expected: `edge.kind === "conflicts_with"` for conflict edges; `edge.kind === "supports"` for support edges — no collapse to generic kind
    Failure Indicators: `edge.kind` is a NavigatorEdgeKind value like `"fact_relation"` or `"semantic_similar"`, or `bun run build` emits type errors on the widened kind
    Evidence: .sisyphus/evidence/task-3-graph-semantics.txt

  Scenario: Downstream scoring does not penalize memory relation edges to default floor
    Tool: Bash
    Preconditions: Same fixtures as above. Use `conflict_exploration` strategy which sets `conflicts_with: 2.0` weight
    Steps:
      1. Run the targeted test with `conflict_exploration` strategy
      2. Capture the score breakdown for a path containing a `conflicts_with` edge
      3. Assert that `edgePriorityScore` returns > 0.1 for memory relation kinds (not the -1 indexOf fallback), OR that the strategy weight multiplier (2.0) is applied correctly to offset the base
      4. Confirm `calculateQueryIntentMatch` doesn't drag the match score to 0 for paths dominated by memory relation edges
    Expected: A `conflicts_with` edge under `conflict_exploration` strategy scores higher than default 0.1 * 1.0 = 0.1
    Failure Indicators: Score breakdown shows base=0.1 and multiplier=1.0 for known-weighted memory relation edges
    Evidence: .sisyphus/evidence/task-3-graph-semantics.txt

  Scenario: Logic/semantic edge families remain unaffected
    Tool: Bash
    Steps:
      1. Run existing navigator test suite covering logic edges (causal/temporal/same_episode) and semantic edges (semantic_similar/entity_bridge/conflict_or_update)
      2. Confirm all existing tests pass without modification
    Expected: Zero regressions to logic_edges/semantic_edges handling; those `as NavigatorEdgeKind` casts were not touched
    Evidence: .sisyphus/evidence/task-3-graph-semantics.txt
  ```

  **Commit**: YES | Message: `harden(memory): preserve graph relation semantics` | Files: `src/memory/navigator.ts`, `src/memory/types.ts`, targeted tests

- [x] 4. Make time-slice reads query-accurate for current/projection paths

  **What to do**: Only if Task 1 reports AMBER/RED on §5, close the gap where tool-level time-slice inputs reach graph traversal but not every in-scope current/projection read. The following leak sites are already known from code inspection and should be the **initial audit/fix targets** (Task 1 may discover additional sites, but these are not speculative):
  - **Confirmed runtime leak**: `navigator.ts:expandPrivateBeliefFrontier` (~line 1043): reads `private_cognition_current` with `WHERE agent_id = ? AND kind = 'assertion' AND id IN (...)` — no time-slice filter, returns latest state regardless of requested slice. This is the primary fix target.
  - **Capability boundaries (test-only APIs, zero production callers)**: `area-world-projection-repo.ts` getters at lines 100, 129, 160, 184 (`getAreaStateCurrent`, `getAreaNarrativeCurrent`, `getWorldStateCurrent`, `getWorldNarrativeCurrent`). These have no time-slice parameter, but they are NOT runtime leak sites — lsp_find_references confirms zero production callers (all references are in test files). These are current-only projection surfaces to **classify and document** in accordance with the authority matrix, not fix targets.
  - `tools.ts:memory_explore` (line 487): passes time-slice params into navigator correctly — this is the entry, not the leak

  **Architectural decision for this cutover**: Area/world projection surfaces (`area_state_current`, `area_narrative_current`, `world_state_current`, `world_narrative_current`) are **current-only** in this round. Migration 020 (schema.ts:535) only added `valid_time`/`committed_time` columns — there is no historical ledger backing these tables. This means:
  - For `private_cognition_current`: time-slice CAN be applied because `private_cognition_events` is the upstream ledger (rebuildable via `memory-replay.ts`)
  - For area/world `*_current` tables: the fix is to **explicitly reject or document** time-slice requests that these surfaces cannot serve, NOT to build a historical ledger in this cutover
  - The tool layer must not make "pseudo-history" promises for surfaces that are current-only — if a time-slice query reaches a current-only surface, the response must either omit that surface or include a clear "current-only" caveat

  For each site: either apply time-slice filtering at query time (where ledger backing exists), or explicitly reject the unsupported mode with a documented rationale (where the surface is current-only). Add/adjust tests to prove there is no "historical edges + current projection" mixing in one answer, and add at least one test asserting that a current-only surface boundary is correctly expressed. If Task 1 reports §5 GREEN (all sites already handle slicing), keep this task as evidence-only.
  **Must NOT do**: Must NOT redesign the time model. Must NOT broaden scope into full historical-query infrastructure beyond the concrete gaps listed above plus any additional gaps proven by Task 1. Must NOT enforce single-timestamp for settlement commits (projection-manager.ts:90 and :202 use separate `Date.now()` calls — this is a known concern but fixing it requires changes to the settlement pipeline and is out of scope for this cutover). Must NOT build a historical ledger for area/world current-only projection tables in this round.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: touches query semantics across navigator, projection repo, and time-slice utilities
  - Skills: []
  - Omitted: [`git-master`] — not required

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 6,7 | Blocked By: 1

  **References**:
  - Pattern: `src/memory/tools.ts:487` — public `asOfTime` / `timeDimension` entry; correctly passes slice into navigator
  - Pattern: `src/memory/time-slice-query.ts` — canonical time-slice helper behavior
  - Leak (confirmed runtime): `src/memory/navigator.ts:expandPrivateBeliefFrontier` (~line 1043) — reads `private_cognition_current` in production navigator path without time-slice filter. THIS IS THE PRIMARY FIX TARGET.
  - Boundary (test-only API): `src/memory/projection/area-world-projection-repo.ts:100` — `getAreaStateCurrent` has no time-slice parameter. Zero production callers (all references are in test files). Classify as capability boundary to document, not runtime leak to fix.
  - Boundary (test-only API): `src/memory/projection/area-world-projection-repo.ts:129` — `getAreaNarrativeCurrent` has no time-slice parameter. Callers: test files only (publication-recovery-sweeper.test.ts, e2e-rp-memory-pipeline.test.ts, validation-area-world-surfacing.test.ts, validation-publication-pipeline.test.ts, turn-service.test.ts).
  - Boundary (test-only API): `src/memory/projection/area-world-projection-repo.ts:160` — `getWorldStateCurrent` has no time-slice parameter. Zero production callers.
  - Boundary (test-only API): `src/memory/projection/area-world-projection-repo.ts:184` — `getWorldNarrativeCurrent` has no time-slice parameter. Zero production callers.
  - Test: `src/memory/stress-time-slice.test.ts` — edge/boundary/performance verification
  - Test: `test/memory/time-slice-query.test.ts` — core time-slice helper regression suite
  - Test: `test/memory/validation-time-model.test.ts` — time-model semantic regression suite
  - Test: any additional navigator/projection time-slice tests discovered by Task 1

  **Acceptance Criteria**:
  - [ ] Baseline commands for affected files pass before edits
  - [ ] A failing test proves the concrete time-slice leak before the fix (or evidence file proves none exists)
  - [ ] `bun test src/memory/stress-time-slice.test.ts` passes after the fix
  - [ ] `bun test test/memory/time-slice-query.test.ts` passes after the fix
  - [ ] `bun test test/memory/validation-time-model.test.ts` passes after the fix
  - [ ] Any targeted navigator/projection time-slice tests touched by this task pass
  - [ ] `bun run build` and `bun run check:legacy-memory-surface` pass
  - [ ] Evidence file explicitly states whether unsupported query modes are honored or rejected at each touched read surface: specific disposition for the confirmed runtime leak (`expandPrivateBeliefFrontier` :1043), plus documentation of capability boundaries for the 4 test-only area-world getters (classify as current-only per authority matrix, not fix)

  **QA Scenarios**:
  ```
  Scenario: Historical query does not pull current projection by accident
    Tool: Bash
    Steps: Run the targeted time-slice test with a fixture where cognition/projection changed after the requested timestamp
    Expected: Returned result reflects the requested slice, not the latest state
    Evidence: .sisyphus/evidence/task-4-time-slice.txt

  Scenario: Boundary timestamp semantics stay stable
    Tool: Bash
    Steps: Run the stress/boundary suite covering equality and zero/null timestamp semantics
    Expected: Exact-boundary and fallback behaviors remain deterministic and documented by tests
    Evidence: .sisyphus/evidence/task-4-time-slice.txt
  ```

  **Commit**: YES | Message: `harden(memory): make time-slice reads query-accurate` | Files: `src/memory/navigator.ts`, `src/memory/projection/area-world-projection-repo.ts`, optional helpers/tests

- [x] 5. Converge publication live path and recovery path

  **What to do**: Only if Task 1 reports AMBER/RED on §12, harden the existing publication pipeline so settlement commit, materialization, projection update, and recovery retry converge on one idempotent observable outcome. The task may use Task 2’s integrity/idempotency primitives but must stay inside the existing `turn-service` → `projection-manager` → `materialization` → `publication-recovery-sweeper` pipeline. Start by writing a failing test for the exact inconsistency window discovered by Task 1, then fix only that gap. If Task 1 reports §12 GREEN, keep this task as evidence-only.
  **Must NOT do**: Must NOT create a new async architecture, event bus, or outbox subsystem. Must NOT split publication handling into a new independent framework.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: touches transaction boundaries, retry logic, and recovery semantics
  - Skills: []
  - Omitted: [`git-master`] — not needed

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 6,7 | Blocked By: 1,2

  **References**:
  - Pattern: `src/runtime/turn-service.ts` — turn settlement entry path
  - Pattern: `src/memory/projection/projection-manager.ts` — sync settlement projection boundary
  - Pattern: `src/memory/materialization.ts` — live materialization + retry path
  - Pattern: `src/memory/publication-recovery-sweeper.ts` — async recovery path
  - Pattern: `src/memory/projection/area-world-projection-repo.ts` — publication projection writes
  - Test: `test/memory/validation-publication-pipeline.test.ts`
  - Test: `test/memory/materialization-promotion.test.ts`
  - Test: `test/memory/validation-turn-settlement.test.ts`
  - Test: `src/memory/publication-recovery-sweeper.test.ts` — THE primary recovery regression suite. Covers orphan recovery + projection reconciliation (:87), unique-constraint-during-recovery treated as reconciled (:160), and materializePublications recovery job payload replay (:233). This is where §12 recovery-path correctness is actually verified.

  **Acceptance Criteria**:
  - [ ] Baseline publication tests pass before edits
  - [ ] A failing test demonstrates the concrete live/recovery inconsistency before the fix (or evidence file proves no gap exists)
  - [ ] `bun test test/memory/validation-publication-pipeline.test.ts` passes
  - [ ] `bun test test/memory/materialization-promotion.test.ts` passes
  - [ ] `bun test test/memory/validation-turn-settlement.test.ts` passes
  - [ ] `bun test src/memory/publication-recovery-sweeper.test.ts` passes — this is the explicit recovery-path gate; without it, §12 can be falsely declared GREEN while the sweeper path remains untested
  - [ ] `bun run build` and `bun run check:legacy-memory-surface` pass
  - [ ] Evidence file states the final idempotency rule used by both live and recovery paths

  **QA Scenarios**:
  ```
  Scenario: Publication success path yields exactly one visible state
    Tool: Bash
    Steps: Run the targeted publication pipeline tests for successful settlement → materialization → projection flow
    Expected: Exactly one publication outcome is observable; no duplicate or missing projection state
    Evidence: .sisyphus/evidence/task-5-publication.txt

  Scenario: Retry/recovery path converges instead of diverging
    Tool: Bash
    Steps: Run the targeted tests that force a recoverable publication failure and sweep/retry it
    Expected: Recovery ends in the same observable state as the success path, with no duplicate publication artifacts
    Evidence: .sisyphus/evidence/task-5-publication.txt
  ```

  **Commit**: YES | Message: `harden(memory): converge publication materialization retries` | Files: `src/memory/materialization.ts`, `src/memory/projection/projection-manager.ts`, `src/memory/publication-recovery-sweeper.ts`, targeted tests

- [x] 6. Finish residual §19 cutover work and remove dead compat remnants

  **What to do**: Complete the remaining §19 work that still makes sense in the current codebase state. This includes: (1) **audit the actual coverage of `scripts/memory-replay.ts` and `scripts/memory-verify.ts`** — currently `memory-replay` only rebuilds `private_cognition_current` (via `PrivateCognitionProjectionRepo.rebuild()`) and does NOT cover publication/materialization/area-world-projection tables, and `memory-verify` only samples first 10 agents (`LIMIT 10`) and only checks row-count parity (`current rows == distinct event keys`) without verifying field-level correctness (`summary`, `status`, `source_event_ref`). If Task 1 proves broader replay/verify coverage is needed for cutover safety, extend the scripts to cover the missing domains; otherwise, record the explicit coverage boundaries in the evidence file so the scope limitation is documented, not hidden; (2) create or update a delete-readiness checklist artifact for residual compat shims that are intentionally kept vs intentionally removed; (3) remove actual dead compat residue that Task 1 discovers has zero callers (`AgentFactOverlay` cleanup is already essentially complete — only a guard-test entry in `test/memory/legacy-literal-gate.test.ts:21` remains, which is intentionally kept as a forbidden-token check; focus on any *new* dead types/functions Task 1 discovers instead); (4) verify canonical ref convergence and document any intentionally retained compatibility shims. Update directly dependent tests in the same task.
  **Must NOT do**: Must NOT resurrect `agent_fact_overlay`, dual-read, or dual-write behavior. Must NOT remove intentional retained shims (`legacy:` settlement prefix, backward-compatible time-slice inputs, snake_case compat parsing, contested-write safety gate) without explicit zero-dependency proof and checklist updates.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: mostly cleanup/verification work across types, scripts, and tests with some targeted source edits
  - Skills: []
  - Omitted: [`git-master`] — code and verification focus

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: 7 | Blocked By: 1,2,3,4,5

  **References**:
  - Pattern: `src/memory/storage.ts` — retained compat settlement-id prefix to explicitly keep
  - Pattern: `src/memory/types.ts` — dead compat types / labels to triage (note: `AgentFactOverlay` is already cleaned — only a forbidden-token entry in `legacy-literal-gate.test.ts:21` remains; focus on other dead types Task 1 discovers)
  - Pattern: `src/memory/task-agent.ts` — intentional contested-write gate to keep
  - Script: `scripts/memory-replay.ts` — replay/rebuild artifact path; currently covers ONLY `private_cognition_current` via `PrivateCognitionProjectionRepo.rebuild()` (line 32-41)
  - Script: `scripts/memory-verify.ts` — integrity verification artifact path; currently LIMIT 10 agents (line 16), row-count parity only (lines 29-37), no field-level checks
  - Gap: `src/memory/materialization.ts` — materialization state not covered by replay/verify scripts
  - Gap: `src/memory/publication-recovery-sweeper.ts` — publication recovery state not covered
  - Gap: `src/memory/projection/area-world-projection-repo.ts` — area/world projection tables not covered
  - Gap: `src/memory/projection/projection-manager.ts` — projection settlement state not covered
  - Test: `test/memory/legacy-literal-gate.test.ts` — no forbidden token regression
  - Test: any tests that currently assert removed legacy internals, as identified in Task 1

  **Acceptance Criteria**:
  - [ ] Baseline commands for affected files/scripts/tests pass before edits
  - [ ] `lsp_find_references` or equivalent evidence proves zero callers before any dead type/function removal
  - [ ] `bun run check:legacy-memory-surface` passes after cleanup
  - [ ] `bun run build` passes after cleanup
  - [ ] Evidence file explicitly documents which projection domains each script covers vs does not cover, **cross-referenced against Task 1's Surface Authority Matrix**. For each surface classified as "must be rebuildable": replay/verify coverage must be YES or explicitly justified as NOT-NEEDED. Current known coverage: `memory-replay.ts` → `private_cognition_current` only; `memory-verify.ts` → `private_cognition_current` row-count parity for first 10 agents only. Known gaps: publication tables, materialization state, area/world projection tables, field-level drift (`summary`, `status`, `source_event_ref`). For each gap: either (a) Task 1 audit proves the domain is GREEN and no extension needed (record why), or (b) script is extended to cover it with test evidence
  - [ ] Delete-readiness checklist is saved/updated in `.sisyphus/evidence/task-6-delete-readiness.txt`
  - [ ] Any kept compatibility shim is explicitly listed in the checklist with rationale

  **QA Scenarios**:
  ```
  Scenario: Dead compat type/code is removed without breaking callers
    Tool: Bash
    Steps: Capture zero-reference proof for the targeted dead symbol(s), remove them, then run build and targeted tests
    Expected: Build stays green; no caller breaks; evidence records zero-reference proof and resulting cleanup
    Evidence: .sisyphus/evidence/task-6-cutover.txt

  Scenario: Legacy surface guard still blocks forbidden regressions
    Tool: Bash
    Steps: Run `bun run check:legacy-memory-surface` after all cleanup changes and any test rewrites in this task
    Expected: Guard passes; only intentionally allowlisted files contain forbidden legacy literals
    Evidence: .sisyphus/evidence/task-6-cutover.txt

  Scenario: Script coverage audit is documented with no hidden gaps
    Tool: Bash + Grep
    Preconditions: Task 1 audit evidence is available with §19 status
    Steps:
      1. Read `scripts/memory-replay.ts` and record which tables it rebuilds (expected: only `private_cognition_current` via `PrivateCognitionProjectionRepo.rebuild()`)
      2. Read `scripts/memory-verify.ts` and record: (a) agent sampling limit (expected: `LIMIT 10`), (b) verification dimensions (expected: row-count parity only), (c) tables checked (expected: `private_cognition_current` + `private_cognition_events` only)
      3. Cross-reference Task 1 audit to determine if publication/materialization/area-world-projection domains need replay/verify coverage
      4. If coverage extension was made: run extended scripts against test DB and capture output
      5. If no extension needed: record justification from Task 1 evidence
    Expected: Evidence file contains explicit table-by-table coverage matrix with YES/NO/NOT-NEEDED per domain and rationale
    Failure Indicators: Evidence file says "scripts are sufficient" without listing which domains were checked and which were not
    Evidence: .sisyphus/evidence/task-6-cutover.txt
  ```

  **Commit**: YES | Message: `cleanup(memory): finish V3 cutover remnants` | Files: `src/memory/types.ts`, optional scripts/tests/checklist artifacts

- [x] 7. Align regression suite with final cutover state and clean legacy-dependent tests

  **What to do**: Audit every test file or assertion flagged in Task 1 as legacy-dependent and classify it into exactly one bucket: `keep as-is`, `rewrite to canonical behavior`, or `delete because production path was intentionally removed`. Rewrite tests when the product behavior is still required but the current assertion leaks old implementation details. Delete only those tests whose covered production path has been intentionally removed and for which zero-reference proof or replacement coverage is recorded. Update any helper/fixture files that still manufacture removed legacy shapes by default. Run the full affected suite at the end.
  **Must NOT do**: Must NOT delete tests merely because they are inconvenient or failing. Must NOT introduce forbidden legacy tokens into non-allowlisted files. Must NOT remove useful regression intent when a rewrite would preserve it.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: high-context test triage across multiple memory subsystems
  - Skills: []
  - Omitted: [`git-master`] — not required

  **Parallelization**: Can Parallel: NO | Wave 5 | Blocks: F1-F4 | Blocked By: 1,2,3,4,5,6

  **References**:
  - Test: `test/memory/legacy-literal-gate.test.ts` — guardrail test that all rewrites must respect
  - Test: `test/memory/schema.test.ts` — migration/integrity regression anchor
  - Test: `test/memory/validation-publication-pipeline.test.ts` — publication regression anchor
  - Test: `test/memory/materialization-promotion.test.ts` — retry/recovery regression anchor
  - Test: `test/memory/validation-turn-settlement.test.ts` — settlement/materialization integration anchor
  - Test: `test/memory/e2e-rp-memory-pipeline.test.ts` — end-to-end canonical memory behavior anchor
  - Pattern: legacy-dependent tests discovered in Task 1 evidence

  **Acceptance Criteria**:
  - [ ] Baseline targeted tests pass/fail is recorded before changes
  - [ ] Every touched legacy-dependent test has a disposition recorded in `.sisyphus/evidence/task-7-test-alignment.txt`
  - [ ] Deleted tests are mapped to removed production paths or replacement tests in the evidence file
  - [ ] Rewritten tests assert canonical behavior instead of removed legacy internals
  - [ ] `bun run check:legacy-memory-surface` passes after all test edits
  - [ ] `bun test` passes after all test alignment work
  - [ ] `bun run build` passes after all test alignment work

  **QA Scenarios**:
  ```
  Scenario: Canonical regression suite stays green after cleanup
    Tool: Bash
    Steps: Run `bun run build && bun run check:legacy-memory-surface && bun test`
    Expected: Full suite and build pass after test rewrites/deletions
    Evidence: .sisyphus/evidence/task-7-test-alignment.txt

  Scenario: Removed tests were truly legacy-only
    Tool: Bash
    Steps: For each deleted test, capture zero-reference proof or replacement-coverage proof in the evidence file and rerun the nearest surviving canonical suite
    Expected: Evidence shows why deletion was safe; surviving canonical suites still cover required behavior
    Evidence: .sisyphus/evidence/task-7-test-alignment.txt
  ```

  **Commit**: YES | Message: `test(memory): align regressions with final cutover` | Files: touched `test/memory/**/*.ts`, test helpers/fixtures, optional evidence references

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in parallel. ALL must approve. Present consolidated results to the user and get explicit "okay" before completing.
> Do NOT auto-proceed after verification. Wait for explicit user approval.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Task 1: no commit unless the executor intentionally commits audit artifacts (default NO)
- Task 2: `harden(memory): enforce integrity and idempotency invariants`
- Task 3: `harden(memory): preserve graph relation semantics`
- Task 4: `harden(memory): make time-slice reads query-accurate`
- Task 5: `harden(memory): converge publication materialization retries`
- Task 6: `cleanup(memory): finish V3 cutover remnants`
- Task 7: `test(memory): align regressions with final cutover`
- Pre-commit gate for every YES commit: `bun run build && bun run check:legacy-memory-surface && <task-specific bun test commands>`

## Success Criteria
- The memory stack's in-scope surfaces (canonical ledgers, sync projections, navigator runtime paths, publication pipeline) have one canonical production path per concern, with no hidden legacy fallback dependency
- Any remaining backward-compat shims are explicitly intentional, documented in the delete-readiness checklist, and covered by tests
- No test in the retained suite depends on removed legacy code or removed legacy table semantics
- Fresh installs and upgrade-path migrations both remain green
- Graph relation semantics (§6), time-slice reads (§5), and publication behavior (§12) are consistent under success, failure, and retry paths for in-scope surfaces
- Surface authority matrix is complete and all "must be rebuildable" surfaces have replay/verify coverage or documented justification for exclusion
- Known deferred gaps (organizer durability, search/FTS repair, settlement multi-clock, area/world history) are classified in the authority matrix, not silently ignored
