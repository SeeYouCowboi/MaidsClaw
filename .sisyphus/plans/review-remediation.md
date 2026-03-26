# Review Remediation: Architecture Enforcement & Legacy Cleanup

## TL;DR

> **Quick Summary**: Remediate 6 architectural issues from code review — enforce WriteTemplate at write boundaries, implement ArtifactContract runtime consumption, add publication failure recovery, validate contested evidence storage, add retrieval observability, and clean up remaining legacy remnants.
>
> **Deliverables**:
> - WriteTemplate enforcement gates at cognition/publication write boundaries
> - ArtifactContract runtime enforcement (authority/scope/ledger/trace-redaction)
> - PublicationRecoverySweeper with persistent recovery state machine
> - Contested evidence write-time schema validation
> - Navigator supplemental retrieval debug logging
> - Legacy cleanup: test fixes, LSP type fix, doc update, zero-match gate
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 waves + final verification
> **Critical Path**: Wave 0 prerequisites → Wave 1 enforcement foundations → Wave 2 infrastructure → Wave 3 cleanup → Final Verification

---

## Context

### Original Request
Analyze and act on a ChatGPT code review identifying 6 architectural issues (A1-A6) and 7 legacy cleanup items (B1-B7). After thorough codebase exploration and verification, confirmed A1/A2/A4/A5/A6 are 100% accurate, A3 partially accurate, and B1-B6 already ~95% complete.

### Interview Summary
**Key Discussions**:
- A1 WriteTemplate: True enforcement at write boundaries (not just types)
- A2 ArtifactContract: Full runtime implementation per consensus doc §18.23
- A3 Contested evidence: Storage-layer schema validation only (not full restructuring)
- A4 Publication recovery: Independent PublicationRecoverySweeper (not extending PendingSettlementSweeper)
- A5 AreaStateService: **DEFERRED** — not in this round
- A6 Retrieval observability: Debug-level logging in navigator catch blocks
- Test strategy: TDD with `bun test`

**Research Findings**:
- WriteTemplate `resolveWriteTemplate()` and `getDefaultWriteTemplate()` exist but are NEVER CALLED
- ArtifactContract 8 contracts attached to `submit_rp_turn` but tool-executor just passes through
- Publication `createPublicationEventWithRetry()` silently skips after 3 retries — data loss risk
- Navigator `collectSupplementalSeeds()` has 2 silent catch blocks — zero observability
- Legacy cleanup ~95% done; `src/` has zero legacy pattern matches

### Metis Review
**Identified Gaps** (addressed):
- **CRITICAL: `rp_settlement` phantom capability** — `submit_rp_turn` declares `capability_requirements: ["rp_settlement"]` but `CAPABILITY_MAP` has no such entry. Activating enforcement would block ALL RP turn submissions. → Added as Wave 0 prerequisite.
- **`_memory_maintenance_jobs` table provenance unknown** — PendingSettlementSweeper uses this table but DDL origin unclear. → Added as Wave 0 verification task.
- **Write-time validation gap** — `conflict_factor_refs_json` validated only on read, not on write. → A3 now covers both paths.
- **ArtifactContract scope creep risk** — §18.23 envisions much more than current 3 fields. → Explicitly scoped to existing fields only.
- **WriteTemplate vs CAPABILITY_MAP overlap** — Must be complementary, not duplicative. → WriteTemplate gates at settlement boundary, CAPABILITY_MAP at tool dispatch.

---

## Work Objectives

### Core Objective
Enforce architectural contracts that currently exist as dead code or metadata, add persistent recovery for publication failures, and complete legacy cleanup with automated verification gates.

### Concrete Deliverables
- `src/memory/contracts/write-template.ts` — enforcement functions actually called at write boundaries
- `src/core/tools/artifact-contract-policy.ts` (new) — runtime ArtifactContract enforcement
- `src/memory/publication-recovery-sweeper.ts` (new) — persistent publication recovery
- `src/memory/cognition/private-cognition-current.ts` — write-time validation for conflict_factor_refs_json
- `src/memory/navigator.ts` — debug logging in catch blocks
- Updated tests, docs, and zero-match gate

### Definition of Done
- [ ] `bun run build` passes (tsc --noEmit, zero errors)
- [ ] `bun test` passes (all existing + new tests)
- [ ] WriteTemplate blocks maiden/task_agent cognition writes with `WRITE_TEMPLATE_DENIED`
- [ ] ArtifactContract `ledger_policy`/`authority_level`/`artifact_scope` consumed at runtime
- [ ] Publication failures produce persistent recovery jobs (not silent skips)
- [ ] `conflict_factor_refs_json` validated at write time
- [ ] Navigator catch blocks emit `console.debug` with context
- [ ] Zero legacy pattern matches outside historical exemptions

### Must Have
- WriteTemplate enforcement at settlement processing boundary
- ArtifactContract enforcement for all 8 `submit_rp_turn` artifacts
- PublicationRecoverySweeper with idempotent recovery
- Write-time validation for conflict_factor_refs_json
- Debug logging in navigator catch blocks
- Zero-match gate for legacy patterns

