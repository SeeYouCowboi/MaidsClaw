# Legacy Cleanup & Server/Worker Orchestration Layer

## TL;DR

> **Quick Summary**: Complete all remaining legacy cleanup (deprecated shims, type narrowing, terminology) then implement the full Server/Worker orchestration layer (R1-R10) — wiring existing job primitives into role-based bootstrap, enabling durable job processing, and converging maintenance scripts to a shared service.
> 
> **Deliverables**:
> - Deprecated `bootstrapApp()` + `AppBootstrapResult` removed (callers migrated/deleted)
> - `RuntimeBootstrapResult` narrowed — internal fields hidden from public API
> - Test gate names modernized, doc terminology updated, `AppClients` alias removed
> - Role-based orchestration bootstrap (`server` starts consumers, `worker` runs jobs)
> - Durable job pipeline: `JobPersistence` injected → consumers wired → lease reclaim sweeper
> - `AppMaintenanceFacade` implemented with real `runOnce()`/`drain()`/`getDrainStatus()`
> - 4 maintenance scripts rewritten as thin shells over shared `MaintenanceOrchestrationService`
> - Admin introspection aware of orchestration enablement state
> 
> **Estimated Effort**: XL
> **Parallel Execution**: YES — 8 waves
> **Critical Path**: T1/T2 → T3 → T8 → T9 → T10/T11 → T15 → T16 → T17-T20 → F1-F4

---

## Context

### Original Request
User provided a comprehensive cleanup checklist covering 12 remaining items + 10 orchestration layer gaps (R1-R10). P0 + P1 items are already complete. The remaining work represents the final systematic bottleneck of the legacy cleanup effort.

### Interview Summary
**Key Discussions**:
- **bootstrapApp callers**: 4 broken RP scripts (referencing deleted `local-runtime.js`) will be DELETED; `start-dev.ts` + 2 test files migrated to `createAppHost()`
- **RuntimeBootstrapResult**: Narrow exported type to hide `db`/`rawDb`/`sessionService`; keep full type for internal composition root
- **Test strategy**: TDD for orchestration layer components
- **Execution order**: Quick cleanup first (Wave 1), then orchestration in dependency order

**Research Findings**:
- All job primitives exist (`JobPersistence`, `PgJobStore`, `JobDispatcher`, `JobScheduler`, `PgJobRunner`) but NONE wired to `bootstrapRuntime()` or `createAppHost()`
- `reclaimExpiredLeases()` implemented in `PgJobStore` but has ZERO production call sites (verified: `grep -rn "reclaimExpiredLeases" src/ --include="*.ts"` shows only definition in `pg-store.ts` and interface in `durable-store.ts`)
- `initializePgBackendForRuntime()` defined at `runtime.ts:594` but has ZERO call sites (verified: `grep -rn "initializePgBackendForRuntime" src/ --include="*.ts"` — only the export definition, no callers)
- `MemoryTaskAgent` has fire-and-forget fallback in durable mode (violates R5)
- Worker role in `createAppHost()` is an empty skeleton
- `AppMaintenanceFacade` methods all throw "not yet implemented"
- Maintenance scripts each do independent bootstrap with manual SQLite/PG branching
- `memory-rebuild-derived.ts` has no PG support; PG path in other scripts bypasses job queue

### Metis Review
**Identified Gaps** (addressed):
- Broken RP scripts (4 files) should be deleted rather than migrated — dead code referencing deleted module
- Worker role needs only programmatic bootstrap, no CLI command in this plan
- `reclaimExpiredLeases` sweep interval: 60s, run by server + maintenance roles
- `AppMaintenanceFacade.runOnce()` should dispatch through job queue for consistency
- `memory-rebuild-derived.ts` PG support comes via shared service, not script-level fix
- Need to verify `PgJobStore` satisfies `JobPersistence` interface or create adapter

---

## Work Objectives

### Core Objective
Eliminate all remaining legacy shims and transition artifacts, then wire existing orchestration primitives into a role-based bootstrap system that enables durable job processing, self-healing lease recovery, and unified maintenance operations.

### Concrete Deliverables
- `src/bootstrap/app-bootstrap.ts` — deleted
- `src/bootstrap/types.ts` — `RuntimeBootstrapResult` narrowed, `AppBootstrapResult` deleted
- `scripts/debug-rp-turn.ts`, `scripts/rp-integration-test.ts`, `scripts/rp-70-turn-test.ts`, `scripts/rp-private-thoughts-test.ts` — deleted
- `scripts/start-dev.ts` — migrated to `createAppHost()`
- `test/cli/acceptance.test.ts`, `test/cli/debug-commands.test.ts` — migrated to `createAppHost()`
- `test/pg-app/phase2a-gate.test.ts`, `phase2b-gate.test.ts`, `phase2c-gate.test.ts` — renamed descriptions
- `src/app/clients/app-clients.ts` — `AppClients` alias removed
- `src/jobs/job-persistence-factory.ts` — backend-neutral factory (new)
- `src/bootstrap/runtime.ts` — `JobPersistence` injected into `GraphStorageService` + `MemoryTaskAgent`
- `src/app/host/create-app-host.ts` — worker role implemented, server durable mode, maintenance facade real
- `src/jobs/lease-reclaim-sweeper.ts` — periodic sweeper (new)
- `src/memory/task-agent.ts` — fire-and-forget fallback removed in durable mode
- `src/app/host/maintenance-orchestration-service.ts` — shared service (new)
- `scripts/search-rebuild.ts`, `memory-replay.ts`, `memory-maintenance.ts`, `memory-rebuild-derived.ts` — thin shells
- `src/app/host/types.ts` — orchestration status types added

### Definition of Done
- [ ] `bun run build` passes (zero type errors)
- [ ] `bun test` passes (all existing + new TDD tests)
- [ ] No imports of `bootstrapApp` or `AppBootstrapResult` remain in codebase
- [ ] No imports of `local-runtime.js` remain in codebase
- [ ] `RuntimeBootstrapResult` no longer exports `db`/`rawDb`/`sessionService`
- [ ] Test gate descriptions contain no "Phase 2A/2B/2C" prefix
- [ ] `AppMaintenanceFacade` methods do not throw "not yet implemented"
- [ ] Worker role bootstrap starts job consumer loop
- [ ] Server durable mode starts job consumer + lease reclaim sweeper
- [ ] All 4 maintenance scripts delegate to `MaintenanceOrchestrationService`

### Must Have
- Zero regression in existing test suite
- TDD for all orchestration components (tests written first)
- Backend-neutral abstractions (SQLite/PG behind single interface)
- Graceful drain semantics in `AppMaintenanceFacade`
- `reclaimExpiredLeases` in a scheduled sweeper (60s interval)
- Strict durable mode flag to disable fire-and-forget fallback

### Must NOT Have (Guardrails)
- NO new `bun:sqlite` direct imports outside `src/storage/` and `src/jobs/persistence.ts`
- NO SQLite-specific logic in `AppMaintenanceFacade` or `MaintenanceOrchestrationService`
- NO fire-and-forget fallback when `strictDurableMode` is enabled
- NO `bootstrapApp()` callers left in codebase after completion
- NO manual DB connection management in maintenance scripts (must use shared service)
- NO new `AppClients` references (only `AppUserFacade`)
- NO "Phase 2A/2B/2C" terminology in test descriptions or documentation
- NO skipping existing sweepers (`PendingSettlementSweeper`, `PublicationRecoverySweeper`) — preserve them

### Explicitly Out of Scope (deferred)
- Docker `docker-compose.jobs-pg.yml` worker service definition — worker uses programmatic bootstrap only in this plan; container definition deferred to deployment planning
- Test file renaming (e.g. `phase2a-gate.test.ts` → `bootstrap-gate.test.ts`) — only internal descriptions are renamed in this plan; file renames are a P2 follow-up to avoid breaking CI/reference chains
- `SqliteBackendFactory` full implementation (`backend-types.ts:62-71` currently throws "not yet implemented") — SQLite bootstrap handled directly in `runtime.ts`

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (`bun test` configured, extensive test suite)
- **Automated tests**: TDD for orchestration components; tests-after for cleanup items
- **Framework**: bun test
- **TDD applies to**: Tasks 8-16 (orchestration layer)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Type safety**: `bun run build` (tsc --noEmit)
- **Tests**: `bun test {relevant-test-file}`
- **Integration**: Verify imports resolve, no circular deps
- **Scripts**: Run script with `--help` or `--dry-run` where applicable

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — quick cleanup, 6 parallel tasks):
├── Task 1: Delete broken RP scripts (4 files) [quick]
├── Task 2: Migrate start-dev.ts + tests to createAppHost() [unspecified-high]
├── Task 4: Narrow RuntimeBootstrapResult exported type [unspecified-high]
├── Task 5: Rename test gate descriptions (3 files) [quick]
├── Task 6: Update doc terminology [quick]
└── Task 7: Remove AppClients deprecated alias [quick]

Wave 1.5 (After T1+T2 — cleanup dependency):
└── Task 3: Delete bootstrapApp() + AppBootstrapResult (depends: 1, 2) [quick]

Wave 2 (After Wave 1 — orchestration foundation, TDD):
├── Task 8: Backend-neutral JobPersistence factory (depends: none) [deep]
└── Task 9: Inject JobPersistence into bootstrapRuntime (depends: 8) [deep]

Wave 3 (After Wave 2 — role-based bootstrap, 3 parallel, TDD):
├── Task 10: Implement worker role in createAppHost (depends: 9) [deep]
├── Task 11: Implement server durable mode in createAppHost (depends: 9) [deep]
└── Task 13: Remove fire-and-forget fallback / strict durable mode (depends: 9) [deep]

Wave 4 (After Wave 3 — self-healing + verification, 2 parallel, TDD):
├── Task 12: Wire reclaimExpiredLeases into sweeper (depends: 10 or 11) [deep]
└── Task 14: Role boundary acceptance tests (depends: 10, 11) [deep]

Wave 5a (After Wave 3 — orchestration service first, TDD):
└── Task 16: Create MaintenanceOrchestrationService (depends: 9) [deep]

Wave 5b (After Wave 5a — facade wires service, TDD):
└── Task 15: Implement AppMaintenanceFacade (depends: 9, 11, 16) [deep]

Wave 6 (After Wave 5b — script convergence, 4 parallel):
├── Task 17: Rewrite search-rebuild.ts as thin shell (depends: 16) [unspecified-high]
├── Task 18: Rewrite memory-replay.ts as thin shell (depends: 16) [unspecified-high]
├── Task 19: Rewrite memory-maintenance.ts as thin shell (depends: 16) [unspecified-high]
└── Task 20: Rewrite memory-rebuild-derived.ts as thin shell (depends: 16) [unspecified-high]

