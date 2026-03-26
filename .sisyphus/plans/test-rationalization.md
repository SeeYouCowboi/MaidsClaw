# Test Rationalization — Remove Obsolete, Legacy, Duplicate, or Low-Signal Tests

## TL;DR

> **Quick Summary**: Audit and clean up the 112-file test suite by removing tautologies, inlining thin wrappers, relocating a gated historical-exemption file, and auditing 7 candidate duplicate families + legacy-facing tests — acting on findings only when evidence proves a test no longer adds signal.
>
> **Deliverables**:
> - Tautology removed from `test/bootstrap.test.ts`
> - `test/runtime/tool-permissions.test.ts` inlined into `test/runtime/bootstrap.test.ts` and deleted
> - `src/memory/contracts/graph-node-ref.test.ts` moved to `test/memory/contracts/` with gate update and import rewrite
> - 7 structured audit artifacts in `.sisyphus/evidence/audit-*.md`
> - Legacy-test classification with conditional removals
> - Coverage baseline and final comparison
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES — 2 waves (Wave 1 sequential, Wave 2 parallel with 7 tasks)
> **Critical Path**: T1 → T2 → T3 → T4 → (T5–T11 parallel) → F1–F4

---

## Context

### Original Request
Rewrite the existing test-rationalization policy document into an executable Sisyphus-format plan with concrete tasks, QA scenarios, parallel waves, and agent dispatch.

### Interview Summary
**Key Discussions**:
- Prior plan review identified it as a sound policy document but not agent-executable — missing QA scenarios, agent categories, parallel waves, and concrete verification steps
- All 112 test files verified (26 under `src/`, 86 under `test/`)
- `bootstrap.test.ts` tautology (`expect(true).toBe(true)` line 21) confirmed
- `tool-permissions.test.ts` has real runtime registration coverage — cannot be deleted without inlining
- Legacy-literal-gate whitelist confirmed: `src/memory/schema.ts`, `test/memory/schema.test.ts`, `src/memory/contracts/graph-node-ref.test.ts`
- Duplicate candidate size disparities verified (schema 769 vs 1404, navigator 839 vs 220, retrieval 296 vs 1783) — clearly NOT simple duplicates
- Build passes, `check:legacy-memory-surface` = `bun test test/memory/legacy-literal-gate.test.ts`

### Metis Review
**Identified Gaps** (addressed):
- `bun run build` does NOT check test files (`tsconfig.build.json` excludes `test/**` and `**/*.test.ts`) — added `bunx tsc --noEmit` to all verification steps
- `graph-node-ref.test.ts` uses relative import `"./graph-node-ref.js"` — moving it requires import path rewrite to `"../../../src/memory/contracts/graph-node-ref.js"`
- `test/memory/contracts/` directory does not exist — must be created before the move
- Gate update must be a SET REPLACEMENT (remove old path + add new path), not just an append
- `tool-permissions.test.ts` inlining adds 4 new imports to host file — confirmed acceptable at ~160 lines total
- 16 non-audited `src/memory/*.test.ts` files explicitly out of scope
- Wave 4 (conditional execution) may be a no-op if all audits recommend "keep separate" — valid outcome
- No test file imports from other test files — moves won't cascade

---

## Work Objectives

### Core Objective
Remove tests that genuinely no longer add signal (tautologies, legacy-only, proven duplicates, thin wrappers) using an evidence-based audit approach, while preserving all coverage that protects live production behavior.

### Concrete Deliverables
- 3 high-confidence cleanups completed (Wave 1)
- 7 structured audit artifacts with recommendations and rationale
- Conditional file modifications based on audit evidence
- Coverage baseline + final comparison report

### Definition of Done
- [ ] `bun test` passes with zero failures
- [ ] `bunx tsc --noEmit` passes (full type-check including test files)
- [ ] `bun run check:legacy-memory-surface` passes
- [ ] Every removed test/assertion has a written rationale in its commit message
- [ ] Coverage does not regress vs baseline

### Must Have
- Evidence-based audit before any duplicate removal
- Atomic commit for graph-node-ref move + gate update + import rewrite
- Structured audit artifacts saved to `.sisyphus/evidence/`
- Pre-flight green confirmation before any changes

### Must NOT Have (Guardrails)
- Do NOT delete tests based on name alone (`legacy`, `v3`, `proposal`)
- Do NOT merge files only because they are small
- Do NOT use file count reduction as a success metric
- Do NOT modify any production source files (`src/**/*.ts` excluding `*.test.ts`)
- Do NOT modify CLI test files, stress test files, or validation-suite files outside explicit audit scope
- Do NOT create new test utility/helper files or extract shared fixtures
- Do NOT "improve" or "modernize" any test code — only remove, inline, or move as specified
- Do NOT touch the 16 non-audited `src/memory/*.test.ts` files: `tools.test.ts`, `storage.test.ts`, `visibility-policy.test.ts`, `embeddings.test.ts`, `core-memory.test.ts`, `contested-chain-v3.test.ts`, `cognition/cognition-search.test.ts`, `cognition/memory-relation-types.test.ts`, `cognition/belief-revision.test.ts`, `materialization.test.ts`, `time-slice-v3.test.ts`, `pinned-summary-proposal.test.ts`, `promotion.test.ts`, `shared-blocks/section-path-validator.test.ts`, `alias.test.ts`, `prompt-data.test.ts`

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES — Bun test runner
- **Automated tests**: Existing tests used as regression gates, no new tests written
- **Framework**: `bun test`

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

### Verification Command Set (ALL tasks)
```powershell
bun run build                              # Production type-check
bunx tsc --noEmit                          # Full type-check INCLUDING test files
bun run check:legacy-memory-surface        # Legacy gate
bun test                                   # Full suite
```

> **CRITICAL**: `bun run build` alone is NOT sufficient. It uses `tsconfig.build.json` which excludes `test/**` and `**/*.test.ts`. You MUST also run `bunx tsc --noEmit` which uses the base `tsconfig.json` and type-checks test files. Failing to do this will miss broken import paths in moved test files.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Sequential — git state dependency, each task commits before next starts):
├── T1: Preflight verification + coverage baseline [quick]
├── T2: Remove bootstrap tautology [quick] (depends: T1)
├── T3: Inline tool-permissions into runtime bootstrap [quick] (depends: T2)
└── T4: Move graph-node-ref + gate update + import rewrite [quick] (depends: T3)

