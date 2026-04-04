# Talker/Thinker Split — Phase 2: Correctness / Parity / Recovery

## TL;DR

> **Quick Summary**: Fix all Phase 1 accepted degradations in the Talker/Thinker split — restore search projection sync, relation intents, conflict factors, settlement ledger tracking, recovery sweeper, controlled flush, and global concurrency cap, bringing split mode's functional correctness to parity with the sync path.
>
> **Deliverables**:
> - Thinker cognition enters search index (`search_docs_cognition`) and graph organizer pipeline
> - `relationIntents` and `conflictFactors` generated and materialized in split mode
> - Settlement ledger tracks `talker_committed` → `thinker_projecting` → `applied` lifecycle
> - Recovery sweeper detects and re-enqueues lost Thinker jobs
> - Thinker conditionally triggers `memory.organize` jobs for graph organization
> - Global Thinker concurrency capped at configurable limit (default 4)
> - Core Memory Index updated conditionally after Thinker commits
> - Prompt quality evaluation baseline with automated metrics
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES — 5 waves
> **Critical Path**: T5 → T6 → T10/T11 → T13 → T15 → F1-F4

---

## Context

### Original Request

Implement Phase 2 of the Talker/Thinker split per requirements document `docs/talker-thinker-phase2-requirements.md`. Phase 1 shipped a latency-optimized MVP split with 10 accepted degradations. Phase 2 fixes 9 of them (excluding `pinnedSummaryProposal` which is dormant).

### Interview Summary

**Key Discussions**:
- All requirements confirmed with Option A (minimal invasive, direct function call approach)
- User explicitly requested: extract `applyContestConflictFactors` as independent exported function
- R-P2-07 (prompt quality) included in plan with evaluation baseline + initial iteration
- Test strategy: tests-after (project has 100+ test files with `bun test`)

**Research Findings**:
- All code references verified — file paths and line numbers from requirements doc match current codebase
- `TurnSettlementPayload.talkerTurnVersion` already exists at `contracts.ts:129` — R-P2-04 prerequisite already met
- `ThinkerWorkerDeps` at `thinker-worker.ts:43-50` needs expansion for Phase 2 dependencies
- `CognitionRepository` (cognition-repo.ts:121-126) contains entity resolution logic (`entityResolver`) that **will fail** in Thinker context — see Metis review below
- `applyContestConflictFactors` is PRIVATE on `ExplicitSettlementProcessor` (line 391) — extraction confirmed
- `enqueueOrganizerJobs` is PRIVATE on `MemoryTaskAgent` (line 712) — extraction needed

### Metis Review

**Identified Gaps (addressed)**:

1. **CognitionRepository entity resolution incompatibility**: Requirements doc Option A says "use full CognitionRepository in Thinker". Metis identified that `CognitionRepository.upsertAssertion()` calls `entityResolver(pointerKey, agentId)` which may fail when Thinker references entities not yet created. **Resolution**: Keep existing raw write path (`CognitionEventRepo.append()` + `CognitionProjectionRepo.upsertFromEvent()`), add `SearchProjectionRepo` to `ProjectionCommitRepos` type for post-write search sync. This preserves the INTENT of Option A (search sync) while avoiding entity resolution failures.

2. **ResolvedLocalRefs hidden dependency**: `materializeRelationIntents()` requires `ResolvedLocalRefs` which needs DB read-back (episode rows, cognition projection rows). **Resolution**: Read back within the same `sql.begin()` transaction after `commitSettlement()`.

3. **`commitSettlement()` return type**: Must change from `Promise<void>` to `Promise<CommitSettlementResult>` to return `changedNodeRefs`. Phase 1 guardrail G5 is lifted for Phase 2.

4. **Ledger transition constraints**: `markApplying()` only accepts `pending` or `failed_retryable`. Need dedicated `markThinkerProjecting()` method.

5. **Transaction duration**: CoreMemoryIndexUpdater (LLM call) MUST be OUTSIDE `sql.begin()` to avoid holding PG transaction during LLM inference.

### Phase 1 Guardrail Status (Phase 2)

| Guardrail | Phase 1 Rule | Phase 2 Status |
|-----------|-------------|----------------|
| G5 | Do NOT change commitSettlement() signature | **LIFTED** — return type changes to include changedNodeRefs |
| G9 | Thinker MUST NOT trigger flushIfDue() | **MODIFIED** — Thinker MAY enqueue `memory.organize` jobs (not full flush) |
| G13 | No recovery sweeper | **LIFTED** — Recovery sweeper added |
| G14 | Do NOT use settlementUnitOfWork for Thinker | **MODIFIED** — Thinker uses ledger for state tracking (not full UoW) |
| G1-G4, G6-G8, G10-G12, G15 | Various | **UNCHANGED** — Still in effect |

---

## Work Objectives

### Core Objective

Bring Thinker's functional correctness to parity with the sync path by restoring all Phase 1 accepted degradations, ensuring Thinker output is fully searchable, organized, and tracked.

### Concrete Deliverables

- Modified `ProjectionManager.commitSettlement()` with search sync and changedNodeRefs return
- Extended `ThinkerWorkerDeps` and Thinker worker transaction with full artifact materialization
- Extended `SettlementLedgerStatus` with split-mode states and repo methods
- Extended `PendingSettlementSweeper` with Thinker job recovery
- Extracted standalone functions: `enqueueOrganizerJobs`, `applyContestConflictFactors`
- Extended Thinker prompt for `relationIntents` + `conflictFactors` generation
- Configurable global Thinker concurrency cap
- Conditional CoreMemoryIndexUpdater trigger in Thinker path
- Prompt quality evaluation baseline with automated metrics

### Definition of Done

- [ ] `bun run build && bun test` passes with zero failures
- [ ] `--mode sync` behavior identical to Phase 1 completion
- [ ] `--mode async` Talker latency < 25s
- [ ] All 9 Phase 1 degradations resolved (see acceptance criteria below)

### Must Have

- Search sync: Thinker cognition appears in `search_docs_cognition` immediately after commit
- changedNodeRefs: `commitSettlement()` returns node refs for downstream organizer jobs
- Relation intents: `memory_relations` contains `supports`/`triggered` records in split mode
- Conflict factors: `conflicts_with` relations created for contested assertions in split mode
- Ledger tracking: Settlement lifecycle visible via `settlement_processing_ledger`
- Recovery: Lost Thinker jobs detected and re-enqueued within configurable interval
- Concurrency: Global Thinker job cap enforced via `CONCURRENCY_KEY_CAPS`
- Flush: `memory.organize` jobs enqueued after Thinker commits (when conditions met)
- Core Memory Index: Updated conditionally after Thinker commits

### Must NOT Have (Guardrails)

- **No CognitionRepository for Thinker writes** — entity resolution will fail; keep raw write path + post-write search sync
- **No `flushIfDue()` from Thinker** — only `memory.organize` enqueue, not full flush
- **No `memory.migrate` from Thinker** — only organize, never migrate
- **No Talker functional behavior changes** — Talker's output, latency, and settlement data must remain identical. Exception: T8 adds a **best-effort observability write** (`markTalkerCommitted`) after the settlement transaction; this does NOT alter Talker's functional output and is wrapped in try/catch (failure does not propagate).
- **No sync-path behavior changes** — all existing sync-path tests must pass unchanged
- **No new database tables** — extend existing schemas only (ledger column additions are OK)
- **No CoreMemoryIndexUpdater inside transaction** — LLM calls outside `sql.begin()`
- **No frequency-limit skipping for organize enqueue** — refs are job-local; skipping = permanent ref loss
- **No `submit_rp_turn` tool structure changes**
- **No `runRpBufferedTurn` or `runRpTalkerTurn` functional modifications** — exception: T8 adds post-transaction observability write (best-effort, no functional impact)
- **No monitoring dashboards, circuit breakers, or admin endpoints** (scope creep)
- **No batch collapse or `setThinkerVersion`** (Phase 3)

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision

- **Infrastructure exists**: YES
- **Automated tests**: Tests-after
- **Framework**: `bun test`
- **Pattern**: Follow `test/pg-app/pg-settlement-ledger.test.ts` and `test/memory/explicit-settlement-processor-pg.test.ts`

### QA Policy

Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Type-safe compilation**: `bun run build` (tsc --noEmit)
- **Unit/Integration tests**: `bun test` (full suite) + targeted test files
- **PG integration**: Tests run against real PG via `PG_TEST_URL` (docker-compose.jobs-pg.yml)
- **SQL assertions**: Direct DB queries via test helpers to verify row existence

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — extractions + independent changes, ALL parallel):
├── T1:  Extract enqueueOrganizerJobs as standalone function [quick]
├── T2:  Extract applyContestConflictFactors as standalone function [quick]
├── T3:  Settlement ledger: extend status type + repo methods + tests (R-P2-03) [unspecified-high]
├── T4:  Global thinker concurrency cap (R-P2-06) [quick]
└── T5:  Upgrade commitSettlement: search sync + changedNodeRefs return (R-P2-00 D1+D2) [deep]

Wave 2 (Thinker Worker Core — depends on Wave 1):
├── T6:  Expand ThinkerWorkerDeps + transaction scaffolding (depends: T5) [deep]
├── T7:  Extend Thinker prompt: relationIntents + conflictFactors schema (depends: none) [deep]
├── T8:  Integrate settlement ledger into Talker + Thinker flow (depends: T3) [unspecified-high]
└── T9:  CoreMemoryIndexUpdater conditional trigger (depends: T6) [unspecified-high]

Wave 3 (Artifact Materialization + Recovery — depends on Wave 2):
├── T10: Relation intent materialization in Thinker (depends: T6, T7) [deep]
├── T11: Conflict factor resolution + application in Thinker (depends: T2, T6, T7) [deep]
└── T12: Recovery sweeper: sweepThinkerJobs (depends: T8) [deep]

Wave 4 (Controlled Flush + Integration Tests):
├── T13: Thinker controlled flush: enqueue memory.organize (depends: T1, T6, T10, T11) [unspecified-high]
└── T14: Full Thinker pipeline integration tests (depends: T6-T13) [unspecified-high]

Wave 5 (Prompt Optimization):
└── T15: Prompt quality evaluation baseline + initial iteration (depends: all) [deep]

Wave FINAL (4 parallel reviews → user okay):
├── F1:  Plan compliance audit (oracle)
├── F2:  Code quality review (unspecified-high)
├── F3:  Real manual QA (unspecified-high)
└── F4:  Scope fidelity check (deep)
→ Present results → Get explicit user okay