Wave 7 (After Wave 4+5b — observability):
└── Task 21: Orchestration admin introspection (depends: 11, 15) [unspecified-high]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit (subagent_type: oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: T2 → T3 → T8 → T9 → T11 → T16 → T15 → T17-T20 → F1-F4 → user okay
Parallel Speedup: ~65% faster than sequential
Max Concurrent: 6 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| T1 | — | T3 | 1 |
| T2 | — | T3 | 1 |
| T3 | T1, T2 | — | 1.5 |
| T4 | — | — | 1 |
| T5 | — | — | 1 |
| T6 | — | — | 1 |
| T7 | — | — | 1 |
| T8 | — | T9 | 2 |
| T9 | T8 | T10, T11, T13, T15, T16 | 2 |
| T10 | T9 | T12, T14 | 3 |
| T11 | T9 | T12, T14, T15, T21 | 3 |
| T12 | T10 or T11 | — | 4 |
| T13 | T9 | — | 3 |
| T14 | T10, T11 | — | 4 |
| T15 | T9, T11, T16 | T21 | 5b |
| T16 | T9 | T15, T17, T18, T19, T20 | 5a |
| T17 | T16 | — | 6 |
| T18 | T16 | — | 6 |
| T19 | T16 | — | 6 |
| T20 | T16 | — | 6 |
| T21 | T11, T15 | — | 7 |

### Agent Dispatch Summary

| Wave | Tasks | Agents |
|------|-------|--------|
| 1 | 6 | T1→`quick`, T2→`unspecified-high`, T4→`unspecified-high`, T5→`quick`, T6→`quick`, T7→`quick` |
| 1.5 | 1 | T3→`quick` |
| 2 | 2 | T8→`deep`, T9→`deep` |
| 3 | 3 | T10→`deep`, T11→`deep`, T13→`deep` |
| 4 | 2 | T12→`deep`, T14→`deep` |
| 5a | 1 | T16→`deep` |
| 5b | 1 | T15→`deep` |
| 6 | 4 | T17-T20→`quick` |
| 7 | 1 | T21→`unspecified-high` |
| FINAL | 4 | F1→`oracle` (subagent_type), F2→`unspecified-high`, F3→`unspecified-high`, F4→`deep` |

---

## TODOs

- [x] 1. Delete Broken RP Scripts

  **What to do**:
  - Delete the following 4 files that reference the deleted `local-runtime.js` module and have broken type usage:
    - `scripts/debug-rp-turn.ts`
    - `scripts/rp-integration-test.ts`
    - `scripts/rp-70-turn-test.ts`
    - `scripts/rp-private-thoughts-test.ts`
  - Verify no other files import from these scripts
  - Remove any `package.json` script entries that reference them

  **Must NOT do**:
  - Do NOT delete `scripts/start-dev.ts` (still in use, migrated in Task 2)
  - Do NOT delete any maintenance scripts (`search-rebuild.ts`, `memory-replay.ts`, etc.)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple file deletion with minimal verification
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `git-master`: Not needed — just file deletion, no complex git ops

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 4, 5, 6, 7)
  - **Blocks**: Task 3
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `scripts/debug-rp-turn.ts:6` — imports from deleted `../src/terminal-cli/local-runtime.js`
  - `scripts/rp-integration-test.ts:10` — same broken import
  - `scripts/rp-70-turn-test.ts:16` — same broken import
  - `scripts/rp-private-thoughts-test.ts:27` — same broken import

  **WHY Each Reference Matters**:
  - These files are already broken (LSP reports errors on every usage of `AppBootstrapResult` properties and `local-runtime.js` imports). They are dead code.

  **Acceptance Criteria**:
  - [ ] All 4 files deleted from `scripts/`
  - [ ] `bun run build` passes (should improve — these files had type errors)
  - [ ] `grep -r "debug-rp-turn\|rp-integration-test\|rp-70-turn-test\|rp-private-thoughts-test" package.json` returns 0 results

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Scripts directory no longer contains broken files
    Tool: Bash
    Preconditions: Files exist before deletion
    Steps:
      1. Run: ls scripts/debug-rp-turn.ts scripts/rp-integration-test.ts scripts/rp-70-turn-test.ts scripts/rp-private-thoughts-test.ts 2>&1
      2. Assert: All 4 return "No such file or directory"
      3. Run: bun run build
      4. Assert: Exit code 0, no errors referencing deleted files
    Expected Result: All 4 files absent, build passes
    Failure Indicators: Any file still exists, or build fails with reference to deleted file
    Evidence: .sisyphus/evidence/task-1-scripts-deleted.txt

  Scenario: No dangling references to deleted scripts
    Tool: Bash
    Preconditions: Scripts deleted
    Steps:
      1. Run: grep -r "debug-rp-turn\|rp-integration-test\|rp-70-turn-test\|rp-private-thoughts-test" package.json scripts/ src/ test/ 2>/dev/null || echo "CLEAN"
      2. Assert: Output is "CLEAN"
    Expected Result: Zero references remain
    Evidence: .sisyphus/evidence/task-1-no-dangling-refs.txt
  ```

  **Commit**: YES
  - Message: `chore: delete broken RP test scripts referencing deleted local-runtime`
  - Files: `scripts/debug-rp-turn.ts`, `scripts/rp-integration-test.ts`, `scripts/rp-70-turn-test.ts`, `scripts/rp-private-thoughts-test.ts`
  - Pre-commit: `bun run build`

- [x] 2. Migrate start-dev.ts + Tests from bootstrapApp to createAppHost

  **What to do**:
  - Migrate `scripts/start-dev.ts` from `bootstrapApp()` to `createAppHost({ role: "server" })`
    - Replace `bootstrapApp({ enableGateway: true, ... })` with `createAppHost({ role: "server", ... }, runtime)` pattern
    - Use `host.start()` / `host.shutdown()` instead of direct server/shutdown access
  - Migrate `test/cli/acceptance.test.ts` bootstrap calls (lines 772, 835, 865) from `bootstrapApp()` to `createAppHost()`
  - Migrate `test/cli/debug-commands.test.ts` seed functions from `bootstrapApp()` to `createAppHost()`
  - Fix any `local-runtime.js` imports if present in these files
  - Update import statements to use `createAppHost` from `src/app/host/`

  **Must NOT do**:
  - Do NOT change test assertions or test behavior — only the bootstrap mechanism
  - Do NOT refactor test structure beyond what's needed for the migration
  - Do NOT modify `createAppHost()` itself — only consumers

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Requires understanding of both old and new bootstrap APIs, careful migration of 3 files
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 4, 5, 6, 7)
  - **Blocks**: Task 3
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/app/host/create-app-host.ts:64-257` — `createAppHost()` implementation, the target API
  - `src/app/host/types.ts:62-70` — `AppHost` interface with `start()`, `shutdown()`, user/admin facades
  - `src/bootstrap/app-bootstrap.ts:37-135` — current `bootstrapApp()` implementation showing what it delegates to createAppHost internally

  **API/Type References**:
  - `src/app/host/types.ts:7` — `AppRole = "local" | "server" | "worker" | "maintenance"` — use `"server"` for start-dev, `"local"` for tests
  - `src/app/host/types.ts:62-70` — `AppHost` interface shape

  **Files to Modify**:
  - `scripts/start-dev.ts:24` — `bootstrapApp({ enableGateway: true, ... })`
  - `test/cli/acceptance.test.ts:772,835,865` — bootstrap calls
  - `test/cli/debug-commands.test.ts` — seed function bootstrap calls

  **WHY Each Reference Matters**:
  - `create-app-host.ts` is the target API — executor needs to understand its parameters and return type
  - `app-bootstrap.ts` shows how `bootstrapApp` delegates internally — migration should produce equivalent behavior
  - `types.ts` defines the `AppHost` interface that replaces the old `AppBootstrapResult` return

  **Acceptance Criteria**:
  - [ ] `scripts/start-dev.ts` uses `createAppHost()` instead of `bootstrapApp()`
  - [ ] `test/cli/acceptance.test.ts` uses `createAppHost()` instead of `bootstrapApp()`
  - [ ] `test/cli/debug-commands.test.ts` uses `createAppHost()` instead of `bootstrapApp()`
  - [ ] `grep -r "bootstrapApp" scripts/start-dev.ts test/cli/acceptance.test.ts test/cli/debug-commands.test.ts` returns 0 results
  - [ ] `bun run build` passes
  - [ ] `bun test test/cli/acceptance.test.ts` passes
  - [ ] `bun test test/cli/debug-commands.test.ts` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: start-dev.ts migrated and functional
    Tool: Bash
    Preconditions: start-dev.ts rewritten to use createAppHost
    Steps:
      1. Run: grep "bootstrapApp" scripts/start-dev.ts || echo "CLEAN"
      2. Assert: Output is "CLEAN"
      3. Run: grep "createAppHost" scripts/start-dev.ts
      4. Assert: At least one match found
      5. Run: bun run build
      6. Assert: Exit code 0
    Expected Result: No bootstrapApp references, createAppHost used, build passes
    Evidence: .sisyphus/evidence/task-2-start-dev-migrated.txt

  Scenario: Test files migrated and passing
    Tool: Bash
    Preconditions: Test files rewritten
    Steps:
      1. Run: grep -c "bootstrapApp" test/cli/acceptance.test.ts test/cli/debug-commands.test.ts 2>/dev/null
      2. Assert: All counts are 0
      3. Run: bun test test/cli/acceptance.test.ts
      4. Assert: All tests pass
      5. Run: bun test test/cli/debug-commands.test.ts
      6. Assert: All tests pass
    Expected Result: Zero bootstrapApp references, all tests pass
    Evidence: .sisyphus/evidence/task-2-tests-migrated.txt
  ```

  **Commit**: YES (groups with T1)
  - Message: `refactor: migrate start-dev and test files from bootstrapApp to createAppHost`
  - Files: `scripts/start-dev.ts`, `test/cli/acceptance.test.ts`, `test/cli/debug-commands.test.ts`
  - Pre-commit: `bun run build && bun test test/cli/`

- [x] 3. Delete bootstrapApp() Shim + AppBootstrapResult Type

  **What to do**:
  - Delete `src/bootstrap/app-bootstrap.ts` entirely
  - Remove `AppBootstrapResult` type from `src/bootstrap/types.ts` (lines 126-132)
  - Remove `AppBootstrapOptions` type if only used by `bootstrapApp()`
  - There is NO barrel `index.ts` in `src/bootstrap/` — modules import directly from `app-bootstrap.ts` and `types.ts`, so no barrel update needed
  - Verify no remaining imports of `bootstrapApp` or `AppBootstrapResult` anywhere

  **Must NOT do**:
  - Do NOT delete `RuntimeBootstrapResult` — it is still used internally (narrowed in Task 4)
  - Do NOT delete `bootstrapRuntime()` — it is the real bootstrap function
  - Do NOT modify `createAppHost()` — it is the replacement API

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Straightforward deletion after callers migrated
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1.5 (Sequential after T1+T2)
  - **Blocks**: None
  - **Blocked By**: Task 1, Task 2

  **References**:

  **Pattern References**:
  - `src/bootstrap/app-bootstrap.ts` — entire file to delete
  - `src/bootstrap/types.ts:126-132` — `AppBootstrapResult` type definition to delete
  - Note: No barrel `index.ts` exists in `src/bootstrap/` — imports are direct, no barrel update needed

  **WHY Each Reference Matters**:
  - Executor needs to know exact file and line ranges to delete
  - Barrel export must be updated or build will fail with missing export — NOTE: no barrel `index.ts` exists, imports are direct from `app-bootstrap.ts`

  **Acceptance Criteria**:
  - [ ] `src/bootstrap/app-bootstrap.ts` does not exist
  - [ ] `AppBootstrapResult` not in `src/bootstrap/types.ts`
  - [ ] `grep -r "bootstrapApp\|AppBootstrapResult" src/ test/ scripts/` returns 0 results
  - [ ] `bun run build` passes
  - [ ] `bun test` passes (full suite)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: bootstrapApp completely removed from codebase
    Tool: Bash
    Preconditions: Tasks 1 and 2 completed
    Steps:
      1. Run: test -f src/bootstrap/app-bootstrap.ts && echo "EXISTS" || echo "DELETED"
      2. Assert: Output is "DELETED"
      3. Run: grep -r "bootstrapApp\|AppBootstrapResult\|AppBootstrapOptions" src/ test/ scripts/ 2>/dev/null | grep -v node_modules || echo "CLEAN"
      4. Assert: Output is "CLEAN"
      5. Run: bun run build && bun test
      6. Assert: Both exit code 0
    Expected Result: File deleted, zero references, full build+test pass
    Evidence: .sisyphus/evidence/task-3-bootstrap-deleted.txt

  Scenario: No dangling imports of deleted module
    Tool: Bash
    Preconditions: app-bootstrap.ts deleted
    Steps:
      1. Run: grep -r "app-bootstrap" src/ test/ scripts/ --include="*.ts" || echo "CLEAN"
      2. Assert: Output is "CLEAN" (no files import the deleted module)
    Expected Result: No imports reference deleted module
    Evidence: .sisyphus/evidence/task-3-no-dangling-imports.txt
  ```

  **Commit**: YES
  - Message: `chore: delete bootstrapApp shim and AppBootstrapResult type`
  - Files: `src/bootstrap/app-bootstrap.ts` (deleted), `src/bootstrap/types.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 4. Narrow RuntimeBootstrapResult Exported Type

  **What to do**:
  - In `src/bootstrap/types.ts`, create a new `PublicRuntimeBootstrapResult` type (or rename appropriately) that EXCLUDES:
    - `db: Db` — raw database handle, internal only
    - `rawDb: Database` — raw bun:sqlite handle, internal only
    - `sessionService: SessionService` — internal service
  - Keep the full `RuntimeBootstrapResult` type for internal use (composition root, `bootstrapRuntime()` return, `createAppHost()` parameter)
  - Update external consumers (if any beyond internal bootstrap) to use the narrow type
  - Add `@internal` JSDoc to `RuntimeBootstrapResult` indicating it should not be used outside `src/bootstrap/` and `src/app/host/`

  **Must NOT do**:
  - Do NOT delete `RuntimeBootstrapResult` — it is the internal composition root type
  - Do NOT remove fields that `createAppHost()` needs (agentRegistry, turnService, etc.)
  - Do NOT break `test/architecture/import-boundaries.test.ts` — it tests that this type is NOT imported from forbidden paths

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Requires careful type analysis and ensuring no downstream consumers break
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 5, 6, 7)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/bootstrap/types.ts:76-104` — full `RuntimeBootstrapResult` type with all 27 fields
  - `src/app/host/create-app-host.ts:64` — `createAppHost()` accepts `RuntimeBootstrapResult` as `_injectedRuntime`
  - `test/architecture/import-boundaries.test.ts` — tests that forbid importing this type from wrong layers

  **API/Type References**:
  - `src/bootstrap/types.ts:76` — fields `db`, `rawDb`, `sessionService` are the ones to hide
  - `src/bootstrap/runtime.ts` — returns `RuntimeBootstrapResult`

  **WHY Each Reference Matters**:
  - `types.ts` is the source file to modify
  - `create-app-host.ts` is the primary consumer — must continue to work with internal type
  - Import boundary test validates that the narrowing is enforced architecturally

  **Acceptance Criteria**:
  - [ ] `RuntimeBootstrapResult` still exists but has `@internal` JSDoc
  - [ ] A narrower public type exists without `db`/`rawDb`/`sessionService`
  - [ ] `bun run build` passes
  - [ ] `bun test test/architecture/` passes
  - [ ] `bun test` passes (full suite)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Internal fields hidden from public type
    Tool: Bash
    Preconditions: Type narrowing applied
    Steps:
      1. Run: grep -A 5 "PublicRuntimeBootstrapResult\|RuntimeBootstrapPublic" src/bootstrap/types.ts
      2. Assert: New narrow type exists
      3. Run: grep "db:\|rawDb:\|sessionService:" <<< $(grep -A 30 "PublicRuntimeBootstrapResult\|RuntimeBootstrapPublic" src/bootstrap/types.ts)
      4. Assert: None of these fields appear in the narrow type
      5. Run: bun run build && bun test
      6. Assert: Both pass
    Expected Result: Narrow type exists without internal fields, full build+test passes
    Evidence: .sisyphus/evidence/task-4-type-narrowed.txt

  Scenario: Internal type still usable by createAppHost
    Tool: Bash
    Preconditions: Type narrowing applied
    Steps:
      1. Run: grep "RuntimeBootstrapResult" src/app/host/create-app-host.ts
      2. Assert: Still imports and uses the full internal type
      3. Run: bun run build
      4. Assert: Exit code 0 — createAppHost compiles without errors
    Expected Result: Internal type unchanged for composition root consumers
    Evidence: .sisyphus/evidence/task-4-internal-type-preserved.txt
  ```

  **Commit**: YES (groups with Wave 1)
  - Message: `refactor(types): narrow RuntimeBootstrapResult, hide db/rawDb/sessionService from public API`
  - Files: `src/bootstrap/types.ts`, possibly `src/bootstrap/index.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 5. Rename Test Gate Descriptions (Drop Phase 2X Prefix)

  **What to do**:
  - In `test/pg-app/phase2a-gate.test.ts`:
    - Line 1 comment: "Phase 2A Foundation Gate" → "Foundation Gate"
    - Line 7 describe: `"Phase 2A Foundation Gate"` → `"Foundation Gate"`
  - In `test/pg-app/phase2b-gate.test.ts`:
    - Line 1 comment: "Phase 2B Domain Repositories Gate" → "Domain Repositories Gate"
    - Line 7 describe: `"Phase 2B Domain Repositories Gate"` → `"Domain Repositories Gate"`
    - Line 121 describe: `"Phase 2B Settlement UoW Gate"` → `"Settlement UoW Gate"`
    - Line 128 describe: `"Phase 2B Migration Tools Gate"` → `"Migration Tools Gate"`
  - In `test/pg-app/phase2c-gate.test.ts`:
    - Line 1 comment: "Phase 2C Final Verification Gate" → "PG Feature Import Gate"
    - Line 7 describe: `"Phase 2C Final Verification Gate"` → `"PG Feature Import Gate"`

  **Must NOT do**:
  - Do NOT rename the test FILE names (phase2a-gate.test.ts etc.) — only internal descriptions
  - Do NOT change test logic or assertions
  - Do NOT change the `skipIf` conditions

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple string replacements in 3 files
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4, 6, 7)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `test/pg-app/phase2a-gate.test.ts:1,7` — "Phase 2A Foundation Gate" strings
  - `test/pg-app/phase2b-gate.test.ts:1,7,121,128` — "Phase 2B" strings
  - `test/pg-app/phase2c-gate.test.ts:1,7` — "Phase 2C Final Verification Gate" strings
  - `docs/APP_LAYER_WIRING_CONSENSUS_2026-03-30.zh-CN.md:155-156` — Decision A023: naming convention

  **WHY Each Reference Matters**:
  - Test files contain the strings to change
  - Consensus doc defines the target naming convention (Foundation Gate, Domain Repositories Gate, PG Feature Import Gate)

  **Acceptance Criteria**:
  - [ ] `grep -r "Phase 2A\|Phase 2B\|Phase 2C" test/pg-app/` returns 0 results
  - [ ] `grep "Foundation Gate" test/pg-app/phase2a-gate.test.ts` returns matches
  - [ ] `grep "PG Feature Import Gate" test/pg-app/phase2c-gate.test.ts` returns matches
  - [ ] `bun test test/pg-app/` passes (if PG tests are enabled)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: No Phase 2X terminology remains in test gates
    Tool: Bash
    Preconditions: String replacements applied
    Steps:
      1. Run: grep -r "Phase 2A\|Phase 2B\|Phase 2C" test/pg-app/ || echo "CLEAN"
      2. Assert: Output is "CLEAN"
      3. Run: grep "Foundation Gate" test/pg-app/phase2a-gate.test.ts
      4. Assert: Match found
      5. Run: grep "Domain Repositories Gate" test/pg-app/phase2b-gate.test.ts
      6. Assert: Match found
      7. Run: grep "PG Feature Import Gate" test/pg-app/phase2c-gate.test.ts
      8. Assert: Match found
    Expected Result: All Phase 2X prefixes replaced with correct new names
    Evidence: .sisyphus/evidence/task-5-gate-names-updated.txt
  ```

  **Commit**: YES (groups with T6, T7)
  - Message: `chore: rename test gate descriptions per A023 convention`
  - Files: `test/pg-app/phase2a-gate.test.ts`, `test/pg-app/phase2b-gate.test.ts`, `test/pg-app/phase2c-gate.test.ts`
  - Pre-commit: `bun run build`

- [x] 6. Update Documentation Terminology

  **What to do**:
  - In `docs/MEMORY_PLATFORM_GAPS_TOTAL_2026-03-30.zh-CN.md`:
    - Line 136: Change "phase gate 强度不足" framing to "acceptance harness" / "foundation gate" terminology
    - Line 409: Change `不是 "phase gate ready"` to `不是 "acceptance gate ready"`
  - Search all `docs/*.md` files for remaining instances of:
    - "强验收" used to describe phase gates → replace with "foundation/import gate" framing
    - "直接读 runtime 内部对象" describing config doctor/agent commands → replace with "基于 AppHostAdmin" framing
  - Verify that `APP_LAYER_WIRING_CONSENSUS` and `APP_LAYER_WIRING_LEGACY_CLEANUP_CHECKLIST` already use correct terminology (they should — they define the cleanup)

  **Must NOT do**:
  - Do NOT rewrite entire documents — only update specific terminology
  - Do NOT change the intent of the documentation, only the wording
  - Do NOT delete any documentation files

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Targeted text replacements in documentation
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4, 5, 7)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `docs/MEMORY_PLATFORM_GAPS_TOTAL_2026-03-30.zh-CN.md:136` — "phase gate 强度不足"
  - `docs/MEMORY_PLATFORM_GAPS_TOTAL_2026-03-30.zh-CN.md:409` — `"phase gate ready"`
  - `docs/APP_LAYER_WIRING_CONSENSUS_2026-03-30.zh-CN.md:155-156` — reference for correct terminology
  - `docs/APP_LAYER_WIRING_LEGACY_CLEANUP_CHECKLIST_2026-03-30.zh-CN.md:124-129` — defines the cleanup instructions

  **WHY Each Reference Matters**:
  - Lines 136 and 409 in GAPS_TOTAL are confirmed legacy terminology that needs updating
  - Consensus and checklist docs define what the correct terminology should be

  **Acceptance Criteria**:
  - [ ] No docs use "phase gate" described as "强验收" (strong acceptance)
  - [ ] No docs describe config doctor as "直接读 runtime 内部对象"
  - [ ] `bun run build` still passes (docs don't affect build, but verify)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Legacy terminology removed from documentation
    Tool: Bash
    Preconditions: Terminology updated
    Steps:
      1. Run: grep -r "phase gate.*强" docs/ || echo "CLEAN"
      2. Assert: Output is "CLEAN" (no "phase gate" with "强验收" nearby)
      3. Run: grep -r "直接读 runtime" docs/ || echo "CLEAN"
      4. Assert: Output is "CLEAN"
    Expected Result: Zero legacy terminology instances
    Evidence: .sisyphus/evidence/task-6-doc-terminology.txt

  Scenario: Documentation still coherent
    Tool: Bash
    Preconditions: Terminology updated
    Steps:
      1. Run: grep "foundation.*gate\|import.*gate\|acceptance.*gate\|AppHostAdmin" docs/MEMORY_PLATFORM_GAPS_TOTAL_2026-03-30.zh-CN.md
      2. Assert: New terminology present in updated sections
    Expected Result: Updated terms used in place of old ones
    Evidence: .sisyphus/evidence/task-6-doc-coherent.txt
  ```

  **Commit**: YES (groups with T5, T7)
  - Message: `docs: update legacy phase gate and runtime introspection terminology`
  - Files: `docs/MEMORY_PLATFORM_GAPS_TOTAL_2026-03-30.zh-CN.md` + any other affected docs
  - Pre-commit: `bun run build`

- [x] 7. Remove AppClients Deprecated Alias

  **What to do**:
  - Remove the deprecated `AppClients` type alias from `src/app/clients/app-clients.ts` (lines 17-18)
  - Note: There is NO barrel `index.ts` in `src/app/clients/` — consumers import directly from `app-clients.ts`, so no barrel update needed
  - Verify no source code imports `AppClients` (documentation references are OK to leave)

  **Must NOT do**:
  - Do NOT modify `AppUserFacade` — it is the replacement and is already in use
  - Do NOT update documentation references to `AppClients` — they are historical context

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single line removal + barrel update
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4, 5, 6)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/app/clients/app-clients.ts:17-18` — `/** @deprecated Use AppUserFacade */ export type AppClients = AppUserFacade;`
  - Note: No barrel `index.ts` exists in `src/app/clients/` — imports are direct from `app-clients.ts`

  **WHY Each Reference Matters**:
  - Line 17-18 is the exact code to remove
  - No barrel file exists, so only `app-clients.ts` needs modification

  **Acceptance Criteria**:
  - [ ] `grep "AppClients" src/app/clients/app-clients.ts` returns 0 results
  - [ ] `grep -r "AppClients" src/ --include="*.ts" | grep -v "deprecated\|\.d\.ts"` returns 0 results
  - [ ] `bun run build` passes
  - [ ] `bun test` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: AppClients alias fully removed
    Tool: Bash
    Preconditions: Alias deleted
    Steps:
      1. Run: grep "AppClients" src/app/clients/app-clients.ts || echo "CLEAN"
      2. Assert: Output is "CLEAN"
      3. Run: grep -r "import.*AppClients\|AppClients" src/ --include="*.ts" | grep -v "node_modules\|\.d\.ts" || echo "CLEAN"
      4. Assert: Output is "CLEAN"
      5. Run: bun run build && bun test
      6. Assert: Both pass
    Expected Result: Zero AppClients references in source, build+test pass
    Evidence: .sisyphus/evidence/task-7-appclients-removed.txt
  ```

  **Commit**: YES (groups with T5, T6)
  - Message: `chore: remove deprecated AppClients type alias`
  - Files: `src/app/clients/app-clients.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 8. Backend-Neutral JobPersistence Factory (TDD)

  **What to do**:
  - **RED**: Write tests for a `createJobPersistence(backendType, options)` factory that:
    - Returns `SqliteJobPersistence` when `backendType === "sqlite"`
    - Returns a `PgJobPersistence` adapter when `backendType === "pg"` (adapts `DurableJobStore` to `JobPersistence` interface)
    - Throws for unknown backend types
  - **GREEN**: Implement the factory in `src/jobs/job-persistence-factory.ts`
    - Verify if `DurableJobStore` (PG) already satisfies `JobPersistence` interface — if not, create thin adapter
    - The adapter should map `DurableJobStore` methods to `JobPersistence` contract
  - **REFACTOR**: Clean up, ensure both paths return the same interface
  - Also verify `JobPersistence` interface is fully async-compatible (R8 requirement): change all method return types to `Promise<...>` (e.g. `enqueue → Promise<void>`, `claim → Promise<boolean>`, `listPending → Promise<JobEntry[]>`, etc.). Update `SqliteJobPersistence` to wrap sync returns in `Promise.resolve()`. This ensures the PG adapter (which wraps async `DurableJobStore`) and SQLite share one interface.
  - **Async cascade — update ALL existing callers** (4 files, 9 call sites):
    | File | Calls to update | Notes |
    |------|----------------|-------|
    | `src/jobs/queue.ts:28,99,104,109,114` | `enqueue`, `claim`, `complete`, `fail`(x2) | Currently fire-and-forget via `?.` — add `await` or explicitly `void` the Promise. `syncPersistence()` must become `async` |
    | `src/jobs/dispatcher.ts:44-45` | `listPending()`, `listRetryable()` | Return values used (spread into array) — must add `await`, make `loadResumableJobs()` async |
    | `src/memory/storage.ts:982` | `enqueue` | Inside `enqueueDurableJob()` — add `await`, make caller async if not already |
    | `src/memory/task-agent.ts:531` | `enqueue` | Inside `enqueueOrganizerJobs()` — add `await`, already wrapped in try/catch |
  - **Files that do NOT need changes** (verified via grep — do NOT touch):
    - `src/jobs/pg-runner.ts` — uses `PgJobStore`/`DurableJobStore`, NOT `JobPersistence`
    - `src/memory/transaction-batcher.ts` — no `JobPersistence` usage
    - `src/gateway/sse.ts` — no `JobPersistence` usage
  - **PG adapter lazy initialization**: The PG adapter returned by the factory must use lazy pool resolution. At construction time, it receives a `PgBackendFactory` reference (whose pool may not yet be initialized). On first method call, it calls `factory.getPool()` to resolve the connection. This handles the timing gap where `bootstrapRuntime()` is sync but PG init is async (see Task 9). The adapter MUST NOT call `getPool()` in its constructor.

  **Must NOT do**:
  - Do NOT change the behavioral logic of existing `SqliteJobPersistence` or `PgJobStore` implementations — but you MUST update `SqliteJobPersistence` method signatures and return types to be async (wrap sync returns in `Promise.resolve()`). This is a mechanical signature change, not a logic change.
  - Do NOT add new database schemas — use existing tables
  - Do NOT make the factory a singleton — let callers manage lifecycle

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Requires understanding both SQLite and PG job stores, interface alignment, TDD discipline
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential: T8 → T9)
  - **Blocks**: Task 9
  - **Blocked By**: None (Wave 1 items are independent)

  **References**:

  **Pattern References**:
  - `src/jobs/persistence.ts:24-32` — `JobPersistence` interface (enqueue, claim, complete, fail, retry, listPending, listRetryable)
  - `src/jobs/persistence.ts:48-165` — `SqliteJobPersistence` implementation (mechanical async conversion here)
  - `src/jobs/durable-store.ts:244-259` — `DurableJobStore` interface for PG (already async — target for adapter)
  - `src/jobs/pg-store.ts` — PG implementation of `DurableJobStore`

  **Async Cascade References** (files requiring `await` insertion):
  - `src/jobs/queue.ts:28,91-116` — `syncPersistence()` method: 5 persistence calls, must become async
  - `src/jobs/dispatcher.ts:39-45` — `loadResumableJobs()`: `listPending()` and `listRetryable()` return values spread into array, must await
  - `src/memory/storage.ts:982` — `enqueueDurableJob()`: single `enqueue` call
  - `src/memory/task-agent.ts:531` — inside `enqueueOrganizerJobs()`: single `enqueue` call

  **API/Type References**:
  - `src/jobs/types.ts` — `JobKind`, `JobEntry`, `ExecutionClass` types
  - `src/storage/backend-types.ts:14,78-102` — `BackendType`, `PgBackendFactory` (lazy pool reference for PG adapter)

  **Test References**:
  - `test/jobs/pg-race-recovery.test.ts` — existing PG job test patterns

  **WHY Each Reference Matters**:
  - `persistence.ts` defines the target interface and SQLite impl — factory must return this interface
  - `durable-store.ts` + `pg-store.ts` define PG primitives — need to assess interface compatibility
  - `backend-types.ts` provides the `BackendType` discriminator and `PgBackendFactory` for lazy adapter
  - Cascade files (queue, dispatcher, storage, task-agent) must all `await` after async conversion — miss any and you get floating Promises

  **Acceptance Criteria**:
  - [ ] Test file exists: `test/jobs/job-persistence-factory.test.ts`
  - [ ] Factory function exported from `src/jobs/job-persistence-factory.ts`
  - [ ] SQLite path returns `SqliteJobPersistence` instance
  - [ ] PG path returns adapter implementing `JobPersistence` interface
  - [ ] `bun test test/jobs/job-persistence-factory.test.ts` → PASS
  - [ ] PG adapter uses lazy pool resolution (no `getPool()` in constructor, resolves on first method call)
  - [ ] All 4 cascade files updated with `await`: `queue.ts`, `dispatcher.ts`, `storage.ts`, `task-agent.ts`
  - [ ] `bun run build` passes (zero type errors from floating Promises)
  - [ ] `bun test` passes (cascade changes don't break existing tests)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Factory returns correct implementation per backend type
    Tool: Bash
    Preconditions: Factory implemented with TDD
    Steps:
      1. Run: bun test test/jobs/job-persistence-factory.test.ts
      2. Assert: All tests pass (sqlite path, pg path, unknown throws)
      3. Run: grep "JobPersistence" src/jobs/job-persistence-factory.ts
      4. Assert: Interface referenced (confirms type compliance)
    Expected Result: Tests pass, factory type-safe
    Evidence: .sisyphus/evidence/task-8-factory-tests.txt

  Scenario: PG adapter uses lazy pool initialization
    Tool: Bash
    Preconditions: PG adapter implemented
    Steps:
      1. Run: grep -n "getPool" src/jobs/job-persistence-factory.ts
      2. Assert: getPool() NOT called in constructor (no match in constructor section)
      3. Assert: getPool() IS called inside method bodies (lazy resolution)
      4. Run: bun run build
      5. Assert: No type errors
    Expected Result: PG adapter defers pool access until first use
    Evidence: .sisyphus/evidence/task-8-pg-lazy-init.txt

  Scenario: All async cascade callers updated
    Tool: Bash
    Preconditions: Interface converted to async, all callers updated
    Steps:
      1. Run: grep -n "await.*persistence\.\|await.*jobPersistence\." src/jobs/queue.ts src/jobs/dispatcher.ts src/memory/storage.ts src/memory/task-agent.ts
      2. Assert: ≥9 matches (all call sites now await)
      3. Run: bun run build
      4. Assert: Zero type errors (no floating Promises)
      5. Run: bun test
      6. Assert: All tests pass
    Expected Result: Async conversion complete across all 4 files, zero regression
    Evidence: .sisyphus/evidence/task-8-async-cascade.txt
  ```

  **Commit**: YES
  - Message: `feat(jobs): async JobPersistence interface, backend-neutral factory with lazy PG adapter`
  - Files: `src/jobs/job-persistence-factory.ts`, `src/jobs/persistence.ts`, `src/jobs/queue.ts`, `src/jobs/dispatcher.ts`, `src/memory/storage.ts`, `src/memory/task-agent.ts`, `test/jobs/job-persistence-factory.test.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 9. Inject JobPersistence into bootstrapRuntime (TDD)

  **What to do**:
  - **RED**: Write tests verifying that `bootstrapRuntime()` accepts an optional `jobPersistence` parameter and passes it to:
    - `GraphStorageService` constructor (line ~268)
    - `MemoryTaskAgent` constructor (line ~329)
  - **GREEN**: Modify `bootstrapRuntime()` in `src/bootstrap/runtime.ts` to:
    - Accept optional `JobPersistence` parameter in its options
    - Create `JobPersistence` via the factory from Task 8 when not explicitly provided and `backendType` supports it. **For PG backend**: the factory creates a lazy PG adapter (from Task 8) that holds the `pgFactory` reference but does NOT resolve the pool until first method call. This is safe because `bootstrapRuntime()` is sync, and by the time any persistence method is actually called, `initializePgBackendForRuntime()` will have been called by `createAppHost()` (see below). **For SQLite backend**: the factory creates `SqliteJobPersistence` immediately (sync, `db` is available).
    - Pass it to `GraphStorageService` and `MemoryTaskAgent`
  - **REFACTOR**: Ensure the injection follows existing DI patterns in runtime.ts
  - Include `jobPersistence` in `RuntimeBootstrapResult` so the host layer can access it for consumers
  - **Wire PG initialization through the host layer**: `createAppHost()` must call `initializePgBackendForRuntime(runtime)` (already exists at `src/bootstrap/runtime.ts:594-602`) after `bootstrapRuntime()` returns when `runtime.backendType === "pg"`. Currently `createAppHost()` (line 115-124) calls `bootstrapRuntime()` synchronously but never initializes PG. Add this async call between bootstrap and host assembly. This is what enables Tasks 10/11/16/17-20 to operate with a live PG pool.
  - **Optionally extend `AppHostOptions`**: Add optional `pgUrl?: string` field to `AppHostOptions` in `types.ts` so scripts can pass PG connection info via CLI flags (e.g. `--pg-url`). When present, set `process.env.PG_APP_URL = options.pgUrl` before calling `initializePgBackendForRuntime()`. If not set, `initializePgBackendForRuntime` uses `process.env.PG_APP_URL` as it already does.
  - Note: `backendType` is already resolved inside `bootstrapRuntime()` via `resolveBackendType()` which reads `MAIDSCLAW_BACKEND` env var. No need to add `backendType` to `AppHostOptions` — it flows through env. Scripts set `MAIDSCLAW_BACKEND=pg` before calling `createAppHost()` to opt into PG.

  **Must NOT do**:
  - Do NOT start job consumers in runtime bootstrap — that's the host layer's job (Task 10/11)
  - Do NOT change the default behavior for `role: "local"` — local mode may skip job persistence
  - Do NOT modify `GraphStorageService` or `MemoryTaskAgent` constructors — they already accept optional `JobPersistence`

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Core bootstrap modification requires careful understanding of dependency flow
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential after T8)
  - **Blocks**: Tasks 10, 11, 13, 15
  - **Blocked By**: Task 8

  **References**:

  **Pattern References**:
  - `src/bootstrap/runtime.ts:205-585` — `bootstrapRuntime()` function
  - `src/bootstrap/runtime.ts:268` — `GraphStorageService` instantiation (currently without JobPersistence)
  - `src/bootstrap/runtime.ts:329-337` — `MemoryTaskAgent` instantiation (currently without JobPersistence)
  - `src/bootstrap/runtime.ts:533-548` — sweeper startup section (reference for where consumer startup could go)
  - `src/bootstrap/runtime.ts:594-602` — `initializePgBackendForRuntime()` — must be called from `createAppHost()` when PG backend is active
  - `src/app/host/create-app-host.ts:115-124` — current `bootstrapRuntime()` call site — add PG init after this line

  **API/Type References**:
  - `src/memory/storage.ts:1109-1124` — `GraphStorageService` constructor accepts optional `JobPersistence`
  - `src/memory/task-agent.ts:320-375` — `MemoryTaskAgent` constructor accepts optional `jobPersistence`
  - `src/bootstrap/types.ts:76-104` — `RuntimeBootstrapResult` type (may need `jobPersistence` field added)
  - `src/storage/backend-types.ts:14` — `BackendType = "sqlite" | "pg"` (already used by `resolveBackendType()`)
  - `src/storage/backend-types.ts:78-102` — `PgBackendFactory` class — created inside `bootstrapRuntime()`, exposed on result as `pgFactory`
  - `src/app/host/types.ts:32-48` — `AppHostOptions` — may need optional `pgUrl?: string` field added

  **WHY Each Reference Matters**:
  - Lines 268 and 329 are the exact injection points — currently NOT passing JobPersistence
  - Constructor signatures confirm both classes already accept the parameter — just need to pass it
  - RuntimeBootstrapResult may need the field so host layer can access it

  **Acceptance Criteria**:
  - [ ] `bootstrapRuntime()` accepts optional `jobPersistence` or creates one via factory
  - [ ] `GraphStorageService` receives `jobPersistence` when available
  - [ ] `MemoryTaskAgent` receives `jobPersistence` when available
  - [ ] `RuntimeBootstrapResult` includes `jobPersistence` field
  - [ ] `createAppHost()` calls `initializePgBackendForRuntime(runtime)` when `runtime.backendType === "pg"` (before host assembly)
  - [ ] Optional `pgUrl?: string` added to `AppHostOptions` in `types.ts` — when set, propagated to `process.env.PG_APP_URL` before PG init
  - [ ] `bun run build` passes
  - [ ] `bun test` passes (existing tests unaffected — local mode still works without persistence)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: JobPersistence injected into runtime bootstrap
    Tool: Bash
    Preconditions: Runtime.ts modified
    Steps:
      1. Run: grep "jobPersistence" src/bootstrap/runtime.ts | head -10
      2. Assert: jobPersistence appears in parameter, GraphStorageService instantiation, and MemoryTaskAgent instantiation
      3. Run: bun run build
      4. Assert: Exit code 0
      5. Run: bun test
      6. Assert: All existing tests pass (no regression)
    Expected Result: JobPersistence wired through runtime, zero regression
    Evidence: .sisyphus/evidence/task-9-injection.txt

  Scenario: Local mode still works without explicit JobPersistence
    Tool: Bash
    Preconditions: Injection implemented with optional parameter
    Steps:
      1. Run: bun test test/cli/
      2. Assert: CLI tests still pass (local mode bootstrap doesn't require JobPersistence)
    Expected Result: Backward compatible — local mode unaffected
    Evidence: .sisyphus/evidence/task-9-backward-compat.txt

  Scenario: PG initialization wired through createAppHost
    Tool: Bash
    Preconditions: Task 9 implementation complete
    Steps:
      1. Run: grep -n "initializePgBackendForRuntime" src/app/host/create-app-host.ts
      2. Assert: At least 1 match — PG init is called after bootstrapRuntime()
      3. Run: grep -n "pgUrl" src/app/host/types.ts
      4. Assert: At least 1 match — pgUrl option exists in AppHostOptions
      5. Run: bun run build
      6. Assert: Exit code 0
    Expected Result: PG backend initialization flows through host layer, pgUrl option exposed
    Evidence: .sisyphus/evidence/task-9-pg-wiring.txt
  ```

  **Commit**: YES
  - Message: `feat(bootstrap): inject JobPersistence into runtime, wire PG init through host`
  - Files: `src/bootstrap/runtime.ts`, `src/bootstrap/types.ts`, `src/app/host/create-app-host.ts`, `src/app/host/types.ts`, test files
  - Pre-commit: `bun run build && bun test`