Wave 2 (Parallel — 7 independent audit-then-act tasks):
├── T5: Schema-family audit-then-act (depends: T4) [deep]
├── T6: Navigator-family audit-then-act (depends: T4) [deep]
├── T7: Retrieval-family audit-then-act (depends: T4) [deep]
├── T8: Shared-blocks stress audit-then-act (depends: T4) [deep]
├── T9: Time-slice stress audit-then-act (depends: T4) [deep]
├── T10: Validation overlap audit-then-act (depends: T4) [deep]
└── T11: Legacy-test inventory + classify + conditional removals (depends: T4) [deep]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Full test suite + coverage comparison (unspecified-high)
└── F4: Scope fidelity check (deep)
→ Present results → Get explicit user okay

Critical Path: T1 → T2 → T3 → T4 → T5–T11 (parallel) → F1–F4 → user okay
Parallel Speedup: ~50% faster than fully sequential (7 parallel audits)
Max Concurrent: 7 (Wave 2)
```

### Dependency Matrix

| Task | Blocked By | Blocks |
|------|-----------|--------|
| T1   | —         | T2     |
| T2   | T1        | T3     |
| T3   | T2        | T4     |
| T4   | T3        | T5–T11 |
| T5   | T4        | F1–F4  |
| T6   | T4        | F1–F4  |
| T7   | T4        | F1–F4  |
| T8   | T4        | F1–F4  |
| T9   | T4        | F1–F4  |
| T10  | T4        | F1–F4  |
| T11  | T4        | F1–F4  |
| F1–F4| T5–T11    | user okay |

### Agent Dispatch Summary

- **Wave 1**: **4** — T1 → `quick`, T2 → `quick`, T3 → `quick`, T4 → `quick`
- **Wave 2**: **7** — T5–T11 → `deep` (each requires thorough file analysis + conditional action)
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## Philosophy (Preserved from Original Plan)

> A test is removed or merged only when we can explain **why it no longer adds signal**.

Allowed reasons:
1. **Pure scaffolding / tautology** — assertion that tests nothing (`expect(true).toBe(true)`)
2. **Legacy-only coverage** — for a production path that has already been removed
3. **Exact duplicate** — assertion-level duplicate already present elsewhere
4. **Thin wrapper** — unique assertion can be inlined into a more appropriate host test

### Wave 2 Audit Protocol

Each Wave 2 task follows a strict two-phase pattern:

**Phase A — Read-Only Audit** (MANDATORY first):
1. List all `describe(...)` blocks in both files
2. List all `it(...)` names in both files
3. Classify each source assertion as: `exact duplicate`, `complementary`, `historical/migration-only`, `obsolete`
4. Produce structured audit artifact → save to `.sisyphus/evidence/audit-{name}.md`
5. Choose recommendation: `keep separate` | `prune duplicates only` | `merge source into target` | `delete source after inline`

**Phase B — Conditional Action** (ONLY if Phase A recommends changes):
- If `keep separate`: log rationale, no file changes, commit audit artifact only
- If `prune duplicates only`: delete specific duplicate `it()` blocks, preserve unique assertions
- If `merge source into target`: copy unique assertions to target, delete source file
- If `delete source after inline`: inline unique assertions into target, delete source file
- After any file modification: run full verification command set

> **Wave 2 may result in zero file modifications. This is a valid and expected outcome.**

---

## TODOs

- [x] 1. Preflight Verification + Coverage Baseline

  **What to do**:
  - Run `bun test` and confirm zero failures — this establishes the green baseline
  - Capture test file inventory: count all `*.test.ts` files under `src/` and `test/` separately
  - Capture coverage baseline: `bun test --coverage 2>&1` and save output
  - Record results as the before-snapshot for the entire plan

  **Must NOT do**:
  - Modify any files
  - Skip the full test run — a pre-existing failure must be caught now, not confused with a regression later

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Read-only verification, no code changes, simple command execution
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1 (sequential position 1)
  - **Blocks**: T2, T3, T4
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `package.json:8` — `"build": "tsc -p tsconfig.build.json --noEmit"` (production type-check)
  - `package.json:9` — `"check:legacy-memory-surface": "bun test test/memory/legacy-literal-gate.test.ts"` (gate check)

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Full test suite passes before any changes
    Tool: Bash
    Preconditions: Clean working tree (no uncommitted changes)
    Steps:
      1. Run: bun test
      2. Assert: exit code 0, zero failures in output
      3. Run: bun run build
      4. Assert: exit code 0
      5. Run: bunx tsc --noEmit
      6. Assert: exit code 0
      7. Run: bun run check:legacy-memory-surface
      8. Assert: exit code 0
    Expected Result: All 4 commands pass with zero errors
    Failure Indicators: Any non-zero exit code, any "FAIL" in test output
    Evidence: .sisyphus/evidence/task-1-preflight-green.txt

  Scenario: Coverage baseline captured
    Tool: Bash
    Preconditions: Full test suite passes
    Steps:
      1. Run: bun test --coverage 2>&1 | Out-File -Encoding utf8 .sisyphus/evidence/task-1-coverage-baseline.txt
      2. Assert: file exists and is non-empty
      3. Count test files: (Get-ChildItem -Recurse -Filter "*.test.ts" src).Count — record as src_count
      4. Count test files: (Get-ChildItem -Recurse -Filter "*.test.ts" test).Count — record as test_count
      5. Record: "Baseline: {src_count} src + {test_count} test = {total} total"
    Expected Result: Coverage file saved, file counts recorded (expect 26 src + 86 test = 112)
    Failure Indicators: Coverage file empty, counts don't match expected 112
    Evidence: .sisyphus/evidence/task-1-coverage-baseline.txt
  ```

  **Commit**: NO (read-only task)

---

