# Legacy Code Complete Removal

## TL;DR

> **Quick Summary**: Systematically remove all legacy private_event/private_belief infrastructure, agent_fact_overlay dual-writes, deprecated prompt slots, core memory label compat aliases, and dead schema columns. Zero-regression approach: cut writes → migrate data → cut reads → remove types → schema cleanup.
> 
> **Deliverables**:
> - agent_fact_overlay table fully dropped
> - private_event/private_belief node kinds removed from type system + all runtime code
> - Deprecated CORE_MEMORY/MEMORY_HINTS prompt slots removed
> - COMPAT_ALIAS_MAP and legacy core memory labels cleaned
> - source_label_raw dead column dropped
> - CreatedState field naming canonicalized (privateEventIds → episodeEventIds, privateBeliefIds → assertionIds)
> - All legacy node_refs migrated in search_docs, memory_relations, semantic_edges, node_scores, node_embeddings
> - Legacy-only test files removed, remaining tests updated for canonical patterns
> - Legacy docs updated
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 7 waves (22 tasks + 4 final verification)
> **Critical Path**: T1→T4→T7→T9→T10→T14→T15→T22→F1-F4

---

## Context

### Original Request
Complete removal of ALL legacy code from the MaidsClaw codebase. The codebase transitioned from old naming (private_event → episode, private_belief → assertion/cognition) with a dual-write architecture that is now ready for final cutover.

### Research Findings
- Exhaustive audit identified 9 production source files touching `agent_fact_overlay`, 12 files with legacy node kind constants, 6 files with deprecated prompt infrastructure, and ~28 test files
- `agent_fact_overlay` is actively dual-written by `upsertAssertion()` and exclusively written by `createPrivateBelief()`
- Stored legacy node_refs (`private_event:X`, `private_belief:X`) exist in `search_docs_cognition`, `memory_relations`, `semantic_edges`, `node_scores`, `node_embeddings`
- Migration `memory:006` does raw SELECT from `agent_fact_overlay` without `tableExists` guard — will crash fresh DBs if table removed from DDL
- `getCoreMemoryBlocks` and `getMemoryHints` are required (non-optional) in `MemoryDataSource` interface

### Metis Review
**Identified Gaps** (addressed):
- Migration 006 crash risk on fresh DBs → Add `tableExists` guard in cleanup migration
- `createPrivateBelief` single-write path → Must redirect BEFORE cutting overlay writes
- Stored legacy node_refs in 5 tables → Data migration before removing compat remap code
- `MemoryDataSource` interface break → Make methods optional before removing implementations
- `CreatedState` field names → Find all consumers via LSP before renaming

---

## Work Objectives

### Core Objective
Remove every trace of the private_event/private_belief legacy architecture and deprecated prompt system, leaving only the canonical private_episode + private_cognition architecture.

### Concrete Deliverables
- `agent_fact_overlay` table dropped via migration
- Zero production code referencing `agent_fact_overlay` (outside migrations)
- Zero production code referencing `private_event` or `private_belief` as node kinds
- Deprecated `CORE_MEMORY` and `MEMORY_HINTS` prompt slots removed
- `COMPAT_ALIAS_MAP`, `READ_ONLY_LABELS` removed; core memory labels tightened
- `source_label_raw` column dropped
- `CreatedState.privateEventIds` → `episodeEventIds`, `privateBeliefIds` → `assertionIds`
- `CreatedState.privateEventIds` → `episodeEventIds`, `privateBeliefIds` → `assertionIds`
- `node_embeddings` CHECK constraint tightened (legacy kinds removed)
- All stored legacy node_refs rewritten in 5 tables
- All test files updated to use only canonical naming
- Legacy docs removed/updated

### Definition of Done
- [ ] `bun test` passes with 0 failures
- [ ] `bun run build` passes with 0 type errors
- [ ] Grep `agent_fact_overlay` in src/ (*.ts, exclude schema.ts) → 0 matches
- [ ] Grep `private_event|private_belief` in src/ (*.ts, exclude schema.ts) → 0 matches
- [ ] Grep `LEGACY_NODE_KINDS|LegacyNodeRefKind|LEGACY_NODE_REF_KINDS` in src/ → 0 matches
- [ ] Grep `CORE_MEMORY|MEMORY_HINTS` in src/core/prompt-template.ts → 0 matches
- [ ] Grep `COMPAT_ALIAS_MAP|READ_ONLY_LABELS` in src/ → 0 matches
- [ ] Grep `getCoreMemoryBlocks|getMemoryHints` in src/ → 0 matches
- [ ] Grep `makeLegacyNodeRef` in src/ → 0 matches
- [ ] Grep `privateEventIds|privateBeliefIds` in src/ → 0 matches
- [ ] Fresh test DB has no `agent_fact_overlay` table (verified via migration test)

### Must Have
- Zero data loss — all existing assertions backfilled to `private_cognition_current` before dropping overlay
- All stored legacy node_refs (`private_event:X`, `private_belief:X`) purged from derived tables (they self-heal via GraphOrganizer)
- Migration 006 guarded with `tableExists` check
- `createPrivateBelief` redirected to `upsertAssertion` before any overlay writes are removed
- Every task has `bun test` green — tests are updated CO-LOCATED with production code, NOT deferred
- Each task that modifies production code MUST also update the tests that directly depend on the changed code

### Must NOT Have (Guardrails)
- MUST NOT touch `private_episode_events` or `private_cognition_events` tables — these are MODERN
- MUST NOT touch `private_cognition_current` table — this is the canonical projection
- MUST NOT remove `"thought"` category routing in `storage.ts:560` — intentional, routes to cognition
- MUST NOT remove `"user"` from `CORE_MEMORY_LABELS` — it's a standalone label, not a compat alias
- MUST NOT refactor CognitionRepository class structure — direct removal only
- MUST NOT change ExplicitSettlementProcessor behavior
- MUST NOT modify gateway/HTTP/SSE layers
- MUST NOT add new abstractions during cleanup
- MUST NOT touch GraphNavigator.explore query logic beyond removing legacy entries
- MUST NOT remove `private_episode` from `STABLE_FACTOR_REF_PATTERN` regex — it's the modern episode ref prefix, not legacy

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (bun test)
- **Automated tests**: Tests-after (update existing tests alongside code changes)
- **Framework**: bun test

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Schema/SQL**: Use Bash (bun test + direct DB queries via test harness)
- **Type system**: Use Bash (bun run build / tsc --noEmit)
- **Content verification**: Use Grep tool (NOT bash grep — the Grep tool is cross-platform and works on Windows)
- **Note**: This is a Windows (win32) environment. All QA scenarios should use the Grep tool for content searches, and Bash for `bun test` / `bun run build` commands only. Do NOT rely on `wc`, `find -exec`, `awk`, or Unix-only shell pipelines.

---

## Execution Strategy

### Parallel Execution Waves

