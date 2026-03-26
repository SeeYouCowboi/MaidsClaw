# Memory V3 Hardening and Final Cutover

## TL;DR
> **Summary**: Finish the remaining Memory V3 hardening work as a verification-first cutover. Audit the real gaps, harden only the parts that still fail the audit, complete the residual §19 cleanup work, and align the regression suite with the final canonical architecture.
>
> **Deliverables**:
> - One preflight audit matrix covering §19, §15, §6, §12, and §5
> - At most two new memory migrations, only if the audit proves they are required
> - Canonical graph/time/publication behavior verified or corrected without re-implementing already-finished V3 work
> - Residual §19 cutover artifacts completed (`memory-replay`, `memory-verify`, delete-readiness checklist, dead-type cleanup)
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
Produce a decision-complete hardening/cutover sequence that leaves the memory stack in one canonical, test-backed state: no stale legacy fallback dependencies, no unresolved integrity/idempotency gaps, no graph/time/publication correctness drift, and no regression tests anchored to removed internals.

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
- [ ] `bun test test/memory/e2e-rp-memory-pipeline.test.ts` passes
- [ ] `bun test src/memory/stress-time-slice.test.ts` passes
- [ ] Grep `agent_fact_overlay` in `src/**/*.ts` excluding `src/memory/schema.ts` returns 0 matches
- [ ] Grep `AgentFactOverlay` in `src/**/*.ts` returns 0 matches
- [ ] Grep `relation_type as NavigatorEdgeKind` in `src/memory/**/*.ts` returns 0 matches
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