- [x] 2. Remove Tautology from `test/bootstrap.test.ts`

  **What to do**:
  - Delete the tautological test at lines 20–22: `it("should pass a basic truth assertion", () => { expect(true).toBe(true); });`
  - Keep the file with its 2 remaining version smoke tests (lines 9–18) — these verify `src/index.ts` exports and are genuinely useful
  - Run targeted test, then full verification suite

  **Must NOT do**:
  - Delete the entire file — the version smoke tests (`version()` and `VERSION`) have no other home
  - Modify the remaining tests in any way
  - Add or "improve" any assertions

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single-line deletion in a small file, trivial change
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1 (sequential position 2)
  - **Blocks**: T3
  - **Blocked By**: T1

  **References**:

  **Pattern References**:
  - `test/bootstrap.test.ts:20-22` — The tautological test to delete: `it("should pass a basic truth assertion", () => { expect(true).toBe(true); });`
  - `test/bootstrap.test.ts:9-18` — The 2 remaining tests to KEEP: `should import from src/index.ts without errors` and `should return the correct version`

  **Acceptance Criteria**:

  - [ ] Lines 20–22 removed from `test/bootstrap.test.ts`
  - [ ] File retains exactly 2 `it()` blocks
  - [ ] `bun test test/bootstrap.test.ts` → PASS (2 tests, 0 failures)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Tautology removed, version smoke tests preserved
    Tool: Bash
    Preconditions: T1 completed, baseline green
    Steps:
      1. Verify line "expect(true).toBe(true)" does NOT appear in test/bootstrap.test.ts
      2. Verify line "should import from src/index.ts without errors" DOES appear
      3. Verify line "should return the correct version" DOES appear
      4. Run: bun test test/bootstrap.test.ts
      5. Assert: 2 tests pass, 0 failures
      6. Run: bunx tsc --noEmit
      7. Assert: exit code 0
      8. Run: bun test
      9. Assert: exit code 0, zero failures
    Expected Result: File has 2 passing tests, tautology gone
    Failure Indicators: "expect(true).toBe(true)" still present, test count != 2, any failure
    Evidence: .sisyphus/evidence/task-2-bootstrap-trimmed.txt
  ```

  **Commit**: YES
  - Message: `test(rationalize): remove tautology from bootstrap smoke test`
  - Body: `DELETED: it("should pass a basic truth assertion") — REASON: pure tautology (expect(true).toBe(true))`
  - Body: `PRESERVED: version() and VERSION smoke tests remain in test/bootstrap.test.ts`
  - Files: `test/bootstrap.test.ts`
  - Pre-commit: `bun test test/bootstrap.test.ts`

- [x] 3. Inline `tool-permissions.test.ts` into `test/runtime/bootstrap.test.ts`

  **What to do**:
  - Add 4 new imports to `test/runtime/bootstrap.test.ts`:
    ```typescript
    import { registerRuntimeTools } from "../../src/bootstrap/tools.js";
    import { CoreMemoryService } from "../../src/memory/core-memory.js";
    import { ALL_MEMORY_TOOL_NAMES, MEMORY_TOOL_NAMES } from "../../src/memory/tool-names.js";
    ```
  - Copy the entire `describe("runtime tool registration", ...)` block (lines 7–34 of `tool-permissions.test.ts`) as a NEW top-level `describe` block at the end of `test/runtime/bootstrap.test.ts`
  - Verify the host file compiles and the inlined test passes
  - Delete `test/runtime/tool-permissions.test.ts`
  - Run full verification suite

  **Must NOT do**:
  - Modify the existing 5 tests in `test/runtime/bootstrap.test.ts`
  - Rename or refactor the inlined test — copy it exactly
  - Create a new file instead of inlining
  - "Improve" the inlined test (no assertion modernization, no cleanup)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Mechanical copy-paste of one describe block + 4 imports, then delete source
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1 (sequential position 3)
  - **Blocks**: T4
  - **Blocked By**: T2

  **References**:

  **Pattern References**:
  - `test/runtime/tool-permissions.test.ts:1-35` — The ENTIRE file to inline (1 describe, 1 it, 4 imports, ~25 lines of test body)
  - `test/runtime/bootstrap.test.ts:1-128` — The host file (5 existing tests in `describe("bootstrapRuntime")`, 128 lines)

  **API/Type References**:
  - `src/bootstrap/tools.ts:registerRuntimeTools` — Function under test in the inlined assertion
  - `src/memory/core-memory.ts:CoreMemoryService` — Used to verify tool execution writes
  - `src/memory/tool-names.ts:ALL_MEMORY_TOOL_NAMES, MEMORY_TOOL_NAMES` — Constants used for schema verification

  **WHY Each Reference Matters**:
  - `tool-permissions.test.ts` is the SOLE source — copy its describe block verbatim
  - `bootstrap.test.ts` is the SOLE target — add the new describe block AFTER the existing `describe("bootstrapRuntime")` block
  - The 4 imports must be added to the top of the host file alongside existing imports

  **Acceptance Criteria**:

  - [ ] `test/runtime/bootstrap.test.ts` contains a new `describe("runtime tool registration")` block
  - [ ] All 4 new imports present at top of file
  - [ ] Original 5 tests unchanged
  - [ ] `bun test test/runtime/bootstrap.test.ts` → PASS (6 tests total, 0 failures)
  - [ ] `test/runtime/tool-permissions.test.ts` deleted (file does not exist)
  - [ ] `bunx tsc --noEmit` → exit code 0

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Inlined test passes in host file
    Tool: Bash
    Preconditions: T2 committed, tree clean
    Steps:
      1. Run: bun test test/runtime/bootstrap.test.ts
      2. Assert: output contains "runtime tool registration"
      3. Assert: 6 tests pass (5 original + 1 inlined), 0 failures
      4. Verify: test/runtime/tool-permissions.test.ts does NOT exist
      5. Run: bunx tsc --noEmit
      6. Assert: exit code 0
      7. Run: bun test
      8. Assert: exit code 0, zero failures
    Expected Result: Inlined test passes, source file deleted, no regressions
    Failure Indicators: "tool-permissions.test.ts" still exists, test count != 6, any failure
    Evidence: .sisyphus/evidence/task-3-tool-permissions-inlined.txt

  Scenario: No orphaned imports after deletion
    Tool: Bash
    Preconditions: tool-permissions.test.ts deleted
    Steps:
      1. Search all files for imports of "tool-permissions": grep -r "tool-permissions" test/ src/
      2. Assert: zero matches (no file imports the deleted file)
    Expected Result: No remaining references to deleted file
    Failure Indicators: Any grep match found
    Evidence: .sisyphus/evidence/task-3-no-orphans.txt
  ```

  **Commit**: YES
  - Message: `test(rationalize): inline tool-permissions into runtime bootstrap test`
  - Body: `DELETED: test/runtime/tool-permissions.test.ts — REASON: thin-wrapper-inlined`
  - Body: `PRESERVED: describe("runtime tool registration") moved to test/runtime/bootstrap.test.ts`
  - Files: `test/runtime/bootstrap.test.ts`, `test/runtime/tool-permissions.test.ts` (deleted)
  - Pre-commit: `bun test test/runtime/bootstrap.test.ts`

---

