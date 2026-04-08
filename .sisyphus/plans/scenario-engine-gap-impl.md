# Scenario Engine Gap Analysis Implementation

## TL;DR

> **Quick Summary**: Implement 8 work items (W1-W8) from the Scenario Engine Gap Analysis to upgrade the engine from "memory/cognition integration test platform" to "memory/cognition/reasoning verification platform". A prep task (W0) adds pipeline scaffolding for new assertion types.
>
> **Deliverables**:
> - W0: Pipeline scaffolding (result union types, BeatCallLog threading, validation stubs)
> - W1: ToolCallPattern asserter (existence + cardinality per beat)
> - W2: ReasoningChainProbe verifier (cognitionKey coexistence + optional logic edges)
> - W5: Embedding fixture generator + injection mechanism for RRF hybrid search testing
> - W6: Probe matcher extension for expectedConflictFields
> - W3: ToolCallPattern + ReasoningChainProbe definitions added to all stories
> - W4: L1-L4 failure diagnosis module
> - W7: Conflict verification probes for manor-intrigue and island-suspicion
> - W8: Comparison report enhancement (coverage ratio + assertion alignment)
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: T1 (W0) -> T2 (W1) -> T6 (W3) -> F1-F4 (verification)

---

## Context

### Original Request
Implement the executable work plan from `docs/scenario-engine-gap-analysis.md`, covering Phase 1 (reasoning verification infrastructure) and Phase 2 (story completion + report enhancement).

### Interview Summary
**Key Discussions**:
- The gap analysis document serves as the interview — 10 architecture consensus decisions (C-1~C-10) with detailed rationale
- 4 parallel codebase explorations confirmed insertion points, type compatibility, and data flow
- Metis review identified critical architecture gap: ToolCallPattern and ReasoningChainProbe don't fit existing probe pipeline

**Research Findings**:
- Tool call capture already exists in live path via `createLiveCapturingProvider()` in `scripted-provider.ts:91-161`
- `CognitionHit` ALREADY has `conflictEvidence`, `conflictSummary`, `conflictFactorRefs`, `resolution` — matcher only needs checking logic
- `ProbeResult` is tightly coupled to fragment matching — new probe types need discriminated union or parallel result types
- `probe-matcher.ts` is a pure function (no DB access) — W4 diagnosis MUST be separate module
- Settlement path has ZERO tool calls — ToolCallPattern must be skipped for settlement
- `configureEmbeddingSearch()` still needs live embed function for query-time embedding even with document fixtures

### Metis Review
**Identified Gaps** (addressed):
- **Critical**: ToolCallPattern (per-beat) and ReasoningChainProbe (cross-beat) need separate execution paths from existing probe pipeline → Added W0 prep task
- **Critical**: `BeatCallLog[]` not accessible to assertion layer — `ScenarioRunResult` missing tool call data → W0 threads it through
- **Critical**: Missing validators for new DSL fields → Each task includes validation
- **Important**: W8 implicitly depends on W1/W2 result types → W8 deferred to Wave 3 with explicit dependency
- **Important**: ToolCallPattern meaningless on settlement path → Explicit skip in W1
- **Edge case**: Query-time embedding still needs live API key → Accepted as integration test requirement for W5

---

## Work Objectives

### Core Objective
Upgrade the scenario engine from a memory/cognition integration test platform to a memory/cognition/reasoning verification platform with deterministic tool call pattern and reasoning chain assertions.

### Concrete Deliverables
- New files: `tool-call-asserter.ts`, `reasoning-chain-verifier.ts`, `probe-diagnosis.ts`, `scenario-assertion-types.ts`, embedding fixture script + fixture files
- Modified files: `story-types.ts`, `story-validation.ts`, `probe-types.ts`, `probe-matcher.ts`, `probe-executor.ts`, `orchestrator.ts`, `report-generator.ts`, `write-paths.ts`, `manor-intrigue.ts`, `island-suspicion.ts`, `invisible-man.ts`
- Test files: `tool-call-asserter.test.ts`, `reasoning-chain-verifier.test.ts`, `probe-diagnosis.test.ts`, extended `probe-matcher.test.ts`, extended `story-validation.test.ts`

### Definition of Done
- [ ] `bun test test/scenario-engine/` — ALL tests pass (existing + new)
- [ ] ToolCallPattern assertions pass for live and scripted paths on all stories with expectedToolPattern
- [ ] ReasoningChainProbe verification passes for settlement and live paths on all stories with reasoningChainProbes
- [ ] Embedding fixture injection enables RRF hybrid search (cosine + pg_trgm) in test
- [ ] Conflict field probes pass on manor-intrigue and island-suspicion settlement paths
- [ ] Failure diagnosis auto-reports L1-L4 layer on any probe failure
- [ ] Comparison report shows coverage ratio and per-assertion alignment

### Must Have
- All new assertion types use 100% pass threshold in live path (C-9)
- Existing retrieval probes keep 70% live threshold unchanged
- ToolCallPattern: existence + cardinality only (C-3 levels A+B)
- ReasoningChainProbe: cognitionKey coexistence mandatory, logic edges optional (C-4)
- Failure diagnosis: on-failure-only, 4-layer localization (C-10)

### Must NOT Have (Guardrails)
- NO argument-level tool call assertions (C-3 explicitly excludes level D)
- NO ordered subsequence assertions for tool calls (C-3 excludes level C)
- NO LLM-as-judge reasoning trace evaluation (C-2 excludes this)
- NO partial scoring for reasoning chains — binary pass/fail only (C-9)
- NO modifications to `src/` source files — all changes in `test/scenario-engine/`
- NO Zod or schema validation libraries — handwritten validators only
- NO modifications to existing story beats, assertions, or dialogue
- NO breaking changes to `CachedToolCallLog` format — additive only
- `probe-matcher.ts` MUST remain a pure function — no DB queries added to it
- `ProbeResult` type MUST stay backward-compatible — use discriminated union for new result types

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** - ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (bun test)
- **Automated tests**: YES (tests-after, per work item)
- **Framework**: bun test
- **Pattern**: Follow test factories in existing `probe-matcher.test.ts:8-22` (`hit()`, `probe()` helpers)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Unit tests**: Use Bash (bun test) — run specific test file, assert pass count
- **Integration**: Use Bash (bun test) — run full scenario suite against story files
- **Type checking**: Use Bash (bun run build) — verify zero TypeScript errors
- **Validation**: Use Bash (bun test) — verify story validation passes with new fields

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — must complete first):
└── T1: W0 Pipeline scaffolding (result types + data plumbing + validation stubs) [deep]

Wave 2 (Phase 1 — MAX PARALLEL, all depend on T1):
├── T2: W1 ToolCallPattern asserter [deep]
├── T3: W2 ReasoningChainProbe verifier [deep]
├── T4: W5 Embedding fixture generator + injection [unspecified-high]
└── T5: W6 Probe matcher conflict field extension [unspecified-high]

Wave 3 (Phase 2 — MAX PARALLEL, depends on Wave 2):
├── T6: W3 Add probes to stories (depends: T2, T3) [unspecified-high]
├── T7: W4 Failure diagnosis module (depends: T2) [deep]
├── T8: W7 Manor/Island conflict probes (depends: T5) [unspecified-high]
└── T9: W8 Comparison report enhancement (depends: T1) [unspecified-high]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real manual QA (unspecified-high)
└── F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: T1 → T2 → T6 → F1-F4 → user okay
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 4 (Waves 2 & 3)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| T1 | — | T2, T3, T4, T5, T9 | 1 |
| T2 | T1 | T6, T7 | 2 |
| T3 | T1 | T6 | 2 |
| T4 | T1 | — | 2 |
| T5 | T1 | T8 | 2 |
| T6 | T2, T3 | — | 3 |
| T7 | T2 | — | 3 |
| T8 | T5 | — | 3 |
| T9 | T1 | — | 3 |

### Agent Dispatch Summary