### Must NOT Have (Guardrails)
- **DO NOT** implement §18.23 `derive_only`/`proposal_write`/`authoritative_write` effect_type expansion — DEFERRED
- **DO NOT** implement `read_scope`/`write_scope` split — DEFERRED
- **DO NOT** add new `ArtifactContract` fields beyond existing 3
- **DO NOT** add WriteTemplate checks inside `CognitionRepository` internals — gate belongs at service boundary
- **DO NOT** modify `PendingSettlementSweeper` — new sweeper is independent
- **DO NOT** change navigator catch-and-continue behavior — only add logging
- **DO NOT** add AreaStateService — explicitly deferred
- **DO NOT** use `console.warn` for retrieval degradation — use `console.debug` (expected transient failures)
- **DO NOT** add structured logging infrastructure dependencies

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (`bun test`, extensive test files in both `src/*.test.ts` and `test/`)
- **Automated tests**: TDD (RED → GREEN → REFACTOR)
- **Framework**: `bun test`
- **Convention**: Unit tests co-located in `src/`; integration/pipeline tests in `test/`

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Enforcement tasks (A1, A2, A3)**: Positive test (authorized passes) + Negative test (unauthorized rejected with correct error code)
- **Infrastructure (A4)**: Mock DB with orphaned settlement → verify recovery
- **Observability (A6)**: Spy on console.debug → verify called with args
- **Cleanup (B)**: Grep verification → zero matches outside exemptions

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 0 (Prerequisites — must complete before all other work):
├── Task 1: Wire executionContext in AgentLoop + fix rp_settlement [deep]
└── Task 2: Internal type/interface cleanup (EmbeddingPurpose, legacy method names) [quick]

Wave 1 (Enforcement Foundations — parallel after Wave 0):
├── Task 3: A1 WriteTemplate enforcement + TDD [deep]
├── Task 4: A3 conflict_factor_refs_json write-time validation + TDD [quick]
└── Task 5: A6 Navigator debug logging + TDD [quick]

Wave 2 (Infrastructure — parallel after Wave 1):
├── Task 6: A2 ArtifactContract runtime enforcement + TDD [deep]
└── Task 7: A4 PublicationRecoverySweeper + TDD [deep]

Wave 3 (Documentation — after Wave 2):
└── Task 8: Update architecture & regression docs [writing]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit (deep)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| T1 | — | T3, T6 |
| T2 | — | T3, T4, T5 |
| T3 | T1, T2 | T6 |
| T4 | T2 | T8 |
| T5 | T2 | T8 |
| T6 | T3 | T8 |
| T7 | T1 | T8 |
| T8 | T4, T5, T6, T7 | FINAL |
| F1-F4 | T8 | — |

### Agent Dispatch Summary

- **Wave 0**: 2 tasks — T1 → `deep`, T2 → `quick`
- **Wave 1**: 3 tasks — T3 → `deep`, T4 → `quick`, T5 → `quick`
- **Wave 2**: 2 tasks — T6 → `deep`, T7 → `deep`
- **Wave 3**: 1 task — T8 → `writing`
- **FINAL**: 4 tasks — F1 → `deep`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. Wire `executionContext` in AgentLoop + fix `rp_settlement` phantom capability

  **What to do**:
  - **Root problem**: `canExecuteTool()` at `agent-loop.ts:300` and `:606` is called as `canExecuteTool(this.profile, toolCall.name)` WITHOUT the `executionContext` parameter. Since `executionContext` is optional, `canExecuteTool()` returns `true` unconditionally (line 96: `if (!executionContext) return true`). This means capability_requirements AND cardinality enforcement are completely bypassed at runtime.
  - RED: Write test showing that canExecuteTool WITH executionContext rejects task_agent calling submit_rp_turn
  - RED: Write test showing that canExecuteTool WITH executionContext respects cardinality (at_most_once tools rejected on second call)
  - GREEN: Fix `rp_settlement` phantom capability — add to `CAPABILITY_MAP` mapping to a new `canSettleRpTurn` field in `AgentPermissions` (rp_agent: true, others: false)
  - GREEN: Scan ALL `capability_requirements` arrays across all tools — fix any other phantom capabilities
  - GREEN: Wire `executionContext` construction and passing in `AgentLoop` at both call sites (lines 300 and 606). Build the `ToolExecutionContext` from `this.profile`, registered tool schemas, agent permissions, and turn-level tool usage tracking.
  - REFACTOR: Verify all existing tests still pass after wiring

  **Must NOT do**:
  - DO NOT change `canExecuteTool()` function signature or logic — only fix calling code and data
  - DO NOT break existing tool execution for any agent type

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Requires understanding AgentLoop lifecycle, tool execution flow, capability system; multi-file changes
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — Wave 0 (with T2)
  - **Blocks**: T3, T6
  - **Blocked By**: None

  **References**:
  - `src/core/agent-loop.ts:300` — first `canExecuteTool(this.profile, toolCall.name)` call WITHOUT executionContext
  - `src/core/agent-loop.ts:606` — second call, same pattern
  - `src/core/tools/tool-access-policy.ts:83-112` — `canExecuteTool()` function; line 86 shows optional `executionContext`, line 96 early-returns `true` when absent
  - `src/core/tools/tool-access-policy.ts:20-32` — CAPABILITY_MAP (11 entries); add `rp_settlement` here
  - `src/core/tools/tool-access-policy.ts:57-72` — `ToolExecutionContext` type: `{ schema, permissions, turnToolsUsed }`
  - `src/memory/contracts/agent-permissions.ts` — `AgentPermissions` type + `getDefaultPermissions(role)`
  - `src/runtime/submit-rp-turn-tool.ts:59` — `capability_requirements: ["rp_settlement"]` phantom source
  - `src/memory/stress-capability-matrix.test.ts` — existing capability tests as pattern reference

  **WHY Each Reference Matters**:
  - `agent-loop.ts:300,606`: These are the call sites that MUST pass executionContext to activate capability/cardinality enforcement
  - `tool-access-policy.ts:96`: This `if (!executionContext) return true` line is why all enforcement is currently bypassed
  - `tool-access-policy.ts:57-72`: ToolExecutionContext type shows what must be constructed and passed

  **Acceptance Criteria**:
  - [ ] `rp_settlement` in CAPABILITY_MAP; AgentPermissions has `canSettleRpTurn`
  - [ ] AgentLoop passes `executionContext` to `canExecuteTool()` at both call sites
  - [ ] Zero phantom capabilities remain (all capability_requirements mapped)
  - [ ] RP agent + submit_rp_turn → allowed; task_agent → denied with TOOL_PERMISSION_DENIED
  - [ ] Cardinality enforcement works (at_most_once tool called twice → rejected)
  - [ ] `bun test` → all pass

  **QA Scenarios:**
  ```
  Scenario: executionContext activates capability enforcement
    Tool: Bash (bun test)
    Steps:
      1. Call canExecuteTool for task_agent on submit_rp_turn WITH executionContext
      2. Assert returns false (task_agent lacks canSettleRpTurn)
      3. Call for rp_agent → assert returns true
    Expected Result: Capability enforcement correctly differentiates agent roles
    Evidence: .sisyphus/evidence/task-1-capability-enforcement.txt

  Scenario: No phantom capabilities in codebase
    Tool: Bash (grep + cross-reference)
    Steps:
      1. grep -rn "capability_requirements" src/ --include="*.ts"
      2. Extract all capability strings
      3. Verify each exists in CAPABILITY_MAP
    Expected Result: Zero unmatched capabilities
    Evidence: .sisyphus/evidence/task-1-no-phantom.txt
  ```

  **Commit**: YES
  - Message: `feat(tools): wire executionContext in AgentLoop and fix rp_settlement capability`
  - Files: agent-loop.ts, tool-access-policy.ts, agent-permissions.ts, tests
  - Pre-commit: `bun test`