- [x] 4. Move `graph-node-ref.test.ts` + Gate Update + Import Rewrite

  **What to do**:
  - Create directory `test/memory/contracts/` (it does not exist)
  - Move `src/memory/contracts/graph-node-ref.test.ts` → `test/memory/contracts/graph-node-ref.test.ts`
  - Rewrite the relative import in the moved file:
    - OLD (line 2): `from "./graph-node-ref.js"`
    - NEW: `from "../../../src/memory/contracts/graph-node-ref.js"`
  - Update `test/memory/legacy-literal-gate.test.ts` ALLOWED_FILES (line 9) — this is a SET REPLACEMENT:
    - REMOVE: `"src/memory/contracts/graph-node-ref.test.ts"`
    - ADD: `"test/memory/contracts/graph-node-ref.test.ts"`
  - All three changes (move + import rewrite + gate update) in ONE atomic commit
  - Run full verification suite

  **Must NOT do**:
  - Move the file WITHOUT updating the gate — this breaks CI
  - Update the gate WITHOUT removing the old path — makes the gate permissive to a stale path
  - Modify any test assertions in graph-node-ref.test.ts — only the import path changes
  - Move any other file in this task

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: File move + 2 line edits, well-defined mechanical change
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1 (sequential position 4, final)
  - **Blocks**: T5, T6, T7, T8, T9, T10, T11
  - **Blocked By**: T3

  **References**:

  **Pattern References**:
  - `src/memory/contracts/graph-node-ref.test.ts:2-6` — Import block to rewrite: `import { type GraphNodeRef, parseGraphNodeRef, serializeGraphNodeRef } from "./graph-node-ref.js"`
  - `src/memory/contracts/graph-node-ref.test.ts:35-37` — Legacy rejection tests (`private_event`, `private_belief`) — these contain FORBIDDEN_TOKENS by design, which is why the gate whitelist exists
  - `test/memory/legacy-literal-gate.test.ts:6-10` — The `ALLOWED_FILES` Set that must be updated

  **WHY Each Reference Matters**:
  - The import path `"./graph-node-ref.js"` is relative to `src/memory/contracts/` — after moving to `test/memory/contracts/`, it must become `"../../../src/memory/contracts/graph-node-ref.js"`
  - Lines 35-37 contain `private_event` and `private_belief` strings as test inputs — the gate deliberately whitelists this file so these strings don't trigger violations
  - ALLOWED_FILES line 9 must change from `"src/memory/contracts/graph-node-ref.test.ts"` to `"test/memory/contracts/graph-node-ref.test.ts"`

  **Acceptance Criteria**:

  - [ ] `src/memory/contracts/graph-node-ref.test.ts` does NOT exist
  - [ ] `test/memory/contracts/graph-node-ref.test.ts` exists with correct import path
  - [ ] ALLOWED_FILES in gate file contains `"test/memory/contracts/graph-node-ref.test.ts"` and does NOT contain `"src/memory/contracts/graph-node-ref.test.ts"`
  - [ ] `bun test test/memory/contracts/graph-node-ref.test.ts` → PASS
  - [ ] `bun run check:legacy-memory-surface` → PASS
  - [ ] `bunx tsc --noEmit` → exit code 0

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Moved test passes at new location
    Tool: Bash
    Preconditions: T3 committed, tree clean
    Steps:
      1. Verify: test/memory/contracts/graph-node-ref.test.ts exists
      2. Verify: src/memory/contracts/graph-node-ref.test.ts does NOT exist
      3. Verify: import path in test/memory/contracts/graph-node-ref.test.ts contains "../../../src/memory/contracts/graph-node-ref.js"
      4. Run: bun test test/memory/contracts/graph-node-ref.test.ts
      5. Assert: all tests pass (parseGraphNodeRef, serializeGraphNodeRef, roundtrip — 6 it blocks)
    Expected Result: All 6 test cases pass at the new location
    Failure Indicators: File not found, import error, any test failure
    Evidence: .sisyphus/evidence/task-4-graph-node-ref-moved.txt

  Scenario: Legacy gate updated atomically
    Tool: Bash
    Preconditions: File moved, imports rewritten
    Steps:
      1. Read test/memory/legacy-literal-gate.test.ts
      2. Assert: ALLOWED_FILES contains "test/memory/contracts/graph-node-ref.test.ts"
      3. Assert: ALLOWED_FILES does NOT contain "src/memory/contracts/graph-node-ref.test.ts"
      4. Run: bun run check:legacy-memory-surface
      5. Assert: 1 test, 0 failures
      6. Run: bunx tsc --noEmit
      7. Assert: exit code 0
      8. Run: bun test
      9. Assert: exit code 0, zero failures
    Expected Result: Gate correctly whitelists new path, all checks pass
    Failure Indicators: Old path still in ALLOWED_FILES, gate test fails, any regression
    Evidence: .sisyphus/evidence/task-4-gate-updated.txt
  ```

  **Commit**: YES
  - Message: `test(rationalize): move graph-node-ref test to test/ and update legacy gate`
  - Body: `MOVED: src/memory/contracts/graph-node-ref.test.ts → test/memory/contracts/graph-node-ref.test.ts`
  - Body: `UPDATED: test/memory/legacy-literal-gate.test.ts ALLOWED_FILES — replaced old path with new path`
  - Body: `REWRITTEN: import path from "./graph-node-ref.js" to "../../../src/memory/contracts/graph-node-ref.js"`
  - Files: `test/memory/contracts/graph-node-ref.test.ts` (new), `src/memory/contracts/graph-node-ref.test.ts` (deleted), `test/memory/legacy-literal-gate.test.ts` (modified)
  - Pre-commit: `bun run check:legacy-memory-surface && bun test test/memory/contracts/graph-node-ref.test.ts`

- [x] 5. Schema-Family Audit-Then-Act

  **What to do**:
  **Phase A — Read-Only Audit:**
  - Read `src/memory/schema.test.ts` (769 lines) and `test/memory/schema.test.ts` (1404 lines) in full
  - List all `describe(...)` and `it(...)` blocks in both files
  - Classify each assertion in the source (`src/`) as: `exact duplicate`, `complementary`, `historical/migration-only`, or `obsolete`
  - Note: `test/memory/schema.test.ts` is in the legacy gate's ALLOWED_FILES — if source is merged into target, the gate entry must remain; if source is deleted entirely, verify no gate impact
  - Save structured audit artifact to `.sisyphus/evidence/audit-schema.md`
  - Recommend one action: `keep separate` | `prune duplicates only` | `merge source into target` | `delete source after inline`

  **Phase B — Conditional Action:**
  - Execute ONLY the Phase A recommendation
  - If `keep separate`: no file changes
  - If any modification: run full verification command set, commit with rationale

  **Must NOT do**:
  - Assume overlap from file names alone — the size difference (769 vs 1404) suggests different layers
  - Modify `test/memory/legacy-literal-gate.test.ts` ALLOWED_FILES unless the source file is deleted (it currently whitelists `test/memory/schema.test.ts`)
  - Touch `src/memory/schema.ts` (production source, out of scope)
  - Refactor, modernize, or "clean up" any test code

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Thorough line-by-line comparison of 769 + 1404 lines, assertion-level classification
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T6, T7, T8, T9, T10, T11)
  - **Blocks**: F1–F4
  - **Blocked By**: T4

  **References**:

  **Pattern References**:
  - `src/memory/schema.test.ts:1-769` — Source file: 769 lines, starts with `createMemorySchema` tests, includes enum coverage, `makeNodeRef`, `TransactionBatcher`, migration tests
  - `test/memory/schema.test.ts:1-1404` — Target file: 1404 lines, imports `GraphNavigator` + `NODE_REF_KINDS`, uses `openDatabase` wrapper, includes migration and node-ref tests
  - `test/memory/legacy-literal-gate.test.ts:7-8` — ALLOWED_FILES includes `"src/memory/schema.ts"` and `"test/memory/schema.test.ts"` — these entries exist because these files legitimately contain forbidden tokens for migration/schema purposes

  **Audit Artifact Template**:
  ```markdown
  ## Audit: Schema Family
  ### Source: src/memory/schema.test.ts (769 lines, N describe blocks, M it blocks)
  ### Target: test/memory/schema.test.ts (1404 lines, N describe blocks, M it blocks)
  ### Overlap Analysis:
  - Exact duplicate assertions: [list with line numbers or "none"]
  - Complementary assertions: [list]
  - Legacy/migration-only: [list or "none"]
  - Obsolete: [list or "none"]
  ### Recommendation: [keep separate | prune duplicates | merge | delete after inline]
  ### Rationale: [why]
  ### If action recommended, specific assertions to move/delete: [list with line numbers]
  ```

  **Acceptance Criteria**:

  - [ ] Audit artifact saved to `.sisyphus/evidence/audit-schema.md`
  - [ ] Artifact contains complete describe/it listing for both files
  - [ ] Every assertion classified with rationale
  - [ ] If file changes made: `bun test` passes, `bunx tsc --noEmit` passes, `bun run check:legacy-memory-surface` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Audit artifact is complete and well-formed
    Tool: Bash
    Preconditions: Both files read in full
    Steps:
      1. Verify .sisyphus/evidence/audit-schema.md exists
      2. Assert: file contains "## Audit: Schema Family"
      3. Assert: file contains "### Recommendation:"
      4. Assert: file contains "### Rationale:"
      5. Assert: file lists every describe() and it() block from both files
    Expected Result: Complete, structured audit artifact
    Failure Indicators: Missing sections, incomplete it() listing
    Evidence: .sisyphus/evidence/audit-schema.md

  Scenario: No regression after any changes (if applicable)
    Tool: Bash
    Preconditions: Phase B completed (or skipped if "keep separate")
    Steps:
      1. Run: bun test src/memory/schema.test.ts (if still exists)
      2. Run: bun test test/memory/schema.test.ts
      3. Run: bun run check:legacy-memory-surface
      4. Run: bunx tsc --noEmit
      5. Run: bun test
      6. Assert: all pass
    Expected Result: Zero regressions
    Failure Indicators: Any test failure, any type error
    Evidence: .sisyphus/evidence/task-5-schema-verified.txt
  ```

  **Commit**: YES (only if Phase B modified files) | NO (if "keep separate")
  - Message: `test(rationalize): [action] schema test [domain detail]`
  - Body: `DELETED/PRESERVED manifest per commit strategy`
  - Pre-commit: `bun test src/memory/schema.test.ts test/memory/schema.test.ts`