Critical Path: T5 → T6 → T10/T11 → T13 → T15 → F1-F4 → user okay
Parallel Speedup: ~65% faster than sequential
Max Concurrent: 5 (Wave 1)
```

### Dependency Matrix

| Task | Blocked By | Blocks | Wave |
|------|-----------|--------|------|
| T1 | — | T13 | 1 |
| T2 | — | T11 | 1 |
| T3 | — | T8, T12 | 1 |
| T4 | — | — | 1 |
| T5 | — | T6 | 1 |
| T6 | T5 | T9, T10, T11, T13, T14 | 2 |
| T7 | — | T10, T11 | 2 |
| T8 | T3 | T12 | 2 |
| T9 | T6 | T14 | 2 |
| T10 | T6, T7 | T13, T14 | 3 |
| T11 | T2, T6, T7 | T13, T14 | 3 |
| T12 | T8 | T14 | 3 |
| T13 | T1, T6, T10, T11 | T14 | 4 |
| T14 | T6-T13 | T15 | 4 |
| T15 | all | — | 5 |

### Agent Dispatch Summary

- **Wave 1**: **5** — T1 → `quick`, T2 → `quick`, T3 → `unspecified-high`, T4 → `unspecified-high`, T5 → `deep`
- **Wave 2**: **4** — T6 → `deep`, T7 → `deep`, T8 → `unspecified-high`, T9 → `unspecified-high`
- **Wave 3**: **3** — T10 → `deep`, T11 → `deep`, T12 → `deep`
- **Wave 4**: **2** — T13 → `unspecified-high`, T14 → `unspecified-high`
- **Wave 5**: **1** — T15 → `deep`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [ ] 1. Extract `enqueueOrganizerJobs()` as Standalone Exported Function

  **What to do**:
  - Extract `enqueueOrganizerJobs()` (currently private on `MemoryTaskAgent`, line 712-749) into a standalone exported function
  - New export location: `src/memory/organize-enqueue.ts` (new file)
  - Function signature: `export async function enqueueOrganizerJobs(jobPersistence: JobPersistence, agentId: string, settlementId: string, changedNodeRefs: NodeRef[], chunkSize?: number): Promise<void>`
  - Default `chunkSize` = 50 (current `ORGANIZER_CHUNK_SIZE`)
  - Co-extract `ORGANIZER_CHUNK_SIZE` constant and `JOB_MAX_ATTEMPTS["memory.organize"]` reference
  - Refactor `MemoryTaskAgent.enqueueOrganizerJobs()` to be a thin wrapper calling the extracted function: `return enqueueOrganizerJobs(this.jobPersistence!, this.agentId, ...)`
  - Write test: `test/memory/organize-enqueue.test.ts` — verify chunking (51 refs → 2 jobs), empty refs → no jobs, enqueue failure → error propagates to caller

  **Error Propagation Contract (CRITICAL)**:
  - The extracted function MUST let `jobPersistence.enqueue()` errors propagate (throw). It must NOT catch/swallow errors internally.
  - The CALLER decides how to handle errors. In `MemoryTaskAgent` (line 648-654), the outer try/catch checks `strictDurableMode`: if true, re-throws; if false, falls back to `launchBackgroundOrganize()`. If the extracted function swallows errors, `strictDurableMode` protection is silently broken.
  - The Thinker worker (T13) will wrap the call in its own try/catch with its own error handling policy.

  **Must NOT do**:
  - Do NOT change the behavior of the existing `MemoryTaskAgent.enqueueOrganizerJobs()` — it must remain a call-through wrapper
  - Do NOT remove the private method — keep it for backward compat, just delegate
  - Do NOT catch errors inside the extracted function — let them propagate to the caller

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single function extraction with clear boundaries, mechanical refactoring
  - **Skills**: []
    - No special skills needed — straightforward code extraction
  - **Skills Evaluated but Omitted**:
    - `git-master`: Not needed — no git operations in this task

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T2, T3, T4, T5)
  - **Blocks**: T13 (controlled flush uses this function)
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `src/memory/task-agent.ts:712-749` — Current `enqueueOrganizerJobs()` implementation: chunking logic, `ORGANIZER_CHUNK_SIZE=50`, `JOB_MAX_ATTEMPTS` reference, job ID format `memory.organize:{settlementId}:chunk:{ordinal}`
  - `src/memory/task-agent.ts:648-654` — How MemoryTaskAgent calls enqueueOrganizerJobs: error handling with `strictDurableMode` check

  **API/Type References**:
  - `src/jobs/durable-store.ts` — `JobPersistence.enqueue()` interface used by the function
  - `src/memory/types.ts` — `NodeRef` type used in `changedNodeRefs` parameter
  - `src/jobs/types.ts:46-56` — `JOB_MAX_ATTEMPTS` map with `"memory.organize": 3`

  **Test References**:
  - `test/jobs/pg-organize-enqueue.test.ts` — Existing organize enqueue tests, follow this pattern
  - `test/memory/organizer-enqueue-failure.test.ts` — Tests for enqueue failure handling

  **Acceptance Criteria**:
  - [ ] New file `src/memory/organize-enqueue.ts` exists with exported function
  - [ ] `MemoryTaskAgent.enqueueOrganizerJobs()` delegates to the standalone function
  - [ ] `bun run build` passes — no type errors
  - [ ] `bun test` passes — all existing tests still pass
  - [ ] New test `test/memory/organize-enqueue.test.ts` passes

  **QA Scenarios**:

  ```
  Scenario: Standalone function chunks refs correctly
    Tool: Bash (bun test)
    Preconditions: test/memory/organize-enqueue.test.ts exists
    Steps:
      1. Run `bun test test/memory/organize-enqueue.test.ts`
      2. Test case: 51 NodeRefs → function calls jobPersistence.enqueue() exactly 2 times
      3. Test case: 0 NodeRefs → function calls jobPersistence.enqueue() 0 times
      4. Test case: 50 NodeRefs → function calls jobPersistence.enqueue() exactly 1 time
      5. Test case: enqueue() throws → error propagates (NOT swallowed)
    Expected Result: All test cases pass; errors are NOT caught internally
    Failure Indicators: Test output shows FAIL for any case; enqueue call count mismatch; error swallowed silently
    Evidence: .sisyphus/evidence/task-1-chunk-logic.txt

  Scenario: Existing MemoryTaskAgent behavior unchanged
    Tool: Bash (bun test)
    Preconditions: None
    Steps:
      1. Run `bun test test/jobs/pg-organize-enqueue.test.ts test/memory/organizer-enqueue-failure.test.ts`
      2. All existing tests must pass without modification
    Expected Result: All tests PASS
    Failure Indicators: Any test failure in existing test files
    Evidence: .sisyphus/evidence/task-1-regression.txt
  ```

  **Commit**: YES (groups with T5 in C1)
  - Message: `feat(projection): add search sync + changedNodeRefs to commitSettlement, extract enqueueOrganizerJobs`
  - Files: `src/memory/organize-enqueue.ts`, `src/memory/task-agent.ts`, `test/memory/organize-enqueue.test.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 2. Extract `applyContestConflictFactors()` as Standalone Exported Function

  **What to do**:
  - Extract `applyContestConflictFactors()` (currently private on `ExplicitSettlementProcessor`, line 391-426) into a standalone exported function
  - New export location: `src/memory/cognition/contest-conflict-applicator.ts` (new file)
  - Function signature: `export async function applyContestConflictFactors(relationBuilder: Pick<RelationBuilder, "writeContestRelations">, cognitionProjectionRepo: Pick<CognitionProjectionRepo, "updateConflictFactors">, agentId: string, settlementId: string, contestedAssertions: Array<{ cognitionKey: string; nodeRef: string }>, resolvedFactorNodeRefs: string[], unresolvedCount: number): Promise<void>`
  - Co-extract `normalizeConflictFactorRefs` import (from `private-cognition-current.ts`)
  - Refactor `ExplicitSettlementProcessor.applyContestConflictFactors()` to be a thin wrapper calling the standalone function
  - Write test: verify conflict factor application writes relations + updates projection metadata

  **Must NOT do**:
  - Do NOT change the behavior of `ExplicitSettlementProcessor.applyContestConflictFactors()` — thin wrapper only
  - Do NOT modify `normalizeConflictFactorRefs` itself

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Mechanical function extraction with clear type boundaries
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `git-master`: Not needed

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T3, T4, T5)
  - **Blocks**: T11 (conflict factor application in Thinker uses this function)
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `src/memory/explicit-settlement-processor.ts:391-426` — Current private method: uses `normalizeConflictFactorRefs`, `this.relationBuilder.writeContestRelations()`, `this.cognitionProjectionRepo.updateConflictFactors()`
  - `src/memory/explicit-settlement-processor.ts:168-206` — Sync path sequence showing where applyContestConflictFactors fits in the pipeline

  **API/Type References**:
  - `src/memory/cognition/relation-builder.ts:81` — `RelationBuilder.writeContestRelations()` signature
  - `src/storage/domain-repos/pg/cognition-projection-repo.ts` — `CognitionProjectionRepo.updateConflictFactors()` signature
  - `src/memory/cognition/private-cognition-current.ts` — `normalizeConflictFactorRefs()` function

  **Test References**:
  - `test/memory/explicit-settlement-processor-pg.test.ts` — Existing settlement processor tests, verify no regression

  **Acceptance Criteria**:
  - [ ] New file `src/memory/cognition/contest-conflict-applicator.ts` exists with exported function
  - [ ] `ExplicitSettlementProcessor.applyContestConflictFactors()` delegates to the standalone function
  - [ ] `bun run build` passes
  - [ ] `bun test` passes — all existing settlement processor tests still pass

  **QA Scenarios**:

  ```
  Scenario: Extracted function preserves behavior
    Tool: Bash (bun test)
    Preconditions: Extraction complete
    Steps:
      1. Run `bun test test/memory/explicit-settlement-processor-pg.test.ts`
      2. All existing contest/conflict-related test cases must pass
    Expected Result: All tests PASS — behavior identical to pre-extraction
    Failure Indicators: Any test failure in settlement processor tests
    Evidence: .sisyphus/evidence/task-2-regression.txt

  Scenario: Build verifies type safety of extraction
    Tool: Bash (bun run build)
    Preconditions: Extraction complete
    Steps:
      1. Run `bun run build`
      2. Check for zero type errors
    Expected Result: Exit code 0, no type errors
    Failure Indicators: Type errors in contest-conflict-applicator.ts or explicit-settlement-processor.ts
    Evidence: .sisyphus/evidence/task-2-build.txt
  ```

  **Commit**: YES (groups with T3 in C2)
  - Message: `feat(settlement): extend ledger with split-mode states, extract applyContestConflictFactors`
  - Files: `src/memory/cognition/contest-conflict-applicator.ts`, `src/memory/explicit-settlement-processor.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 3. Settlement Ledger: Extend Status Type + PgSettlementLedgerRepo Methods (R-P2-03)

  **What to do**:
  - Extend `SettlementLedgerStatus` union type in `src/memory/settlement-ledger.ts` with two new states:
    - `"talker_committed"` — Talker has committed settlement, Thinker not yet started
    - `"thinker_projecting"` — Thinker is executing projection (equivalent to sync `applying`)
  - Extend `SettlementLedger` interface with two new methods:
    - `markTalkerCommitted(settlementId: string, agentId: string): Promise<void>`
    - `markThinkerProjecting(settlementId: string, agentId: string): Promise<void>`
  - Implement in `PgSettlementLedgerRepo`:
    - `markTalkerCommitted()`: INSERT with status `talker_committed` (new settlement entry)
    - `markThinkerProjecting()`: UPDATE status from `talker_committed` OR `failed_retryable` → `thinker_projecting`; reject other source states
    - Existing `markApplied()` must accept transitions from `thinker_projecting` (in addition to existing `applying`)
    - Existing `markFailed()` must accept transitions from `thinker_projecting`
  - Update `SettlementLedgerCheckResult` mapping: `talker_committed` → `"pending"`, `thinker_projecting` → `"pending"`
  - Add migration or ALTER TABLE if the `settlement_processing_ledger` table has a CHECK constraint on status values — verify in `src/storage/pg-app-schema-truth.ts:28-48`
  - Write tests following `test/pg-app/pg-settlement-ledger.test.ts` pattern

  **Must NOT do**:
  - Do NOT modify existing sync-path transition rules (pending → claimed → applying → applied)
  - Do NOT change the table structure beyond adding status values

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Involves type extension, PG repo implementation, migration check, and PG integration tests
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `git-master`: Not needed for this task

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T2, T4, T5)
  - **Blocks**: T8 (ledger integration into Talker/Thinker), T12 (recovery sweeper uses ledger)
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `src/storage/domain-repos/pg/settlement-ledger-repo.ts:11-210` — Full `PgSettlementLedgerRepo` with all existing methods; follow same pattern for new methods
  - `src/storage/domain-repos/pg/settlement-ledger-repo.ts:121-133` — `markApplying()` transition constraints: only from `pending` or `failed_retryable`. Model new `markThinkerProjecting()` on this pattern.

  **API/Type References**:
  - `src/memory/settlement-ledger.ts:1-23` — `SettlementLedgerStatus` type (8 states) and `SettlementLedger` interface (all methods)
  - `src/storage/pg-app-schema-truth.ts:28-48` — `settlement_processing_ledger` table DDL — check for CHECK constraint on status column

  **Test References**:
  - `test/pg-app/pg-settlement-ledger.test.ts` — Existing ledger tests: state transition tests, constraint violation tests. Follow same structure.

  **Acceptance Criteria**:
  - [ ] `SettlementLedgerStatus` includes `"talker_committed"` and `"thinker_projecting"`
  - [ ] `PgSettlementLedgerRepo` has `markTalkerCommitted()` and `markThinkerProjecting()` methods
  - [ ] Transition `talker_committed → thinker_projecting → applied` works
  - [ ] Transition `thinker_projecting → failed_retryable → thinker_projecting` works (retry)
  - [ ] Invalid transitions rejected (e.g., `pending → thinker_projecting` fails)
  - [ ] `bun run build && bun test` passes

  **QA Scenarios**:

  ```
  Scenario: Happy path — full split-mode lifecycle
    Tool: Bash (bun test)
    Preconditions: PG test database available
    Steps:
      1. Run `bun test test/pg-app/pg-settlement-ledger.test.ts`
      2. New test case: markTalkerCommitted() → markThinkerProjecting() → markApplied()
      3. Verify each intermediate status via rawStatus() query
    Expected Result: All transitions succeed, rawStatus returns expected values at each stage
    Failure Indicators: Transition throws error; rawStatus returns wrong value
    Evidence: .sisyphus/evidence/task-3-ledger-lifecycle.txt

  Scenario: Invalid transition rejected
    Tool: Bash (bun test)
    Preconditions: PG test database available
    Steps:
      1. Insert a settlement with status "pending"
      2. Attempt markThinkerProjecting() — should REJECT (only from talker_committed or failed_retryable)
      3. Verify error is thrown
    Expected Result: Transition rejects with appropriate error
    Failure Indicators: Transition silently succeeds when it should fail
    Evidence: .sisyphus/evidence/task-3-invalid-transition.txt
  ```

  **Commit**: YES (groups with T2 in C2)
  - Message: `feat(settlement): extend ledger with split-mode states, extract applyContestConflictFactors`
  - Files: `src/memory/settlement-ledger.ts`, `src/storage/domain-repos/pg/settlement-ledger-repo.ts`, `src/storage/pg-app-schema-truth.ts`, `test/pg-app/pg-settlement-ledger.test.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 4. Global Thinker Concurrency Cap (R-P2-06)

  **What to do**:

  **⚠️ CRITICAL ARCHITECTURE ISSUE**: `claimNext()` (pg-store.ts:518-538) only checks the SINGLE `concurrency_key` stored on each job row. Thinker jobs are created with `concurrency_key = cognition.thinker:session:${sessionId}` (see `job-persistence-factory.ts:222`). Simply adding `cognition.thinker:global` to `CONCURRENCY_KEY_CAPS` does NOTHING because no job carries that key. **The claim loop must be modified.**

  - Add `cognition_thinker_global` to `CONCURRENCY_CAPS` in `src/jobs/types.ts` with default value 4
  - Add `"cognition.thinker:global": CONCURRENCY_CAPS.cognition_thinker_global` to `CONCURRENCY_KEY_CAPS` in `src/jobs/pg-store.ts`
  - **Modify `claimNext()`** (pg-store.ts:518-538) to support **derived global caps**:
    - After the existing per-key check passes (line 536-538), add a second check for the job kind's global cap
    - Derive global key from job's concurrency_key: `cognition.thinker:session:X` → strip the `:session:X` suffix → `cognition.thinker:global`
    - Lookup `getConcurrencyCap("cognition.thinker:global")` — if a cap exists, count ALL running `cognition.thinker` jobs (across all sessions): `SELECT COUNT(*) FROM jobs_current WHERE job_type = candidate.job_type AND status = 'running'`
    - If running count >= global cap, skip this candidate
    - This approach is generic: any job kind can get a global cap by adding `{kind}:global` to `CONCURRENCY_KEY_CAPS`
  - Make the value configurable via `RuntimeConfig.talkerThinker.globalConcurrencyCap`
  - Write tests: (1) global cap=2 + 4 sessions → only 2 claimed; (2) per-session cap still works; (3) non-thinker jobs unaffected

  **Must NOT do**:
  - Do NOT change per-session cap (remains 1)
  - Do NOT give thinker jobs multiple concurrency_key values (schema only supports one)
  - Do NOT add global checks for job types that don't have a `{kind}:global` entry in CONCURRENCY_KEY_CAPS

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Requires modifying `claimNext()` claim logic — the core job scheduling path. Must be careful not to regress other job kinds. More than a config change.
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `git-master`: Not needed

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T2, T3, T5)
  - **Blocks**: None
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `src/jobs/pg-store.ts:138-145` — Current `CONCURRENCY_KEY_CAPS` map — add new entry
  - `src/jobs/pg-store.ts:518-538` — `claimNext()` claim loop: iterates candidates, checks SINGLE `concurrency_key` per job. **THIS IS THE CODE TO MODIFY** — add derived global cap check after the per-key check passes.
  - `src/jobs/job-persistence-factory.ts:215-228` — Where thinker job `concurrency_key` is assigned as `cognition.thinker:session:${sessionId}`. Shows the single-key-per-job design.

  **API/Type References**:
  - `src/jobs/types.ts:58-68` — `CONCURRENCY_CAPS` object — add `cognition_thinker_global: 4`

  **External References**:
  - None needed — entirely internal scheduling change

  **Test References**:
  - `test/jobs/pg-claim-lease.test.ts` — Existing claim tests with concurrency, follow pattern
  - `test/jobs/pg-fencing.test.ts` — Tests for concurrent job execution limits

  **Acceptance Criteria**:
  - [ ] `CONCURRENCY_KEY_CAPS` contains `"cognition.thinker:global"` entry
  - [ ] `CONCURRENCY_CAPS` contains `cognition_thinker_global` with default 4
  - [ ] `claimNext()` checks BOTH per-session AND global caps for thinker jobs
  - [ ] Non-thinker jobs unaffected by global cap logic (no regression)
  - [ ] `bun run build && bun test` passes
  - [ ] New test verifies global cap enforcement at the `claimNext()` level

  **QA Scenarios**:

  ```
  Scenario: Global cap limits concurrent thinker jobs via claimNext
    Tool: Bash (bun test)
    Preconditions: PG test database available, global cap set to 2
    Steps:
      1. Enqueue 4 cognition.thinker jobs from 4 different sessions (each has concurrency_key=cognition.thinker:session:{n})
      2. Call claimNext() 4 times from same worker
      3. Assert: exactly 2 jobs claimed (status=running), 2 remain pending
      4. Verify: SELECT count(*) FROM jobs_current WHERE job_type='cognition.thinker' AND status='running' → 2
    Expected Result: Only 2 thinker jobs running despite 4 different session keys
    Failure Indicators: 3 or 4 jobs claimed; global cap not checked by claimNext
    Evidence: .sisyphus/evidence/task-4-global-cap.txt

  Scenario: Per-session cap still enforced alongside global
    Tool: Bash (bun test)
    Preconditions: PG test database available, global cap=10
    Steps:
      1. Enqueue 3 cognition.thinker jobs for the SAME session
      2. Call claimNext() 3 times
      3. Assert: exactly 1 job claimed (per-session cap = 1), 2 remain pending
    Expected Result: Per-session cap prevents more than 1 concurrent job per session
    Failure Indicators: More than 1 job claimed for same session
    Evidence: .sisyphus/evidence/task-4-session-cap.txt

  Scenario: Non-thinker jobs unaffected by global cap logic
    Tool: Bash (bun test)
    Preconditions: PG test database available
    Steps:
      1. Enqueue 3 task.run jobs (task.run has NO entry in CONCURRENCY_KEY_CAPS — no global cap)
      2. Call claimNext() 3 times
      3. Assert: all 3 jobs claimed (up to their own per-key cap) — no spurious global cap applied
      NOTE: Do NOT use memory.organize for this test — it already has `memory.organize:global` in CONCURRENCY_KEY_CAPS (pg-store.ts:140)
    Expected Result: task.run jobs claimed normally, derived global cap check finds no cap and proceeds
    Failure Indicators: Jobs blocked by non-existent global cap; derived key lookup causes false positive
    Evidence: .sisyphus/evidence/task-4-no-regression.txt
  ```

  **Commit**: YES (standalone C3)
  - Message: `feat(jobs): add global thinker concurrency cap`
  - Files: `src/jobs/types.ts`, `src/jobs/pg-store.ts`, runtime config file
  - Pre-commit: `bun run build && bun test`