```
CRITICAL RULE: Every task that modifies production code MUST ALSO update
the tests that directly depend on the changed code IN THE SAME TASK.
Tests are NOT deferred to a separate wave. Each task's "What to do"
includes test updates. Wave 7 handles ONLY tests that are purely about
legacy assertions (e.g., "LEGACY_NODE_KINDS has 2 kinds") with no
production code dependency.

Wave 1 (Foundation — all 3 tasks independent, run in parallel):
├── Task 1: Redirect createPrivateBelief → upsertAssertion + update tests [deep]
├── Task 2: Guard migration 006 with tableExists check [quick]
└── Task 3: Make MemoryDataSource interface methods optional [quick]

Wave 2 (Cut writes — after Wave 1. Task 4 first, then Task 5 — both edit cognition-repo.ts):
├── Task 4: Cut agent_fact_overlay writes in upsertAssertion + update tests [deep]
└── Task 5: Cut agent_fact_overlay writes in retractCognition + update tests (sequential after Task 4) [unspecified-high]

Wave 3 (Data migration — Tasks 7,8 parallel; then Task 6 after 8; then Task 9 after all):
├── Task 7: Write migration to backfill unkeyed assertions (depends: 4,5) [deep]
├── Task 8: Write migration to purge legacy node_refs from derived tables (depends: 4) [deep]
├── Task 6: Remove legacy compat source_ref loops (sequential after Task 8) [unspecified-high]
└── Task 9: Write migration to drop agent_fact_overlay (sequential after 6,7,8) [deep]

Wave 4 (Cut reads — after Wave 3. All 4 tasks parallel):
├── Task 10: Remove agent_fact_overlay reads from cognition-repo + update tests [deep]
├── Task 11: Remove agent_fact_overlay reads from graph-organizer + graph-edge-view + embeddings + update tests [unspecified-high]
├── Task 12: Remove agent_fact_overlay reads from navigator + update tests [unspecified-high]
└── Task 13: Remove agent_fact_overlay reads from relation-builder + relation-intent-resolver + cognition-search + update tests [unspecified-high]

Wave 5 (Remove type infrastructure — Task 14 first, then 15-18 parallel):
├── Task 14: Remove LEGACY_NODE_KINDS + AnyNodeRefKind + parseGraphNodeRef legacy support + update tests [deep]
│   (MUST complete before 15-18 start — they depend on types.ts changes)
├── Task 15: Remove legacy constants from 6 files + update tests (after 14) [unspecified-high]
├── Task 16: Remove legacy patterns from promotion.ts + private-cognition-current.ts + update tests (after 14) [unspecified-high]
├── Task 17: Rename CreatedState fields in task-agent + core-memory-index-updater + update tests (after 14) [unspecified-high]
└── Task 18: Write migration to tighten node_embeddings CHECK (after 8,14) [quick]

Wave 6 (Prompt system cleanup — Task 19 first, then 20,21 parallel):
├── Task 19: Remove deprecated CORE_MEMORY + MEMORY_HINTS + getCoreMemoryBlocks + getMemoryHints (depends: 3) [unspecified-high]
│   (MUST complete before 20 starts)
├── Task 20: Remove COMPAT_ALIAS_MAP + READ_ONLY_LABELS + tighten labels (after 19) [unspecified-high]
└── Task 21: Remove schema.ts makeLegacyNodeRef function (after 14) [quick]

Wave 7 (Legacy test cleanup + docs):
├── Task 22: Remove legacy-ONLY test files + assertions + update migration count [unspecified-high]
└── Task 23: Clean up legacy docs (after 22) [writing]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit (deep)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave | Parallel Within Wave |
|------|-----------|--------|------|---------------------|
| 1 | — | 4,5 | 1 | YES (with 2,3) |
| 2 | — | 9 | 1 | YES (with 1,3) |
| 3 | — | 19 | 1 | YES (with 1,2) |
| 4 | 1 | 5,6,7,8 | 2 | NO — must complete first (both 4 and 5 edit cognition-repo.ts) |
| 5 | 1,4 | 7 | 2 | NO — sequential after 4 (same file) |
| 6 | 4,8 | 9 | 3 | NO — sequential after 8 |
| 7 | 4,5 | 9 | 3 | YES (with 6,8) |
| 8 | 4 | 6,9,18 | 3 | YES (with 6,7) |
| 9 | 6,7,8 | 10-13 | 3 | NO — sequential after 6,7,8 |
| 10 | 9 | 14 | 4 | YES (with 11,12,13) |
| 11 | 9 | 14 | 4 | YES (with 10,12,13) |
| 12 | 9 | 14 | 4 | YES (with 10,11,13) |
| 13 | 9 | 14 | 4 | YES (with 10,11,12) |
| 14 | 10-13 | 15-18,21 | 5 | NO — must complete first |
| 15 | 14 | 22 | 5 | YES (with 16,17,18) |
| 16 | 14 | 22 | 5 | YES (with 15,17,18) |
| 17 | 14 | 22 | 5 | YES (with 15,16,18) |
| 18 | 8,14 | — | 5 | YES (with 15,16,17) |
| 19 | 3 | 20 | 6 | NO — must complete first |
| 20 | 19 | — | 6 | YES (with 21) |
| 21 | 14 | — | 6 | YES (with 20) |
| 22 | 15-18 | 23 | 7 | YES |
| 23 | 22 | — | 7 | NO — sequential after 22 |

### Agent Dispatch Summary

- **Wave 1**: 3 parallel — T1→`deep`, T2→`quick`, T3→`quick`
- **Wave 2**: T4 first, then T5 sequential (both edit cognition-repo.ts) — T4→`deep`, T5→`unspecified-high`
- **Wave 3**: T6+T7+T8 parallel, then T9 sequential — T6→`unspecified-high`, T7→`deep`, T8→`deep`, T9→`deep`
- **Wave 4**: 4 parallel — T10→`deep`, T11-T13→`unspecified-high`
- **Wave 5**: T14 first, then T15-T18 parallel — T14→`deep`, T15-T17→`unspecified-high`, T18→`quick`
- **Wave 6**: T19 first, then T20+T21 parallel — T19-T20→`unspecified-high`, T21→`quick`
- **Wave 7**: T22 then T23 — T22→`unspecified-high`, T23→`writing`
- **FINAL**: 4 parallel — F1→`deep`, F2-F3→`unspecified-high`, F4→`deep`

---

## TODOs

- [x] 1. Redirect createPrivateBelief → upsertAssertion

  **What to do**:
  - In `src/memory/storage.ts`: Remove the `createPrivateBelief()` method body that writes directly to `agent_fact_overlay` (lines 658-705)
  - Replace it with a call to `CognitionRepository.upsertAssertion()` using the same parameters, mapped to `UpsertAssertionParams`
  - In `src/memory/task-agent.ts`: Find where `createPrivateBelief` is called (line ~643) and update it to use `cognitionRepo.upsertAssertion()` instead
  - Update the `legacyCreatePrivateBeliefToolName` tool definition — either redirect its handler or remove the tool entirely from `CALL_ONE_TOOLS`
  - If removing the tool: ensure the agent prompt/schema no longer offers `create_private_belief` as a tool option

  **Must NOT do**:
  - MUST NOT touch `private_episode_events` or `private_cognition_events` tables
  - MUST NOT change the behavior of `upsertAssertion()` itself (it still dual-writes in this phase)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Multiple interconnected files need careful coordination to avoid data loss
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Tasks 4, 5
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/memory/storage.ts:658-705` — Current `createPrivateBelief()` implementation writing to `agent_fact_overlay`
  - `src/memory/cognition/cognition-repo.ts:210-420` — `upsertAssertion()` method — the target for redirection

  **API/Type References**:
  - `src/memory/cognition/cognition-repo.ts:1246-1250` — `UpsertAssertionParams` type definition
  - `src/memory/task-agent.ts:96-102` — `CreatedState` type with `privateBeliefIds`
  - `src/memory/task-agent.ts:640-660` — Where `createPrivateBelief` is called in the task agent

  **WHY Each Reference Matters**:
  - `storage.ts:658-705` — This is the code to replace. Study the params to map them correctly to `UpsertAssertionParams`
  - `cognition-repo.ts:210-420` — This is what you're redirecting to. Match parameter semantics exactly
  - `task-agent.ts:640-660` — This is the call site that invokes the tool handler. Must be updated to call the new path

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Assertion created via upsertAssertion path instead of createPrivateBelief
    Tool: Bash (bun test)
    Preconditions: Test DB initialized with schema
    Steps:
      1. Run `bun test src/memory/storage.test.ts` — verify all existing tests pass
      2. Run `bun test src/memory/task-agent.test.ts` — verify all existing tests pass
      3. Run `grep -rn "createPrivateBelief" src/ | grep -v ".test.ts" | grep -v "schema.ts"` — verify only migration/compat refs remain (or zero if tool removed)
    Expected Result: All tests pass; createPrivateBelief no longer writes to agent_fact_overlay
    Evidence: .sisyphus/evidence/task-1-redirect-belief.txt

  Scenario: No direct agent_fact_overlay INSERT from createPrivateBelief path
    Tool: Bash (grep)
    Steps:
      1. Run `grep -n "INSERT INTO agent_fact_overlay" src/memory/storage.ts`
    Expected Result: Zero matches (the INSERT moved to upsertAssertion path)
    Evidence: .sisyphus/evidence/task-1-no-direct-insert.txt
  ```

  **Commit**: YES — C1
  - Message: `fix(memory): redirect createPrivateBelief to upsertAssertion`
  - Files: `src/memory/storage.ts`, `src/memory/task-agent.ts`, related tests
  - Pre-commit: `bun test`

- [x] 2. Guard migration 006 with tableExists check

  **What to do**:
  - In `src/memory/schema.ts`, find migration `memory:006:backfill-canonical-stances` (lines 231-263)
  - Wrap the entire `up()` body in `if (tableExists(db, "agent_fact_overlay")) { ... }` — so it's a no-op on fresh databases where the table won't exist after DROP
  - Verify `tableExists` helper is already available in the file (used by migrations 002/004)

  **Must NOT do**:
  - MUST NOT change any other migration's behavior
  - MUST NOT modify the DDL that creates `agent_fact_overlay` (that happens later in Task 9)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single file, small change, clear pattern already exists in other migrations
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Task 9
  - **Blocked By**: None

  **References**:
  - `src/memory/schema.ts:231-263` — Migration 006 implementation to wrap
  - `src/memory/schema.ts:156-170` — Migrations 002/004 showing `tableExists` pattern to follow

  **WHY Each Reference Matters**:
  - Lines 231-263 — The migration body that will crash if `agent_fact_overlay` doesn't exist
  - Lines 156-170 — Pattern to copy: `if (tableExists(db, "agent_event_overlay"))` guard

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Migration 006 is guarded
    Tool: Bash (grep)
    Steps:
      1. Run `grep -A2 "memory:006" src/memory/schema.ts | grep "tableExists"`
    Expected Result: `tableExists` guard found within migration 006 body
    Evidence: .sisyphus/evidence/task-2-guard-migration.txt

  Scenario: All migrations still pass
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test src/memory/schema.test.ts`
    Expected Result: All migration tests pass
    Evidence: .sisyphus/evidence/task-2-migration-tests.txt
  ```

  **Commit**: YES — C2 (grouped with Task 3)
  - Message: `fix(memory): guard migration 006 + make MemoryDataSource methods optional`
  - Files: `src/memory/schema.ts`
  - Pre-commit: `bun test`

- [x] 3. Make MemoryDataSource interface methods optional

  **What to do**:
  - In `src/core/prompt-data-sources.ts`: Change `getCoreMemoryBlocks(agentId: string): string;` to `getCoreMemoryBlocks?(agentId: string): string;`
  - Change `getMemoryHints(userMessage: string, viewerContext: ViewerContext): Promise<string>;` to `getMemoryHints?(userMessage: string, viewerContext: ViewerContext): Promise<string>;`
  - In `src/core/prompt-builder.ts`: Add null-check before calling `memDs.getCoreMemoryBlocks(agentId)` (line 230) — it's already guarded by `if (!hasSplitBlocks)` but add `memDs.getCoreMemoryBlocks?.()` safe call
  - In `src/core/prompt-data-adapters/memory-adapter.ts`: Verify the adapter still provides these methods (it should, they just become optional in the interface)

  **Must NOT do**:
  - MUST NOT remove the implementations yet (that's Task 19)
  - MUST NOT change any other interface methods

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Interface change, 2-3 files, straightforward
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Task 19
  - **Blocked By**: None

  **References**:
  - `src/core/prompt-data-sources.ts:16,20` — Interface methods to make optional
  - `src/core/prompt-builder.ts:228-233` — Caller that needs null-safe access
  - `src/core/prompt-data-adapters/memory-adapter.ts:4-5` — Adapter implementation

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Interface compiles with optional methods
    Tool: Bash (tsc)
    Steps:
      1. Run `bun run build` (or tsc --noEmit if available)
    Expected Result: Zero type errors related to MemoryDataSource
    Evidence: .sisyphus/evidence/task-3-type-check.txt
  ```

  **Commit**: YES — C2 (grouped with Task 2)
  - Message: `fix(memory): guard migration 006 + make MemoryDataSource methods optional`
  - Files: `src/core/prompt-data-sources.ts`, `src/core/prompt-builder.ts`, `src/core/prompt-data-adapters/memory-adapter.ts`
  - Pre-commit: `bun test`