- [x] 2. Internal type/interface cleanup (EmbeddingPurpose, legacy method names)

  **What to do**:
  - **Note**: `bun run build && bun run check:legacy-memory-surface` already passes. This task is internal type hygiene, not fixing build errors.
  - Rename `EmbeddingPurpose` value: `src/core/models/embedding-provider.ts:1` — change `"memory_search"` → `"narrative_search"` to align with canonical naming. Update ALL consumers of `EmbeddingPurpose` in tandem.
  - Fix `MemoryTaskModelProvider.embed()` in `src/memory/task-agent.ts:93`: also uses `"memory_search"` — update to match
  - Investigate `src/memory/task-agent.ts:591`: uses `this.storage.createPrivateEvent(...)` — if `GraphStorageService` no longer exposes this method, update to canonical name. If method still exists and is the correct interface, leave as-is.
  - Run `bun run build` → confirm still passes after all renames

  **Must NOT do**:
  - DO NOT change functional behavior — type/naming alignment only
  - DO NOT remove methods that are still needed — only rename to canonical
  - DO NOT assume the build is currently broken — it passes; this is cleanup

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Type alignment, no logic changes
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — Wave 0 (with T1)
  - **Blocks**: T3, T4, T5
  - **Blocked By**: None

  **References**:
  - `src/core/models/embedding-provider.ts:1` — `EmbeddingPurpose = "memory_index" | "memory_search" | "query_expansion"` (rename `memory_search` → `narrative_search`)
  - `src/memory/task-agent.ts:90-93` — `MemoryTaskModelProvider` embed() uses `"memory_search"`; update in tandem
  - `src/memory/task-agent.ts:591` — `this.storage.createPrivateEvent(...)` investigate legacy method
  - `src/memory/model-provider-adapter.ts` — adapter implementing both types; verify compiles
  - `src/core/models/openai-provider.ts` — another consumer of EmbeddingPurpose
  - `test/cli/config-validate.test.ts:259` — already uses `narrative_search` (NO change needed)

  **Acceptance Criteria**:
  - [ ] `bun run build` → still passes (zero errors)
  - [ ] `bun run check:legacy-memory-surface` → still passes
  - [ ] `EmbeddingPurpose` no longer contains `"memory_search"` literal
  - [ ] All consumers compile cleanly

  **QA Scenarios:**
  ```
  Scenario: Build and legacy gate still pass after renames
    Tool: Bash
    Steps:
      1. bun run build
      2. bun run check:legacy-memory-surface
    Expected Result: Both exit code 0
    Evidence: .sisyphus/evidence/task-2-build-clean.txt

  Scenario: No memory_search in EmbeddingPurpose
    Tool: Bash (grep)
    Steps:
      1. grep -n "memory_search" src/core/models/embedding-provider.ts
    Expected Result: Zero matches
    Evidence: .sisyphus/evidence/task-2-no-legacy-embedding.txt
  ```

  **Commit**: YES
  - Message: `refactor(models): rename EmbeddingPurpose memory_search to narrative_search`
  - Pre-commit: `bun run build && bun test`

