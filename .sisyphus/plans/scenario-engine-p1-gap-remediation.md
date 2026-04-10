# Scenario Engine P1 Gap Remediation

## TL;DR
> **Summary**: Close the four P1 scenario-engine gaps with additive JSON regression artifacts, scenario-level QueryRouter coverage, fail-fast embedding fixture validation, and an opt-in `ScenarioDebugger` snapshot surface. Keep scope strictly to P1-4 through P1-7; preserve current markdown reports, existing router unit tests, and default test ergonomics.
> **Deliverables**:
> - JSON report generation + baseline diff keyed by `probe.id`, with additive `.json` siblings beside existing `.md` reports
> - New `query-router` scenario story/tests covering CJK alias scan, multi-intent routing, budget reallocation, and plan determinism
> - Embedding fixture metadata/version validation with hard model/schema mismatch failures and optional age checks
> - `ScenarioDebugger` immutable snapshots for graph state, indexed content, and probe hits, exposed only when debug is enabled
> **Effort**: Large
> **Parallel**: YES - 2 waves
> **Critical Path**: T1/T3/T5/T7 -> T2/T4/T6/T8 -> F1-F4

## Context
### Original Request
Provide an executable plan for the scenario-engine gaps listed as P1-4 through P1-7: regression tracking, QueryRouter coverage, fixture staleness detection, and intermediate-state observability.

### Interview Summary
- Scope is locked to `test/scenario-engine/docs/scenario-engine-gaps.md` P1-4 through P1-7 only.
- Existing markdown report filenames under `test/scenario-engine/reports/` must remain unchanged; JSON output is additive.
- Existing router/unit coverage in `test/memory/query-router.test.ts`, `test/memory/query-plan-builder.test.ts`, and `test/memory/retrieval-orchestrator-plan.test.ts` is reference material, not work to duplicate.
- Default test strategy is `tests-after` using `bun test`; every task still requires agent-executed happy/error QA.
- No `.github/workflows/`, artifact upload implementation, dashboards, or unrelated P0/P2 work are in scope.

### Metis Review (gaps addressed)
- Preserve the current markdown save path from `test/scenario-engine/probes/report-generator.ts:197` and add JSON siblings instead of renaming reports.
- Treat baseline comparison as explicit input only; do not auto-discover “the previous report” from disk.
- Avoid router determinism flakiness by using time-neutral queries in the new scenario and comparing normalized plan/budget objects only.
- Make fixture age validation opt-in via `maxAgeMs`; model/schema mismatch is still a hard failure.
- Implement debugger data as immutable in-memory snapshots so lookups still work after schema cleanup.

## Work Objectives
### Core Objective
Upgrade the scenario-engine test platform so regression quality is machine-comparable, QueryRouter integration is exercised end-to-end, embedding fixtures fail fast when stale/incompatible, and debugging a failed scenario no longer requires manual DB inspection.

### Deliverables
- Add JSON report generation/diffing in `test/scenario-engine/probes/report-generator.ts`, plus any additive contract changes needed in `test/scenario-engine/probes/probe-types.ts` and `test/scenario-engine/probes/probe-executor.ts`.
- Add a new story/export/test pair for router integration coverage: `test/scenario-engine/stories/query-router.ts`, `test/scenario-engine/stories/index.ts`, `test/scenario-engine/scenarios/query-router.test.ts`.
- Add fixture metadata validation in `test/scenario-engine/runner/embedding-fixtures.ts` and emit the new metadata shape from `test/scenario-engine/scripts/generate-embedding-fixtures.ts`.
- Add a new debugger module and orchestrator exposure path: `test/scenario-engine/runner/debugger.ts`, `test/scenario-engine/runner/orchestrator.ts`, and any minimal runner/probe wiring files needed for capture.

### Definition of Done (verifiable conditions with commands)
- [ ] `bun run build`
- [ ] `bun test test/scenario-engine/probes/report-generator.test.ts`
- [ ] `bun test test/scenario-engine/scenarios/query-router.test.ts test/memory/query-router.test.ts test/memory/query-plan-builder.test.ts test/memory/retrieval-orchestrator-plan.test.ts`
- [ ] `bun test test/scenario-engine/runner/embedding-fixtures.test.ts`
- [ ] `bun test test/scenario-engine/runner/debugger.test.ts`
- [ ] `bun test test/scenario-engine/`