---

- [ ] 5. Upgrade `commitSettlement()`: Search Sync + changedNodeRefs Return (R-P2-00 Diff 1+2)

  **What to do**:

  **Part A — Search Sync (R-P2-00 Diff 1)**:
  - Add `searchProjectionRepo?` to `ProjectionCommitRepos` type (optional — maintains backward compat for sync path callers that don't need it)
  - Define `ProjectionSearchProjectionRepo` type (following `ProjectionEpisodeRepo` pattern) with method `upsertCognitionSearchDoc(params): Promise<void>`
  - In `appendCognitionEvents()` (projection-manager.ts:175-200), after each cognition event is appended + projected, call `searchProjectionRepo.upsertCognitionSearchDoc()` if the repo is provided
  - The search doc must contain: `overlayId` (from projection upsert), `agentId`, `kind` (assertion/evaluation/commitment), `content` (summary text), `stance`, `basis`, `sourceRefKind`
  - Find the `SearchProjectionRepo` contract in `src/storage/domain-repos/contracts/search-projection-repo.ts` — identify the exact `upsert` method signature

  **Part B — changedNodeRefs Return (R-P2-00 Diff 2)**:
  - Define return type: `export type CommitSettlementResult = { changedNodeRefs: NodeRef[] }`
  - Change `commitSettlement()` return from `Promise<void>` to `Promise<CommitSettlementResult>`
  - Collect refs during episode append: each episode → `private_episode:{id}` NodeRef
  - Collect refs during cognition event append: each cognition event → `private_cognition:{id}` NodeRef
  - Return collected refs in the result
  - Use `lsp_find_references` on `commitSettlement` to find ALL call sites and update them:
    - Thinker worker (thinker-worker.ts:279) — capture returned changedNodeRefs
    - Any sync-path callers — may ignore the return value (backward compat)

  **Must NOT do**:
  - Do NOT use `CognitionRepository` for Thinker writes — entity resolution will fail
  - Do NOT make `searchProjectionRepo` required in `ProjectionCommitRepos` — optional for backward compat
  - Do NOT modify the internal logic of `appendEpisodes` or `appendCognitionEvents` beyond adding search sync and ref collection

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Modifies core shared infrastructure (`ProjectionManager`), requires careful type changes across multiple call sites, needs thorough understanding of NodeRef format
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `git-master`: Not needed for implementation

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T2, T3, T4)
  - **Blocks**: T6 (ThinkerWorkerDeps expansion depends on new return type)
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `src/memory/projection/projection-manager.ts:160-222` — Current `commitSettlement()` implementation: episode append → cognition append → slot upsert → area state → publications
  - `src/memory/projection/projection-manager.ts:50-57` — `ProjectionCommitRepos` type to extend
  - `src/memory/cognition/cognition-repo.ts:218-227` — `syncCognitionSearchDoc()` call pattern in CognitionRepository — this is the REFERENCE for how search docs should be built (overlayId, agentId, kind, content, stance, basis)
  - `src/memory/task-agent.ts:467-472` — `CreatedState.changedNodeRefs` — the sync-path pattern for ref collection

  **API/Type References**:
  - `src/storage/domain-repos/contracts/search-projection-repo.ts` — `SearchProjectionRepo` contract — find the upsert method
  - `src/memory/types.ts` — `NodeRef` type: format is `"private_cognition:{id}"` or `"private_episode:{id}"`
  - `src/memory/contracts/graph-node-ref.ts` — NodeRef construction helpers

  **Test References**:
  - `test/pg-app/pg-search-projection-repo.test.ts` — Existing search projection repo tests
  - `test/memory/explicit-settlement-processor-pg.test.ts` — Tests that call commitSettlement indirectly

  **WHY Each Reference Matters**:
  - `cognition-repo.ts:218-227`: Shows EXACT search doc shape (overlayId, kind, content, stance, basis) — executor must replicate this format
  - `task-agent.ts:467-472`: Shows `changedNodeRefs` as `NodeRef[]` initialized in CreatedState — executor must use same ref format
  - `search-projection-repo.ts`: Must read contract to know exact method signature for upsert

  **Acceptance Criteria**:
  - [ ] `ProjectionCommitRepos` type includes optional `searchProjectionRepo`
  - [ ] `commitSettlement()` returns `Promise<CommitSettlementResult>` with `changedNodeRefs`
  - [ ] All existing `commitSettlement()` callers updated (no type errors)
  - [ ] When `searchProjectionRepo` provided: cognition events produce search docs
  - [ ] When `searchProjectionRepo` NOT provided: behavior unchanged (backward compat)
  - [ ] `bun run build && bun test` passes

  **QA Scenarios**:

  ```
  Scenario: commitSettlement returns changedNodeRefs
    Tool: Bash (bun test)
    Preconditions: projection-manager.ts modified
    Steps:
      1. Create test that calls commitSettlement with 2 cognition ops and 1 episode
      2. Assert result.changedNodeRefs has length 3
      3. Assert refs match format: ["private_cognition:{id}", "private_cognition:{id}", "private_episode:{id}"]
    Expected Result: changedNodeRefs contains exactly the refs for created records
    Failure Indicators: Empty array; wrong ref format; wrong count
    Evidence: .sisyphus/evidence/task-5-changed-refs.txt

  Scenario: Search sync writes docs when repo provided
    Tool: Bash (bun test)
    Preconditions: PG test database available, search projection repo passed in repoOverrides
    Steps:
      1. Call commitSettlement with searchProjectionRepo in repoOverrides
      2. Commit 2 cognition ops (1 assertion, 1 evaluation)
      3. Query search_docs_cognition WHERE settlement_id = test_settlement_id
      4. Assert: 2 rows exist with correct kind and content
    Expected Result: search_docs_cognition contains matching rows
    Failure Indicators: No rows; wrong count; missing fields
    Evidence: .sisyphus/evidence/task-5-search-sync.txt

  Scenario: Backward compat — no searchProjectionRepo
    Tool: Bash (bun test)
    Preconditions: projection-manager.ts modified
    Steps:
      1. Call commitSettlement WITHOUT searchProjectionRepo in repoOverrides
      2. Assert: no error thrown, projections still written normally
    Expected Result: Identical behavior to pre-change commitSettlement
    Failure Indicators: Error thrown; missing projections
    Evidence: .sisyphus/evidence/task-5-backward-compat.txt
  ```

  **Commit**: YES (groups with T1 in C1)
  - Message: `feat(projection): add search sync + changedNodeRefs to commitSettlement, extract enqueueOrganizerJobs`
  - Files: `src/memory/projection/projection-manager.ts`, callers of commitSettlement
  - Pre-commit: `bun run build && bun test`