- [x] 4. Cut agent_fact_overlay writes from upsertAssertion

  **What to do**:
  - In `src/memory/cognition/cognition-repo.ts`: Remove the `agent_fact_overlay` INSERT (lines ~326-341) and UPDATE (lines ~403-417) from `upsertAssertion()`
  - Keep ONLY the `private_cognition_events` INSERT and `private_cognition_current` UPSERT writes
  - Remove the `agent_fact_overlay` SELECT for existing state check (line ~226) — use `private_cognition_current` SELECT instead
  - Update `syncAssertionCurrentProjection()` if it references the overlay
  - Update the search doc sync call to use `private_cognition_current` IDs instead of `agent_fact_overlay` IDs

  **Must NOT do**:
  - MUST NOT change `private_cognition_events` or `private_cognition_current` write logic
  - MUST NOT change the `UpsertAssertionParams` type signature

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex dual-write removal with data integrity implications
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (edits cognition-repo.ts — same file as Task 5)
  - **Parallel Group**: Wave 2 (must complete before Task 5)
  - **Blocks**: Tasks 5, 6, 7, 8
  - **Blocked By**: Task 1

  **References**:
  - `src/memory/cognition/cognition-repo.ts:210-420` — Full `upsertAssertion()` method
  - `src/memory/cognition/cognition-repo.ts:1118-1165` — `updateCognitionSearchDocStance()` that reads from overlay for assertion IDs
  - `src/memory/cognition/cognition-repo.ts:1168-1209` — `syncCognitionSearchDoc()` — search doc sync logic

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: upsertAssertion no longer writes to agent_fact_overlay
    Tool: Bash (grep)
    Steps:
      1. Run `grep -n "agent_fact_overlay" src/memory/cognition/cognition-repo.ts`
    Expected Result: Only READ references remain (for getAssertions fallback — removed in Task 10)
    Evidence: .sisyphus/evidence/task-4-no-writes.txt

  Scenario: Assertion upsert still works correctly
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test src/memory/cognition/` — all cognition tests pass
      2. Run `bun test src/memory/stress-contested-chain.test.ts` — contested chain tests pass
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-4-tests.txt
  ```

  **CRITICAL — Co-locate test updates**:
  - Update `src/memory/stress-contested-chain.test.ts` — this test directly INSERTs into `agent_fact_overlay` for setup. Rewrite test setup to use `private_cognition_current` instead, or use `cognitionRepo.upsertAssertion()` helper.
  - Update `src/memory/contested-chain-v3.test.ts` — same issue, rewrite overlay references
  - Update any other test that directly INSERTs into `agent_fact_overlay` for assertions about write behavior

  **Commit**: YES — C3
  - Message: `refactor(memory): cut agent_fact_overlay writes from upsertAssertion + retractCognition`
  - Files: `src/memory/cognition/cognition-repo.ts`, `src/memory/stress-contested-chain.test.ts`, `src/memory/contested-chain-v3.test.ts`, related tests
  - Pre-commit: `bun test`