- [x] 3. A1: WriteTemplate enforcement at settlement boundary (TDD)

  **What to do**:
  - RED: Write tests showing maiden calling `commitCognitionOps()` → rejected with `WRITE_TEMPLATE_DENIED`; rp_agent → allowed
  - RED: Write tests showing task_agent calling `materializePublications()` → rejected; rp_agent → allowed
  - GREEN: Create `enforceWriteTemplate(agentProfile, operation)` pure function in `src/memory/contracts/write-template.ts`. Call `resolveWriteTemplate(profile.role, profile.writeTemplate)` and check `allowCognitionWrites` / `allowPublications` flags. Throw `MaidsClawError` with code `WRITE_TEMPLATE_DENIED` on violation.
  - GREEN: Wire enforcement at `ExplicitSettlementProcessor.process()` entry (cognition writes) and `materializePublications()` entry (publication writes). Pass `agentProfile` or resolved WriteTemplate through the call chain.
  - REFACTOR: Ensure WriteTemplate composes with CAPABILITY_MAP — WriteTemplate at settlement boundary, CAPABILITY_MAP at tool dispatch. No duplication.

  **Must NOT do**:
  - DO NOT add checks inside CognitionRepository internals — gate at service boundary
  - DO NOT change WriteTemplate type contract — only add enforcement consumers
  - DO NOT duplicate CAPABILITY_MAP checks

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Requires understanding settlement flow, agent context propagation, and multi-file changes
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — Wave 1 (with T4, T5)
  - **Blocks**: T6
  - **Blocked By**: T1, T2

  **References**:
  - `src/memory/contracts/write-template.ts:3-37` — WriteTemplate type, defaults, resolve function (currently dead code — make it alive)
  - `src/memory/explicit-settlement-processor.ts` — cognition write path entry; wire enforcement HERE
  - `src/memory/materialization.ts:298-400` — `materializePublications()` entry; wire enforcement HERE
  - `src/memory/cognition-op-committer.ts` — cognition commit path (DO NOT add checks here — too deep)
  - `src/core/tools/tool-access-policy.ts:94-112` — canExecuteTool pattern: pure function, no side effects, returns boolean
  - `src/agents/profile.ts:39` — `writeTemplate?: WriteTemplate` on AgentProfile

  **WHY Each Reference Matters**:
  - `write-template.ts`: The functions that should enforce policy exist but are never called. This task makes them live.
  - `explicit-settlement-processor.ts`: This is the correct enforcement point for cognition writes — high enough to catch all paths, low enough to have agent context.
  - `materialization.ts:298`: This is the correct enforcement point for publications.

  **Acceptance Criteria**:
  - [ ] Test: maiden agent cognition write → `WRITE_TEMPLATE_DENIED` error
  - [ ] Test: task_agent publication → `WRITE_TEMPLATE_DENIED` error
  - [ ] Test: rp_agent cognition write → succeeds
  - [ ] Test: rp_agent publication → succeeds
  - [ ] Test: profile override `{ allowCognitionWrites: true }` on maiden → succeeds
  - [ ] `bun test` → all pass

  **QA Scenarios:**
  ```
  Scenario: Maiden cognition write is blocked
    Tool: Bash (bun test)
    Steps:
      1. Create test with maiden profile (role: "maiden")
      2. Call settlement processor with cognition ops
      3. Assert throws MaidsClawError with code "WRITE_TEMPLATE_DENIED"
    Expected Result: Error thrown with correct code
    Evidence: .sisyphus/evidence/task-3-maiden-blocked.txt

  Scenario: RP agent cognition write succeeds
    Tool: Bash (bun test)
    Steps:
      1. Create test with rp_agent profile
      2. Call settlement processor with cognition ops
      3. Assert no error thrown
    Expected Result: Operation completes successfully
    Evidence: .sisyphus/evidence/task-3-rp-allowed.txt

  Scenario: Profile override allows maiden
    Tool: Bash (bun test)
    Steps:
      1. Create maiden profile with writeTemplate: { allowCognitionWrites: true }
      2. Call settlement processor with cognition ops
      3. Assert succeeds (override takes precedence)
    Expected Result: Override respected, write allowed
    Evidence: .sisyphus/evidence/task-3-override-works.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): enforce WriteTemplate at settlement boundary`
  - Files: write-template.ts, explicit-settlement-processor.ts, materialization.ts, tests
  - Pre-commit: `bun test`

- [ ] 4. A3: Validate conflict_factor_refs_json at write time (TDD)

  **What to do**:
  - RED: Write test: call `applyContestConflictFactors()` with invalid ref `"garbage:ref"` → expect rejection or logged warning + dropped ref
  - RED: Write test: call with valid ref `"assertion:42"` → expect stored correctly
  - GREEN: In `explicit-settlement-processor.ts` `applyContestConflictFactors()` (~line 338-352), add validation using `normalizeConflictFactorRefs()` from `private-cognition-current.ts` BEFORE `JSON.stringify`. Drop invalid refs with `console.warn`.
  - REFACTOR: Ensure read-time validation in `normalizeConflictFactorRefs()` remains as defensive fallback

  **Must NOT do**:
  - DO NOT change read-time validation — it stays as fallback
  - DO NOT throw on invalid refs — drop + warn (same as read-time behavior)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single validation call addition at one write site
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — Wave 1 (with T3, T5)
  - **Blocks**: T8
  - **Blocked By**: T2

  **References**:
  - `src/memory/explicit-settlement-processor.ts:338-352` — write path: `applyContestConflictFactors()` does raw `JSON.stringify(resolvedFactorNodeRefs)` without validation
  - `src/memory/cognition/private-cognition-current.ts:59-79` — `normalizeConflictFactorRefs()` validates against regex `^(assertion|evaluation|commitment|private_episode|event):\d+$`; currently read-only
  - `src/memory/cognition/cognition-search.ts:131-147` — `parseFactorRefsJson()` read-time validation pattern

  **Acceptance Criteria**:
  - [ ] Test: invalid ref → dropped + console.warn
  - [ ] Test: valid ref → stored correctly
  - [ ] Test: empty array → stored as `"[]"`
  - [ ] Read-time validation unchanged

  **QA Scenarios:**
  ```
  Scenario: Invalid conflict factor ref is dropped
    Tool: Bash (bun test)
    Steps:
      1. Call applyContestConflictFactors with ["assertion:1", "garbage:ref", "evaluation:2"]
      2. Read stored conflict_factor_refs_json
      3. Parse and assert only ["assertion:1", "evaluation:2"] present
    Expected Result: Invalid ref dropped, valid refs preserved
    Evidence: .sisyphus/evidence/task-4-invalid-dropped.txt

  Scenario: Valid refs stored correctly
    Tool: Bash (bun test)
    Steps:
      1. Call applyContestConflictFactors with ["assertion:42", "commitment:7"]
      2. Read stored JSON
      3. Assert exact match
    Expected Result: All valid refs stored
    Evidence: .sisyphus/evidence/task-4-valid-stored.txt
  ```

  **Commit**: YES
  - Message: `fix(cognition): validate conflict_factor_refs_json at write time`
  - Files: explicit-settlement-processor.ts, test
  - Pre-commit: `bun test`