- [ ] 6. Expand ThinkerWorkerDeps + Transaction Scaffolding (R-P2-00 Integration)

  **What to do**:
  - Extend `ThinkerWorkerDeps` interface (thinker-worker.ts:43-50) with new dependencies:
    - `cognitionProjectionRepo: CognitionProjectionRepo` (for conflict factor resolution + ref read-back)
    - `relationWriteRepo: RelationWriteRepo` (for relation intent materialization)
    - `relationBuilder: RelationBuilder` (for contest conflict relations)
    - `coreMemoryIndexUpdater: CoreMemoryIndexUpdater` (for index updates)
    - `jobPersistence?: JobPersistence` (for organize job enqueue)
    - `settlementLedger?: SettlementLedger` (for ledger state tracking)
  - Expand the `sql.begin()` block in the Thinker worker to:
    - Create `PgSearchProjectionRepo(txSql)` and pass as `searchProjectionRepo` in `repoOverrides`
    - Capture `changedNodeRefs` from `commitSettlement()` return value (new return type from T5)
    - Create `PgRelationWriteRepo(txSql)` for use by T10 (relation intent materialization)
    - Create `PgEpisodeRepo(txSql)` for read-back (building ResolvedLocalRefs)
    - Store all tx-scoped repos and the returned `changedNodeRefs` for downstream steps (T9, T10, T11)
  - Add post-transaction placeholder comments marking where T9/T10/T11/T13 will add logic:
    ```
    // [T9] CoreMemoryIndexUpdater trigger (outside tx)
    // [T13] enqueueOrganizerJobs (outside tx)
    ```

  **Must NOT do**:
  - Do NOT implement relation intent materialization here — that's T10
  - Do NOT implement conflict factor resolution here — that's T11
  - Do NOT implement CoreMemoryIndexUpdater trigger here — that's T9
  - Do NOT implement organizer enqueue here — that's T13
  - Do NOT add LLM calls inside the `sql.begin()` block

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Central integration point — modifies the Thinker worker transaction to prepare for all subsequent tasks; must understand the full Phase 2 pipeline architecture
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `git-master`: Not needed

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential after T5)
  - **Blocks**: T9, T10, T11, T13, T14 (all downstream Thinker worker additions)
  - **Blocked By**: T5 (needs commitSettlement return type change)

  **References**:

  **Pattern References**:
  - `src/runtime/thinker-worker.ts:267-280` — Current `sql.begin()` block: 5 repo overrides → commitSettlement. This is the EXACT code to expand.
  - `src/runtime/thinker-worker.ts:43-50` — Current `ThinkerWorkerDeps` interface to extend
  - `src/memory/explicit-settlement-processor.ts:168-206` — Sync path pipeline sequence for REFERENCE of what the expanded Thinker transaction should eventually achieve

  **API/Type References**:
  - `src/storage/domain-repos/pg/cognition-search-repo.ts` — `PgCognitionSearchRepo` for tx-scoped search repo creation pattern
  - `src/storage/domain-repos/contracts/search-projection-repo.ts` — SearchProjectionRepo contract
  - `src/storage/domain-repos/pg/relation-write-repo.ts` — `PgRelationWriteRepo` constructor takes `txSql`
  - `src/storage/domain-repos/pg/episode-repo.ts` — `PgEpisodeRepo` constructor for read-back

  **Acceptance Criteria**:
  - [ ] `ThinkerWorkerDeps` includes all 6 new optional dependencies
  - [ ] `sql.begin()` creates tx-scoped `PgSearchProjectionRepo`, `PgRelationWriteRepo`, `PgEpisodeRepo`
  - [ ] `commitSettlement()` return value captured as `changedNodeRefs`
  - [ ] `searchProjectionRepo` passed in `repoOverrides`
  - [ ] Placeholder comments mark where T9/T10/T11/T13 will add logic
  - [ ] `bun run build && bun test` passes
  - [ ] Existing Thinker behavior unchanged (new deps are optional)

  **QA Scenarios**:

  ```
  Scenario: Thinker commit now produces search docs
    Tool: Bash (bun test)
    Preconditions: T5 + T6 both complete, PG test database
    Steps:
      1. Run a Thinker worker with PgSearchProjectionRepo wired
      2. Thinker commits settlement with 2 cognition ops
      3. Query: SELECT count(*) FROM search_docs_cognition WHERE settlement_id = $1
      4. Assert: count >= 2
    Expected Result: Search docs exist for Thinker cognition output
    Failure Indicators: count = 0; search_docs_cognition table empty
    Evidence: .sisyphus/evidence/task-6-search-docs.txt

  Scenario: Backward compat — deps not provided
    Tool: Bash (bun test)
    Preconditions: T6 complete
    Steps:
      1. Create ThinkerWorkerDeps with only the original 6 fields (no new optional deps)
      2. Run Thinker worker — should still work normally
      3. No errors thrown for missing optional deps
    Expected Result: Thinker operates identically to Phase 1 when new deps are absent
    Failure Indicators: TypeError for undefined deps; crash on missing optional
    Evidence: .sisyphus/evidence/task-6-backward-compat.txt
  ```

  **Commit**: YES (groups with T7, T8, T9 in C4)
  - Message: `feat(thinker): expand worker deps, prompt, ledger integration, core memory index trigger`
  - Files: `src/runtime/thinker-worker.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 7. Extend Thinker Prompt: `relationIntents` + `conflictFactors` Schema (R-P2-01 + R-P2-02 Prompt)

  **What to do**:
  - Find the Thinker prompt template/instruction that defines the structured output schema for the Thinker LLM call
  - Add `relationIntents` field to the expected output:
    ```
    relationIntents: Array<{ sourceRef: string; targetRef: string; intent: "supports" | "triggered" }>
    ```
    - `sourceRef`: reference to an episode (e.g., `episode:local_ref` or `episode:{key}`)
    - `targetRef`: reference to a cognition assertion (e.g., `cognition:{key}`)
    - `intent`: the causal relationship type
  - Add `conflictFactors` field to the expected output:
    ```
    conflictFactors: Array<{ kind: string; ref: string; note?: string }>
    ```
    - `kind`: type of conflict (e.g., `"contradicts"`, `"supersedes"`)
    - `ref`: reference to the conflicting cognition key
    - `note`: optional human-readable explanation
  - Add prompt instructions explaining WHEN to generate each:
    - `relationIntents`: For every new assertion, generate a `supports`/`triggered` link to the episode that caused it
    - `conflictFactors`: When a new assertion contradicts an existing one (check `existingCognition` context), generate a conflict factor
  - Update the structured output validation/parsing in the Thinker worker to handle these new fields (normalize + validate)
  - The output schema must match `RelationIntent` (rp-turn-contract.ts:87-91) and `ConflictFactor` (rp-turn-contract.ts:93-97)

  **Must NOT do**:
  - Do NOT implement the materialization/landing — that's T10 and T11
  - Do NOT modify the sync-path prompt or `submit_rp_turn` tool

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Prompt engineering for structured output requires careful instruction design; must understand the cognitive model (assertion ↔ episode causality, conflict detection)
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `git-master`: Not needed

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (parallel with T6, T8, T9)
  - **Blocks**: T10 (needs prompt to generate relationIntents), T11 (needs prompt to generate conflictFactors)
  - **Blocked By**: None (prompt is independent of code changes)

  **References**:

  **Pattern References**:
  - Phase 1 Thinker prompt (ref in `.sisyphus/plans/talker-thinker-split.md` T7 step 6) — Current Thinker instructions to extend
  - `src/runtime/thinker-worker.ts` — Find where prompt is assembled (look for system message construction, `ChatMessage[]` building)

  **API/Type References**:
  - `src/runtime/rp-turn-contract.ts:87-91` — `RelationIntent` type: `{ sourceRef, targetRef, intent: 'supports' | 'triggered' }`
  - `src/runtime/rp-turn-contract.ts:93-97` — `ConflictFactor` type: `{ kind, ref, note? }`
  - `src/interaction/contracts.ts:111-112` — `TurnSettlementPayload.relationIntents` and `.conflictFactors` — these fields already exist in the settlement type

  **Test References**:
  - `test/runtime/rp-turn-contract.test.ts` — Existing turn contract tests; add validation tests for new fields
  - `scripts/rp-suspicion-test.ts` — Evaluation framework that can test prompt output quality

  **Acceptance Criteria**:
  - [ ] Thinker prompt includes instructions for `relationIntents` generation
  - [ ] Thinker prompt includes instructions for `conflictFactors` generation
  - [ ] Thinker output parsing handles `relationIntents` and `conflictFactors` fields
  - [ ] Invalid/missing fields handled gracefully (empty array default)
  - [ ] `bun run build` passes

  **QA Scenarios**:

  ```
  Scenario: Thinker output parsing handles new fields
    Tool: Bash (bun test)
    Preconditions: Prompt and parsing updated
    Steps:
      1. Create unit test for Thinker output normalization
      2. Test with output containing valid relationIntents and conflictFactors
      3. Test with output missing both fields (backward compat)
      4. Test with output containing malformed fields (graceful degradation)
    Expected Result: Valid fields parsed correctly; missing fields default to []; malformed fields logged and skipped
    Failure Indicators: Parse error; crash on missing fields; no graceful degradation
    Evidence: .sisyphus/evidence/task-7-parsing.txt

  Scenario: Prompt instruction clarity
    Tool: Bash (grep/read)
    Preconditions: Prompt file modified
    Steps:
      1. Read the Thinker prompt template
      2. Verify `relationIntents` instructions include: when to generate, what sourceRef/targetRef format, what intent values
      3. Verify `conflictFactors` instructions include: when to generate, what kind values, what ref format
    Expected Result: Instructions are unambiguous and reference the correct field types
    Failure Indicators: Vague instructions; missing field descriptions; wrong type names
    Evidence: .sisyphus/evidence/task-7-prompt-review.txt
  ```

  **Commit**: YES (groups with T6, T8, T9 in C4)
  - Message: `feat(thinker): expand worker deps, prompt, ledger integration, core memory index trigger`
  - Files: Thinker prompt template file, `src/runtime/thinker-worker.ts` (parsing)
  - Pre-commit: `bun run build && bun test`

---

- [ ] 8. Integrate Settlement Ledger into Talker + Thinker Flow (R-P2-03 Integration)

  **What to do**:
  - **Talker side**: In `runRpTalkerTurn()` (find in src/runtime), after the settlement transaction commits, call `settlementLedger.markTalkerCommitted(settlementId, agentId)`. This should be a best-effort call — failure to mark the ledger must NOT block the Talker turn.
  - **Thinker side**: In the Thinker worker's `sql.begin()` block:
    - Before `commitSettlement()`: call `deps.settlementLedger?.markThinkerProjecting(settlementId, agentId)` (best-effort)
    - After successful commit: call `deps.settlementLedger?.markApplied(settlementId)` (best-effort)
    - On failure (in catch block): call `deps.settlementLedger?.markFailed(settlementId, error.message, retryable)` (best-effort)
  - All ledger calls must be wrapped in try/catch — ledger failures are logged but do NOT propagate as errors
  - Verify that `SettlementLedger` is available in both Talker and Thinker contexts via dependency injection

  **Must NOT do**:
  - Do NOT make ledger writes part of the settlement transaction — they are observability writes, not data-integrity writes
  - Do NOT require ledger to be present — all calls use optional chaining (`deps.settlementLedger?.`)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Integration across two code paths (Talker + Thinker) with error handling considerations
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (parallel with T6, T7, T9)
  - **Blocks**: T12 (recovery sweeper depends on ledger being populated)
  - **Blocked By**: T3 (needs ledger type extensions and repo methods)

  **References**:

  **Pattern References**:
  - `src/runtime/thinker-worker.ts:267-280` — Thinker worker's `sql.begin()` block — add ledger calls around commitSettlement
  - Find `runRpTalkerTurn` in `src/runtime/` — Talker's settlement commit point for markTalkerCommitted

  **API/Type References**:
  - `src/memory/settlement-ledger.ts:13-23` — `SettlementLedger` interface with new methods from T3
  - `src/storage/domain-repos/pg/settlement-ledger-repo.ts` — `PgSettlementLedgerRepo` implementation

  **Acceptance Criteria**:
  - [ ] Talker calls `markTalkerCommitted()` after settlement commit
  - [ ] Thinker calls `markThinkerProjecting()` before commit, `markApplied()` after success, `markFailed()` on error
  - [ ] All ledger calls are best-effort (try/catch, log on failure)
  - [ ] Thinker works without ledger (optional chaining)
  - [ ] `bun run build && bun test` passes

  **QA Scenarios**:

  ```
  Scenario: Full lifecycle observed in ledger
    Tool: Bash (bun test)
    Preconditions: T3 + T8 complete, PG database
    Steps:
      1. Simulate Talker turn → markTalkerCommitted
      2. Simulate Thinker processing → markThinkerProjecting → commitSettlement → markApplied
      3. Query: SELECT status FROM settlement_processing_ledger WHERE settlement_id = $1
      4. Assert: status = 'applied'
    Expected Result: Ledger shows final 'applied' status
    Failure Indicators: Status still 'talker_committed' or 'thinker_projecting'
    Evidence: .sisyphus/evidence/task-8-lifecycle.txt

  Scenario: Ledger failure does not block Thinker
    Tool: Bash (bun test)
    Preconditions: T8 complete
    Steps:
      1. Provide a mock settlementLedger that throws on markThinkerProjecting
      2. Run Thinker worker — should complete normally
      3. Assert: settlement is committed despite ledger failure
    Expected Result: Thinker completes; error is logged; no propagation
    Failure Indicators: Thinker fails; error propagates
    Evidence: .sisyphus/evidence/task-8-ledger-failure.txt
  ```

  **Commit**: YES (groups with T6, T7, T9 in C4)
  - Message: `feat(thinker): expand worker deps, prompt, ledger integration, core memory index trigger`
  - Files: `src/runtime/thinker-worker.ts`, Talker settlement file
  - Pre-commit: `bun run build && bun test`

- [ ] 9. CoreMemoryIndexUpdater Conditional Trigger in Thinker (R-P2-00 Diff 3)

  **What to do**:
  - In the Thinker worker, AFTER the `sql.begin()` transaction completes (outside the tx), conditionally call `deps.coreMemoryIndexUpdater.updateIndex(agentId, created, CALL_TWO_TOOLS)`
  - **Trigger conditions** (ANY of):
    - `cognitionOps.length >= 3`
    - Any assertion in `cognitionOps` has `stance === "contested"`
  - If conditions not met, skip the update (rely on next sync-path flush)
  - Build `CreatedState` object from the cognitionOps and episode data to pass to `updateIndex()`:
    - `assertionIds`: IDs of assertion cognition ops
    - `episodeEventIds`: IDs of episodes
    - `entityIds`, `factIds`: empty arrays (Thinker doesn't create entities/facts)
    - `changedNodeRefs`: from commitSettlement return (captured in T6)
  - Import `CALL_TWO_TOOLS` constant from `src/memory/task-agent.ts` — or extract it as a shared constant if it's private
  - Wrap in try/catch — CoreMemoryIndex update failure must NOT fail the overall Thinker processing

  **Must NOT do**:
  - Do NOT call updateIndex inside `sql.begin()` — it makes an LLM call which would hold the PG transaction open
  - Do NOT always trigger — only on threshold conditions
  - Do NOT modify `CoreMemoryIndexUpdater` class itself

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Involves LLM call orchestration, conditional logic, and correct `CreatedState` construction
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (parallel with T7, T8)
  - **Blocks**: T14 (integration tests)
  - **Blocked By**: T6 (needs expanded ThinkerWorkerDeps + changedNodeRefs from transaction)

  **References**:

  **Pattern References**:
  - `src/memory/task-agent.ts:637` — Sync-path call: `await this.coreMemoryIndexUpdater.updateIndex(flushRequest.agentId, created, CALL_TWO_TOOLS)` — exact pattern to follow
  - `src/memory/task-agent.ts:467-472` — `CreatedState` type: `{ episodeEventIds, assertionIds, entityIds, factIds, changedNodeRefs }`

  **API/Type References**:
  - `src/memory/core-memory-index-updater.ts:15-46` — `CoreMemoryIndexUpdater.updateIndex()` signature and implementation
  - `src/memory/task-agent.ts` — `CALL_TWO_TOOLS` constant definition, `CreatedState` type

  **Acceptance Criteria**:
  - [ ] CoreMemoryIndexUpdater triggered when cognitionOps ≥ 3
  - [ ] CoreMemoryIndexUpdater triggered when any assertion has `stance === "contested"`
  - [ ] CoreMemoryIndexUpdater NOT triggered when conditions unmet
  - [ ] Call is OUTSIDE `sql.begin()` transaction
  - [ ] Failure is caught and logged, does not propagate
  - [ ] `bun run build && bun test` passes

  **QA Scenarios**:

  ```
  Scenario: Index updated on threshold
    Tool: Bash (bun test)
    Preconditions: T6 + T9 complete
    Steps:
      1. Run Thinker with 4 cognition ops (above threshold)
      2. Mock CoreMemoryIndexUpdater.updateIndex to track calls
      3. Assert: updateIndex called exactly once
    Expected Result: updateIndex invoked with correct CreatedState
    Failure Indicators: Not called; called with wrong params; called inside tx
    Evidence: .sisyphus/evidence/task-9-index-trigger.txt

  Scenario: Index NOT updated below threshold
    Tool: Bash (bun test)
    Preconditions: T6 + T9 complete
    Steps:
      1. Run Thinker with 1 cognition op (below threshold, no contested)
      2. Mock CoreMemoryIndexUpdater.updateIndex to track calls
      3. Assert: updateIndex NOT called
    Expected Result: updateIndex not invoked
    Failure Indicators: updateIndex called when conditions unmet
    Evidence: .sisyphus/evidence/task-9-no-trigger.txt
  ```

  **Commit**: YES (groups with T6, T7, T8 in C4)
  - Message: `feat(thinker): expand worker deps, prompt, ledger integration, core memory index trigger`
  - Files: `src/runtime/thinker-worker.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 10. Relation Intent Materialization in Thinker Worker (R-P2-01 Landing)

  **What to do**:
  - After `commitSettlement()` returns inside the Thinker's `sql.begin()` block, build `ResolvedLocalRefs`:
    1. Read back committed episodes: `await txEpisodeRepo.readBySettlement(settlementId, agentId)` → map to `localRefIndex`
    2. Read back committed cognition projections: use `txCognitionProjectionRepo` to get cognitionByKey map
    3. Construct `ResolvedLocalRefs = { settlementId, agentId, localRefIndex, cognitionByKey }`
  - Extract `relationIntents` from the Thinker's parsed output (from T7's prompt extension)
  - Call `materializeRelationIntents(intents, resolvedRefs, txRelationWriteRepo)` (already exported from `relation-intent-resolver.ts`)
  - Handle empty intents gracefully: if `relationIntents` is empty/undefined, skip materialization
  - Log: `[thinker_worker] materialized ${count} relation intents for settlement ${settlementId}`

  **Must NOT do**:
  - Do NOT call `materializeRelationIntents` outside the `sql.begin()` — refs must be resolved within same transaction
  - Do NOT modify `materializeRelationIntents()` function itself
  - Do NOT build refs manually — use the DB read-back pattern from `ExplicitSettlementProcessor.buildSettledArtifacts()`

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Must correctly build ResolvedLocalRefs via DB read-back; ref resolution is the trickiest part of this task
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (parallel with T11, T12)
  - **Blocks**: T13 (controlled flush), T14 (integration tests)
  - **Blocked By**: T6 (needs expanded transaction with tx-scoped repos), T7 (needs prompt to generate relationIntents)

  **References**:

  **Pattern References**:
  - `src/memory/explicit-settlement-processor.ts:344-389` — `buildSettledArtifacts()` — THE reference for building `ResolvedLocalRefs`. Shows: `episodeRepo.readBySettlement()` → episode nodeRefs, `episodeRepo.readPublicationsBySettlement()` → pub nodeRefs, then builds `localRefIndex`
  - `src/memory/explicit-settlement-processor.ts:168-206` — Full pipeline sequence showing where `materializeRelationIntents` fits (step 13)

  **API/Type References**:
  - `src/memory/cognition/relation-intent-resolver.ts:192-222` — `materializeRelationIntents()` function: takes `(intents, resolvedRefs, relationWriteRepo)` → returns written count
  - `src/memory/cognition/relation-intent-resolver.ts:1-30` — `ResolvedLocalRefs` type definition: `{ settlementId, agentId, localRefIndex: Map, cognitionByKey: Map }`
  - `src/runtime/rp-turn-contract.ts:87-91` — `RelationIntent` type: `{ sourceRef, targetRef, intent }`
  - `src/storage/domain-repos/pg/episode-repo.ts` — `PgEpisodeRepo.readBySettlement()` for episode read-back

  **Test References**:
  - `test/memory/relation-intent-resolver-pg.test.ts` — Existing relation intent tests, verify no regression
  - `test/pg-app/pg-relation-write-repo.test.ts` — Relation write repo tests

  **Acceptance Criteria**:
  - [ ] Thinker worker builds `ResolvedLocalRefs` from DB read-back after commitSettlement
  - [ ] `materializeRelationIntents()` called with Thinker-generated intents
  - [ ] `memory_relations` table contains new `supports`/`triggered` records after Thinker commit
  - [ ] Empty relationIntents → no error, no relations written
  - [ ] `bun run build && bun test` passes

  **QA Scenarios**:

  ```
  Scenario: Relation intents materialized
    Tool: Bash (bun test)
    Preconditions: T6 + T7 + T10 complete, PG database
    Steps:
      1. Run Thinker with output containing 2 relationIntents (1 supports, 1 triggered)
      2. Query: SELECT relation_type, count(*) FROM memory_relations WHERE source_ref = $settlementId GROUP BY relation_type
      3. Assert: 1 row with 'supports', 1 row with 'triggered'
    Expected Result: Both relation types exist in memory_relations
    Failure Indicators: No rows; wrong relation types; ref resolution failure
    Evidence: .sisyphus/evidence/task-10-relation-intents.txt

  Scenario: Empty intents handled gracefully
    Tool: Bash (bun test)
    Preconditions: T10 complete
    Steps:
      1. Run Thinker with output where relationIntents = []
      2. Assert: no error thrown
      3. Assert: no new rows in memory_relations for this settlement
    Expected Result: Clean skip, no side effects
    Failure Indicators: Error on empty array; unexpected rows written
    Evidence: .sisyphus/evidence/task-10-empty-intents.txt
  ```

  **Commit**: YES (groups with T11 in C5)
  - Message: `feat(thinker): restore relationIntents + conflictFactors materialization`
  - Files: `src/runtime/thinker-worker.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 11. Conflict Factor Resolution + Application in Thinker Worker (R-P2-02 Landing)

  **What to do**:
  - After `materializeRelationIntents()` (T10) inside the Thinker's `sql.begin()` block:
    1. Extract `conflictFactors` from Thinker's parsed output
    2. Call `resolveConflictFactors(factors, txCognitionProjectionRepo, { settlementId })` — already exported from `relation-intent-resolver.ts:224-268`
    3. Identify contested assertions from cognitionOps: filter for `stance === "contested"`, build `Array<{ cognitionKey, nodeRef }>`
    4. Call the extracted `applyContestConflictFactors(txRelationBuilder, txCognitionProjectionRepo, agentId, settlementId, contestedAssertions, resolvedFactorNodeRefs, unresolvedCount)` — from T2's extraction
  - Handle empty conflictFactors gracefully: if empty/undefined, skip both resolve and apply
  - Construct `RelationBuilder` instance within the transaction: needs `PgRelationWriteRepo(txSql)`, `PgRelationReadRepo(txSql)`, `PgCognitionProjectionRepo(txSql)` — check `RelationBuilder` constructor deps
  - Log: `[thinker_worker] resolved ${resolved.length} conflict factors (${unresolved.length} unresolved) for settlement ${settlementId}`

  **Must NOT do**:
  - Do NOT modify `resolveConflictFactors()` or the extracted `applyContestConflictFactors()`
  - Do NOT call outside the transaction — factor refs must resolve against just-committed data

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Must correctly wire RelationBuilder + handle contested assertion detection + chain resolve → apply sequence
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (parallel with T10, T12)
  - **Blocks**: T13 (controlled flush), T14 (integration tests)
  - **Blocked By**: T2 (needs extracted applyContestConflictFactors), T6 (needs expanded transaction), T7 (needs prompt for conflictFactors)

  **References**:

  **Pattern References**:
  - `src/memory/explicit-settlement-processor.ts:188-206` — Sync path sequence: `resolveConflictFactors()` → `applyContestConflictFactors()` — follow this EXACT order
  - `src/memory/cognition/relation-builder.ts` — `RelationBuilder` constructor — check required deps for instantiation within tx

  **API/Type References**:
  - `src/memory/cognition/relation-intent-resolver.ts:224-268` — `resolveConflictFactors()` signature and return type
  - `src/memory/cognition/contest-conflict-applicator.ts` — Extracted `applyContestConflictFactors()` from T2
  - `src/runtime/rp-turn-contract.ts:93-97` — `ConflictFactor` type: `{ kind, ref, note? }`
  - `src/memory/cognition/relation-builder.ts:81` — `RelationBuilder.writeContestRelations()` signature

  **Acceptance Criteria**:
  - [ ] `resolveConflictFactors()` called with Thinker-generated factors
  - [ ] `applyContestConflictFactors()` called for contested assertions
  - [ ] `memory_relations` contains `conflicts_with` records when contested assertion exists
  - [ ] `cognition_projections` conflict metadata updated
  - [ ] Empty conflictFactors → no error, no conflict writes
  - [ ] `bun run build && bun test` passes

  **QA Scenarios**:

  ```
  Scenario: Conflict factors resolved and applied
    Tool: Bash (bun test)
    Preconditions: T2 + T6 + T7 + T11 complete, PG database
    Steps:
      1. Run Thinker with output containing 1 contested assertion and 2 conflictFactors
      2. Query: SELECT count(*) FROM memory_relations WHERE relation_type = 'conflicts_with' AND source_ref = $settlementId
      3. Assert: count > 0
      4. Query: SELECT conflict_summary FROM cognition_projections WHERE cognition_key = $contestedKey
      5. Assert: conflict_summary is not null, contains factor count
    Expected Result: Conflict relations exist; projection metadata updated
    Failure Indicators: No conflicts_with rows; null conflict_summary; ref resolution failure
    Evidence: .sisyphus/evidence/task-11-conflict-factors.txt

  Scenario: No contested assertions — skip gracefully
    Tool: Bash (bun test)
    Preconditions: T11 complete
    Steps:
      1. Run Thinker with output where conflictFactors exists but no assertion has stance="contested"
      2. Assert: resolveConflictFactors NOT called (or called but returns empty)
      3. Assert: applyContestConflictFactors NOT called
    Expected Result: No conflict processing when no contested assertions
    Failure Indicators: Unnecessary conflict processing; unexpected writes
    Evidence: .sisyphus/evidence/task-11-no-contest.txt
  ```

  **Commit**: YES (groups with T10 in C5)
  - Message: `feat(thinker): restore relationIntents + conflictFactors materialization`
  - Files: `src/runtime/thinker-worker.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 12. Recovery Sweeper: `sweepThinkerJobs` in PendingSettlementSweeper (R-P2-04)

  **What to do**:
  - Add `sweepThinkerJobs()` method to `PendingSettlementSweeper` (src/memory/pending-settlement-sweeper.ts)
  - **Execution frequency**: Run within the existing `runSweep()` tick but on a separate interval. Add `thinkerRecoveryIntervalMs` option (default: 5 * 60_000 = 5 minutes). Use internal counter/timestamp to skip intermediate ticks.

  **Detection logic — DUAL-PATH (version gap is primary, ledger is supplementary)**:

  The version gap signal (`talker_turn_counter > thinker_committed_version` in `recent_cognition_slots`) is written as part of the Talker's core settlement transaction — it is always reliable. The ledger signal (`talker_committed` status) is written best-effort by T8 — it may be absent if `markTalkerCommitted()` failed. Therefore:

  1. **Primary detection**: Query `recent_cognition_slots` for sessions where `talker_turn_counter > thinker_committed_version` (version gap exists). This is the ground truth and is ALWAYS available.
  2. **Settlement identification**: For each gapped session/agent pair, query `interaction_records` for `turn_settlement` records with `talkerTurnVersion` values in the gap range (between `thinker_committed_version + 1` and `talker_turn_counter`). These records are written in the Talker's core transaction — always reliable.
  3. **Job existence check**: For each identified settlement, query `jobs_current` for existing `cognition.thinker` job (via `payload_json->>'settlementId'` match). If a pending/running job exists → skip (already being handled).
  4. **Lost enqueue confirmed**: If no pending/running job exists → re-enqueue.

  The ledger (when available) provides supplementary context: if a `talker_committed` entry exists for this settlement, the sweeper can update it to `thinker_projecting` upon re-enqueue. But ledger absence does NOT block recovery — the version gap + interaction_records path is self-sufficient.

  - **Compensation**: Re-enqueue `cognition.thinker` job using `CognitionThinkerJobPayload` from `durable-store.ts:49-54`. Read `talkerTurnVersion` from `TurnSettlementPayload` in the interaction record (already exists at contracts.ts:129). Use idempotent enqueue: `ON CONFLICT (job_key) DO NOTHING` so duplicate re-enqueues are safe.

  **Retry tracking — persistent only, NO in-memory state**:

  ⚠️ `trySweepLock()` in `PgPendingFlushRecoveryRepo` returns `true` unconditionally (line 155-157) — it is NOT a real distributed lock. In-memory retry maps would be unreliable across restarts and multiple instances.

  Instead, use the version gap itself as the persistent retry signal:
  - The sweeper re-scans every 5 minutes. If the version gap still exists and no job exists → re-enqueue again. This is inherently persistent — the gap is the state.
  - To track escalation (how long a gap has persisted without resolution), add a `first_detected_at BIGINT` column to `settlement_processing_ledger` (set on first `markTalkerCommitted()`) or compute from the settlement's `created_at` in `interaction_records`.
  - **Hard-fail escalation**: If a settlement's gap has persisted for > `hardFailThresholdMs` (default: 30 minutes = 6 sweep cycles), log a CRITICAL error and (if ledger entry exists) mark it `failed_terminal`. The Thinker's version-based idempotency (`thinkerCommittedVersion >= talkerTurnVersion`) ensures re-enqueue is always safe regardless of retry count.

  **DO NOT use**:
  - ❌ `PendingFlushRecoveryRepo` — wrong granularity (session-level unique index, `ON CONFLICT (session_id) DO NOTHING`)
  - ❌ In-memory retry maps — lost on restart, `trySweepLock()` is a no-op so no distributed coordination
  - ❌ Ledger-only detection — `markTalkerCommitted()` is best-effort; ledger entry may be absent

  - **Safety**: Thinker's version-based idempotency check (`thinkerCommittedVersion >= talkerTurnVersion`) ensures duplicate enqueue is safe
  - Write tests: simulate lost enqueue → verify sweeper detects via version gap and re-enqueues within interval

  **Must NOT do**:
  - Do NOT create a new sweeper class — extend the existing `PendingSettlementSweeper`
  - Do NOT modify the existing `sweepPendingSettlements()` logic
  - **Do NOT use `PendingFlushRecoveryRepo`** — wrong granularity (session, not settlement)
  - **Do NOT use in-memory retry maps** — `trySweepLock()` is a no-op (`return true`), no real distributed lock, state lost on restart
  - **Do NOT rely solely on ledger for detection** — `markTalkerCommitted()` is best-effort; use version gap as primary signal
  - Do NOT assume a specific PG table name — verify from `src/jobs/pg-schema.ts`

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex detection SQL + recovery state machine + distributed system safety concerns
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (parallel with T10, T11)
  - **Blocks**: T14 (integration tests)
  - **Blocked By**: T8 (needs ledger integration to populate `talker_committed` states)

  **References**:

  **Pattern References**:
  - `src/memory/pending-settlement-sweeper.ts:36-120` — Existing sweeper: 30s interval, `tryAcquireSweepGuard()` lock, `runSweep()` method, exponential backoff. Follow same structure for Thinker recovery.
  - `src/memory/pending-settlement-sweeper.ts:8-15` — Constants: `PERIODIC_INTERVAL_MS`, `TRANSIENT_BASE_BACKOFF_MS`, etc. Add analogous constants for Thinker recovery.

  **API/Type References**:
  - `src/jobs/durable-store.ts:49-54` — `CognitionThinkerJobPayload`: `{ sessionId, agentId, settlementId, talkerTurnVersion }`
  - `src/interaction/contracts.ts:94-130` — `TurnSettlementPayload` — contains `talkerTurnVersion` (line 129) and `settlementId` (line 95) for re-enqueue payload construction
  - `src/jobs/pg-schema.ts` — Verify actual table name for `jobs_current` queries
  - `src/memory/settlement-ledger.ts` — `SettlementLedger` interface — supplementary signal only (not primary detection)

  **Anti-Reference (DO NOT USE)**:
  - `src/storage/domain-repos/pg/pending-flush-recovery-repo.ts` — **WRONG granularity**: session-level unique index, `ON CONFLICT (session_id) DO NOTHING`. Cannot track multiple lost settlements per session.
  - `src/storage/domain-repos/pg/pending-flush-recovery-repo.ts:155-157` — `trySweepLock()` returns `true` unconditionally — NOT a real distributed lock. Proves in-memory state is unreliable in multi-instance scenarios.

  **Test References**:
  - `test/pg-app/pg-settlement-ledger.test.ts` — Ledger query patterns
  - `test/memory/pending-settlement-sweeper.test.ts` — If exists, follow sweep testing pattern

  **Acceptance Criteria**:
  - [ ] `sweepThinkerJobs()` method exists on `PendingSettlementSweeper`
  - [ ] Runs on configurable interval (default 5 min) within existing tick
  - [ ] **Primary detection**: version gap in `recent_cognition_slots` (talker_turn_counter > thinker_committed_version)
  - [ ] **Settlement identification**: via `interaction_records` query (NOT ledger-only)
  - [ ] Correctly identifies missing jobs via `jobs_current` query
  - [ ] Re-enqueues with correct `CognitionThinkerJobPayload` (idempotent via `ON CONFLICT DO NOTHING`)
  - [ ] Does NOT use PendingFlushRecoveryRepo, does NOT use in-memory retry maps
  - [ ] Works even when `markTalkerCommitted()` failed (ledger entry absent)
  - [ ] Handles multiple lost settlements per session independently
  - [ ] Hard-fail escalation after threshold (log CRITICAL, mark ledger if entry exists)
  - [ ] `bun run build && bun test` passes

  **QA Scenarios**:

  ```
  Scenario: Lost enqueue detected and recovered
    Tool: Bash (bun test)
    Preconditions: PG database, T3 + T8 + T12 complete
    Steps:
      1. Create a session with talker_turn_counter=5, thinker_committed_version=3
      2. Insert settlement records for turns 4 and 5 (with talkerTurnVersion in payload)
      3. Do NOT enqueue cognition.thinker jobs for these settlements
      4. Run sweepThinkerJobs()
      5. Query jobs_current for new cognition.thinker jobs
      6. Assert: 2 new pending jobs with correct settlementIds and talkerTurnVersions
    Expected Result: Sweeper detects gap and re-enqueues both missing jobs
    Failure Indicators: No new jobs; wrong payload; only 1 of 2 recovered
    Evidence: .sisyphus/evidence/task-12-recovery.txt

  Scenario: Already-pending job not re-enqueued
    Tool: Bash (bun test)
    Preconditions: PG database
    Steps:
      1. Create version gap scenario
      2. Enqueue a cognition.thinker job for one of the settlements (pending status)
      3. Run sweepThinkerJobs()
      4. Assert: only the settlement WITHOUT an existing job gets re-enqueued
    Expected Result: No duplicate enqueue for already-pending job
    Failure Indicators: Duplicate job created; existing job overwritten
    Evidence: .sisyphus/evidence/task-12-no-duplicate.txt
  ```

  **Commit**: YES (standalone C6)
  - Message: `feat(recovery): extend sweeper with thinker job recovery`
  - Files: `src/memory/pending-settlement-sweeper.ts`, test file
  - Pre-commit: `bun run build && bun test`