### Must Have
- JSON reports are saved beside current markdown reports as the same stem with `.json` extension.
- `compareReports()` compares reports by `probe.id`, quantifies score/latency deltas, and records pass/fail transitions plus added/removed probe IDs.
- The new router scenario covers exactly these integrations: CJK alias substring resolution, multi-intent routing, budget reallocation, and plan determinism.
- Fixture validation rejects missing metadata, model mismatch, schema mismatch, and stale age when `maxAgeMs` is provided.
- `ScenarioDebugger` exposes `getGraphState(beatId)`, `getIndexedContent(beatId)`, and `getProbeHits(probeId)` only when debug is enabled.
- Debug snapshots remain readable after run completion without requiring a live DB schema.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- No `.github/workflows/`, artifact upload logic, dashboards, or report portals.
- No auto-discovery of a baseline file from disk; baseline input stays explicit.
- No time-dependent router determinism assertions that rely on `Date.now()`-derived query windows.
- No hard age-based fixture failures on default test runs unless `maxAgeMs` is explicitly supplied.
- No generic log dumping as the debugger surface; use structured snapshot APIs only.
- No reopening P0/P2 gaps, and no rework of unrelated ToolCallPattern / ReasoningChain / ConflictField features.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: `tests-after` using `bun test`
- QA policy: every task includes an exact happy path and one failure/edge path
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`
- File artifacts: JSON/markdown reports stay under `test/scenario-engine/reports/`; tests assert their paths directly

## Execution Strategy
### Parallel Execution Waves
> Scope is intentionally limited to four P1 gaps, so the plan uses two compact waves with explicit dependencies.

Wave 1: foundation tasks
- T1 JSON report contract + diff semantics
- T3 QueryRouter story/case fixture
- T5 Fixture metadata contract + validation helper
- T7 Debugger types + orchestrator gating

Wave 2: wiring/integration tasks
- T2 JSON persistence + scenario/report wiring
- T4 QueryRouter scenario assertions + determinism coverage
- T6 Fixture generator/injection wiring + tests
- T8 Debugger snapshot capture + tests

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks | Wave |
|------|------------|--------|------|
| T1 | — | T2 | 1 |
| T3 | — | T4 | 1 |
| T5 | — | T6 | 1 |
| T7 | — | T8 | 1 |
| T2 | T1 | F1-F4 | 2 |
| T4 | T3 | F1-F4 | 2 |
| T6 | T5 | F1-F4 | 2 |
| T8 | T7 | F1-F4 | 2 |

### Agent Dispatch Summary (wave -> task count -> categories)
- Wave 1 -> 4 tasks -> `unspecified-high`, `deep`, `unspecified-high`, `deep`
- Wave 2 -> 4 tasks -> `unspecified-high`, `deep`, `unspecified-high`, `deep`
- Final Verification -> 4 tasks -> `oracle`, `unspecified-high`, `unspecified-high`, `deep`

## TODOs
> Implementation + test = one task.
> Every task includes exact file targets, acceptance criteria, and QA scenarios.

- [ ] 1. Add JSON report contract and diff semantics

  **What to do**: Extend `test/scenario-engine/probes/probe-types.ts` so `ProbeResult` carries additive `latencyMs?: number`, then time each probe execution in `test/scenario-engine/probes/probe-executor.ts`. In `test/scenario-engine/probes/report-generator.ts`, add a JSON report type plus `generateJsonReport()` and `compareReports(baseline, current)`. JSON comparison must key by `probe.id`, ignore volatile `meta.generatedAt`/`meta.gitSha` fields, compute `scoreDelta` and `latencyDeltaMs`, and classify `statusChange` as `pass->fail`, `fail->pass`, `added`, or `removed`.
  **Must NOT do**: Do not rename `saveReport()` or change existing markdown text/filenames. Do not auto-read a baseline from disk. Do not make latency mandatory when a retrieval method cannot supply it.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: focused contract/report work with additive type changes.
  - Skills: []
  - Omitted: [`git-master`] - not needed for implementation planning.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T2 | Blocked By: none

  **References**:
  - Pattern: `test/scenario-engine/probes/report-generator.ts:38` - existing markdown report generator to mirror structurally, not replace.
  - Pattern: `test/scenario-engine/probes/report-generator.ts:197` - stable markdown save path/filename convention.
  - API/Type: `test/scenario-engine/probes/probe-types.ts:16` - current `ProbeResult` shape to extend additively.
  - API/Type: `test/scenario-engine/probes/probe-executor.ts` - probe execution timing insertion point.
  - Test: `test/scenario-engine/probes/report-generator.test.ts` - extend with JSON schema/diff assertions.
  - External: `test/scenario-engine/docs/scenario-engine-gaps.md:114` - P1-4 intent and expected JSON diff capability.

  **Acceptance Criteria**:
  - [ ] `generateJsonReport()` returns stable JSON with `meta`, `summary`, `perBeatStats`, and `probes`.
  - [ ] `compareReports()` compares the union of probe IDs and returns deltas for score, latency, and pass/fail state.
  - [ ] `generateReport()` markdown output remains byte-compatible for existing tests except where explicit new JSON helpers are asserted separately.
  - [ ] `ProbeResult.latencyMs` is additive and does not break existing probe tests.
  - [ ] `bun test test/scenario-engine/probes/report-generator.test.ts` passes.

  **QA Scenarios**:
  ```text
  Scenario: JSON report mirrors a passing probe set
    Tool: Bash
    Steps: run `bun test test/scenario-engine/probes/report-generator.test.ts`
    Expected: tests cover a passing report with stable `summary`, per-probe `score`, and optional `latencyMs`
    Evidence: .sisyphus/evidence/task-1-json-report.txt

  Scenario: Diff detects pass/fail and added/removed probes
    Tool: Bash
    Steps: run `bun test test/scenario-engine/probes/report-generator.test.ts`
    Expected: tests assert `pass->fail`, `fail->pass`, `added`, `removed`, `scoreDelta`, and `latencyDeltaMs`
    Evidence: .sisyphus/evidence/task-1-report-diff.txt
  ```

  **Commit**: YES | Message: `feat(scenario-engine): add json report contracts and probe drift diffing` | Files: `test/scenario-engine/probes/probe-types.ts`, `test/scenario-engine/probes/probe-executor.ts`, `test/scenario-engine/probes/report-generator.ts`, `test/scenario-engine/probes/report-generator.test.ts`

- [ ] 2. Persist JSON report siblings and wire explicit comparisons

  **What to do**: In `test/scenario-engine/probes/report-generator.ts`, add a `saveJsonReport()` helper that writes `test/scenario-engine/reports/<storyId>-<suffix>-report.json` beside the existing markdown file. Update the exact report-producing tests that already save markdown reports to save JSON siblings too: `test/scenario-engine/smoke.test.ts`, `test/scenario-engine/scenarios/invisible-man.test.ts`, `test/scenario-engine/scenarios/island-suspicion.test.ts`, `test/scenario-engine/scenarios/manor-intrigue.test.ts`, `test/scenario-engine/scenarios/invisible-man-live.test.ts`, and `test/scenario-engine/scenarios/live-mini-sample.test.ts`. Add one explicit comparison path in tests: generate settlement/scripted or settlement/live JSON reports in the same test, feed them to `compareReports()`, and assert the diff object rather than scanning files implicitly.
  **Must NOT do**: Do not add a workflow, artifact upload, or automatic “baseline path” resolver. Do not stop writing markdown files.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: test wiring plus persistence path updates.
  - Skills: []
  - Omitted: [`playwright`] - no browser work involved.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: F1-F4 | Blocked By: T1

  **References**:
  - Pattern: `test/scenario-engine/probes/report-generator.ts:197` - report save helper and filename stem.
  - Pattern: `test/scenario-engine/scenarios/manor-intrigue.test.ts` - existing report-writing test pattern to preserve.
  - Pattern: `test/scenario-engine/smoke.test.ts` - existing scenario smoke flow suitable for explicit comparison assertions.
  - Test: `test/scenario-engine/probes/report-generator.test.ts` - persistence assertions.
  - External: `test/scenario-engine/docs/scenario-engine-gaps.md:121` - CI artifact handoff intent without implementing CI.

  **Acceptance Criteria**:
  - [ ] Every scenario test that currently writes markdown also writes a `.json` sibling with the same stem.
  - [ ] Explicit comparison tests exercise `compareReports()` using in-memory/current-run report objects only.
  - [ ] Existing markdown filenames remain unchanged.
  - [ ] JSON artifacts are written under `test/scenario-engine/reports/` and can be attached by future CI unchanged.
  - [ ] `bun test test/scenario-engine/smoke.test.ts test/scenario-engine/scenarios/invisible-man.test.ts test/scenario-engine/scenarios/island-suspicion.test.ts test/scenario-engine/scenarios/manor-intrigue.test.ts test/scenario-engine/scenarios/invisible-man-live.test.ts test/scenario-engine/scenarios/live-mini-sample.test.ts` passes.

  **QA Scenarios**:
  ```text
  Scenario: Scenario tests emit markdown and json siblings
    Tool: Bash
    Steps: run `bun test test/scenario-engine/smoke.test.ts`
    Expected: the targeted test writes both `<stem>-report.md` and `<stem>-report.json` under `test/scenario-engine/reports/`
    Evidence: .sisyphus/evidence/task-2-report-files.txt

  Scenario: Explicit baseline comparison skips auto-discovery
    Tool: Bash
    Steps: run `bun test test/scenario-engine/probes/report-generator.test.ts`
    Expected: tests prove diffs are produced only when baseline/current objects are explicitly passed
    Evidence: .sisyphus/evidence/task-2-explicit-baseline.txt
  ```

  **Commit**: YES | Message: `test(scenario-engine): persist json report siblings for scenario outputs` | Files: `test/scenario-engine/probes/report-generator.ts`, `test/scenario-engine/smoke.test.ts`, `test/scenario-engine/scenarios/invisible-man.test.ts`, `test/scenario-engine/scenarios/island-suspicion.test.ts`, `test/scenario-engine/scenarios/manor-intrigue.test.ts`, `test/scenario-engine/scenarios/invisible-man-live.test.ts`, `test/scenario-engine/scenarios/live-mini-sample.test.ts`

- [ ] 3. Create QueryRouter scenario story and case definitions

  **What to do**: Add `test/scenario-engine/stories/query-router.ts` and export it from `test/scenario-engine/stories/index.ts`. The file should export both `queryRouterStory` and a small `queryRouterCases` descriptor array used by tests. Seed the story with enough entities, aliases, episodes, and assertions to support three fixed queries: (1) CJK alias substring resolution with one character having 3+ aliases, (2) a multi-intent query that should produce a stable `primaryIntent` plus ordered `secondaryIntents`, and (3) a budget-reallocation query whose router/plan output is deterministic across repeated execution. Keep all query texts time-neutral so they do not trigger `Date.now()`-derived time windows.
  **Must NOT do**: Do not copy router math/assertions from `test/memory/*.test.ts`. Do not add unrelated probe types or P0 plan-surface work. Do not use ambiguous “recently/today/last night” query wording.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: requires aligning story data with router/planner expectations without re-opening unrelated work.
  - Skills: []
  - Omitted: [`frontend-ui-ux`] - irrelevant.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T4 | Blocked By: none

  **References**:
  - Pattern: `test/scenario-engine/stories/mini-sample.ts` - minimal story shape for a compact scenario fixture.
  - Pattern: `test/scenario-engine/stories/index.ts` - story export registration.
  - API/Type: `test/scenario-engine/dsl/story-types.ts:238` - `Story` contract; set `probes: []` explicitly because router assertions live in the scenario test, not in story probes.
  - API/Type: `src/memory/query-router.ts` - production router behavior to seed for.
  - Test: `test/memory/query-router.test.ts` - reference expectations for alias scan and multi-intent ordering.
  - Test: `test/memory/query-plan-builder.test.ts` - reference expectations for deterministic plan shape.

  **Acceptance Criteria**:
  - [ ] `queryRouterStory` seeds aliases/entities/assertions sufficient for the three named query cases.
  - [ ] `queryRouterCases` declares expected `primaryIntent`, ordered `secondaryIntents`, expected entity IDs, and the normalized fields to compare for determinism.
  - [ ] Story export registration allows importing the story from scenario tests.
  - [ ] `bun test test/scenario-engine/dsl/story-validation.test.ts` still passes.

  **QA Scenarios**:
  ```text
  Scenario: QueryRouter story validates as a normal scenario story
    Tool: Bash
    Steps: run `bun test test/scenario-engine/dsl/story-validation.test.ts`
    Expected: the new story passes validation with no extra router-specific schema work
    Evidence: .sisyphus/evidence/task-3-story-validation.txt

  Scenario: Query cases stay time-neutral and deterministic-friendly
    Tool: Bash
    Steps: run `bun test test/scenario-engine/scenarios/query-router.test.ts`
    Expected: no test depends on wall-clock time; determinism assertions compare the same normalized query/plan object twice
    Evidence: .sisyphus/evidence/task-3-determinism-shape.txt
  ```

  **Commit**: YES | Message: `test(scenario-engine): add query-router scenario story fixtures` | Files: `test/scenario-engine/stories/query-router.ts`, `test/scenario-engine/stories/index.ts`

- [ ] 4. Add QueryRouter scenario integration and determinism tests

  **What to do**: Create `test/scenario-engine/scenarios/query-router.test.ts`. Seed data with `runScenario(queryRouterStory, { writePath: "settlement", phase: "full" })`, then exercise the same router/planner stack the scenario engine uses. Assert case 1 resolves the expected entity IDs via alias substring scan; assert case 2 returns the expected `primaryIntent`, ordered `secondaryIntents`, matched rules, and signals; assert case 3 produces byte-stable normalized plan data and budget allocations across two identical invocations. Include one negative alias case that proves an unrelated substring does not resolve a false-positive entity.
  **Must NOT do**: Do not duplicate allocator unit tests or verify every surface-weight float exactly. Do not compare raw objects that contain volatile/non-deterministic fields.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: end-to-end router/planner integration with determinism normalization and negative coverage.
  - Skills: []
  - Omitted: [`git-workflow`] - unrelated.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: F1-F4 | Blocked By: T3

  **References**:
  - Pattern: `test/scenario-engine/runner/orchestrator.ts:85` - `runScenario()` settlement seeding flow.
  - Pattern: `test/memory/query-router.test.ts` - alias scan and multi-intent expectations.
  - Pattern: `test/memory/retrieval-orchestrator-plan.test.ts` - budget reallocation invariants to assert at integration level, not re-derive.
  - API/Type: `src/memory/query-router.ts` - route output fields to assert.
  - API/Type: `src/memory/query-plan-builder.ts` - deterministic plan builder output to normalize and compare.
  - API/Type: `src/memory/retrieval/budget-allocator.ts` - budget-allocation output shape.

  **Acceptance Criteria**:
  - [ ] CJK alias case resolves the intended entity and does not resolve the negative control query.
  - [ ] Multi-intent case asserts `primaryIntent`, ordered `secondaryIntents`, `matchedRules`, and relevant router signals.
  - [ ] Determinism case compares the same normalized plan/budget object twice and passes exactly.
  - [ ] The test reuses existing production services rather than a standalone fake router implementation.
  - [ ] `bun test test/scenario-engine/scenarios/query-router.test.ts test/memory/query-router.test.ts test/memory/query-plan-builder.test.ts test/memory/retrieval-orchestrator-plan.test.ts` passes.

  **QA Scenarios**:
  ```text
  Scenario: CJK alias substring scan resolves the intended entity
    Tool: Bash
    Steps: run `bun test test/scenario-engine/scenarios/query-router.test.ts`
    Expected: the positive alias case returns the expected entity id set; the negative alias case stays unresolved
    Evidence: .sisyphus/evidence/task-4-alias-scan.txt

  Scenario: Plan determinism stays byte-stable for the fixed query
    Tool: Bash
    Steps: run `bun test test/scenario-engine/scenarios/query-router.test.ts`
    Expected: two identical invocations produce the same normalized plan object and the same budget allocation object
    Evidence: .sisyphus/evidence/task-4-plan-determinism.txt
  ```

  **Commit**: YES | Message: `test(scenario-engine): cover query-router integration and plan determinism` | Files: `test/scenario-engine/scenarios/query-router.test.ts`, `test/scenario-engine/stories/query-router.ts`

- [ ] 5. Add fixture metadata contract and validation helper

  **What to do**: Extend `test/scenario-engine/runner/embedding-fixtures.ts` so `EmbeddingFixtureFile` requires `modelVersion: string`, `schemaVersion: number`, and the existing `generatedAt: number`. Add exported constants for the current fixture schema version and a `validateFixtureFreshness(fixture, opts)` helper with `expectedModel`, `expectedSchemaVersion`, optional `maxAgeMs`, and optional `nowMs` for tests. Validation must fail before any DB writes when metadata is missing, model/schema mismatch occurs, or age exceeds `maxAgeMs`.
  **Must NOT do**: Do not hard-code a wall-clock expiry into default loads. Do not silently accept pre-versioned fixtures missing metadata.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: focused schema/validation work.
  - Skills: []
  - Omitted: [`playwright`] - not applicable.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T6 | Blocked By: none

  **References**:
  - API/Type: `test/scenario-engine/runner/embedding-fixtures.ts:24` - current fixture file shape with `generatedAt` already present.
  - Pattern: `test/scenario-engine/runner/embedding-fixtures.ts:34` - current load/inject flow.
  - Pattern: `test/scenario-engine/scripts/generate-embedding-fixtures.ts:143` - generator output shape to keep aligned.
  - Test: `test/scenario-engine/runner/infra.test.ts` - runner-focused test style for new fixture tests.
  - External: `test/scenario-engine/docs/scenario-engine-gaps.md:172` - P1-6 intent.

  **Acceptance Criteria**:
  - [ ] `EmbeddingFixtureFile` requires `modelVersion`, `schemaVersion`, and `generatedAt`.
  - [ ] `validateFixtureFreshness()` throws descriptive errors for missing metadata, model mismatch, schema mismatch, and stale age.
  - [ ] `injectEmbeddingFixtures()` calls validation before creating/upserting vectors.
  - [ ] `bun test test/scenario-engine/runner/embedding-fixtures.test.ts` passes.

  **QA Scenarios**:
  ```text
  Scenario: Fresh fixture passes validation and injection preflight
    Tool: Bash
    Steps: run `bun test test/scenario-engine/runner/embedding-fixtures.test.ts`
    Expected: a synthetic fixture with matching model/schema and no age violation validates cleanly
    Evidence: .sisyphus/evidence/task-5-fixture-happy.txt

  Scenario: Stale or mismatched fixture fails before DB writes
    Tool: Bash
    Steps: run `bun test test/scenario-engine/runner/embedding-fixtures.test.ts`
    Expected: tests assert thrown errors for missing metadata, model mismatch, schema mismatch, and age expiry, with no repo upsert called
    Evidence: .sisyphus/evidence/task-5-fixture-errors.txt
  ```

  **Commit**: YES | Message: `feat(scenario-engine): validate embedding fixture metadata before injection` | Files: `test/scenario-engine/runner/embedding-fixtures.ts`, `test/scenario-engine/runner/embedding-fixtures.test.ts`

- [ ] 6. Update fixture generator and load path for versioned fixtures

  **What to do**: Update `test/scenario-engine/scripts/generate-embedding-fixtures.ts` so generated files always emit the new metadata contract. Keep `model` as the embedding model identifier used for repo upserts, and set `modelVersion` to the same resolved model id unless the provider exposes a more specific version string. Update `loadEmbeddingFixtures()` to surface a clear regeneration error for pre-versioned files. Add a pure helper for building fixture documents so tests can verify the serialized shape without requiring live API keys or committing new fixture files.
  **Must NOT do**: Do not require a real fixture generation run in default QA. Do not assume `test/scenario-engine/fixtures/` already contains committed fixtures.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: script/output alignment plus testability improvements.
  - Skills: []
  - Omitted: [`git-master`] - not relevant.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: F1-F4 | Blocked By: T5

  **References**:
  - Pattern: `test/scenario-engine/scripts/generate-embedding-fixtures.ts:89` - CLI generation flow.
  - Pattern: `test/scenario-engine/scripts/generate-embedding-fixtures.ts:143` - fixture serialization block.
  - API/Type: `test/scenario-engine/runner/embedding-fixtures.ts:34` - load helper error messaging.
  - Test: `test/scenario-engine/runner/embedding-fixtures.test.ts` - extend with generator-shape assertions.

  **Acceptance Criteria**:
  - [ ] The generator emits `modelVersion`, `schemaVersion`, and `generatedAt` in the serialized fixture document.
  - [ ] `loadEmbeddingFixtures()` rejects pre-versioned fixture JSON with a regenerate message.
  - [ ] Default QA for this task uses synthetic fixture documents only; no live API key is required.
  - [ ] `bun test test/scenario-engine/runner/embedding-fixtures.test.ts` passes.

  **QA Scenarios**:
  ```text
  Scenario: Generator helper emits versioned fixture documents
    Tool: Bash
    Steps: run `bun test test/scenario-engine/runner/embedding-fixtures.test.ts`
    Expected: tests assert serialized fixture documents contain `model`, `modelVersion`, `schemaVersion`, `generatedAt`, and `vectors`
    Evidence: .sisyphus/evidence/task-6-generator-shape.txt

  Scenario: Legacy fixture JSON is rejected with a regeneration hint
    Tool: Bash
    Steps: run `bun test test/scenario-engine/runner/embedding-fixtures.test.ts`
    Expected: loading a fixture that lacks the new metadata throws a clear “regenerate fixtures” error
    Evidence: .sisyphus/evidence/task-6-legacy-fixture.txt
  ```

  **Commit**: YES | Message: `test(scenario-engine): version embedding fixture generation output` | Files: `test/scenario-engine/scripts/generate-embedding-fixtures.ts`, `test/scenario-engine/runner/embedding-fixtures.ts`, `test/scenario-engine/runner/embedding-fixtures.test.ts`

- [ ] 7. Add ScenarioDebugger types and default-off handle gating

  **What to do**: Create `test/scenario-engine/runner/debugger.ts` with `ScenarioDebugger`, `GraphSnapshot`, `IndexSnapshot`, and `ProbeHitsSnapshot` types plus a collector factory that stores immutable snapshots in memory. Extend `test/scenario-engine/runner/infra.ts` so `RunOptions` gains additive `debug?: boolean`. In `test/scenario-engine/runner/orchestrator.ts`, resolve `debugEnabled` as `options?.debug ?? (process.env.SCENARIO_DEBUG === "1")`, add optional `debugger?: ScenarioDebugger` to `ScenarioHandleExtended`, and instantiate the collector only when `debugEnabled` is true. Export the debugger types from `test/scenario-engine/runner/index.ts`.
  **Must NOT do**: Do not expose debugger objects on normal runs. Do not make debugger methods lazy DB queries. Do not return `undefined` for bad lookups; throw descriptive `Unknown beatId` / `Unknown probeId` errors.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: API/lifecycle design with strict default-off parity.
  - Skills: []
  - Omitted: [`frontend-ui-ux`] - irrelevant.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T8 | Blocked By: none

  **References**:
  - API/Type: `test/scenario-engine/runner/orchestrator.ts:40` - `ScenarioHandleExtended` attachment point.
  - Pattern: `test/scenario-engine/runner/orchestrator.ts:85` - central `runScenario()` option resolution.
  - Pattern: `test/scenario-engine/runner/index.ts` - runner export surface.
  - API/Type: `test/scenario-engine/runner/infra.ts` - additive run option location if explicit debug override is needed.
  - External: `test/scenario-engine/docs/scenario-engine-gaps.md:203` - P1-7 target API.

  **Acceptance Criteria**:
  - [ ] `ScenarioHandleExtended.debugger` is absent by default and present only in debug-enabled runs.
  - [ ] `ScenarioDebugger` methods return immutable snapshots and throw descriptive lookup errors for unknown IDs.
  - [ ] Debugger types are exported for downstream tests/imports.
  - [ ] `bun test test/scenario-engine/runner/debugger.test.ts` passes.

  **QA Scenarios**:
  ```text
  Scenario: Debugger is absent by default
    Tool: Bash
    Steps: run `bun test test/scenario-engine/runner/debugger.test.ts`
    Expected: default runs return no `handle.debugger` and produce behavior identical to pre-change runs
    Evidence: .sisyphus/evidence/task-7-debug-off.txt

  Scenario: Unknown beat/probe lookup throws descriptive errors
    Tool: Bash
    Steps: run `bun test test/scenario-engine/runner/debugger.test.ts`
    Expected: `getGraphState("missing")` / `getProbeHits("missing")` throw exact unknown-id errors
    Evidence: .sisyphus/evidence/task-7-debug-errors.txt
  ```

  **Commit**: YES | Message: `feat(scenario-engine): add opt-in scenario debugger handle surface` | Files: `test/scenario-engine/runner/debugger.ts`, `test/scenario-engine/runner/infra.ts`, `test/scenario-engine/runner/orchestrator.ts`, `test/scenario-engine/runner/index.ts`, `test/scenario-engine/runner/debugger.test.ts`

- [ ] 8. Capture graph/index/probe snapshots for ScenarioDebugger

  **What to do**: Wire the debugger collector into the scenario pipeline so it captures: (a) per-beat graph snapshots after each beat is persisted/organized, (b) per-beat indexed-content snapshots showing what search/index rows exist after the beat, and (c) per-probe hit snapshots from `executeProbes()` containing hit order, score, source refs, and matched/missed fragments. Use immutable JSON-friendly payloads so the debugger remains usable even if `keepSchema` is false and cleanup has already run. Add dedicated tests for debug-on capture using a compact story such as `mini-sample`.
  **Must NOT do**: Do not store raw SQL clients or lazy closures in snapshots. Do not change normal run results when debug is off.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: cross-cutting pipeline instrumentation across runner and probe layers.
  - Skills: []
  - Omitted: [`playwright`] - not applicable.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: F1-F4 | Blocked By: T7

  **References**:
  - Pattern: `test/scenario-engine/runner/orchestrator.ts:140` - write-path dispatch sequence.
  - Pattern: `test/scenario-engine/probes/probe-executor.ts` - probe hit collection point.
  - Pattern: `test/scenario-engine/runner/write-paths.ts` - per-path persistence/projection points for beat snapshots.
  - Pattern: `test/scenario-engine/runner/graph-organizer-step.ts` - graph-organizer output source.
  - Pattern: `test/scenario-engine/runner/embedding-step.ts` - indexed content/embedding-related state source.
  - Test: `test/scenario-engine/stories/mini-sample.ts` - compact story for debugger capture tests.

  **Acceptance Criteria**:
  - [ ] With debug enabled, `getGraphState(beatId)` returns the captured post-beat graph snapshot.
  - [ ] With debug enabled, `getIndexedContent(beatId)` returns the captured indexed-content snapshot for that beat.
  - [ ] With debug enabled, `getProbeHits(probeId)` returns ordered hit data plus matched/missed fragments.
  - [ ] Snapshots remain readable after run completion without requiring a live schema.
  - [ ] `bun test test/scenario-engine/runner/debugger.test.ts` passes.

  **QA Scenarios**:
  ```text
  Scenario: Debug-enabled run captures valid beat and probe snapshots
    Tool: Bash
    Steps: run `bun test test/scenario-engine/runner/debugger.test.ts`
    Expected: the test fetches one valid beat snapshot and one valid probe-hit snapshot from a completed run and verifies stable fields
    Evidence: .sisyphus/evidence/task-8-debug-snapshots.txt

  Scenario: Snapshots survive schema cleanup
    Tool: Bash
    Steps: run `bun test test/scenario-engine/runner/debugger.test.ts`
    Expected: a debug-enabled run with cleanup still allows snapshot reads from `handle.debugger` after completion
    Evidence: .sisyphus/evidence/task-8-debug-cleanup.txt
  ```

  **Commit**: YES | Message: `feat(scenario-engine): capture immutable debugger snapshots for beats and probes` | Files: `test/scenario-engine/runner/debugger.ts`, `test/scenario-engine/runner/orchestrator.ts`, `test/scenario-engine/runner/write-paths.ts`, `test/scenario-engine/probes/probe-executor.ts`, `test/scenario-engine/runner/graph-organizer-step.ts`, `test/scenario-engine/runner/embedding-step.ts`, `test/scenario-engine/runner/debugger.test.ts`

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in parallel. All must approve. Present consolidated results to the user and wait for explicit okay before marking work complete.

- [ ] F1. Plan Compliance Audit — oracle
  Validate every T1-T8 acceptance criterion against the final diff and command output. Confirm markdown filenames are unchanged, JSON siblings exist, baseline comparison stays explicit, and no P0/P2 files were pulled in. Output: `Tasks [N/N] | Guardrails [N/N] | VERDICT`.
- [ ] F2. Code Quality Review — unspecified-high
  Run `bun run build` plus the targeted test commands from Definition of Done. Review changed files for accidental scope creep, duplicate router math, lazy DB-backed debugger lookups, and default-on age gating. Output: `Build [PASS/FAIL] | Tests [PASS/FAIL] | Code Review [PASS/FAIL] | VERDICT`.
- [ ] F3. Real Manual QA — unspecified-high
  Execute the new router scenario tests, fixture validation tests, debugger tests, and one report-producing smoke test. Verify actual report files under `test/scenario-engine/reports/` include both `.md` and `.json` siblings. Output: `Reports [PASS/FAIL] | Router [PASS/FAIL] | Fixtures [PASS/FAIL] | Debugger [PASS/FAIL] | VERDICT`.
- [ ] F4. Scope Fidelity Check — deep
  Compare the final diff to `test/scenario-engine/docs/scenario-engine-gaps.md` P1-4 through P1-7 and this plan. Confirm no `.github/workflows/`, dashboards, or unrelated probe subsystems were added. Output: `In Scope [PASS/FAIL] | Out of Scope [PASS/FAIL] | VERDICT`.

## Commit Strategy
| Task | Commit Message |
|------|----------------|
| T1 | `feat(scenario-engine): add json report contracts and probe drift diffing` |
| T2 | `test(scenario-engine): persist json report siblings for scenario outputs` |
| T3 | `test(scenario-engine): add query-router scenario story fixtures` |
| T4 | `test(scenario-engine): cover query-router integration and plan determinism` |
| T5 | `feat(scenario-engine): validate embedding fixture metadata before injection` |
| T6 | `test(scenario-engine): version embedding fixture generation output` |
| T7 | `feat(scenario-engine): add opt-in scenario debugger handle surface` |
| T8 | `feat(scenario-engine): capture immutable debugger snapshots for beats and probes` |

## Success Criteria
- JSON reports exist beside current markdown reports and can be diffed explicitly by `probe.id`
- Router integration coverage is present in scenario-engine without duplicating existing unit-test math
- Fixture validation fails early for incompatible/stale metadata and remains stable by default without `maxAgeMs`
- `ScenarioDebugger` is default-off, debug-on, and usable after run completion
- `bun run build` and `bun test test/scenario-engine/` both pass