- [x] 5. A6: Add debug logging to navigator supplemental seeds (TDD)

  **What to do**:
  - RED: Write test: spy on `console.debug`, trigger narrative search error in `collectSupplementalSeeds()`, assert `console.debug` called with error context
  - GREEN: Replace the 2 silent catch blocks in `navigator.ts:404` and `navigator.ts:431` with `console.debug` calls including: error message, query (truncated to 100 chars), viewer_agent_id
  - REFACTOR: Ensure no behavior change — still catch-and-continue

  **Must NOT do**:
  - DO NOT use console.warn — these are expected transient failures
  - DO NOT change catch-and-continue behavior
  - DO NOT add structured logging dependencies

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Two catch blocks, add one line each
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — Wave 1 (with T3, T4)
  - **Blocks**: T8
  - **Blocked By**: T2

  **References**:
  - `src/memory/navigator.ts:404-406` — catch block 1: `catch { // narrative search unavailable — continue with existing seeds }`
  - `src/memory/navigator.ts:431-433` — catch block 2: `catch { // cognition search unavailable — continue with existing seeds }`
  - `src/memory/navigator.ts:379-437` — full `collectSupplementalSeeds()` method context

  **Acceptance Criteria**:
  - [ ] Test: narrative search error → console.debug called with error message, query snippet, agent_id
  - [ ] Test: cognition search error → console.debug called with error message, query snippet, agent_id
  - [ ] Test: supplemental seeds still work when no errors (behavior unchanged)

  **QA Scenarios:**
  ```
  Scenario: Narrative search failure logs debug
    Tool: Bash (bun test)
    Steps:
      1. Mock narrativeSearch.searchNarrative to throw Error("connection lost")
      2. Call collectSupplementalSeeds("test query", viewerContext, [])
      3. Assert console.debug called with string containing "narrative" and "connection lost"
      4. Assert function returns empty array (graceful degradation preserved)
    Expected Result: Debug logged, no throw, empty supplemental seeds
    Evidence: .sisyphus/evidence/task-5-narrative-debug.txt

  Scenario: No errors produces no debug logs
    Tool: Bash (bun test)
    Steps:
      1. Mock narrativeSearch to return valid results
      2. Call collectSupplementalSeeds
      3. Assert console.debug NOT called
    Expected Result: No spurious debug output on success
    Evidence: .sisyphus/evidence/task-5-no-spurious-debug.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): add debug logging to navigator supplemental seeds`
  - Files: navigator.ts, test
  - Pre-commit: `bun test`