---

- [ ] 13. Thinker Controlled Flush: Enqueue `memory.organize` After Settlement (R-P2-05)

  **What to do**:
  - In the Thinker worker, AFTER the `sql.begin()` transaction completes (outside the tx), enqueue `memory.organize` jobs:

    **⚠️ TRIGGER CONDITION (CORRECTED)**: Based on `changedNodeRefs.length > 0`, NOT on episode/publication presence. `GraphOrganizer.parseNodeRef()` (graph-organizer.ts:100-107) supports `assertion`, `evaluation`, `commitment`, `event`, `entity`, `fact` node kinds. Thinker frequently produces cognition-only output (assertions/evaluations/commitments without episodes). Using episodes/publications as the trigger would miss the majority case and leave cognition nodes without embeddings/semantic edges/scores.

    **⚠️ NO FREQUENCY LIMITING VIA SKIP (CORRECTED)**: Do NOT implement "skip if pending organize job exists" — this permanently drops the current settlement's `changedNodeRefs`. `GraphOrganizer.run()` (graph-organizer.ts:29-30) ONLY processes refs explicitly in `job.changedNodeRefs`; there is no compensation channel. Skipped refs = permanently unorganized nodes.

    Steps:
    1. Check `changedNodeRefs.length > 0` (from `commitSettlement()` return via T6)
    2. Call extracted `enqueueOrganizerJobs()` from T1: `enqueueOrganizerJobs(deps.jobPersistence, agentId, settlementId, changedNodeRefs)`
    3. Each settlement gets its own organize job(s) with its own refs — this is correct because refs are job-local
    4. The existing `ORGANIZER_CHUNK_SIZE=50` and per-kind concurrency cap (`memory.organize:global: 2`) provide natural throttling

  - Wrap in try/catch — enqueue failure must NOT fail the Thinker processing
  - Log: `[thinker_worker] enqueued ${chunkCount} memory.organize jobs (${changedNodeRefs.length} refs) for settlement ${settlementId}`

  **Must NOT do**:
  - Do NOT call `flushIfDue()` — only enqueue organize jobs
  - Do NOT enqueue `memory.migrate` jobs
  - Do NOT enqueue inside `sql.begin()` — must be outside the transaction
  - Do NOT skip enqueue based on existing pending jobs — refs are job-local and would be permanently lost
  - Do NOT use episode/publication count as trigger — use `changedNodeRefs.length > 0` (includes cognition node refs)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Conditional job enqueue with frequency limiting and post-transaction placement
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (sequential — needs T10/T11 materialization to populate changedNodeRefs)
  - **Blocks**: T14 (integration tests)
  - **Blocked By**: T1 (extracted enqueueOrganizerJobs), T6 (changedNodeRefs from transaction), T10 + T11 (materialization populates refs)

  **References**:

  **Pattern References**:
  - `src/memory/organize-enqueue.ts` — Extracted `enqueueOrganizerJobs()` from T1 — the function to call
  - `src/memory/task-agent.ts:648-654` — How MemoryTaskAgent handles enqueue failure: try/catch + `strictDurableMode` check. Follow same pattern.

  **API/Type References**:
  - `src/memory/organize-enqueue.ts` — `enqueueOrganizerJobs(jobPersistence, agentId, settlementId, changedNodeRefs, chunkSize?)` from T1
  - `src/jobs/pg-schema.ts` — Table for `jobs_current` query (frequency limit check)

  **References**:

  **Pattern References**:
  - `src/memory/organize-enqueue.ts` — Extracted `enqueueOrganizerJobs()` from T1 — the function to call
  - `src/memory/task-agent.ts:648-654` — How MemoryTaskAgent handles enqueue failure: try/catch with fallback. Follow try/catch pattern (without strictDurableMode — Thinker always catches).
  - `src/memory/graph-organizer.ts:29-30` — `GraphOrganizer.run()`: takes `job.changedNodeRefs`, deduplicates, processes only those refs. Proves refs are job-local.
  - `src/memory/graph-organizer.ts:100-107` — `parseNodeRef()` supports: event, entity, fact, assertion, evaluation, commitment. Proves cognition nodes ARE supported.

  **API/Type References**:
  - `src/memory/organize-enqueue.ts` — `enqueueOrganizerJobs(jobPersistence, agentId, settlementId, changedNodeRefs, chunkSize?)` from T1

  **Acceptance Criteria**:
  - [ ] Organize jobs enqueued when `changedNodeRefs.length > 0` (regardless of episode/publication presence)
  - [ ] NOT enqueued when changedNodeRefs is empty
  - [ ] Cognition-only Thinker output (assertions without episodes) triggers organize
  - [ ] Each settlement gets its own organize job(s) — no frequency-limit skipping
  - [ ] Enqueue happens OUTSIDE `sql.begin()` transaction
  - [ ] Enqueue failure caught and logged, does not fail Thinker
  - [ ] `bun run build && bun test` passes

  **QA Scenarios**:

  ```
  Scenario: Organize jobs enqueued for cognition-only output
    Tool: Bash (bun test)
    Preconditions: T1 + T6 + T13 complete, PG database
    Steps:
      1. Run Thinker with output containing 3 assertions, 0 episodes, 0 publications
      2. commitSettlement returns changedNodeRefs with 3 assertion refs
      3. Query: SELECT count(*) FROM jobs_current WHERE job_type = 'memory.organize' AND payload_json->>'settlementId' = $1
      4. Assert: count > 0
    Expected Result: memory.organize job(s) enqueued even without episodes/publications
    Failure Indicators: No jobs enqueued for cognition-only output
    Evidence: .sisyphus/evidence/task-13-cognition-only.txt

  Scenario: Each settlement gets its own organize jobs
    Tool: Bash (bun test)
    Preconditions: T13 complete, PG database
    Steps:
      1. Run Thinker for settlement_A → produces changedNodeRefs [ref_1, ref_2]
      2. Run Thinker for settlement_B → produces changedNodeRefs [ref_3]
      3. Query all memory.organize jobs
      4. Assert: jobs exist for BOTH settlements, each with their own refs
    Expected Result: Both settlements' refs are enqueued independently — no ref loss
    Failure Indicators: settlement_B refs missing; only one settlement's jobs exist
    Evidence: .sisyphus/evidence/task-13-no-ref-loss.txt
  ```

  **Commit**: YES (standalone C7)
  - Message: `feat(thinker): add controlled memory.organize enqueue after settlement`
  - Files: `src/runtime/thinker-worker.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 14. Full Thinker Pipeline Integration Tests

  **What to do**:
  - Create `test/runtime/thinker-worker-phase2.test.ts` — comprehensive integration tests for the full Phase 2 Thinker pipeline
  - Test the end-to-end flow: Thinker prompt output → commitSettlement → search sync → changedNodeRefs → relation intent materialization → conflict factor resolution → ledger updates → CoreMemoryIndex trigger → organize enqueue
  - Test scenarios:
    1. **Happy path — full pipeline**: Thinker produces cognition + episodes + relationIntents + conflictFactors → all artifacts land correctly
    2. **Minimal output**: Thinker produces only 1 cognition op, no intents/factors → graceful skip of all optional paths
    3. **Contested assertion with conflict factors**: Thinker produces contested assertion + conflict factors → conflicts_with relations created
    4. **Ledger lifecycle**: talker_committed → thinker_projecting → applied
    5. **Ledger on failure**: thinker_projecting → failed_retryable
    6. **Search sync verification**: After commit, search_docs_cognition has correct rows
    7. **Organize enqueue verification**: After commit with non-empty `changedNodeRefs` (including cognition-only output), memory.organize job exists
    8. **CoreMemoryIndex threshold**: ≥3 ops triggers update; <3 ops does not
  - Follow test structure from `test/memory/explicit-settlement-processor-pg.test.ts` for PG integration
  - Use real PG (docker-compose.jobs-pg.yml) for all DB assertions

  **Must NOT do**:
  - Do NOT skip PG integration tests — in-memory mocks are insufficient for verifying SQL correctness
  - Do NOT duplicate tests already covered by individual task QA scenarios — focus on CROSS-TASK INTEGRATION

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Integration test authoring across multiple subsystems; requires understanding of full pipeline
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (after T13)
  - **Blocks**: T15 (prompt optimization depends on functional pipeline)
  - **Blocked By**: T6-T13 (all Thinker worker changes)

  **References**:

  **Pattern References**:
  - `test/memory/explicit-settlement-processor-pg.test.ts` — Integration test structure: schema setup, repo creation, test data, assertion patterns
  - `test/memory/pg-memory-chain-integration.test.ts` — Multi-step pipeline test pattern
  - `test/pg-app/pg-settlement-uow.test.ts` — Transaction-aware PG tests with `withTestAppSchema`

  **Test References**:
  - `test/pg-app/pg-settlement-ledger.test.ts` — Ledger assertion patterns
  - `test/pg-app/pg-relation-write-repo.test.ts` — Relation assertion patterns
  - `test/memory/cognition-repo-pg.test.ts` — Cognition assertion patterns

  **Acceptance Criteria**:
  - [ ] `test/runtime/thinker-worker-phase2.test.ts` exists with ≥8 test cases
  - [ ] All test cases pass: `bun test test/runtime/thinker-worker-phase2.test.ts`
  - [ ] Tests cover: search sync, changedNodeRefs, relation intents, conflict factors, ledger, index trigger, organize enqueue
  - [ ] Tests use real PG, not mocks

  **QA Scenarios**:

  ```
  Scenario: Full integration test suite passes
    Tool: Bash (bun test)
    Preconditions: All T6-T13 complete, PG docker running
    Steps:
      1. Run `bun test test/runtime/thinker-worker-phase2.test.ts`
      2. Assert: all test cases pass
    Expected Result: ≥8 tests pass, 0 failures
    Failure Indicators: Any test failure; timeout; PG connection error
    Evidence: .sisyphus/evidence/task-14-integration-tests.txt

  Scenario: Full regression suite passes
    Tool: Bash (bun test)
    Preconditions: All changes complete
    Steps:
      1. Run `bun run build && bun test`
      2. Assert: zero failures across entire test suite
    Expected Result: All existing + new tests pass
    Failure Indicators: Any regression in existing tests
    Evidence: .sisyphus/evidence/task-14-regression.txt
  ```

  **Commit**: YES (standalone C8)
  - Message: `test(thinker): add full pipeline integration tests`
  - Files: `test/runtime/thinker-worker-phase2.test.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 15. Prompt Quality Evaluation Baseline + Initial Iteration (R-P2-07)

  **What to do**:
  - **Baseline evaluation**:
    1. Create `scripts/thinker-quality-eval.ts` — automated evaluation script
    2. Define automated proxy metrics (NOT human blind evaluation):
       - **Cognition op count parity**: Thinker vs sync path — ratio of assertion/evaluation/commitment counts
       - **Stance distribution similarity**: Compare stance distributions (confident/tentative/contested) between modes
       - **Conflict detection rate**: Number of `contested` assertions / total assertions — compare between modes
       - **Assertion-to-episode ratio**: Cognition ops per episode — measure cognitive density
       - **Relation intent coverage**: Percentage of episodes with at least one `supports`/`triggered` relation
       - **Sketch utilization**: Does Thinker output reference concepts from cognitiveSketch? (keyword overlap metric)
    3. Run 10 rounds of sync vs async comparison, producing JSON output with per-metric scores
    4. Establish baseline numbers

  - **Initial prompt iteration**:
    1. Based on baseline metrics, identify the weakest metric(s)
    2. Adjust Thinker prompt to address specific weaknesses:
       - If low conflict detection: add explicit "check for contradictions with existing beliefs" instruction
       - If low sketch utilization: add "incorporate reasoning from cognitiveSketch" emphasis
       - If low relation intent coverage: add "for every new assertion, identify its causal episode" instruction
    3. Re-run evaluation after iteration 1, compare to baseline

  - Use existing `scripts/rp-suspicion-test.ts` as reference for evaluation framework patterns

  **Must NOT do**:
  - Do NOT require human evaluation as acceptance criteria — all metrics must be automated
  - Do NOT modify Talker prompt or sync-path prompt
  - Do NOT target 100% parity — ≤15% gap is the acceptance target per requirements doc

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Prompt engineering + evaluation framework design + metric analysis — requires understanding of the cognitive model
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 5 (after all functional tasks complete)
  - **Blocks**: None
  - **Blocked By**: All tasks T1-T14 (needs full functional pipeline)

  **References**:

  **Pattern References**:
  - `scripts/rp-suspicion-test.ts` — Existing evaluation framework: test runner pattern, metric collection, output format
  - Phase 1 Thinker prompt — Current prompt to iterate on

  **API/Type References**:
  - `src/storage/pg-app-schema-ops.ts` — `private_cognition_current` — cognition output for comparison
  - `src/runtime/rp-turn-contract.ts` — Turn outcome types for metric extraction

  **Acceptance Criteria**:
  - [ ] `scripts/thinker-quality-eval.ts` exists with ≥6 automated metrics
  - [ ] Baseline evaluation produces JSON output with per-metric scores
  - [ ] At least 1 prompt iteration completed
  - [ ] Post-iteration metrics show improvement in targeted area(s)
  - [ ] `bun run build` passes (script compiles)

  **QA Scenarios**:

  ```
  Scenario: Evaluation script produces metrics
    Tool: Bash
    Preconditions: Full pipeline functional, test PG database with data
    Steps:
      1. Run `bun run scripts/thinker-quality-eval.ts --rounds 3 --output json`
      2. Parse JSON output
      3. Assert: output contains all 6 metric keys
      4. Assert: each metric has numeric value between 0 and 1
    Expected Result: Valid JSON with all metrics populated
    Failure Indicators: Script crashes; missing metrics; non-numeric values
    Evidence: .sisyphus/evidence/task-15-baseline.json

  Scenario: Post-iteration improvement
    Tool: Bash
    Preconditions: Prompt iteration applied
    Steps:
      1. Run evaluation with baseline prompt → capture metrics_v0
      2. Apply iteration 1 prompt changes
      3. Run evaluation again → capture metrics_v1
      4. Assert: at least one metric improved by > 5%
    Expected Result: Measurable improvement in targeted metric(s)
    Failure Indicators: All metrics unchanged or regressed
    Evidence: .sisyphus/evidence/task-15-iteration1.json
  ```

  **Commit**: YES (standalone C9)
  - Message: `feat(thinker): add prompt quality evaluation baseline`
  - Files: `scripts/thinker-quality-eval.ts`, Thinker prompt file
  - Pre-commit: `bun run build`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, grep for code patterns, check DB schema). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod (warn-level is ok), commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp). Verify extracted functions maintain original behavior.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration: Thinker commit → search sync → organize enqueue → ledger state → relation materialization → conflict detection. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT Have" compliance. Detect cross-task contamination. Verify sync-path tests pass unchanged. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Sync Path [PASS/FAIL] | VERDICT`