---

- [x] 6. Navigator-Family Audit-Then-Act

  **What to do**:
  **Phase A — Read-Only Audit:**
  - Read `src/memory/navigator.test.ts` (839 lines) and `test/memory/navigator.test.ts` (220 lines) in full
  - List all `describe(...)` and `it(...)` blocks in both files
  - Classify each assertion in the SMALLER file (`test/`, 220 lines) against the LARGER file (`src/`, 839 lines)
  - Note: the size ratio (839 vs 220) strongly suggests different coverage layers — verify this
  - Save structured audit artifact to `.sisyphus/evidence/audit-navigator.md`

  **Phase B — Conditional Action:**
  - Execute ONLY the Phase A recommendation
  - If `keep separate`: no file changes
  - If any modification: run full verification command set, commit with rationale

  **Must NOT do**:
  - Assume the smaller file is a subset of the larger — it may cover different scenarios (e.g., explain-shell tests)
  - Modify `src/memory/navigator.ts` (production source)
  - Extract shared test fixtures (`freshDb`, `viewer`, `insertEntity`)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 839 + 220 lines comparison, need to understand navigator domain semantics
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T5, T7, T8, T9, T10, T11)
  - **Blocks**: F1–F4
  - **Blocked By**: T4

  **References**:

  **Pattern References**:
  - `src/memory/navigator.test.ts:1-839` — Source: comprehensive navigator tests, imports `GRAPH_RETRIEVAL_STRATEGIES`, `NarrativeSearchServiceLike`, `CognitionSearchServiceLike`, `RetrievalService`
  - `test/memory/navigator.test.ts:1-220` — Target: smaller focused tests, imports only `GraphNavigator`, `AliasService`, schema types
  - Both files share helper pattern: `freshDb()`, `viewer()/viewerA()`, `insertEntity()` — but these are NOT shared code, they are independent implementations

  **Audit Artifact Template**: Same structure as T5

  **Acceptance Criteria**:
  - [ ] Audit artifact saved to `.sisyphus/evidence/audit-navigator.md`
  - [ ] Artifact contains complete describe/it listing for both files
  - [ ] If file changes made: all verification commands pass

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Audit artifact is complete
    Tool: Bash
    Preconditions: Both files read in full
    Steps:
      1. Verify .sisyphus/evidence/audit-navigator.md exists
      2. Assert: contains "### Recommendation:" and "### Rationale:"
      3. Assert: lists all describe/it blocks from both files
    Expected Result: Complete audit artifact
    Evidence: .sisyphus/evidence/audit-navigator.md

  Scenario: No regression after any changes
    Tool: Bash
    Preconditions: Phase B completed or skipped
    Steps:
      1. Run: bun test src/memory/navigator.test.ts (if exists)
      2. Run: bun test test/memory/navigator.test.ts (if exists)
      3. Run: bunx tsc --noEmit && bun test
      4. Assert: all pass
    Expected Result: Zero regressions
    Evidence: .sisyphus/evidence/task-6-navigator-verified.txt
  ```

  **Commit**: YES (only if Phase B modified files) | NO (if "keep separate")
  - Message: `test(rationalize): [action] navigator test [domain detail]`
  - Pre-commit: `bun test src/memory/navigator.test.ts test/memory/navigator.test.ts`

---

- [x] 7. Retrieval-Family Audit-Then-Act

  **What to do**:
  **Phase A — Read-Only Audit:**
  - Read `src/memory/retrieval.test.ts` (296 lines) and `test/memory/retrieval-search.test.ts` (1783 lines) in full
  - List all `describe(...)` and `it(...)` blocks in both files
  - Note: extreme size difference (296 vs 1783) — the source is likely service/unit oriented while the target covers orchestration and typed retrieval surfaces
  - Save structured audit artifact to `.sisyphus/evidence/audit-retrieval.md`

  **Phase B — Conditional Action:**
  - Execute ONLY the Phase A recommendation
  - If `keep separate`: no file changes

  **Must NOT do**:
  - Assume overlap from both mentioning "retrieval"
  - Modify `src/memory/retrieval.ts` (production source)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 296 + 1783 lines comparison, need to distinguish unit vs orchestration layers
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T5, T6, T8, T9, T10, T11)
  - **Blocks**: F1–F4
  - **Blocked By**: T4

  **References**:

  **Pattern References**:
  - `src/memory/retrieval.test.ts:1-296` — Source: smaller service/unit file
  - `test/memory/retrieval-search.test.ts:1-1783` — Target: large orchestration + typed retrieval surfaces file

  **Audit Artifact Template**: Same structure as T5

  **Acceptance Criteria**:
  - [ ] Audit artifact saved to `.sisyphus/evidence/audit-retrieval.md`
  - [ ] Complete describe/it listing, each assertion classified
  - [ ] If file changes made: all verification commands pass

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Audit artifact is complete
    Tool: Bash
    Steps:
      1. Verify .sisyphus/evidence/audit-retrieval.md exists and is well-formed
    Expected Result: Complete audit
    Evidence: .sisyphus/evidence/audit-retrieval.md

  Scenario: No regression after any changes
    Tool: Bash
    Steps:
      1. Run: bun test src/memory/retrieval.test.ts (if exists)
      2. Run: bun test test/memory/retrieval-search.test.ts
      3. Run: bunx tsc --noEmit && bun test
      4. Assert: all pass
    Expected Result: Zero regressions
    Evidence: .sisyphus/evidence/task-7-retrieval-verified.txt
  ```

  **Commit**: YES (only if Phase B modified files) | NO (if "keep separate")
  - Message: `test(rationalize): [action] retrieval test [domain detail]`
  - Pre-commit: `bun test src/memory/retrieval.test.ts test/memory/retrieval-search.test.ts`