- [x] 5. Cut agent_fact_overlay writes from retractCognition

  **What to do**:
  - In `src/memory/cognition/cognition-repo.ts`: Find `retractCognition()` method (lines ~700-780)
  - Remove the `UPDATE agent_fact_overlay SET status='retracted'` statements (lines ~718-721, ~766-769)
  - Keep ONLY the `private_cognition_current` UPDATE
  - Verify `retractCognition` only writes to `private_cognition_current` after this change
  - Update any tests that assert agent_fact_overlay state after retraction

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (edits cognition-repo.ts — same file as Task 4)
  - **Parallel Group**: Wave 2 (sequential after Task 4)
  - **Blocks**: Task 7
  - **Blocked By**: Tasks 1, 4

  **References**:
  - `src/memory/cognition/cognition-repo.ts:700-780` — `retractCognition()` method

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: retractCognition no longer touches agent_fact_overlay
    Tool: Bash (grep)
    Steps:
      1. Run `grep -n "agent_fact_overlay" src/memory/cognition/cognition-repo.ts | grep -i "update\|retract"`
    Expected Result: Zero matches for UPDATE/retract on agent_fact_overlay
    Evidence: .sisyphus/evidence/task-5-no-retract-writes.txt
  ```

  **Commit**: YES — C3 (grouped with Task 4)

- [x] 6. Remove legacy compat source_ref loops in cognition-repo search doc sync

  **What to do**:
  - In `src/memory/cognition/cognition-repo.ts:1137`: Remove the `for (const sourceRef of [... , \`private_event:${row.id}\`])` loop — keep only the canonical `${refKind}:${row.id}` ref
  - In `src/memory/cognition/cognition-repo.ts:1157`: Remove the `for (const sourceRef of [... , \`private_belief:${row.id}\`])` loop — keep only the canonical `assertion:${row.id}` ref
  - These loops try both canonical and legacy source_ref patterns in search_docs_cognition. After data migration (Task 8), only canonical refs will exist

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (sequential after Task 8)
  - **Blocks**: Task 9
  - **Blocked By**: Tasks 4, 8

  **References**:
  - `src/memory/cognition/cognition-repo.ts:1136-1144` — Legacy source_ref loop for evaluation/commitment
  - `src/memory/cognition/cognition-repo.ts:1155-1163` — Legacy source_ref loop for assertion

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: No legacy source_ref patterns in search doc sync
    Tool: Bash (grep)
    Steps:
      1. Run `grep -n "private_event\|private_belief" src/memory/cognition/cognition-repo.ts`
    Expected Result: Zero matches
    Evidence: .sisyphus/evidence/task-6-no-legacy-refs.txt
  ```

  **Commit**: YES — C4
  - Message: `refactor(memory): remove legacy source_ref compat loops`
  - Files: `src/memory/cognition/cognition-repo.ts`
  - Pre-commit: `bun test`

- [x] 7. Write migration to backfill unkeyed assertions from overlay to cognition_current

  **What to do**:
  - Add new migration `memory:028:backfill-unkeyed-assertions` in `src/memory/schema.ts`
  - SELECT all rows from `agent_fact_overlay WHERE cognition_key IS NULL` (these are old assertions never dual-written)
  - For each row, generate a synthetic `cognition_key` (e.g., `legacy_backfill:{agent_id}:{id}`)
  - INSERT into `private_cognition_events` (append-only event log) with op='upsert'
  - INSERT OR IGNORE into `private_cognition_current` with kind='assertion', mapping: predicate→summary_text, stance/basis→record_json fields
  - Guard with `if (tableExists(db, "agent_fact_overlay"))` for fresh-DB safety

  **Must NOT do**:
  - MUST NOT modify existing rows in agent_fact_overlay
  - MUST NOT skip rows — all unkeyed assertions must be migrated

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Data migration with complex field mapping and integrity requirements
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 8, 9)
  - **Blocks**: Tasks 9, 10
  - **Blocked By**: Tasks 4, 5

  **References**:
  - `src/memory/schema.ts:80-82` — `agent_fact_overlay` DDL showing column names
  - `src/memory/cognition/cognition-repo.ts:811-822` — `getAssertions()` fallback query showing which columns are read
  - `src/memory/cognition/cognition-repo.ts:1060-1095` — `toCanonicalAssertion()` showing how overlay rows map to canonical format
  - `src/memory/schema.ts:436-440` — Migration 017 as pattern for migration structure

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Unkeyed assertions backfilled to private_cognition_current
    Tool: Bash (bun test)
    Steps:
      1. Write a test in `test/memory/schema.test.ts` that:
         - Creates a fresh DB using RAW DDL that includes agent_fact_overlay (NOT createMemorySchema(), since Task 9 will later remove it from DDL)
         - Use a helper like `db.exec(LEGACY_AGENT_FACT_OVERLAY_DDL)` with the DDL hardcoded in the test
         - INSERTs 3 rows into `agent_fact_overlay` with `cognition_key = NULL`
         - Applies migration `memory:028` directly (call the up() function)
         - SELECTs from `private_cognition_current WHERE cognition_key LIKE 'legacy_backfill:%'`
         - Asserts 3 rows exist with correct predicate/stance/basis values
      2. Run `bun test test/memory/schema.test.ts`
    Expected Result: Test passes; all unkeyed assertions backfilled correctly
    Note: This test must remain runnable AFTER Task 9 removes agent_fact_overlay from MEMORY_DDL. By hardcoding the legacy table DDL in the test itself, the test is self-contained and independent of the current schema state.
    Evidence: .sisyphus/evidence/task-7-backfill.txt
  ```

  **Commit**: YES — C5
  - Message: `feat(memory): migration backfill unkeyed assertions + rewrite legacy node_refs`
  - Files: `src/memory/schema.ts`
  - Pre-commit: `bun test`

- [x] 8. Write migration to purge stored legacy node_refs from derived tables

  **What to do**:
  - Add new migration `memory:029:purge-legacy-node-refs` in `src/memory/schema.ts`
  - **CRITICAL**: `private_event:X` IDs point to `private_episode_events.id` and `private_belief:X` IDs point to `agent_fact_overlay.id`. These ID spaces are DIFFERENT from `private_cognition_current.id`, so simple string rewriting (`private_belief:42` → `assertion:42`) is **SEMANTICALLY WRONG** — the IDs would point to nonexistent rows.
  - **Correct strategy — DELETE legacy rows from derived/rebuildable tables** (they'll be regenerated by `GraphOrganizer.run()` on next settlement):
    - `DELETE FROM node_embeddings WHERE node_kind IN ('private_event', 'private_belief')`
    - `DELETE FROM semantic_edges WHERE source_node_ref LIKE 'private_event:%' OR source_node_ref LIKE 'private_belief:%' OR target_node_ref LIKE 'private_event:%' OR target_node_ref LIKE 'private_belief:%'`
    - `DELETE FROM node_scores WHERE node_ref LIKE 'private_event:%' OR node_ref LIKE 'private_belief:%'`
    - `DELETE FROM memory_relations WHERE source_node_ref LIKE 'private_event:%' OR ... OR target_node_ref LIKE 'private_belief:%'`
  - **For `search_docs_cognition`**: DELETE rows with `source_ref LIKE 'private_event:%' OR source_ref LIKE 'private_belief:%'` — these will be rebuilt when assertions/evaluations are next accessed via `syncCognitionSearchDoc()`
  - These tables are ALL derived projections or heuristic caches — deleting rows causes temporary quality degradation but NOT data loss. The source-of-truth tables (`private_episode_events`, `private_cognition_events`, `private_cognition_current`) are untouched.

  **Must NOT do**:
  - MUST NOT try to rewrite `private_event:X → evaluation:X` — IDs don't match across tables
  - MUST NOT touch `private_episode_events` or `private_cognition_events` — these are source-of-truth
  - MUST NOT touch `search_docs_private` — it uses different refs

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Multi-table cleanup with semantic understanding of ID spaces
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 7, 9)
  - **Blocks**: Tasks 9, 11-13, 18
  - **Blocked By**: Task 4

  **References**:
  - `src/memory/graph-organizer.ts:147-155` — Shows `private_event:X` queries `private_episode_events WHERE id = X` (NOT private_cognition_current)
  - `src/memory/graph-organizer.ts:167-174` — Shows `private_belief:X` / `assertion:X` queries `agent_fact_overlay WHERE id = X`
  - `src/memory/cognition/cognition-repo.ts:358-368` — Shows `syncCognitionSearchDoc` uses `agent_fact_overlay.id` as overlay ID for search doc source_ref
  - `src/memory/graph-organizer.ts:32-88` — `GraphOrganizer.run()` regenerates embeddings + semantic edges on next call

  **WHY Each Reference Matters**:
  - Lines 147-155 prove `private_event:X` → `private_episode_events.id`, NOT evaluation
  - Lines 167-174 prove `private_belief:X` → `agent_fact_overlay.id`, NOT private_cognition_current.id
  - Lines 358-368 prove search docs use overlay IDs — they'll be stale after overlay drops
  - Lines 32-88 prove these derived tables self-heal on next GraphOrganizer run

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: No legacy node_refs remain in any derived table
    Tool: Bash (bun test)
    Steps:
      1. Write a test in `test/memory/schema.test.ts` that:
         - Creates fresh DB using RAW DDL (including legacy node_embeddings CHECK that allows private_event/private_belief — hardcoded in test, NOT from current MEMORY_DDL which may have already removed them)
         - Seeds with `private_event:1` and `private_belief:2` refs in all 5 derived tables
         - Applies migration `memory:029` directly (call the up() function)
         - Asserts `SELECT count(*) FROM search_docs_cognition WHERE source_ref LIKE 'private_%'` → 0
         - Asserts `SELECT count(*) FROM node_embeddings WHERE node_kind IN ('private_event','private_belief')` → 0
         - Asserts `SELECT count(*) FROM memory_relations WHERE source_node_ref LIKE 'private_%'` → 0
         - Asserts `SELECT count(*) FROM node_scores WHERE node_ref LIKE 'private_%'` → 0
      2. Run `bun test test/memory/schema.test.ts`
    Expected Result: Test passes; zero legacy refs remain
    Note: Test uses hardcoded legacy DDL so it remains runnable after Task 9 removes legacy tables/constraints from MEMORY_DDL and Task 18 tightens the CHECK constraint.
    Evidence: .sisyphus/evidence/task-8-refs-purged.txt

  Scenario: Source-of-truth tables untouched
    Tool: Bash (bun test)
    Steps:
      1. In same test: before migration, count rows in private_episode_events and private_cognition_current
      2. After migration, assert identical counts
      3. Run `bun test test/memory/schema.test.ts`
    Expected Result: Zero rows affected in source-of-truth tables
    Evidence: .sisyphus/evidence/task-8-source-tables-safe.txt
  ```

  **Commit**: YES — C5 (grouped with Task 7)

- [x] 9. Write migration to drop agent_fact_overlay + drop source_label_raw

  **What to do**:
  - Add new migration `memory:030:drop-agent-fact-overlay` in `src/memory/schema.ts`
  - `DROP TABLE IF EXISTS agent_fact_overlay`
  - Remove `agent_fact_overlay` from `MEMORY_DDL` string (line 80) — so fresh DBs never create it
  - Also update migration `memory:006` if not already guarded (should be done by Task 2)
  - Note: `source_label_raw` dies with the table since it's a column of `agent_fact_overlay`

  **Must NOT do**:
  - MUST NOT drop `private_cognition_current` or `private_cognition_events`
  - MUST NOT modify any table other than `agent_fact_overlay`

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Schema DDL change with cascade implications for migrations
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (sequential after Tasks 7, 8)
  - **Blocks**: Tasks 10-13
  - **Blocked By**: Tasks 7, 8

  **References**:
  - `src/memory/schema.ts:80-82` — Current `agent_fact_overlay` DDL to remove
  - `src/memory/schema.ts:436-440` — Migration 017 (`DROP TABLE agent_event_overlay`) as pattern
  - `src/memory/schema.ts:715-724` — Migration 027 marker documenting the compat cutover

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: agent_fact_overlay table dropped
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test src/memory/schema.test.ts`
      2. Verify fresh DB has no agent_fact_overlay table
    Expected Result: Migration tests pass; table doesn't exist on fresh DB
    Evidence: .sisyphus/evidence/task-9-table-dropped.txt

  Scenario: DDL no longer creates agent_fact_overlay
    Tool: Bash (grep)
    Steps:
      1. Run `grep "CREATE TABLE.*agent_fact_overlay" src/memory/schema.ts`
    Expected Result: Zero matches in MEMORY_DDL (only in migration bodies)
    Evidence: .sisyphus/evidence/task-9-ddl-clean.txt
  ```

  **Commit**: YES — C6
  - Message: `feat(memory): migration drop agent_fact_overlay`
  - Files: `src/memory/schema.ts`
  - Pre-commit: `bun test`

- [x] 10. Remove agent_fact_overlay reads from cognition-repo

  **What to do**:
  - In `src/memory/cognition/cognition-repo.ts`:
    - `getAssertions()` (lines ~796-843): Remove the `agent_fact_overlay WHERE cognition_key IS NULL` fallback query — after Task 7 backfill, all assertions are in `private_cognition_current`
    - `getAssertionByKey()` (lines ~890-920): Remove the `agent_fact_overlay` fallback SELECT — use only `private_cognition_current`
    - `upsertAssertion()` existing-state SELECT: Remove `agent_fact_overlay` lookup (should already be done by Task 4, verify)
    - `updateCognitionSearchDocStance()` (lines ~1147-1165): Remove the `agent_fact_overlay` SELECT for assertion IDs — use `private_cognition_current` instead
  - Remove any remaining `import` or SQL string referencing `agent_fact_overlay`

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Multiple interconnected read paths to remove with fallback logic
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 11, 12, 13)
  - **Blocks**: Task 14
  - **Blocked By**: Tasks 7, 9

  **References**:
  - `src/memory/cognition/cognition-repo.ts:796-843` — `getAssertions()` with dual-source merge
  - `src/memory/cognition/cognition-repo.ts:890-920` — `getAssertionByKey()` with fallback
  - `src/memory/cognition/cognition-repo.ts:1147-1165` — `updateCognitionSearchDocStance()` for assertions

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Zero agent_fact_overlay references in cognition-repo
    Tool: Bash (grep)
    Steps:
      1. Run `grep -n "agent_fact_overlay" src/memory/cognition/cognition-repo.ts`
    Expected Result: Zero matches
    Evidence: .sisyphus/evidence/task-10-no-overlay-refs.txt

  Scenario: Cognition tests still pass
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test src/memory/cognition/`
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-10-tests.txt
  ```

  **Commit**: YES — C7
  - Message: `refactor(memory): cut agent_fact_overlay reads from all modules`
  - Files: `src/memory/cognition/cognition-repo.ts`
  - Pre-commit: `bun test`

- [x] 11. Remove agent_fact_overlay reads from graph-organizer + graph-edge-view + embeddings

  **What to do**:
  - `src/memory/graph-organizer.ts`:
    - `renderNodeContent()` (lines 167-174): Replace the fallback `SELECT predicate, provenance, stance FROM agent_fact_overlay WHERE id = ?` with a query to `private_cognition_current` for assertion kind
    - `lookupNodeUpdatedAt()` (lines 354-357): Replace the fallback `SELECT updated_at FROM agent_fact_overlay` with `private_cognition_current` query
    - `syncSearchProjection()` (lines 477-490): Replace `SELECT predicate, provenance, agent_id, stance FROM agent_fact_overlay` with `private_cognition_current` query
  - `src/memory/graph-edge-view.ts`:
    - `loadNodeVisibilityData()` (lines 408-412): Replace `SELECT agent_id FROM agent_fact_overlay WHERE id = ?` for `legacyPrivateBeliefKind || "assertion"` with `private_cognition_current` query
  - `src/memory/embeddings.ts`:
    - `queryNearestNeighbors()` (line 87): Replace `privateBeliefOwnerStmt` that queries `agent_fact_overlay` with `private_cognition_current` query
    - `isNodeVisibleForAgent()` (lines 114-146): Update to handle assertion/evaluation/commitment visibility via `private_cognition_current`

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 10, 12, 13)
  - **Blocks**: Task 14
  - **Blocked By**: Tasks 8, 9

  **References**:
  - `src/memory/graph-organizer.ts:111-175, 313-358, 407-499` — All methods with overlay reads
  - `src/memory/graph-edge-view.ts:394-413` — Visibility data loading
  - `src/memory/embeddings.ts:86-87, 114-146` — Embedding visibility filter

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Zero agent_fact_overlay refs in graph-organizer, graph-edge-view, embeddings
    Tool: Bash (grep)
    Steps:
      1. Run `grep -n "agent_fact_overlay" src/memory/graph-organizer.ts src/memory/graph-edge-view.ts src/memory/embeddings.ts`
    Expected Result: Zero matches
    Evidence: .sisyphus/evidence/task-11-no-overlay-refs.txt
  ```

  **Commit**: YES — C7 (grouped with Tasks 10, 12, 13)

- [x] 12. Remove agent_fact_overlay reads AND legacy node kind usage from navigator

  **What to do**:
  - `src/memory/navigator.ts` has BOTH `agent_fact_overlay` SQL reads AND legacy node kind constants:
  - **agent_fact_overlay SQL reads** (replace with `private_cognition_current` queries):
    - Line 848: `expandEntityFrontier()` — `SELECT ... FROM agent_fact_overlay WHERE agent_id = ? AND (source_entity_id IN (...) OR target_entity_id IN (...))`
    - Line 1138: `loadNodeSnapshot()` — `SELECT ... FROM agent_fact_overlay WHERE agent_id=? AND cognition_key IS NULL AND id IN (...)`
    - Line 1295: `resolveNodeAgentId()` — `SELECT agent_id FROM agent_fact_overlay WHERE id=?`
    - Line 1759: `loadNodeVisibilityData()` — `SELECT agent_id FROM agent_fact_overlay WHERE id = ?`
  - **Legacy node kind constants** (remove):
    - Remove local `legacyPrivateEventKind` / `legacyPrivateBeliefKind` constants (lines 153-154)
    - Remove legacy entries from `KNOWN_NODE_KINDS` set (lines 156-165)
    - Remove legacy columns from `nodeTypePrior()` priors table (lines 508-516)
    - Update type signatures from `AnyNodeRefKind` → `NodeRefKind`
  - Update navigator tests that reference legacy constants or overlay SQL

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Multiple SQL query replacements + constant removal across a large file (1856 lines)
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 10, 11, 13)
  - **Blocks**: Task 14
  - **Blocked By**: Tasks 8, 9

  **References**:
  - `src/memory/navigator.ts:845-852` — `expandEntityFrontier()` overlay query
  - `src/memory/navigator.ts:1135-1144` — `loadNodeSnapshot()` overlay fallback for unkeyed assertions
  - `src/memory/navigator.ts:1293-1298` — `resolveNodeAgentId()` overlay lookup
  - `src/memory/navigator.ts:1757-1762` — `loadNodeVisibilityData()` overlay lookup
  - `src/memory/navigator.ts:153-165` — Legacy constants + KNOWN_NODE_KINDS set
  - `src/memory/navigator.ts:507-516` — `nodeTypePrior()` priors table

  **WHY Each Reference Matters**:
  - Lines 845-852: Entity frontier expansion uses overlay to find beliefs about entities — redirect to `private_cognition_current WHERE kind='assertion'`
  - Lines 1135-1144: Node snapshot loading falls back to overlay for unkeyed assertions — after Task 7 backfill, use only `private_cognition_current`
  - Lines 1293-1298, 1757-1762: Agent ID resolution for `private_belief`/`assertion` refs — redirect to `private_cognition_current`

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Zero agent_fact_overlay refs AND zero legacy constants in navigator
    Tool: Bash (grep + bun test)
    Steps:
      1. Run `grep -n "agent_fact_overlay\|legacyPrivate\|private_event\|private_belief" src/memory/navigator.ts`
      2. Run `bun test src/memory/navigator.test.ts`
    Expected Result: Zero grep matches; navigator tests pass
    Evidence: .sisyphus/evidence/task-12-navigator-clean.txt
  ```

  **Commit**: YES — C7 (grouped)

- [x] 13. Remove agent_fact_overlay reads from relation-builder + relation-intent-resolver + cognition-search

  **What to do**:
  - `src/memory/cognition/relation-builder.ts`:
    - `resolveSourceAgentId()` (lines ~210, ~222): Replace `SELECT agent_id FROM agent_fact_overlay` with `private_cognition_current` query
    - `resolveCanonicalCognitionRefByKey()` (lines ~287-294): Replace `agent_fact_overlay` lookup with `private_cognition_current` lookup
  - `src/memory/cognition/relation-intent-resolver.ts`:
    - `resolveFactorNodeRef()` (lines 323-329): Replace `SELECT id FROM agent_fact_overlay WHERE cognition_key = ?` with `private_cognition_current` query
  - `src/memory/cognition/cognition-search.ts`:
    - Find and replace the single `agent_fact_overlay` reference (assertion ID lookup) with `private_cognition_current` query

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 10, 11, 12)
  - **Blocks**: Task 14
  - **Blocked By**: Tasks 8, 9

  **References**:
  - `src/memory/cognition/relation-builder.ts` — 3 agent_fact_overlay references
  - `src/memory/cognition/relation-intent-resolver.ts:323-329` — cognition_key lookup
  - `src/memory/cognition/cognition-search.ts` — 1 reference

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Zero agent_fact_overlay refs in relation modules
    Tool: Bash (grep)
    Steps:
      1. Run `grep -rn "agent_fact_overlay" src/memory/cognition/`
    Expected Result: Zero matches
    Evidence: .sisyphus/evidence/task-13-no-overlay-refs.txt
  ```

  **Commit**: YES — C7 (grouped)

- [x] 14. Remove LEGACY_NODE_KINDS, LegacyNodeRefKind, ALL_KNOWN_NODE_REF_KINDS from types.ts + parseGraphNodeRef

  **What to do**:
  - In `src/memory/types.ts`:
    - Remove lines 102-105: `legacyPrivateEventKind`, `legacyPrivateBeliefKind`, `LEGACY_NODE_KINDS`, `LegacyNodeRefKind`
    - Remove line 110: `ALL_KNOWN_NODE_REF_KINDS` — replace all usages with `CANONICAL_NODE_KINDS` (which is `NODE_REF_KINDS`)
    - Remove line 111: `AnyNodeRefKind` type — replace all usages with `NodeRefKind`
    - Remove line 114: `LEGACY_NODE_REF_KINDS` alias
    - Update line 328: `node_kind: AnyNodeRefKind` → `node_kind: NodeRefKind` in EmbeddingEntry or equivalent type
  - In `src/memory/contracts/graph-node-ref.ts`:
    - Remove import of `ALL_KNOWN_NODE_REF_KINDS`, `AnyNodeRefKind`
    - Replace with `NODE_REF_KINDS`, `NodeRefKind`
    - `parseGraphNodeRef()` will now reject `private_event:X` and `private_belief:X` refs (correct — they've been migrated)
  - Find ALL files importing `AnyNodeRefKind` or `ALL_KNOWN_NODE_REF_KINDS` and update to canonical types:
    - `graph-organizer.ts`, `navigator.ts`, `retrieval.ts`, `embedding-linker.ts`, `graph-edge-view.ts`

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Cross-cutting type change affecting 10+ files — must be atomic
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 5 (must complete before Tasks 15-18)
  - **Blocks**: Tasks 15, 16, 17, 18, 21, 22
  - **Blocked By**: Tasks 10-13

  **References**:
  - `src/memory/types.ts:99-114` — All legacy type definitions to remove
  - `src/memory/contracts/graph-node-ref.ts:1-26` — Parser using ALL_KNOWN_NODE_REF_KINDS
  - `src/memory/graph-organizer.ts:7,90,179,182,204,220` — AnyNodeRefKind usages
  - `src/memory/navigator.ts:16,156,507,516,586,587,602,1199,1493,1520,1820` — AnyNodeRefKind usages
  - `src/memory/retrieval.ts:24` — AnyNodeRefKind import
  - `src/memory/embedding-linker.ts:3,7,13,26,29,65` — AnyNodeRefKind usages
  - `src/memory/graph-edge-view.ts:5,10` — AnyNodeRefKind usages

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Zero legacy type references
    Tool: Bash (grep + tsc)
    Steps:
      1. Run `grep -rn "LEGACY_NODE_KINDS\|LegacyNodeRefKind\|ALL_KNOWN_NODE_REF_KINDS\|AnyNodeRefKind\|LEGACY_NODE_REF_KINDS" src/`
      2. Run `bun run build` — zero type errors
    Expected Result: Zero grep matches; build succeeds
    Evidence: .sisyphus/evidence/task-14-types-clean.txt
  ```

  **Commit**: YES — C8
  - Message: `refactor(memory): remove legacy node kind type infrastructure`
  - Files: types.ts, graph-node-ref.ts, + all files importing AnyNodeRefKind/ALL_KNOWN_NODE_REF_KINDS
  - Pre-commit: `bun test`

- [ ] 15. Remove legacy constants from navigator + graph-edge-view + visibility-policy + retrieval + graph-organizer + embeddings

  **What to do**:
  - In each file, remove:
    - Local `legacyPrivateEventKind` / `legacyPrivateBeliefKind` constant declarations
    - Legacy entries from `KNOWN_NODE_KINDS` sets
    - Legacy entries from `nodeTypePrior()` priors table (navigator.ts:508-516)
    - Legacy entries from `isCuratedBridgePair()` allowed set (graph-organizer.ts:222-237, navigator.ts equivalent)
    - Legacy branching in `getNodeDisposition()` (visibility-policy.ts:118)
    - Legacy branching in `scopeFromNodeKind()` (retrieval.ts:419)
    - Legacy branching in `isNodeVisibleForAgent()` (embeddings.ts:121-146)
    - Legacy branching in `renderNodeContent()` (graph-organizer.ts:147-155)
    - Legacy branching in `lookupNodeUpdatedAt()` (graph-organizer.ts:340-345)
    - Legacy branching in `lookupTopicCluster()` (graph-organizer.ts:388-390)
    - Legacy branching in `syncSearchProjection()` (graph-organizer.ts:449-459)
    - Remove static class fields from `VisibilityPolicy` (visibility-policy.ts:13-14)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Many files but each change is mechanical removal
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with Tasks 16, 17, 18)
  - **Blocks**: Task 22
  - **Blocked By**: Task 14

  **References**:
  - `src/memory/navigator.ts:153-165, 507-516` — Constants + priors table
  - `src/memory/graph-edge-view.ts:19-30` — Constants + KNOWN_NODE_KINDS
  - `src/memory/visibility-policy.ts:13-14, 118-119` — Static fields + getNodeDisposition
  - `src/memory/retrieval.ts:418-423` — scopeFromNodeKind
  - `src/memory/graph-organizer.ts:9-10, 96-108, 147-155, 220-238, 340-345, 388-390, 449-459` — Multiple methods
  - `src/memory/embeddings.ts:19-20, 121-146` — Constants + visibility filter

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Zero legacy constants in production code
    Tool: Bash (grep)
    Steps:
      1. Run `grep -rn "legacyPrivateEventKind\|legacyPrivateBeliefKind\|legacyPrivateEventPrefix\|legacyPrivateBeliefPrefix" src/ | grep -v ".test.ts" | grep -v promotion.ts`
      2. Run `bun test`
    Expected Result: Zero grep matches (promotion.ts handled separately in Task 16); all tests pass
    Evidence: .sisyphus/evidence/task-15-constants-clean.txt
  ```

  **Commit**: YES — C8 (grouped with Task 14)

- [ ] 16. Remove legacy patterns from promotion.ts + private-cognition-current.ts

  **What to do**:
  - `src/memory/promotion.ts`:
    - Remove `legacyPrivateEventPrefix` and `legacyPrivateBeliefPrefix` constants (lines 64-65)
    - Remove all branching that checks `source_ref.startsWith(legacyPrivateBeliefPrefix)` (lines 147, 320)
    - Keep the `source_ref.startsWith("assertion:")` checks (canonical)
    - Remove the regex `/\bprivate[_\s-]?belief\b/i` check (line 499) — legacy content filter
    - Update `source_ref.startsWith(legacyPrivateEventPrefix)` checks (line 460) — keep the `evaluation:` and `commitment:` checks
  - `src/memory/cognition/private-cognition-current.ts`:
    - In `normalizeConflictFactorRefs()` (line ~72): Remove `private_belief|private_event` from the regex pattern, keep only canonical kinds: `assertion|evaluation|commitment|private_episode|event`

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with Tasks 14, 15, 17, 18)
  - **Blocks**: Task 22
  - **Blocked By**: Task 14

  **References**:
  - `src/memory/promotion.ts:64-65, 147, 320, 460, 499` — All legacy patterns
  - `src/memory/cognition/private-cognition-current.ts:72` — Regex with legacy kinds
  - `src/memory/cognition/relation-intent-resolver.ts:312` — Similar regex (handled in Task 13)

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Zero legacy patterns in promotion + private-cognition-current
    Tool: Bash (grep)
    Steps:
      1. Run `grep -n "private_belief\|private_event\|legacyPrivate" src/memory/promotion.ts src/memory/cognition/private-cognition-current.ts`
    Expected Result: Zero matches
    Evidence: .sisyphus/evidence/task-16-promotion-clean.txt
  ```

  **Commit**: YES — C8 (grouped)

- [ ] 17. Rename CreatedState fields in ALL consumers

  **What to do**:
  - In `src/memory/task-agent.ts`:
    - `CreatedState` type (line 96): Rename `privateEventIds` → `episodeEventIds`, `privateBeliefIds` → `assertionIds`
    - Find all places where `CreatedState` fields are assigned/read within task-agent.ts and update field names
    - Use LSP find_references on `privateEventIds` and `privateBeliefIds` to find ALL consumers
  - In `src/memory/explicit-settlement-processor.ts`:
    - Line 480: `created.privateEventIds.push(row.id)` → `created.episodeEventIds.push(row.id)` (evaluations)
    - Line 488: `created.privateEventIds.push(row.id)` → `created.episodeEventIds.push(row.id)` (commitments)
    - Line 496: `created.privateBeliefIds.push(row.id)` → `created.assertionIds.push(row.id)` (assertions)
    - Line 507: `created.privateBeliefIds.push(row.id)` → `created.assertionIds.push(row.id)` (retracted assertions)
    - Line 518: `created.privateEventIds.push(row.id)` → `created.episodeEventIds.push(row.id)` (retracted eval/commit)
  - In `src/memory/core-memory-index-updater.ts`:
    - Update references to `created.privateEventIds` → `created.episodeEventIds` (line 29)
    - Update references to `created.privateBeliefIds` → `created.assertionIds` (line 30)
  - In test files: Update all `privateEventIds: []` / `privateBeliefIds: []` references:
    - `test/memory/validation-negative-cases.test.ts:152-153`
    - `test/memory/validation-contested-cognition.test.ts:318-319`
    - `test/memory/validation-turn-settlement.test.ts:151-152`

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Type rename across multiple files, LSP-assisted
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with Tasks 14-16, 18)
  - **Blocks**: Task 22
  - **Blocked By**: Task 14

  **References**:
  - `src/memory/task-agent.ts:96-102` — `CreatedState` type definition
  - `src/memory/core-memory-index-updater.ts:29-30` — Field references
  - `test/memory/validation-contested-cognition.test.ts:318-319` — Test references
  - `test/memory/validation-negative-cases.test.ts:152-153` — Test references

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Zero legacy field names
    Tool: Bash (grep + tsc)
    Steps:
      1. Run `grep -rn "privateEventIds\|privateBeliefIds" src/ test/`
      2. Run `bun run build`
    Expected Result: Zero grep matches; build succeeds
    Evidence: .sisyphus/evidence/task-17-names-clean.txt
  ```

  **Commit**: YES — C9
  - Message: `refactor(memory): rename CreatedState fields to canonical names`
  - Files: task-agent.ts, core-memory-index-updater.ts, test files
  - Pre-commit: `bun test`

- [ ] 18. Write migration to tighten node_embeddings CHECK constraint

  **What to do**:
  - Add migration `memory:031:tighten-node-embeddings-check` in `src/memory/schema.ts`
  - Rebuild `node_embeddings` table with CHECK constraint removing `'private_event', 'private_belief'`:
    `CHECK (node_kind IN ('event', 'entity', 'fact', 'assertion', 'evaluation', 'commitment'))`
  - Follow the rebuild pattern from migration 016 (lines 420-434): CREATE new table → INSERT from old → DROP old → RENAME → recreate indexes
  - Also update the `MEMORY_DDL` string (line 85) to remove legacy kinds from the CHECK

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single migration, follows established rebuild pattern
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with Tasks 14-17)
  - **Blocks**: None
  - **Blocked By**: Tasks 8, 14

  **References**:
  - `src/memory/schema.ts:85` — Current DDL with legacy CHECK
  - `src/memory/schema.ts:420-434` — Migration 016 as rebuild pattern

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: CHECK constraint rejects legacy kinds
    Tool: Bash (bun test)
    Steps:
      1. Add a test to `test/memory/schema.test.ts` that:
         - Creates fresh DB via `createMemorySchema()` (applies all migrations including 031)
         - Attempts INSERT into `node_embeddings` with `node_kind='private_event'` — wraps in try/catch
         - Asserts the INSERT throws a CHECK constraint error
         - Attempts INSERT with `node_kind='assertion'` — asserts success
      2. Run `bun test test/memory/schema.test.ts`
    Expected Result: Test passes; legacy kinds rejected, canonical kinds accepted
    Evidence: .sisyphus/evidence/task-18-check-tightened.txt
  ```

  **Commit**: YES — C10
  - Message: `feat(memory): migration tighten node_embeddings CHECK`
  - Files: `src/memory/schema.ts`
  - Pre-commit: `bun test`

- [x] 19. Remove deprecated CORE_MEMORY + MEMORY_HINTS slots + getCoreMemoryBlocks + getMemoryHints

  **What to do**:
  - `src/core/prompt-template.ts`:
    - Remove `CORE_MEMORY = "core_memory"` enum value (line 13) and its @deprecated comment
    - Remove `MEMORY_HINTS = "memory_hints"` enum value (line 21) and its @deprecated comment
    - Remove both from `SECTION_SLOT_ORDER` array (lines 33, 39)
  - `src/core/prompt-renderer.ts`:
    - Line 28: Remove `PromptSectionSlot.CORE_MEMORY` from `SYSTEM_SLOTS` set
    - Line 32: Remove `PromptSectionSlot.MEMORY_HINTS` from `SYSTEM_SLOTS` set
  - `src/core/prompt-sections.ts`:
    - Line 18: Remove `CoreMemoryData` type (used by CORE_MEMORY slot)
    - Line 35: Remove `MemoryHintsData` type (used by MEMORY_HINTS slot)
  - `src/core/prompt-builder.ts`:
    - Remove the entire `legacyCore` fallback block (lines 227-233)
    - Remove any code that renders `CORE_MEMORY` or `MEMORY_HINTS` slots
  - `src/core/prompt-data-sources.ts`:
    - Remove `getCoreMemoryBlocks?` method from `MemoryDataSource` interface (line 16, already optional from Task 3)
    - Remove `getMemoryHints?` method from interface (line 20, already optional from Task 3)
  - `src/core/prompt-data-adapters/memory-adapter.ts`:
    - Remove `getCoreMemoryBlocks` implementation/import (line 4)
    - Remove `getMemoryHints` implementation/import (line 5)
  - `src/memory/prompt-data.ts`:
    - Remove `getMemoryHints()` function (lines 92-125) — it's @deprecated since T8
    - Remove `SHARED_LABELS` legacy comment (line 20-21)
  - Update ALL test files that reference `CORE_MEMORY`, `MEMORY_HINTS`, `CoreMemoryData`, or `MemoryHintsData`:
    - `test/core/prompt-template.test.ts` — update SECTION_SLOT_ORDER assertions
    - `test/core/prompt-builder.test.ts` — remove getCoreMemoryBlocks test
    - Any other test importing these types

  **Must NOT do**:
  - MUST NOT remove `getPinnedBlocks` or `getSharedBlocks` — these are canonical
  - MUST NOT remove `getMemoryHints` if it has non-RP consumers (check first)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (must complete before Task 20)
  - **Blocks**: Task 20
  - **Blocked By**: Task 3

  **References**:
  - `src/core/prompt-template.ts:8-40` — Enum + SECTION_SLOT_ORDER
  - `src/core/prompt-renderer.ts:25-33` — SYSTEM_SLOTS set referencing both deprecated slots
  - `src/core/prompt-sections.ts:18-38` — CoreMemoryData + MemoryHintsData types
  - `src/core/prompt-builder.ts:227-233` — Legacy fallback block
  - `src/core/prompt-data-sources.ts:16,20` — Interface methods
  - `src/core/prompt-data-adapters/memory-adapter.ts:4-5` — Adapter imports
  - `src/memory/prompt-data.ts:92-125` — @deprecated getMemoryHints

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Zero deprecated prompt slot references
    Tool: Bash (grep + tsc)
    Steps:
      1. Run `grep -rn "CORE_MEMORY\|MEMORY_HINTS\|getCoreMemoryBlocks\|getMemoryHints" src/`
      2. Run `bun run build`
    Expected Result: Zero grep matches; build succeeds
    Evidence: .sisyphus/evidence/task-19-prompt-clean.txt
  ```

  **Commit**: YES — C11
  - Message: `refactor(core): remove deprecated prompt slots + getCoreMemoryBlocks + getMemoryHints`
  - Files: prompt-template.ts, prompt-builder.ts, prompt-data.ts, prompt-data-sources.ts, memory-adapter.ts
  - Pre-commit: `bun test`