- **Wave 1**: **1 task** — T1 `deep`
- **Wave 2**: **4 tasks** — T2 `deep`, T3 `deep`, T4 `unspecified-high`, T5 `unspecified-high`
- **Wave 3**: **4 tasks** — T6 `unspecified-high`, T7 `deep`, T8 `unspecified-high`, T9 `unspecified-high`
- **FINAL**: **4 tasks** — F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high`, F4 `deep`

---

## TODOs

- [x] 1. W0 Pipeline Scaffolding: Result Union Types + BeatCallLog Threading + Validation Stubs

  **What to do**:
  - Create `test/scenario-engine/probes/scenario-assertion-types.ts` defining the discriminated union result type:
    ```typescript
    type ToolCallAssertionResult = {
      kind: "tool_call_pattern";
      beatId: string;
      passed: boolean;
      violations: { rule: string; detail: string }[];
    };
    type ReasoningChainResult = {
      kind: "reasoning_chain";
      probeId: string;
      passed: boolean;
      cognitionResults: { cognitionKey: string; found: boolean; stanceMatch: boolean; actualStance?: string }[];
      edgeResults?: { fromRef: string; toRef: string; found: boolean }[];
    };
    // NOTE: ConflictFieldResult is NOT a top-level union member.
    // Conflict field checking is an extension of ProbeResult within probe-matcher.ts (per C-6).
    // See T5 (W6) for the ProbeResult extension approach.
    type ScenarioAssertionResult = ProbeResult | ToolCallAssertionResult | ReasoningChainResult;
    ```
  - Extend `StoryBeat` in `story-types.ts` with optional `expectedToolPattern?: ToolCallPattern` field (after line 55 `publicationDeclarations?`)
  - Add `ToolCallPattern` type to `story-types.ts`: `{ mustContain?: string[]; mustNotContain?: string[]; minCalls?: number; maxCalls?: number }`
  - Add `ReasoningChainProbe` type to `story-types.ts`: `{ id: string; description: string; expectedCognitions: { cognitionKey: string; expectedStance: AssertionStance }[]; expectEdges?: boolean; expectedEdges?: { fromEpisodeLocalRef: string; toEpisodeLocalRef: string; edgeType: LogicEdgeType }[] }`
  - Extend `Story` type with optional `reasoningChainProbes?: ReasoningChainProbe[]`
  - Extend `StoryProbe` type with optional `expectedConflictFields?: { hasConflictSummary?: boolean; expectedFactorRefs?: string[]; hasResolution?: boolean }`
  - Thread `BeatCallLog[]` through the runner: extend `WritePathResult` in `write-paths.ts` to include `capturedToolCallLog?: CachedToolCallLog` (already exists on live path, make it available on all results), and ensure `ScenarioHandleExtended` or `ScenarioRunResult` in `orchestrator.ts` exposes it
  - Add stub validation functions in `story-validation.ts`:
    - `validateToolCallPatterns(story: Story): ValidationError[]` — validates mustContain/mustNotContain are strings, minCalls <= maxCalls
    - `validateReasoningChainProbes(story: Story): ValidationError[]` — validates cognitionKey references exist in story assertions, episodeLocalRef references exist in story episodes
    - `validateConflictFields(story: Story): ValidationError[]` — validates expectedFactorRefs are valid pointer_key strings
  - Wire new validators into `validateStory()` orchestrator
  - Run `bun run build` to verify zero TypeScript errors

  **Must NOT do**:
  - Implement assertion/verification logic (that's T2, T3, T5)
  - Add any `src/` file changes
  - Break existing types — all additions are optional fields

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Type scaffolding across multiple files requiring careful cross-reference consistency. Must understand existing type relationships to extend without breaking backward compatibility.
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - None relevant — this is pure TypeScript type work

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1 (solo)
  - **Blocks**: T2, T3, T4, T5, T9
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `test/scenario-engine/dsl/story-types.ts:46-58` — StoryBeat type definition. Add `expectedToolPattern?` after `publicationDeclarations?` (line 57). Follow optional field pattern.
  - `test/scenario-engine/dsl/story-types.ts:141-150` — StoryProbe type definition. Add `expectedConflictFields?` after `topK` field. Follow same optional pattern.
  - `test/scenario-engine/dsl/story-types.ts:159-171` — Story root type. Add `reasoningChainProbes?: ReasoningChainProbe[]` after `probes` field.
  - `test/scenario-engine/dsl/story-validation.ts:16-34` — `validateStory()` orchestrator. Follow pattern: each validator returns `ValidationError[]`, orchestrator spreads all into `errors`.
  - `test/scenario-engine/dsl/story-validation.ts:279-293` — `validateProbes()` pattern for validating cross-references (viewerPerspective → character.id).

  **API/Type References**:
  - `test/scenario-engine/probes/probe-types.ts:12-20` — Existing `ProbeResult` type. The new discriminated union wraps this with `kind: "retrieval_probe"` or keeps it as-is alongside new result types.
  - `test/scenario-engine/generators/scripted-provider.ts:8-27` — `BeatCallLog`, `FlushCallEntry`, `CachedToolCallLog` types. These are the tool call data structures to thread through.
  - `test/scenario-engine/runner/write-paths.ts:104-109` — `WritePathResult` type. `capturedToolCallLog` already exists here for live path. Make it accessible in `ScenarioRunResult`.
  - `test/scenario-engine/runner/orchestrator.ts:96-109` — `ScenarioHandleExtended` construction. Thread tool call data here.
  - `src/runtime/rp-turn-contract.ts:26-33` — `AssertionStance` union type (imported by story-types.ts). Used in `ReasoningChainProbe.expectedCognitions[].expectedStance`.
  - `src/memory/types.ts:23-24` — `LogicEdgeType` (imported by story-types.ts). Used in `ReasoningChainProbe.expectedEdges[].edgeType`.

  **Test References**:
  - `test/scenario-engine/dsl/story-validation.test.ts` — Existing validation tests. Add test cases for new validators following same pattern.

  **External References**:
  - None — pure internal type work

  **WHY Each Reference Matters**:
  - `story-types.ts` line ranges: Exact insertion points for new fields — executor must not add fields in wrong position or break existing type
  - `story-validation.ts` orchestrator: Must wire new validators into same pattern — spread ValidationError[] into errors array
  - `scripted-provider.ts` types: These are the EXACT types that will flow through the pipeline — must reference them, not reinvent
  - `orchestrator.ts` construction: Where BeatCallLog threading lands — must understand what data is already available

  **Acceptance Criteria**:

  - [ ] `bun run build` passes with zero errors (TypeScript compiles cleanly)
  - [ ] `bun test test/scenario-engine/dsl/story-validation.test.ts` passes (existing + new validation tests)
  - [ ] New types exported from `test/scenario-engine/probes/scenario-assertion-types.ts`
  - [ ] `StoryBeat.expectedToolPattern` is optional and typed as `ToolCallPattern`
  - [ ] `Story.reasoningChainProbes` is optional and typed as `ReasoningChainProbe[]`
  - [ ] `StoryProbe.expectedConflictFields` is optional and typed correctly
  - [ ] All existing tests pass unchanged: `bun test test/scenario-engine/`

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: TypeScript compilation with new types
    Tool: Bash (bun run build)
    Preconditions: All new type files created, all existing files updated
    Steps:
      1. Run `bun run build` in project root
      2. Check exit code
    Expected Result: Exit code 0, no TypeScript errors related to scenario-engine files
    Failure Indicators: Any error mentioning story-types.ts, scenario-assertion-types.ts, or write-paths.ts
    Evidence: .sisyphus/evidence/task-1-tsc-build.txt

  Scenario: Validation rejects invalid ToolCallPattern
    Tool: Bash (bun test)
    Preconditions: story-validation.test.ts updated with new test cases
    Steps:
      1. Run `bun test test/scenario-engine/dsl/story-validation.test.ts`
      2. Verify test cases cover: minCalls > maxCalls (rejected), empty pattern (accepted), valid pattern (accepted)
    Expected Result: All validation tests pass
    Failure Indicators: Test failure on validateToolCallPatterns or validateReasoningChainProbes
    Evidence: .sisyphus/evidence/task-1-validation-tests.txt

  Scenario: Existing tests unbroken
    Tool: Bash (bun test)
    Preconditions: All type changes made with optional fields only
    Steps:
      1. Run `bun test test/scenario-engine/`
      2. Compare pass count with baseline
    Expected Result: Same number of passing tests as before changes (no regressions)
    Failure Indicators: Any previously-passing test now fails
    Evidence: .sisyphus/evidence/task-1-regression.txt
  ```

  **Commit**: YES
  - Message: `feat(scenario-engine): add assertion pipeline scaffolding with result union types and BeatCallLog threading`
  - Files: `test/scenario-engine/probes/scenario-assertion-types.ts`, `test/scenario-engine/dsl/story-types.ts`, `test/scenario-engine/dsl/story-validation.ts`, `test/scenario-engine/runner/write-paths.ts`, `test/scenario-engine/runner/orchestrator.ts`
  - Pre-commit: `bun run build && bun test test/scenario-engine/dsl/`