- [x] 10. Implement Worker Role in createAppHost (TDD)

  **What to do**:
  - **RED**: Write tests for `createAppHost({ role: "worker", ... })` that verify:
    - Worker starts a durable job consumer loop (using `JobDispatcher`/`PgJobRunner`)
    - Worker does NOT start gateway server
    - Worker does NOT expose user facade
    - Worker responds to `shutdown()` by draining the consumer
  - **GREEN**: Implement worker role in `src/app/host/create-app-host.ts`:
    - Worker role currently has NO dedicated section — `user` at line 139 excludes worker (only `local`/`server`), `start()` at line 216 only handles `server`, `shutdown()` at line 223 only handles `server`. All three need worker branches.
    - Instantiate `JobDispatcher` + `JobScheduler` (for SQLite) or `PgJobRunner` (for PG)
    - Start the consumer loop on `host.start()` (add `else if (options.role === "worker")` block after line 217)
    - Stop the consumer on `host.shutdown()` (add worker drain before line 234)
    - Wire job handlers for known `JobKind` values (`memory.organize`, `search.rebuild`, etc.)
  - **REFACTOR**: Ensure consumer start/stop follows the same lifecycle pattern as gateway server

  **Must NOT do**:
  - Do NOT add gateway server to worker role
  - Do NOT expose AppUserFacade from worker — workers only process jobs
  - Do NOT modify server role behavior — that's Task 11

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex orchestration wiring with lifecycle management, TDD
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 11, 13)
  - **Blocks**: Tasks 12, 14
  - **Blocked By**: Task 9

  **References**:

  **Pattern References**:
  - `src/app/host/create-app-host.ts:139-159` — user facade construction (local/server only — worker gets `undefined` here, which is correct)
  - `src/app/host/create-app-host.ts:216-221` — `start()` function (currently only handles `server` role — add worker branch)
  - `src/app/host/create-app-host.ts:223-236` — `shutdown()` function (currently only handles `server` — add worker drain)
  - `src/app/host/create-app-host.ts:161-171` — server/gateway construction (lifecycle pattern to follow for worker consumer)
  - `src/jobs/dispatcher.ts` — `JobDispatcher` for in-memory job dispatch
  - `src/jobs/scheduler.ts` — `JobScheduler` for interval-based polling
  - `src/jobs/pg-runner.ts` — `PgJobRunner` for PG backend job processing

  **API/Type References**:
  - `src/app/host/types.ts:7` — `AppRole` includes `"worker"`
  - `src/app/host/types.ts:62-70` — `AppHost` interface
  - `src/jobs/types.ts` — `JobKind` enum for handler registration

  **WHY Each Reference Matters**:
  - Lines 139-159 show how roles are gated (local/server get user facade, worker/maintenance get `undefined`). Worker logic goes in `start()` at 216 and `shutdown()` at 223.
  - Server role (100-138) shows the lifecycle pattern (start/shutdown) to follow
  - Dispatcher/Scheduler/PgRunner are the job consumer primitives to wire

  **Acceptance Criteria**:
  - [ ] `createAppHost({ role: "worker" })` starts job consumer on `host.start()`
  - [ ] Worker `host.shutdown()` drains consumer gracefully
  - [ ] Worker does not start gateway server
  - [ ] Both SQLite and PG backends handled via factory
  - [ ] TDD tests pass: `bun test test/app/host/worker-role.test.ts`
  - [ ] `bun run build` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Worker role starts and processes jobs
    Tool: Bash
    Preconditions: Worker role implemented
    Steps:
      1. Run: bun test test/app/host/worker-role.test.ts
      2. Assert: All tests pass (consumer starts, processes job, shuts down)
      3. Run: bun run build
      4. Assert: Exit code 0
    Expected Result: Worker role lifecycle functional
    Evidence: .sisyphus/evidence/task-10-worker-role.txt

  Scenario: Worker role does not start gateway
    Tool: Bash
    Preconditions: Worker role implemented
    Steps:
      1. Run: grep -A 20 "role.*worker" src/app/host/create-app-host.ts | grep -i "gateway\|server.*listen"
      2. Assert: No gateway/server startup in worker path
    Expected Result: Worker is job-consumer only, no HTTP listener
    Evidence: .sisyphus/evidence/task-10-no-gateway.txt
  ```

  **Commit**: YES
  - Message: `feat(host): implement worker role with durable job consumer loop`
  - Files: `src/app/host/create-app-host.ts`, `test/app/host/worker-role.test.ts`
  - Pre-commit: `bun test`

- [x] 11. Implement Server Durable Mode in createAppHost (TDD)

  **What to do**:
  - **RED**: Write tests for `createAppHost({ role: "server", enableDurableOrchestration: true })` that verify:
    - Server starts job consumer IN ADDITION to gateway
    - Server starts lease reclaim sweeper (delegates to Task 12, but option must be recognized)
    - `enableDurableOrchestration: false` (default) preserves current server behavior
  - **GREEN**: Extend server role in `src/app/host/create-app-host.ts`:
    - Add `enableDurableOrchestration?: boolean` to `AppHostOptions`
    - When enabled: start `JobDispatcher`/`PgJobRunner` alongside gateway
    - Wire shutdown to drain both gateway AND consumer
    - **Pass `strictDurableMode: true` to `MemoryTaskAgent`** when `enableDurableOrchestration` is enabled — this is the wiring that activates Task 13's strict mode. Without this, Task 13 adds the option but nothing ever sets it. For `role: "worker"`, also pass `strictDurableMode: true` (workers are inherently durable). For `role: "local"` and `role: "server"` without durable orchestration, leave `strictDurableMode` as `undefined` (default, preserves fire-and-forget fallback).
  - **REFACTOR**: Share consumer startup logic between worker and server roles (extract helper)

  **Must NOT do**:
  - Do NOT change default server behavior — durable orchestration must be opt-in
  - Do NOT duplicate consumer logic — share with worker role (Task 10)
  - Do NOT implement lease reclaim here — that's Task 12

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Extends existing server role with dual lifecycle management
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 10, 13)
  - **Parallel Group**: Wave 3 (with Tasks 10, 13)
  - **Blocks**: Tasks 12, 14, 15, 21
  - **Blocked By**: Task 9
  - **⚠️ Merge Conflict Risk**: Both T10 and T11 modify `create-app-host.ts`. T10 adds worker branches in `start()`/`shutdown()`, T11 extends server role. They touch DIFFERENT code regions (worker vs server role branches), so merge conflicts are unlikely but possible. If merge conflict occurs on commit, executor should resolve by keeping both sets of changes — they are additive, not conflicting.

  **References**:

  **Pattern References**:
  - `src/app/host/create-app-host.ts:161-171` — current server role implementation (gateway construction)
  - `src/app/host/create-app-host.ts:216-221` — `start()` function (server-only — T11 extends this to include consumer when durable)
  - `src/app/host/types.ts:32-48` — `AppHostOptions` type (add `enableDurableOrchestration` here)

  **WHY Each Reference Matters**:
  - Server role (161-171 gateway, 216-221 start, 223-236 shutdown) is the code to extend
  - AppHostOptions is where the new `enableDurableOrchestration` flag must be added
  - Task 13 adds `strictDurableMode` to MemoryTaskAgent but nothing sets it — THIS TASK is where it gets wired for server durable mode and worker role

  **Acceptance Criteria**:
  - [ ] `AppHostOptions` includes `enableDurableOrchestration?: boolean`
  - [ ] Server with `enableDurableOrchestration: true` starts job consumer
  - [ ] Server with `enableDurableOrchestration: false` behaves as before
  - [ ] Server shutdown drains both gateway and consumer when durable is enabled
  - [ ] `strictDurableMode: true` passed to `MemoryTaskAgent` when `enableDurableOrchestration` is enabled (wires Task 13's option)
  - [ ] Worker role also passes `strictDurableMode: true` (via Task 10 shared helper or direct)
  - [ ] TDD tests pass
  - [ ] `bun run build` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Server durable mode starts consumer alongside gateway
    Tool: Bash
    Preconditions: Server durable mode implemented
    Steps:
      1. Run: bun test test/app/host/server-durable.test.ts
      2. Assert: Tests pass (consumer + gateway both start)
      3. Run: bun run build
      4. Assert: Exit code 0
    Expected Result: Server with durable mode runs both HTTP and job processing
    Evidence: .sisyphus/evidence/task-11-server-durable.txt

  Scenario: Default server behavior unchanged
    Tool: Bash
    Preconditions: Durable mode is opt-in
    Steps:
      1. Run: bun test test/cli/
      2. Assert: All existing CLI tests pass (use default server mode)
    Expected Result: Zero regression in default server behavior
    Evidence: .sisyphus/evidence/task-11-backward-compat.txt
  ```

  **Commit**: YES
  - Message: `feat(host): implement server durable mode with optional job consumer`
  - Files: `src/app/host/create-app-host.ts`, `src/app/host/types.ts`, test files
  - Pre-commit: `bun test`