- [x] 8. Shared-Blocks Stress Audit-Then-Act

  **What to do**:
  **Phase A — Read-Only Audit:**
  - Read `src/memory/stress-shared-blocks.test.ts` (409 lines) and `src/memory/shared-blocks/shared-blocks.test.ts` (871 lines) in full
  - The stress file covers: sequential patch ordering, concurrent collision detection, permission matrix enforcement, retrieval_only exclusion, audit trail integrity
  - The unit file covers: core shared-block CRUD operations
  - Classify: which stress scenarios merely repeat unit coverage vs which add genuinely broader scenario testing
  - Save structured audit artifact to `.sisyphus/evidence/audit-shared-blocks.md`

  **Phase B — Conditional Action:**
  - If `prune duplicates only`: delete specific duplicate `it()` blocks from the stress file, keeping unique stress scenarios
  - If `keep separate`: no file changes

  **Must NOT do**:
  - Delete the entire stress file — performance/stress tests should remain standalone unless proven fully duplicated
  - Move the stress file (both files are under `src/`, no relocation needed)
  - Modify `src/memory/shared-blocks/` production files

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Must distinguish unit assertions from stress scenarios in 409 + 871 lines
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T5, T6, T7, T9, T10, T11)
  - **Blocks**: F1–F4
  - **Blocked By**: T4

  **References**:

  **Pattern References**:
  - `src/memory/stress-shared-blocks.test.ts:1-409` — Stress test: imports `SharedBlockRepo`, `SharedBlockPatchService`, `PatchSeqConflictError`, `SharedBlockPermissions`, `SharedBlockAttachService`, `SharedBlockAuditFacade`
  - `src/memory/shared-blocks/shared-blocks.test.ts:1-871` — Unit test: core shared-block operations

  **Acceptance Criteria**:
  - [ ] Audit artifact saved to `.sisyphus/evidence/audit-shared-blocks.md`
  - [ ] If file changes made: `bun test src/memory/stress-shared-blocks.test.ts` passes, `bun test` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Audit artifact complete
    Tool: Bash
    Steps:
      1. Verify .sisyphus/evidence/audit-shared-blocks.md exists and lists all describe/it blocks
    Evidence: .sisyphus/evidence/audit-shared-blocks.md

  Scenario: No regression after any changes
    Tool: Bash
    Steps:
      1. Run: bun test src/memory/stress-shared-blocks.test.ts (if exists)
      2. Run: bun test src/memory/shared-blocks/shared-blocks.test.ts
      3. Run: bunx tsc --noEmit && bun test
    Expected Result: Zero regressions
    Evidence: .sisyphus/evidence/task-8-shared-blocks-verified.txt
  ```

  **Commit**: YES (only if Phase B modified files) | NO (if "keep separate")
  - Message: `test(rationalize): [action] shared-blocks stress tests`
  - Pre-commit: `bun test src/memory/stress-shared-blocks.test.ts`

---

- [x] 9. Time-Slice Stress Audit-Then-Act

  **What to do**:
  **Phase A — Read-Only Audit:**
  - Read `src/memory/stress-time-slice.test.ts` (279 lines) and `test/memory/time-slice-query.test.ts` (294 lines) in full
  - Both files are similar size (279 vs 294) — more likely to have real overlap than other pairs
  - The stress file covers: dual-dimension filtering, t_valid=0 edge cases, boundary conditions, large-dataset performance, empty-result scenarios
  - Classify: which assertions are deterministic duplicate boundary checks vs meaningful standalone stress assertions
  - Save structured audit artifact to `.sisyphus/evidence/audit-time-slice.md`

  **Phase B — Conditional Action:**
  - Execute ONLY the Phase A recommendation
  - Pay special attention to performance/boundary tests — these should remain even if a related unit test exists

  **Must NOT do**:
  - Delete performance-oriented tests unless proven to be exact duplicates
  - Modify `src/memory/time-slice-query.ts` (production source)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Similar-size files (279 vs 294) require careful assertion-level comparison
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T5, T6, T7, T8, T10, T11)
  - **Blocks**: F1–F4
  - **Blocked By**: T4

  **References**:

  **Pattern References**:
  - `src/memory/stress-time-slice.test.ts:1-279` — Stress test: imports `filterProjectionRowsByTimeSlice`, `isEdgeInTimeSlice`, `isProjectionRowInTimeSlice`, `TimeSliceQuery`, `TimeAwareProjectionRow`
  - `test/memory/time-slice-query.test.ts:1-294` — Query test: time-slice query coverage

  **Acceptance Criteria**:
  - [ ] Audit artifact saved to `.sisyphus/evidence/audit-time-slice.md`
  - [ ] If changes made: `bun test` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Audit artifact complete
    Tool: Bash
    Steps:
      1. Verify .sisyphus/evidence/audit-time-slice.md exists
    Evidence: .sisyphus/evidence/audit-time-slice.md

  Scenario: No regression after any changes
    Tool: Bash
    Steps:
      1. Run: bun test src/memory/stress-time-slice.test.ts (if exists)
      2. Run: bun test test/memory/time-slice-query.test.ts
      3. Run: bunx tsc --noEmit && bun test
    Expected Result: Zero regressions
    Evidence: .sisyphus/evidence/task-9-time-slice-verified.txt
  ```

  **Commit**: YES (only if Phase B modified files) | NO (if "keep separate")
  - Message: `test(rationalize): [action] time-slice stress tests`
  - Pre-commit: `bun test src/memory/stress-time-slice.test.ts test/memory/time-slice-query.test.ts`