- [x] 2. W1 ToolCallPattern Asserter

  **What to do**:
  - Create `test/scenario-engine/probes/tool-call-asserter.ts` with main function:
    ```typescript
    export function assertToolCallPatterns(
      beats: StoryBeat[],
      beatCallLogs: BeatCallLog[],
    ): ToolCallAssertionResult[]
    ```
  - For each beat with `expectedToolPattern`:
    - Find matching `BeatCallLog` by `beatId`
    - Flatten all `flushCalls[].toolCalls[]` to get tool name list
    - Check `mustContain`: every listed tool name appears at least once in tool calls → violation if missing
    - Check `mustNotContain`: no listed tool name appears in tool calls → violation if present
    - Check `minCalls`: total tool call count >= minCalls → violation if under
    - Check `maxCalls`: total tool call count <= maxCalls → violation if over
    - `passed = violations.length === 0`
  - Handle settlement path: if no `BeatCallLog` exists for a beat, skip that beat (settlement has no tool calls). Do NOT fail — silently skip with a note in result.
  - Handle scripted path: BeatCallLog comes from cache replay, validate as normal.
  - Create `test/scenario-engine/probes/tool-call-asserter.test.ts` with >= 7 test cases:
    1. Full match (all mustContain present, no mustNotContain present) → passed
    2. Missing required tool (mustContain has "create_entity" but tool calls don't include it) → violation
    3. Forbidden tool present (mustNotContain has "create_alias" but it appears) → violation
    4. minCalls violation (minCalls: 3 but only 2 calls) → violation
    5. maxCalls violation (maxCalls: 5 but 7 calls) → violation
    6. Empty pattern (no mustContain, no mustNotContain, no min/max) → vacuous pass
    7. No BeatCallLog for beat (settlement path) → skip, no assertion result
    8. Multiple beats with patterns → multiple results
  - Wire `assertToolCallPatterns` into `orchestrator.ts` execution flow: call after write path completes, before probe execution. Results stored alongside `ProbeResult[]`.
  - Add ToolCallPattern results section to `report-generator.ts`:
    ```
    ## Tool Call Pattern Assertions
    | Beat | Passed | Violations |
    |------|--------|------------|
    ```

  **Must NOT do**:
  - Assert argument values of tool calls (C-3 level D excluded)
  - Assert ordered sequence of tool calls (C-3 level C excluded)
  - Fail when no BeatCallLog exists (settlement path is valid)
  - Modify `probe-matcher.ts` — this is a separate assertion path

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Core reasoning verification logic with multiple assertion rules, edge cases, and report integration. Needs careful boundary handling for settlement/scripted/live paths.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T3, T4, T5)
  - **Blocks**: T6 (story probe additions), T7 (failure diagnosis)
  - **Blocked By**: T1

  **References**:

  **Pattern References**:
  - `test/scenario-engine/probes/probe-matcher.ts:10-67` — `matchProbeResults()` pattern for pure assertion function taking data in, returning structured result. Follow same pure-function, no-side-effect pattern.
  - `test/scenario-engine/probes/probe-assertions.ts:1-25` — `assertAllProbesPass()` pattern for throwing on failure with formatted message. Create analogous `assertAllToolCallPatternsPass()`.
  - `test/scenario-engine/probes/probe-matcher.test.ts:8-22` — Test factory helpers (`hit()`, `probe()`). Create analogous `beatLog()`, `pattern()` factories.

  **API/Type References**:
  - `test/scenario-engine/probes/scenario-assertion-types.ts` — `ToolCallAssertionResult` type (from T1)
  - `test/scenario-engine/dsl/story-types.ts` — `ToolCallPattern` type and `StoryBeat.expectedToolPattern` (from T1)
  - `test/scenario-engine/generators/scripted-provider.ts:15-28` — `BeatCallLog` type: `{ beatId: string; flushCalls: FlushCallEntry[] }` where `FlushCallEntry = { callPhase: "call_one" | "call_two"; toolCalls: ToolCallResult[] }`
  - `test/scenario-engine/generators/scripted-provider.ts:91-161` — `createLiveCapturingProvider()` captures tool calls — understand what `ToolCallResult` contains (tool name, arguments, result)
  - `test/scenario-engine/runner/orchestrator.ts:96-109` — Where to wire assertToolCallPatterns into the execution flow (after write path, before probes)

  **Test References**:
  - `test/scenario-engine/probes/probe-matcher.test.ts` — Test structure, factory helpers, assertion patterns

  **External References**:
  - `docs/scenario-engine-gap-analysis.md:62-80` — C-3 consensus: existence + cardinality (A+B), explicitly excludes ordered subsequence (C) and argument-level (D)

  **WHY Each Reference Matters**:
  - `probe-matcher.ts`: Shows the PATTERN for pure assertion functions — input data, return structured results, no side effects
  - `scripted-provider.ts`: Contains the EXACT `BeatCallLog` type that this asserter consumes — must understand `FlushCallEntry.toolCalls` structure
  - `orchestrator.ts`: Integration point — where assertion results join the reporting pipeline

  **Acceptance Criteria**:

  - [ ] `bun test test/scenario-engine/probes/tool-call-asserter.test.ts` — >= 7 test cases, ALL pass
  - [ ] `bun run build` — zero TypeScript errors
  - [ ] Asserter correctly matches tool names from `ToolCallResult` objects
  - [ ] Settlement path beats silently skipped (no false failures)
  - [ ] Report generator includes ToolCallPattern section

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: ToolCallPattern happy path — all patterns satisfied
    Tool: Bash (bun test)
    Preconditions: tool-call-asserter.test.ts has test case with beat having mustContain: ["create_entity", "upsert_assertion"] and BeatCallLog containing those tool calls
    Steps:
      1. Run `bun test test/scenario-engine/probes/tool-call-asserter.test.ts --filter "full match"`
      2. Assert test passes
    Expected Result: `passed: true`, zero violations
    Failure Indicators: Any violation in result
    Evidence: .sisyphus/evidence/task-2-happy-path.txt

  Scenario: ToolCallPattern violation — mustNotContain tool present
    Tool: Bash (bun test)
    Preconditions: test case with mustNotContain: ["create_alias"] and BeatCallLog containing create_alias call
    Steps:
      1. Run `bun test test/scenario-engine/probes/tool-call-asserter.test.ts --filter "forbidden"`
      2. Assert violation includes "create_alias"
    Expected Result: `passed: false`, violation mentioning "mustNotContain: create_alias"
    Failure Indicators: Test passes when it should fail, or violation detail missing
    Evidence: .sisyphus/evidence/task-2-violation.txt

  Scenario: Settlement path — graceful skip when no BeatCallLog
    Tool: Bash (bun test)
    Preconditions: test case with beat having expectedToolPattern but empty BeatCallLog array
    Steps:
      1. Run `bun test test/scenario-engine/probes/tool-call-asserter.test.ts --filter "settlement"`
      2. Assert result is empty or marked as skipped
    Expected Result: No assertion failure, no result entry for that beat
    Failure Indicators: Assertion throws or produces false violation
    Evidence: .sisyphus/evidence/task-2-settlement-skip.txt
  ```

  **Commit**: YES
  - Message: `feat(scenario-engine): implement ToolCallPattern asserter with existence and cardinality checks`
  - Files: `test/scenario-engine/probes/tool-call-asserter.ts`, `test/scenario-engine/probes/tool-call-asserter.test.ts`, `test/scenario-engine/runner/orchestrator.ts`, `test/scenario-engine/probes/report-generator.ts`
  - Pre-commit: `bun test test/scenario-engine/probes/tool-call-asserter.test.ts`

- [x] 3. W2 ReasoningChainProbe Verifier

  **What to do**:
  - Create `test/scenario-engine/probes/reasoning-chain-verifier.ts` with main function:
    ```typescript
    export async function verifyReasoningChains(
      probes: ReasoningChainProbe[],
      infra: ScenarioInfra,
    ): Promise<ReasoningChainResult[]>
    ```
  - **CognitionKey coexistence verification** (mandatory per probe):
    - For each `expectedCognitions[]` entry, query `private_cognition_current` table via `infra.repos` (direct DB query, NOT through search services)
    - Check: cognitionKey exists AND stance matches `expectedStance`
    - Record `{ cognitionKey, found: boolean, stanceMatch: boolean, actualStance }`
    - Probe passes coexistence check if ALL expectedCognitions are found with matching stances
  - **Logic edge verification** (optional, only when `expectEdges: true` AND `expectedEdges` provided):
    - For each `expectedEdges[]` entry, resolve `fromEpisodeLocalRef` and `toEpisodeLocalRef` to actual episode IDs in DB
    - Query logic_edges table for matching edge (from → to, edgeType)
    - Record `{ fromRef, toRef, found: boolean }`
    - Edge check is a bonus — probe passes even if edges not found (C-4: optional layer)
  - Create `test/scenario-engine/probes/reasoning-chain-verifier.test.ts` with >= 6 test cases:
    1. All cognitionKeys present with correct stances → passed
    2. Missing cognitionKey → failed (found: false)
    3. CognitionKey exists but wrong stance → failed (stanceMatch: false)
    4. Edges present when expectEdges: true → edgeResults populated, bonus pass
    5. Edges missing when expectEdges: true → still passes (edges optional per C-4)
    6. expectEdges: false → edgeResults not populated
  - Use mock/stub infra for unit tests — do NOT require real DB in unit test
  - Wire into `orchestrator.ts`: call after write path and after probes, using `handle.infra`
  - Add ReasoningChain results section to `report-generator.ts`:
    ```
    ## Reasoning Chain Verification
    | Probe | Passed | Cognitions | Edges |
    |-------|--------|------------|-------|
    ```
  - Threshold: 100% pass required for both settlement and live paths (C-9)

  **Must NOT do**:
  - Add weighted/partial scoring — binary pass/fail only (C-9)
  - Use search services (cognitionSearch/narrativeSearch) — use direct DB queries for deterministic verification
  - Add LLM-as-judge evaluation (C-2 explicitly excludes)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Cross-beat verification with DB queries, episode ID resolution, and multiple assertion layers. Requires understanding of cognition storage schema and logic edge table structure.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T2, T4, T5)
  - **Blocks**: T6 (story probe additions)
  - **Blocked By**: T1

  **References**:

  **Pattern References**:
  - `test/scenario-engine/probes/probe-executor.ts:51-68` — `executeCognitionSearch()` shows how CognitionHit results are extracted from DB. ReasoningChainProbe uses similar data but with direct queries, not search.
  - `test/scenario-engine/probes/probe-matcher.ts:10-67` — Pure function pattern. Follow similar structure but with async DB access.
  - `test/scenario-engine/runner/write-paths.ts:139-323` — Settlement path's `commitSettlement()` flow shows how assertions reach `private_cognition_current`.

  **API/Type References**:
  - `test/scenario-engine/probes/scenario-assertion-types.ts` — `ReasoningChainResult` type (from T1)
  - `test/scenario-engine/dsl/story-types.ts` — `ReasoningChainProbe` type (from T1), `LogicEdgeSpec` type (lines 112-117)
  - `src/memory/cognition/cognition-search.ts:47-59` — `CognitionHit` type with `cognitionKey`, `stance`, `kind` fields. Shows what's queryable in DB.
  - `src/memory/types.ts:23-24` — `LogicEdgeType` union. Used for edge type matching.
  - `src/memory/task-agent.ts:241-253` — `create_logic_edge` tool definition. Shows `source_event_id`, `target_event_id`, `relation_type` schema.

  **Test References**:
  - `test/scenario-engine/probes/probe-matcher.test.ts` — Factory helper pattern for unit tests

  **External References**:
  - `docs/scenario-engine-gap-analysis.md:86-123` — C-4 consensus: CognitionKey coexistence (mandatory) + Logic Edges (optional, controlled by expectEdges)

  **WHY Each Reference Matters**:
  - `probe-executor.ts:51-68`: Shows HOW cognition data flows from DB → CognitionHit → ProbeResult. ReasoningChainProbe skips the search step but needs to understand what data is available.
  - `cognition-search.ts:47-59`: The CognitionHit type tells us EXACTLY what fields we can query — cognitionKey + stance are both available
  - `task-agent.ts:241-253`: Proves create_logic_edge IS a real tool agents can call — validates that expectedEdges has real data to verify against

  **Acceptance Criteria**:

  - [ ] `bun test test/scenario-engine/probes/reasoning-chain-verifier.test.ts` — >= 6 test cases, ALL pass
  - [ ] `bun run build` — zero TypeScript errors
  - [ ] CognitionKey lookup uses direct DB query, NOT cognitionSearch service
  - [ ] Missing cognitionKey → probe fails (passed: false)
  - [ ] Missing edges with `expectEdges: true` → probe still passes (optional layer)
  - [ ] Report generator includes ReasoningChain section

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: All cognitionKeys present with matching stances
    Tool: Bash (bun test)
    Preconditions: Mock infra with private_cognition_current containing cognitionKeys "oswin_alibi" (stance: "contested") and "key_custody" (stance: "accepted")
    Steps:
      1. Run verifyReasoningChains with probe expecting both keys
      2. Assert passed: true, all cognitionResults have found: true and stanceMatch: true
    Expected Result: ReasoningChainResult with passed: true
    Failure Indicators: passed: false or any cognitionResult with found: false
    Evidence: .sisyphus/evidence/task-3-happy-path.txt

  Scenario: CognitionKey exists but stance mismatch
    Tool: Bash (bun test)
    Preconditions: Mock infra with cognitionKey "oswin_alibi" having stance "accepted" but probe expects "contested"
    Steps:
      1. Run verifyReasoningChains
      2. Assert passed: false with stanceMatch: false and actualStance: "accepted"
    Expected Result: passed: false, cognitionResults[0].stanceMatch === false
    Failure Indicators: probe passes when stance doesn't match
    Evidence: .sisyphus/evidence/task-3-stance-mismatch.txt

  Scenario: Optional edges missing — probe still passes
    Tool: Bash (bun test)
    Preconditions: Mock infra with cognitionKeys present but NO logic edges in DB. Probe has expectEdges: true with expectedEdges defined.
    Steps:
      1. Run verifyReasoningChains
      2. Assert passed: true (cognitions all match), edgeResults show found: false
    Expected Result: passed: true because edges are optional bonus layer (C-4)
    Failure Indicators: probe fails due to missing edges
    Evidence: .sisyphus/evidence/task-3-optional-edges.txt
  ```

  **Commit**: YES
  - Message: `feat(scenario-engine): implement ReasoningChainProbe verifier with cognitionKey coexistence and optional edge checks`
  - Files: `test/scenario-engine/probes/reasoning-chain-verifier.ts`, `test/scenario-engine/probes/reasoning-chain-verifier.test.ts`, `test/scenario-engine/runner/orchestrator.ts`, `test/scenario-engine/probes/report-generator.ts`
  - Pre-commit: `bun test test/scenario-engine/probes/reasoning-chain-verifier.test.ts`

