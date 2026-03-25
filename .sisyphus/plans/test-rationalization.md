# Test Rationalization — Slim Down & Relocate

## TL;DR

> **Quick Summary**: Consolidate 113 test files into ~95 by merging duplicate pairs, relocating `src/memory/*.test.ts` → `test/memory/`, consolidating stress/validation suites, and deleting dead scaffolding tests. Every merge preserves unique assertions — no behavioral coverage is lost.
> 
> **Deliverables**:
> - Duplicate test file pairs (schema, navigator) merged — single source of truth per module
> - All `src/memory/*.test.ts` relocated to `test/memory/` — unified test directory convention
> - Stress tests consolidated into fewer files
> - Batch-created validation tests consolidated into fewer files
> - Dead scaffolding tests deleted
> - ~15-20 files removed, ~50-80 truly-duplicate test cases pruned
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 5 waves
> **Critical Path**: T1→T2→T5→T8→T12→F1-F4
> 
> **PREREQUISITE**: The `legacy-cleanup` plan MUST complete first. That plan removes legacy-only test files and updates legacy references in surviving tests. This plan handles non-legacy structural consolidation only.

---

## Context

### Original Request
User considers 1788 tests across 113 files excessive. Wants aggressive pruning and file relocation (瘦身/搬家).

### Research Findings

**Critical finding from Metis review**: The initial audit claimed stress/validation files "overlap" with counterparts and could be deleted. Deep assertion-level analysis proves they are NOT redundant — each has unique behavioral coverage at different abstraction layers. The real problem is too many small files, not too many tests.

**What's actually achievable**:
- FILE count reduction: 113 → ~95 files (merge duplicates, consolidate small files)
- TEST count reduction: ~50-80 truly-duplicate tests pruned during merges
- DIRECTORY normalization: all test files under `test/` (currently split between `src/` and `test/`)

**What's NOT in scope** (handled by legacy-cleanup plan):
- `canonical-node-refs.test.ts` deletion — Task 22 of legacy plan
- `v3-regression.test.ts` deletion — Task 22 of legacy plan
- Legacy assertion updates in schema/graph-node-ref/demo-scenario tests — Task 22 of legacy plan
- `contested-chain-v3.test.ts` rewriting (uses agent_fact_overlay) — Task 4 of legacy plan

### Metis Review
**Key risks addressed**:
- Double-booking with legacy-cleanup plan → Explicit exclusion boundary defined
- Deleting "overlapping" tests that aren't actually redundant → Pre-merge assertion verification required
- Breaking shared test helper dependencies → `memory-test-utils.ts` consumers tracked

---

## Work Objectives

### Core Objective
Reduce test file count from 113 to ~95 by merging duplicate pairs, relocating scattered test files to a unified `test/` directory, and consolidating small files — while preserving 100% of unique behavioral assertions.

### Concrete Deliverables
- All `src/memory/*.test.ts` files relocated to `test/memory/`
- Duplicate schema test files merged (73 tests → ~50)
- Duplicate navigator test files merged (31 tests → ~25)
- Stress test files consolidated from 4 → 2
- Validation test files consolidated from 8 → 4
- Dead scaffolding tests deleted (~5 tests)

### Definition of Done
- [ ] `bun test` passes with 0 failures
- [ ] `bun run build` passes with 0 type errors
- [ ] Zero test files remain in `src/memory/` (all relocated to `test/memory/`)
- [ ] Grep `describe\(` in `src/memory/` (include *.test.ts) → 0 matches
- [ ] Total test files ≤ 100 (from 113)
- [ ] No orphaned imports in `test/helpers/memory-test-utils.ts`

### Must Have
- Every unique assertion from a deleted source file MUST exist verbatim in the merge target BEFORE the source is deleted
- `bun test` green after every task
- Two-commit pattern: (1) merge assertions into target + verify, (2) delete source file