- [ ] 6. A2: ArtifactContract runtime enforcement (TDD)

  **What to do**:
  - RED: Write tests for all 3 enforcement dimensions:
    - `ledger_policy: "append_only"` → verify write targets append-only tables (private_cognition_events, private_episode_events)
    - `authority_level: "agent"` → verify writing agent matches artifact's scope owner
    - `artifact_scope: "private"` → verify private artifacts excluded from public trace output
  - GREEN: Create `src/core/tools/artifact-contract-policy.ts`:
    - `enforceArtifactContracts(contracts: Record<string, ArtifactContract>, context: ArtifactEnforcementContext): void`
    - `filterTraceByArtifactScope(traceEntries, contracts): FilteredTrace` — redact private-scoped artifacts from public traces
  - GREEN: Wire enforcement in settlement processing path (after WriteTemplate gate):
    - In `ExplicitSettlementProcessor.process()` — verify cognition artifacts match append_only + private + agent
    - In `materializePublications()` — verify publication artifacts match append_only + area/world + agent
  - GREEN: Wire trace-aware scope redaction: `TraceStore.addSettlement()` already receives `RedactedSettlement` (type, op_count, kinds). Extend the settlement redaction path to consume `artifactContracts` — when generating `RedactedSettlement`, exclude artifact categories with `artifact_scope: "private"` from the `kinds` array. This uses the existing trace hook at `src/app/diagnostics/trace-store.ts:51-58`, not a hypothetical artifact-level trace structure.
  - REFACTOR: Ensure ArtifactContract enforcement composes with (not duplicates) WriteTemplate and CAPABILITY_MAP

  **Must NOT do**:
  - DO NOT implement §18.23 derive_only/proposal_write/authoritative_write effect_type expansion — DEFERRED
  - DO NOT implement read_scope/write_scope split — DEFERRED
  - DO NOT add new ArtifactContract fields beyond existing 3 (authority_level, artifact_scope, ledger_policy)
  - DO NOT break existing tool execution flow — enforcement is additive

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: New policy module, multi-file wiring, trace redaction integration
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — Wave 2 (with T7)
  - **Blocks**: T8
  - **Blocked By**: T3 (WriteTemplate enforcement must be in place first)

  **References**:
  - `src/core/tools/tool-definition.ts:38-42` — ArtifactContract type: authority_level, artifact_scope, ledger_policy
  - `src/core/tools/tool-definition.ts:64-72` — artifactContracts on ToolSchema
  - `src/runtime/submit-rp-turn-tool.ts:5-46` — 8 concrete artifact contracts (publicReply, privateCognition, privateEpisodes, publications, pinnedSummaryProposal, relationIntents, conflictFactors, areaStateArtifacts)
  - `src/core/tools/tool-executor.ts:80,101` — current pass-through (replace with enforcement call)
  - `src/core/tools/tool-access-policy.ts:94-112` — canExecuteTool pattern (follow this pure-function style)
  - `src/app/diagnostics/trace-store.ts:51-58` — `addSettlement()` receives `RedactedSettlement`; this is the concrete trace hook for scope-based redaction
  - `src/app/contracts/inspect.ts` — `RedactedSettlement` type definition (type, op_count, kinds)
  - `src/app/contracts/trace.ts` — `TraceBundle` type with settlement field
  - Consensus doc §18.23 (lines 2259-2297) — design intent for ArtifactContract as "正式运行时契约"

  **WHY Each Reference Matters**:
  - `submit-rp-turn-tool.ts:5-46`: These 8 contracts are the ONLY concrete instances. All enforcement tests should use these real contracts.
  - `tool-executor.ts:80`: This is where enforcement should be wired — currently just assigns to schema, should also enforce.
  - `tool-access-policy.ts`: Follow this module's pattern for the new policy module.

  **Acceptance Criteria**:
  - [ ] Test: append_only artifact written to current_state table → enforcement error
  - [ ] Test: append_only artifact written to append-only table → allowed
  - [ ] Test: agent-authority artifact with mismatched agent_id → enforcement error
  - [ ] Test: private-scope artifact in public trace → redacted
  - [ ] Test: world-scope artifact in public trace → visible
  - [ ] All 8 submit_rp_turn contracts pass validation with correct write targets
  - [ ] `bun test` → all pass

  **QA Scenarios:**
  ```
  Scenario: Private artifacts excluded from settlement trace kinds
    Tool: Bash (bun test)
    Steps:
      1. Create settlement with both public (publicReply, scope: "world") and private (privateCognition, scope: "private") artifacts
      2. Call the redaction function that builds RedactedSettlement using artifactContracts
      3. Assert RedactedSettlement.kinds does NOT include "privateCognition" or "privateEpisodes"
      4. Assert RedactedSettlement.kinds DOES include "publicReply" and "publications"
    Expected Result: Private-scoped artifact kinds filtered from trace
    Evidence: .sisyphus/evidence/task-6-trace-redaction.txt

  Scenario: Ledger policy append_only is enforced
    Tool: Bash (bun test)
    Steps:
      1. Simulate write to privateCognition (ledger_policy: "append_only")
      2. Verify enforcement allows append operation
      3. Simulate overwrite/update attempt on same artifact
      4. Assert enforcement rejects with appropriate error
    Expected Result: Append allowed, overwrite rejected
    Evidence: .sisyphus/evidence/task-6-ledger-enforce.txt
  ```

  **Commit**: YES
  - Message: `feat(tools): enforce ArtifactContract at runtime`
  - Files: artifact-contract-policy.ts (new), tool-executor.ts, settlement processor, diagnostics trace, tests
  - Pre-commit: `bun test`

- [ ] 7. A4: PublicationRecoverySweeper with persistent recovery (TDD)

  **What to do**:
  - RED: Write test: create orphaned publication (settlement exists but no matching event_nodes row) → sweep → verify event_nodes row created
  - RED: Write test: unique constraint hit during recovery → reconciled (not error)
  - RED: Write test: max retries exhausted → status changes to `exhausted`
  - GREEN: Create `src/memory/publication-recovery-sweeper.ts`:
    - Follow `PendingSettlementSweeper` pattern exactly (constructor DI, start/stop lifecycle, timer-based sweep, backoff with jitter)
    - Use `_memory_maintenance_jobs` table with `job_type = "publication_recovery"`
    - State machine: `pending → retrying → reconciled | exhausted`
    - Idempotency via existing unique constraint `ux_event_nodes_publication_scope`
  - GREEN: In `materializePublications()`, change `return "skipped"` (line 439) to also write a recovery job row BEFORE returning skipped
  - REFACTOR: Wire sweeper into bootstrap/runtime.ts alongside PendingSettlementSweeper

  **Must NOT do**:
  - DO NOT modify PendingSettlementSweeper — independent new sweeper
  - DO NOT add new migrations — `_memory_maintenance_jobs` DDL already exists in `src/memory/schema.ts` (lines 48-50 baseline CREATE TABLE + indexes; migration adds idempotency_key/next_attempt_at)
  - DO NOT change the synchronous retry logic (3x) — only add persistent fallback after exhaustion

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: New sweeper module, state machine, idempotency, DI wiring
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — Wave 2 (with T6)
  - **Blocks**: T8
  - **Blocked By**: T1 (executionContext wiring prerequisite)

  **References**:
  - `src/memory/pending-settlement-sweeper.ts` — **Primary pattern reference**: follow exactly for constructor DI, start/stop, timer, backoff, state machine
  - `src/memory/materialization.ts:434-439` — where `return "skipped"` happens after retry exhaustion; add recovery job write here
  - `src/memory/materialization.ts:298-400` — full materializePublications() context
  - `src/memory/schema.ts` — unique constraint `ux_event_nodes_publication_scope` on event_nodes
  - `src/memory/storage.ts:155-219` — `createProjectedEvent()` used by materialization
  - `src/bootstrap/runtime.ts` — wire sweeper alongside PendingSettlementSweeper

  **WHY Each Reference Matters**:
  - `pending-settlement-sweeper.ts`: Copy this pattern 1:1. Same lifecycle, same table, different job_type.
  - `materialization.ts:439`: The exact line where data is silently lost. Insert recovery job creation before `return "skipped"`.
  - `ux_event_nodes_publication_scope`: This unique constraint is the idempotency key — recovery attempts that hit it → reconciled.

  **Acceptance Criteria**:
  - [ ] Test: orphaned publication → sweep creates event_nodes row
  - [ ] Test: unique constraint during recovery → status = reconciled
  - [ ] Test: N failures → status = exhausted (with configurable max)
  - [ ] Test: sweep is idempotent (re-running on reconciled job is no-op)
  - [ ] materializePublications skipped → recovery job row created
  - [ ] Sweeper wired in bootstrap/runtime.ts

  **QA Scenarios:**
  ```
  Scenario: Recovery sweeper re-materializes orphaned publication
    Tool: Bash (bun test)
    Steps:
      1. Create mock DB with settlement record containing publication data
      2. Verify no matching event_nodes row exists
      3. Insert recovery job (pending status)
      4. Run sweeper.sweep()
      5. Verify event_nodes row now exists with correct source_settlement_id and source_pub_index
      6. Verify job status = reconciled
    Expected Result: Publication materialized, job marked reconciled
    Evidence: .sisyphus/evidence/task-7-recovery-success.txt

  Scenario: Duplicate recovery is idempotent
    Tool: Bash (bun test)
    Steps:
      1. Create recovery job for already-materialized publication
      2. Run sweeper.sweep()
      3. Verify unique constraint hit → job status = reconciled (not error)
    Expected Result: No duplicate event_nodes, job reconciled cleanly
    Evidence: .sisyphus/evidence/task-7-idempotent.txt

  Scenario: materializePublications creates recovery job on skip
    Tool: Bash (bun test)
    Steps:
      1. Mock storage.createProjectedEvent to throw SQLite busy error
      2. Call materializePublications (will exhaust 3 retries)
      3. Verify recovery job row created in _memory_maintenance_jobs
      4. Verify job payload contains settlement_id, pub_index, visibility_scope
    Expected Result: Recovery job created before returning "skipped"
    Evidence: .sisyphus/evidence/task-7-skip-creates-job.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): add PublicationRecoverySweeper`
  - Files: publication-recovery-sweeper.ts (new), materialization.ts, bootstrap/runtime.ts, tests
  - Pre-commit: `bun test`