- [x] 4. W5 Embedding Fixture Generator + Injection

  **What to do**:
  - Create `test/scenario-engine/scripts/generate-embedding-fixtures.ts`:
    - Takes a story ID (default: mini-sample) as argument
    - Runs settlement path to populate DB with entities/episodes/cognitions
    - Calls `collectNodes()` (from embedding-step.ts) to get all node refs
    - Uses real API key + current embedding model to generate vectors for each node
    - Serializes to JSON fixture file: `test/scenario-engine/fixtures/{storyId}-embeddings.json`
    - Format: `{ storyId, model, dimension, generatedAt, vectors: { nodeRef: string, kind: string, vector: number[] }[] }`
  - Create `test/scenario-engine/runner/embedding-fixtures.ts`:
    - `loadEmbeddingFixtures(storyId: string): EmbeddingFixture[]` — reads fixture JSON
    - `injectEmbeddingFixtures(infra: ScenarioInfra, fixtures: EmbeddingFixture[]): Promise<number>` — writes vectors to `PgEmbeddingRepo.upsert()` for each fixture entry
    - Called AFTER `runScenario()` but BEFORE `configureEmbeddingSearch()` in test files
  - Update test pipeline: in tests that use embedding path, add injection step:
    ```typescript
    const handle = await runScenario(story, { writePath: "settlement" });
    const fixtures = loadEmbeddingFixtures(story.id);
    const injected = await injectEmbeddingFixtures(handle.infra, fixtures);
    configureEmbeddingSearch(handle.infra); // enables RRF hybrid search
    const probeResults = await executeProbes(story, handle);
    ```
  - **Query-time embedding limitation**: `configureEmbeddingSearch()` needs a working `embed()` function for query vectors at search time. Pre-computed fixtures only cover **document** vectors. This means:
    - Tests using embedding fixtures STILL require a live API key (same as current integration tests that need DB)
    - Without API key, tests must skip the RRF hybrid path and fall back to pg_trgm only
    - Pure offline RRF verification (pre-computing query vectors too) is a Phase 3 long-term item
  - Generate fixture file for mini-sample story (smallest story, fastest iteration)

  **Must NOT do**:
  - Test embedding quality or cosine similarity thresholds (C-5: verify RRF pipeline, not embedding quality)
  - Build a full embedding test framework — single script + single injection mechanism
  - Mock the embedding model — use real API for fixture generation (one-time cost)
  - Claim offline RRF verification is achieved — current implementation requires live API key for query-time embedding

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Integration work bridging runner infrastructure with embedding system. Requires understanding DB schema and embedding injection.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T2, T3, T5)
  - **Blocks**: None
  - **Blocked By**: T1

  **References**:

  **Pattern References**:
  - `test/scenario-engine/runner/embedding-step.ts:43-71` — `collectNodes()` function: queries entity_nodes, private_episode_events, private_cognition_current. Shows exactly which nodes need embedding vectors.
  - `test/scenario-engine/runner/embedding-step.ts:73-119` — `generateEmbeddings()` function: resolves model IDs, batches embed calls, writes to `PgEmbeddingRepo.upsert()`. Fixture injection follows same `upsert()` pattern.

  **API/Type References**:
  - `test/scenario-engine/runner/infra.ts:380-411` — `configureEmbeddingSearch()` function: sets embedding fallback on NarrativeSearchService and CognitionSearchService. Requires working embed function for query vectors.
  - `test/scenario-engine/stories/mini-sample.ts` — Smallest story (6 probes, 12 beats). Use this for fixture generation.

  **External References**:
  - `docs/scenario-engine-gap-analysis.md:129-141` — C-5 consensus: pre-computed fixtures, verify RRF logic correctness, not embedding quality

  **WHY Each Reference Matters**:
  - `embedding-step.ts:43-71`: Shows exactly which node types need vectors — must generate fixtures for same set
  - `infra.ts:380-411`: The CONSUMER of fixtures — must understand what configureEmbeddingSearch expects to work correctly

  **Acceptance Criteria**:

  - [ ] Fixture generation script runs: `bun run test/scenario-engine/scripts/generate-embedding-fixtures.ts`
  - [ ] Fixture file created: `test/scenario-engine/fixtures/mini-sample-embeddings.json`
  - [ ] `loadEmbeddingFixtures("mini-sample")` returns parsed fixture array
  - [ ] `injectEmbeddingFixtures(infra, fixtures)` writes vectors to DB without error
  - [ ] After injection + `configureEmbeddingSearch()`, probes using narrative_search/cognition_search trigger RRF hybrid path (cosine + pg_trgm) — requires live API key for query embedding
  - [ ] `bun run build` — zero TypeScript errors
  - [ ] Acceptance criteria note: pure offline RRF verification is Phase 3 long-term; current implementation tests RRF pipeline correctness using live API key for query-time embedding

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Fixture injection enables RRF hybrid search
    Tool: Bash (bun test)
    Preconditions: mini-sample settlement path completed, fixture file exists
    Steps:
      1. Load fixtures via loadEmbeddingFixtures("mini-sample")
      2. Inject via injectEmbeddingFixtures(infra, fixtures)
      3. Call configureEmbeddingSearch(infra)
      4. Run executeProbes(miniSample, handle) — narrative_search probes
      5. Check that search results include both pg_trgm AND cosine similarity contributions
    Expected Result: Probes return results; RRF path exercised (vectors exist in DB)
    Failure Indicators: Probes fail or vectors not found in embedding table
    Evidence: .sisyphus/evidence/task-4-rrf-hybrid.txt

  Scenario: Fixture file format is valid and complete
    Tool: Bash (bun test)
    Preconditions: generate-embedding-fixtures.ts has been run
    Steps:
      1. Read test/scenario-engine/fixtures/mini-sample-embeddings.json
      2. Parse JSON, verify storyId, model, dimension fields
      3. Verify vectors array has entries with nodeRef, kind, vector (correct dimension)
    Expected Result: Valid JSON with correct structure and non-empty vectors
    Failure Indicators: Missing fields, wrong dimension, empty vectors array
    Evidence: .sisyphus/evidence/task-4-fixture-format.txt
  ```

  **Commit**: YES
  - Message: `feat(scenario-engine): add embedding fixture generation and injection for RRF hybrid search testing`
  - Files: `test/scenario-engine/scripts/generate-embedding-fixtures.ts`, `test/scenario-engine/runner/embedding-fixtures.ts`, `test/scenario-engine/fixtures/mini-sample-embeddings.json`
  - Pre-commit: `bun run build`

- [x] 5. W6 Probe Matcher Conflict Field Extension

  **What to do**:
  - Extend `StoryProbe` type with optional `expectedConflictFields` (already added in T1 scaffolding). Now implement the matching logic.
  - In `probe-matcher.ts`, add a new phase AFTER the existing fragment matching loop but BEFORE pass/fail determination:
    - If `probe.expectedConflictFields` is defined AND `probe.retrievalMethod === "cognition_search"`:
      - For each hit in topK, check conflict fields from the raw `CognitionHit` data
      - `hasConflictSummary: true` → verify `hit.conflictSummary !== null && hit.conflictSummary !== ""`
      - `expectedFactorRefs: ["ref1", "ref2"]` → verify ALL listed refs appear in `hit.conflictFactorRefs[]` (subset match)
      - `hasResolution: true` → verify `hit.resolution !== null`
    - Record results as optional fields on `ProbeResult` itself (NOT as a separate ConflictFieldResult union member — per C-6, this is a matcher extension, not a new pipeline):
      ```typescript
      type ProbeResult = {
        // ... existing fields unchanged ...
        conflictFieldResults?: { field: string; expected: boolean; actual: boolean }[];
      };
      ```
    - Conflict field failures are SEPARATE from fragment matching — they don't affect the existing `score` calculation
    - But they DO affect `passed`: if conflict field checks fail, `passed = false` regardless of fragment score
  - **Critical design decision**: `probe-matcher.ts` currently receives `RetrievalHit[]` which LACKS conflict fields. The `executeCognitionSearch()` in `probe-executor.ts` maps `CognitionHit` → `RetrievalHit` and drops conflict info. Fix: extend `RetrievalHit` with optional conflict fields, OR pass raw `CognitionHit[]` alongside `RetrievalHit[]`.
    - Recommended: Extend `RetrievalHit` in `probe-types.ts` with optional `conflictSummary?`, `conflictFactorRefs?`, `resolution?` fields. Update `executeCognitionSearch()` in `probe-executor.ts` to populate these from `CognitionHit`.
  - Extend `probe-matcher.test.ts` with >= 4 new test cases:
    1. hasConflictSummary: true + hit HAS summary → passes
    2. hasConflictSummary: true + hit has empty summary → fails
    3. expectedFactorRefs match → passes
    4. expectedFactorRefs partial mismatch → fails
  - `probe-matcher.ts` MUST remain a pure function — conflict field checking uses only the data passed in, no DB queries

  **Must NOT do**:
  - Modify `CognitionHit` type in `src/memory/cognition/cognition-search.ts` — only modify test files
  - Add DB queries to `probe-matcher.ts` — remains pure
  - Change existing score calculation — conflict fields are a separate pass/fail dimension

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Focused extension of existing matcher with clear insertion point. Requires understanding CognitionHit → RetrievalHit mapping.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T2, T3, T4)
  - **Blocks**: T8 (conflict probes in stories)
  - **Blocked By**: T1

  **References**:

  **Pattern References**:
  - `test/scenario-engine/probes/probe-matcher.ts:10-67` — Current `matchProbeResults()` function. Conflict field checking goes AFTER fragment matching (line 43) and BEFORE pass/fail (line 56). Follow pure function pattern.
  - `test/scenario-engine/probes/probe-matcher.test.ts:8-22` — Factory helpers `hit()` and `probe()`. Extend `hit()` to accept optional conflict fields.
  - `test/scenario-engine/probes/probe-executor.ts:51-68` — `executeCognitionSearch()` maps CognitionHit to RetrievalHit. This is where conflict fields currently get DROPPED. Must extend to carry them through.

  **API/Type References**:
  - `test/scenario-engine/probes/probe-types.ts:3-8` — `RetrievalHit` type. Extend with optional `conflictSummary?`, `conflictFactorRefs?`, `resolution?`.
  - `src/memory/cognition/cognition-search.ts:47-59` — `CognitionHit` type. Has `conflictEvidence?: ConflictEvidenceItem[]`, `conflictSummary?: string | null`, `conflictFactorRefs?: NodeRef[]`, `resolution?`. These fields ALREADY EXIST — just need to be threaded through to matcher.
  - `src/memory/cognition/cognition-search.ts:25-30` — `ConflictEvidenceItem` type: `{ targetRef, strength, sourceKind, sourceRef }`.

  **External References**:
  - `docs/scenario-engine-gap-analysis.md:146-169` — C-6 consensus: extend probe matcher, add to existing stories, no new story

  **WHY Each Reference Matters**:
  - `probe-matcher.ts:10-67`: Exact function to modify — insertion point after line 43 for conflict checking
  - `probe-executor.ts:51-68`: The BRIDGE between CognitionHit (has conflict data) and RetrievalHit (currently LACKS it) — must fix this data loss
  - `cognition-search.ts:47-59`: Proves conflict fields already exist in DB layer — no schema changes needed

  **Acceptance Criteria**:

  - [ ] `bun test test/scenario-engine/probes/probe-matcher.test.ts` — all existing + 4 new conflict field tests pass
  - [ ] `bun run build` — zero TypeScript errors
  - [ ] `RetrievalHit` extended with optional conflict fields
  - [ ] `executeCognitionSearch()` threads conflict data from CognitionHit → RetrievalHit
  - [ ] Conflict field failures set `passed: false` but don't change `score`
  - [ ] `probe-matcher.ts` remains a pure function (no DB, no side effects)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Conflict summary present when expected
    Tool: Bash (bun test)
    Preconditions: probe-matcher.test.ts has test with probe.expectedConflictFields = { hasConflictSummary: true } and hit has conflictSummary: "contested (3 factors)"
    Steps:
      1. Run `bun test test/scenario-engine/probes/probe-matcher.test.ts --filter "conflict summary"`
      2. Assert result.passed === true
    Expected Result: Conflict field check passes
    Failure Indicators: passed: false when summary is present
    Evidence: .sisyphus/evidence/task-5-conflict-summary.txt

  Scenario: Factor refs mismatch — probe fails
    Tool: Bash (bun test)
    Preconditions: probe expects expectedFactorRefs: ["ref_a", "ref_b"] but hit only has conflictFactorRefs: ["ref_a"]
    Steps:
      1. Run matcher with mismatched refs
      2. Assert passed: false
    Expected Result: Conflict field check fails due to missing "ref_b"
    Failure Indicators: passed: true despite missing ref
    Evidence: .sisyphus/evidence/task-5-factor-mismatch.txt

  Scenario: Non-cognition probe ignores conflict fields
    Tool: Bash (bun test)
    Preconditions: probe with retrievalMethod: "narrative_search" has expectedConflictFields defined
    Steps:
      1. Run matcher — conflict fields should be ignored for non-cognition probes
    Expected Result: Conflict fields silently skipped, normal fragment matching applies
    Failure Indicators: Error thrown or unexpected behavior
    Evidence: .sisyphus/evidence/task-5-non-cognition-skip.txt
  ```

  **Commit**: YES
  - Message: `feat(scenario-engine): extend probe-matcher with expectedConflictFields checking`
  - Files: `test/scenario-engine/probes/probe-matcher.ts`, `test/scenario-engine/probes/probe-matcher.test.ts`, `test/scenario-engine/probes/probe-types.ts`, `test/scenario-engine/probes/probe-executor.ts`
  - Pre-commit: `bun test test/scenario-engine/probes/probe-matcher.test.ts`