### Must NOT Have (Guardrails)
- MUST NOT touch files already modified by legacy-cleanup Tasks 1-23: `canonical-node-refs.test.ts`, `v3-regression.test.ts`, `contested-chain-v3.test.ts`, `graph-node-ref.test.ts` legacy assertions, `demo-scenario.test.ts` legacy audit test
- MUST NOT delete `test/architecture/import-boundaries.test.ts` — unique architectural constraint enforcement
- MUST NOT delete `test/cli/local-runtime.test.ts` — unique `createLocalRuntime()` result shape coverage
- MUST NOT delete `test/memory/integration.test.ts` — unique end-to-end memory pipeline (3 tests but critical path)
- MUST NOT delete `test/memory/relation-intents.test.ts` — unique relation resolution logic
- MUST NOT delete `stress-capability-matrix.test.ts` — unique tool system correctness coverage (17 tests)
- MUST NOT delete `validation-turn-settlement.test.ts` — unique settlement pipeline coverage (7 tests)
- MUST NOT delete `validation-negative-cases.test.ts` — unique edge case coverage (9 tests)
- MUST NOT modify `test/helpers/memory-test-utils.ts` shared helper
- MUST NOT change any non-test production source file
- MUST NOT refactor test logic — only move/merge/delete

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: YES (bun test)
- **Automated tests**: Tests-after (verify after each merge)
- **Framework**: bun test

### QA Policy
Every task MUST include:
- Pre-merge assertion count (`bun test <target-file>` → N pass)
- Post-merge assertion count (`bun test <target-file>` → N+M pass)
- Post-delete suite verification (`bun test` → all pass)
- Use Grep tool for content searches (Windows environment)
- Use Bash ONLY for `bun test` commands

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Safe deletions — no merge needed):
├── Task 1: Delete test/bootstrap.test.ts (scaffolding) [quick]
└── Task 2: Delete test/runtime/tool-permissions.test.ts (1 test, verify covered first) [quick]