- [x] 13. Remove Fire-and-Forget Fallback / Strict Durable Mode (TDD)

  **What to do**:
  - **RED**: Write tests for `MemoryTaskAgent` with `strictDurableMode: true` that verify:
    - When `jobPersistence` is available AND strict mode is on: enqueue failure THROWS (no fallback)
    - When `jobPersistence` is NOT available AND strict mode is on: construction fails or warns
    - When strict mode is off (default): current fallback behavior preserved
  - **GREEN**: Modify `src/memory/task-agent.ts`:
    - Add `strictDurableMode?: boolean` constructor option
    - In lines 470-485: when strict mode is on, remove the `catch` block that falls back to `launchBackgroundOrganize()`
    - Add runtime validation: strict durable mode requires `jobPersistence` to be provided
  - **REFACTOR**: Clean up `launchBackgroundOrganize()` — it remains for non-strict mode but gets `@deprecated` annotation

  **Must NOT do**:
  - Do NOT remove `launchBackgroundOrganize()` entirely — keep for backward compat in non-strict mode
  - Do NOT change behavior when `strictDurableMode` is false or undefined
  - Do NOT modify the `enqueueOrganizerJobs()` logic itself

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Behavioral mode switch with careful backward compatibility, TDD
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 10, 11)
  - **Blocks**: None
  - **Blocked By**: Task 9

  **References**:

  **Pattern References**:
  - `src/memory/task-agent.ts:470-485` — durable enqueue with fire-and-forget fallback (the code to guard)
  - `src/memory/task-agent.ts:499-508` — `launchBackgroundOrganize()` fire-and-forget method
  - `src/memory/task-agent.ts:320-375` — constructor (add `strictDurableMode` option)
  - `src/memory/task-agent.ts:511-544` — `enqueueOrganizerJobs()` (keep unchanged)

  **WHY Each Reference Matters**:
  - Lines 470-485 contain the exact fallback code that violates R5
  - Lines 499-508 is the fire-and-forget method to deprecate
  - Constructor is where the new mode flag gets accepted

  **Acceptance Criteria**:
  - [ ] `strictDurableMode` option added to `MemoryTaskAgent` constructor
  - [ ] Strict mode: enqueue failure throws, no fallback to `launchBackgroundOrganize()`
  - [ ] Non-strict mode: existing fallback behavior preserved (backward compat)
  - [ ] `launchBackgroundOrganize()` annotated with `@deprecated`
  - [ ] TDD tests pass
  - [ ] `bun run build` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Strict mode prevents fire-and-forget fallback
    Tool: Bash
    Preconditions: Strict durable mode implemented
    Steps:
      1. Run: bun test test/memory/task-agent-strict.test.ts
      2. Assert: Tests pass (strict mode throws on enqueue failure, non-strict falls back)
    Expected Result: Mode switch controls fallback behavior
    Evidence: .sisyphus/evidence/task-13-strict-mode.txt

  Scenario: Non-strict mode backward compatible
    Tool: Bash
    Preconditions: Default mode unchanged
    Steps:
      1. Run: bun test test/memory/
      2. Assert: All existing memory tests pass
    Expected Result: Zero regression when strict mode is off
    Evidence: .sisyphus/evidence/task-13-backward-compat.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): strict durable mode, deprecate fire-and-forget fallback`
  - Files: `src/memory/task-agent.ts`, test files
  - Pre-commit: `bun test`

- [x] 12. Wire reclaimExpiredLeases into Lease Reclaim Sweeper (TDD)

  **What to do**:
  - **RED**: Write tests for a `LeaseReclaimSweeper` that:
    - Calls `reclaimExpiredLeases()` on a configurable interval (default: 60s)
    - Starts and stops cleanly with `start()`/`stop()`
    - Only runs when PG backend is active (no-op for SQLite — SQLite uses in-process locks)
    - Logs reclaimed count per sweep
  - **GREEN**: Implement `src/jobs/lease-reclaim-sweeper.ts`:
    - Accept `DurableJobStore` (which has `reclaimExpiredLeases()` method)
    - Use `setInterval` with configurable period
    - Clean shutdown via `clearInterval`
  - **REFACTOR**: Integrate into host layer — start sweeper when `role === "server"` + durable mode, or `role === "worker"`, or `role === "maintenance"`

  **Must NOT do**:
  - Do NOT modify `PgJobStore.reclaimExpiredLeases()` implementation — it's already correct
  - Do NOT add reclaim to SQLite path — SQLite uses in-process locking
  - Do NOT make the sweeper interval hardcoded — must be configurable

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Sweeper lifecycle management, PG-only logic, integration with host layer
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Task 14)
  - **Blocks**: None
  - **Blocked By**: Task 10 or Task 11

  **References**:

  **Pattern References**:
  - `src/jobs/pg-store.ts:923-960` — `reclaimExpiredLeases()` implementation in `DurableJobStore`
  - `src/jobs/durable-store.ts:253` — `reclaimExpiredLeases()` interface method declaration
  - `src/memory/pending-settlement-sweeper.ts` — existing sweeper pattern (start/stop lifecycle) to follow
  - `src/memory/publication-recovery-sweeper.ts` — another sweeper pattern reference

  **Test References**:
  - `test/jobs/pg-race-recovery.test.ts:73` — existing test for `reclaimExpiredLeases()` behavior

  **WHY Each Reference Matters**:
  - `pg-store.ts:923-960` is the function to call — already implemented, just needs a caller
  - Settlement/publication sweepers show the established pattern for periodic sweepers in this codebase
  - pg-race-recovery test shows how to set up test fixtures for lease reclaim

  **Acceptance Criteria**:
  - [ ] `LeaseReclaimSweeper` class exported from `src/jobs/lease-reclaim-sweeper.ts`
  - [ ] Sweeper calls `reclaimExpiredLeases()` every 60s (configurable)
  - [ ] Sweeper starts/stops cleanly
  - [ ] PG-only: no-op when backend is SQLite
  - [ ] Integrated into host startup for relevant roles
  - [ ] TDD tests pass
  - [ ] `bun run build` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Lease reclaim sweeper lifecycle
    Tool: Bash
    Preconditions: Sweeper implemented
    Steps:
      1. Run: bun test test/jobs/lease-reclaim-sweeper.test.ts
      2. Assert: Tests pass (start/stop/reclaim cycle)
    Expected Result: Sweeper correctly manages its lifecycle and calls reclaimExpiredLeases
    Evidence: .sisyphus/evidence/task-12-sweeper.txt

  Scenario: reclaimExpiredLeases has production call site
    Tool: Bash
    Preconditions: Sweeper wired
    Steps:
      1. Run: grep -r "reclaimExpiredLeases" src/ --include="*.ts" | grep -v "test\|\.d\.ts"
      2. Assert: At least one call site in lease-reclaim-sweeper.ts (beyond the interface definition)
    Expected Result: reclaimExpiredLeases is called in production code
    Evidence: .sisyphus/evidence/task-12-call-site.txt
  ```

  **Commit**: YES
  - Message: `feat(jobs): lease reclaim sweeper with 60s interval (R4)`
  - Files: `src/jobs/lease-reclaim-sweeper.ts`, `src/app/host/create-app-host.ts`, test files
  - Pre-commit: `bun test`