- [x] 6. W3 Add ToolCallPattern + ReasoningChainProbe to Stories

  **What to do**:
  - Add `expectedToolPattern` to specific beats in each story where tool call patterns are meaningful:
    - **manor-intrigue**: Beats with logicEdges (a5, b5, c2, c5, d2, d5, e1) — add `expectedToolPattern: { mustContain: ["create_logic_edge"] }` for beats with causal chains. Add `mustContain: ["upsert_assertion"]` for beats with assertion stance changes (b4, d4).
    - **island-suspicion**: Beats with dense memory operations (d1, d4, e3, f2, g1) — add appropriate mustContain for create_episode_event, upsert_assertion, create_logic_edge based on each beat's memoryEffects.
    - **invisible-man**: Beats with cognitive complexity (c1b, d2, e2, e2b) — add mustContain matching expected tool use.
  - Add `reasoningChainProbes` to each story's `Story` definition.
    **CRITICAL: Agent MUST read each story file's actual cognitionKey values before defining probes. Do NOT invent key names.**
    Verified cognitionKey targets per story:
    - **manor-intrigue**: 1-2 chains:
      - Chain 1: Alibi collapse — cognitionKeys `["oswin_alibi", "oswin_last_had_key", "oswin_guilty"]` with expected stances (contested → rejected → confirmed)
      - Chain 2 (optional): Motive reconstruction — `["ashworth_ordered_tamper", "oswin_ashworth_debt", "ashworth_motivated"]`
    - **island-suspicion**: 1-2 chains:
      - Chain 1: Framing evidence — `["xu_ran_paid_by_yuanchao", "killer_used_computer", "third_person_hypothesis"]` with stance progression (contested → rejected, then tentative → accepted)
    - **invisible-man**: 1 chain:
      - Chain 1: Cognitive blindness — `["no_one_entered", "cognitive_blindness_theory", "angus_memory_gap", "welkin_postman_disguise"]` (contested → L, then accepted, accepted, accepted)
    - **mini-sample**: 1 chain (smoke test):
      - Chain 1: Butler suspicion arc — `["butler_oswin_suspicious", "butler_innocent", "ashworth_involved"]`
  - For each chain, set `expectEdges: false` initially (conservative — don't require edge creation)
  - Run `bun test test/scenario-engine/dsl/story-validation.test.ts` to verify all stories still validate
  - Minimum: 2 beats with expectedToolPattern + 1 ReasoningChainProbe per story (including mini-sample)
  - **mini-sample** (Suggestion 1): Include as the first validation target — smallest story (6 probes, 12 beats), fastest iteration. Add at least 1 ToolCallPattern beat + 1 ReasoningChainProbe as smoke test.

  **Must NOT do**:
  - Modify existing beats, assertions, dialogue, or memoryEffects
  - Add new beats or characters
  - Set `expectEdges: true` (keep conservative — logic edge creation by LLM is non-deterministic)
  - Add patterns that would fail on settlement path (settlement has no tool calls — tool patterns skipped)
  - Invent cognitionKey names — MUST read from story file's actual assertion/commitment definitions

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Story-level changes requiring domain understanding of each narrative's reasoning structure. Must identify correct cognitionKeys and tool patterns per beat.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T7, T8, T9)
  - **Blocks**: None
  - **Blocked By**: T2 (W1 ToolCallPattern asserter), T3 (W2 ReasoningChainProbe verifier)

  **References**:

  **Pattern References**:
  - `test/scenario-engine/stories/manor-intrigue.ts` — Full story structure. Beats a5, b4, b5, c2, c5, d1, d2, d4, d5, e1 are key targets for expectedToolPattern. CognitionKeys: `oswin_alibi`, `key_custody`, `oswin_guilty`, `ashworth_ordered_tamper`.
  - `test/scenario-engine/stories/island-suspicion.ts` — Full story. CognitionKeys: `xu_ran_paid_by_yuanchao`, `killer_used_computer`, `player_suspect`, `player_usb_contradiction`.
  - `test/scenario-engine/stories/invisible-man.ts` — Full story. CognitionKeys: `no_one_entered`, `cognitive_blindness_theory`, `angus_memory_gap`, `welkin_postman_disguise`, `cognitive_blindness_demonstrated`.
  - `test/scenario-engine/stories/mini-sample.ts` — Smallest story (6 probes, 12 beats). CognitionKeys: `butler_oswin_suspicious`, `butler_innocent`, `ashworth_involved`, `butler_thief`, `head_maid_report`. Use as first validation target.

  **API/Type References**:
  - `test/scenario-engine/dsl/story-types.ts` — `ToolCallPattern` type, `ReasoningChainProbe` type, `Story.reasoningChainProbes` (all from T1)

  **External References**:
  - `docs/scenario-engine-gap-analysis.md:187-218` — C-8 roadmap: W3 depends on W1+W2

  **WHY Each Reference Matters**:
  - Story files: Must read actual beat memoryEffects to determine which tools SHOULD be called per beat. Cannot guess — must derive from DSL.
  - story-types.ts: Type definitions constrain what fields are available.

  **Acceptance Criteria**:

  - [ ] `bun test test/scenario-engine/dsl/story-validation.test.ts` — all stories validate with new probes
  - [ ] Each story (including mini-sample) has >= 2 beats with `expectedToolPattern`
  - [ ] Each story (including mini-sample) has >= 1 `ReasoningChainProbe`
  - [ ] All cognitionKey references in ReasoningChainProbes match actual keys in story files
  - [ ] No existing tests broken
  - [ ] `bun run build` — zero TypeScript errors

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Stories validate with new probe definitions
    Tool: Bash (bun test)
    Preconditions: All three stories updated with expectedToolPattern and reasoningChainProbes
    Steps:
      1. Run `bun test test/scenario-engine/dsl/story-validation.test.ts`
      2. Assert all validation tests pass for all stories
    Expected Result: Zero validation errors for manor-intrigue, island-suspicion, invisible-man
    Failure Indicators: ValidationError mentioning new fields
    Evidence: .sisyphus/evidence/task-6-story-validation.txt

  Scenario: ToolCallPattern references valid tool names
    Tool: Bash (bun test)
    Preconditions: story beats have mustContain/mustNotContain referencing real tool names from CALL_ONE_TOOLS
    Steps:
      1. Verify all mustContain tool names are in ["create_episode_event", "create_entity", "upsert_assertion", "create_alias", "create_logic_edge"]
      2. No typos or non-existent tool names
    Expected Result: All tool names are valid
    Failure Indicators: Validation catches unknown tool names, or live path assertion fails due to typo
    Evidence: .sisyphus/evidence/task-6-tool-names.txt
  ```

  **Commit**: YES
  - Message: `feat(scenario-engine): add ToolCallPattern and ReasoningChainProbe definitions to all stories`
  - Files: `test/scenario-engine/stories/manor-intrigue.ts`, `test/scenario-engine/stories/island-suspicion.ts`, `test/scenario-engine/stories/invisible-man.ts`, `test/scenario-engine/stories/mini-sample.ts`
  - Pre-commit: `bun test test/scenario-engine/dsl/story-validation.test.ts`

- [x] 7. W4 Failure Diagnosis Module (L1-L4)

  **What to do**:
  - Create `test/scenario-engine/probes/probe-diagnosis.ts` as a SEPARATE module (NOT inside probe-matcher.ts):
    ```typescript
    export async function diagnoseProbeFailure(
      probe: ProbeDefinition,
      missed: string[],
      infra: ScenarioInfra,
      writePath: "live" | "scripted" | "settlement",
    ): Promise<DiagnosisResult[]>
    ```
  - **writePath guard**: If `writePath === "settlement"`, return empty array immediately — settlement failures are DSL bugs, not agent issues. Diagnosis only runs for `"live"` and `"scripted"` paths.
  - For each missed fragment, run 4-layer diagnosis in order:
    - **L1 Extraction Missing**: Query `private_cognition_current` / `private_episode_events` for the fragment text. If not found → `layer: "L1", diagnosis: "EXTRACTION MISSING"`, meaning agent never created this data
    - **L2 Projection Missing**: Query `search_docs_cognition` / `search_docs_world` for the fragment. If L1 found but L2 not → `layer: "L2", diagnosis: "PROJECTION MISSING"`, meaning data exists but wasn't synced to search docs
    - **L3 Retrieval Failure**: Run direct ILIKE / vector raw query against search_docs. If L2 found but probe's search didn't match → `layer: "L3", diagnosis: "RETRIEVAL FAILURE"`, meaning data is searchable but query didn't match
    - **L4 Ranking Overflow**: Expand topK (e.g., to 100) and re-query. If found at rank > original topK → `layer: "L4", diagnosis: "RANK OVERFLOW at rank #N"`, meaning data was retrieved but ranked too low
  - Output format per fragment:
    ```typescript
    type DiagnosisResult = {
      fragment: string;
      layer: "L1" | "L2" | "L3" | "L4" | "UNKNOWN";
      diagnosis: string;
      detail?: string; // e.g., "found at rank #18 (topK=15)"
    };
    ```
  - Integration with report-generator.ts: when a probe fails, append diagnosis block:
    ```
    ❌ Probe p_reasoning_chain FAILED (score: 0.40)
       Missed: ["cognitive_blindspot", "mailman_identity"]
       
       🔍 Diagnosis:
       - "cognitive_blindspot": L1 EXTRACTION MISSING
         → not found in private_cognition_current
       - "mailman_identity": L4 RANK OVERFLOW
         → found in search_docs_world, matched at rank #18 (topK=15)
    ```
  - Create `test/scenario-engine/probes/probe-diagnosis.test.ts` with >= 4 test cases using mocked DB:
    1. L1 — fragment not in any table → EXTRACTION MISSING
    2. L2 — in private tables but not in search_docs → PROJECTION MISSING
    3. L3 — in search_docs but query misses → RETRIEVAL FAILURE
    4. L4 — found at rank beyond topK → RANK OVERFLOW
  - Diagnosis ONLY triggers on failure (`probe.passed === false`). Never runs for passing probes.
  - Diagnosis is for reporting only — does NOT change pass/fail status.
  - **Orchestrator integration**: In `orchestrator.ts`, after probe execution, iterate failed probes and call `diagnoseProbeFailure(probe, missed, infra, options.writePath)`. The writePath guard is inside the function, so caller always calls it — function returns empty array for settlement.

  **Must NOT do**:
  - Add DB queries to `probe-matcher.ts` (remains pure)
  - Suggest fixes or auto-retry
  - Run diagnosis on passing probes
  - Assume writePath from context — use the explicit writePath parameter

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Multi-layer DB diagnostic queries requiring understanding of storage schema, search projection, and ranking mechanics. Complex async data flow.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T6, T8, T9)
  - **Blocks**: None
  - **Blocked By**: T2 (W1 — diagnosis references assertion result types)

  **References**:

  **Pattern References**:
  - `test/scenario-engine/probes/report-generator.ts:29-91` — `generateReport()` function. Diagnosis block appends to probe failure section. Follow existing markdown formatting.
  - `test/scenario-engine/probes/probe-executor.ts:51-68` — `executeCognitionSearch()` shows how cognition DB queries work. L1-L4 diagnosis needs similar query patterns.

  **API/Type References**:
  - `test/scenario-engine/runner/write-paths.ts:573-598` — `syncLiveEpisodesToSearchDocs()` shows search_docs_world schema. L2 diagnosis queries this table.
  - `test/scenario-engine/runner/infra.ts` — `ScenarioInfra` type providing DB access via `infra.repos`
  - `src/memory/cognition/cognition-search.ts` — Cognition search service (L3 diagnosis uses raw search)
  - `src/memory/narrative/narrative-search.ts` — Narrative search service (L3/L4 diagnosis uses expanded queries)

  **External References**:
  - `docs/scenario-engine-gap-analysis.md:236-259` — C-10 consensus: failure-only diagnosis, 4-layer localization

  **WHY Each Reference Matters**:
  - `report-generator.ts:29-91`: Exact integration point for diagnosis output. Must match markdown formatting.
  - `write-paths.ts:573-598`: Shows HOW data reaches search_docs — L2 diagnosis checks if this sync happened correctly.

  **Acceptance Criteria**:

  - [ ] `bun test test/scenario-engine/probes/probe-diagnosis.test.ts` — >= 4 test cases, ALL pass
  - [ ] `bun run build` — zero TypeScript errors
  - [ ] Diagnosis ONLY runs when probe.passed === false
  - [ ] Diagnosis returns empty array when writePath === "settlement"
  - [ ] Each layer correctly identified in isolation (L1-L4)
  - [ ] Report includes formatted diagnosis block on probe failure
  - [ ] `probe-matcher.ts` UNCHANGED (no DB queries added)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: L1 Extraction Missing diagnosis
    Tool: Bash (bun test)
    Preconditions: Mock DB with empty private_cognition_current for queried fragment
    Steps:
      1. Call diagnoseProbeFailure with missed fragment "cognitive_blindspot"
      2. L1 query returns nothing → diagnosis: L1 EXTRACTION MISSING
    Expected Result: DiagnosisResult with layer: "L1", diagnosis: "EXTRACTION MISSING"
    Failure Indicators: Wrong layer assigned, or diagnosis runs on passing probe
    Evidence: .sisyphus/evidence/task-7-l1-diagnosis.txt

  Scenario: L4 Rank Overflow diagnosis
    Tool: Bash (bun test)
    Preconditions: Mock DB with fragment in search_docs, but original topK=15, expanded search finds it at rank 18
    Steps:
      1. Call diagnoseProbeFailure with missed fragment
      2. L1, L2 find the data → L3 probe search also finds it → L4 expanded search finds at rank #18
    Expected Result: DiagnosisResult with layer: "L4", detail containing "rank #18 (topK=15)"
    Failure Indicators: Stops at L3 instead of continuing to L4
    Evidence: .sisyphus/evidence/task-7-l4-diagnosis.txt
  ```

  **Commit**: YES
  - Message: `feat(scenario-engine): implement L1-L4 failure diagnosis module with report integration`
  - Files: `test/scenario-engine/probes/probe-diagnosis.ts`, `test/scenario-engine/probes/probe-diagnosis.test.ts`, `test/scenario-engine/probes/report-generator.ts`
  - Pre-commit: `bun test test/scenario-engine/probes/probe-diagnosis.test.ts`

- [x] 8. W7 Conflict Verification Probes for Manor/Island

  **What to do**:
  - Add `expectedConflictFields` to existing `StoryProbe` entries in manor-intrigue and island-suspicion that use `cognition_search` retrieval method and target contested assertions:
    - **manor-intrigue**: 
      - For probes querying `oswin_alibi` (contested in b4) — add `expectedConflictFields: { hasConflictSummary: true, expectedFactorRefs: [refs from b4 conflictFactors] }`
      - For probes querying `oswin_guilty` (confirmed in d4 after contested) — add `expectedConflictFields: { hasResolution: true }`
      - Add 1-2 NEW cognition_search probes specifically targeting conflict-rich assertions if existing probes don't cover them
    - **island-suspicion**:
      - For probes querying `xu_ran_paid_by_yuanchao` (contested d1 → rejected d4) — add `expectedConflictFields: { hasConflictSummary: true }`
      - Add 1 NEW cognition_search probe targeting the contested→rejected transition
    - **invisible-man**: Only 1 contested assertion (`no_one_entered` at d2). Consider adding `expectedConflictFields` to an existing probe but don't force it if coverage is thin.
  - Total new/modified probes: 3-5 across manor and island (per C-6 decision)
  - Run validation to ensure all new probes pass story validation

  **Must NOT do**:
  - Create a new dedicated conflict story (C-6 explicitly excludes option B)
  - Add probes for invisible-man if the single contested assertion doesn't warrant it
  - Modify existing beat assertions or memoryEffects

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Story-domain work requiring understanding of which assertions are contested and what conflict fields the settlement path would populate.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T6, T7, T9)
  - **Blocks**: None
  - **Blocked By**: T5 (W6 conflict field matcher must be implemented first)

  **References**:

  **Pattern References**:
  - `test/scenario-engine/stories/manor-intrigue.ts` — Existing probes p6-p10 use cognition_search. Look for probes targeting contested cognitionKeys. Beat b4: `oswin_alibi` contested with conflictFactors. Beat d4: `oswin_guilty` confirmed after contested.
  - `test/scenario-engine/stories/island-suspicion.ts` — Existing probes. Beats d1/d2/d4: `xu_ran_paid_by_yuanchao` contested→rejected. Beat e2: `player_usb_contradiction` contested.

  **API/Type References**:
  - `test/scenario-engine/dsl/story-types.ts` — `StoryProbe.expectedConflictFields` type (from T1)
  - `test/scenario-engine/dsl/story-types.ts:83-94` — `AssertionSpec` with `conflictFactors?: string[]` showing what conflict data is defined in stories

  **External References**:
  - `docs/scenario-engine-gap-analysis.md:146-169` — C-6 consensus: 1-2 probes for manor oswin_alibi, 1 for island player_suspect

  **WHY Each Reference Matters**:
  - Story files: Must read existing probes to determine which already target contested assertions (extend them) vs which need NEW probes
  - AssertionSpec.conflictFactors: The DSL-defined conflict data that SHOULD appear as CognitionHit.conflictFactorRefs after settlement

  **Acceptance Criteria**:

  - [ ] `bun test test/scenario-engine/dsl/story-validation.test.ts` — stories validate with conflict probes
  - [ ] manor-intrigue has >= 2 probes with expectedConflictFields
  - [ ] island-suspicion has >= 1 probe with expectedConflictFields
  - [ ] No existing probes modified in ways that break them
  - [ ] `bun run build` — zero TypeScript errors

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Conflict probes validate in story schema
    Tool: Bash (bun test)
    Preconditions: manor-intrigue and island-suspicion updated with conflict probes
    Steps:
      1. Run `bun test test/scenario-engine/dsl/story-validation.test.ts`
    Expected Result: Zero validation errors
    Failure Indicators: ValidationError on expectedConflictFields
    Evidence: .sisyphus/evidence/task-8-conflict-validation.txt

  Scenario: Conflict probes target correct contested assertions
    Tool: Bash (bun test)
    Preconditions: Probes reference cognitionKeys that actually have contested stance in story
    Steps:
      1. Verify each conflict probe's query targets a cognitionKey with stance "contested" in some beat
      2. Verify expectedFactorRefs match the conflictFactors array in the corresponding AssertionSpec
    Expected Result: All conflict probes reference valid contested assertions
    Failure Indicators: Probe references non-contested assertion or wrong conflictFactors
    Evidence: .sisyphus/evidence/task-8-probe-accuracy.txt
  ```

  **Commit**: YES
  - Message: `feat(scenario-engine): add conflict verification probes to manor-intrigue and island-suspicion`
  - Files: `test/scenario-engine/stories/manor-intrigue.ts`, `test/scenario-engine/stories/island-suspicion.ts`
  - Pre-commit: `bun test test/scenario-engine/dsl/story-validation.test.ts`

- [x] 9. W8 Comparison Report Enhancement

  **What to do**:
  - Enhance `generateComparisonReport()` in `report-generator.ts` with two new sections:
  - **Coverage Ratio** (C-7 / G-1):
    - After running both scripted and settlement paths, compute: `live_count / settlement_count` for:
      - Episodes: count of `private_episode_events` rows (live vs settlement)
      - Cognitions: count of `private_cognition_current` rows (live vs settlement)
      - Entities: count of `entity_nodes` rows (live vs settlement)
    - Output as table:
      ```
      ## Coverage Ratio
      | Dimension | Settlement | Live | Ratio |
      |-----------|-----------|------|-------|
      | Episodes  | 45        | 42   | 93.3% |
      | Cognitions| 30        | 28   | 93.3% |
      | Entities  | 12        | 12   | 100%  |
      ```
    - Low ratio (< 80%) → flag as "⚠️ significant extraction gap"
  - **Per-Assertion Alignment** (G-10 merged into G-1):
    - Extend existing `alignCognitionState()` function to include per-assertion detail:
      - For each cognitionKey: show `settlementStance` vs `liveStance`
      - Status: `match` (same stance), `drift` (different stance), `gap` (missing in live), `surprise` (extra in live)
    - Output as table:
      ```
      ## Per-Assertion Alignment
      | CognitionKey | Settlement Stance | Live Stance | Status |
      |-------------|-------------------|-------------|--------|
      | oswin_alibi | contested         | contested   | ✅ match |
      | key_custody | accepted          | tentative   | ⚠️ drift |
      ```
  - Add test for new report sections — snapshot test comparing generated report format

  **Must NOT do**:
  - Redesign existing report format — additive sections only
  - Build dashboards or visualization
  - Change how `alignCognitionState()` works internally — only extend its output
  - Report on W1/W2 result types (those have their own report sections in T2/T3)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Report generation enhancement with DB queries and markdown formatting. Moderate complexity.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T6, T7, T8)
  - **Blocks**: None
  - **Blocked By**: T1 (needs base types from pipeline scaffolding)

  **References**:

  **Pattern References**:
  - `test/scenario-engine/probes/report-generator.ts:160-280` — `generateComparisonReport()` function. New sections append after existing comparison sections. Follow markdown table formatting pattern.
  - `test/scenario-engine/probes/report-generator.ts:300-370` — `alignCognitionState()` function. Currently produces `CognitionAlignment[]` with `match/gap/surprise`. Extend with `drift` status and per-assertion stance detail.
  - `test/scenario-engine/probes/report-generator.ts:280-299` — `alignProbeResults()` function. Pattern for scripted vs settlement comparison.

  **API/Type References**:
  - `test/scenario-engine/runner/infra.ts` — `ScenarioInfra` type for DB access to count rows
  - `test/scenario-engine/probes/probe-types.ts` — Types consumed by report generator

  **External References**:
  - `docs/scenario-engine-gap-analysis.md:172-183` — C-7: coverage ratio in comparison report, G-10 merged with G-1

  **WHY Each Reference Matters**:
  - `report-generator.ts:160-280`: Exact function to extend — must understand existing sections to insert new ones in correct position
  - `alignCognitionState()`: Already queries private_cognition_current for both infras — extend its per-assertion output, don't rebuild

  **Acceptance Criteria**:

  - [ ] `bun run build` — zero TypeScript errors
  - [ ] `generateComparisonReport()` includes "Coverage Ratio" section with episode/cognition/entity counts
  - [ ] `generateComparisonReport()` includes "Per-Assertion Alignment" section with stance comparison
  - [ ] Low coverage ratio (< 80%) flagged with warning icon
  - [ ] `alignCognitionState()` returns per-assertion stance detail with match/drift/gap/surprise status

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Coverage ratio section generated correctly
    Tool: Bash (bun test)
    Preconditions: Two ScenarioInfra instances with known row counts
    Steps:
      1. Generate comparison report with mocked infra (settlement: 45 episodes, live: 42 episodes)
      2. Parse output for "Coverage Ratio" section
      3. Verify ratio: 42/45 = 93.3%
    Expected Result: Table shows correct counts and ratio with no warning (> 80%)
    Failure Indicators: Wrong counts, missing section, or incorrect ratio calculation
    Evidence: .sisyphus/evidence/task-9-coverage-ratio.txt

  Scenario: Per-assertion alignment with stance drift
    Tool: Bash (bun test)
    Preconditions: Settlement has cognitionKey "oswin_alibi" stance "contested", live has same key stance "tentative"
    Steps:
      1. Generate comparison report
      2. Parse "Per-Assertion Alignment" section
      3. Verify status: "drift" for oswin_alibi
    Expected Result: Table shows drift status with both stances displayed
    Failure Indicators: Shows "match" instead of "drift", or missing assertion entry
    Evidence: .sisyphus/evidence/task-9-stance-drift.txt
  ```

  **Commit**: YES
  - Message: `feat(scenario-engine): enhance comparison report with coverage ratio and per-assertion alignment`
  - Files: `test/scenario-engine/probes/report-generator.ts`, `test/scenario-engine/probes/report-generator.test.ts`
  - Pre-commit: `bun test test/scenario-engine/probes/report-generator.test.ts`