---

## Commit Strategy

| Commit | Scope | Tasks | Message | Pre-commit |
|--------|-------|-------|---------|------------|
| C1 | projection | T1, T5 | `feat(projection): add search sync + changedNodeRefs to commitSettlement, extract enqueueOrganizerJobs` | `bun run build && bun test` |
| C2 | settlement | T2, T3 | `feat(settlement): extend ledger with split-mode states, extract applyContestConflictFactors` | `bun run build && bun test` |
| C3 | jobs | T4 | `feat(jobs): add global thinker concurrency cap` | `bun run build && bun test` |
| C4 | thinker | T6, T7, T8, T9 | `feat(thinker): expand worker deps, prompt, ledger integration, core memory index trigger` | `bun run build && bun test` |
| C5 | thinker | T10, T11 | `feat(thinker): restore relationIntents + conflictFactors materialization` | `bun run build && bun test` |
| C6 | recovery | T12 | `feat(recovery): extend sweeper with thinker job recovery` | `bun run build && bun test` |
| C7 | thinker | T13 | `feat(thinker): add controlled memory.organize enqueue after settlement` | `bun run build && bun test` |
| C8 | test | T14 | `test(thinker): add full pipeline integration tests` | `bun run build && bun test` |
| C9 | thinker | T15 | `feat(thinker): add prompt quality evaluation baseline` | `bun run build && bun test` |