- [ ] 20. Remove COMPAT_ALIAS_MAP + READ_ONLY_LABELS + tighten CoreMemoryInput types

  **What to do**:
  - `src/memory/types.ts`:
    - Remove `COMPAT_ALIAS_MAP` (lines 91-94)
    - Remove `READ_ONLY_LABELS` (lines 96-97)
    - Update `CORE_MEMORY_LABELS` (line 82): Remove `"character"` — keep `"user"`, `"index"`, `"pinned_summary"`, `"pinned_index"`, `"persona"`
    - Note: Keep `"index"` in `CORE_MEMORY_LABELS` — it's still actively used by `core-memory-index-updater.ts` as the label for the agent's index block
    - Update `CoreMemoryAppendInput.label` (line 404): Remove `"character"` — keep `"user" | "pinned_summary"`
    - Update `CoreMemoryReplaceInput.label` (line 409): Same
  - `src/memory/core-memory.ts`:
    - Line 11: Remove the `{ label: "character", ... }` entry from the defaults array — it's described as "legacy, read-only" and after removing `COMPAT_ALIAS_MAP`, nothing reads it
    - Line 23-24: Remove `resolveCanonicalLabel()` function (it resolves COMPAT_ALIAS_MAP which is being deleted)
    - Line 19-20: Update `isReadOnlyForRp()` — it uses `READ_ONLY_LABELS` which is being deleted. Inline the remaining read-only labels or use a new constant
  - `src/memory/core-memory-index-updater.ts`: Verify `"index"` label usage is correct — keep as-is
  - Find ALL remaining usages of `COMPAT_ALIAS_MAP` and `READ_ONLY_LABELS` and remove/replace
  - `src/memory/prompt-data.ts`: Remove the `SHARED_LABELS` array with legacy `"user"` comment if applicable
  - **DB migration (REQUIRED)**: Write migration `memory:032:migrate-character-labels` that:
    - `UPDATE core_memory_blocks SET label = 'pinned_summary' WHERE label = 'character'` — migrate existing `character` rows to canonical `pinned_summary`
    - This prevents orphaning real data: `src/memory/schema.ts:83` (DDL), `src/memory/core-memory.ts:11` (defaults), and `src/memory/prompt-data.test.ts:100-115` all treat `character` as real data
    - After migration, rebuild `core_memory_blocks` with tightened CHECK (remove `'character'` from allowed labels)
  - Update tests:
    - `src/memory/prompt-data.test.ts:100-115` — update `character` label references to `pinned_summary`
    - `src/memory/core-memory.test.ts` — update any tests referencing `character` or `COMPAT_ALIAS_MAP`

  **Must NOT do**:
  - MUST NOT remove `"user"` from CORE_MEMORY_LABELS — it's a standalone label, not a compat alias
  - MUST NOT remove `"index"` from CORE_MEMORY_LABELS — it's actively used by core-memory-index-updater.ts
  - MUST NOT remove `"character"` from type system WITHOUT migrating existing DB rows first — data loss risk

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (parallel with Task 21, after Task 19)
  - **Blocks**: None
  - **Blocked By**: Task 19

  **References**:
  - `src/memory/types.ts:76-97` — Label definitions and compat maps
  - `src/memory/types.ts:403-412` — Input types accepting legacy labels

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Zero compat alias references in code
    Tool: Grep tool + Bash (bun test)
    Steps:
      1. Grep "COMPAT_ALIAS_MAP|READ_ONLY_LABELS" in src/ → expect 0 matches
      2. Grep "resolveCanonicalLabel" in src/ → expect 0 matches
      3. Run `bun run build` → expect 0 type errors
      4. Run `bun test` → expect all pass
    Expected Result: Zero compat references; build + tests pass
    Evidence: .sisyphus/evidence/task-20-compat-clean.txt

  Scenario: character → pinned_summary data migration works
    Tool: Bash (bun test)
    Steps:
      1. Write a test in `test/memory/schema.test.ts` that:
         - Creates DB with existing `core_memory_blocks` row where `label='character'`
         - Applies migration `memory:032`
         - Asserts `SELECT count(*) FROM core_memory_blocks WHERE label='character'` → 0
         - Asserts `SELECT count(*) FROM core_memory_blocks WHERE label='pinned_summary'` → ≥ 1
      2. Run `bun test test/memory/schema.test.ts`
    Expected Result: All `character` labels migrated to `pinned_summary`; test passes
    Evidence: .sisyphus/evidence/task-20-character-migrated.txt

  Scenario: core_memory_blocks CHECK rejects 'character' after migration
    Tool: Bash (bun test)
    Steps:
      1. In the same test: after migration 032, attempt INSERT with `label='character'`
      2. Assert CHECK constraint violation
    Expected Result: 'character' no longer accepted as label
    Evidence: .sisyphus/evidence/task-20-check-tightened.txt
  ```

  **Commit**: YES — C12
  - Message: `refactor(memory): remove COMPAT_ALIAS_MAP + READ_ONLY_LABELS + migrate character label`
  - Files: `src/memory/types.ts`, `src/memory/core-memory.ts`, `src/memory/schema.ts` (migration 032), `src/memory/prompt-data.ts`, `src/memory/prompt-data.test.ts`, `src/memory/core-memory.test.ts`
  - Pre-commit: `bun test`

- [ ] 21. Remove schema.ts makeLegacyNodeRef function

  **What to do**:
  - `src/memory/schema.ts`: Remove `makeLegacyNodeRef()` function (lines 45-53)
  - Find all callers — should only be in test files after Task 14. Remove test usages too.
  - Note: `makeNodeRef()` (canonical version) should remain

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (parallel with Task 20, after Task 14)
  - **Blocks**: None
  - **Blocked By**: Task 14

  **References**:
  - `src/memory/schema.ts:45-53` — Function to remove
  - `test/memory/schema.test.ts:618-619` — Test usage to remove

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: makeLegacyNodeRef removed
    Tool: Bash (grep)
    Steps:
      1. Run `grep -rn "makeLegacyNodeRef" src/ test/`
    Expected Result: Zero matches
    Evidence: .sisyphus/evidence/task-21-function-removed.txt
  ```

  **Commit**: YES — C13
  - Message: `refactor(memory): remove makeLegacyNodeRef`
  - Files: `src/memory/schema.ts`
  - Pre-commit: `bun test`