Wave 2 (Relocate src/memory/*.test.ts → test/memory/ — no assertion changes):
├── Task 3: Relocate src/memory/schema.test.ts → test/memory/schema-unit.test.ts [quick]
├── Task 4: Relocate src/memory/navigator.test.ts → test/memory/navigator-unit.test.ts [quick]
├── Task 5: Relocate remaining src/memory/*.test.ts files (batch) [unspecified-high]
└── Task 6: Relocate src/memory/cognition/*.test.ts files [quick]

Wave 3 (Merge duplicates — merge into target, then delete source):
├── Task 7: Merge test/memory/navigator.test.ts into navigator-unit.test.ts (after T4) [unspecified-high]
├── Task 8: Deduplicate test/memory/schema.test.ts + schema-unit.test.ts overlapping describes (after T3) [deep]
└── Task 9: Deduplicate test/memory/retrieval-search.test.ts + retrieval.test.ts overlapping describes [unspecified-high]

Wave 4 (Consolidate stress + validation suites):
├── Task 10: Merge stress-shared-blocks unique assertions into shared-blocks.test.ts, delete source [unspecified-high]
├── Task 11: Merge stress-time-slice unique assertions into time-slice-query.test.ts, delete source [unspecified-high]
├── Task 12: Merge validation-contested-cognition into cognition-commit.test.ts [unspecified-high]
├── Task 13: Merge validation-time-model into time-slice-query.test.ts [unspecified-high]
├── Task 14: Merge validation-explain-visibility into visibility-isolation.test.ts [unspecified-high]
├── Task 15: Merge validation-cross-session + validation-episode-lifecycle + validation-publication-pipeline + validation-area-world-surfacing into integration.test.ts [deep]
└── Task 16: Merge tiny CLI tests (trace-store + config-doctor → nearest CLI file) [quick]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit (deep)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Automated end-to-end QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave | Parallel |
|------|-----------|--------|------|----------|
| 1 | — | — | 1 | YES (with 2) |
| 2 | — | — | 1 | YES (with 1) |
| 3 | — | 8 | 2 | YES (with 4,5,6) |
| 4 | — | 7 | 2 | YES (with 3,5,6) |
| 5 | — | 10,11 | 2 | YES (with 3,4,6) |
| 6 | — | 12 | 2 | YES (with 3,4,5) |
| 7 | 4 | — | 3 | YES (with 8,9) |
| 8 | 3 | — | 3 | YES (with 7,9) |
| 9 | 5 | — | 3 | YES (with 7,8) |
| 10 | 5 | — | 4 | YES (with 11-16) |
| 11 | 5 | — | 4 | YES (with 10,12-16) |
| 12 | 6 | — | 4 | YES (with 10,11,13-16) |
| 13 | 5 | — | 4 | YES (with 10-12,14-16) |
| 14 | 5 | — | 4 | YES (with 10-13,15,16) |
| 15 | 5 | — | 4 | YES (with 10-14,16) |
| 16 | — | — | 4 | YES (with 10-15) |

### Agent Dispatch Summary

- **Wave 1**: 2 parallel — T1-T2→`quick`
- **Wave 2**: 4 parallel — T3-T4,T6→`quick`, T5→`unspecified-high`
- **Wave 3**: 3 parallel — T7,T9→`unspecified-high`, T8→`deep`
- **Wave 4**: 7 parallel — T10-T14,T16→`unspecified-high`, T15→`deep`
- **FINAL**: 4 parallel — F1,F4→`deep`, F2-F3→`unspecified-high`

---

## TODOs

- [ ] 1. Delete test/bootstrap.test.ts

  **What to do**:
  - Delete `test/bootstrap.test.ts` (3 tests: version import, truth assertion, pure scaffolding)
  - Verify `test/runtime/bootstrap.test.ts` (5 tests) is separate and unaffected

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - `test/bootstrap.test.ts` — File to delete (3 pure scaffolding tests)
  - `test/runtime/bootstrap.test.ts` — Separate file, must NOT be deleted

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Scaffolding tests deleted, runtime bootstrap untouched
    Tool: Bash (bun test) + Glob tool
    Steps:
      1. Verify test/bootstrap.test.ts does not exist (use Glob)
      2. Run `bun test test/runtime/bootstrap.test.ts` → passes
      3. Run `bun test` → all pass
    Expected Result: File deleted; runtime bootstrap unaffected; suite green
    Evidence: .sisyphus/evidence/task-1-scaffolding-deleted.txt
  ```

  **Commit**: YES — C1
  - Message: `test: delete scaffolding tests (bootstrap, tool-permissions)`
  - Pre-commit: `bun test`

- [ ] 2. Delete test/runtime/tool-permissions.test.ts

  **What to do**:
  - First verify this 1-test file's assertion is covered by `test/runtime/bootstrap.test.ts` or `test/core/tools/tool-access-policy.test.ts`
  - If covered → delete. If NOT covered → move the single test into `test/core/tools/tool-access-policy.test.ts`
  - Either way, the standalone 1-test file is eliminated

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - `test/runtime/tool-permissions.test.ts` — 1-test file to eliminate
  - `test/core/tools/tool-access-policy.test.ts` — Potential merge target (31 tests, same domain)

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: tool-permissions file eliminated
    Tool: Bash (bun test) + Glob tool
    Steps:
      1. Verify test/runtime/tool-permissions.test.ts does not exist
      2. Run `bun test test/core/tools/tool-access-policy.test.ts` → passes (if assertion merged here)
      3. Run `bun test` → all pass
    Expected Result: File eliminated; assertion preserved if unique
    Evidence: .sisyphus/evidence/task-2-permissions-eliminated.txt
  ```

  **Commit**: YES — C1 (grouped with Task 1)

- [ ] 3. Relocate src/memory/schema.test.ts → test/memory/schema-unit.test.ts

  **What to do**:
  - `git mv src/memory/schema.test.ts test/memory/schema-unit.test.ts`
  - Update any relative imports in the moved file (e.g., `./schema` → `../../src/memory/schema`)
  - Verify imports resolve correctly after move

  **Must NOT do**:
  - MUST NOT change any test assertions — pure relocation only
  - MUST NOT merge with `test/memory/schema.test.ts` yet (that's Task 8)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4, 5, 6)
  - **Blocks**: Task 8
  - **Blocked By**: None

  **References**:
  - `src/memory/schema.test.ts` — Source (49 tests)
  - `test/memory/schema.test.ts` — Existing file (24 tests) — NOT touched here

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Schema unit tests relocated and passing
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test test/memory/schema-unit.test.ts` → 49 tests pass (same count as before)
      2. Run `bun test test/memory/schema.test.ts` → 24 tests still pass (untouched)
      3. Verify src/memory/schema.test.ts does not exist
    Expected Result: Both files pass independently; source file removed
    Evidence: .sisyphus/evidence/task-3-schema-relocated.txt
  ```

  **Commit**: YES — C2
  - Message: `test: relocate src/memory/*.test.ts → test/memory/`
  - Pre-commit: `bun test`

- [ ] 4. Relocate src/memory/navigator.test.ts → test/memory/navigator-unit.test.ts

  **What to do**:
  - `git mv src/memory/navigator.test.ts test/memory/navigator-unit.test.ts`
  - Update relative imports

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 5, 6)
  - **Blocks**: Task 7
  - **Blocked By**: None

  **References**:
  - `src/memory/navigator.test.ts` — Source (27 tests)
  - `test/memory/navigator.test.ts` — Existing file (4 tests) — NOT touched here

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Navigator unit tests relocated and passing
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test test/memory/navigator-unit.test.ts` → 27 tests pass
      2. Run `bun test test/memory/navigator.test.ts` → 4 tests still pass
    Expected Result: Both pass; source removed
    Evidence: .sisyphus/evidence/task-4-navigator-relocated.txt
  ```

  **Commit**: YES — C2 (grouped)

- [ ] 5. Relocate remaining src/memory/*.test.ts files (batch)

  **What to do**:
  Relocate ALL remaining `src/memory/*.test.ts` files to `test/memory/`:
  - `src/memory/storage.test.ts` → `test/memory/storage.test.ts`
  - `src/memory/task-agent.test.ts` → `test/memory/task-agent.test.ts`
  - `src/memory/retrieval.test.ts` → `test/memory/retrieval-unit.test.ts` (suffix -unit to avoid clash with `test/memory/retrieval-search.test.ts`)
  - `src/memory/visibility-policy.test.ts` → `test/memory/visibility-policy.test.ts`
  - `src/memory/tools.test.ts` → `test/memory/tools.test.ts`
  - `src/memory/prompt-data.test.ts` → `test/memory/prompt-data.test.ts`
  - `src/memory/promotion.test.ts` → `test/memory/promotion.test.ts`
  - `src/memory/materialization.test.ts` → `test/memory/materialization.test.ts`
  - `src/memory/embeddings.test.ts` → `test/memory/embeddings.test.ts`
  - `src/memory/core-memory.test.ts` → `test/memory/core-memory.test.ts`
  - `src/memory/alias.test.ts` → `test/memory/alias.test.ts`
  - `src/memory/pinned-summary-proposal.test.ts` → `test/memory/pinned-summary-proposal.test.ts`
  - `src/memory/area-hierarchy.test.ts` → `test/memory/area-hierarchy.test.ts`
  - `src/memory/stress-capability-matrix.test.ts` → `test/memory/stress-capability-matrix.test.ts`
  - `src/memory/stress-contested-chain.test.ts` → `test/memory/stress-contested-chain.test.ts`
  - `src/memory/stress-shared-blocks.test.ts` → `test/memory/stress-shared-blocks.test.ts`
  - `src/memory/stress-time-slice.test.ts` → `test/memory/stress-time-slice.test.ts`
  - `src/memory/time-slice-v3.test.ts` → `test/memory/time-slice-v3.test.ts`
  - `src/memory/shared-blocks/shared-blocks.test.ts` → `test/memory/shared-blocks.test.ts`
  - `src/memory/shared-blocks/section-path-validator.test.ts` → `test/memory/section-path-validator.test.ts`
  - Use `git mv` for each to preserve history
  - Update all relative imports in each moved file
  - Check for name collisions with existing `test/memory/*.test.ts` files — suffix `-unit` if collision

  **Must NOT do**:
  - MUST NOT move files already handled by legacy-cleanup plan: `canonical-node-refs.test.ts`, `v3-regression.test.ts`, `contested-chain-v3.test.ts`
  - MUST NOT change any test assertions — pure relocation

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: ~20 files to move, import path updates needed for each
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 4, 6)
  - **Blocks**: Tasks 9-15
  - **Blocked By**: None

  **References**:
  - All `src/memory/*.test.ts` files listed above

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: All src/memory tests relocated, suite green
    Tool: Bash (bun test) + Glob tool
    Steps:
      1. Glob src/memory/*.test.ts → expect only files handled by legacy-cleanup plan (canonical-node-refs, v3-regression, contested-chain-v3)
      2. Run `bun test` → all pass
    Expected Result: All non-legacy src/memory tests relocated; suite passes
    Evidence: .sisyphus/evidence/task-5-batch-relocated.txt
  ```

  **Commit**: YES — C2 (grouped)

- [ ] 6. Relocate src/memory/cognition/*.test.ts files

  **What to do**:
  - `src/memory/cognition/belief-revision.test.ts` → `test/memory/belief-revision.test.ts`
  - `src/memory/cognition/cognition-search.test.ts` → `test/memory/cognition-search.test.ts`
  - `src/memory/cognition/memory-relation-types.test.ts` → `test/memory/memory-relation-types.test.ts`
  - Update relative imports

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 4, 5)
  - **Blocks**: Task 12
  - **Blocked By**: None

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Cognition tests relocated
    Tool: Bash (bun test) + Glob tool
    Steps:
      1. Glob src/memory/cognition/*.test.ts → expect 0 files
      2. Run `bun test test/memory/belief-revision.test.ts test/memory/cognition-search.test.ts test/memory/memory-relation-types.test.ts` → all pass
    Expected Result: All relocated; suite green
    Evidence: .sisyphus/evidence/task-6-cognition-relocated.txt
  ```

  **Commit**: YES — C2 (grouped)

- [ ] 7. Merge test/memory/navigator.test.ts INTO navigator-unit.test.ts

  **What to do**:
  - Read `test/memory/navigator.test.ts` (4 tests — explain shell: conflict query, redacted placeholders, drilldown, time-slice filter)
  - Check each assertion against `test/memory/navigator-unit.test.ts` (27 tests)
  - For each assertion NOT already in navigator-unit.test.ts: copy the `it(...)` block verbatim into the appropriate `describe` block
  - For each assertion that IS a duplicate: discard
  - Run `bun test test/memory/navigator-unit.test.ts` → verify test count = 27 + N (where N = non-duplicate assertions)
  - Delete `test/memory/navigator.test.ts`

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 8, 9)
  - **Blocks**: None
  - **Blocked By**: Task 4

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Navigator tests merged, source deleted
    Tool: Bash (bun test) + Glob tool
    Steps:
      1. Run `bun test test/memory/navigator-unit.test.ts` → expect ≥ 27 tests pass (27 original + merged unique)
      2. Verify test/memory/navigator.test.ts does not exist
      3. Run `bun test` → all pass
    Expected Result: All unique assertions preserved; source deleted
    Evidence: .sisyphus/evidence/task-7-navigator-merged.txt
  ```

  **Commit**: YES — C3
  - Message: `test: merge navigator duplicate tests (+N assertions merged)`
  - Pre-commit: `bun test`

- [ ] 8. Deduplicate schema-unit.test.ts + schema.test.ts overlapping describes

  **What to do**:
  - Read both `test/memory/schema-unit.test.ts` (49 tests, from relocated src/) and `test/memory/schema.test.ts` (24 tests)
  - For each `describe` block in schema-unit.test.ts, check if schema.test.ts has a describe with similar name
  - For overlapping describes: compare `it(...)` blocks at assertion level
    - If exact same assertion → keep ONE copy in schema.test.ts, remove from schema-unit.test.ts
    - If different assertion → keep BOTH
  - After deduplication, merge remaining unique tests from schema-unit.test.ts INTO schema.test.ts
  - Delete schema-unit.test.ts
  - Target: 73 combined → ~50-55 (remove ~15-20 true duplicates)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Assertion-level comparison across 73 tests, requires careful judgment
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 7, 9)
  - **Blocks**: None
  - **Blocked By**: Task 3

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Schema tests deduplicated, single file
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test test/memory/schema.test.ts` → passes with ~50-55 tests
      2. Verify test/memory/schema-unit.test.ts does not exist
      3. Run `bun test` → all pass
    Expected Result: Single schema test file; no duplicate assertions; suite green
    Evidence: .sisyphus/evidence/task-8-schema-deduped.txt
  ```

  **Commit**: YES — C4
  - Message: `test: deduplicate schema test overlapping describes (-N duplicate assertions)`
  - Pre-commit: `bun test`

- [ ] 9. Deduplicate retrieval-unit.test.ts + retrieval-search.test.ts overlapping describes

  **What to do**:
  - Read `test/memory/retrieval-unit.test.ts` (14 tests, relocated from src/) and `test/memory/retrieval-search.test.ts` (40 tests)
  - Compare assertion-level overlap (initial audit flagged "light overlap")
  - Merge unique assertions from retrieval-unit into retrieval-search
  - Delete retrieval-unit.test.ts
  - Target: 54 combined → ~45-50

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 7, 8)
  - **Blocks**: None
  - **Blocked By**: Task 5

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Retrieval tests deduplicated
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test test/memory/retrieval-search.test.ts` → passes with ~45-50 tests
      2. Verify test/memory/retrieval-unit.test.ts does not exist
      3. Run `bun test` → all pass
    Expected Result: Single retrieval test file; unique assertions preserved
    Evidence: .sisyphus/evidence/task-9-retrieval-deduped.txt
  ```

  **Commit**: YES — C5
  - Message: `test: deduplicate retrieval test overlapping describes (-N duplicate assertions)`
  - Pre-commit: `bun test`

- [ ] 10. Merge stress-shared-blocks unique assertions into shared-blocks.test.ts, delete source

  **What to do**:
  - Read `test/memory/stress-shared-blocks.test.ts` (14 tests — 10-patch monotonicity, cross-agent interleaving, admin-grant constraints, SQL injection filter, before/after chains)
  - Read `test/memory/shared-blocks.test.ts` (56 tests — unit tests for shared block services)
  - For EACH of the 14 stress tests: check if shared-blocks.test.ts covers the same assertion
  - Move all UNIQUE stress assertions into shared-blocks.test.ts under a new `describe("stress scenarios")` block
  - Delete stress-shared-blocks.test.ts

  **Must NOT do**:
  - MUST NOT discard any unique assertion — every `it(...)` block from stress file must either match an existing test or be copied verbatim

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 11-16)
  - **Blocks**: None
  - **Blocked By**: Task 5

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Stress-shared-blocks merged into shared-blocks
    Tool: Bash (bun test) + Glob tool
    Steps:
      1. Run `bun test test/memory/shared-blocks.test.ts` → passes with ≥ 56 tests (56 original + merged unique)
      2. Verify test/memory/stress-shared-blocks.test.ts does not exist
      3. Run `bun test` → all pass
    Expected Result: All unique assertions preserved; source deleted
    Evidence: .sisyphus/evidence/task-10-stress-shared-merged.txt
  ```

  **Commit**: YES — C6
  - Message: `test: consolidate stress-shared-blocks + stress-time-slice into counterparts`
  - Pre-commit: `bun test`

- [ ] 11. Merge stress-time-slice unique assertions into time-slice-query.test.ts, delete source

  **What to do**:
  - Read `test/memory/stress-time-slice.test.ts` (16 tests — performance benchmarks 150/200 rows < 500ms, DB-level boundary conditions, genesis data persistence)
  - Read `test/memory/time-slice-query.test.ts` (15 tests)
  - Move all unique assertions under a new `describe("stress / boundary conditions")` block
  - **PRESERVE** performance benchmark assertions (150 rows < 500ms) — these are the ONLY performance regression tests
  - Delete stress-time-slice.test.ts

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 10, 12-16)
  - **Blocks**: None
  - **Blocked By**: Task 5

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Stress-time-slice merged into time-slice-query
    Tool: Bash (bun test) + Grep tool
    Steps:
      1. Run `bun test test/memory/time-slice-query.test.ts` → passes with ≥ 15 tests
      2. Grep "500" in test/memory/time-slice-query.test.ts → expect match (performance benchmark preserved)
      3. Verify test/memory/stress-time-slice.test.ts does not exist
    Expected Result: Performance benchmarks preserved; source deleted
    Evidence: .sisyphus/evidence/task-11-stress-timeslice-merged.txt
  ```

  **Commit**: YES — C6 (grouped with Task 10)

- [ ] 12. Merge validation-contested-cognition into cognition-commit.test.ts

  **What to do**:
  - Read `test/memory/validation-contested-cognition.test.ts` (6 tests)
  - Read `test/memory/cognition-commit.test.ts` (56 tests)
  - Move unique assertions under new `describe("contested cognition validation")` block
  - Delete validation-contested-cognition.test.ts

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 10, 11, 13-16)
  - **Blocks**: None
  - **Blocked By**: Task 6

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Validation-contested-cognition merged
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test test/memory/cognition-commit.test.ts` → passes with ≥ 56 tests
      2. Verify test/memory/validation-contested-cognition.test.ts does not exist
    Expected Result: Assertions preserved; source deleted
    Evidence: .sisyphus/evidence/task-12-validation-contested-merged.txt
  ```

  **Commit**: YES — C7
  - Message: `test: consolidate 6 validation tests into counterpart files`
  - Pre-commit: `bun test`

- [ ] 13. Merge validation-time-model into time-slice-query.test.ts

  **What to do**:
  - Read `test/memory/validation-time-model.test.ts` (5 tests)
  - Move unique assertions into `test/memory/time-slice-query.test.ts` under new `describe("time model validation")` block
  - Delete validation-time-model.test.ts

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: None
  - **Blocked By**: Task 5

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Validation-time-model merged
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test test/memory/time-slice-query.test.ts` → passes
      2. Verify test/memory/validation-time-model.test.ts does not exist
    Expected Result: Assertions preserved; source deleted
    Evidence: .sisyphus/evidence/task-13-validation-time-merged.txt
  ```

  **Commit**: YES — C7 (grouped)

- [ ] 14. Merge validation-explain-visibility into visibility-isolation.test.ts

  **What to do**:
  - Read `test/memory/validation-explain-visibility.test.ts` (6 tests — AuthorizationPolicy, session-scoped visibility)
  - Move unique assertions into `test/memory/visibility-isolation.test.ts` under new `describe("explain visibility validation")` block
  - Delete validation-explain-visibility.test.ts

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: None
  - **Blocked By**: Task 5

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Validation-explain-visibility merged
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test test/memory/visibility-isolation.test.ts` → passes with ≥ 25 tests
      2. Verify test/memory/validation-explain-visibility.test.ts does not exist
    Expected Result: Assertions preserved; source deleted
    Evidence: .sisyphus/evidence/task-14-validation-visibility-merged.txt
  ```

  **Commit**: YES — C7 (grouped)

- [ ] 15. Merge validation-cross-session + validation-episode-lifecycle + validation-publication-pipeline + validation-area-world-surfacing into integration.test.ts

  **What to do**:
  - Read all 4 validation files (4+5+5+7 = 21 tests total)
  - Read `test/memory/integration.test.ts` (3 tests)
  - For EACH of the 21 tests: check if integration.test.ts covers the same assertion
  - Move all unique assertions into integration.test.ts under new describe blocks:
    - `describe("cross-session durability")` — from validation-cross-session
    - `describe("episode lifecycle")` — from validation-episode-lifecycle
    - `describe("publication pipeline")` — from validation-publication-pipeline
    - `describe("area/world surfacing")` — from validation-area-world-surfacing
  - Delete all 4 validation files
  - Note: These 4 files all use `memory-test-utils.ts` helpers — integration.test.ts may need to import them

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 4 source files into 1 target, need to manage shared helper imports
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: None
  - **Blocked By**: Task 5

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 4 validation files consolidated into integration.test.ts
    Tool: Bash (bun test) + Glob tool
    Steps:
      1. Run `bun test test/memory/integration.test.ts` → passes with ≥ 24 tests (3 original + 21 merged)
      2. Glob test/memory/validation-cross-session* test/memory/validation-episode* test/memory/validation-publication* test/memory/validation-area* → expect 0 files
      3. Run `bun test` → all pass
    Expected Result: 4 files merged; all assertions preserved
    Evidence: .sisyphus/evidence/task-15-validation-batch-merged.txt
  ```

  **Commit**: YES — C7 (grouped)

- [ ] 16. Merge tiny CLI tests (trace-store + config-doctor → nearest CLI file)

  **What to do**:
  - `test/cli/trace-store.test.ts` (3 tests) → merge into `test/cli/debug-commands.test.ts` (9 tests, diagnostic domain)
  - `test/cli/config-doctor.test.ts` (3 tests) → merge into `test/cli/config-validate.test.ts` (17 tests, config validation domain)
  - Delete both source files

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: None
  - **Blocked By**: None

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Tiny CLI tests consolidated
    Tool: Bash (bun test) + Glob tool
    Steps:
      1. Run `bun test test/cli/debug-commands.test.ts` → passes with ≥ 12 tests
      2. Run `bun test test/cli/config-validate.test.ts` → passes with ≥ 20 tests
      3. Verify trace-store.test.ts and config-doctor.test.ts do not exist
    Expected Result: Tests merged; sources deleted
    Evidence: .sisyphus/evidence/task-16-cli-consolidated.txt
  ```

  **Commit**: YES — C8
  - Message: `test: merge tiny CLI tests into nearest file`
  - Pre-commit: `bun test`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `deep`
  Read the plan. Verify each "Must Have" and "Must NOT Have". Check all files listed for deletion are actually deleted. Check all files listed as "keep" still exist. Check no legacy-cleanup files were touched.

  **QA Scenarios:**
  ```
  Scenario: All plan constraints verified
    Tool: Grep tool + Bash (bun test)
    Steps:
      1. Grep "describe(" in src/memory/ (include *.test.ts) → expect 0 matches (all relocated)
      2. Verify import-boundaries.test.ts, local-runtime.test.ts, integration.test.ts, relation-intents.test.ts all exist
      3. Verify stress-capability-matrix.test.ts, validation-turn-settlement.test.ts, validation-negative-cases.test.ts all exist
      4. Run `bun test` → all pass
    Expected Result: All constraints satisfied
    Evidence: .sisyphus/evidence/F1-compliance.txt
  ```

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun test`. Check no orphaned imports. Verify no duplicate describe blocks remain across merged files.

  **QA Scenarios:**
  ```
  Scenario: No orphans, no duplicates
    Tool: Bash (bun test) + Grep tool
    Steps:
      1. Run `bun test` → 0 failures
      2. Run `bun run build` → 0 errors
      3. Grep "memory-test-utils" in test/ → verify all importing files exist
    Expected Result: Clean build, no orphans
    Evidence: .sisyphus/evidence/F2-quality.txt
  ```

- [ ] F3. **Automated End-to-End QA** — `unspecified-high`
  Full test suite verification plus file count check.

  **QA Scenarios:**
  ```
  Scenario: Test suite healthy, file count reduced
    Tool: Bash (bun test) + Glob tool
    Steps:
      1. Run `bun test` → record total pass/fail
      2. Use Glob **/*.test.ts → count files, expect ≤ 100
      3. Use Glob src/memory/*.test.ts → expect 0 files
    Expected Result: All tests pass; ≤ 100 test files; 0 in src/memory/
    Evidence: .sisyphus/evidence/F3-qa.txt
  ```

- [ ] F4. **Scope Fidelity Check** — `deep`
  Verify no legacy-cleanup files were touched. Verify no production source was modified.

  **QA Scenarios:**
  ```
  Scenario: Scope boundaries respected
    Tool: Grep tool + Bash (git)
    Steps:
      1. Run `git diff --name-only` → verify ZERO non-test files changed (no *.ts outside test/ and src/memory/*.test.ts)
      2. Grep "canonical-node-refs|v3-regression|contested-chain-v3" in git diff → expect 0 (legacy plan handles these)
    Expected Result: Only test files changed; no legacy-plan overlap
    Evidence: .sisyphus/evidence/F4-scope.txt
  ```

---

## Commit Strategy

| Commit | Message | Pre-commit |
|--------|---------|------------|
| C1 | test: delete scaffolding tests (bootstrap, tool-permissions) | bun test |
| C2 | test: relocate src/memory/*.test.ts → test/memory/ | bun test |
| C3 | test: merge navigator duplicate tests (+4 assertions merged, deduplicated) | bun test |
| C4 | test: deduplicate schema test overlapping describes (-N duplicate assertions) | bun test |
| C5 | test: deduplicate retrieval test overlapping describes (-N duplicate assertions) | bun test |
| C6 | test: consolidate stress-shared-blocks + stress-time-slice into counterparts | bun test |
| C7 | test: consolidate 6 validation tests into counterpart files | bun test |
| C8 | test: merge tiny CLI tests into nearest file | bun test |
| C9 | test: final cleanup — verify test count + file count | bun test |

---

## Success Criteria

### Verification Commands

Use **Bash** for test/build:
```
bun test                    # Expected: all pass, 0 failures
bun run build               # Expected: 0 type errors
```

Use **Grep tool** / **Glob tool** for structural checks:

| Check | Tool | Pattern/Path | Expected |
|-------|------|-------------|----------|
| No tests in src/memory/ | Glob | src/memory/*.test.ts | 0 files |
| No tests in src/memory/cognition/ | Glob | src/memory/cognition/*.test.ts | 0 files |
| Total test files ≤ 100 | Glob | **/*.test.ts | ≤ 100 files |
| No orphaned helper imports | Grep | memory-test-utils in test/ | All importing files exist |

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] Zero test files in src/memory/
- [ ] File count ≤ 100