---

## Success Criteria

### Verification Commands

```bash
bun run build          # Expected: zero errors
bun test               # Expected: zero failures
```

### Functional Verification (from requirements doc §5)

- [ ] Split mode: `search_docs_cognition` contains new records after Thinker commit (R-P2-00 D1)
- [ ] Split mode: `memory.organize` job enqueued with non-empty `changedNodeRefs` after Thinker commit (R-P2-00 D2)
- [ ] Split mode: `core_memory_blocks` label=`index` `updated_at` refreshed when cognitionOps ≥ 3 (R-P2-00 D3)
- [ ] Split mode: `memory_relations` contains `supports`/`triggered` records (R-P2-01)
- [ ] Split mode: `conflicts_with` records exist when contested assertion present (R-P2-02)
- [ ] `settlement_processing_ledger` tracks Talker/Thinker lifecycle correctly (R-P2-03)
- [ ] Simulated enqueue failure → recovery sweeper re-enqueues within 5 min (R-P2-04)
- [ ] Thinker commit with non-empty `changedNodeRefs` → `memory.organize` job enqueued (R-P2-05)
- [ ] Global Thinker concurrency does not exceed configured cap (R-P2-06)
- [ ] Automated quality metrics baseline established with ≤15% gap target (R-P2-07)

### Regression Verification

- [ ] `--mode sync` behavior identical to Phase 1 completion
- [ ] `--mode async` Talker latency < 25s
- [ ] All existing tests pass unchanged