- [ ] 22. Remove legacy-ONLY test files + assertions

  **What to do**:
  Most test updates are already co-located in Tasks 1-21 (each production task updates its own tests). This task handles ONLY test files/assertions that are purely about legacy invariants with no corresponding production change:
  - **DELETE** `src/memory/canonical-node-refs.test.ts` (5 tests) — exists solely to test canonical vs legacy kind separation; concept no longer exists
  - **DELETE** `src/memory/v3-regression.test.ts` (26 tests) — tests V3 migration invariants that are now the only path; many assertions reference `LEGACY_NODE_REF_KINDS` which is removed
  - `src/memory/contracts/graph-node-ref.test.ts`: Remove test cases for `private_event:55` and `private_belief:88` (lines 17-18, 56-57, 75-76, 94-95) — parser now rejects these; add NEW tests asserting these are rejected
  - `src/memory/schema.test.ts`: Remove `parseGraphNodeRef backward compat` describe block (lines 770-784); Remove `private_belief:42` embedding test (lines 705-714); Update migration count expectation (27 → 32, since migrations 028-032 are added)
  - `test/e2e/demo-scenario.test.ts`: Remove "legacy retirement audit" test (lines 293-300) — legacy is fully gone, audit is moot

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 7
  - **Blocks**: None
  - **Blocked By**: Tasks 15-18

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Zero legacy references in test files
    Tool: Bash (grep + bun test)
    Steps:
      1. Run `grep -rn "private_event\|private_belief\|LEGACY_NODE" src/memory/*.test.ts src/memory/**/*.test.ts test/`
      2. Run `bun test`
    Expected Result: Zero grep matches; all tests pass
    Evidence: .sisyphus/evidence/task-22-tests-clean.txt
  ```

  **Commit**: YES — C14
  - Message: `test: remove legacy-only test files + assertions`
  - Pre-commit: `bun test`

- [ ] 23. Clean up legacy docs

  **What to do**:
  - `docs/MEMORY_REGRESSION_MATRIX.md`: Remove "Legacy Private Path Retirement Audit" section (lines 260-272) or update to reflect completion
  - `docs/MEMORY_SECTION18_MIGRATION_NOTES.md`: Archive or remove (legacy retirement notes now complete)
  - `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md`: Update to reflect legacy removal is done
  - `docs/MEMORY_ARCHITECTURE_2026.md`: Update to remove references to `agent_fact_overlay` as an active table

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 7 (after Task 22)
  - **Blocks**: None
  - **Blocked By**: Task 22

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Docs don't reference legacy tables as active
    Tool: Bash (grep)
    Steps:
      1. Run `grep -rn "agent_fact_overlay" docs/ | grep -iv "historical\|removed\|dropped\|legacy"`
    Expected Result: Zero matches (only historical references remain if any)
    Evidence: .sisyphus/evidence/task-23-docs-clean.txt
  ```

  **Commit**: YES — C15
  - Message: `docs: remove legacy documentation`
  - Files: `docs/*.md`
  - Pre-commit: —

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `deep`
  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check evidence files exist. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

  **QA Scenarios:**
  ```
  Scenario: All Must Have items verified
    Tool: Grep tool (cross-platform content search)
    Steps:
      1. Grep "agent_fact_overlay" in src/ (include *.ts, exclude schema.ts) → expect 0 matches
      2. Grep "private_event|private_belief" in src/ (include *.ts, exclude schema.ts) → expect 0 matches
      3. Grep "LEGACY_NODE_KINDS|LegacyNodeRefKind" in src/ → expect 0 matches
      4. Grep "COMPAT_ALIAS_MAP|READ_ONLY_LABELS" in src/ → expect 0 matches
      5. Grep "getCoreMemoryBlocks|getMemoryHints" in src/ → expect 0 matches
      6. Grep "makeLegacyNodeRef" in src/ → expect 0 matches
      7. Grep "privateEventIds|privateBeliefIds" in src/ → expect 0 matches
    Expected Result: All 7 searches return 0 matches
    Evidence: .sisyphus/evidence/F1-compliance.txt
  ```

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check no legacy patterns remain.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

  **QA Scenarios:**
  ```
  Scenario: Build and tests pass cleanly
    Tool: Bash (bun test + bun run build) + Grep tool
    Steps:
      1. Run `bun test` → expect 0 failures
      2. Run `bun run build` → expect 0 errors
      3. Use Grep tool: pattern "as any|@ts-ignore" in src/memory/ and src/core/ (include *.ts, exclude *.test.ts) → document any matches
    Expected Result: Build passes; tests pass; no new code quality issues
    Evidence: .sisyphus/evidence/F2-quality.txt
  ```

