# Application Layer Wiring Closeout

## TL;DR

> **Quick Summary**: Unify MaidsClaw's application layer behind a role-aware `AppHost` factory with typed facades (`AppUserFacade` / `AppHostAdmin` / `AppMaintenanceFacade`), async-ify `SessionService`, absorb flush logic into facade `closeSession()`, migrate `InteractionStore` → `InteractionRepo`, unify CLI/gateway mode branching through a single facade contract, and restructure tests into 4 acceptance tiers.
>
> **Deliverables**:
> - `createAppHost()` async factory with role-aware facet matrix
> - `AppUserFacade` (evolved from `AppClients`) as unified CLI/gateway contract
> - `AppHostAdmin` with typed `HostStatusDTO` / `PipelineStatusDTO`
> - `AppMaintenanceFacade` narrow core skeleton
> - `SessionService` 7 methods async + 2 aliases deprecated
> - Flush decision matrix (A034) absorbed into facade `closeSession()`
> - `InteractionStore` → `InteractionRepo` in all facade/edge code
> - 8 CLI commands + gateway + slash dispatcher migrated to facades
> - 4-tier test script structure in `package.json`
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 5 waves
> **Critical Path**: Task 1 → Task 5 → Task 6 → Task 10 → Task 15 → Task 18 → Task 19 → F1-F4

---

## Context

### Original Request
Execute the "Application Layer Wiring Closeout" as defined in `docs/APP_LAYER_WIRING_CONSENSUS_2026-03-30.zh-CN.md` (decisions A001-A035). The consensus document constrains the development direction; specific implementation may adjust based on actual circumstances.

### Key Research Findings

**Bootstrap Chain (Current)**:
- `bootstrapRuntime()` → 27-field `RuntimeBootstrapResult` (raw services, DB, registries)
- `bootstrapApp()` → wraps runtime, optionally adds `GatewayServer`, returns `AppBootstrapResult`
- `createAppClientRuntime()` → CLI mode-aware wrapper with `AppClients` facade

**InteractionStore Triple Instantiation**:
- `runtime.ts:265` — authoritative instance (wrapped by `SqliteInteractionRepoAdapter`)
- `app-clients.ts:28` — redundant `new InteractionStore(runtime.db)`
- `local-runtime.ts:15` — redundant `new InteractionStore(runtime.db)`

**SessionService (All 9 Methods SYNC)**:
- 7 canonical: `createSession`, `getSession`, `closeSession`, `isOpen`, `markRecoveryRequired`, `clearRecoveryRequired`, `requiresRecovery`
- 2 deprecated aliases: `setRecoveryRequired` → `markRecoveryRequired`, `isRecoveryRequired` → `requiresRecovery`
- Dual-mode constructor `(db?: Db)` — preserved this round

**Three Close Paths (All Different Behaviors)**:
1. CLI `session.ts:155-161`: close → flush (WRONG order), failure silently ignored
2. Gateway `controllers.ts:506-512`: flush → close (correct order), failure propagates by accident
3. Slash `/close` `slash-dispatcher.ts:316-332`: close only, NO flush at all

**GatewayServer**: Constructor takes 7 scattered params including `runtime?`, `start()/stop()` both sync

**Existing `AppClients` = Future `AppUserFacade`**: Identical `{session, turn, inspect, health}` structure

**`SessionRepo` Interface Already Exists**: `src/storage/domain-repos/contracts/session-repo.ts` — async target contract for future PG migration

### Metis Review

**Identified Gaps (addressed)**:
- `controllers.ts:344` `ctx.sessionService.getSession()` — MISSED by consensus A028 caller list → added to async migration
- Slash `/close` handler — third close path with NO flush → added as flush migration target
- Test files calling SessionService directly (14 files, critical: `turn-service-run-user-turn.test.ts`) → included in async wave
- `handleCloseSession` creates ephemeral `LocalSessionClient` per request → replaced with stable `AppHost.user.session`
- Gateway flush conditional `if (ctx.turnService && session?.agent_id)` maps to `"skipped_no_agent"` but currently untracked → facade handles

**Auto-Resolved Defaults**:
- `PendingSettlementSweeper` lifecycle: internal detail of `AppHost.shutdown()`, not surfaced through maintenance facade
- `TraceStore` routing: internal wiring of `AppHost`, injected into turn execution implicitly
- `LocalRuntime`: deleted after SessionShell migrates to facades (per A018)
- Test tier structure: implemented as `package.json` script entries with glob patterns, not file moves

---

## Work Objectives

### Core Objective
Replace the fragmented bootstrap/runtime/client stack with a unified role-aware `AppHost` that exposes typed facades, ensuring the facade layer serves as a zero-change isolation seam for the upcoming PG backend migration.

### Concrete Deliverables
- `src/app/host/` — `AppHost` types, factory, facade implementations
- `src/session/service.ts` — async method signatures
- `src/app/clients/` — `AppClients` evolved to `AppUserFacade`
- 8 CLI command files migrated to consume `AppHost`
- `src/gateway/server.ts` + `controllers.ts` — facade-based, no raw runtime
- `src/terminal-cli/shell/slash-dispatcher.ts` — mode branches eliminated
- `package.json` — 4-tier test scripts
- New test suites: `test/app/app-host.test.ts`, `test/app/session-close-flush.test.ts`

### Definition of Done
- [ ] `bun run build` passes (zero TypeScript errors)
- [ ] `bun test` passes WITHOUT PG running (hermetic baseline — PG tests skip, not fail)
- [ ] `bun run test:acceptance:app-host` passes (new app-host surface tests)
- [ ] `bun run test:acceptance:closeout` passes (aggregate gate, requires PG for data-plane tier)
- [ ] Zero `RuntimeBootstrapResult` references in `src/app/clients/`, `src/terminal-cli/commands/`, `src/terminal-cli/shell/`
- [ ] Zero `_internal.runtime` or raw runtime escape hatches on `AppHost`
- [ ] Zero `InteractionStore` imports outside `src/interaction/` and `src/storage/`
- [ ] Zero mode-branching `if (mode === "gateway") ... else ...` in slash-dispatcher.ts
- [ ] All facade methods return `Promise<T>`
- [ ] All SessionService callers have proper `await` (no unawaited promises)

### Must Have
- All facade method signatures are async (A025 — PG migration isolation seam)
- `AppHost` facet matrix matches A022 role rules (including: server gets `maintenance` only when explicitly enabled)
- `AppHost.getBoundPort()` for server role returns actual bound port after `start()` (port: 0 safe)
- `closeSession()` absorbs flush as pre-close host step with A034 decision matrix
- `SessionCloseResult` / `SessionRecoverResult` are host-aware (A021)
- `InteractionStore` no longer appears in facade/edge type signatures (A029)
- Three close paths unified through single facade (A015)
- `bootstrapApp()` preserved as transition shim delegating TO `createAppHost()` (A032)

### Must NOT Have (Guardrails)
- No `TurnService` flush logic, threshold parameters, sweeper, or settlement pipeline changes. (Adding `await` to SessionService calls inside TurnService IS in-scope for Task 2's async migration — this is a mechanical propagation, not a behavioral change.)
- No `SessionService` constructor signature change (`db?: Db` preserved per A035)
- No service implementation replacement (SQLite queries, repo adapters unchanged)
- No `listSessions()` addition (explicitly excluded by A033)
- No test file directory restructuring (only `package.json` script entries + PG skip wrappers)
- No deletion of `bootstrapRuntime()` or `bootstrapApp()` (become internal, not removed)
- No `MemoryTaskAgent` / memory domain / lore / persona changes
- No PG backend actual activation (A002 — next round)
- No full maintenance script migration (only skeleton facade per A017)
- No durable job dispatcher / scheduler / lease reclaim wiring — those gaps (`MEMORY_PLATFORM_GAPS` §1-3) require a separate platform-runtime closeout plan
- No new `runtime.db` / raw service graph exposure in any added code — including no `_internal.runtime` escape hatches on `AppHost`

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (Bun native test runner)
- **Automated tests**: Tests-after (existing tests as regression baseline + new acceptance tests)
- **Framework**: `bun test`
- **Strategy**: Existing `bun test` as hermetic regression gate; new `test/app/*.test.ts` files for AppHost surface

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Type-check gate**: `bun run build` (tsc --noEmit) — zero errors
- **Regression gate**: `bun test` — all existing tests pass
- **Import boundary**: `bun test test/architecture/import-boundaries.test.ts` — pass
- **AST verification**: `ast_grep_search` for forbidden patterns (raw runtime leaks, InteractionStore in edge code, mode branching)

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — types, factory skeleton, async migration):
├── Task 1: AppHost types + AppRole definition [quick]
├── Task 2: SessionService async migration (methods + ALL 15+ callers + tests) [deep]
├── Task 3: AppHostAdmin DTO types (HostStatusDTO, PipelineStatusDTO) [quick]
└── Task 4: SessionCloseResult / SessionRecoverResult host-aware types [quick]

Wave 2 (Facade implementations — core logic):
├── Task 5: createAppHost() factory (calls bootstrapRuntime directly, NOT bootstrapApp) [deep]
├── Task 6: AppClients → AppUserFacade evolution + flush absorption [deep]
├── Task 7: InteractionStore → InteractionRepo migration in edge code [unspecified-high]
├── Task 8: AppHostAdmin implementation (getHostStatus, getPipelineStatus) [unspecified-high]
└── Task 9: AppMaintenanceFacade narrow core skeleton [quick]

Wave 3 (Entry point migration — CLI + gateway):
├── Task 10: chat.ts + SessionShell constructor migration to AppHost (co-batched) [deep]
├── Task 11: session.ts / turn.ts / debug.ts migration to AppHost [unspecified-high]
├── Task 12: config.ts / agent.ts migration to AppHostAdmin [unspecified-high]
├── Task 13: server.ts / index.ts migration to AppHost lifecycle [unspecified-high]
└── Task 14: GatewayServer + controllers.ts facade migration [deep]

Wave 4 (Unification + cleanup):
├── Task 15: Slash-dispatcher mode branch elimination [deep]
├── Task 16: LocalRuntime removal + SessionShell internal cleanup [quick]
└── Task 17: createAppClientRuntime() bridge update [unspecified-high]

Wave 5 (Test restructure + acceptance):
├── Task 18: package.json 4-tier test scripts + PG test hermetic isolation [unspecified-high]
├── Task 19: App-host acceptance test suite [deep] (after Task 18)
├── Task 20: Import boundary extension for facade leak detection [quick]
└── Task 21: Transition shim deprecation markers + documentation [quick]