---

- [x] 10. Validation Overlap Audit-Then-Act (2 Pairs)

  **What to do**:
  **Phase A — Read-Only Audit (2 pairs in one task):**

  **Pair 1**: `test/memory/validation-contested-cognition.test.ts` (339 lines) vs `test/memory/cognition-commit.test.ts` (2414 lines)
  - Extreme size difference (339 vs 2414) — the validation file is likely a focused scenario, not a duplicate
  - Note: `validation-contested-cognition.test.ts` may import from `memory-test-utils.ts` — verify and preserve imports if merging

  **Pair 2**: `test/memory/validation-explain-visibility.test.ts` (315 lines) vs `test/memory/visibility-isolation.test.ts` (245 lines)
  - Similar sizes (315 vs 245) — more likely to have overlap
  - Note: `validation-explain-visibility.test.ts` may import from `memory-test-utils.ts`

  - List all `describe(...)` and `it(...)` blocks in all 4 files
  - Classify assertions per pair
  - Save structured audit artifact to `.sisyphus/evidence/audit-validation-overlap.md`

  **Phase B — Conditional Action:**
  - Execute ONLY the Phase A recommendations (one recommendation per pair)
  - If merging, preserve `memory-test-utils.ts` imports correctly

  **Must NOT do**:
  - Fold these into `test/memory/integration.test.ts` — that is a separate focused file
  - Touch other validation-suite files (`validation-cross-session`, `validation-episode-lifecycle`, `validation-publication-pipeline`, `validation-area-world-surfacing`)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 4 files to analyze (339 + 2414 + 315 + 245 = 3313 lines total), assertion-level comparison
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T5, T6, T7, T8, T9, T11)
  - **Blocks**: F1–F4
  - **Blocked By**: T4

  **References**:

  **Pattern References**:
  - `test/memory/validation-contested-cognition.test.ts:1-339` — Validation scenario for contested cognition
  - `test/memory/cognition-commit.test.ts:1-2414` — Comprehensive cognition commit coverage (7x larger)
  - `test/memory/validation-explain-visibility.test.ts:1-315` — Validation scenario for explain visibility
  - `test/memory/visibility-isolation.test.ts:1-245` — Visibility isolation coverage

  **External References**:
  - `test/memory/memory-test-utils.ts` (if it exists) — shared test utility used by validation files; imports must be preserved if merging

  **Acceptance Criteria**:
  - [ ] Audit artifact saved to `.sisyphus/evidence/audit-validation-overlap.md`
  - [ ] Two separate recommendations (one per pair)
  - [ ] If changes made: `bun test` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Audit artifact covers both pairs
    Tool: Bash
    Steps:
      1. Verify .sisyphus/evidence/audit-validation-overlap.md exists
      2. Assert: contains separate sections for Pair 1 and Pair 2
      3. Assert: each pair has its own recommendation
    Evidence: .sisyphus/evidence/audit-validation-overlap.md

  Scenario: No regression after any changes
    Tool: Bash
    Steps:
      1. Run: bun test test/memory/validation-contested-cognition.test.ts (if exists)
      2. Run: bun test test/memory/cognition-commit.test.ts
      3. Run: bun test test/memory/validation-explain-visibility.test.ts (if exists)
      4. Run: bun test test/memory/visibility-isolation.test.ts
      5. Run: bunx tsc --noEmit && bun test
    Expected Result: Zero regressions
    Evidence: .sisyphus/evidence/task-10-validation-verified.txt
  ```

  **Commit**: YES (only if Phase B modified files) | NO (if "keep separate")
  - Message: `test(rationalize): [action] validation overlap [pair detail]`
  - Pre-commit: `bun test test/memory/validation-contested-cognition.test.ts test/memory/cognition-commit.test.ts test/memory/validation-explain-visibility.test.ts test/memory/visibility-isolation.test.ts`

- [x] 11. Legacy-Test Inventory + Classify + Conditional Removals

  **What to do**:
  **Phase A — Read-Only Inventory:**
  - Inspect the following files that intentionally cover legacy/compatibility behavior (NOT covered by other Wave 2 audits):
    - `src/memory/task-agent.test.ts` — task-agent behavior
    - `test/runtime/rp-turn-contract.test.ts` — RP turn contract
    - `test/core/models/bootstrap.test.ts` — model bootstrap
    - `test/interaction/interaction-log.test.ts` — interaction log
  - For each file, determine:
    1. Does the test cover a production path that STILL EXISTS in the codebase?
    2. Is it temporary historical coverage that will disappear after a known follow-up?
    3. Is it truly obsolete and removable now?
  - To verify whether a production path still exists: use `lsp_find_references` or `grep` to trace the functions/types under test back to production code
  - Save classification to `.sisyphus/evidence/audit-legacy.md`

  **Phase B — Conditional Removals:**
  - A legacy test can be removed ONLY IF the corresponding runtime/compatibility/migration path has already been retired from production code
  - If no tests qualify for removal: log rationale in audit artifact, no file changes — this is a valid outcome
  - If removals are warranted: delete only the specific tests/files that cover retired paths

  **Must NOT do**:
  - Delete tests based on label alone (`legacy`, `v3`, `proposal`)
  - Touch files covered by other Wave 2 audits (schema, navigator, retrieval, etc.)
  - Touch the 16 non-audited `src/memory/*.test.ts` files listed in the guardrails
  - Modify production source code even if it looks dead — production changes require a separate plan
  - Touch `src/memory/contracts/graph-node-ref.test.ts` (already moved in T4) or migration-focused sections of `test/memory/schema.test.ts` (covered by T5)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Must trace test assertions back to production code to verify path existence
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T5, T6, T7, T8, T9, T10)
  - **Blocks**: F1–F4
  - **Blocked By**: T4

  **References**:

  **Pattern References**:
  - `src/memory/task-agent.test.ts` — Tests task-agent memory behavior; trace `TaskAgent` or equivalent to verify production usage
  - `test/runtime/rp-turn-contract.test.ts` — Tests RP turn contract; trace the contract type to verify it's still used in runtime
  - `test/core/models/bootstrap.test.ts` — Tests model bootstrap; trace model registration to verify it's still active
  - `test/interaction/interaction-log.test.ts` — Tests interaction logging; trace `InteractionLog` or equivalent to verify production usage

  **WHY Each Reference Matters**:
  - Each file covers a different production domain — the agent must trace the tested code back to verify the production path is still live
  - If the production function/type/path has been removed, the test is a valid removal candidate
  - If the production path still exists, the test MUST stay regardless of naming

  **Acceptance Criteria**:
  - [ ] Audit artifact saved to `.sisyphus/evidence/audit-legacy.md`
  - [ ] Every file classified as: `still required` | `temporary historical` | `obsolete/removable`
  - [ ] For each classification: evidence provided (production path reference or proof of retirement)
  - [ ] If file changes made: `bun test` passes, `bunx tsc --noEmit` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Legacy audit artifact is complete
    Tool: Bash
    Steps:
      1. Verify .sisyphus/evidence/audit-legacy.md exists
      2. Assert: contains classification for all 4 target files
      3. Assert: each classification includes evidence (production path reference)
    Evidence: .sisyphus/evidence/audit-legacy.md

  Scenario: No regression after any removals (if applicable)
    Tool: Bash
    Steps:
      1. Run: bun test (full suite)
      2. Run: bunx tsc --noEmit
      3. Assert: all pass
    Expected Result: Zero regressions; only tests covering retired production paths were removed
    Failure Indicators: Any test failure, any type error
    Evidence: .sisyphus/evidence/task-11-legacy-verified.txt

  Scenario: No forbidden files touched
    Tool: Bash
    Steps:
      1. Run: git diff --name-only (check what files were modified)
      2. Assert: no files from the 16 non-audited src/memory/*.test.ts list appear
      3. Assert: no files from other Wave 2 audit pairs appear
      4. Assert: no production source files (src/**/*.ts excluding *.test.ts) appear
    Expected Result: Only the 4 target files (or subset) were modified/deleted
    Evidence: .sisyphus/evidence/task-11-scope-check.txt
  ```

  **Commit**: YES (only if removals made) | NO (if all tests still required)
  - Message: `test(rationalize): retire legacy-only coverage after classification`
  - Body: `DELETED: [file] — REASON: legacy-only, production path [path] has been retired`
  - Pre-commit: `bun test`

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.sisyphus/evidence/`. Verify audit artifacts exist for all 7 pairs. Verify coverage baseline and final comparison exist.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `bunx tsc --noEmit` + `bun test`. Review all changed files for: orphaned imports from deleted files, broken relative paths, `as any`/`@ts-ignore` introduced by moves, commented-out code. Verify no production source files (`src/**/*.ts` excluding `*.test.ts`) were modified.
  Output: `TypeCheck [PASS/FAIL] | Tests [N pass/N fail] | Orphans [CLEAN/N issues] | VERDICT`