- [x] 14. Role Boundary Acceptance Tests (TDD)

  **What to do**:
  - Write acceptance tests proving R10 — role boundaries are verifiable:
    - `role: "server"` with durable mode → has gateway + consumer + lease sweeper
    - `role: "server"` without durable → has gateway only (no consumer)
    - `role: "worker"` → has consumer only (no gateway, no user facade)
    - `role: "local"` → has user facade, no consumer, no gateway (in-process mode)
    - `role: "maintenance"` → has maintenance facade, no gateway
  - Each test verifies the AppHost interface shape: which facades are populated, which are null/undefined
  - Verify shutdown behavior per role

  **Must NOT do**:
  - Do NOT test internal implementation details — only test the public AppHost interface
  - Do NOT require a running database — use mocks/stubs for the runtime
  - Do NOT duplicate existing unit tests — these are role-boundary integration tests

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Integration-level tests across all 4 roles, requires understanding of entire host layer
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Task 12)
  - **Blocks**: None
  - **Blocked By**: Tasks 10, 11

  **References**:

  **Pattern References**:
  - `src/app/host/create-app-host.ts:64-257` — full `createAppHost()` implementation with role branches
  - `src/app/host/types.ts:62-70` — `AppHost` interface defining what to test

  **Test References**:
  - `test/pg-app/phase2a-gate.test.ts` — existing gate test pattern (import verification)
  - `test/architecture/import-boundaries.test.ts` — existing architectural test pattern

  **WHY Each Reference Matters**:
  - `create-app-host.ts` shows all role branches to cover
  - `types.ts` defines the interface contract to assert against

  **Acceptance Criteria**:
  - [ ] Test file: `test/app/host/role-boundaries.test.ts`
  - [ ] Tests cover all 4 roles (server, worker, local, maintenance)
  - [ ] Server durable vs non-durable tested
  - [ ] All tests pass: `bun test test/app/host/role-boundaries.test.ts`

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: All role boundaries provable
    Tool: Bash
    Preconditions: Tests written
    Steps:
      1. Run: bun test test/app/host/role-boundaries.test.ts
      2. Assert: All tests pass
      3. Run: grep -c "describe\|it(" test/app/host/role-boundaries.test.ts
      4. Assert: At least 5 test cases (4 roles + 1 durable variant)
    Expected Result: Every role's boundary is verified by at least one test
    Evidence: .sisyphus/evidence/task-14-role-boundaries.txt
  ```

  **Commit**: YES
  - Message: `test: role boundary acceptance tests proving R10`
  - Files: `test/app/host/role-boundaries.test.ts`
  - Pre-commit: `bun test`

- [x] 15. Implement AppMaintenanceFacade (Wire Real `runOnce` / `drain` / `getDrainStatus`)

  **What to do**:
  - Replace the stub `maintenanceFacade` object in `create-app-host.ts:173-183` with a real implementation
  - `runOnce()`: Delegate to `MaintenanceOrchestrationService.runFullMaintenance()` (from Task 16), which dispatches multiple granular maintenance jobs (search rebuild, projection replay, derived rebuild). This is a fan-out model — `runOnce()` itself is just the entry point that triggers the service
  - `drain()`: Set a drain flag on the host; stop the lease-reclaim sweeper and job consumers. Idempotent — calling twice is a no-op
  - `getDrainStatus()`: Return `{ draining: boolean; activeJobs: number; pendingJobs: number }`. To obtain `activeJobs` and `pendingJobs`, extend `JobPersistence` interface with `countByStatus(status: PersistentJobStatus): Promise<number>` (async — consistent with Task 8's async-everywhere decision). For SQLite: `SELECT COUNT(*)` wrapped in `Promise.resolve()`. For PG: the adapter delegates to `DurableJobStore.countByStatus()` (already async, returns `PgStatusCount`) and extracts the single status count. Add this method to `JobPersistence` in `src/jobs/persistence.ts` and implement in `SqliteJobPersistence`. Task 8's PG adapter will also implement it.
  - Extract the facade into its own file `src/app/host/maintenance-facade.ts` (implementation only — keep type in `types.ts`)
  - Wire it into `createAppHost()` for roles that expose maintenance (`maintenance` role, or any role with `enableMaintenance: true`)
  - TDD: Write tests first proving runOnce delegates to the orchestration service, drain stops consumers, getDrainStatus reflects state via countByStatus
  - The facade must accept `JobPersistence` + a reference to `MaintenanceOrchestrationService` as constructor/factory arguments — no direct DB access beyond `JobPersistence`

  **Must NOT do**:
  - Do NOT change the `AppMaintenanceFacade` type in `types.ts` (it's already correct)
  - Do NOT add business logic for individual maintenance tasks here — that's Task 16's `MaintenanceOrchestrationService`
  - Do NOT make drain synchronous — it should set a flag and return immediately

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Wiring facade to job pipeline requires understanding multiple subsystems (jobs, host lifecycle, drain semantics)
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: No UI involved

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Task 16 completing first)
  - **Parallel Group**: Wave 5b (after Task 16)
  - **Blocks**: Tasks 17-20 (scripts depend on working facade), Task 21 (introspection)
  - **Blocked By**: Task 9 (JobPersistence injected into runtime), Task 11 (server durable mode), Task 16 (MaintenanceOrchestrationService must exist — facade delegates to it)

  **References**:

  **Pattern References**:
  - `src/app/host/create-app-host.ts:173-183` — Current stub to replace
  - `src/app/host/create-app-host.ts:209-211` — `shouldExposeMaintenance()` gating pattern
  - `src/jobs/dispatcher.ts` — `JobDispatcher` API for dispatching jobs
  - `src/jobs/persistence.ts:24-55` — `JobPersistence` interface (enqueue, claim, complete, fail)

  **API/Type References**:
  - `src/app/host/types.ts:24-30` — `AppMaintenanceFacade` type contract (runOnce, drain, getDrainStatus, optional verify/rebuild)
  - `src/jobs/types.ts` — Job type definitions, `JOB_MAX_ATTEMPTS`
  - `src/jobs/persistence.ts:3-8` — `PersistentJobStatus` enum (pending, processing, retryable, exhausted, reconciled) — needed for `countByStatus` parameter type
  - `src/jobs/persistence.ts:24-32` — `JobPersistence` interface — extend with `countByStatus(status: PersistentJobStatus): Promise<number>` (async, consistent with Task 8's async-everywhere conversion)

  **Test References**:
  - `test/jobs/` — Any existing job tests for mocking patterns

  **WHY Each Reference Matters**:
  - `create-app-host.ts:173-183` shows the exact stub to replace and its position in host construction
  - `types.ts:24-30` is the contract — implementation must match exactly
  - `dispatcher.ts` shows how to dispatch jobs so `runOnce()` follows existing patterns
  - `persistence.ts` interface is what facade queries for drain status

  **Acceptance Criteria**:
  - [ ] New file: `src/app/host/maintenance-facade.ts`
  - [ ] Test file: `test/app/host/maintenance-facade.test.ts`
  - [ ] `JobPersistence` interface extended with `countByStatus(status: PersistentJobStatus): Promise<number>` in `src/jobs/persistence.ts`
  - [ ] `SqliteJobPersistence` implements `countByStatus`
  - [ ] `runOnce()` delegates to `MaintenanceOrchestrationService.runFullMaintenance()` (verified by mock)
  - [ ] `drain()` sets drain flag and is idempotent
  - [ ] `getDrainStatus()` returns `{ draining, activeJobs, pendingJobs }` using `countByStatus`
  - [ ] Stub in `create-app-host.ts:173-183` replaced with real facade instantiation
  - [ ] Tests pass: `bun test test/app/host/maintenance-facade.test.ts`

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: runOnce delegates to orchestration service fan-out
    Tool: Bash
    Preconditions: Tests written with mocked MaintenanceOrchestrationService
    Steps:
      1. Run: bun test test/app/host/maintenance-facade.test.ts --grep "runOnce"
      2. Assert: test verifies runFullMaintenance() was called on the orchestration service
      3. Assert: test verifies facade does NOT directly call enqueue() — delegation only
    Expected Result: runOnce delegates to service, which handles job dispatch internally
    Failure Indicators: Direct enqueue call, or service method not invoked
    Evidence: .sisyphus/evidence/task-15-runonce-delegates.txt

  Scenario: getDrainStatus uses async countByStatus for active/pending counts
    Tool: Bash
    Preconditions: Tests with mocked async JobPersistence including countByStatus
    Steps:
      1. Run: bun test test/app/host/maintenance-facade.test.ts --grep "getDrainStatus"
      2. Assert: countByStatus("processing") awaited for activeJobs
      3. Assert: countByStatus("pending") awaited for pendingJobs
      4. Assert: returned object matches { draining: boolean, activeJobs: number, pendingJobs: number }
    Expected Result: Drain status derived from async countByStatus, not direct DB queries
    Failure Indicators: Direct SQL queries, sync call without await, or countByStatus not called
    Evidence: .sisyphus/evidence/task-15-drain-status-countby.txt

  Scenario: drain is idempotent and stops consumers
    Tool: Bash
    Preconditions: Tests with mocked consumers
    Steps:
      1. Run: bun test test/app/host/maintenance-facade.test.ts --grep "drain"
      2. Assert: first drain() sets draining=true
      3. Assert: second drain() does not throw
      4. Assert: getDrainStatus() reflects draining=true after drain()
    Expected Result: drain sets flag, second call is no-op, status reflects state
    Failure Indicators: Second drain throws, or status not updated
    Evidence: .sisyphus/evidence/task-15-drain-idempotent.txt

  Scenario: Stub replaced in create-app-host
    Tool: Bash
    Preconditions: Implementation complete
    Steps:
      1. Run: grep -n "not yet implemented" src/app/host/create-app-host.ts
      2. Assert: zero matches (no more stub throws)
      3. Run: grep -n "maintenance-facade" src/app/host/create-app-host.ts
      4. Assert: at least one import of the new module
    Expected Result: No "not yet implemented" stubs remain for maintenance facade
    Failure Indicators: grep still finds stub throws
    Evidence: .sisyphus/evidence/task-15-stub-replaced.txt
  ```

  **Commit**: YES
  - Message: `feat(host): implement AppMaintenanceFacade with durable job dispatch`
  - Files: `src/app/host/maintenance-facade.ts`, `src/app/host/create-app-host.ts`, `test/app/host/maintenance-facade.test.ts`
  - Pre-commit: `bun test`