- [ ] F3. **Automated End-to-End QA** — `unspecified-high`
  Start from clean state. Run full `bun test`. Verify all Definition of Done criteria via Grep tool. Test assertion upsert still works correctly end-to-end.
  Output: `Scenarios [N/N pass] | Integration [N/N] | VERDICT`

  **QA Scenarios:**
  ```
  Scenario: Full test suite and Definition of Done verification
    Tool: Bash (bun test) + Grep tool (for content searches)
    Steps:
      1. Run `bun test` → record pass/fail count
      2. Use Grep tool to verify each Definition of Done criterion:
         - Grep "agent_fact_overlay" in src/ (exclude schema.ts) → expect 0 matches
         - Grep "private_event|private_belief" in src/ (exclude schema.ts) → expect 0 matches
         - Grep "LEGACY_NODE_KINDS|LegacyNodeRefKind" in src/ → expect 0 matches
         - Grep "COMPAT_ALIAS_MAP|READ_ONLY_LABELS" in src/ → expect 0 matches
         - Grep "getCoreMemoryBlocks|getMemoryHints" in src/ → expect 0 matches
         - Grep "makeLegacyNodeRef" in src/ → expect 0 matches
         - Grep "privateEventIds|privateBeliefIds" in src/ → expect 0 matches
      3. Run `bun test test/memory/cognition-commit.test.ts` → verify assertion upsert still works e2e
    Expected Result: All tests pass; all grep verifications return 0 matches
    Evidence: .sisyphus/evidence/F3-qa.txt
  ```

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Verify private_episode_events, private_cognition_events, private_cognition_current tables are UNTOUCHED.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | VERDICT`

  **QA Scenarios:**
  ```
  Scenario: Modern tables untouched, scope fidelity verified
    Tool: Bash (git) + Grep tool
    Steps:
      1. Run `git log --oneline -20` → list recent commits to verify scope
      2. Use Grep tool: pattern "private_episode_events|private_cognition_events|private_cognition_current" in src/memory/schema.ts → verify these tables still exist in MEMORY_DDL (expect matches)
      3. Use Grep tool: pattern "DROP TABLE.*private_episode|DROP TABLE.*private_cognition" in src/memory/schema.ts → expect 0 matches (these tables must NOT be dropped)
      4. Run `bun test` → verify all tests pass
    Expected Result: Modern tables intact; scope clean; all tests pass
    Evidence: .sisyphus/evidence/F4-scope.txt
  ```

---

## Commit Strategy

| Commit | Message | Files | Pre-commit |
|--------|---------|-------|------------|
| C1 | fix(memory): redirect createPrivateBelief to upsertAssertion | storage.ts, task-agent.ts, + their tests | bun test |
| C2 | fix(memory): guard migration 006 + make MemoryDataSource methods optional | schema.ts, prompt-data-sources.ts, memory-adapter.ts | bun test |
| C3 | refactor(memory): cut agent_fact_overlay writes from upsertAssertion + retractCognition | cognition-repo.ts, stress-contested-chain.test.ts, contested-chain-v3.test.ts, + related tests | bun test |
| C4 | refactor(memory): remove legacy source_ref compat loops | cognition-repo.ts | bun test |
| C5 | feat(memory): migration backfill unkeyed assertions + purge legacy node_refs from derived tables | schema.ts, + migration tests | bun test |
| C6 | feat(memory): migration drop agent_fact_overlay | schema.ts, + tests | bun test |
| C7 | refactor(memory): cut agent_fact_overlay reads from all modules | cognition-repo.ts, graph-organizer.ts, graph-edge-view.ts, embeddings.ts, navigator.ts, relation-*.ts, cognition-search.ts, + their tests | bun test |
| C8 | refactor(memory): remove legacy node kind type infrastructure | types.ts, graph-node-ref.ts, navigator.ts, visibility-policy.ts, retrieval.ts, graph-organizer.ts, embeddings.ts, graph-edge-view.ts, promotion.ts, private-cognition-current.ts, + their tests | bun test |
| C9 | refactor(memory): rename CreatedState fields to canonical names | task-agent.ts, core-memory-index-updater.ts, explicit-settlement-processor.ts, + their tests | bun test |
| C10 | feat(memory): migration tighten node_embeddings CHECK | schema.ts | bun test |
| C11 | refactor(core): remove deprecated prompt slots + getCoreMemoryBlocks + getMemoryHints | prompt-template.ts, prompt-renderer.ts, prompt-sections.ts, prompt-builder.ts, prompt-data.ts, prompt-data-sources.ts, memory-adapter.ts, + their tests | bun test |
| C12 | refactor(memory): remove COMPAT_ALIAS_MAP + READ_ONLY_LABELS + migrate character label | types.ts, core-memory.ts, schema.ts (migration 032), prompt-data.ts, prompt-data.test.ts, core-memory.test.ts | bun test |
| C13 | refactor(memory): remove makeLegacyNodeRef | schema.ts, schema.test.ts | bun test |
| C14 | test: remove legacy-only test files + assertions + update migration counts | v3-regression.test.ts, canonical-node-refs.test.ts, graph-node-ref.test.ts, schema.test.ts, demo-scenario.test.ts | bun test |
| C15 | docs: remove legacy documentation | docs/*.md | — |

---

## Success Criteria

### Verification Commands

Use **Bash** for test/build and **Grep tool** for content searches (cross-platform):

```
bun test                    # Expected: all pass, 0 failures
bun run build               # Expected: no type errors (tsc --noEmit)
```

Use **Grep tool** for each of these patterns in `src/` (all must return 0 matches):

| Pattern | Path | Exclude | Expected |
|---------|------|---------|----------|
| `agent_fact_overlay` | src/ | schema.ts | 0 matches |
| `private_event\|private_belief` | src/ | schema.ts, *.md | 0 matches |
| `LEGACY_NODE_KINDS\|LegacyNodeRefKind` | src/ | — | 0 matches |
| `COMPAT_ALIAS_MAP\|READ_ONLY_LABELS` | src/ | — | 0 matches |
| `getCoreMemoryBlocks\|getMemoryHints` | src/ | — | 0 matches |
| `makeLegacyNodeRef` | src/ | — | 0 matches |
| `privateEventIds\|privateBeliefIds` | src/ | — | 0 matches |
| `CORE_MEMORY\|MEMORY_HINTS` | src/core/prompt-template.ts | — | 0 matches |

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] Zero legacy references in production code
- [ ] All data migrated
- [ ] Schema clean