- [ ] 8. Update architecture & regression docs

  **What to do**:
  - **`docs/MEMORY_ARCHITECTURE_2026.md`** (505 lines):
    - Update §4 (Retrieval Split) to reflect navigator debug logging
    - Update §5 (Memory Tools): remove `memory_search` as active compat alias (tool already removed from code)
    - Update §7 (Compatibility Guarantees): reflect legacy cleanup completion
    - Update §9 (Core Memory Labels): remove `COMPAT_ALIAS_MAP` and `READ_ONLY_LABELS` references (already removed from code)
    - Update §11 (Tool Contracts): document ArtifactContract runtime enforcement (no longer metadata-only)
    - Add new section for WriteTemplate enforcement at settlement boundary
    - Add new section for PublicationRecoverySweeper
    - Document executionContext wiring in AgentLoop
  - **`docs/MEMORY_REGRESSION_MATRIX.md`**:
    - Lines 82-95: `memory_search` is still described as active alias. Update to reflect removal — mark as "retired" or remove the scenario entirely if the tool no longer exists.

  **Must NOT do**:
  - DO NOT change document overall structure
  - DO NOT add speculative future plans — document current state only

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: Multi-doc update requiring understanding of both old and new state
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — Wave 3 (after all implementation)
  - **Blocks**: FINAL
  - **Blocked By**: T4, T5, T6, T7

  **References**:
  - `docs/MEMORY_ARCHITECTURE_2026.md` — main architecture doc (505 lines)
  - `docs/MEMORY_REGRESSION_MATRIX.md:82-95` — `memory_search` still listed as active alias (Scenario 6)
  - `test/memory/legacy-literal-gate.test.ts` — existing zero-match gate (already exempts `.sisyphus/`, `.claude/`, `docs/`)
  - All implementation files from T1-T7 for accurate documentation

  **Acceptance Criteria**:
  - [ ] `memory_search` not described as active tool in either doc
  - [ ] `COMPAT_ALIAS_MAP` / `READ_ONLY_LABELS` not referenced as active code
  - [ ] WriteTemplate enforcement documented
  - [ ] ArtifactContract runtime enforcement documented
  - [ ] PublicationRecoverySweeper documented
  - [ ] executionContext wiring documented
  - [ ] `bun run check:legacy-memory-surface` → still passes

  **QA Scenarios:**
  ```
  Scenario: Docs match code reality
    Tool: Bash (grep)
    Steps:
      1. grep "memory_search" docs/MEMORY_ARCHITECTURE_2026.md — expect zero active references
      2. grep "memory_search.*active\|memory_search.*alias" docs/MEMORY_REGRESSION_MATRIX.md — expect zero or marked retired
      3. grep "WriteTemplate" docs/MEMORY_ARCHITECTURE_2026.md — expect enforcement section exists
      4. bun run check:legacy-memory-surface — expect passes
    Expected Result: All docs accurate, gate still passes
    Evidence: .sisyphus/evidence/task-8-doc-audit.txt
  ```

  **Commit**: YES
  - Message: `docs(memory): update architecture and regression docs to match current state`
  - Files: docs/MEMORY_ARCHITECTURE_2026.md, docs/MEMORY_REGRESSION_MATRIX.md

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `deep`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

  **QA Scenarios:**
  ```
  Scenario: All Must Have items present
    Tool: Bash (grep + read)
    Steps:
      1. For each Must Have item, grep/read the implementation file
      2. Verify WriteTemplate enforcement exists in explicit-settlement-processor.ts
      3. Verify ArtifactContract enforcement exists (artifact-contract-policy.ts)
      4. Verify PublicationRecoverySweeper exists
      5. Verify conflict_factor_refs validation at write time
      6. Verify navigator debug logging
      7. Verify zero-match gate script
    Expected Result: All 6 Must Have items verified
    Evidence: .sisyphus/evidence/final-qa/f1-must-have.txt

  Scenario: All Must NOT Have items absent
    Tool: Bash (grep)
    Steps:
      1. grep -rn "derive_only\|proposal_write\|authoritative_write" src/ — expect 0
      2. grep -rn "read_scope\|write_scope" src/core/tools/ — expect 0
      3. grep -rn "AreaStateService" src/ — expect 0
    Expected Result: Zero matches for all forbidden patterns
    Evidence: .sisyphus/evidence/final-qa/f1-must-not-have.txt
  ```

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

  **QA Scenarios:**
  ```
  Scenario: Build and test pass
    Tool: Bash
    Steps:
      1. bun run build
      2. bun test
    Expected Result: Both exit code 0
    Evidence: .sisyphus/evidence/final-qa/f2-build-test.txt

  Scenario: No code quality violations in new/changed files
    Tool: Bash (grep)
    Steps:
      1. git diff --name-only HEAD~10 -- "*.ts" (get changed files)
      2. For each file: grep "as any\|@ts-ignore\|console\.log\|TODO.*HACK" — expect 0
    Expected Result: Zero quality violations in changed files
    Evidence: .sisyphus/evidence/final-qa/f2-quality.txt
  ```

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | VERDICT`

  **QA Scenarios:**
  ```
  Scenario: All per-task QA scenarios pass
    Tool: Bash (bun test + grep)
    Steps:
      1. Execute each scenario from Tasks 1-10 sequentially
      2. Capture output for each
      3. Verify all expected results match
    Expected Result: All scenarios pass (20+ individual checks)
    Evidence: .sisyphus/evidence/final-qa/f3-all-scenarios.txt

  Scenario: Cross-task integration — WriteTemplate + ArtifactContract compose
    Tool: Bash (bun test)
    Steps:
      1. Simulate RP agent settlement with cognition + publication
      2. Verify WriteTemplate allows (rp_agent has allowCognitionWrites=true)
      3. Verify ArtifactContract enforcement validates (correct ledger_policy, authority, scope)
      4. Verify settlement trace has correct redacted kinds
    Expected Result: Both enforcement layers pass without conflict
    Evidence: .sisyphus/evidence/final-qa/f3-integration.txt
  ```

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Unaccounted [CLEAN/N files] | VERDICT`

  **QA Scenarios:**
  ```
  Scenario: No scope creep — §18.23 expansions absent
    Tool: Bash (grep)
    Steps:
      1. grep -rn "derive_only\|proposal_write\|authoritative_write\|external_side_effect" src/
      2. grep -rn "read_scope" src/core/tools/
      3. Assert zero matches
    Expected Result: Zero §18.23-expansion patterns found
    Evidence: .sisyphus/evidence/final-qa/f4-no-creep.txt

  Scenario: All changed files accounted for by tasks
    Tool: Bash (git diff)
    Steps:
      1. git diff --name-only HEAD~10
      2. For each changed file, verify it's listed in a task's "Files" section
      3. Flag any unaccounted files
    Expected Result: Zero unaccounted file changes
    Evidence: .sisyphus/evidence/final-qa/f4-accounted.txt
  ```