- [x] 16. Create MaintenanceOrchestrationService (Shared Maintenance Logic)

  **What to do**:
  - Create `src/app/host/maintenance-orchestration-service.ts` — a service that encapsulates ALL maintenance business logic currently scattered across 4 scripts
  - The service provides methods: `searchRebuild(agentId, scope, backend)`, `replayProjection(surface, backend)`, `runFullMaintenance(backend)`, `rebuildDerived(agentId, options)`
  - Each method dispatches work through the job pipeline (enqueue → claim → execute) for durability
  - PG support: For `rebuildDerived`, add PG path via `PgProjectionRebuilder` (currently missing from `memory-rebuild-derived.ts`)
  - Backend branching: The service receives `backendType` at construction and routes to SQLite or PG code paths accordingly — eliminating per-script branching
  - `AppMaintenanceFacade.runOnce()` (from Task 15) should delegate to this service's `runFullMaintenance()`
  - **Public access path**: Extend `AppMaintenanceFacade` type in `types.ts` to add optional granular methods: `searchRebuild?()`, `replayProjection?()`, `rebuildDerived?()`. The facade already has `verify?()` and `rebuild?()` optional methods, so this follows the existing pattern. In `createAppHost()`, when role is `maintenance`, the facade implementation provides these methods by delegating to the service internally. Scripts access granular operations via `host.maintenance!.searchRebuild!(...)` — keeping all access through the single facade entry point, not a second `orchestrationService` property on `AppHost`. This avoids bypassing the facade pattern.
  - Add the `MaintenanceOrchestrationService` type/class export from the new file
  - TDD: Test each method dispatches correct job type/payload; test backend routing logic

  **Must NOT do**:
  - Do NOT duplicate any existing rebuilder logic — call into existing modules (`executeSearchRebuild`, `PgSearchRebuilder`, `PgProjectionRebuilder`, etc.)
  - Do NOT add CLI arg parsing — that stays in the thin script shells (Tasks 17-20)
  - Do NOT handle database opening/closing — receive already-open connections from the host runtime

  **New Job Kinds Required** (extend `src/jobs/types.ts`):
  > The existing `JobKind` union is `"memory.migrate" | "memory.organize" | "task.run" | "search.rebuild"`.
  > Add the following new kinds for maintenance operations:
  - `"maintenance.replay_projection"` — for `replayProjection()` (surfaces: cognition, area, world)
  - `"maintenance.rebuild_derived"` — for `rebuildDerived()` (node-ref chunked organizer rebuild)
  - `"maintenance.full"` — for `runFullMaintenance()` (umbrella kind that fans out into sub-jobs)
  > NOTE: `search.rebuild` already exists and should be REUSED by `searchRebuild()` — do NOT create a duplicate.
  > Also add corresponding `ExecutionClass` entries: `"background.maintenance_replay"`, `"background.maintenance_rebuild_derived"`, `"background.maintenance_full"`.
  > Add `JOB_MAX_ATTEMPTS` entries: `maintenance.replay_projection: 2`, `maintenance.rebuild_derived: 3`, `maintenance.full: 1`.
  > Add `CONCURRENCY_CAPS` entries as appropriate (e.g., `maintenance_replay_global: 1`, `maintenance_rebuild_derived_global: 1`).
  > Handlers: Each job kind needs a handler function registered with the job consumer. Define handler mapping in the service:
  > - `search.rebuild` → existing `executeSearchRebuild` / `PgSearchRebuilder`
  > - `maintenance.replay_projection` → `PgProjectionRebuilder` methods or SQLite projection repos
  > - `maintenance.rebuild_derived` → organizer rebuild logic (currently in `memory-rebuild-derived.ts`)
  > - `maintenance.full` → fans out into individual `search.rebuild` + `maintenance.replay_projection` + `maintenance.rebuild_derived` jobs

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Must understand 4 scripts' domain logic, extract shared patterns, and wire through job pipeline
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: No UI

  **Parallelization**:
  - **Can Run In Parallel**: YES (independent of Task 15 — T15 depends on T16, not the reverse)
  - **Parallel Group**: Wave 5a (runs before Task 15)
  - **Blocks**: Task 15 (facade delegates to this service), Tasks 17-20 (scripts delegate to this service)
  - **Blocked By**: Task 9 (JobPersistence in runtime)

  **References**:

  **Pattern References**:
  - `scripts/search-rebuild.ts:1-124` — Search rebuild logic to extract (SQLite path lines 48-80, PG path lines 85-124)
  - `scripts/memory-replay.ts:1-257` — Projection replay logic (PG lines 19-68, SQLite lines 69+)
  - `scripts/memory-maintenance.ts:1-488` — Full maintenance operation (table reporting, cleanup, rebuild)
  - `scripts/memory-rebuild-derived.ts:1-194` — Derived rebuild logic (SQLite ONLY — needs PG path added)

  **API/Type References**:
  - `src/memory/search-rebuild-job.ts` — `executeSearchRebuild()`, `SearchRebuildPayload`, `SearchRebuildScope`
  - `src/memory/search-rebuild-pg.ts` — `PgSearchRebuilder`, `PgSearchRebuildScope`
  - `src/migration/pg-projection-rebuild.ts` — `PgProjectionRebuilder` (cognition, area, world rebuilds)
  - `src/jobs/persistence.ts:24-32` — `JobPersistence` interface for job dispatch
  - `src/jobs/types.ts:1-58` — `JobKind` union, `ExecutionClass`, `JOB_MAX_ATTEMPTS`, `CONCURRENCY_CAPS` — must extend all four with new maintenance kinds

  **WHY Each Reference Matters**:
  - The 4 scripts contain the actual domain logic to extract — each script shows a different maintenance concern
  - `search-rebuild-job.ts` and `search-rebuild-pg.ts` are the existing rebuilder modules the service should call
  - `pg-projection-rebuild.ts` provides PG rebuild capabilities that `memory-rebuild-derived.ts` currently lacks
  - `JobPersistence` is the dispatch mechanism — all operations go through the job pipeline

  **Acceptance Criteria**:
  - [ ] New file: `src/app/host/maintenance-orchestration-service.ts`
  - [ ] Test file: `test/app/host/maintenance-orchestration-service.test.ts`
  - [ ] `JobKind` union in `src/jobs/types.ts` extended with `maintenance.replay_projection`, `maintenance.rebuild_derived`, `maintenance.full`
  - [ ] Corresponding `ExecutionClass`, `JOB_MAX_ATTEMPTS`, and `CONCURRENCY_CAPS` entries added
  - [ ] Service has methods: `searchRebuild`, `replayProjection`, `runFullMaintenance`, `rebuildDerived`
  - [ ] Each method dispatches through `JobPersistence` with correct job kind (verified by mock)
  - [ ] `searchRebuild` reuses existing `search.rebuild` job kind (no duplicate)
  - [ ] `rebuildDerived` supports both SQLite and PG backends
  - [ ] Backend routing tested for both `sqlite` and `pg` paths
  - [ ] `AppMaintenanceFacade` type extended with optional `searchRebuild?()`, `replayProjection?()`, `rebuildDerived?()` in `types.ts`
  - [ ] `createAppHost()` wires service into maintenance facade when role is `maintenance` (facade.searchRebuild/replayProjection/rebuildDerived delegate to service internally)
  - [ ] Tests pass: `bun test test/app/host/maintenance-orchestration-service.test.ts`

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: searchRebuild dispatches correct job for SQLite backend
    Tool: Bash
    Preconditions: Service instantiated with mocked JobPersistence and backendType="sqlite"
    Steps:
      1. Run: bun test test/app/host/maintenance-orchestration-service.test.ts --grep "searchRebuild.*sqlite"
      2. Assert: enqueue called with job type matching search-rebuild
      3. Assert: payload includes agentId and scope
    Expected Result: Job dispatched with correct type and payload for SQLite path
    Failure Indicators: Wrong job type, missing payload fields, or PG path taken
    Evidence: .sisyphus/evidence/task-16-search-rebuild-sqlite.txt

  Scenario: rebuildDerived supports PG backend (was previously SQLite-only)
    Tool: Bash
    Preconditions: Service with backendType="pg" and mocked PgProjectionRebuilder
    Steps:
      1. Run: bun test test/app/host/maintenance-orchestration-service.test.ts --grep "rebuildDerived.*pg"
      2. Assert: PG projection rebuilder is called (not SQLite path)
      3. Assert: Job is dispatched through job pipeline
    Expected Result: PG path exercised, job dispatched durably
    Failure Indicators: "not implemented" error, or SQLite code path taken for PG backend
    Evidence: .sisyphus/evidence/task-16-rebuild-derived-pg.txt

  Scenario: runFullMaintenance orchestrates all sub-operations
    Tool: Bash
    Preconditions: Service with all mocked dependencies
    Steps:
      1. Run: bun test test/app/host/maintenance-orchestration-service.test.ts --grep "runFullMaintenance"
      2. Assert: Multiple jobs dispatched covering all maintenance concerns
    Expected Result: Full maintenance dispatches jobs for rebuild, replay, and derived operations
    Failure Indicators: Missing job types, or operations executed inline instead of through job queue
    Evidence: .sisyphus/evidence/task-16-full-maintenance.txt

  Scenario: New job kinds registered in types.ts
    Tool: Bash
    Preconditions: Job kinds added
    Steps:
      1. Run: grep "maintenance.replay_projection\|maintenance.rebuild_derived\|maintenance.full" src/jobs/types.ts
      2. Assert: All 3 new kinds appear in JobKind union
      3. Run: grep "maintenance" src/jobs/types.ts | grep -c "JOB_MAX_ATTEMPTS\|CONCURRENCY_CAPS\|EXECUTION_CLASS_PRIORITY"
      4. Assert: ≥3 lines (entries in all relevant maps)
    Expected Result: Job type system knows about all new maintenance operations
    Failure Indicators: Missing kinds in union, or missing entries in constants
    Evidence: .sisyphus/evidence/task-16-job-kinds.txt
  ```

  **Commit**: YES
  - Message: `feat(host): create MaintenanceOrchestrationService consolidating script logic`
  - Files: `src/app/host/maintenance-orchestration-service.ts`, `src/jobs/types.ts`, `test/app/host/maintenance-orchestration-service.test.ts`
  - Pre-commit: `bun test`

- [x] 17. Rewrite `search-rebuild.ts` as Thin Shell over MaintenanceOrchestrationService

  **What to do**:
  - Rewrite `scripts/search-rebuild.ts` to:
    1. Parse CLI args (keep existing `--agent`, `--scope`, `--backend`, `--pg-url` flags)
    2. Bootstrap via `createAppHost({ role: "maintenance" })` to get a fully wired runtime
    3. Access the maintenance facade via `host.maintenance!.searchRebuild!(agentId, scope, backend)` instead of doing manual DB open / migration / direct rebuilder calls
    4. Await result, print summary, shut down host via `host.shutdown()`
  - The script should be ~30-40 lines max — all domain logic lives in the service
  - No manual `openDatabase()`, no `runMemoryMigrations()`, no `SqliteJobPersistence` construction, no `PgBackendFactory` — all handled by runtime bootstrap
  - Remove direct imports of `persistence.js`, `schema.js`, `search-rebuild-job.js`, `search-rebuild-pg.js`, `backend-types.js`, `database.js`

  **Must NOT do**:
  - Do NOT change the CLI interface (flags, help text, exit codes) — backward compatible
  - Do NOT move/rename the script file
  - Do NOT add new features beyond what the script already does

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Straightforward rewrite — delete logic, replace with service call
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 18, 19, 20)
  - **Parallel Group**: Wave 6
  - **Blocks**: None
  - **Blocked By**: Task 16 (MaintenanceOrchestrationService must exist)

  **References**:

  **Pattern References**:
  - `scripts/search-rebuild.ts:1-124` — Current implementation to rewrite
  - `src/app/host/maintenance-orchestration-service.ts` — Service to delegate to (from Task 16)

  **API/Type References**:
  - `src/app/host/create-app-host.ts:64-67` — `createAppHost()` signature for maintenance bootstrap
  - `src/app/host/types.ts:32-48` — `AppHostOptions` for role/config options

  **WHY Each Reference Matters**:
  - Current script shows exact CLI interface to preserve
  - Service provides the replacement API — just call it instead of manual DB/rebuilder code
  - `createAppHost` replaces all manual bootstrap logic

  **Acceptance Criteria**:
  - [ ] `scripts/search-rebuild.ts` rewritten to use `createAppHost` + `MaintenanceOrchestrationService`
  - [ ] No direct imports of `persistence.js`, `schema.js`, `database.js`, `search-rebuild-job.js`, `search-rebuild-pg.js`, `backend-types.js`
  - [ ] CLI interface unchanged: `--agent`, `--scope`, `--backend`, `--pg-url` all still work
  - [ ] Script is ≤50 lines
  - [ ] Type-checks: `bun run build` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Script has no direct DB/migration/rebuilder imports
    Tool: Bash
    Preconditions: Script rewritten
    Steps:
      1. Run: grep -c "openDatabase\|runMemoryMigrations\|SqliteJobPersistence\|PgBackendFactory\|executeSearchRebuild\|PgSearchRebuilder" scripts/search-rebuild.ts
      2. Assert: 0 matches
      3. Run: grep -c "createAppHost\|maintenance" scripts/search-rebuild.ts
      4. Assert: ≥1 match for createAppHost usage
    Expected Result: Script delegates entirely to service, no manual bootstrap
    Failure Indicators: Direct DB/migration imports still present
    Evidence: .sisyphus/evidence/task-17-search-rebuild-thin.txt

  Scenario: CLI flags still parse correctly
    Tool: Bash
    Preconditions: Script rewritten
    Steps:
      1. Run: grep -c "parseArgs\|--agent\|--scope\|--backend\|--pg-url" scripts/search-rebuild.ts
      2. Assert: parseArgs present, all 4 flags defined
      3. Run: wc -l scripts/search-rebuild.ts
      4. Assert: ≤50 lines
    Expected Result: CLI interface preserved, script is thin
    Failure Indicators: Missing flags, or script >50 lines
    Evidence: .sisyphus/evidence/task-17-search-rebuild-cli.txt
  ```

  **Commit**: YES (groups with 18, 19, 20)
  - Message: `refactor(scripts): rewrite maintenance scripts as thin shells over orchestration service`
  - Files: `scripts/search-rebuild.ts`, `scripts/memory-replay.ts`, `scripts/memory-maintenance.ts`, `scripts/memory-rebuild-derived.ts`
  - Pre-commit: `bun run build`