- [ ] 1. Run preflight audit and produce gap matrix

  **What to do**: Run a zero-mutation preflight across the five target chains and record an explicit GREEN/AMBER/RED matrix before touching production code. The audit must verify the current reality of §19, §15, §6, §12, and §5, discover the current highest migration number in `src/memory/schema.ts`, and classify each chain as `no-code-change-needed`, `test-only`, or `code+test required`. Save all findings to `.sisyphus/evidence/task-1-preflight-audit.txt` and update the work log with concrete file references for every AMBER/RED finding.
  **Must NOT do**: Must NOT change source, tests, or migrations. Must NOT assume old plan state; discover current state from code.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: cross-cutting audit across migrations, retrieval, projection, and test infrastructure
  - Skills: []
  - Omitted: [`git-master`] — no git work required in the audit itself

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 2,3,4,5,6,7 | Blocked By: none

  **References**:
  - Pattern: `src/memory/schema.ts` — discover actual migration count and existing 028-032 cutover work
  - Pattern: `src/memory/navigator.ts` — verify graph semantic preservation and time-slice loss points
  - Pattern: `src/memory/graph-edge-view.ts` — verify current read semantics and failure behavior
  - Pattern: `src/memory/materialization.ts` — verify publication live-path / retry-path consistency
  - Pattern: `src/memory/projection/projection-manager.ts` — verify settlement/materialization boundary
  - Pattern: `src/memory/projection/area-world-projection-repo.ts` — verify current/projection time-slice behavior
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
  - [ ] Evidence file lists every remaining legacy-dependent test candidate with disposition: keep / rewrite / delete

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Baseline memory stack is green
    Tool: Bash
    Steps: Run `bun run build && bun run check:legacy-memory-surface && bun test test/memory/schema.test.ts && bun test test/memory/validation-publication-pipeline.test.ts && bun test test/memory/materialization-promotion.test.ts && bun test test/memory/validation-turn-settlement.test.ts && bun test src/memory/stress-time-slice.test.ts`
    Expected: All commands pass without editing the repo
    Evidence: .sisyphus/evidence/task-1-preflight-audit.txt

  Scenario: Audit catches real red flags instead of assuming old plan state
    Tool: Grep
    Steps: Search for `agent_fact_overlay`, `AgentFactOverlay`, `relation_type as NavigatorEdgeKind`, and `.skip(` / `.todo(` in current source/test files
    Expected: Evidence records exact match counts and file paths; any nonzero unexpected match is flagged AMBER/RED
    Evidence: .sisyphus/evidence/task-1-preflight-audit.txt
  ```

  **Commit**: NO | Message: `verify(memory): baseline audit` | Files: `.sisyphus/evidence/task-1-preflight-audit.txt`

- [ ] 2. Enforce DB integrity and idempotency only for audit-proven gaps

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

- [ ] 3. Preserve graph relation semantics end-to-end

  **What to do**: Only if Task 1 reports AMBER/RED on §6, remove the semantic loss point where `memory_relations.relation_type` is coerced into a weaker navigator edge kind. Preserve relation semantics from `GraphEdgeView.readMemoryRelations()` through `GraphNavigator.expandRelationEdges()`, ranking, and explain output so conflict-specific and support-specific behavior can be tested directly. Add/adjust tests to prove that the runtime distinguishes `supports`, `conflicts_with`, and other in-scope relation types at the read/rank/explain layer. If Task 1 reports §6 GREEN, keep this task as evidence-only and do not mutate source.
  **Must NOT do**: Must NOT invent a new graph taxonomy or a new edge subsystem. Must NOT degrade existing `logic_edges` / `semantic_edges` handling while fixing `memory_relations` semantics.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: focused semantic preservation across existing navigator/view code
  - Skills: []
  - Omitted: [`git-master`] — not needed for code reasoning

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 6,7 | Blocked By: 1

  **References**:
  - Pattern: `src/memory/graph-edge-view.ts` — canonical relation_type read surface
  - Pattern: `src/memory/navigator.ts` — current coercion and path scoring behavior
  - Pattern: `src/memory/types.ts` — `MemoryRelationType`, `NavigatorEdgeKind`, and beam-edge shapes
  - Pattern: `src/memory/tools.ts` — `memory_explore` public surface affected by explain output
  - Test: `src/memory/cognition/memory-relation-types.test.ts` — existing relation-type coverage to extend
  - Test: relevant `memory_explore` / navigator tests discovered by Task 1

  **Acceptance Criteria**:
  - [ ] Baseline commands for affected files pass before edits
  - [ ] A failing test demonstrates the current semantic loss (or evidence file proves no loss exists)
  - [ ] `bun test src/memory/cognition/memory-relation-types.test.ts` passes after the fix
  - [ ] Any navigator/explain tests touched by this task pass after the fix
  - [ ] Grep `relation_type as NavigatorEdgeKind` in `src/memory/**/*.ts` returns 0 matches after a code-changing fix
  - [ ] `bun run build` and `bun run check:legacy-memory-surface` pass

  **QA Scenarios**:
  ```
  Scenario: Conflict relation remains conflict-specific through explain path
    Tool: Bash
    Steps: Run the targeted navigator/memory relation test that seeds a `conflicts_with` edge and inspects returned edge metadata/ranking
    Expected: Output preserves conflict semantics instead of collapsing to a generic relation kind
    Evidence: .sisyphus/evidence/task-3-graph-semantics.txt

  Scenario: Non-conflict relation still behaves correctly
    Tool: Bash
    Steps: Run the same targeted suite with `supports` / `triggered` relation fixtures
    Expected: Support/trigger paths still rank and render correctly; no regression to other edge families
    Evidence: .sisyphus/evidence/task-3-graph-semantics.txt
  ```

  **Commit**: YES | Message: `harden(memory): preserve graph relation semantics` | Files: `src/memory/navigator.ts`, `src/memory/types.ts`, targeted tests

- [ ] 4. Make time-slice reads query-accurate for current/projection paths

  **What to do**: Only if Task 1 reports AMBER/RED on §5, close the gap where tool-level time-slice inputs reach graph traversal but not every in-scope current/projection read. Update the exact read sites identified by Task 1 so `private cognition`, `area/world projection`, and any other in-scope current-state lookup either honor the requested slice at query time or explicitly reject unsupported modes. Add/adjust tests to prove there is no “historical edges + current projection” mixing in one answer. If Task 1 reports §5 GREEN, keep this task as evidence-only.
  **Must NOT do**: Must NOT redesign the time model. Must NOT broaden scope into full historical-query infrastructure beyond the concrete gap proven by Task 1.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: touches query semantics across navigator, projection repo, and time-slice utilities
  - Skills: []
  - Omitted: [`git-master`] — not required

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 6,7 | Blocked By: 1

  **References**:
  - Pattern: `src/memory/tools.ts` — public `asOfTime` / `timeDimension` entry
  - Pattern: `src/memory/time-slice-query.ts` — canonical time-slice helper behavior
  - Pattern: `src/memory/navigator.ts` — current filter timing and private cognition frontier reads
  - Pattern: `src/memory/projection/area-world-projection-repo.ts` — current/projection reads that may ignore time slice
  - Test: `src/memory/stress-time-slice.test.ts` — edge/boundary/performance verification
  - Test: any navigator/projection time-slice tests discovered by Task 1

  **Acceptance Criteria**:
  - [ ] Baseline commands for affected files pass before edits
  - [ ] A failing test proves the concrete time-slice leak before the fix (or evidence file proves none exists)
  - [ ] `bun test src/memory/stress-time-slice.test.ts` passes after the fix
  - [ ] Any targeted navigator/projection time-slice tests touched by this task pass
  - [ ] `bun run build` and `bun run check:legacy-memory-surface` pass
  - [ ] Evidence file explicitly states whether unsupported query modes are honored or rejected at each touched read surface

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

- [ ] 5. Converge publication live path and recovery path

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

  **Acceptance Criteria**:
  - [ ] Baseline publication tests pass before edits
  - [ ] A failing test demonstrates the concrete live/recovery inconsistency before the fix (or evidence file proves no gap exists)
  - [ ] `bun test test/memory/validation-publication-pipeline.test.ts` passes
  - [ ] `bun test test/memory/materialization-promotion.test.ts` passes
  - [ ] `bun test test/memory/validation-turn-settlement.test.ts` passes
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

- [ ] 6. Finish residual §19 cutover work and remove dead compat remnants

  **What to do**: Complete the remaining §19 work that still makes sense in the current codebase state. This includes: (1) verify replay/rebuild support for canonical memory state using `scripts/memory-replay.ts` / related helpers, adding missing replay/integrity logic only if Task 1 proves it is absent; (2) create or update a delete-readiness checklist artifact for residual compat shims that are intentionally kept vs intentionally removed; (3) remove dead compat code that Task 1 proves has zero callers, especially dead types such as `AgentFactOverlay` and any now-obsolete legacy-only cleanup residue; (4) verify canonical ref convergence and document any intentionally retained compatibility shims. Update directly dependent tests in the same task.
  **Must NOT do**: Must NOT resurrect `agent_fact_overlay`, dual-read, or dual-write behavior. Must NOT remove intentional retained shims (`legacy:` settlement prefix, backward-compatible time-slice inputs, snake_case compat parsing, contested-write safety gate) without explicit zero-dependency proof and checklist updates.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: mostly cleanup/verification work across types, scripts, and tests with some targeted source edits
  - Skills: []
  - Omitted: [`git-master`] — code and verification focus

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: 7 | Blocked By: 1,2,3,4,5

  **References**:
  - Pattern: `src/memory/storage.ts` — retained compat settlement-id prefix to explicitly keep
  - Pattern: `src/memory/types.ts` — dead compat types / labels to triage (`AgentFactOverlay`, legacy-read-only labels)
  - Pattern: `src/memory/task-agent.ts` — intentional contested-write gate to keep
  - Script: `scripts/memory-replay.ts` — replay/rebuild artifact path
  - Script: `scripts/memory-verify.ts` — integrity verification artifact path
  - Test: `test/memory/legacy-literal-gate.test.ts` — no forbidden token regression
  - Test: any tests that currently assert removed legacy internals, as identified in Task 1

  **Acceptance Criteria**:
  - [ ] Baseline commands for affected files/scripts/tests pass before edits
  - [ ] `lsp_find_references` or equivalent evidence proves zero callers before any dead type/function removal
  - [ ] `bun run check:legacy-memory-surface` passes after cleanup
  - [ ] `bun run build` passes after cleanup
  - [ ] Replay / verify scripts are either proven sufficient by evidence or updated with tests/evidence showing canonical rebuild/integrity support
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
  ```

  **Commit**: YES | Message: `cleanup(memory): finish V3 cutover remnants` | Files: `src/memory/types.ts`, optional scripts/tests/checklist artifacts

- [ ] 7. Align regression suite with final cutover state and clean legacy-dependent tests

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
- [ ] F1. Plan Compliance Audit — oracle
- [ ] F2. Code Quality Review — unspecified-high
- [ ] F3. Real Manual QA — unspecified-high
- [ ] F4. Scope Fidelity Check — deep

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
- The memory stack has one canonical production path per concern, with no hidden legacy fallback dependency
- Any remaining backward-compat shims are explicitly intentional, documented in the delete-readiness checklist, and covered by tests
- No test in the retained suite depends on removed legacy code or removed legacy table semantics
- Fresh installs and upgrade-path migrations both remain green
- Retrieval, time-slice, and publication behavior are consistent under success, failure, and retry paths