Wave FINAL (After ALL tasks — 4 parallel reviews, autonomous):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present consolidated report to user
```

**Critical Path**: Task 1 → Task 5 → Task 6 → Task 10 → Task 15 → Task 18 → Task 19 → F1-F4
**Parallel Speedup**: ~60% faster than sequential
**Max Concurrent**: 5 (Wave 3)

### Dependency Matrix

| Task | Blocked By | Blocks |
|------|-----------|--------|
| 1 | — | 5, 6, 8, 9, 14 |
| 2 | — | 5, 6, 7, 10-14 |
| 3 | — | 8, 12 |
| 4 | — | 6 |
| 5 | 1, 2 | 10, 11, 12, 13, 14 |
| 6 | 1, 4, 5 | 10, 11, 14, 15 |
| 7 | 2 | 10, 11, 14 |
| 8 | 1, 3, 5 | 12, 13 |
| 9 | 1, 5 | 18 |
| 10 | 5, 6, 7 | 15, 16 |
| 11 | 5, 6, 7 | 15, 17 |
| 12 | 5, 8 | 17 |
| 13 | 5, 8 | 17 |
| 14 | 1, 5, 6, 7 | 15 |
| 15 | 6, 10, 11, 14 | 19 |
| 16 | 10, 15 | 19 |
| 17 | 11, 12, 13 | 19 |
| 18 | 19 | F1-F4 |
| 19 | 15, 16, 17 | 18, F1-F4 |
| 20 | 15, 16, 17 | F1-F4 |
| 21 | 5, 17 | F1-F4 |

### Agent Dispatch Summary

- **Wave 1**: 4 tasks — T1 → `quick`, T2 → `deep`, T3 → `quick`, T4 → `quick`
- **Wave 2**: 5 tasks — T5 → `deep`, T6 → `deep`, T7 → `unspecified-high`, T8 → `unspecified-high`, T9 → `quick`
- **Wave 3**: 5 tasks — T10 → `unspecified-high`, T11 → `unspecified-high`, T12 → `unspecified-high`, T13 → `unspecified-high`, T14 → `deep`
- **Wave 4**: 3 tasks — T15 → `deep`, T16 → `unspecified-high`, T17 → `unspecified-high`
- **Wave 5**: 4 tasks — T18 → `quick`, T19 → `deep`, T20 → `quick`, T21 → `quick`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

### Wave 1 — Foundation Types & Async Migration

- [ ] 1. AppHost Types + AppRole Definition

  **What to do**:
  - Create `src/app/host/types.ts` with all type definitions from consensus Section 6:
    - `AppRole = "local" | "server" | "worker" | "maintenance"`
    - `AppHost = { role, user?, admin, maintenance?, start, shutdown, getBoundPort? }`
      - `getBoundPort(): number` — only meaningful for `server` role. Returns the OS-assigned port after `start()`. When `port: 0` is configured, this returns the actual ephemeral port. Throws if called before `start()` or on non-server role.
    - `AppUserFacade = { session: SessionClient, turn: TurnClient, inspect: InspectClient, health: HealthClient }`
    - `AppHostAdmin = { getHostStatus, getPipelineStatus, listRuntimeAgents, getCapabilities, exportDebugBundle? }`
    - `HostStatusDTO = { backendType, memoryPipelineStatus, migrationStatus }`
    - `PipelineStatusDTO = { memoryPipelineStatus, memoryPipelineReady, effectiveOrganizerEmbeddingModelId }`
    - `AppMaintenanceFacade = { runOnce, drain, getDrainStatus, verify?, rebuild? }`
    - `AppHostOptions = { role, cwd?, configDir?, databasePath?, dataDir?, port?, host?, enableMaintenance?, ... }`
      - `enableMaintenance?: boolean` — when `true` and role is `server`, attaches maintenance facet (A022 line 145)
  - Create `src/app/host/index.ts` barrel export
  - All facade methods MUST return `Promise<T>` (A025 constraint)
  - `AppUserFacade` MUST be structurally identical to existing `AppClients` type at `src/app/clients/app-clients.ts:17-22` — it is an evolution, not a new parallel type
  - `AppHost` MUST NOT include any `_internal` / escape hatch exposing `RuntimeBootstrapResult`. Per A011, facade types must not re-expose raw runtime/service graph. The `chat.ts` migration (Task 10) must pass `host.user` to SessionShell, which requires co-batching SessionShell constructor migration within Task 10.

  **Must NOT do**:
  - Do not create implementations — this task is types only
  - Do not modify existing `AppClients` type yet (that's Task 6)
  - Do not add any runtime logic

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Pure type definitions, single new file, no logic
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: No UI work involved

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4)
  - **Blocks**: Tasks 5, 6, 8, 9, 14
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `src/app/clients/app-clients.ts:17-22` — Existing `AppClients` type that `AppUserFacade` must match structurally
  - `src/app/clients/session-client.ts` — `SessionClient` interface (facade references this, doesn't redefine)
  - `src/app/clients/turn-client.ts` — `TurnClient` interface
  - `src/app/clients/inspect-client.ts` — `InspectClient` interface
  - `src/app/clients/health-client.ts` — `HealthClient` interface

  **API/Type References**:
  - `src/bootstrap/types.ts:106-128` — `AppBootstrapOptions` and `AppBootstrapResult` for `AppHostOptions` alignment
  - `src/bootstrap/types.ts:76-104` — `RuntimeBootstrapResult` fields that `HostStatusDTO` / `PipelineStatusDTO` distill
  - `src/bootstrap/types.ts:69-74` — `MemoryPipelineStatus` type definition (union of "ready" | "missing_embedding_model" | ...)

  **External References**:
  - `docs/APP_LAYER_WIRING_CONSENSUS_2026-03-30.zh-CN.md` Section 6 — interface sketches (lines 428-534)

  **WHY Each Reference Matters**:
  - `app-clients.ts:17-22`: The exact shape `AppUserFacade` must match — ensures evolution, not duplication
  - `types.ts:106-128`: `AppHostOptions` should be a superset of `AppBootstrapOptions` to enable smooth factory delegation
  - `types.ts:76-104`: Know which runtime fields the DTOs distill (e.g., `memoryPipelineStatus`, `backendType`, `migrationStatus`)

  **Acceptance Criteria**:

  - [ ] `bun run build` passes with new type file
  - [ ] `AppUserFacade` is structurally assignable from `AppClients` (TypeScript compatibility)
  - [ ] All facade method return types are `Promise<T>`

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Type definitions compile without errors
    Tool: Bash
    Preconditions: New type file created at src/app/host/types.ts
    Steps:
      1. Run `bun run build`
      2. Check exit code
    Expected Result: Exit code 0, zero TypeScript errors
    Failure Indicators: Any TS error referencing src/app/host/types.ts
    Evidence: .sisyphus/evidence/task-1-type-compile.txt

  Scenario: AppUserFacade structurally matches AppClients
    Tool: Bash
    Preconditions: Both types exist
    Steps:
      1. Create a temporary test file that assigns AppClients to AppUserFacade
      2. Run `bun run build`
      3. Delete temporary file
    Expected Result: No type error on assignment
    Failure Indicators: TS2322 type incompatibility error
    Evidence: .sisyphus/evidence/task-1-facade-compat.txt
  ```

  **Commit**: YES (groups with Task 3, 4)
  - Message: `feat(app): add AppHost types, AppRole, and facade type definitions`
  - Files: `src/app/host/types.ts`, `src/app/host/index.ts`
  - Pre-commit: `bun run build`

---

- [ ] 2. SessionService Async Migration

  **What to do**:
  - **Phase A — Method signatures**: In `src/session/service.ts`, change all 7 canonical methods to `async` returning `Promise<T>`. Wrap existing sync logic with `Promise.resolve()` or direct return (async functions auto-wrap). Mark `setRecoveryRequired()` and `isRecoveryRequired()` with `@deprecated` JSDoc.
  - **Phase B — Caller updates**: Add `await` to ALL direct `SessionService` callers. This is the COMPLETE list — missing any one causes a silent bug (Promise where value expected):
    - `src/runtime/turn-service.ts:902` — `this.sessionService.setRecoveryRequired(request.sessionId)` — fire-and-forget without `await` creates unhandled promise
    - `src/runtime/turn-service.ts:1015` — `this.sessionService.getSession(sessionId)?.agentId` — without `await`, optional chaining on Promise always yields `undefined` (SILENT BUG)
    - `src/app/turn/user-turn-service.ts:19` — `deps.sessionService.isOpen(params.sessionId)` — predicate on Promise is always truthy (SILENT BUG)
    - `src/app/turn/user-turn-service.ts:20,50` — `deps.sessionService.getSession(params.sessionId)` — without `await`, `?.agentId` on Promise is `undefined`
    - `src/app/turn/user-turn-service.ts:38` — `deps.sessionService.isRecoveryRequired(params.sessionId)` — predicate on Promise always truthy
    - `src/memory/tool-adapter.ts:30` — `services.sessionService.getSession(sessionId)` — same `.agentId` silent-null pattern
    - `src/app/inspect/view-models.ts:183` — `params.runtime.sessionService.requiresRecovery(derivedSessionId)` — predicate always truthy
    - `src/app/inspect/view-models.ts:340` — `params.runtime.sessionService.getSession(sessionId)?.agentId` — silent null
    - `src/app/diagnostics/diagnose-service.ts:101` — `params.runtime.sessionService.requiresRecovery(sessionId)` — predicate always truthy
    - `src/app/clients/local/local-session-client.ts:14,22,30+` — ALL wrapped method calls (createSession, closeSession, getSession, recoverSession, isOpen, requiresRecovery, clearRecoveryRequired) must add `await`
    - `src/bootstrap/runtime.ts` — `turnServiceAgentLoop` → `sessionService.getSession()` needs `await`
    - `src/gateway/controllers.ts:344` — `ctx.sessionService.getSession()` needs `await` (Metis finding — missed by A028)
    - `src/gateway/controllers.ts:506` — `sessionClient(ctx).getSession()` — verify already async via LocalSessionClient
    - `src/terminal-cli/shell/slash-dispatcher.ts` — `/recover` handler: `requiresRecovery()` / `clearRecoveryRequired()` need `await`
    - `src/terminal-cli/commands/chat.ts` — `createSession()` / `getSession()` need `await`
    - `src/app/clients/local/local-turn-client.ts:121` — `deps.sessionService.requiresRecovery()` needs `await`
    NOTE: `executeUserTurn()` in `user-turn-service.ts` is a sync function returning `AsyncIterable<Chunk>`. The SessionService calls within it happen BEFORE the async iterable is created. After async migration, `executeUserTurn` MUST become `async` (return type changes to `Promise<AsyncIterable<Chunk>>`). All callers of `executeUserTurn` must then add `await`.
  - **Phase C — Test updates**: Update test files that call `SessionService` methods directly:
    - `test/runtime/turn-service-run-user-turn.test.ts` — lines 63, 64, 98, 99, 134, 168 need `await`
    - Search all test files for direct `sessionService.` calls and add `await` where needed
  - Do NOT change constructor signature `(db?: Db)` — that's next round (A035)

  **Must NOT do**:
  - Do not change `SessionService` constructor
  - Do not add new methods (e.g., no `listSessions()`)
  - Do not change internal SQLite query logic
  - Do not delete alias methods (only `@deprecated` this round)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Cross-cutting change touching 15+ files (session/service.ts, turn-service.ts, user-turn-service.ts, tool-adapter.ts, view-models.ts, diagnose-service.ts, local-session-client.ts, local-turn-client.ts, runtime.ts, controllers.ts, slash-dispatcher.ts, chat.ts, + tests). Requires careful tracing of all callers and understanding of sync→async behavioral implications.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3, 4)
  - **Blocks**: Tasks 5, 6, 7, 10-14
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `src/session/service.ts:20-149` — All 9 methods to be modified (7 canonical + 2 aliases)
  - `src/app/clients/local/local-session-client.ts` — Already wraps sync calls in async (pattern to follow: after async migration, remove redundant Promise.resolve wrappers)

  **API/Type References**:
  - `src/storage/domain-repos/contracts/session-repo.ts` — Existing async `SessionRepo` interface (async target contract already defined for future PG migration)

  **Caller References (ALL must be updated — COMPLETE verified list)**:
  - `src/runtime/turn-service.ts:902` — `this.sessionService.setRecoveryRequired()` (fire-and-forget → needs `await`)
  - `src/runtime/turn-service.ts:1015` — `this.sessionService.getSession()?.agentId` (silent null without `await`)
  - `src/app/turn/user-turn-service.ts:19,20,38,50` — 4 SessionService calls; function itself must become `async`
  - `src/memory/tool-adapter.ts:30` — `services.sessionService.getSession()` (resolveAgentId helper)
  - `src/app/inspect/view-models.ts:183` — `sessionService.requiresRecovery()` (loadSummaryView)
  - `src/app/inspect/view-models.ts:340` — `sessionService.getSession()?.agentId` (loadMemoryView)
  - `src/app/diagnostics/diagnose-service.ts:101` — `sessionService.requiresRecovery()` (diagnose flow)
  - `src/app/clients/local/local-session-client.ts:14,22,30+` — ALL wrapped calls in the class
  - `src/bootstrap/runtime.ts` — `turnServiceAgentLoop` inner function
  - `src/gateway/controllers.ts:344` — `ctx.sessionService.getSession(sessionId)` (sync, no await)
  - `src/terminal-cli/shell/slash-dispatcher.ts` — `/recover` handler
  - `src/terminal-cli/commands/chat.ts` — `createSession()` / `getSession()`
  - `src/app/clients/local/local-turn-client.ts:121` — `requiresRecovery()`
  - `test/runtime/turn-service-run-user-turn.test.ts:63,64,98,99,134,168` — Direct sync calls in tests
  - Search for ALL callers of `executeUserTurn()` — its signature changes to `async`

  **External References**:
  - Consensus A028, A033, A035

  **WHY Each Reference Matters**:
  - `service.ts:20-149`: The exact methods being changed — need line-by-line async transformation
  - `local-session-client.ts`: Shows the async wrapper pattern that becomes unnecessary after migration
  - `session-repo.ts`: Proves the async target interface already exists — validates this migration direction
  - Each caller reference: Missing ANY caller causes a runtime error (Promise returned but not awaited)

  **Acceptance Criteria**:

  - [ ] All 7 canonical methods return `Promise<T>`
  - [ ] `setRecoveryRequired` and `isRecoveryRequired` have `@deprecated` JSDoc
  - [ ] `bun run build` passes (confirms all callers correctly await)
  - [ ] `bun test` passes (confirms tests updated)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: SessionService methods return Promise
    Tool: Bash
    Preconditions: service.ts methods converted to async
    Steps:
      1. Run `bun run build`
      2. Verify no TS errors about missing await or Promise handling
    Expected Result: Exit code 0
    Failure Indicators: TS2801 (async function without await), TS1062 (promise not awaited at call site)
    Evidence: .sisyphus/evidence/task-2-async-compile.txt

  Scenario: All existing tests still pass after async migration
    Tool: Bash
    Preconditions: All callers updated with await
    Steps:
      1. Run `bun test`
      2. Compare pass count to baseline
    Expected Result: Zero failures, same test count
    Failure Indicators: Any test failure, especially in turn-service-run-user-turn.test.ts
    Evidence: .sisyphus/evidence/task-2-test-regression.txt

  Scenario: Deprecated aliases have @deprecated marker
    Tool: Bash (grep)
    Preconditions: Aliases marked
    Steps:
      1. Search src/session/service.ts for `@deprecated` annotations
      2. Verify setRecoveryRequired and isRecoveryRequired have the marker
    Expected Result: Both aliases found with @deprecated
    Failure Indicators: Missing @deprecated on either method
    Evidence: .sisyphus/evidence/task-2-deprecated-markers.txt

  Scenario: No remaining sync SessionService calls in production code
    Tool: Bash (ast_grep_search)
    Preconditions: All callers migrated
    Steps:
      1. Use ast_grep_search to find `sessionService.$METHOD($$)` patterns not preceded by `await`
      2. Verify zero matches in src/ (excluding the service definition itself)
    Expected Result: Zero unwaited sync calls
    Failure Indicators: Any match indicates a missed caller
    Evidence: .sisyphus/evidence/task-2-no-sync-calls.txt
  ```

  **Commit**: YES
  - Message: `refactor(session): make SessionService methods async and update all callers`
  - Files: `src/session/service.ts`, `src/bootstrap/runtime.ts`, `src/gateway/controllers.ts`, `src/terminal-cli/shell/slash-dispatcher.ts`, `src/terminal-cli/commands/chat.ts`, `src/app/clients/local/local-turn-client.ts`, `src/app/clients/local/local-session-client.ts`, `test/runtime/turn-service-run-user-turn.test.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 3. AppHostAdmin DTO Types

  **What to do**:
  - Add `HostStatusDTO` and `PipelineStatusDTO` to `src/app/host/types.ts` (created in Task 1) if not already included there. Ensure the types match consensus A030 exactly:
    ```ts
    type HostStatusDTO = {
      backendType: "sqlite" | "pg";
      memoryPipelineStatus: MemoryPipelineStatus;
      migrationStatus: { succeeded: boolean };
    };
    type PipelineStatusDTO = {
      memoryPipelineStatus: MemoryPipelineStatus;
      memoryPipelineReady: boolean;
      effectiveOrganizerEmbeddingModelId: string | undefined;
    };
    ```
  - Import `MemoryPipelineStatus` from the appropriate memory types module

  **Must NOT do**:
  - Do not implement the admin methods — types only
  - Do not define `listRuntimeAgents` or `getCapabilities` DTO shapes (remain `Promise<unknown>` per A030)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small type addition to file created in Task 1
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4) — in practice, runs after Task 1 within same wave since it edits Task 1's file
  - **Blocks**: Tasks 8, 12
  - **Blocked By**: Task 1 (file must exist)

  **References**:

  **API/Type References**:
  - `src/bootstrap/types.ts:69-74` — `MemoryPipelineStatus` type definition (import from here, NOT from src/memory/)
  - `src/bootstrap/types.ts:76-104` — `RuntimeBootstrapResult` fields being distilled into DTOs

  **External References**:
  - Consensus A030 (lines 218-234) — exact DTO shapes

  **WHY Each Reference Matters**:
  - `memory/types.ts`: Need the exact `MemoryPipelineStatus` import path
  - `types.ts:76-104`: Know which fields (`backendType`, `memoryPipelineStatus`, `memoryPipelineReady`, etc.) the DTOs reference

  **Acceptance Criteria**:
  - [ ] `bun run build` passes
  - [ ] DTO types match consensus A030 shapes exactly

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: DTO types compile and match consensus
    Tool: Bash
    Preconditions: Types added to host/types.ts
    Steps:
      1. Run `bun run build`
      2. Verify HostStatusDTO has backendType, memoryPipelineStatus, migrationStatus fields
    Expected Result: Clean compilation
    Failure Indicators: Import errors for MemoryPipelineStatus
    Evidence: .sisyphus/evidence/task-3-dto-compile.txt
  ```

  **Commit**: YES (groups with Task 1, 4)
  - Message: `feat(app): add AppHost types, AppRole, and facade type definitions`
  - Files: `src/app/host/types.ts`
  - Pre-commit: `bun run build`

---

- [ ] 4. SessionCloseResult / SessionRecoverResult Host-Aware Types

  **What to do**:
  - Define `SessionCloseResult` and `SessionRecoverResult` types per consensus A021/A031/A034:
    ```ts
    type SessionCloseResult = {
      session_id: string;
      closed_at: number;
      host_steps: {
        flush_on_session_close: "completed" | "not_applicable" | "skipped_no_agent";
      };
    };
    type SessionRecoverResult = {
      session_id: string;
      recovered: true;
      action: "discard_partial_turn";
      note_code: "partial_output_not_canonized";
    };
    ```
  - Place in `src/app/host/types.ts` or `src/app/contracts/` — whichever aligns with existing project structure
  - Check if existing `SessionCloseResult` / `SessionRecoverResult` already exist in `src/app/clients/session-client.ts` — if so, evolve them rather than creating duplicates

  **Must NOT do**:
  - Do not implement the actual close/recover logic (that's Task 6)
  - Do not change existing `SessionClient` interface yet

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small type definitions
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3)
  - **Blocks**: Task 6
  - **Blocked By**: None (can start immediately, but coordinates with Task 1 if in same file)

  **References**:

  **Pattern References**:
  - `src/app/contracts/session.ts:3-16` — **Actual definition site** for existing `SessionCreateResult` (line 3), `SessionCloseResult` (line 8), `SessionRecoverResult` (line 13). These types must be evolved to include host-aware fields.
  - `src/app/clients/session-client.ts` — Re-exports these types; verify import path alignment after evolution

  **External References**:
  - Consensus A021 (lines 136-139), A031 (lines 237-239), A034 (lines 298-313) — type shapes and flush decision matrix

  **WHY Each Reference Matters**:
  - `contracts/session.ts:3-16`: The actual source files for result types — evolve these, not the re-exports in session-client.ts

  **Acceptance Criteria**:
  - [ ] `bun run build` passes
  - [ ] `SessionCloseResult.host_steps.flush_on_session_close` has 3-value union type
  - [ ] `SessionRecoverResult` has `action` and `note_code` literal fields

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Result types compile and have correct literal types
    Tool: Bash
    Preconditions: Types defined
    Steps:
      1. Run `bun run build`
    Expected Result: Clean compilation
    Failure Indicators: Any TS error in type file
    Evidence: .sisyphus/evidence/task-4-result-types.txt
  ```

  **Commit**: YES (groups with Task 1, 3)
  - Message: `feat(app): add AppHost types, AppRole, and facade type definitions`
  - Files: `src/app/host/types.ts`
  - Pre-commit: `bun run build`