---

## Commit Strategy

| Wave | Task | Message | Key Files | Pre-commit |
|------|------|---------|-----------|------------|
| 0 | T1 | `feat(tools): wire executionContext in AgentLoop and fix rp_settlement` | agent-loop.ts, tool-access-policy.ts, agent-permissions.ts | `bun test` |
| 0 | T2 | `refactor(models): rename EmbeddingPurpose memory_search to narrative_search` | embedding-provider.ts, task-agent.ts | `bun run build && bun test` |
| 1 | T3 | `feat(memory): enforce WriteTemplate at settlement boundary` | write-template.ts, explicit-settlement-processor.ts, materialization.ts | `bun test` |
| 1 | T4 | `fix(cognition): validate conflict_factor_refs_json at write time` | explicit-settlement-processor.ts | `bun test` |
| 1 | T5 | `feat(memory): add debug logging to navigator supplemental seeds` | navigator.ts | `bun test` |
| 2 | T6 | `feat(tools): enforce ArtifactContract at runtime` | artifact-contract-policy.ts (new), tool-executor.ts, trace-store.ts | `bun test` |
| 2 | T7 | `feat(memory): add PublicationRecoverySweeper` | publication-recovery-sweeper.ts (new), materialization.ts, runtime.ts | `bun test` |
| 3 | T8 | `docs(memory): update architecture and regression docs` | MEMORY_ARCHITECTURE_2026.md, MEMORY_REGRESSION_MATRIX.md | `bun run check:legacy-memory-surface` |

---

## Success Criteria

### Verification Commands
```bash
bun run build                    # Expected: zero errors
bun test                         # Expected: all pass
bun run check:legacy-memory-surface  # Expected: zero legacy matches outside exemptions (existing gate)
```

### Final Checklist
- [ ] WriteTemplate enforcement blocks unauthorized writes with `WRITE_TEMPLATE_DENIED`
- [ ] ArtifactContract consumed at runtime (authority, scope, ledger policy)
- [ ] PublicationRecoverySweeper recovers skipped publications
- [ ] conflict_factor_refs_json validated at write time
- [ ] Navigator catch blocks emit debug logs
- [ ] Zero legacy patterns outside exemptions
- [ ] MEMORY_ARCHITECTURE_2026.md reflects current state
- [ ] `bun run build` passes
- [ ] `bun test` passes