- [x] F3. **Full Test Suite + Coverage Comparison** — `unspecified-high`
  Run `bun test` from clean state. Compare test file count before/after. Compare coverage output against `.sisyphus/evidence/task-1-coverage-baseline.txt`. Verify no previously-covered lines became uncovered. Run `bun run check:legacy-memory-surface`.
  Output: `Tests [N/N pass] | Files Before/After [N/N] | Coverage [preserved/regressed] | Gate [PASS/FAIL] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (`git log --oneline`, `git diff` from plan start). Verify 1:1 — everything in spec was done, nothing beyond spec was done. Check "Must NOT do" compliance. Verify no non-audited `src/memory/*.test.ts` files were touched. Verify no CLI/stress/validation files were modified outside explicit scope. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Scope [CLEAN/N violations] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

Commits grouped by logical change, one per modification. Wave 1 sequential commits, Wave 2 one commit per audit-action pair.

| Task | Commit Message | Pre-commit |
|------|---------------|------------|
| T2 | `test(rationalize): remove tautology from bootstrap smoke test` | `bun test test/bootstrap.test.ts` |
| T3 | `test(rationalize): inline tool-permissions into runtime bootstrap test` | `bun test test/runtime/bootstrap.test.ts` |
| T4 | `test(rationalize): move graph-node-ref test to test/ and update legacy gate` | `bun run check:legacy-memory-surface` |
| T5–T10 | `test(rationalize): [audit-finding-based action] in [domain]` | `bun test [affected files]` |
| T11 | `test(rationalize): retire legacy-only coverage after classification` | `bun test [affected files]` |

> Each commit message MUST include a DELETED/PRESERVED manifest:
> ```
> DELETED: [file or assertion] — REASON: [useless|legacy-only|duplicate|thin-wrapper-inlined]
> PRESERVED: [assertion] moved to [destination file]
> ```

---

## Success Criteria

### Verification Commands
```powershell
bun run build                           # Expected: clean exit
bunx tsc --noEmit                       # Expected: clean exit (includes test files)
bun run check:legacy-memory-surface     # Expected: 1 test, 0 failures
bun test                                # Expected: all pass, 0 failures
```

### Final Checklist
- [ ] All "Must Have" items present
- [ ] All "Must NOT Have" items absent
- [ ] All tests pass (`bun test`)
- [ ] Full type-check passes (`bunx tsc --noEmit`)
- [ ] Legacy gate passes (`bun run check:legacy-memory-surface`)
- [ ] Every removed test/assertion has written rationale in commit message
- [ ] 7 audit artifacts exist in `.sisyphus/evidence/`
- [ ] Coverage baseline exists and final coverage does not regress
- [ ] No production source files modified
- [ ] No non-audited `src/memory/*.test.ts` files touched