---

## Final Verification Wave (MANDATORY -- after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**

- [ ] F1. **Plan Compliance Audit** -- `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns -- reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** -- `unspecified-high`
  Run `bun run build` (tsc) + `bun test test/scenario-engine/`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic variable names.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** -- `unspecified-high`
  Start from clean state. Run settlement path on mini-sample with new probes. Run live path on mini-sample. Compare reports. Verify ToolCallPattern assertions execute and produce results. Verify ReasoningChainProbe produces results. Verify conflict fields checked. Save evidence to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** -- `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 -- everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Verify NO files under `src/` were modified. Detect cross-task contamination.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| Task | Commit Message | Pre-commit |
|------|---------------|------------|
| T1 | `feat(scenario-engine): add assertion pipeline scaffolding with result union types and BeatCallLog threading` | `bun run build` |
| T2 | `feat(scenario-engine): implement ToolCallPattern asserter with existence and cardinality checks` | `bun test test/scenario-engine/probes/tool-call-asserter.test.ts` |
| T3 | `feat(scenario-engine): implement ReasoningChainProbe verifier with cognitionKey coexistence and optional edge checks` | `bun test test/scenario-engine/probes/reasoning-chain-verifier.test.ts` |
| T4 | `feat(scenario-engine): add embedding fixture generation and injection for RRF hybrid search testing` | `bun run build` |
| T5 | `feat(scenario-engine): extend probe-matcher with expectedConflictFields checking` | `bun test test/scenario-engine/probes/probe-matcher.test.ts` |
| T6 | `feat(scenario-engine): add ToolCallPattern and ReasoningChainProbe definitions to all stories` | `bun test test/scenario-engine/dsl/story-validation.test.ts` |
| T7 | `feat(scenario-engine): implement L1-L4 failure diagnosis module with report integration` | `bun test test/scenario-engine/probes/probe-diagnosis.test.ts` |
| T8 | `feat(scenario-engine): add conflict verification probes to manor-intrigue and island-suspicion` | `bun test test/scenario-engine/dsl/story-validation.test.ts` |
| T9 | `feat(scenario-engine): enhance comparison report with coverage ratio and per-assertion alignment` | `bun test test/scenario-engine/probes/report-generator.test.ts` |

---

## Success Criteria

### Verification Commands
```bash
bun run build                           # Expected: 0 errors
bun test test/scenario-engine/          # Expected: ALL pass (existing + new)
bun test test/scenario-engine/probes/   # Expected: tool-call-asserter, reasoning-chain-verifier, probe-diagnosis, probe-matcher all pass
```

### Final Checklist
- [ ] All "Must Have" present (100% thresholds, existence+cardinality, cognitionKey coexistence)
- [ ] All "Must NOT Have" absent (no argument assertions, no LLM-as-judge, no src/ changes)
- [ ] All existing tests pass unchanged
- [ ] New assertion pipeline handles ToolCallPattern + ReasoningChainProbe + ConflictFields
- [ ] Failure diagnosis auto-reports L1-L4 on probe failure
- [ ] Comparison report shows coverage ratio + assertion alignment
- [ ] Embedding fixtures enable RRF hybrid search path in tests