---

### Wave 2 — Facade Implementations

- [ ] 5. createAppHost() Factory Implementation

  **What to do**:
  - Create `src/app/host/create-app-host.ts` implementing the unified async factory:
    ```ts
    export async function createAppHost(options: AppHostOptions): Promise<AppHost>
    ```
  - Factory internally (CRITICAL — dependency direction per A032):
    1. Calls `bootstrapRuntime()` directly with mapped options — this is the ONLY bootstrap call `createAppHost()` makes. It does NOT call `bootstrapApp()`.
    2. For `server` role: creates `GatewayServer` directly using runtime result fields (port, host, controllers context) — mirrors what `bootstrapApp()` currently does at lines 89-107 but without going through `bootstrapApp()`.
    3. Assembles facades: `AppUserFacade`, `AppHostAdmin`, `AppMaintenanceFacade` from runtime result
    4. Wires `start()` / `shutdown()` lifecycle:
       - `local` role: `start()` is no-op, `shutdown()` stops runtime
       - `server` role: `start()` binds transport (calls `GatewayServer.start()`), `shutdown()` stops server then runtime
       - `worker` / `maintenance`: skeleton for future
    5. Applies A022 facet matrix per consensus lines 143-148:
       - ALL roles get `admin` (read-only observation, negligible cost)
       - `local`: `user` + `admin`; `maintenance` NOT exposed
       - `server`: `user` + `admin` + lifecycle; `maintenance` exposed ONLY when explicitly enabled via `AppHostOptions` (e.g., `enableMaintenance: true`)
       - `worker`: `admin` + `maintenance`; `user` optional
       - `maintenance`: `admin` + `maintenance`; `user.inspect` only on demand
  - `AppHost.user` facet uses existing `createLocalAppClients()` internally (for now — Task 6 will evolve it)
  - `AppHost.admin` wraps runtime fields into DTOs (using types from Task 3)
  - Export from `src/app/host/index.ts`
  - Shutdown ordering: stop server → stop sweeper (via runtime.shutdown) → flush pending
  - After `createAppHost()` is verified, update `bootstrapApp()` to become a thin synchronous-compatible shim that calls `createAppHost()` internally and maps the result back to `AppBootstrapResult` shape. This is the A032 transition direction: `bootstrapApp()` delegates TO `createAppHost()`, never the reverse.

  **Must NOT do**:
  - Do NOT have `createAppHost()` call `bootstrapApp()` — the dependency arrow is `bootstrapApp()` → `createAppHost()` → `bootstrapRuntime()`, never the reverse
  - Do not delete `bootstrapApp()` — it becomes a transition shim calling `createAppHost()`
  - Do not delete `bootstrapRuntime()` — factory wraps it
  - Do not change `GatewayServer` constructor yet (that's Task 14)
  - Do not activate PG backend

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Core architectural piece, must correctly wire lifecycle, handle role matrix, integrate with existing bootstrap chain
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 first (other Wave 2 tasks depend on this)
  - **Blocks**: Tasks 6, 7 (transitively), 8, 9, 10-14
  - **Blocked By**: Tasks 1, 2

  **References**:

  **Pattern References**:
  - `src/bootstrap/app-bootstrap.ts:34-119` — Current `bootstrapApp()` — study its GatewayServer wiring (lines 89-107) to replicate in factory WITHOUT calling `bootstrapApp()` itself. After factory works, `bootstrapApp()` gets shimmed to delegate to `createAppHost()`.
  - `src/bootstrap/runtime.ts:205-585` — `bootstrapRuntime()` — the ONLY bootstrap entry `createAppHost()` calls directly
  - `src/app/clients/app-clients.ts:24-40` — `createLocalAppClients()` used to assemble `user` facet

  **API/Type References**:
  - `src/app/host/types.ts` (Task 1) — `AppHost`, `AppHostOptions`, `AppRole`, facade types
  - `src/bootstrap/types.ts:106-128` — `AppBootstrapOptions` for option mapping
  - `src/gateway/server.ts:8-17` — `GatewayServerOptions` for server role wiring
  - `src/gateway/server.ts:31,87` — `start()` and `stop()` methods (both sync — wrap in async)

  **External References**:
  - Consensus A032 (lines 242-275) — factory design and migration strategy
  - Consensus A022 (lines 142-149) — role facet matrix

  **WHY Each Reference Matters**:
  - `app-bootstrap.ts:34-119`: Study the GatewayServer creation pattern (lines 89-107); replicate this logic inside `createAppHost()` for `server` role. Then shim `bootstrapApp()` to delegate to `createAppHost()`.
  - `types.ts:106-128`: Option fields must align for smooth delegation to `bootstrapRuntime()`
  - `server.ts:8-17`: GatewayServer's current constructor params determine how to wire server role
  - `server.ts:31,87`: Sync start/stop need async wrapping in host lifecycle

  **Acceptance Criteria**:

  - [ ] `createAppHost({ role: "local", databasePath: ":memory:" })` returns working `AppHost`
  - [ ] `AppHost.user.session` / `.turn` / `.inspect` / `.health` all defined
  - [ ] `AppHost.admin.getHostStatus()` returns `HostStatusDTO`
  - [ ] `AppHost.start()` resolves (no-op for local)
  - [ ] `AppHost.shutdown()` cleans up resources
  - [ ] Server role: `host.getBoundPort()` returns actual bound port after `host.start()` (including `port: 0` case)
  - [ ] Server role with `enableMaintenance: true`: `host.maintenance` is defined
  - [ ] Server role without `enableMaintenance`: `host.maintenance` is undefined
  - [ ] `bun run build && bun test` passes

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Local AppHost creates successfully with in-memory DB
    Tool: Bash
    Preconditions: Factory implemented, type definitions from Task 1 exist
    Steps:
      1. Create test file test/app/app-host.test.ts
      2. Test: const host = await createAppHost({ role: "local", databasePath: ":memory:" })
      3. Assert host.role === "local"
      4. Assert host.user is defined
      5. Assert host.admin is defined
      6. Assert host.maintenance is undefined (local role)
      7. Call await host.start() — should resolve
      8. Call await host.shutdown() — should resolve
      9. Run `bun test test/app/app-host.test.ts`
    Expected Result: All assertions pass
    Failure Indicators: createAppHost throws, missing facets, shutdown hangs
    Evidence: .sisyphus/evidence/task-5-local-host.txt

  Scenario: Server AppHost includes lifecycle + dynamic port binding
    Tool: Bash
    Preconditions: Factory implemented
    Steps:
      1. In test: const host = await createAppHost({ role: "server", databasePath: ":memory:", port: 0 })
      2. Assert host.role === "server"
      3. Assert host.user is defined
      4. Assert host.admin is defined
      5. Call await host.start() — transport should bind to ephemeral port
      6. Assert host.getBoundPort() > 0 (NOT 0 — actual OS-assigned port)
      7. Assert host.maintenance is undefined (not explicitly enabled)
      8. Call await host.shutdown() — should clean up
      9. Run test
    Expected Result: Server starts cleanly, getBoundPort returns real port, stops cleanly
    Failure Indicators: getBoundPort returns 0, port conflict, shutdown timeout
    Evidence: .sisyphus/evidence/task-5-server-host.txt

  Scenario: Server with enableMaintenance exposes maintenance facet
    Tool: Bash
    Preconditions: Factory implemented
    Steps:
      1. const host = await createAppHost({ role: "server", databasePath: ":memory:", port: 0, enableMaintenance: true })
      2. Assert host.maintenance is defined
      3. Assert host.maintenance.runOnce throws "not yet implemented" (skeleton)
      4. await host.shutdown()
    Expected Result: Maintenance facet present when explicitly enabled
    Evidence: .sisyphus/evidence/task-5-server-maintenance.txt

  Scenario: Admin DTO returns correct shape
    Tool: Bash
    Preconditions: Host created
    Steps:
      1. const status = await host.admin.getHostStatus()
      2. Assert status.backendType === "sqlite"
      3. Assert status.migrationStatus.succeeded is boolean
      4. Assert status.memoryPipelineStatus is defined
    Expected Result: DTO matches HostStatusDTO shape
    Failure Indicators: Missing fields, wrong types
    Evidence: .sisyphus/evidence/task-5-admin-dto.txt
  ```

  **Commit**: YES
  - Message: `feat(app): implement createAppHost factory (bootstrapRuntime direct) + shim bootstrapApp`
  - Files: `src/app/host/create-app-host.ts`, `src/app/host/index.ts`, `src/bootstrap/app-bootstrap.ts`, `test/app/app-host.test.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 6. AppClients → AppUserFacade Evolution + Flush Absorption

  **What to do**:
  - **Phase A — Type evolution**: Evolve `AppClients` type to `AppUserFacade` in `src/app/clients/app-clients.ts`:
    - Rename `AppClients` → `AppUserFacade` (or add `AppUserFacade` as primary with `AppClients` as deprecated alias)
    - Use `lsp_rename` if safe, otherwise manual rename with `replaceAll`
  - **Phase A2 — Factory internalization**: `createLocalAppClients(runtime: RuntimeBootstrapResult)` is absorbed into `createAppHost()` factory (per A018). It becomes an internal implementation detail — no longer exported as a public API that accepts `RuntimeBootstrapResult`. The `createAppHost()` factory calls it internally with the bootstrapped runtime. This eliminates the `RuntimeBootstrapResult` dependency from `src/app/clients/app-clients.ts`'s public surface.
  - **Phase A3 — Local client constructor narrowing**: Refactor `LocalInspectClient` and `LocalHealthClient` constructors to accept narrow dependency objects instead of the full `RuntimeBootstrapResult`:
    - `LocalInspectClient`: Accept `{ inspectQueryService, traceStore?, sessionService, ... }` instead of `RuntimeBootstrapResult`
    - `LocalHealthClient`: Accept `{ healthChecks }` instead of full runtime
    - These narrowed constructors are called internally by `createAppHost()`, not by external code
    - This ensures zero `RuntimeBootstrapResult` references in `src/app/clients/` as the Definition of Done requires
  - **Phase B — SessionClient closeSession upgrade**: Update `SessionClient.closeSession()` return type to `SessionCloseResult` (Task 4 type) with host-aware `host_steps` field
  - **Phase C — Flush absorption**: Implement host-aware close in `LocalSessionClient`:
    - `closeSession()` now performs: (1) resolve flush decision per A034 matrix, (2) if applicable: call `turnService.flushOnSessionClose()` as pre-close step, (3) if flush fails: throw (session stays open per A015), (4) call underlying `sessionService.closeSession()`, (5) return `SessionCloseResult` with `host_steps`
    - Decision matrix (A034): no agent_id → `"skipped_no_agent"`, no memoryTaskAgent → `"not_applicable"`, no pending records → `"not_applicable"`, flush succeeds → `"completed"`, flush fails → throw
  - **Phase D — RecoverSession upgrade**: Update `SessionClient.recoverSession()` return type to `SessionRecoverResult` (Task 4 type)
  - **Phase E — Gateway client alignment**: Ensure `GatewaySessionClient.closeSession()` and `.recoverSession()` return the new host-aware result types. This requires evolving the gateway HTTP response body for `/session/:id/close` and `/session/:id/recover` endpoints to include `host_steps` / `action` / `note_code` fields. The gateway controller must produce these fields on the server side, and `GatewaySessionClient` must parse them on the client side. This is an intentional API evolution per A021, not an accidental format change.

  **Must NOT do**:
  - Do not change `TurnService.flushOnSessionClose()` internals — treat as black box
  - Do not add new methods to `SessionClient`
  - Do not change the flush threshold logic

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Core behavioral change (flush absorption), affects session lifecycle contract, multiple files
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (after Task 5)
  - **Parallel Group**: Wave 2 (with Tasks 7, 8, 9)
  - **Blocks**: Tasks 10, 11, 14, 15
  - **Blocked By**: Tasks 1, 4, 5

  **References**:

  **Pattern References**:
  - `src/app/clients/app-clients.ts:17-22` — Current `AppClients` type to evolve
  - `src/app/clients/session-client.ts` — `SessionClient` interface and current result types
  - `src/app/clients/local/local-session-client.ts` — Local implementation to receive flush logic
  - `src/gateway/controllers.ts:506-512` — Correct flush→close ordering to replicate in facade

  **API/Type References**:
  - `src/app/host/types.ts` (Task 4) — `SessionCloseResult`, `SessionRecoverResult` types
  - `src/app/turn/` — `TurnService.flushOnSessionClose()` signature

  **Test References**:
  - `test/cli/acceptance.test.ts` — Session close contracts (must remain passing)

  **External References**:
  - Consensus A015 (lines 100-103) — pre-close → close ordering, failure semantics
  - Consensus A034 (lines 298-313) — flush decision matrix
  - Consensus A026 (lines 178-186) — CLI/gateway unification through facade

  **WHY Each Reference Matters**:
  - `controllers.ts:506-512`: The gateway's flush→close order is the CORRECT pattern to replicate
  - `session-client.ts`: Current `closeSession()` return type must be upgraded to host-aware version
  - `local-session-client.ts`: WHERE the flush logic gets absorbed — this is the main implementation site

  **Acceptance Criteria**:

  - [ ] `LocalSessionClient.closeSession()` absorbs flush as pre-close step
  - [ ] Flush decision matrix implemented per A034
  - [ ] Flush failure causes throw (session stays open)
  - [ ] `SessionCloseResult` includes `host_steps.flush_on_session_close`
  - [ ] `bun run build && bun test` passes

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: closeSession with pending records returns "completed"
    Tool: Bash
    Preconditions: Session with pending interaction records, memory system active
    Steps:
      1. Create test in test/app/session-close-flush.test.ts
      2. Bootstrap in-memory AppHost, create session, seed interaction records
      3. Call host.user.session.closeSession(sessionId)
      4. Assert result.host_steps.flush_on_session_close === "completed"
      5. Assert session is closed
    Expected Result: flush_on_session_close === "completed"
    Failure Indicators: Wrong status, session not closed, error thrown
    Evidence: .sisyphus/evidence/task-6-flush-completed.txt

  Scenario: closeSession with no agent_id returns "skipped_no_agent"
    Tool: Bash
    Preconditions: Session without agent_id
    Steps:
      1. Create session without agent_id context
      2. Call closeSession()
      3. Assert result.host_steps.flush_on_session_close === "skipped_no_agent"
    Expected Result: Correct skip status
    Failure Indicators: Attempt to flush without agent context
    Evidence: .sisyphus/evidence/task-6-flush-skipped.txt

  Scenario: closeSession with no memory system returns "not_applicable"
    Tool: Bash
    Preconditions: Runtime with memoryTaskAgent = null
    Steps:
      1. Bootstrap host without memory pipeline
      2. Create and close session
      3. Assert result.host_steps.flush_on_session_close === "not_applicable"
    Expected Result: not_applicable status
    Evidence: .sisyphus/evidence/task-6-flush-not-applicable.txt

  Scenario: closeSession when flush fails throws and session stays open
    Tool: Bash
    Preconditions: Mock flushOnSessionClose to throw
    Steps:
      1. Set up flush to fail
      2. Call closeSession() in try/catch
      3. Assert error is thrown
      4. Assert session is still open (not closed)
    Expected Result: Error thrown, session remains open
    Failure Indicators: Session closed despite flush failure
    Evidence: .sisyphus/evidence/task-6-flush-failure.txt
  ```

  **Commit**: YES
  - Message: `refactor(app): evolve AppClients to AppUserFacade with flush absorption`
  - Files: `src/app/clients/app-clients.ts`, `src/app/clients/session-client.ts`, `src/app/clients/local/local-session-client.ts`, `src/app/clients/gateway/gateway-session-client.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 7. InteractionStore → InteractionRepo Migration in Edge Code

  **What to do**:
  - **local-turn-client.ts**: Change `LocalTurnDeps.interactionStore: InteractionStore` → `interactionRepo: InteractionRepo` (line 30). Update `executeLocalTurn()` at line 96: change `deps.interactionStore.getSettlementPayload(...)` → `await deps.interactionRepo.getSettlementPayload(...)` (InteractionRepo version is async)
  - **app-clients.ts**: In `createLocalAppClients()`, replace `new InteractionStore(runtime.db)` (line 28) with `runtime.interactionRepo` (already exists on `RuntimeBootstrapResult`)
  - **local-runtime.ts**: Replace `new InteractionStore(runtime.db)` (line 15) with `runtime.interactionRepo`. Update `executeTurn()` to pass `interactionRepo` instead of `interactionStore`
  - Verify `InteractionRepo` interface is importable from `src/storage/domain-repos/contracts/interaction-repo.ts`

  **Must NOT do**:
  - Do not delete `InteractionStore` class — it remains as SQLite adapter backing `SqliteInteractionRepoAdapter`
  - Do not modify `InteractionStore` internals
  - Do not change `InteractionRepo` interface

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Multi-file type migration with async implications, needs careful tracing
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (after Task 2)
  - **Parallel Group**: Wave 2 (with Tasks 6, 8, 9)
  - **Blocks**: Tasks 10, 11, 14
  - **Blocked By**: Task 2 (async SessionService needed because local-turn-client.ts changes interact)

  **References**:

  **Pattern References**:
  - `src/app/clients/local/local-turn-client.ts:27-32` — `LocalTurnDeps` type with `interactionStore` field
  - `src/app/clients/local/local-turn-client.ts:96-102` — `getSettlementPayload()` sync call to be async-ified
  - `src/app/clients/app-clients.ts:28` — `new InteractionStore(runtime.db)` to eliminate
  - `src/terminal-cli/local-runtime.ts:15` — `new InteractionStore(runtime.db)` to eliminate

  **API/Type References**:
  - `src/storage/domain-repos/contracts/interaction-repo.ts:7-46` — `InteractionRepo` async interface (target type)
  - `src/bootstrap/types.ts` — `RuntimeBootstrapResult.interactionRepo` field (already exists)
  - `src/storage/domain-repos/sqlite/interaction-repo.ts:11-103` — `SqliteInteractionRepoAdapter` (wraps InteractionStore)

  **WHY Each Reference Matters**:
  - `local-turn-client.ts:27-32`: The type declaration that must change from `InteractionStore` to `InteractionRepo`
  - `local-turn-client.ts:96-102`: The sync `getSettlementPayload()` call that becomes async
  - `interaction-repo.ts:7-46`: The target interface — all methods are async, confirming `await` is needed

  **Acceptance Criteria**:

  - [ ] Zero `InteractionStore` imports in `src/app/clients/` and `src/terminal-cli/`
  - [ ] `local-turn-client.ts` uses `InteractionRepo` type
  - [ ] `getSettlementPayload()` call uses `await`
  - [ ] Only one `InteractionStore` instantiation remains (in `runtime.ts:265`)
  - [ ] `bun run build && bun test` passes

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Zero InteractionStore in edge code
    Tool: Bash (ast_grep_search)
    Preconditions: Migration complete
    Steps:
      1. ast_grep_search for `import { InteractionStore } from $PATH` in src/app/ and src/terminal-cli/
      2. Assert zero matches
    Expected Result: No InteractionStore imports in facade/edge code
    Failure Indicators: Any remaining import
    Evidence: .sisyphus/evidence/task-7-no-interaction-store.txt

  Scenario: Settlement payload still resolves correctly
    Tool: Bash
    Preconditions: Migration complete
    Steps:
      1. Run `bun test` — focus on turn/settlement related tests
      2. Verify no regression in settlement payload resolution
    Expected Result: All tests pass
    Failure Indicators: Settlement payload undefined when expected
    Evidence: .sisyphus/evidence/task-7-settlement-regression.txt
  ```

  **Commit**: YES
  - Message: `refactor(app): migrate InteractionStore to InteractionRepo in edge code`
  - Files: `src/app/clients/local/local-turn-client.ts`, `src/app/clients/app-clients.ts`, `src/terminal-cli/local-runtime.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 8. AppHostAdmin Implementation

  **What to do**:
  - Implement `AppHostAdmin` methods in a new file `src/app/host/app-host-admin.ts`:
    - `getHostStatus()`: Returns `HostStatusDTO` by reading `runtime.backendType`, `runtime.memoryPipelineStatus`, `runtime.migrationStatus`
    - `getPipelineStatus()`: Returns `PipelineStatusDTO` by reading `runtime.memoryPipelineStatus`, `runtime.memoryPipelineReady`, `runtime.effectiveOrganizerEmbeddingModelId`
    - `listRuntimeAgents()`: Returns `Promise<unknown>` wrapping `runtime.agentRegistry.getAll()` (first round, shape unfixed)
    - `getCapabilities()`: Returns `Promise<unknown>` — stub for now
    - `exportDebugBundle`: Omitted in first round (optional in type)
  - Wire into `createAppHost()` factory (Task 5) — admin facet reads from bootstrapped runtime
  - Admin MUST NOT expose raw runtime — it distills specific fields into DTOs

  **Must NOT do**:
  - Do not expose `runtime.agentRegistry` directly — wrap in admin method
  - Do not expose `runtime.db` / `runtime.rawDb` / `runtime.pgFactory`
  - Do not change internal AgentRegistry or MemoryPipeline logic

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Implementation of new module, needs to correctly map runtime internals to DTO shapes
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 6, 7, 9)
  - **Blocks**: Tasks 12, 13
  - **Blocked By**: Tasks 1, 3, 5

  **References**:

  **Pattern References**:
  - `src/terminal-cli/commands/config.ts:325-336` — How `config doctor` currently reads runtime fields (pattern to replicate in DTO)
  - `src/terminal-cli/commands/server.ts:113-114` — How `server start` reads `memoryPipelineStatus/Ready`
  - `src/terminal-cli/commands/agent.ts:119-126` — How `agent --source runtime` reads `agentRegistry`

  **API/Type References**:
  - `src/app/host/types.ts` (Tasks 1, 3) — `AppHostAdmin`, `HostStatusDTO`, `PipelineStatusDTO` types
  - `src/bootstrap/types.ts:76-104` — `RuntimeBootstrapResult` source fields

  **WHY Each Reference Matters**:
  - `config.ts:325-336`: Shows exact fields being consumed — admin DTO must provide these same values
  - `server.ts:113-114`: Same pattern — confirms `memoryPipelineStatus` and `memoryPipelineReady` are needed
  - `agent.ts:119-126`: Confirms `agentRegistry.getAll()` and `.get()` are the consumed methods

  **Acceptance Criteria**:

  - [ ] `getHostStatus()` returns correct `HostStatusDTO` shape
  - [ ] `getPipelineStatus()` returns correct `PipelineStatusDTO` shape
  - [ ] `listRuntimeAgents()` returns agent list without exposing raw registry
  - [ ] `bun run build && bun test` passes

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Admin DTOs return correct values from runtime
    Tool: Bash
    Preconditions: AppHost created with in-memory DB
    Steps:
      1. const host = await createAppHost({ role: "local", databasePath: ":memory:" })
      2. const status = await host.admin.getHostStatus()
      3. Assert status.backendType === "sqlite"
      4. Assert typeof status.migrationStatus.succeeded === "boolean"
      5. const pipeline = await host.admin.getPipelineStatus()
      6. Assert typeof pipeline.memoryPipelineReady === "boolean"
    Expected Result: All DTO fields match expected types
    Evidence: .sisyphus/evidence/task-8-admin-dtos.txt
  ```

  **Commit**: YES (groups with Task 5)
  - Message: `feat(app): implement createAppHost factory with role-aware facets`
  - Files: `src/app/host/app-host-admin.ts`, `src/app/host/create-app-host.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 9. AppMaintenanceFacade Narrow Core Skeleton

  **What to do**:
  - Create `src/app/host/app-maintenance-facade.ts` with minimal implementation:
    - `runOnce()`: `throw new Error("not yet implemented")`
    - `drain()`: `throw new Error("not yet implemented")`
    - `getDrainStatus()`: `throw new Error("not yet implemented")`
    - `verify?()`: optional slot, omit implementation
    - `rebuild?()`: optional slot, omit implementation
  - Wire into `createAppHost()`: available for `worker`, `maintenance`, and `server` roles per A022. For `server`, only exposed when `AppHostOptions.enableMaintenance === true` (consensus line 145: "仅在显式启用时暴露"). For `worker`/`maintenance`, always present.
  - Purpose: establish the formal skeleton so maintenance role has an anchor. All methods throw "not yet implemented" — actual implementation is deferred to the platform-runtime PG closeout (see gap document `docs/MEMORY_PLATFORM_GAPS_APP_CLI_ACCEPTANCE_2026-03-28.zh-CN.md` for the durable dispatcher / lease reclaim / rebuild orchestration gaps that must close before these methods can have real logic).

  **Must NOT do**:
  - Do not implement actual maintenance logic (A017 — just skeleton)
  - Do not migrate existing maintenance scripts into this facade

  **Explicit scope note — PG platform-runtime gaps NOT addressed by this plan**:
  This plan builds the **interaction-side** foundation for PG switch (`AppUserFacade` async seams, `InteractionRepo` migration). It does NOT close the **platform-runtime** PG gaps identified in `docs/MEMORY_PLATFORM_GAPS_APP_CLI_ACCEPTANCE_2026-03-28.zh-CN.md`:
  - Durable job dispatcher / scheduler not wired into default bootstrap (gap §1, lines 15-34)
  - Expired lease reclaim not in default loop (gap §3, lines 50-71)
  - `search-rebuild` / `memory-rebuild-derived` orchestration not closed (gap §4-5, lines 75-100)
  These require a separate "platform-runtime PG closeout" plan. Task 9's `throw` stubs are the anchor point — once the platform gaps close, `runOnce`/`drain`/`getDrainStatus` get real implementations wired to the durable job system.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Stub implementation, throw on all methods
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 6, 7, 8)
  - **Blocks**: Task 18
  - **Blocked By**: Tasks 1, 5

  **References**:

  **API/Type References**:
  - `src/app/host/types.ts` (Task 1) — `AppMaintenanceFacade` type definition

  **External References**:
  - Consensus A017 (lines 111-114) — narrow core scope

  **Acceptance Criteria**:
  - [ ] `bun run build` passes
  - [ ] Maintenance facet available for worker/maintenance (always) and server (only when `enableMaintenance: true`)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Maintenance facade throws "not yet implemented"
    Tool: Bash
    Preconditions: Skeleton created
    Steps:
      1. Attempt to call maintenance.runOnce() on a maintenance-role host
      2. Expect error "not yet implemented"
    Expected Result: Clean throw with descriptive message
    Evidence: .sisyphus/evidence/task-9-maintenance-skeleton.txt

  Scenario: Local role has no maintenance facet
    Tool: Bash
    Preconditions: AppHost with role "local"
    Steps:
      1. Assert host.maintenance === undefined
    Expected Result: maintenance is undefined for local role
    Evidence: .sisyphus/evidence/task-9-no-maintenance-local.txt
  ```

  **Commit**: YES (groups with Task 5)
  - Message: `feat(app): implement createAppHost factory with role-aware facets`
  - Files: `src/app/host/app-maintenance-facade.ts`
  - Pre-commit: `bun run build`

---

### Wave 3 — Entry Point Migration

- [ ] 10. chat.ts + SessionShell Constructor Migration to AppHost

  **What to do**:
  This task co-batches chat.ts migration WITH SessionShell constructor migration (previously Task 16 Phase A) to avoid needing an `_internal.runtime` escape hatch. Per A032 line 262: "`chat.ts` 改为 `createAppHost({ role: "local" })`，将 `host.user` 传入 shell"

  - **Phase A — SessionShell constructor migration** (do FIRST):
    - Change `SessionShell` constructor from `(state: ShellState, runtime: RuntimeBootstrapResult | undefined, options?)` to `(state: ShellState, facade: AppUserFacade, options?)`
    - Inside SessionShell: replace `this.runtime?.sessionService` with `facade.session`, `this.runtime?.turnService` with equivalent facade calls
    - Remove `this.localRuntime` creation — `createLocalRuntime(runtime)` is no longer needed since facade already provides the same capabilities
    - Keep `this.gatewayClient` path for gateway mode (facade handles both)
    - Update `slash-dispatcher.ts` constructor arg to match (it receives the same shell instance)
  - **Phase B — chat.ts migration**:
    - Replace local mode's `bootstrapApp()` call with `createAppHost({ role: "local", ... })`
    - Pass `host.user` directly into `SessionShell` constructor (enabled by Phase A)
    - Replace `app.runtime.sessionService.createSession()` / `.getSession()` with `host.user.session.createSession()` / `.getSession()`
    - Gateway mode: keep `GatewayClient` path but ensure it returns same result types
    - Replace `app.shutdown()` with `await host.shutdown()`

  **Must NOT do**:
  - Do NOT create any `_internal` / escape hatch on AppHost — pass `host.user` directly
  - Do not eliminate gateway mode branching in chat.ts (slash-dispatcher handles that later)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: High complexity — co-batches SessionShell constructor migration with chat.ts migration. Touches session-shell.ts, chat.ts, slash-dispatcher internal references to shell. Must understand full shell ↔ runtime dependency surface.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 11, 12, 13, 14)
  - **Blocks**: Tasks 15, 16
  - **Blocked By**: Tasks 5, 6, 7

  **References**:

  **Pattern References**:
  - `src/terminal-cli/commands/chat.ts:125-218` — Current dual-mode bootstrap logic to replace
  - `src/terminal-cli/shell/session-shell.ts:23-40` — Constructor receiving `RuntimeBootstrapResult | undefined` — MUST be changed to accept `AppUserFacade`
  - `src/terminal-cli/shell/session-shell.ts:37` — `createLocalRuntime(runtime)` call to eliminate
  - `src/terminal-cli/local-runtime.ts:20` — `sessionService: this.runtime.sessionService` — shows what facade must cover

  **API/Type References**:
  - `src/app/host/types.ts` — `AppHost`, `AppUserFacade`
  - `src/app/host/create-app-host.ts` (Task 5) — factory to call

  **External References**:
  - Consensus A032 (line 262) — `chat.ts` 改为 `createAppHost({ role: "local" })`，将 `host.user` 传入 shell
  - Consensus A011 (line 76-79) — facade must not re-expose raw runtime

  **WHY Each Reference Matters**:
  - `chat.ts:125-218`: The exact code being replaced — need to understand all services accessed
  - `session-shell.ts:23-40`: Constructor being changed — must map ALL runtime field usages to facade equivalents
  - `local-runtime.ts:20`: Shows the exact fields SessionShell consumes from runtime — facade must cover all of them

  **Acceptance Criteria**:
  - [ ] `SessionShell` constructor accepts `AppUserFacade` — no `RuntimeBootstrapResult` in its signature
  - [ ] `chat.ts` local mode uses `createAppHost()` instead of `bootstrapApp()`
  - [ ] `chat.ts` passes `host.user` to `SessionShell` — no `_internal.runtime` escape hatch
  - [ ] No direct `runtime.sessionService` access in `chat.ts` or `session-shell.ts`
  - [ ] `bun run build && bun test` passes

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: SessionShell constructor accepts AppUserFacade
    Tool: Bash (grep)
    Preconditions: session-shell.ts constructor migrated
    Steps:
      1. Search session-shell.ts for `RuntimeBootstrapResult` — should be zero matches
      2. Search session-shell.ts for `AppUserFacade` — should have 1+ matches
      3. Search session-shell.ts for `createLocalRuntime` — should be zero matches
    Expected Result: Shell constructor fully migrated to facade
    Evidence: .sisyphus/evidence/task-10-shell-constructor.txt

  Scenario: Chat local mode bootstraps via AppHost
    Tool: Bash (ast_grep_search)
    Preconditions: chat.ts migrated
    Steps:
      1. Search chat.ts for `bootstrapApp(` — should be zero matches
      2. Search chat.ts for `createAppHost(` — should have 1 match
      3. Search chat.ts for `host.user` being passed to SessionShell
      4. Run `bun run build`
    Expected Result: bootstrapApp removed, createAppHost present, host.user passed to shell, compiles
    Evidence: .sisyphus/evidence/task-10-chat-migration.txt

  Scenario: Existing CLI acceptance tests still pass
    Tool: Bash
    Preconditions: chat.ts + session-shell.ts migrated
    Steps:
      1. Run `bun test test/cli/acceptance.test.ts`
    Expected Result: All tests pass
    Failure Indicators: Any session/chat related test failure
    Evidence: .sisyphus/evidence/task-10-acceptance-regression.txt
  ```

  **Commit**: YES (groups with Tasks 11, 12, 13)
  - Message: `refactor(cli): migrate chat.ts + SessionShell constructor to AppHost/facades`
  - Files: `src/terminal-cli/commands/chat.ts`, `src/terminal-cli/shell/session-shell.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 11. session.ts / turn.ts / debug.ts Migration to AppHost

  **What to do**:
  - These 3 commands already use `createAppClientRuntime()` facade pattern — they are the EASIEST migration:
  - **session.ts**: Remove direct `runtime.runtime.turnService.flushOnSessionClose()` call (line ~160) — facade `closeSession()` now handles flush (Task 6). Remove the `flushRan` local variable and manual flush ordering.
  - **turn.ts**: Already uses `runtime.clients.turn` — verify it works with evolved `AppUserFacade`
  - **debug.ts**: Already uses `runtime.clients.inspect` — verify it works with evolved `AppUserFacade`
  - For all three: ensure `createAppClientRuntime()` bridge (Task 17) routes correctly

  **Must NOT do**:
  - Do not change `createAppClientRuntime()` yet (that's Task 17 — bridge update)
  - Do not add new debug commands

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Multi-file change, but each file is relatively simple
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 10, 12, 13, 14)
  - **Blocks**: Tasks 15, 17
  - **Blocked By**: Tasks 5, 6, 7

  **References**:

  **Pattern References**:
  - `src/terminal-cli/commands/session.ts:155-161` — CLI close with wrong-order flush (BUG to fix)
  - `src/terminal-cli/commands/turn.ts:140` — Already uses `createAppClientRuntime()`
  - `src/terminal-cli/commands/debug.ts:172-198` — Already uses `createAppClientRuntime()` via helpers

  **External References**:
  - Consensus A034 (lines 309-311) — CLI flush ordering bug to fix

  **WHY Each Reference Matters**:
  - `session.ts:155-161`: The flush ordering bug — close→flush is wrong, must remove manual flush since facade handles it

  **Acceptance Criteria**:
  - [ ] `session.ts` no longer calls `flushOnSessionClose()` directly
  - [ ] `session close` returns host-aware `SessionCloseResult` with `host_steps`
  - [ ] `bun run build && bun test` passes

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: session close no longer has manual flush
    Tool: Bash (grep)
    Preconditions: session.ts migrated
    Steps:
      1. Search session.ts for `flushOnSessionClose` — should be zero matches
      2. Search session.ts for `runtime.runtime` — should be zero matches
    Expected Result: No direct runtime or flush access
    Evidence: .sisyphus/evidence/task-11-session-no-flush.txt

  Scenario: All three commands compile and tests pass
    Tool: Bash
    Preconditions: All three files updated
    Steps:
      1. Run `bun run build`
      2. Run `bun test test/cli/`
    Expected Result: Clean build, all CLI tests pass
    Evidence: .sisyphus/evidence/task-11-cli-regression.txt
  ```

  **Commit**: YES (groups with Tasks 10, 12, 13)
  - Message: `refactor(cli): migrate CLI commands to AppHost/facades`
  - Files: `src/terminal-cli/commands/session.ts`, `src/terminal-cli/commands/turn.ts`, `src/terminal-cli/commands/debug.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 12. config.ts / agent.ts Migration to AppHostAdmin

  **What to do**:
  - **config.ts**: `handleConfigDoctor()` (lines 325-336) currently calls `bootstrapApp()` and reads `runtime.memoryPipelineStatus` / `runtime.memoryPipelineReady`. Change to:
    - Call `createAppHost({ role: "local", ... })` instead of `bootstrapApp()`
    - Read `host.admin.getHostStatus()` and `host.admin.getPipelineStatus()` instead of raw runtime fields
  - **agent.ts**: `--source runtime` handlers (lines 119-126, 236-243) currently read `runtime.agentRegistry`. Change to:
    - Call `createAppHost({ role: "local", ... })`
    - Read `host.admin.listRuntimeAgents()` instead of `runtime.agentRegistry`

  **Must NOT do**:
  - Do not change config init/validate/show handlers (they don't use runtime)
  - Do not change agent file-based handlers

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Two files, each needs bootstrap swap + service access swap
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 10, 11, 13, 14)
  - **Blocks**: Task 17
  - **Blocked By**: Tasks 5, 8

  **References**:

  **Pattern References**:
  - `src/terminal-cli/commands/config.ts:325-336` — `handleConfigDoctor()` bootstrap + runtime read
  - `src/terminal-cli/commands/agent.ts:119-126,236-243` — Runtime agent registry access

  **API/Type References**:
  - `src/app/host/app-host-admin.ts` (Task 8) — `getHostStatus()`, `getPipelineStatus()`, `listRuntimeAgents()`

  **WHY Each Reference Matters**:
  - `config.ts:325-336`: Exact code to replace — shows which runtime fields are consumed for doctor
  - `agent.ts:119-126`: Shows `agentRegistry.getAll()` pattern being replaced by admin DTO

  **Acceptance Criteria**:
  - [ ] `config doctor` uses `AppHostAdmin` DTOs, no raw runtime access
  - [ ] `agent --source runtime` uses `AppHostAdmin.listRuntimeAgents()`, no raw registry
  - [ ] `bun run build && bun test` passes

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: config doctor and agent runtime use admin facade
    Tool: Bash (grep)
    Preconditions: Both files migrated
    Steps:
      1. Search config.ts for `runtime.memoryPipelineStatus` — zero matches
      2. Search agent.ts for `runtime.agentRegistry` — zero matches
      3. Run `bun run build && bun test`
    Expected Result: No raw runtime access, clean build and tests
    Evidence: .sisyphus/evidence/task-12-admin-migration.txt
  ```

  **Commit**: YES (groups with Tasks 10, 11, 13)
  - Message: `refactor(cli): migrate CLI commands to AppHost/facades`
  - Files: `src/terminal-cli/commands/config.ts`, `src/terminal-cli/commands/agent.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 13. server.ts / index.ts Migration to AppHost Lifecycle

  **What to do**:
  - **server.ts**: Replace `bootstrapApp({ enableGateway: true, ... })` with `createAppHost({ role: "server", ... })`. Replace `app.server.start()` with `await host.start()`. Replace `app.server.getPort()` with `host.getBoundPort()` (see below). Replace admin info reads (`app.runtime.memoryPipelineStatus`) with `host.admin.getPipelineStatus()`. Replace `app.shutdown()` with `await host.shutdown()`.
  - **index.ts**: Same pattern as server.ts — replace `bootstrapApp()` with `createAppHost({ role: "server" })`, replace `app.server.start()` with `await host.start()`, replace `app.server.getPort()` with `host.getBoundPort()`, replace shutdown.
  - **CRITICAL — port: 0 dynamic binding**: Current code uses `GatewayServer.getPort()` (server.ts:94-99) which returns `this.server.port` — the **actual bound port** after OS assigns it. This is needed when `port: 0` is configured (ephemeral port). The plan MUST NOT replace this with `host.options.port` — that would return `0`, not the bound port.
    - Solution: `AppHost` for `server` role MUST expose a `getBoundPort(): number` method (or equivalent) that delegates to `GatewayServer.getPort()` after `host.start()` has been called. This should be added to Task 1's type definitions and Task 5's factory implementation.
    - If `host.start()` has not been called, `getBoundPort()` should throw or return the configured port.
  - Both must handle `await` for the now-async factory (files may need to be in async context)

  **Must NOT do**:
  - Do not change `GatewayServer` constructor/internals (that's Task 14)
  - Do not change signal handling logic

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Server lifecycle wiring, needs careful shutdown ordering
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 10, 11, 12, 14)
  - **Blocks**: Task 17
  - **Blocked By**: Tasks 5, 8

  **References**:

  **Pattern References**:
  - `src/terminal-cli/commands/server.ts:74-80` — Current `bootstrapApp()` call
  - `src/terminal-cli/commands/server.ts:113-114` — Raw runtime reads for pipeline status
  - `src/index.ts:10` — Main entry `bootstrapApp()` call
  - `src/index.ts` — `app.server.start()` / `app.server.stop()` pattern

  **API/Type References**:
  - `src/app/host/types.ts` — `AppHost.start()`, `AppHost.shutdown()`
  - `src/gateway/server.ts:31,87,94` — sync `start()/stop()/getPort()` that host wraps

  **External References**:
  - Consensus A016 (lines 106-108) — `AppHost` lifecycle replaces raw `GatewayServer` access

  **Acceptance Criteria**:
  - [ ] `server.ts` and `index.ts` use `createAppHost({ role: "server" })`
  - [ ] No `app.server.start()` — replaced with `await host.start()`
  - [ ] No `app.server.getPort()` — replaced with `host.getBoundPort()`
  - [ ] No raw `runtime` access
  - [ ] `port: 0` case works correctly — startup output shows actual bound port, not 0
  - [ ] `bun run build && bun test` passes

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Server starts via AppHost lifecycle
    Tool: Bash
    Preconditions: server.ts and index.ts migrated
    Steps:
      1. Search both files for `bootstrapApp(` — zero matches
      2. Search for `app.server.start()` — zero matches
      3. Search for `app.server.getPort()` — zero matches
      4. Search for `host.getBoundPort()` — should appear in both files
      5. Run `bun run build`
    Expected Result: No legacy bootstrap/server access, getBoundPort used correctly
    Evidence: .sisyphus/evidence/task-13-server-migration.txt

  Scenario: Dynamic port binding still works (port: 0 regression)
    Tool: Bash
    Preconditions: server.ts migrated
    Steps:
      1. Run `bun run cli server start --port 0 --json` (or equivalent)
      2. Parse JSON output — verify reported port is > 0 (not 0)
      3. Or: inspect startup log for "started on port NNNN" where NNNN > 0
    Expected Result: Ephemeral port correctly reported after bind
    Failure Indicators: Output shows "port 0" or port field is 0 in JSON
    Evidence: .sisyphus/evidence/task-13-dynamic-port.txt
  ```

  **Commit**: YES (groups with Tasks 10, 11, 12)
  - Message: `refactor(cli): migrate CLI commands to AppHost/facades`
  - Files: `src/terminal-cli/commands/server.ts`, `src/index.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 14. GatewayServer + Controllers Facade Migration

  **What to do**:
  - **GatewayServer**: Refactor `GatewayServerOptions` to accept `AppHost` or facade references instead of scattered params:
    - Replace `runtime?: RuntimeBootstrapResult` with facade references
    - Replace `sessionService: SessionService` with `userFacade.session` (or pass the assembled `AppHost`)
    - Replace `turnService?: TurnService` — flush is now in facade, but turn streaming still needs `TurnService` internally
    - Replace `hasAgent: (id) => boolean` with `admin.listRuntimeAgents()` or equivalent
    - Keep `port` and `host` params
  - **ControllerContext**: Replace `runtime?: RuntimeBootstrapResult` with facade references. Replace `sessionService` / `turnService` / `hasAgent` with facade-mediated access.
  - **controllers.ts**:
    - Replace `inspectClient()` helper (line 163-169) — no longer constructs `new LocalInspectClient(runtime)`, instead uses stable facade reference
    - Replace `sessionClient()` helper (line 159-161) — no longer creates ephemeral `LocalSessionClient`, uses facade
    - Replace `handleCloseSession` flush logic (line 506-512) — facade `closeSession()` now handles flush internally
    - Replace `ctx.runtime?.traceStore` (line 360) — inject through host or turn metadata
    - Replace `requireRuntime()` pattern — return facade-based clients instead
  - **GatewayServer.start() / stop()**: Keep sync internally, but `AppHost` wraps them in async lifecycle

  **Must NOT do**:
  - Do not change HTTP route definitions (paths, methods)
  - Do not change request/response formats EXCEPT for close/recover endpoints — these intentionally evolve to include host-aware result fields per A021 (coordinated with Task 6 Phase E)
  - Do not modify `TurnService` internals

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex refactoring of gateway layer, multiple interconnected patterns, must preserve HTTP behavior
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 10, 11, 12, 13)
  - **Blocks**: Task 15
  - **Blocked By**: Tasks 1, 5, 6, 7

  **References**:

  **Pattern References**:
  - `src/gateway/server.ts:8-17` — `GatewayServerOptions` to refactor
  - `src/gateway/server.ts:27-85` — Constructor + `start()` method building `ControllerContext`
  - `src/gateway/controllers.ts:19-26` — `ControllerContext` type to change
  - `src/gateway/controllers.ts:159-169` — `sessionClient()` and `inspectClient()` helpers
  - `src/gateway/controllers.ts:506-512` — `handleCloseSession` flush pattern
  - `src/gateway/controllers.ts:360` — `ctx.runtime?.traceStore` access

  **API/Type References**:
  - `src/app/host/types.ts` — `AppHost`, `AppUserFacade`, `AppHostAdmin`

  **External References**:
  - Consensus A027 (lines 188-194) — gateway raw runtime leakage cleanup

  **WHY Each Reference Matters**:
  - `server.ts:8-17`: The constructor params that need facade-ification
  - `controllers.ts:19-26`: The context type threading through ALL handlers
  - `controllers.ts:506-512`: The flush pattern being replaced by facade (already correct ordering, but facade absorbs it)
  - `controllers.ts:360`: Raw traceStore access — needs alternative injection

  **Acceptance Criteria**:
  - [ ] `GatewayServerOptions` no longer has `runtime?: RuntimeBootstrapResult`
  - [ ] `ControllerContext` no longer has `runtime?` field
  - [ ] `handleCloseSession` no longer manually calls `flushOnSessionClose`
  - [ ] Zero `RuntimeBootstrapResult` references in `src/gateway/`
  - [ ] `bun run build && bun test` passes

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Zero RuntimeBootstrapResult in gateway
    Tool: Bash (grep)
    Preconditions: Gateway migrated
    Steps:
      1. Search src/gateway/ for `RuntimeBootstrapResult` — zero matches
      2. Search src/gateway/ for `runtime.db` or `runtime.rawDb` — zero matches
      3. Run `bun run build`
    Expected Result: No raw runtime references in gateway
    Evidence: .sisyphus/evidence/task-14-gateway-no-runtime.txt

  Scenario: Gateway close handler delegates to facade
    Tool: Bash (grep)
    Preconditions: controllers.ts migrated
    Steps:
      1. Search controllers.ts for `flushOnSessionClose` — zero matches
      2. Search controllers.ts for `closeSession(` — verify it calls facade method
    Expected Result: Flush handled by facade, not controller
    Evidence: .sisyphus/evidence/task-14-gateway-facade-close.txt

  Scenario: All gateway tests pass
    Tool: Bash
    Preconditions: Gateway migrated
    Steps:
      1. Run `bun test test/gateway/`
      2. Run `bun run build`
    Expected Result: All tests pass, clean build
    Evidence: .sisyphus/evidence/task-14-gateway-regression.txt
  ```

  **Commit**: YES
  - Message: `refactor(gateway): replace raw runtime with facade refs in GatewayServer and controllers`
  - Files: `src/gateway/server.ts`, `src/gateway/controllers.ts`
  - Pre-commit: `bun run build && bun test`

---

### Wave 4 — Unification + Admin Paths

- [ ] 15. Slash-Dispatcher Mode Branch Elimination

  **What to do**:
  - Refactor `src/terminal-cli/shell/slash-dispatcher.ts` to consume a unified client interface (facade) instead of mode-branching:
  - Currently 9 handlers follow `if (ctx.state.mode === "gateway") { gatewayClient.method() } else { loadView(runtime) }` — ALL must be unified
  - Replace pattern: each handler calls the SAME client method (e.g., `inspectClient.getSummary()`) regardless of mode. The client implementation handles local vs gateway internally.
  - **Handlers to unify**:
    1. `/summary` (line ~136-141) — `inspectClient.getSummary()`
    2. `/transcript` (line ~150-155) — `inspectClient.getTranscript()`
    3. `/prompt` (line ~169-174) — `inspectClient.getPrompt()`
    4. `/chunks` (line ~188-193) — `inspectClient.getChunks()`
    5. `/logs` (line ~202-211) — `inspectClient.getLogs()`
    6. `/memory` (line ~221-230) — `inspectClient.getMemory()`
    7. `/diagnose` (line ~244-255) — `inspectClient.diagnose()`
    8. `/trace` (line ~269-274) — `inspectClient.getTrace()`
    9. `/recover` (line ~298-309) — `sessionClient.recoverSession()`
    10. `/close` (line ~316-332) — `sessionClient.closeSession()` (THIRD close path — currently NO flush, must use facade with flush)
  - The slash-dispatcher context should receive `AppUserFacade` (or `InspectClient` + `SessionClient`) instead of raw `runtime` + `gatewayClient`
  - `/close` handler is critical: currently has NO flush at all — unified facade gives it proper flush semantics

  **Must NOT do**:
  - Do not change slash command names or behavior
  - Do not add new slash commands
  - Do not change output formatting

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 10 handlers to refactor, must preserve exact behavior while changing infrastructure
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 16, 17)
  - **Blocks**: Task 19
  - **Blocked By**: Tasks 6, 10, 11, 14

  **References**:

  **Pattern References**:
  - `src/terminal-cli/shell/slash-dispatcher.ts` — All 16 handlers, focus on 10 with mode branching
  - `src/app/clients/inspect-client.ts` — `InspectClient` interface that unified handlers should consume
  - `src/app/clients/session-client.ts` — `SessionClient` interface for /close and /recover

  **External References**:
  - Consensus A026 (lines 183-184) — slash dispatcher should only consume unified facade, no mode judgment
  - Consensus A014 (lines 94-98) — `AppUserFacade.inspect` is the authority

  **WHY Each Reference Matters**:
  - `slash-dispatcher.ts`: The ENTIRE file being refactored — need to understand all 16 handlers
  - `inspect-client.ts`: The unified interface that replaces mode branching
  - `session-client.ts`: The facade for /close and /recover — brings flush semantics to /close

  **Acceptance Criteria**:
  - [ ] Zero `if (mode === "gateway") ... else ...` patterns in slash-dispatcher
  - [ ] `/close` handler now gets proper flush via facade `closeSession()`
  - [ ] All slash handlers consume unified client interface
  - [ ] `bun run build && bun test` passes

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Zero mode branching in slash-dispatcher
    Tool: Bash (ast_grep_search)
    Preconditions: All handlers unified
    Steps:
      1. ast_grep_search for mode === "gateway" patterns in slash-dispatcher.ts
      2. Assert zero matches
    Expected Result: No mode branching remaining
    Failure Indicators: Any remaining if/else mode pattern
    Evidence: .sisyphus/evidence/task-15-no-mode-branch.txt

  Scenario: /close now has flush semantics
    Tool: Bash (grep)
    Preconditions: /close handler unified
    Steps:
      1. Verify /close handler calls sessionClient.closeSession()
      2. Verify no direct sessionService.closeSession() call
    Expected Result: /close uses facade with flush
    Evidence: .sisyphus/evidence/task-15-close-flush.txt

  Scenario: Slash commands still work (regression)
    Tool: Bash
    Preconditions: All handlers unified
    Steps:
      1. Run `bun test test/cli/acceptance.test.ts` (Contract 11 covers slash commands)
      2. Run `bun run build`
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-15-slash-regression.txt
  ```

  **Commit**: YES (groups with Task 16)
  - Message: `refactor(cli): unify slash-dispatcher and SessionShell via facades`
  - Files: `src/terminal-cli/shell/slash-dispatcher.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 16. LocalRuntime Removal + SessionShell Internal Cleanup

  **What to do**:
  NOTE: SessionShell constructor migration to `AppUserFacade` is now handled in Task 10 (co-batched with chat.ts). This task focuses on cleanup and deletion.
  - **LocalRuntime removal**: Delete `src/terminal-cli/local-runtime.ts`:
    - `LocalRuntime` class was needed when shell had `RuntimeBootstrapResult` — no longer needed after Task 10
    - `createLocalRuntime()` factory function also removed
    - Verify no remaining imports of `LocalRuntime` or `createLocalRuntime` anywhere
  - **SessionShell internal cleanup**:
    - Remove any remaining `RuntimeBootstrapResult` type imports from session-shell.ts (should already be gone after Task 10)
    - Verify turn execution uses `facade.turn.streamTurn()` path exclusively (no `localRuntime.executeTurn()` fallback)
    - Clean up any dead code paths that referenced old runtime patterns

  **Must NOT do**:
  - Do not change shell UX (prompts, colors, formatting)
  - Do not change how messages are displayed

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Reduced scope — primarily deletion and dead code cleanup after Task 10 did the heavy lifting
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 15, 17)
  - **Blocks**: Task 19
  - **Blocked By**: Task 10

  **References**:

  **Pattern References**:
  - `src/terminal-cli/local-runtime.ts` — File to DELETE entirely (30 lines)
  - `src/terminal-cli/shell/session-shell.ts` — Verify no RuntimeBootstrapResult remnants

  **API/Type References**:
  - `src/app/host/types.ts` — `AppUserFacade` (already consumed after Task 10)

  **External References**:
  - Consensus A018 (lines 117-121) — `LocalRuntime` is transition debt, should disappear

  **WHY Each Reference Matters**:
  - `local-runtime.ts`: Being deleted — verify nothing else imports it
  - `session-shell.ts`: Verify Task 10 left no dead code

  **Acceptance Criteria**:
  - [ ] `local-runtime.ts` deleted
  - [ ] Zero `createLocalRuntime` or `LocalRuntime` references in codebase
  - [ ] Zero `RuntimeBootstrapResult` references in `src/terminal-cli/shell/`
  - [ ] `bun run build && bun test` passes

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: No RuntimeBootstrapResult in shell code
    Tool: Bash (grep)
    Preconditions: Shell migrated, LocalRuntime removed
    Steps:
      1. Search src/terminal-cli/shell/ for `RuntimeBootstrapResult` — zero matches
      2. Search entire src/ for `createLocalRuntime` — zero matches
      3. Run `bun run build`
    Expected Result: No raw runtime in shell, no LocalRuntime usage
    Evidence: .sisyphus/evidence/task-16-shell-no-runtime.txt
  ```

  **Commit**: YES (groups with Task 15)
  - Message: `refactor(cli): remove LocalRuntime + cleanup dead RuntimeBootstrapResult refs in shell`
  - Files: `src/terminal-cli/local-runtime.ts` (deleted), `src/terminal-cli/shell/session-shell.ts` (cleanup)
  - Pre-commit: `bun run build && bun test`

---

- [ ] 17. createAppClientRuntime() Bridge Update

  **What to do**:
  - Update `src/terminal-cli/app-client-runtime.ts` to use `createAppHost()` internally for local mode:
    - `mode === "local"`: Call `createAppHost({ role: "local", ... })` instead of `bootstrapApp()`
    - Expose `host.user` as `clients` (since `AppUserFacade` ≈ `AppClients`)
    - Remove `runtime?: RuntimeBootstrapResult` from `AppClientRuntime` type — this was the escape hatch (A018)
    - Gateway mode continues to use `createGatewayAppClients()`
  - This bridge enables `session.ts`, `turn.ts`, `debug.ts` to continue working via their `createAppClientRuntime()` calls while the underlying implementation uses `AppHost`
  - Mark `AppClientRuntime` type with `@deprecated` — callers should migrate to `AppHost` directly in future

  **Must NOT do**:
  - Do not change gateway mode HTTP client creation
  - Do not remove the bridge entirely (commands still use it)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Bridge between old and new patterns, must maintain backward compatibility
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 15, 16)
  - **Blocks**: Task 19
  - **Blocked By**: Tasks 11, 12, 13

  **References**:

  **Pattern References**:
  - `src/terminal-cli/app-client-runtime.ts:18-43` — Current `createAppClientRuntime()` function
  - `src/terminal-cli/app-client-runtime.ts:11-16` — `AppClientRuntime` type with `runtime?` escape hatch

  **API/Type References**:
  - `src/app/host/create-app-host.ts` (Task 5) — new factory to call

  **WHY Each Reference Matters**:
  - `app-client-runtime.ts:18-43`: The exact function being updated — local mode branch changes from `bootstrapApp()` to `createAppHost()`
  - `app-client-runtime.ts:11-16`: The `runtime?` field to remove — was A018's escape hatch

  **Acceptance Criteria**:
  - [ ] Local mode uses `createAppHost()` internally
  - [ ] `AppClientRuntime` no longer exposes `runtime?: RuntimeBootstrapResult`
  - [ ] Gateway mode unchanged
  - [ ] `bun run build && bun test` passes

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Bridge uses AppHost internally
    Tool: Bash (grep)
    Preconditions: Bridge updated
    Steps:
      1. Search app-client-runtime.ts for `bootstrapApp(` — zero matches
      2. Search for `createAppHost(` — one match in local mode branch
      3. Verify `runtime?` field removed from AppClientRuntime type
      4. Run `bun run build && bun test`
    Expected Result: Bridge delegates to AppHost, no runtime escape hatch
    Evidence: .sisyphus/evidence/task-17-bridge-update.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): update createAppClientRuntime bridge to use AppHost internally`
  - Files: `src/terminal-cli/app-client-runtime.ts`
  - Pre-commit: `bun run build && bun test`

---

### Wave 5 — Test Restructure + Acceptance

- [ ] 18. package.json 4-Tier Test Scripts + PG Test Hermetic Isolation

  **What to do**:
  - **Phase A — PG test skip wrappers**: `test/jobs/*.test.ts` (15 files) and `test/pg-app/*.test.ts` (24 files) use hardcoded `127.0.0.1:55432` via `test/helpers/pg-test-utils.ts` — they FAIL (not skip) without PG. To make `bun test` a true hermetic baseline:
    - Add env-check skip wrapper to `test/helpers/pg-test-utils.ts`: check for `PG_TEST_URL` or attempt a fast TCP probe on `127.0.0.1:55432`. If unavailable, export a `skipPgTests = true` flag.
    - In each PG test file's top-level `describe()`, add conditional skip: `describe.skipIf(skipPgTests)("pg-connection", () => { ... })` (Bun natively supports `describe.skipIf`)
    - Alternatively, wrap with `const describePg = skipPgTests ? describe.skip : describe;` at the top of each PG test file
    - This is a mechanical edit across ~39 files — pattern is identical for all
  - **Phase B — 4 test tier scripts in package.json** per consensus A024:
    ```json
    {
      "test": "bun test",
      "test:acceptance:app-host": "bun test test/cli/acceptance.test.ts test/cli/debug-commands.test.ts test/app/app-host.test.ts test/app/session-close-flush.test.ts test/app/facade-contract.test.ts test/architecture/import-boundaries.test.ts",
      "test:pg:data-plane": "PG_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs_test bun test test/pg-app/ test/jobs/ test/scripts/memory-verify-pg.test.ts test/migration/parity-verify.test.ts",
      "test:acceptance:closeout": "bun run test:acceptance:app-host && bun run test:pg:data-plane"
    }
    ```
  - `test` = `bun test` — hermetic baseline. PG tests auto-SKIP (via Phase A wrappers) when PG is not available. This matches A010: "bun test 退回 hermetic baseline."
  - `test:pg:data-plane` — explicitly sets `PG_TEST_URL` env and runs PG-dependent test directories
  - `test:acceptance:closeout` — chains app-host + pg-data-plane as go/no-go gate
  - Do NOT move test files — only add skip wrappers + script entries

  **Must NOT do**:
  - Do not restructure test directories
  - Do not delete or rename existing test files
  - Do not change PG test LOGIC — only add skip-when-unavailable wrappers

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Mechanical but wide-reaching — PG skip wrappers touch ~39 test files + package.json edit. Pattern is repetitive but must be applied to every PG test file.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — BUT Task 18 should complete BEFORE Task 19
  - **Parallel Group**: Wave 5 (with Tasks 20, 21 in parallel; Task 19 waits on this)
  - **Blocks**: Task 19, F1-F4
  - **Blocked By**: None (PG skip wrappers are independent of implementation tasks)

  **References**:

  **Pattern References**:
  - `test/helpers/pg-test-utils.ts:4-6` — Hardcoded `127.0.0.1:55432` URLs (root cause of non-hermetic `bun test`)
  - `test/jobs/pg-connection.test.ts:13` — Example PG test without skip logic
  - `test/jobs/*.test.ts` (15 files) — ALL use `pg-test-utils.ts`
  - `test/pg-app/*.test.ts` (24 files) — ALL need skip wrappers
  - `package.json` — current test scripts section

  **External References**:
  - Consensus A010 (lines 68-72) — "bun test 退回 hermetic baseline"
  - Consensus A024 (lines 160-168) — 4-tier test naming
  - Bun test docs: `describe.skipIf(condition)` API

  **Acceptance Criteria**:
  - [ ] `bun test` passes on a machine WITHOUT PG at 127.0.0.1:55432 (PG tests skip, not fail)
  - [ ] All 4 test tier scripts defined in package.json
  - [ ] `test/helpers/pg-test-utils.ts` exports a `skipPgTests` flag (or equivalent)
  - [ ] Every PG test file in `test/jobs/` and `test/pg-app/` uses skip-when-unavailable wrapper
  - [ ] `bun run test:pg:data-plane` still runs PG tests when PG IS available

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Hermetic baseline passes without PG
    Tool: Bash
    Preconditions: Skip wrappers applied, PG NOT running
    Steps:
      1. Ensure no PG process at 127.0.0.1:55432 (or unset PG_TEST_URL)
      2. Run `bun test`
      3. Verify output shows PG tests as "skipped" not "failed"
      4. Verify non-PG tests all pass
    Expected Result: Zero failures, PG tests marked as skipped
    Failure Indicators: Any PG test showing as "failed" instead of "skipped"
    Evidence: .sisyphus/evidence/task-18-hermetic-baseline.txt

  Scenario: All 4 test tier scripts are correctly defined
    Tool: Bash (grep)
    Preconditions: Scripts added to package.json
    Steps:
      1. Grep package.json for "test:acceptance:app-host" — should exist
      2. Grep package.json for "test:pg:data-plane" — should exist
      3. Grep package.json for "test:acceptance:closeout" — should exist
      4. Verify facade-contract.test.ts is included in test:acceptance:app-host script
    Expected Result: All 4 scripts defined with correct test file references
    Evidence: .sisyphus/evidence/task-18-test-scripts.txt

  Scenario: PG tests still run when PG is available
    Tool: Bash
    Preconditions: PG running at 127.0.0.1:55432
    Steps:
      1. Run `bun run test:pg:data-plane`
      2. Verify PG tests execute (not skip)
    Expected Result: PG tests run and pass
    Evidence: .sisyphus/evidence/task-18-pg-tests-when-available.txt
  ```

  **Commit**: YES (groups with Tasks 19, 20, 21)
  - Message: `test: add 4-tier test scripts and app-host acceptance suite`
  - Files: `package.json`
  - Pre-commit: `bun run build`

---

- [ ] 19. App-Host Acceptance Test Suite

  **What to do**:
  - Create comprehensive acceptance tests for the AppHost surface in `test/app/`:
  - **test/app/app-host.test.ts** (started in Task 5, expanded here):
    - Test `createAppHost({ role: "local", databasePath: ":memory:" })` lifecycle
    - Test `createAppHost({ role: "server", databasePath: ":memory:", port: 0 })` lifecycle
    - Test role facet matrix per A022: local has user+admin, server has user+admin, maintenance facet conditional
    - Test `host.admin.getHostStatus()` returns correct DTO
    - Test `host.admin.getPipelineStatus()` returns correct DTO
    - Test `host.start()` / `host.shutdown()` lifecycle
  - **test/app/session-close-flush.test.ts** (started in Task 6, expanded here):
    - Test all 4 flush decision matrix outcomes (A034)
    - Test flush failure → session stays open (A015)
    - Test `SessionCloseResult` has `host_steps` field
    - Test `SessionRecoverResult` has `action` + `note_code` fields
  - **test/app/facade-contract.test.ts** (new):
    - Test that `AppUserFacade` contract works end-to-end: create session → send turn → inspect → close
    - Test unified close contract between local and gateway implementations
    - Verify no `RuntimeBootstrapResult` leakage through any facade
  - Follow existing test patterns from `test/cli/acceptance.test.ts` for structure

  **Must NOT do**:
  - Do not test internal implementation details (private methods, internal wiring)
  - Do not require PG for these tests (all in-memory SQLite)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Comprehensive test suite covering multiple facade contracts, requires understanding of entire new AppHost surface
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (needs all previous tasks complete)
  - **Parallel Group**: Wave 5 (but runs after Tasks 15-18 complete)
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 15, 16, 17, 18

  **References**:

  **Pattern References**:
  - `test/cli/acceptance.test.ts` — Existing acceptance test structure (13 contracts) — follow this pattern
  - `test/cli/debug-commands.test.ts` — Seed functions pattern for test data setup

  **API/Type References**:
  - `src/app/host/types.ts` — All facade types being tested
  - `src/app/host/create-app-host.ts` — Factory being tested

  **External References**:
  - Consensus A024 (lines 166-168) — minimum coverage for app-host tier

  **WHY Each Reference Matters**:
  - `acceptance.test.ts`: The gold-standard test structure to follow — bootstrapApp + in-memory DB + assertions
  - `debug-commands.test.ts`: Shows seed function pattern for setting up test data

  **Acceptance Criteria**:
  - [ ] `bun run test:acceptance:app-host` passes with all new tests
  - [ ] Covers: local/server bootstrap, session lifecycle, flush matrix, admin DTOs, facade contract
  - [ ] All tests use `:memory:` DB (hermetic)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: App-host acceptance suite passes
    Tool: Bash
    Preconditions: All test files created and Wave 1-4 tasks complete
    Steps:
      1. Run `bun run test:acceptance:app-host`
      2. Verify all tests pass
      3. Verify test count matches expected (check output)
    Expected Result: All tests pass, comprehensive coverage of AppHost surface
    Evidence: .sisyphus/evidence/task-19-acceptance-suite.txt

  Scenario: Tests are hermetic (no external dependencies)
    Tool: Bash
    Preconditions: Test suite created
    Steps:
      1. Run tests without PG_APP_TEST_URL, OPENAI_API_KEY, etc.
      2. Verify all pass (in-memory DB, no external services)
    Expected Result: 100% pass rate without external deps
    Evidence: .sisyphus/evidence/task-19-hermetic.txt
  ```

  **Commit**: YES (groups with Tasks 18, 20, 21)
  - Message: `test: add 4-tier test scripts and app-host acceptance suite`
  - Files: `test/app/app-host.test.ts`, `test/app/session-close-flush.test.ts`, `test/app/facade-contract.test.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 20. Import Boundary Extension for Facade Leak Detection

  **What to do**:
  - Extend `test/architecture/import-boundaries.test.ts` to verify:
    1. Existing rule preserved: `src/app/`, `src/bootstrap/`, `src/gateway/` must NOT import from `src/terminal-cli/`
    2. New rule: `src/terminal-cli/commands/` and `src/terminal-cli/shell/` must NOT import `RuntimeBootstrapResult` (facade leak prevention)
    3. New rule: `src/app/clients/` must NOT import `InteractionStore` (edge code leak prevention)
    4. New rule: `src/gateway/controllers.ts` must NOT import `RuntimeBootstrapResult`
  - These rules ensure the facade isolation seam holds as codebase evolves

  **Must NOT do**:
  - Do not change existing passing boundary rules
  - Do not make rules so strict they break legitimate imports

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small test file extension, pattern matching additions
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with Tasks 19, 21) — runs after Wave 3-4 migrations complete so boundary rules can actually pass
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 15, 16, 17 (all RuntimeBootstrapResult/InteractionStore migrations must be complete for boundary rules to pass)

  **References**:

  **Pattern References**:
  - `test/architecture/import-boundaries.test.ts` (85 lines) — existing boundary test structure

  **WHY Each Reference Matters**:
  - `import-boundaries.test.ts`: The exact file to extend — need to follow existing scan pattern

  **Acceptance Criteria**:
  - [ ] New boundary rules added
  - [ ] All boundary tests pass with current migrated code
  - [ ] `bun test test/architecture/import-boundaries.test.ts` passes

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Extended boundary tests pass
    Tool: Bash
    Preconditions: Boundaries extended
    Steps:
      1. Run `bun test test/architecture/import-boundaries.test.ts`
    Expected Result: All boundary rules pass (no leaks)
    Evidence: .sisyphus/evidence/task-20-boundaries.txt
  ```

  **Commit**: YES (groups with Tasks 18, 19, 21)
  - Message: `test: add 4-tier test scripts and app-host acceptance suite`
  - Files: `test/architecture/import-boundaries.test.ts`
  - Pre-commit: `bun run build && bun test`

---

- [ ] 21. Transition Shim Deprecation Markers

  **What to do**:
  - Add `@deprecated` JSDoc markers to transition shims that will be removed in future rounds:
    - `bootstrapApp()` in `src/bootstrap/app-bootstrap.ts` — `@deprecated Use createAppHost() instead`
    - `AppClientRuntime` type in `src/terminal-cli/app-client-runtime.ts` — `@deprecated Use AppHost directly`
    - `createAppClientRuntime()` in `src/terminal-cli/app-client-runtime.ts` — `@deprecated Use createAppHost() instead`
    - `AppClients` type alias (if kept as alias) — `@deprecated Use AppUserFacade instead`
    - `AppBootstrapResult` in `src/bootstrap/types.ts` — `@deprecated Use AppHost instead`
  - Do NOT delete these — they remain functional for backward compatibility
  - Add inline comments explaining migration path

  **Must NOT do**:
  - Do not delete any deprecated items
  - Do not break any existing imports

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: JSDoc annotation additions only
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with Tasks 18, 19, 20)
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 5, 17

  **References**:

  **Pattern References**:
  - `src/bootstrap/app-bootstrap.ts:34` — `bootstrapApp()` function
  - `src/terminal-cli/app-client-runtime.ts:11-16,18` — `AppClientRuntime` type and factory
  - `src/bootstrap/types.ts:122-128` — `AppBootstrapResult` type

  **Acceptance Criteria**:
  - [ ] All transition shims have `@deprecated` JSDoc
  - [ ] `bun run build` passes (deprecation warnings may appear, that's expected)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Deprecation markers present
    Tool: Bash (grep)
    Preconditions: Markers added
    Steps:
      1. Search for `@deprecated` in bootstrapApp, AppClientRuntime, createAppClientRuntime, AppBootstrapResult
      2. Verify each has deprecation notice
    Expected Result: All shims marked deprecated
    Evidence: .sisyphus/evidence/task-21-deprecation-markers.txt
  ```

  **Commit**: YES
  - Message: `chore: add transition shim deprecation markers for AppHost migration`
  - Files: `src/bootstrap/app-bootstrap.ts`, `src/bootstrap/types.ts`, `src/terminal-cli/app-client-runtime.ts`, `src/app/clients/app-clients.ts`
  - Pre-commit: `bun run build`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Results are presented to user as a consolidated report. No blocking "explicit user okay" gate — verification is autonomous, but rejection triggers automatic fix-and-rerun.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Specific checks: (1) All facade methods return `Promise<T>`, (2) `AppHost` facet matrix per A022 — including server role gets maintenance only when explicitly enabled, (3) `closeSession()` decision matrix per A034, (4) Zero `RuntimeBootstrapResult` in edge code, (5) No `_internal.runtime` escape hatches, (6) All 35 consensus decisions addressed or explicitly deferred, (7) `bootstrapApp()` shims to `createAppHost()` (not reverse), (8) PG tests skip without PG, (9) `getBoundPort()` works for port: 0 case — no port regression.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` + `bun test` (on machine without PG to verify hermetic baseline). Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify no raw `db`/`rawDb`/`pgFactory` leaks through facades. Verify all SessionService callers have `await`.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail/N skip] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state. Execute EVERY QA scenario from EVERY task. Test cross-task integration: (1) `createAppHost({ role: "local" })` → `host.user.session.closeSession()` → verify flush decision matrix, (2) `createAppHost({ role: "server" })` → `host.start()` → HTTP endpoint works → `host.shutdown()`, (3) slash commands work without mode branching, (4) SessionShell accepts `host.user` — no raw runtime. Save evidence to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance: no TurnService flush/threshold/sweeper/settlement changes (await additions ARE allowed), no SessionService constructor change, no service implementation replacement, no test file moves (skip wrappers ARE allowed). Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| Wave | Commit | Message | Key Files | Pre-commit Gate |
|------|--------|---------|-----------|-----------------|
| 1 | C1 | `feat(app): add AppHost types, AppRole, and facade type definitions` | `src/app/host/types.ts` | `bun run build` |
| 1 | C2 | `refactor(session): make SessionService methods async + update all 15+ callers` | `src/session/service.ts`, `turn-service.ts`, `user-turn-service.ts`, `tool-adapter.ts`, `view-models.ts`, `diagnose-service.ts`, `local-session-client.ts`, callers, tests | `bun run build && bun test` |
| 2 | C3 | `feat(app): implement createAppHost factory (bootstrapRuntime direct, shim bootstrapApp)` | `src/app/host/create-app-host.ts`, `src/bootstrap/app-bootstrap.ts` | `bun run build && bun test` |
| 2 | C4 | `refactor(app): evolve AppClients to AppUserFacade with flush absorption` | `src/app/clients/`, facade closeSession | `bun run build && bun test` |
| 2 | C5 | `refactor(app): migrate InteractionStore→InteractionRepo in edge code` | `local-turn-client.ts`, `app-clients.ts` | `bun run build && bun test` |
| 3 | C6 | `refactor(cli): migrate chat.ts + SessionShell constructor to AppHost/facade` | `commands/chat.ts`, `session-shell.ts` | `bun run build && bun test` |
| 3 | C7 | `refactor(gateway): replace raw runtime with facade refs` | `server.ts`, `controllers.ts` | `bun run build && bun test` |
| 4 | C8 | `refactor(cli): unify slash-dispatcher + remove LocalRuntime` | `slash-dispatcher.ts`, `local-runtime.ts` (deleted) | `bun run build && bun test` |
| 5 | C9 | `test: add PG skip wrappers + 4-tier test scripts + app-host acceptance suite` | `test/helpers/pg-test-utils.ts`, `test/jobs/*.test.ts`, `test/pg-app/*.test.ts`, `package.json`, `test/app/*.test.ts` | `bun run build && bun test` |
| 5 | C10 | `chore: add transition shim deprecation markers` | multiple files | `bun run build && bun test` |

---

## Success Criteria

### Verification Commands
```bash
bun run build                          # Expected: exit 0, zero errors
bun test                               # Expected: hermetic baseline — all non-PG pass, PG tests SKIP (not fail)
bun run test:acceptance:app-host       # Expected: AppHost factory, close/recover, inspect, admin
bun run test:pg:data-plane             # Expected: PG data-plane (requires PG at 127.0.0.1:55432)
bun run test:acceptance:closeout       # Expected: aggregates app-host + pg-data-plane
```

### Final Checklist
- [ ] All "Must Have" present (see Work Objectives)
- [ ] All "Must NOT Have" absent (see Guardrails)
- [ ] All tests pass across 4 tiers
- [ ] Zero `RuntimeBootstrapResult` in edge consumer code
- [ ] Zero `InteractionStore` in facade/edge type signatures
- [ ] Zero mode branching in slash-dispatcher
- [ ] All facade methods async
- [ ] Consensus A001-A035 addressed or explicitly deferred with rationale