- [x] 18. Rewrite `memory-replay.ts` as Thin Shell over MaintenanceOrchestrationService

  **What to do**:
  - Rewrite `scripts/memory-replay.ts` to:
    1. Parse CLI args (keep existing `--surface`, `--backend`, `--pg-url`, `--db-path` flags)
    2. Bootstrap via `createAppHost({ role: "maintenance" })`
    3. Access the maintenance facade via `host.maintenance!.replayProjection!(surface, backend)` instead of manual rebuilder construction
    4. Await result, print summary, shut down host via `host.shutdown()`
  - Current script is 257 lines with manual SQLite/PG branching, projection repo instantiation, event replay loops — all of this moves to the service
  - The thin shell should be ~30-40 lines

  **Must NOT do**:
  - Do NOT change CLI interface or exit behavior
  - Do NOT remove/rename the script file

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Same pattern as Task 17 — delete logic, delegate to service
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 17, 19, 20)
  - **Parallel Group**: Wave 6
  - **Blocks**: None
  - **Blocked By**: Task 16

  **References**:

  **Pattern References**:
  - `scripts/memory-replay.ts:1-257` — Current implementation to rewrite
  - `scripts/search-rebuild.ts` (post-Task 17) — Sibling script as pattern example

  **API/Type References**:
  - `src/app/host/maintenance-orchestration-service.ts` — `replayProjection()` method

  **WHY Each Reference Matters**:
  - Current script shows CLI interface to preserve
  - Post-Task 17 search-rebuild shows the exact thin-shell pattern to follow

  **Acceptance Criteria**:
  - [ ] `scripts/memory-replay.ts` rewritten as thin shell
  - [ ] No direct imports of `database.js`, `schema.js`, `cognition-current.js`, `area-world-projection-repo.js`, `backend-types.js`, `pg-projection-rebuild.js`
  - [ ] CLI flags preserved: `--surface`, `--backend`, `--pg-url`, `--db-path`
  - [ ] Script is ≤50 lines
  - [ ] Type-checks: `bun run build` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Script has no direct projection/DB imports
    Tool: Bash
    Preconditions: Script rewritten
    Steps:
      1. Run: grep -c "openDatabase\|PrivateCognitionProjectionRepo\|AreaWorldProjectionRepo\|PgProjectionRebuilder\|PgBackendFactory" scripts/memory-replay.ts
      2. Assert: 0 matches
      3. Run: grep -c "createAppHost" scripts/memory-replay.ts
      4. Assert: ≥1 match
    Expected Result: All domain logic delegated, script is thin shell
    Failure Indicators: Direct projection/DB imports remain
    Evidence: .sisyphus/evidence/task-18-memory-replay-thin.txt

  Scenario: Script line count confirms thin shell
    Tool: Bash
    Preconditions: Script rewritten
    Steps:
      1. Run: wc -l scripts/memory-replay.ts
      2. Assert: ≤50 lines (was 257)
    Expected Result: ~85% reduction in script size
    Failure Indicators: >50 lines indicates logic not fully extracted
    Evidence: .sisyphus/evidence/task-18-memory-replay-lines.txt
  ```

  **Commit**: YES (groups with 17, 19, 20)
  - Message: (grouped with Task 17 commit)
  - Files: (grouped)
  - Pre-commit: `bun run build`

- [x] 19. Rewrite `memory-maintenance.ts` as Thin Shell over MaintenanceOrchestrationService

  **What to do**:
  - Rewrite `scripts/memory-maintenance.ts` to:
    1. Parse CLI args (keep existing flags — likely `--backend`, `--pg-url`, `--db-path` or similar)
    2. Bootstrap via `createAppHost({ role: "maintenance" })`
    3. Access the maintenance facade via `host.maintenance!.runOnce()` instead of the 488-line manual maintenance logic (runOnce delegates to the orchestration service internally)
    4. Await result, print summary, shut down host via `host.shutdown()`
  - This is the largest script (488 lines) with table reporting, selective cleanup, backend branching — ALL moves to the service
  - The thin shell should be ~25-35 lines

  **Must NOT do**:
  - Do NOT change the maintenance report output format (if the service returns structured data, the script formats it the same way)
  - Do NOT remove/rename the script file

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Same thin-shell pattern
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 17, 18, 20)
  - **Parallel Group**: Wave 6
  - **Blocks**: None
  - **Blocked By**: Task 16

  **References**:

  **Pattern References**:
  - `scripts/memory-maintenance.ts:1-488` — Current implementation to rewrite (488 lines!)
  - `scripts/search-rebuild.ts` (post-Task 17) — Thin-shell pattern example

  **API/Type References**:
  - `src/app/host/maintenance-orchestration-service.ts` — `runFullMaintenance()` method

  **WHY Each Reference Matters**:
  - Current script has the most complex logic to extract — understanding its structure helps verify nothing is lost
  - Post-Task 17 script provides the template pattern

  **Acceptance Criteria**:
  - [ ] `scripts/memory-maintenance.ts` rewritten as thin shell
  - [ ] No direct imports of `config.js`, `schema.js`, `database.js`, `backend-types.js`
  - [ ] Script is ≤50 lines (was 488)
  - [ ] Type-checks: `bun run build` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Script eliminates 488-line manual maintenance
    Tool: Bash
    Preconditions: Script rewritten
    Steps:
      1. Run: wc -l scripts/memory-maintenance.ts
      2. Assert: ≤50 lines (was 488)
      3. Run: grep -c "openDatabase\|runMemoryMigrations\|CANONICAL_LEDGER_TABLES\|REPORT_TABLES" scripts/memory-maintenance.ts
      4. Assert: 0 matches (constants moved to service)
    Expected Result: ~90% reduction, all logic in service
    Failure Indicators: >50 lines, or table constants still in script
    Evidence: .sisyphus/evidence/task-19-memory-maintenance-thin.txt
  ```

  **Commit**: YES (groups with 17, 18, 20)
  - Message: (grouped with Task 17 commit)
  - Files: (grouped)
  - Pre-commit: `bun run build`

- [x] 20. Rewrite `memory-rebuild-derived.ts` as Thin Shell + Add PG Support

  **What to do**:
  - Rewrite `scripts/memory-rebuild-derived.ts` to:
    1. Parse CLI args (keep existing `--agent`, `--dry-run`, `--re-embed` flags; ADD `--backend` and `--pg-url` flags for PG support)
    2. Bootstrap via `createAppHost({ role: "maintenance" })`
    3. Access the maintenance facade via `host.maintenance!.rebuildDerived!(agentId, { dryRun, reEmbed, backend })` instead of manual node-ref loading, chunking, and job enqueuing
    4. Await result, print summary, shut down host via `host.shutdown()`
  - This script currently has NO PG support — the service (Task 16) adds PG path, so this script automatically gains it via the `--backend pg` flag
  - Current script is 194 lines with manual SQLite job persistence, chunk computation — all moves to service
  - Thin shell should be ~30-40 lines

  **Must NOT do**:
  - Do NOT implement PG rebuild logic in the script itself — it's in `MaintenanceOrchestrationService`
  - Do NOT remove/rename the script file
  - Do NOT break existing `--dry-run` and `--re-embed` behavior

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Same thin-shell pattern as Tasks 17-19, with minor addition of 2 new CLI flags
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 17, 18, 19)
  - **Parallel Group**: Wave 6
  - **Blocks**: None
  - **Blocked By**: Task 16

  **References**:

  **Pattern References**:
  - `scripts/memory-rebuild-derived.ts:1-194` — Current implementation to rewrite (SQLite-only, 194 lines)
  - `scripts/search-rebuild.ts` (post-Task 17) — Thin-shell pattern + `--backend`/`--pg-url` flag handling pattern

  **API/Type References**:
  - `src/app/host/maintenance-orchestration-service.ts` — `rebuildDerived(agentId, options)` method

  **WHY Each Reference Matters**:
  - Current script shows existing CLI interface to preserve + what dry-run means
  - Post-Task 17 search-rebuild has the `--backend`/`--pg-url` flag pattern to copy

  **Acceptance Criteria**:
  - [ ] `scripts/memory-rebuild-derived.ts` rewritten as thin shell
  - [ ] New flags: `--backend` (default: "sqlite") and `--pg-url` added
  - [ ] No direct imports of `persistence.js`, `schema.js`, `database.js`, `task-agent.js`
  - [ ] Script is ≤50 lines (was 194)
  - [ ] Type-checks: `bun run build` passes

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Script gains PG support via new flags
    Tool: Bash
    Preconditions: Script rewritten
    Steps:
      1. Run: grep -c "\-\-backend\|\-\-pg-url" scripts/memory-rebuild-derived.ts
      2. Assert: ≥2 matches (both flags present)
      3. Run: grep -c "SqliteJobPersistence\|ORGANIZER_CHUNK_SIZE\|openDatabase" scripts/memory-rebuild-derived.ts
      4. Assert: 0 matches (logic moved to service)
    Expected Result: PG flags added, SQLite-specific logic removed
    Failure Indicators: Missing new flags, or old direct imports remain
    Evidence: .sisyphus/evidence/task-20-rebuild-derived-pg-support.txt

  Scenario: Script is thin shell
    Tool: Bash
    Preconditions: Script rewritten
    Steps:
      1. Run: wc -l scripts/memory-rebuild-derived.ts
      2. Assert: ≤50 lines (was 194)
      3. Run: grep -c "createAppHost" scripts/memory-rebuild-derived.ts
      4. Assert: ≥1 match
    Expected Result: ~75% reduction, delegates to service via host
    Failure Indicators: >50 lines
    Evidence: .sisyphus/evidence/task-20-rebuild-derived-thin.txt
  ```

  **Commit**: YES (groups with 17, 18, 19)
  - Message: (grouped with Task 17 commit)
  - Files: (grouped)
  - Pre-commit: `bun run build`

- [ ] 21. Add Orchestration State to Admin Introspection (R9: Observability)

  **What to do**:
  - Extend `AppHostAdmin.getHostStatus()` in `create-app-host.ts:186-192` to include orchestration state:
    - `orchestration.enabled: boolean` — whether job consumers are wired (i.e., role is server/worker with durable mode)
    - `orchestration.role: AppRole` — current host role
    - `orchestration.durableMode: boolean` — whether durable job processing is active
    - `orchestration.leaseReclaimActive: boolean` — whether lease-reclaim sweeper is running
    - `orchestration.drainStatus: { draining, activeJobs, pendingJobs }` — from maintenance facade if available
  - Update `HostStatusDTO` in `types.ts:50-54` to include the new `orchestration` field (optional, to avoid breaking non-orchestrated hosts)
  - Update `AppHostAdmin.getCapabilities()` to return orchestration capability flags
  - TDD: Test that admin returns correct orchestration state for each role

  **Must NOT do**:
  - Do NOT add new API endpoints — this extends the existing admin facade
  - Do NOT expose internal job queue implementation details (table names, SQL queries, etc.)
  - Do NOT make `orchestration` a required field — keep it optional so pre-orchestration hosts still work

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Touches types + implementation + needs awareness of all orchestration components built in prior waves
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on many prior tasks)
  - **Parallel Group**: Wave 7 (solo)
  - **Blocks**: None (final implementation task)
  - **Blocked By**: Tasks 10, 11, 12, 15 (all orchestration components must exist to report their state)

  **References**:

  **Pattern References**:
  - `src/app/host/create-app-host.ts:185-207` — Current admin implementation to extend
  - `src/app/host/create-app-host.ts:216-221` — `start()` shows how role gating works

  **API/Type References**:
  - `src/app/host/types.ts:16-22` — `AppHostAdmin` type to extend
  - `src/app/host/types.ts:50-54` — `HostStatusDTO` to extend with `orchestration?` field
  - `src/app/host/types.ts:7` — `AppRole` type for role field

  **Test References**:
  - `test/app/host/role-boundaries.test.ts` (from Task 14) — Test patterns for role-specific assertions

  **WHY Each Reference Matters**:
  - `create-app-host.ts:185-207` is the exact code to modify — add orchestration fields to the return object
  - `types.ts:50-54` defines the response shape — must add optional `orchestration` field
  - Task 14's role boundary tests provide the pattern for role-specific admin assertions

  **Acceptance Criteria**:
  - [ ] `HostStatusDTO` extended with optional `orchestration` field in `types.ts`
  - [ ] `getHostStatus()` returns orchestration state when orchestration is active
  - [ ] `getCapabilities()` returns orchestration capability flags
  - [ ] Test file: `test/app/host/admin-orchestration.test.ts`
  - [ ] Server role reports `orchestration.enabled: true`, `durableMode` reflects config
  - [ ] Local role reports `orchestration.enabled: false` or omits field
  - [ ] Tests pass: `bun test test/app/host/admin-orchestration.test.ts`

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Server role returns orchestration state
    Tool: Bash
    Preconditions: Tests with server-role AppHost
    Steps:
      1. Run: bun test test/app/host/admin-orchestration.test.ts --grep "server.*orchestration"
      2. Assert: test verifies orchestration.enabled === true
      3. Assert: test verifies orchestration.role === "server"
      4. Assert: test verifies orchestration.durableMode is boolean
      5. Assert: test verifies orchestration.leaseReclaimActive is boolean
    Expected Result: All orchestration fields present and typed correctly for server role
    Failure Indicators: Missing fields, wrong types, or undefined orchestration
    Evidence: .sisyphus/evidence/task-21-server-orchestration.txt

  Scenario: Local role omits or disables orchestration
    Tool: Bash
    Preconditions: Tests with local-role AppHost
    Steps:
      1. Run: bun test test/app/host/admin-orchestration.test.ts --grep "local.*orchestration"
      2. Assert: orchestration.enabled === false OR orchestration field is undefined
    Expected Result: Local role does not claim orchestration capability
    Failure Indicators: Local role shows orchestration.enabled === true
    Evidence: .sisyphus/evidence/task-21-local-no-orchestration.txt

  Scenario: getCapabilities includes orchestration flags
    Tool: Bash
    Preconditions: Tests written
    Steps:
      1. Run: bun test test/app/host/admin-orchestration.test.ts --grep "capabilities"
      2. Assert: getCapabilities() returns object with orchestration-related keys
    Expected Result: Capabilities reflect what's actually wired
    Failure Indicators: Empty capabilities object (still returns {})
    Evidence: .sisyphus/evidence/task-21-capabilities.txt
  ```

  **Commit**: YES
  - Message: `feat(host): expose orchestration state in admin introspection (R9)`
  - Files: `src/app/host/types.ts`, `src/app/host/create-app-host.ts`, `test/app/host/admin-orchestration.test.ts`
  - Pre-commit: `bun test`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle` (subagent_type, not category)

  **What to do**:
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: All "Must Have" deliverables present
    Tool: Bash
    Preconditions: All 21 tasks completed
    Steps:
      1. Run: test -f src/jobs/job-persistence-factory.ts && echo "EXISTS" || echo "MISSING"
      2. Assert: EXISTS (JobPersistence factory from Task 8)
      3. Run: test -f src/app/host/maintenance-facade.ts && echo "EXISTS" || echo "MISSING"
      4. Assert: EXISTS (AppMaintenanceFacade from Task 15)
      5. Run: test -f src/app/host/maintenance-orchestration-service.ts && echo "EXISTS" || echo "MISSING"
      6. Assert: EXISTS (MaintenanceOrchestrationService from Task 16)
      7. Run: test -f src/jobs/lease-reclaim-sweeper.ts && echo "EXISTS" || echo "MISSING"
      8. Assert: EXISTS (Lease reclaim sweeper from Task 12)
      9. Run: grep -r "not yet implemented" src/app/host/create-app-host.ts || echo "CLEAN"
      10. Assert: Output is "CLEAN" (facade stubs replaced)
    Expected Result: All planned files exist, no stubs remain
    Evidence: .sisyphus/evidence/f1-must-have-audit.txt

  Scenario: All "Must NOT Have" patterns absent
    Tool: Bash
    Preconditions: All tasks completed
    Steps:
      1. Run: grep -r "bootstrapApp\|AppBootstrapResult" src/ scripts/ test/ --include="*.ts" || echo "CLEAN"
      2. Assert: Output is "CLEAN"
      3. Run: grep -r "local-runtime" src/ scripts/ test/ --include="*.ts" || echo "CLEAN"
      4. Assert: Output is "CLEAN"
      5. Run: grep -r "Phase 2A\|Phase 2B\|Phase 2C" test/ --include="*.ts" || echo "CLEAN"
      6. Assert: Output is "CLEAN"
      7. Run: grep "AppClients" src/app/clients/app-clients.ts || echo "CLEAN"
      8. Assert: Output is "CLEAN"
    Expected Result: Zero forbidden patterns in codebase
    Evidence: .sisyphus/evidence/f1-must-not-have-audit.txt
  ```

  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`

  **What to do**:
  Run `bun run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp). Verify no `bun:sqlite` imports outside allowed paths.

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Build and tests pass
    Tool: Bash
    Preconditions: All tasks completed
    Steps:
      1. Run: bun run build
      2. Assert: Exit code 0, zero type errors
      3. Run: bun test
      4. Assert: Exit code 0, all tests pass
    Expected Result: Clean build + full test pass
    Evidence: .sisyphus/evidence/f2-build-test.txt

  Scenario: No code quality violations in new/changed files
    Tool: Bash
    Preconditions: Build passes
    Steps:
      1. Run: grep -rn "as any\|@ts-ignore\|@ts-expect-error" src/app/host/maintenance-facade.ts src/app/host/maintenance-orchestration-service.ts src/jobs/job-persistence-factory.ts src/jobs/lease-reclaim-sweeper.ts || echo "CLEAN"
      2. Assert: Output is "CLEAN"
      3. Run: grep -rn "console\.log" src/app/host/maintenance-facade.ts src/app/host/maintenance-orchestration-service.ts src/jobs/job-persistence-factory.ts src/jobs/lease-reclaim-sweeper.ts || echo "CLEAN"
      4. Assert: Output is "CLEAN" (no console.log in production code)
    Expected Result: Zero code quality violations in new files
    Evidence: .sisyphus/evidence/f2-code-quality.txt
  ```

  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`

  **What to do**:
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration: bootstrap with `role: "worker"` and verify job consumer starts; bootstrap with `role: "server"` + `enableDurableOrchestration: true` and verify full pipeline. Run maintenance scripts with `--dry-run`. Save to `.sisyphus/evidence/final-qa/`.

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Cross-task integration — worker role bootstraps and processes a job
    Tool: Bash
    Preconditions: All orchestration tasks (8-16) completed, bun test passes
    Steps:
      1. Run: bun test test/pg-app/phase2b-gate.test.ts --grep "worker"
      2. Assert: Worker role tests pass (job consumer starts, claims jobs, processes to completion)
      3. Run: bun test test/app/host/ --grep "worker\|consumer"
      4. Assert: All worker integration tests pass
    Expected Result: Worker role bootstraps with job consumer, processes enqueued jobs
    Failure Indicators: Consumer not started, jobs stuck in pending, timeout on claim
    Evidence: .sisyphus/evidence/f3-worker-integration.txt

  Scenario: Cross-task integration — server durable mode dispatches through job pipeline
    Tool: Bash
    Preconditions: All orchestration tasks completed
    Steps:
      1. Run: bun test test/pg-app/phase2c-gate.test.ts --grep "durable\|server"
      2. Assert: Server durable mode tests pass (jobs enqueued, not fire-and-forget)
      3. Run: grep -r "fire.and.forget\|without durable" src/memory/task-agent.ts || echo "CLEAN"
      4. Assert: Output is "CLEAN" (fallback removed per Task 13)
    Expected Result: Server mode routes all jobs through durable pipeline
    Failure Indicators: Fire-and-forget fallback still present, jobs executed inline
    Evidence: .sisyphus/evidence/f3-server-durable-integration.txt

  Scenario: Cross-task integration — maintenance scripts delegate to orchestration service
    Tool: Bash
    Preconditions: All tasks including scripts (17-20) completed
    Steps:
      1. Run: grep -c "host\.maintenance\!" scripts/search-rebuild.ts scripts/memory-replay.ts scripts/memory-maintenance.ts scripts/memory-rebuild-derived.ts
      2. Assert: Each script delegates through the maintenance facade (≥1 match per file)
      3. Run: grep -c "openDatabase\|SqliteJobPersistence\|PgBackendFactory" scripts/search-rebuild.ts scripts/memory-replay.ts scripts/memory-maintenance.ts scripts/memory-rebuild-derived.ts || echo "CLEAN"
      4. Assert: Output is "CLEAN" (no direct DB/persistence construction in scripts)
      5. Run: bun run build
      6. Assert: Build passes (scripts compile with new imports)
    Expected Result: All 4 scripts are thin shells delegating to shared service
    Failure Indicators: Scripts still contain direct DB/rebuilder logic
    Evidence: .sisyphus/evidence/f3-script-convergence.txt

  Scenario: All individual task evidence files exist
    Tool: Bash
    Preconditions: All tasks completed
    Steps:
      1. Run: ls .sisyphus/evidence/task-*.txt 2>/dev/null | wc -l
      2. Assert: ≥21 evidence files (one per task minimum)
    Expected Result: Evidence trail exists for all tasks
    Evidence: .sisyphus/evidence/f3-evidence-audit.txt
  ```

  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`

  **What to do**:
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Verify no "Phase 2A/2B/2C" terminology remains, no `bootstrapApp` imports, no `local-runtime.js` imports. Flag unaccounted changes.

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: No scope creep — only planned files modified
    Tool: Bash
    Preconditions: All tasks completed, all commits made
    Steps:
      1. Run: git diff --name-only HEAD~16..HEAD (adjust count for actual commit range)
      2. Collect list of changed files
      3. Compare against planned file list from each task's commit section
      4. Assert: No files changed that aren't listed in any task
    Expected Result: Every changed file traceable to a specific task
    Evidence: .sisyphus/evidence/f4-scope-fidelity.txt

  Scenario: "Must NOT do" compliance across all tasks
    Tool: Bash
    Preconditions: All tasks completed
    Steps:
      1. Run: grep -rn "bootstrapApp" src/ scripts/ test/ --include="*.ts" || echo "CLEAN"
      2. Assert: "CLEAN"
      3. Run: grep -rn "not yet implemented" src/app/host/ || echo "CLEAN"
      4. Assert: "CLEAN"
      5. Run: test ! -f src/bootstrap/app-bootstrap.ts && echo "DELETED" || echo "EXISTS"
      6. Assert: "DELETED"
    Expected Result: All explicit exclusions honored
    Evidence: .sisyphus/evidence/f4-must-not-do.txt
  ```

  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| Wave | Commit | Message | Files | Pre-commit |
|------|--------|---------|-------|-----------|
| 1 | 1 | `chore: delete broken RP test scripts` | 4 scripts | `bun run build` |
| 1 | 2 | `refactor: migrate start-dev + tests from bootstrapApp to createAppHost` | start-dev.ts, acceptance.test.ts, debug-commands.test.ts | `bun run build && bun test` |
| 1 | 3 | `refactor: narrow RuntimeBootstrapResult, remove internal fields from export` | types.ts + consumers | `bun run build && bun test` |
| 1 | 4 | `chore: rename test gate descriptions, update doc terminology, remove AppClients alias` | gate tests, docs, app-clients.ts | `bun run build && bun test` |
| 1.5 | 5 | `chore: delete bootstrapApp shim and AppBootstrapResult type` | app-bootstrap.ts, types.ts | `bun run build && bun test` |
| 2 | 6 | `feat(jobs): backend-neutral JobPersistence factory with TDD` | job-persistence-factory.ts + tests | `bun test src/jobs/` |
| 2 | 7 | `feat(bootstrap): inject JobPersistence into runtime bootstrap` | runtime.ts | `bun run build && bun test` |
| 3 | 8 | `feat(host): implement worker role with durable job consumer` | create-app-host.ts + tests | `bun test` |
| 3 | 9 | `feat(host): implement server durable mode with job consumers` | create-app-host.ts + tests | `bun test` |
| 3 | 10 | `feat(memory): strict durable mode, remove fire-and-forget fallback` | task-agent.ts + tests | `bun test` |
| 4 | 11 | `feat(jobs): lease reclaim sweeper with 60s interval` | lease-reclaim-sweeper.ts + tests | `bun test` |
| 4 | 12 | `test: role boundary acceptance tests (R10)` | test files | `bun test` |
| 5a | 13 | `feat(host): MaintenanceOrchestrationService for unified maintenance ops` | maintenance-orchestration-service.ts, types.ts + tests | `bun test` |
| 5b | 14 | `feat(host): implement AppMaintenanceFacade with real drain/runOnce` | maintenance-facade.ts, create-app-host.ts, persistence.ts + tests | `bun test` |
| 6 | 15 | `refactor(scripts): rewrite maintenance scripts as thin shells over shared service` | 4 scripts | `bun run build` |
| 7 | 16 | `feat(admin): orchestration status in AppHostAdmin introspection` | types.ts, create-app-host.ts + tests | `bun test` |

---

## Success Criteria

### Verification Commands
```bash
bun run build              # Expected: 0 errors
bun test                   # Expected: all pass
grep -r "bootstrapApp" src/ scripts/ test/  # Expected: 0 results
grep -r "local-runtime" src/ scripts/ test/ # Expected: 0 results  
grep -r "Phase 2A\|Phase 2B\|Phase 2C" test/ # Expected: 0 results
grep -r "AppClients" src/ --include="*.ts" | grep -v "deprecated" # Expected: 0 results
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All existing tests pass
- [ ] All new TDD tests pass
- [ ] Worker role starts job consumer
- [ ] Server durable mode starts consumer + lease reclaim
- [ ] Maintenance scripts delegate to shared service
- [ ] Admin introspection reports orchestration state
