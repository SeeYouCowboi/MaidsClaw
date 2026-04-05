# Story-Driven Memory Test Tool

## TL;DR

> **Quick Summary**: Build a 4-layer test tool (Story DSL → Dialogue Generator → Settlement Generator → Scenario Runner) that generates rich, 100+ turn intrigue scenarios to end-to-end test the memory system pipeline. Stories with 8+ characters, timeline conflicts, suspicion chains, and red herrings are defined as TypeScript objects, then processed through the real memory pipeline (ExplicitSettlementProcessor + ProjectionManager + GraphOrganizer) with probe queries verifying retrieval correctness.
> 
> **Deliverables**:
> - Story DSL type system with validation (TypeScript objects importing existing domain enums)
> - LLM-assisted dialogue generator with JSON file caching
> - Settlement payload generator (deterministic path via structured TurnSettlementPayload)
> - Scripted MemoryTaskModelProvider (LLM extraction path testing)
> - Scenario runner orchestrating full PG pipeline + real GraphOrganizer
> - Probe query system with bun test assertions + standalone markdown report
> - First benchmark story: 100+ turns, 8+ characters, 5+ locations, 3+ red herrings, 1 main causal chain
> 
> **Estimated Effort**: XL
> **Parallel Execution**: YES - 4 implementation waves + final review
> **Critical Path**: Task 1 → Task 4 → Task 6 → Task 11 → Task 13 → Task 17 → F1-F4 → user okay

---

## Context

### Original Request
Build a test tool that generates rich, complex scenarios with logical reasoning, timeline analysis, suspicion/distrust, and hidden motives via a story-driven approach. Stories are defined structurally, converted into 100+ turn conversations by a dialogue generator, then processed through the real memory pipeline to create memory nodes. Scenarios are reusable fixtures — modify the story DSL, re-run the generator, get a new fixture.

### Interview Summary
**Key Discussions**:
- **Primary pipeline**: Dialogue → real thinker (live mode) → runMigrate → memory nodes. First run uses real LLM; tool call responses are cached and replayed as "scripted baseline" in subsequent runs.
- **Settlement role**: Reference answer only — Settlement produces the DSL's expected memory state for comparison against what the real thinker actually extracted. NOT the primary test data source.
- **Three orthogonal dimensions** (not "modes"):
  - **WritePath**: `live` (real LLM) | `scripted` (cached live replay) | `settlement` (DSL direct)
  - **Phase**: `full` (populate + probe) | `probe_only` (reuse schema)
  - **Comparison**: optional settlement-vs-scripted diff report
- **Dialogue generation**: LLM-assisted + file caching. Manual cache invalidation.
- **Story DSL format**: TypeScript objects — type-safe, IDE autocomplete.
- **GraphOrganizer**: Run real — full fidelity with real embeddings, semantic edges, node scoring.
- **Running environment**: Local development only. Can depend on PG, API keys, real embedding model.
- **Probe output**: Both bun test assertions (regression) + standalone markdown report (debugging).
- **Code location**: Under `test/scenario-engine/`.
- **Coverage split**: Mini-sample (~12 beats) covers all domain concept types (diagnostic). Manor-intrigue (100+ turns) tests retrieval at scale (narrative complexity). Separate concerns, separate diagnostics.
- **Tool self-testing**: Yes, unit tests for core logic (DSL validation, settlement generation, probe matching).

**Research Findings**:
- Existing `test/helpers/pg-long-rp-memory-scenario.ts` is the predecessor — 28 messages, 7 entities, manual seeding
- `scripts/rp-suspicion-test.ts` with `TurnSpec` type provides precedent for structured turn definitions
- `MemoryTaskModelProvider` interface: `{ chat(messages, tools): ToolCallResult[], embed(texts, purpose, modelId): Float32Array[] }`
- `ExplicitSettlementProcessor` handles structured settlements deterministically
- `ProjectionManager.commitSettlement()` handles sync projections (episodes, cognition, search docs)
- `GraphOrganizer` handles async projections (embeddings, semantic edges, node scoring)

### Metis Review
**Identified Gaps** (addressed):

1. **Settlement Pipeline Gap (CRITICAL)**: `ExplicitSettlementProcessor.process()` does NOT accept `TurnSettlementPayload` directly. It takes `(MemoryFlushRequest, IngestionInput, CreatedState, tools, options)`. The conversion path must be investigated and documented before the settlement generator can be built. → Added as Task 4 (investigation task).

2. **Domain Model Constraints**: Trust is NOT a first-class property — must use `EvaluationRecord.dimensions`. Suspicion is modeled via `basis:"inference"` + `stance:"contested"` + `conflicts_with` relations. Hidden motives are private `CommitmentRecord`s. Episode category `"thought"` is REJECTED by validation — only speech/action/observation/state_change. Logic edges only connect event_nodes, not assertions/entities. → Added as DSL validation constraints in Task 3.

3. **Entity ID Resolution**: TurnSettlementPayload uses pointer_key strings but tools need numeric entity_ids (auto-generated by PG). The tool must create entities first, capture IDs, then reference them in subsequent settlements. → Addressed in Task 6 + Task 11 design.

4. **Settlement Ledger Idempotency**: Re-runs on same schema will skip already-applied settlements. → Guardrail: fresh PG schema per run (follows existing pattern).

5. **Viewer Perspective for Probes**: All retrieval requires ViewerContext. Probes must specify whose perspective to query from. → Added to probe DSL design in Task 10.

6. **Embedding Dimension Matching**: `bootstrapDerivedSchema(sql, { embeddingDim })` must match actual model output. → Addressed in Task 1 configuration.

7. **Scripted Provider Entity ID Problem**: Scripted MemoryTaskModelProvider responses need entity IDs that don't exist until DB insert. → Two-phase approach: pre-seed entities → capture IDs → generate scripted responses using captured IDs.

---

## Work Objectives

### Core Objective
Build a reusable, story-driven test tool that generates complex intrigue scenarios, processes them through the complete memory pipeline (ingestion → settlement → projection → embedding → retrieval), and verifies retrieval correctness via probe queries with both regression assertions and diagnostic reports.

### Concrete Deliverables
- `test/scenario-engine/dsl/` — Story DSL types + validation
- `test/scenario-engine/generators/` — Settlement generator + dialogue generator + scripted provider generator
- `test/scenario-engine/runner/` — Scenario runner (PG bootstrap + pipeline orchestration + GraphOrganizer)
- `test/scenario-engine/probes/` — Probe query system + assertions + report generator
- `test/scenario-engine/stories/` — First benchmark story (100+ turns)
- `test/scenario-engine/cache/` — Dialogue cache directory (gitignored)
- `test/scenario-engine/reports/` — Generated report directory (gitignored)

### Definition of Done
- [ ] `bun test test/scenario-engine/` — all tests pass
- [ ] First story scenario completes end-to-end (all 100+ turns processed, all probes pass)
- [ ] Markdown report generated with per-probe hit/miss + per-beat memory write summary
- [ ] Modifying a story beat and re-running produces updated probe results

### Must Have
- Story DSL types that import and re-export existing domain enums (AssertionStance, AssertionBasis, EpisodeCategory, LogicEdgeType, etc.)
- Validation that catches illegal stance transitions, invalid episode categories, missing preContestedStance
- Primary baseline via live→scripted pipeline: first run uses real LLM to process dialogue, caches tool call responses; subsequent runs replay cached responses deterministically
- Settlement generator producing reference answer (DSL-expected memory state) for comparison diagnostics only
- LLM dialogue generator with JSON file caching and manual invalidation
- Tool call response caching: live run's ToolCallResult[] persisted and replayed as scripted baseline
- Scenario runner with three orthogonal dimensions: WritePath (live|scripted|settlement) × Phase (full|probe_only) × optional comparison report
- Real PG + real ProjectionManager + real GraphOrganizer
- Probe queries using existing retrieval API methods (narrative_search, cognition_search, memory_read, memory_explore)
- bun test assertions + markdown diagnostic report (including settlement-vs-scripted diff when comparison enabled)
- Coverage split: mini-sample (~12 beats) exercises all 7 assertion stances, all 5 bases, all 3 cognition kinds, all 4 episode categories, all 4 logic edge types, entity aliases, evaluations, commitments, contested assertions, retraction ops. Manor-intrigue (100+ turns) focuses on retrieval at scale without coverage mandate.

### Must NOT Have (Guardrails)
- NO custom domain abstractions (no `trust_level: number`, no `suspicion_degree`, no `hidden_motive` as DSL fields — these decompose into existing primitives)
- NO custom query language for probes (use existing retrieval API signatures only)
- NO dynamic branching in stories (stories are linear beat sequences)
- NO inter-story dependencies (each story is 100% self-contained)
- NO web UI / HTML visualization / graph viewer (markdown + JSON reports only)
- NO multi-embedding-model support (one model, configured once)
- NO CI integration (local-only tool)
- NO `"thought"` episode category (rejected by production validation)
- NO logic edges between non-event nodes (only event_node ↔ event_node)
- NO auto-generated red herrings (all plot elements manually authored in DSL)
- NO performance optimization / batching / parallelism of settlements (sequential processing, local-only, time is not critical)

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** - ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (bun test)
- **Automated tests**: YES (Tests-after — write core logic first, test immediately after)
- **Framework**: bun test
- **Pattern**: Follow existing PG test patterns — `skipPgTests` guard, `createPgTestDb()`, schema isolation

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **DSL/Generator logic**: Use Bash (bun test) — run unit tests, assert output shapes
- **PG integration**: Use Bash (bun test) — run with `PG_TEST_URL`, assert DB state
- **Full scenario**: Use Bash (bun test) — run end-to-end, verify report generated + probes pass
- **Report output**: Use Bash (cat/inspect) — verify markdown report structure and content

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately - foundation, 5 parallel):
├── Task 1: Directory scaffolding + configuration [quick]
├── Task 2: Story DSL types [quick]
├── Task 3: Story DSL validation + tests [quick]
├── Task 4: Investigate settlement pipeline path [deep]
└── Task 5: Mini sample story (~12 beats, domain coverage) [quick]

Wave 2 (After Wave 1 - generators, 5 parallel):
├── Task 6: Settlement payload generator + tests (depends: 2, 3, 4) [deep]
├── Task 7: Scripted provider (from cached live) + tests (depends: 2, 4) [unspecified-high]
├── Task 8: LLM dialogue generator (depends: 2) [unspecified-high]
│   └── Task 9: Scenario cache layer + tests (depends: 8, needs GeneratedDialogue type) [quick]
└── Task 10: Probe query types + matching logic + tests (depends: 2) [unspecified-high]

Wave 3 (After Wave 2 - runner, split into 3 sub-tasks + integration):
├── Task 11a: Runner shared infra — PG bootstrap, entity creation, schema lifecycle (depends: 6) [unspecified-high]
├── Task 11b: Runner writePath execution — live/scripted/settlement branches + checkpoint (depends: 7, 9, 11a) [deep]
├── Task 11c: Runner orchestration — dialogue loading, interaction seeding, wiring (depends: 11a, 11b) [unspecified-high]
├── Task 12: GraphOrganizer integration (depends: 11c) [unspecified-high]
├── Task 13: Smoke test — mini-sample end-to-end (depends: 5, 10, 12) [unspecified-high]
└── Task 14: Probe query executor (depends: 10, 11c) [unspecified-high]

Wave 4 (After Wave 3 - reporting + story, partially parallel):
├── Task 15: Probe assertions + report generator + comparison alignment (depends: 14) [unspecified-high]
├── Task 16a: Manor intrigue — story outline + characters (depends: 2, 3) [deep]
├── Task 16b: Manor intrigue — per-phase beats + memory effects (depends: 16a) [deep]
└── Task 16c: Manor intrigue — probes + event relations + validation (depends: 16b) [unspecified-high]

Wave 5 (After Wave 4 - integration):
└── Task 17: Full scenario end-to-end test (depends: 15, 16c) [deep]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: T1 → T4 → T6 → T11a → T11b → T11c → T12 → T13 → T17 → F1-F4 → user okay
Max Concurrent: 5 (Wave 1 & Wave 2)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 | - | 2-5 | 1 |
| 2 | 1 | 5-10, 16a | 1 |
| 3 | 2 | 6, 16a | 1 |
| 4 | - | 6, 7 | 1 |
| 5 | 2, 3 | 13 | 1 |
| 6 | 2, 3, 4 | 11a | 2 |
| 7 | 2, 4 | 11b | 2 |
| 8 | 2 | 9 | 2 |
| 9 | 8 | 11b | 2 |
| 10 | 2 | 13, 14 | 2 |
| 11a | 6 | 11b, 11c | 3 |
| 11b | 7, 9, 11a | 11c | 3 |
| 11c | 11a, 11b | 12, 13, 14 | 3 |
| 12 | 11c | 13 | 3 |
| 13 | 5, 10, 12 | 17 | 3 |
| 14 | 10, 11c | 15 | 3 |
| 15 | 14 | 17 | 4 |
| 16a | 2, 3 | 16b | 4 |
| 16b | 16a | 16c | 4 |
| 16c | 16b | 17 | 4 |
| 17 | 15, 16c | F1-F4 | 5 |
| F1-F4 | 17 | user okay | FINAL |

### Agent Dispatch Summary

- **Wave 1**: **5** — T1→`quick`, T2→`quick`, T3→`quick`, T4→`deep`, T5→`quick`
- **Wave 2**: **5** — T6→`deep`, T7→`unspecified-high`, T8→`unspecified-high`, T9→`quick`(after T8), T10→`unspecified-high`
- **Wave 3**: **6** — T11a→`unspecified-high`, T11b→`deep`, T11c→`unspecified-high`, T12→`unspecified-high`, T13→`unspecified-high`, T14→`unspecified-high`
- **Wave 4**: **4** — T15→`unspecified-high`, T16a→`deep`, T16b→`deep`, T16c→`unspecified-high`
- **Wave 5**: **1** — T17→`deep`
- **FINAL**: **4** — F1→`oracle`, F2→`unspecified-high`, F3→`unspecified-high`, F4→`deep`

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.

- [x] 1. Directory scaffolding + configuration

  **What to do**:
  - Create `test/scenario-engine/` directory structure:
    ```
    test/scenario-engine/
    ├── dsl/           # Story DSL types + validation
    ├── generators/    # Settlement, dialogue, scripted provider generators
    ├── runner/        # Scenario runner + PG orchestration
    ├── probes/        # Probe query system + reports
    ├── stories/       # Story DSL definitions
    ├── cache/         # Dialogue cache (gitignored)
    └── reports/       # Generated reports (gitignored)
    ```
  - Add `.gitignore` entries for `test/scenario-engine/cache/` and `test/scenario-engine/reports/`
  - Create a shared constants file with:
    - `SCENARIO_ENGINE_BASE_TIME = 1_730_000_000_000` (matching existing convention)
    - Embedding dimension constant (match actual model — check `src/memory/embeddings.ts` for config)
    - Default agent/session IDs for scenario runs
  - Create `index.ts` barrel exports in each subdirectory (`dsl/index.ts`, `generators/index.ts`, `runner/index.ts`, `probes/index.ts`, `stories/index.ts`) to keep cross-directory imports concise

  **Must NOT do**:
  - Do NOT create a separate tsconfig (share root)
  - Do NOT add new npm packages

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4, 5)
  - **Blocks**: Tasks 2-5
  - **Blocked By**: None

  **References**:
  - `test/helpers/pg-test-utils.ts` — Existing test helper pattern with `skipPgTests` guard and `createTestPg()` factory. Follow this pattern for PG setup.
  - `test/helpers/pg-app-test-utils.ts` — Full app-level test setup with `createPgTestDb()`, `seedStandardPgEntities()`. Use this as the model for scenario runner bootstrap.
  - `src/memory/embeddings.ts` — Check what embedding model/dimension is configured. The scenario engine must match this exactly.
  - `.gitignore` — Add cache and reports exclusions here.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Directory structure exists after scaffolding
    Tool: Bash
    Steps:
      1. ls -R test/scenario-engine/
      2. Assert directories exist: dsl/, generators/, runner/, probes/, stories/, cache/, reports/
      3. Assert shared constants file exists and exports SCENARIO_ENGINE_BASE_TIME
    Expected Result: All directories present, constants file compiles without errors
    Evidence: .sisyphus/evidence/task-1-scaffolding-structure.txt

  Scenario: Cache and reports are gitignored
    Tool: Bash
    Steps:
      1. Create a dummy file in test/scenario-engine/cache/test.json
      2. Run git status --porcelain test/scenario-engine/cache/
      3. Assert no output (file is ignored)
    Expected Result: Files in cache/ and reports/ are not tracked by git
    Evidence: .sisyphus/evidence/task-1-gitignore-check.txt
  ```

  **Commit**: YES (groups with Tasks 2, 3, 5 in C1)
  - Message: `feat(scenario-engine): scaffold directory structure and configuration`
  - Files: `test/scenario-engine/**`, `.gitignore`

- [x] 2. Story DSL types

  **What to do**:
  - Define TypeScript types for the story DSL in `test/scenario-engine/dsl/story-types.ts`:
    - `StoryCharacter`: id (pointer_key), displayName, entityType, surfaceMotives (string), hiddenCommitments (CommitmentRecord[]), initialEvaluations (EvaluationRecord[]), aliases (string[])
    - `StoryLocation`: id (pointer_key), displayName, parentLocationId?, visibilityScope
    - `StoryClue`: id (pointer_key), displayName, entityType ("item"|"object"), initialLocation, description
    - `StoryBeat`: id, phase, round, timestamp (game-world time), location (pointer_key ref), participants (pointer_key refs), dialogue guidance (what to discuss), whoIsLying (pointer_key ref + what the lie is), memoryEffects (what this beat should produce — see below), publicationDeclarations? (for world-visible events)
    - `MemoryEffect`: the memory nodes this beat should create — episodes (EpisodeSpec[]), assertions (AssertionSpec[]), evaluations (EvaluationSpec[]), commitments (CommitmentSpec[]), logicEdges (LogicEdgeSpec[]), entities? (new entities discovered), aliases? (new aliases), retractions? (cognition keys to retract)
    - `StoryProbe`: query string, retrievalMethod ("narrative_search"|"cognition_search"|"memory_read"|"memory_explore"), viewerPerspective (pointer_key of the querying character), expectedFragments (string[]), expectedMissing? (strings that should NOT appear), topK (how many results to check)
    - `Story`: title, description, characters, locations, clues, beats (ordered), probes, eventRelations (causal/temporal/same_episode links between beat IDs)
  - **CRITICAL**: Import and re-use existing domain enums — do NOT redefine:
    - `AssertionStance` from `src/runtime/rp-turn-contract.ts`
    - `AssertionBasis` from `src/runtime/rp-turn-contract.ts`
    - `PrivateEventCategory` from `src/memory/types.ts` (but constrain to exclude "thought")
    - `LogicEdgeType` from `src/memory/types.ts`
    - `VisibilityScope` from `src/memory/types.ts`
    - `MemoryScope` from `src/memory/types.ts`
  - Define `EpisodeSpec`, `AssertionSpec`, `EvaluationSpec`, `CommitmentSpec`, `LogicEdgeSpec` types that map 1:1 to the fields needed by `ProjectionManager.commitSettlement()` and `CognitionRepository.upsert*()` methods, using pointer_keys for entity references (resolved to numeric IDs at runtime)

  **Must NOT do**:
  - Do NOT create `trust_level: number` or `suspicion_degree` fields — trust is expressed via `EvaluationSpec.dimensions` with `{name: "trustworthiness", value: 0.7}`
  - Do NOT create `hidden_motive: string` field — hidden motives are `CommitmentRecord` with `mode: "intent"` or `"goal"`
  - Do NOT allow `"thought"` as episode category
  - Do NOT create logic edge specs between non-event nodes

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3, 4, 5)
  - **Blocks**: Tasks 5-10, 16
  - **Blocked By**: Task 1 (directory must exist)

  **References**:
  - `src/memory/types.ts` — All domain enums to import: `AssertionStance` (7 values), `PrivateEventCategory` (4 valid values), `LogicEdgeType` (4 values), `VisibilityScope`, `MemoryScope`, `ExploreMode`. Lines 8-71 define all enum constants.
  - `src/runtime/rp-turn-contract.ts` — `AssertionBasis` (5 values), `AssertionRecordV4`, `EvaluationRecord`, `CommitmentRecord` types. These are the exact shapes the settlement pipeline expects.
  - `src/memory/episode/episode-repo.ts` — `EpisodeAppendParams` type shows what fields episodes need: agentId, sessionId, settlementId, category, summary, privateNotes, locationEntityId, locationText, validTime, committedTime, sourceLocalRef.
  - `src/memory/cognition/cognition-repo.ts` — `upsertAssertion()`, `upsertEvaluation()`, `upsertCommitment()` parameter types. These define what the settlement generator must produce.
  - `test/helpers/pg-long-rp-memory-scenario.ts` — Existing scenario entity structure (greenhouse, archive_annex, courtyard, mira, butler_oswin, silver_key, ledger_drawer). Follow this naming and pointer_key convention.
  - `scripts/rp-suspicion-test.ts` — `TurnSpec` type (round, phase, sendGuide, tactic, expectCriteria, checkItems). Use as inspiration for StoryBeat structure.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: DSL types compile and are importable
    Tool: Bash
    Steps:
      1. bun run build (or tsc --noEmit)
      2. Assert no type errors in test/scenario-engine/dsl/story-types.ts
    Expected Result: Zero type errors
    Evidence: .sisyphus/evidence/task-2-types-compile.txt

  Scenario: Domain enums are re-exported, not redefined
    Tool: Bash (grep)
    Steps:
      1. grep -n "AssertionStance" test/scenario-engine/dsl/story-types.ts
      2. Assert it contains "import" and NOT "type AssertionStance ="
      3. Repeat for AssertionBasis, PrivateEventCategory, LogicEdgeType
    Expected Result: All domain types are imported, none redefined
    Evidence: .sisyphus/evidence/task-2-no-redefine.txt
  ```

  **Commit**: YES (groups with Tasks 1, 3, 5 in C1)
  - Message: `feat(scenario-engine): define Story DSL types importing domain enums`
  - Files: `test/scenario-engine/dsl/story-types.ts`

- [x] 3. Story DSL validation + tests

  **What to do**:
  - Create `test/scenario-engine/dsl/story-validation.ts` with validation functions:
    - `validateStory(story: Story): ValidationResult` — top-level validator
    - `validateBeat(beat: StoryBeat, story: Story): ValidationError[]` — per-beat validation
    - `validateStanceTransitions(beats: StoryBeat[]): ValidationError[]` — check that assertion stance changes across beats follow legal state machine (e.g., `confirmed` can only go to `accepted` or `contested`; `rejected`/`abandoned` are terminal)
    - `validateEpisodeCategories(beats: StoryBeat[]): ValidationError[]` — reject `"thought"` category
    - `validateContestedAssertions(beats: StoryBeat[]): ValidationError[]` — `contested` stance REQUIRES `preContestedStance` field
    - `validateLogicEdgeTargets(beats: StoryBeat[]): ValidationError[]` — logic edges only between event-producing beats
    - `validatePointerKeyRefs(story: Story): ValidationError[]` — all pointer_key references in beats resolve to defined characters/locations/clues
    - `validateProbes(story: Story): ValidationError[]` — all probe viewerPerspectives reference defined characters
  - Create `test/scenario-engine/dsl/story-validation.test.ts` with unit tests:
    - Test: valid story passes validation
    - Test: `"thought"` category is rejected
    - Test: illegal stance transition (`rejected` → `accepted`) is caught
    - Test: `contested` without `preContestedStance` is caught
    - Test: logic edge between non-event nodes is caught
    - Test: undefined pointer_key reference is caught
    - Test: probe with undefined viewer perspective is caught

  **Must NOT do**:
  - Do NOT validate dialogue content (that's generated later)
  - Do NOT validate settlement payload structure (that's Task 6)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4, 5)
  - **Blocks**: Tasks 6, 16
  - **Blocked By**: Task 2 (needs DSL types)

  **References**:
  - `test/scenario-engine/dsl/story-types.ts` — The types being validated (from Task 2).
  - `src/memory/types.ts:23-24` — `LOGIC_EDGE_TYPES` constant and `LogicEdgeType` type. Logic edges are ONLY between events.
  - `src/memory/types.ts:20-21` — `PRIVATE_EVENT_CATEGORIES` — the valid set is `speech|action|observation|state_change`. "thought" is listed in the type but rejected at runtime validation.
  - `src/memory/cognition/cognition-repo.ts` — `upsertAssertion()` method shows how `preContestedStance` is used when stance is `contested`.
  - `src/runtime/rp-turn-contract.ts` — Assertion stance type with all 7 values and basis type with 5 values. These define the legal value sets.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Valid mini story passes validation
    Tool: Bash (bun test)
    Steps:
      1. bun test test/scenario-engine/dsl/story-validation.test.ts --filter "valid story"
    Expected Result: Test passes
    Evidence: .sisyphus/evidence/task-3-valid-story.txt

  Scenario: Invalid episode category "thought" is rejected
    Tool: Bash (bun test)
    Steps:
      1. bun test test/scenario-engine/dsl/story-validation.test.ts --filter "thought"
    Expected Result: Test passes, validation error message contains "thought" and "invalid category"
    Evidence: .sisyphus/evidence/task-3-thought-rejected.txt

  Scenario: Illegal stance transition is caught
    Tool: Bash (bun test)
    Steps:
      1. bun test test/scenario-engine/dsl/story-validation.test.ts --filter "stance transition"
    Expected Result: Test passes, validation error identifies the illegal transition
    Evidence: .sisyphus/evidence/task-3-stance-transition.txt
  ```

  **Commit**: YES (groups with Tasks 1, 2, 5 in C1)
  - Message: `feat(scenario-engine): add Story DSL validation with constraint enforcement`
  - Files: `test/scenario-engine/dsl/story-validation.ts`, `test/scenario-engine/dsl/story-validation.test.ts`

- [x] 4. Investigate settlement pipeline conversion path

  **What to do**:
  - **This is a RESEARCH task, not implementation.** The goal is to trace the exact code path from `TurnSettlementPayload` → `ExplicitSettlementProcessor.process()` inputs and document the conversion logic.
  - Use `lsp_find_references` on `TurnSettlementPayload` to find all call sites
  - Use `lsp_find_references` on `ExplicitSettlementProcessor.process()` to find how it's invoked
  - Use `ast_grep_search` to find where `IngestionInput` and `CreatedState` are constructed
  - Trace the full path through the agent runtime: how does a `TurnSettlementPayload` arrive at the processor?
  - Document findings in `test/scenario-engine/docs/settlement-pipeline-discovery.md`:
    - Exact function call chain from turn outcome → processor
    - The conversion function(s) that transform TurnSettlementPayload into MemoryFlushRequest + IngestionInput + CreatedState
    - Whether this conversion can be extracted/reused or must be reimplemented
    - Alternative approach: can we bypass ExplicitSettlementProcessor entirely and call `ProjectionManager.commitSettlement()` + cognition repos directly?
    - Recommended approach for the scenario runner with code examples
  - Also determine: what `SettlementProjectionParams` looks like (used by ProjectionManager.commitSettlement) and how it differs from ExplicitSettlementProcessor's inputs
  - **Verify 1-beat-per-flush viability**: confirm that `runMigrate()` accepts arbitrary `rangeStart`/`rangeEnd` (i.e., a per-beat flush covering only 4-8 dialogue turns) without relying on `FLUSH_THRESHOLD` internal logic. If `runMigrate` hardcodes batch size assumptions, document the constraint and propose an alternative (e.g., calling lower-level methods directly).

  **Must NOT do**:
  - Do NOT implement anything — only research and document
  - Do NOT modify any source code

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
    - Reason: Requires tracing complex multi-file code paths through the agent runtime, understanding type transformations, and evaluating architectural alternatives. Needs deep reasoning about the settlement pipeline.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3, 5)
  - **Blocks**: Tasks 6, 7
  - **Blocked By**: None

  **References**:
  - `src/memory/task-agent.ts` — `MemoryTaskAgent` class. Contains `runMigrate()` method (around line 450), `MemoryIngestionPolicy.buildMigrateInput()`, `CALL_ONE_TOOLS` and `CALL_TWO_TOOLS` definitions. This is the LLM-based migration path.
  - `src/memory/explicit-settlement-processor.ts` — `ExplicitSettlementProcessor.process()` method. Takes `(flushRequest, ingest, created, tools, options)`. Understand EACH parameter type and where they come from.
  - `src/memory/projection/projection-manager.ts` — `ProjectionManager.commitSettlement()` and `SettlementProjectionParams`. This is the sync projection step that follows settlement processing.
  - `src/interaction/contracts.ts` — `TurnSettlementPayload` type definition. This is what the RP agent produces.
  - `src/runtime/rp-turn-contract.ts` — `RpTurnOutcomeSubmissionV5` and `PrivateCognitionCommitV4` types. These are the structured turn outcome types.
  - `src/memory/cognition/cognition-repo.ts` — Direct cognition write methods. Alternative path: bypass processor, call repos directly.
  - `src/memory/episode/episode-repo.ts` — Direct episode write methods.
  - `test/memory/memtask-pg-integration.test.ts` — Shows how existing tests construct the migration input. Check how `makeStubAgent()` works.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Discovery document is complete and actionable
    Tool: Bash (cat/read)
    Steps:
      1. Read test/scenario-engine/docs/settlement-pipeline-discovery.md
      2. Verify it contains: exact function call chain, parameter type transformations, reusability assessment, recommended approach with code examples
      3. Verify it answers: "Can we call ProjectionManager.commitSettlement() directly?"
    Expected Result: Document exists with all required sections, recommended approach is clear and implementable
    Evidence: .sisyphus/evidence/task-4-discovery-complete.txt

  Scenario: Code path references are verified
    Tool: Bash (grep)
    Steps:
      1. For each file path cited in the discovery doc, verify the file exists
      2. For each line number cited, verify the referenced code matches
    Expected Result: All references are accurate and verifiable
    Evidence: .sisyphus/evidence/task-4-references-verified.txt
  ```

  **Commit**: YES (C2)
  - Message: `docs(scenario-engine): document settlement pipeline conversion path`
  - Files: `test/scenario-engine/docs/settlement-pipeline-discovery.md`

- [x] 5. Mini sample story (~12 beats, domain concept coverage)

  **What to do**:
  - Create `test/scenario-engine/stories/mini-sample.ts` — a compact story designed for TWO purposes:
    1. **Smoke testing** generators and runner (small enough to debug quickly)
    2. **Domain concept coverage** (exercises every enum value so failures are diagnosable)
  - Structure:
    - 3-4 characters: a maid, a butler, a cook, optionally a guest
    - 2-3 locations: study, kitchen, cellar
    - 2 clue objects: a letter, a key
    - ~12 beats organized to exercise ALL domain concepts:
      - **Assertion stances (all 7)**: hypothetical → tentative → accepted → confirmed (trust ladder); tentative → contested (with preContestedStance) → rejected → abandoned (distrust path)
      - **Assertion bases (all 5)**: first_hand (maid sees), hearsay (cook reports), inference (maid deduces), introspection (maid reflects), belief (maid assumes)
      - **Cognition kinds (all 3)**: assertion (beliefs about butler), evaluation (trust dimensions per character), commitment (goals/plans/constraints)
      - **Episode categories (all 4)**: speech, action, observation, state_change
      - **Logic edge types (all 4)**: causal (event A caused B), temporal_prev/next (sequence), same_episode (concurrent events)
      - **Additional**: entity aliases ("Mrs. Chen" / "Housekeeper"), retraction ops, contested assertion with conflictFactors
    - 6-8 probes covering narrative_search, cognition_search, memory_read, memory_explore
    - Event relations between beats
  - Run `validateStory()` on the sample to verify it passes validation
  - Create a companion unit test `test/scenario-engine/stories/mini-sample-coverage.test.ts` that scans all beats and asserts every required enum value appears at least once

  **Must NOT do**:
  - Do NOT write dialogue — that's the generator's job
  - Do NOT aim for narrative depth — this story is diagnostic, not literary

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3, 4)
  - **Blocks**: Task 13 (smoke test)
  - **Blocked By**: Tasks 2, 3 (needs types and validation)

  **References**:
  - `test/scenario-engine/dsl/story-types.ts` — DSL types to instantiate (from Task 2).
  - `test/scenario-engine/dsl/story-validation.ts` — Validation to run against the sample (from Task 3).
  - `test/helpers/pg-long-rp-memory-scenario.ts:74-91` — `makeConversationHistory()` shows existing conversation content style. The mini story should have similar thematic content (manor intrigue, hidden keys, suspicion).
  - `scripts/rp-suspicion-test.ts` — TurnSpec structure for inspiration on phase/round organization.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Mini sample passes validation
    Tool: Bash (bun test)
    Steps:
      1. Import mini-sample.ts and call validateStory()
      2. Assert validation result has zero errors
    Expected Result: Validation passes with no errors
    Evidence: .sisyphus/evidence/task-5-validation-pass.txt

  Scenario: Mini sample covers all domain concept types
    Tool: Bash (bun test)
    Steps:
      1. bun test test/scenario-engine/stories/mini-sample-coverage.test.ts
      2. Assert all 7 assertion stances appear at least once across beats
      3. Assert all 5 assertion bases appear at least once
      4. Assert all 3 cognition kinds appear at least once
      5. Assert all 4 episode categories appear at least once
      6. Assert all 4 logic edge types appear at least once
      7. Assert at least one alias, one retraction, one contested assertion with preContestedStance
    Expected Result: Full domain concept coverage verified
    Evidence: .sisyphus/evidence/task-5-coverage-complete.txt
  ```

  **Commit**: YES (groups with Tasks 1, 2, 3 in C1)
  - Message: `feat(scenario-engine): add mini sample story for generator testing`
  - Files: `test/scenario-engine/stories/mini-sample.ts`

- [x] 6. Settlement payload generator + tests

  **What to do**:
  - Create `test/scenario-engine/generators/settlement-generator.ts`:
    - `generateSettlements(story: Story): GeneratedSettlement[]` — converts each story beat into the settlement pipeline input format identified in Task 4's discovery document
    - Each `GeneratedSettlement` contains all data needed to write memory through the chosen pipeline path (either `ProjectionManager.commitSettlement()` direct call or the full `ExplicitSettlementProcessor` path — depends on Task 4 findings)
    - Handle entity ID resolution: entities are created in order of first appearance, IDs captured and reused in subsequent settlements
    - Map DSL types to system types:
      - `AssertionSpec` → arguments for `CognitionRepository.upsertAssertion()` using pointer_keys
      - `EvaluationSpec` → arguments for `CognitionRepository.upsertEvaluation()`
      - `CommitmentSpec` → arguments for `CognitionRepository.upsertCommitment()`
      - `EpisodeSpec` → arguments for `EpisodeRepo.append()`
      - `LogicEdgeSpec` → arguments for `GraphMutableStoreRepo.createLogicEdge()` (event IDs resolved by beat-to-eventId mapping)
    - Generate unique `settlementId`, `cognitionKey`, `sourceLocalRef` per beat to avoid collisions
    - Handle assertion stance transitions: if beat N changes an assertion from "tentative" to "accepted", the generator must reuse the same `cognitionKey` from the earlier beat
    - Handle retraction ops: if a beat retracts a cognition key, generate the appropriate retraction entry
    - Handle `PublicationDeclaration` generation for world-visible events
  - Create `test/scenario-engine/generators/settlement-generator.test.ts`:
    - Test: mini sample story produces correct number of settlements
    - Test: entity creation order is correct (entities before references)
    - Test: assertion stance progression uses same cognitionKey
    - Test: retraction ops produce valid retract entries
    - Test: generated payloads would pass production validation (import and call relevant validators)

  **Must NOT do**:
  - Do NOT call the database — this is pure data transformation
  - Do NOT call any LLM — this is deterministic conversion

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
    - Reason: Most complex data transformation in the tool. Must handle entity ID lifecycle, stance transitions, cognition key tracking, and correct mapping to multiple repository APIs. Requires careful reasoning about ordering and state tracking.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 7, 8, 9, 10)
  - **Blocks**: Task 11
  - **Blocked By**: Tasks 2, 3, 4 (needs types, validation, pipeline discovery)

  **References**:
  - `test/scenario-engine/docs/settlement-pipeline-discovery.md` — Task 4 output. The recommended pipeline path determines what this generator produces.
  - `src/memory/cognition/cognition-repo.ts` — `upsertAssertion()`, `upsertEvaluation()`, `upsertCommitment()` parameter types. Map DSL specs to these exact argument shapes.
  - `src/memory/episode/episode-repo.ts` — `EpisodeAppendParams`. Map `EpisodeSpec` to this shape.
  - `src/storage/domain-repos/pg/graph-mutable-store-repo.ts` — `upsertEntity()`, `createLogicEdge()`, `createProjectedEvent()` methods. For entity creation and logic edge construction.
  - `src/memory/projection/projection-manager.ts` — `commitSettlement()` and `SettlementProjectionParams`. If the direct path is chosen, settlements must match this input type.
  - `src/memory/explicit-settlement-processor.ts` — If the processor path is chosen, understand what inputs it needs.
  - `src/memory/settlement-ledger.ts` — Settlement idempotency. Generated `settlementId`s must be unique per run.
  - `test/helpers/pg-long-rp-memory-scenario.ts:284-396` — `seedCognitionHistory()` shows how assertions/evaluations/commitments are created manually. The generator should produce equivalent data structures.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Mini story produces correct settlements
    Tool: Bash (bun test)
    Steps:
      1. bun test test/scenario-engine/generators/settlement-generator.test.ts
      2. Assert settlements generated match beat count (~12 for mini-sample)
      3. Assert entities are created before they're referenced in assertions
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-6-settlements-correct.txt

  Scenario: Assertion key tracking across beats
    Tool: Bash (bun test)
    Steps:
      1. Run test that creates beats with assertion stance progression (tentative → accepted)
      2. Assert both beats use the SAME cognitionKey
    Expected Result: Cognition key is reused for stance transitions
    Evidence: .sisyphus/evidence/task-6-key-tracking.txt
  ```

  **Commit**: YES (C3)
  - Message: `feat(scenario-engine): settlement payload generator with entity lifecycle`
  - Files: `test/scenario-engine/generators/settlement-generator.ts`, `test/scenario-engine/generators/settlement-generator.test.ts`

- [x] 7. Scripted MemoryTaskModelProvider from cached live results + tests

  **What to do**:
  - Create `test/scenario-engine/generators/scripted-provider.ts`:
    - `createScriptedProviderFromCache(cachedToolCalls: CachedToolCallLog): ScriptedMemoryTaskModelProvider` — creates a mock provider that REPLAYS tool call responses captured from a previous live run
    - **Key design change**: The scripted provider does NOT derive responses from Story DSL. It replays what a REAL LLM actually returned when processing the dialogue. This ensures the scripted baseline reflects real thinker behavior.
    - `CachedToolCallLog`: `{ beats: { beatId: string, flushCalls: { callPhase: "call_one" | "call_two", toolCalls: ToolCallResult[], messages: ChatMessage[] }[] }[] }`
    - **1 beat = 1 flush unit**: each beat's dialogue (4-8 turns) forms exactly one `MemoryFlushRequest`. We construct flush requests manually with `rangeStart`/`rangeEnd` covering exactly one beat's turns. This makes `beatId` the universal alignment key for cache, comparison, checkpoint, and reporting.
    - The provider implements `MemoryTaskModelProvider` interface: `{ chat(messages, tools): ToolCallResult[], embed(texts, purpose, modelId): Float32Array[] }`
    - For `chat()`: track invocation count, return cached `toolCalls` for the corresponding entry. If invocation count exceeds cache entries, throw clear error.
    - For `embed()`: delegate to the real embedding service (since we're running real GraphOrganizer anyway)
    - `createLiveCapturingProvider(realProvider: MemoryTaskModelProvider): { provider: MemoryTaskModelProvider, getLog(): CachedToolCallLog }` — wraps a real provider, intercepts `chat()` calls, captures tool call responses to a log. Used during live runs to populate the cache.
  - Create `test/scenario-engine/generators/scripted-provider.test.ts`:
    - Test: provider replays cached tool calls in correct order
    - Test: provider throws when invocations exceed cached entries
    - Test: capturing provider intercepts and records real LLM responses
    - Test: roundtrip: capture → serialize → deserialize → replay produces identical tool calls

  **Must NOT do**:
  - Do NOT derive scripted responses from Story DSL — they come from cached live run
  - Do NOT make embed() return fake vectors — use real embedding service
  - Do NOT hardcode tool schemas — import from `src/memory/task-agent.ts`

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
    - Reason: Requires understanding the MemoryTaskModelProvider contract, tool call schemas, and entity ID resolution. Moderate complexity but well-defined interface.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 6, 8, 9, 10)
  - **Blocks**: Task 11
  - **Blocked By**: Tasks 2, 4 (needs types and pipeline discovery)

  **References**:
  - `src/memory/task-agent.ts:119-123` — `MemoryTaskModelProvider` interface. The scripted provider MUST implement this exactly.
  - `src/memory/task-agent.ts:138-223` — `CALL_ONE_TOOLS` definitions. These are the 5 tool schemas (create_entity, create_episode_event, upsert_assertion, create_alias, create_logic_edge). Import these, do NOT redefine.
  - `src/memory/task-agent.ts:225-238` — `CALL_TWO_TOOLS` definition (update_index_block). Import this.
  - `src/memory/task-agent.ts:101-104` — `ToolCallResult` type: `{ name: string, arguments: Record<string, unknown> }`.
  - `test/core/agent-loop.test.ts:39-51` — `MockModelProvider` pattern. Shows how to implement a mock that returns pre-programmed responses indexed by invocation count.
  - `test/memory/memtask-pg-integration.test.ts` — Shows how existing tests construct scripted model provider responses for the memory pipeline.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Scripted provider replays cached tool calls correctly
    Tool: Bash (bun test)
    Steps:
      1. bun test test/scenario-engine/generators/scripted-provider.test.ts --filter "replay"
      2. Create a mock CachedToolCallLog with 3 entries
      3. Call chat() 3 times, assert each returns the cached tool calls for that index
    Expected Result: Tool calls replayed in exact order from cache
    Evidence: .sisyphus/evidence/task-7-replay-correct.txt

  Scenario: Capture-then-replay roundtrip produces identical results
    Tool: Bash (bun test)
    Steps:
      1. Create a capturing provider wrapping a mock real provider
      2. Call chat() 3 times through the capturing provider
      3. Serialize the captured log, deserialize it
      4. Create a scripted provider from the deserialized log
      5. Call chat() 3 times on the scripted provider
      6. Assert all responses are identical to the original
    Expected Result: Capture → serialize → deserialize → replay = identical
    Evidence: .sisyphus/evidence/task-7-roundtrip.txt
  ```

  **Commit**: YES (groups with Task 6 in C3)
  - Message: `feat(scenario-engine): scripted MemoryTaskModelProvider from cached live results`
  - Files: `test/scenario-engine/generators/scripted-provider.ts`, `test/scenario-engine/generators/scripted-provider.test.ts`

- [x] 8. LLM dialogue generator

  **What to do**:
  - Create `test/scenario-engine/generators/dialogue-generator.ts`:
    - `generateDialogue(story: Story, options?: DialogueGenOptions): Promise<GeneratedDialogue[]>` — uses real LLM to generate natural dialogue from story beats
    - Each `GeneratedDialogue` = `{ beatId: string, turns: DialogueTurn[] }` where `DialogueTurn` = `{ role: "user"|"assistant", content: string, timestamp: number }`
    - Each beat produces 4-8 dialogue turns using dialogue template categories:
      - Observation: character notices something
      - Probing: character asks pointed questions
      - Deflection/Denial: character deflects or lies
      - Suspicion: character expresses doubt
      - Time verification: character cross-references timeline
      - Motive inference: character speculates about motives
    - Build a system prompt that:
      - Describes the story world and characters
      - Provides the current beat's context (what happens, who's present, who's lying)
      - Instructs the LLM to generate natural dialogue that naturally surfaces the beat's information
      - Specifies the "user" role plays the human interactor and "assistant" plays the maid/RP character
    - Handle timestamps: each turn gets a timestamp spaced appropriately within the beat's time window
    - Return structured `GeneratedDialogue[]` that the cache layer can serialize

  **Must NOT do**:
  - Do NOT cache results — that's Task 9
  - Do NOT call any memory system APIs
  - Do NOT generate more than 8 turns per beat (keep it focused)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
    - Reason: Requires good LLM prompt engineering to generate natural dialogue that surfaces specific story information. Needs understanding of dialogue patterns and template categories.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 6, 7, 9, 10)
  - **Blocks**: Task 9
  - **Blocked By**: Task 2 (needs story types)

  **References**:
  - `test/scenario-engine/dsl/story-types.ts` — Story/StoryBeat/StoryCharacter types. The generator consumes these.
  - `src/memory/task-agent.ts:52-59` — `DialogueRecord` type: `{ role, content, timestamp, recordId?, recordIndex?, correlatedTurnId? }`. The generated dialogue should be convertible to this format.
  - `test/helpers/pg-long-rp-memory-scenario.ts:74-91` — `makeConversationHistory()` shows the dialogue content style used in existing tests. Generated dialogue should feel similar (manor intrigue, formal language).
  - `scripts/rp-suspicion-test.ts` — TurnSpec.sendGuide field shows how existing test describes what dialogue should contain per turn. Use similar guidance approach.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Dialogue generation produces correct structure
    Tool: Bash (bun run)
    Steps:
      1. Generate dialogue for mini sample story (~12 beats)
      2. Assert result has one GeneratedDialogue entry per beat
      3. Assert each entry has 4-8 turns
      4. Assert each turn has role ("user"|"assistant"), non-empty content, valid timestamp
    Expected Result: Structured dialogue output for all beats
    Evidence: .sisyphus/evidence/task-8-dialogue-structure.txt

  Scenario: Dialogue content reflects beat information
    Tool: Bash (bun run)
    Steps:
      1. Generate dialogue for beat about "butler hiding letter"
      2. Assert at least one turn content mentions "letter" or "hidden" or "study"
    Expected Result: Generated dialogue references beat's key elements
    Evidence: .sisyphus/evidence/task-8-dialogue-content.txt
  ```

  **Commit**: YES (C4)
  - Message: `feat(scenario-engine): LLM dialogue generator with beat-to-turn expansion`
  - Files: `test/scenario-engine/generators/dialogue-generator.ts`

- [x] 9. Scenario cache layer (dialogue + tool call responses) + tests

  **What to do**:
  - Create `test/scenario-engine/generators/scenario-cache.ts`:
    - **Dialogue cache** (from LLM dialogue generation):
      - `loadCachedDialogue(story: Story): GeneratedDialogue[] | null` — loads from `test/scenario-engine/cache/{story-id}-dialogue.json`
      - `saveCachedDialogue(story: Story, dialogue: GeneratedDialogue[]): void`
      - `generateOrLoadDialogue(story: Story, options?): Promise<GeneratedDialogue[]>` — orchestrator
    - **Tool call cache** (from live thinker run):
      - `loadCachedToolCalls(story: Story): CachedToolCallLog | null` — loads from `test/scenario-engine/cache/{story-id}-toolcalls.json`
      - `saveCachedToolCalls(story: Story, log: CachedToolCallLog): void`
      - These are populated by the runner during `writePath: "live"` runs (via the capturing provider from Task 7)
    - **Invalidation**: manual deletion of cache files. When dialogue cache is deleted, tool call cache should also be deleted (since tool calls are responses TO that dialogue). Provide `invalidateAllCaches(storyId)` helper.
    - Cache file format: JSON with metadata (story title, generation timestamp, model used) + payload
  - Create `test/scenario-engine/generators/scenario-cache.test.ts`:
    - Test: dialogue save → load roundtrip
    - Test: tool call save → load roundtrip
    - Test: missing cache returns null
    - Test: invalidateAllCaches removes both dialogue and tool call files

  **Must NOT do**:
  - Do NOT implement hash-based auto-invalidation (user decided manual invalidation)
  - Do NOT store cache in git (directory is gitignored from Task 1)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (but depends on Task 8 for types)
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 11
  - **Blocked By**: Task 8 (needs GeneratedDialogue type)

  **References**:
  - `test/scenario-engine/generators/dialogue-generator.ts` — `GeneratedDialogue` type from Task 8. The cache serializes/deserializes these.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Dialogue and tool call cache roundtrips
    Tool: Bash (bun test)
    Steps:
      1. bun test test/scenario-engine/generators/scenario-cache.test.ts
      2. Assert dialogue save → load produces identical GeneratedDialogue[]
      3. Assert tool call save → load produces identical CachedToolCallLog
    Expected Result: Both cache types preserve data through JSON serialization
    Evidence: .sisyphus/evidence/task-9-cache-roundtrip.txt

  Scenario: invalidateAllCaches removes both files
    Tool: Bash (bun test)
    Steps:
      1. Save both dialogue and tool call caches
      2. Call invalidateAllCaches(storyId)
      3. Assert both loadCachedDialogue and loadCachedToolCalls return null
    Expected Result: Both cache files deleted
    Evidence: .sisyphus/evidence/task-9-invalidate-all.txt
  ```

  **Commit**: YES (groups with Task 8 in C4)
  - Message: `feat(scenario-engine): dialogue JSON cache with manual invalidation`
  - Files: `test/scenario-engine/generators/dialogue-cache.ts`, `test/scenario-engine/generators/dialogue-cache.test.ts`

- [x] 10. Probe query types + matching logic + tests

  **What to do**:
  - Create `test/scenario-engine/probes/probe-types.ts`:
    - `ProbeDefinition`: extends `StoryProbe` with runtime fields (resolved viewer context, etc.)
    - `ProbeResult`: `{ probe: ProbeDefinition, hits: RetrievalHit[], matched: string[], missed: string[], unexpectedPresent: string[], score: number, passed: boolean }`
    - `RetrievalHit`: `{ content: string, score: number, source_ref: string, scope: string }`
    - `ScenarioProbeReport`: `{ storyTitle: string, totalProbes: number, passed: number, failed: number, probeResults: ProbeResult[], generatedAt: number }`
  - Create `test/scenario-engine/probes/probe-matcher.ts`:
    - `matchProbeResults(probe: ProbeDefinition, hits: RetrievalHit[], options?: MatchOptions): ProbeResult` — checks if expectedFragments appear in top-K hits (substring matching), checks expectedMissing are absent
    - Matching logic: for each `expectedFragment`, check if ANY of the top-K hits contain it as a substring (case-insensitive). Use `toContainEqual`-style fuzzy matching, NOT exact equality.
    - Score calculation: `matched.length / expectedFragments.length` (0.0 to 1.0)
    - Pass threshold depends on mode:
      - `deterministic` (writePath: settlement or scripted): `passed = score >= 1.0 && unexpectedPresent.length === 0` (strict — all fragments must match)
      - `live` (real LLM): `passed = score >= threshold` where `threshold` is configurable (default 0.7). Live mode accepts partial matches because the LLM may express concepts differently than the story DSL's exact strings.
    - `MatchOptions`: `{ mode: "deterministic" | "live", liveThreshold?: number }`
  - Create `test/scenario-engine/probes/probe-matcher.test.ts`:
    - Test: all fragments found → score 1.0, passed true
    - Test: partial match → score < 1.0, passed false
    - Test: unexpected content present → passed false even if score 1.0
    - Test: case-insensitive matching works
    - Test: top-K limit is respected (fragments beyond K are not checked)

  **Must NOT do**:
  - Do NOT create a custom query language
  - Do NOT call any retrieval APIs (that's Task 14)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 6, 7, 8, 9)
  - **Blocks**: Tasks 13, 14
  - **Blocked By**: Task 2 (needs StoryProbe type)

  **References**:
  - `test/scenario-engine/dsl/story-types.ts` — `StoryProbe` type: query, retrievalMethod, viewerPerspective, expectedFragments, expectedMissing, topK.
  - `src/memory/retrieval/retrieval-orchestrator.ts` — `TypedRetrievalResult` type. Probe results should map to this structure. Understand the `cognition`, `narrative`, `conflict_notes`, `episode` segments.
  - `src/memory/narrative/narrative-search.ts` — `NarrativeSearchService` result type. What narrative_search returns.
  - `src/memory/cognition/cognition-search.ts` — `CognitionSearchService` result type. What cognition_search returns.
  - `test/helpers/pg-long-rp-memory-scenario.ts:526-543` — `expectedNarrativeFragments`, `expectedCognitionFragments`, `expectedEpisodeFragments` — existing pattern for expected retrieval fragments. Follow this convention.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Full match produces passing result
    Tool: Bash (bun test)
    Steps:
      1. bun test test/scenario-engine/probes/probe-matcher.test.ts --filter "all fragments found"
    Expected Result: score = 1.0, passed = true
    Evidence: .sisyphus/evidence/task-10-full-match.txt

  Scenario: Partial match produces failing result
    Tool: Bash (bun test)
    Steps:
      1. Create probe expecting 3 fragments, hits contain only 2
      2. Assert score < 1.0 and passed = false
    Expected Result: Partial match correctly identified
    Evidence: .sisyphus/evidence/task-10-partial-match.txt
  ```

  **Commit**: YES (C5)
  - Message: `feat(scenario-engine): probe types and matching logic`
  - Files: `test/scenario-engine/probes/probe-types.ts`, `test/scenario-engine/probes/probe-matcher.ts`, `test/scenario-engine/probes/probe-matcher.test.ts`

- [x] 11a. Runner shared infra — PG bootstrap, entity creation, schema lifecycle

  **What to do**:
  - Create `test/scenario-engine/runner/infra.ts`:
    - `RunOptions` type:
      ```typescript
      type RunOptions = {
        writePath: "live" | "scripted" | "settlement";
        phase?: "full" | "resume" | "probe_only"; // default: "full"
        compareWithSettlement?: boolean;            // default: false
        keepSchema?: boolean;                       // default: true
      };
      ```
    - `bootstrapScenarioSchema(story, options): Promise<ScenarioInfra>` — shared setup:
      1. Schema naming: `scenario_{storyId}_{writePath}`
      2. If `phase: "probe_only"`: check schema exists, connect, return handle with `entityIdMap` loaded from DB. If missing, throw.
      3. If `phase: "resume"`: check schema exists AND checkpoint file exists. If both present, connect to existing schema, load checkpoint to know which beats are done. If either missing, throw with clear message.
      4. If `phase: "full"`: drop schema if exists, create fresh via `createPgTestDb({ embeddingDim })`. Bootstrap truth + ops + derived. `seedStandardPgEntities()`. Create all story entities via `GraphMutableStoreRepo.upsertEntity()`. Return `entityIdMap: Map<pointer_key, numeric_id>`.
    - `ScenarioInfra`: `{ sql, entityIdMap, schemaName, repos: { graphStore, interaction, episode, cognition, searchProjection, ... }, services: { retrieval, narrativeSearch, cognitionSearch, navigator, embedding } }`
    - `ScenarioHandle`: `{ infra: ScenarioInfra, runResult: ScenarioRunResult }` — returned by `runScenario()` in ALL phases. For `phase: "probe_only"`, `runResult` has `beatsProcessed: 0` and `phase: "probe_only"`. The `infra` field provides the sql/services/entityIdMap that probe executor needs.
    - `cleanupSchema(storyId, writePath?)` — drop specific schema, or all schemas for a story if writePath omitted
    - `cleanupAllSchemas()` — drop all `scenario_*` schemas (convenience for full reset)
    - `ScenarioRunResult`: `{ entityIdMap, settlementCount, projectionStats, errors, elapsedMs, schemaName, writePath, phase }`
  - Create `test/scenario-engine/runner/index.ts` — barrel export for all runner modules

  **Must NOT do**:
  - Do NOT implement writePath execution logic (Task 11b)
  - Do NOT implement orchestration wiring (Task 11c)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (after Wave 2)
  - **Parallel Group**: Wave 3
  - **Blocks**: Tasks 11b, 11c
  - **Blocked By**: Task 6 (needs settlement generator types for ScenarioInfra)

  **References**:
  - `test/helpers/pg-app-test-utils.ts` — `createPgTestDb()`, `seedStandardPgEntities()`, schema bootstrap. Copy pattern exactly.
  - `test/helpers/pg-test-utils.ts` — `skipPgTests` guard, `createTestPg()`.
  - `src/storage/domain-repos/pg/graph-mutable-store-repo.ts` — `upsertEntity()` for entity creation.

  **Acceptance Criteria**:
  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Schema bootstrap and entity creation
    Tool: Bash (bun test, requires PG_TEST_URL)
    Steps:
      1. Call bootstrapScenarioSchema(miniSample, { writePath: "settlement", phase: "full" })
      2. Assert entityIdMap contains all story entities with numeric IDs
      3. Assert schema scenario_{id}_settlement exists in PG
    Expected Result: Schema created, entities seeded, entityIdMap populated
    Evidence: .sisyphus/evidence/task-11a-bootstrap.txt

  Scenario: Probe-only detects missing schema
    Tool: Bash (bun test, requires PG_TEST_URL)
    Steps:
      1. Call bootstrapScenarioSchema(story, { writePath: "scripted", phase: "probe_only" }) with no prior run
      2. Assert throws with message containing "not found"
    Expected Result: Clear error for missing schema
    Evidence: .sisyphus/evidence/task-11a-probe-only-missing.txt

  Scenario: cleanupAllSchemas removes all scenario schemas
    Tool: Bash (bun test, requires PG_TEST_URL)
    Steps:
      1. Create 2 schemas (settlement + scripted)
      2. Call cleanupAllSchemas()
      3. Assert both schemas gone
    Expected Result: All scenario_ schemas removed
    Evidence: .sisyphus/evidence/task-11a-cleanup-all.txt
  ```

  **Commit**: YES (C6)
  - Message: `feat(scenario-engine): runner shared infrastructure — PG bootstrap and schema lifecycle`
  - Files: `test/scenario-engine/runner/infra.ts`, `test/scenario-engine/runner/index.ts`

- [x] 11b. Runner writePath execution — live/scripted/settlement + checkpoint

  **What to do**:
  - Create `test/scenario-engine/runner/write-paths.ts`:
    - **Core design: 1 beat = 1 flush unit.** We do NOT use FLUSH_THRESHOLD. Each beat's dialogue (4-8 turns) is exactly one `MemoryFlushRequest` with `rangeStart`/`rangeEnd` covering that beat's turns only. This makes `beatId` the universal alignment key for cache, comparison, checkpoint, and reporting.
    - `executeLivePath(infra, story, dialogue): Promise<WritePathResult>`:
      1. Construct REAL `MemoryTaskModelProvider` from project config
      2. Wrap with `createLiveCapturingProvider()` (Task 7)
      3. For each beat: construct `MemoryFlushRequest` covering exactly that beat's dialogue turns → call `MemoryTaskAgent.runMigrate()` with capturing provider
      4. **Checkpoint**: after each beat, append to `cache/{storyId}-checkpoint.json` (completed beatIds + captured tool calls so far). On error, checkpoint preserves progress.
      5. After all beats: save full `CachedToolCallLog` via `saveCachedToolCalls()`, delete checkpoint file
    - `executeScriptedPath(infra, story, dialogue): Promise<WritePathResult>`:
      1. Load `CachedToolCallLog`. If missing, throw.
      2. Construct `ScriptedMemoryTaskModelProvider` via `createScriptedProviderFromCache(cache)`
      3. Same per-beat loop as live, but with scripted provider (deterministic)
    - `executeSettlementPath(infra, story): Promise<WritePathResult>`:
      1. Generate settlements via `generateSettlements(story)` (Task 6)
      2. For each beat: execute pipeline path from Task 4's discovery doc
    - `WritePathResult`: `{ beatsProcessed: number, errors: { beatId: string, error: Error }[], capturedToolCallLog? }`
    - Error handling: if beat N fails, capture `{ beatId, error }`, continue to N+1.

  **Must NOT do**:
  - Do NOT implement PG bootstrap (Task 11a)
  - Do NOT implement orchestration wiring (Task 11c)
  - Do NOT retry failed batches (capture error, move on)

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
    - Reason: Three distinct execution paths with different provider construction, batch management, checkpoint/resume logic, and error collection. Requires deep understanding of MemoryTaskAgent.runMigrate and MemoryFlushRequest construction.

  **Parallelization**:
  - **Can Run In Parallel**: NO (after 11a)
  - **Blocks**: Task 11c
  - **Blocked By**: Tasks 7, 9, 11a

  **References**:
  - `src/memory/task-agent.ts:450+` — `runMigrate()` method. Both live and scripted paths call this.
  - `src/interaction/flush-selector.ts` — Reference for `MemoryFlushRequest` shape. Note: we do NOT use FLUSH_THRESHOLD; we construct per-beat flush requests manually.
  - `test/scenario-engine/docs/settlement-pipeline-discovery.md` — Task 4 output for settlement path.
  - `test/scenario-engine/generators/scripted-provider.ts` — `createScriptedProviderFromCache()`, `createLiveCapturingProvider()` from Task 7.
  - `test/scenario-engine/generators/scenario-cache.ts` — `loadCachedToolCalls()`, `saveCachedToolCalls()` from Task 9.

  **Acceptance Criteria**:
  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Settlement path produces memory state
    Tool: Bash (bun test, requires PG_TEST_URL)
    Steps:
      1. Bootstrap infra, call executeSettlementPath(infra, miniSample)
      2. Assert WritePathResult.errors is empty
      3. Query private_cognition_current, assert rows exist
    Expected Result: Settlement writes produce expected DB state
    Evidence: .sisyphus/evidence/task-11b-settlement-path.txt

  Scenario: Live path checkpoint/resume after failure
    Tool: Bash (bun test, requires PG_TEST_URL + LLM API)
    Steps:
      1. Start executeLivePath, simulate failure after beat 3 of 12
      2. Assert checkpoint file exists with completedBeatIds = [beat1, beat2, beat3]
      3. Assert DB schema still exists (NOT dropped — checkpoint only works with existing schema)
      4. Call executeLivePath with resumeFromCheckpoint: true — assert it skips beats 1-3, resumes from beat 4
      5. Assert final CachedToolCallLog contains all 12 beats
    Expected Result: Checkpoint + existing schema enable resume without re-processing
    Evidence: .sisyphus/evidence/task-11b-checkpoint-resume.txt
  ```

  **Commit**: YES (C6)
  - Message: `feat(scenario-engine): runner writePath execution with live/scripted/settlement branches`
  - Files: `test/scenario-engine/runner/write-paths.ts`

- [x] 11c. Runner orchestration — dialogue loading, interaction seeding, wiring

  **What to do**:
  - Create `test/scenario-engine/runner/orchestrator.ts`:
    - `runScenario(story: Story, options?: RunOptions): Promise<ScenarioHandle>` — top-level entry point that wires 11a + 11b. Always returns `ScenarioHandle { infra, runResult }`:
      1. Call `bootstrapScenarioSchema(story, options)` → infra
      2. If `phase: "probe_only"`: return `{ infra, runResult: { beatsProcessed: 0, phase: "probe_only", ... } }` (no writes)
      3. If `phase: "resume"`: load checkpoint, pass to writePath executor with `resumeFromBeatId`
      3. Load dialogue via `generateOrLoadDialogue(story)`
      4. Seed interaction history: write dialogue turns into `InteractionRepo.commit()`
      5. Dispatch to `executeLivePath` / `executeScriptedPath` / `executeSettlementPath` based on `options.writePath`
      6. If `compareWithSettlement: true` AND writePath is not "settlement": also run `executeSettlementPath` in a SEPARATE schema (`scenario_{storyId}_settlement`)
      7. Return `ScenarioRunResult` with combined stats
    - Re-export `RunOptions`, `ScenarioRunResult` from `infra.ts`

  **Must NOT do**:
  - Do NOT duplicate infra or writePath logic — import from 11a and 11b

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (after 11b)
  - **Blocks**: Tasks 12, 13, 14
  - **Blocked By**: Tasks 11a, 11b

  **References**:
  - `test/scenario-engine/runner/infra.ts` — From Task 11a.
  - `test/scenario-engine/runner/write-paths.ts` — From Task 11b.
  - `test/scenario-engine/generators/scenario-cache.ts` — `generateOrLoadDialogue()` from Task 9.
  - `src/storage/domain-repos/pg/interaction-repo.ts` — `PgInteractionRepo.commit()` for interaction seeding.

  **Acceptance Criteria**:
  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Full orchestration completes mini story
    Tool: Bash (bun test, requires PG_TEST_URL)
    Steps:
      1. runScenario(miniSample, { writePath: "settlement", phase: "full" })
      2. Assert ScenarioRunResult.errors is empty
      3. Assert settlementCount matches beat count
      4. Assert search_docs_cognition has rows
    Expected Result: Full pipeline wiring works end-to-end
    Evidence: .sisyphus/evidence/task-11c-orchestration.txt

  Scenario: compareWithSettlement creates both schemas
    Tool: Bash (bun test, requires PG_TEST_URL)
    Steps:
      1. runScenario(miniSample, { writePath: "scripted", compareWithSettlement: true })
      2. Assert schema scenario_{id}_scripted exists
      3. Assert schema scenario_{id}_settlement exists
    Expected Result: Both schemas populated for comparison
    Evidence: .sisyphus/evidence/task-11c-compare-both.txt
  ```

  **Commit**: YES (C6)
  - Message: `feat(scenario-engine): runner orchestrator wiring infra + write-paths`
  - Files: `test/scenario-engine/runner/orchestrator.ts`

- [x] 12. GraphOrganizer integration

  **What to do**:
  - Extend the scenario runner to call real `GraphOrganizer` after all settlements are processed:
    - Create `test/scenario-engine/runner/graph-organizer-step.ts`:
      - `runGraphOrganizer(sql, entityIdMap, story, embeddingService): Promise<GraphOrganizerStepResult>` — calls `GraphOrganizer.run(job)` for each batch of changed node refs
      - Construct `GraphOrganizerJob` with correct `agentId`, `sessionId`, `batchId`, `changedNodeRefs`, `embeddingModelId`
      - The `changedNodeRefs` should include all node refs created during settlement processing (from `CreatedState` or collected during runner execution)
      - Use the REAL embedding service (not mocked) since user chose real GraphOrganizer
      - Wait for each job to complete before proceeding (sequential, not queued)
    - Configure embedding service:
      - Read embedding model config from environment / project config
      - Ensure `embeddingDim` in schema bootstrap matches model output dimension
    - After GraphOrganizer completes:
      - `node_embeddings` table should have vectors for all created nodes
      - `semantic_edges` table should have similarity edges
      - `node_scores` table should have salience/centrality/bridge scores
      - `search_docs_*` tables should be fully synced

  **Must NOT do**:
  - Do NOT mock embeddings — use real embedding service
  - Do NOT parallelize GraphOrganizer jobs (sequential is fine for local-only tool)
  - Do NOT add multi-model support (one model, configured once)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (after Task 11)
  - **Blocks**: Task 13
  - **Blocked By**: Task 11

  **References**:
  - `src/memory/graph-organizer.ts` — `GraphOrganizer` class. `run(job: GraphOrganizerJob)` method. Understand constructor dependencies and what `run()` does.
  - `src/memory/task-agent.ts:69-75` — `GraphOrganizerJob` type: `{ agentId, sessionId, batchId, changedNodeRefs, embeddingModelId }`.
  - `src/memory/embeddings.ts` — `EmbeddingService`. How to construct one with real embedding provider.
  - `src/memory/organize-enqueue.ts` — `enqueueOrganizerJobs()`. Shows how the production system creates GraphOrganizerJobs. May be able to reuse this.
  - `test/memory/embeddings-async.test.ts` — Existing embedding test. Check if it uses real or mocked embeddings, and follow the same setup pattern.

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: GraphOrganizer populates embedding tables
    Tool: Bash (bun test, requires PG_TEST_URL + embedding API)
    Preconditions: PG_TEST_URL set, embedding API available
    Steps:
      1. Run scenario with mini sample story (~12 beats)
      2. After settlements, run GraphOrganizer step
      3. Query node_embeddings table, assert rows exist for created nodes
      4. Query node_scores table, assert salience scores exist
    Expected Result: Embedding and scoring tables populated for all created nodes
    Evidence: .sisyphus/evidence/task-12-embeddings-populated.txt

  Scenario: memory_explore works after GraphOrganizer
    Tool: Bash (bun test, requires PG_TEST_URL + embedding API)
    Steps:
      1. Complete full pipeline (settlements + GraphOrganizer) for mini story
      2. Call GraphNavigator.explore() with a "why" query about the story
      3. Assert result contains evidence paths (not empty)
    Expected Result: Beam search returns evidence paths using semantic edges
    Evidence: .sisyphus/evidence/task-12-explore-works.txt
  ```

  **Commit**: YES (groups with Task 11 in C6)
  - Message: `feat(scenario-engine): GraphOrganizer integration with real embeddings`
  - Files: `test/scenario-engine/runner/graph-organizer-step.ts`

- [x] 13. Smoke test — mini-sample end-to-end

  **What to do**:
  - Create `test/scenario-engine/smoke.test.ts`:
    - Full end-to-end integration test using mini sample story (~12 beats, domain coverage)
    - Test both writePaths: `"scripted"` (deterministic baseline from cached live) and `"settlement"` (DSL reference answer)
    - Pipeline: load mini story → load cached dialogue + tool calls → run scenario → run GraphOrganizer → run probes → verify results
    - Assertions:
      - All ~12 beats processed without errors
      - Entity count in DB matches mini-sample story definition
      - private_cognition_current has expected entries
      - search_docs_cognition has searchable content
      - narrative_search returns hits for story content
      - cognition_search returns hits for assertion content
      - memory_explore returns evidence paths
      - All mini-sample probes pass
    - Use `describe.skipIf(skipPgTests)` guard

  **Must NOT do**:
  - Do NOT test the full 100+ turn story (that's Task 17)
  - Do NOT test report generation (that's Task 15)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (after Tasks 11, 12)
  - **Blocks**: Task 17
  - **Blocked By**: Tasks 5, 10, 12

  **References**:
  - `test/scenario-engine/stories/mini-sample.ts` — Mini sample story from Task 5.
  - `test/scenario-engine/runner/orchestrator.ts` — `runScenario()` from Task 11c.
  - `test/scenario-engine/runner/infra.ts` — `ScenarioHandle` from Task 11a.
  - `test/scenario-engine/runner/graph-organizer-step.ts` — GraphOrganizer from Task 12.
  - `test/scenario-engine/probes/probe-matcher.ts` — `matchProbeResults()` from Task 10.
  - `test/helpers/pg-app-test-utils.ts` — `skipPgTests` guard.

  **Acceptance Criteria**:
  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Smoke test passes with writePath "scripted"
    Tool: Bash (bun test, requires PG_TEST_URL + embedding API)
    Preconditions: Tool call cache exists for mini-sample
    Steps:
      1. PG_TEST_URL=<url> bun test test/scenario-engine/smoke.test.ts --filter "scripted"
      2. Assert ScenarioHandle.runResult.beatsProcessed === ~12
      3. Assert ScenarioHandle.runResult.errors is empty
      4. Assert all mini-sample probes pass
    Expected Result: Scripted baseline produces correct memory state on mini-sample
    Evidence: .sisyphus/evidence/task-13-smoke-scripted.txt

  Scenario: Smoke test passes with writePath "settlement"
    Tool: Bash (bun test, requires PG_TEST_URL + embedding API)
    Steps:
      1. PG_TEST_URL=<url> bun test test/scenario-engine/smoke.test.ts --filter "settlement"
      2. Assert all beats processed via DSL→pipeline path
    Expected Result: Settlement reference answer works on mini-sample
    Evidence: .sisyphus/evidence/task-13-smoke-settlement.txt
  ```

  **Commit**: YES (groups with Tasks 11, 12 in C6)
  - Message: `test(scenario-engine): mini-sample end-to-end smoke test`
  - Files: `test/scenario-engine/smoke.test.ts`

- [x] 14. Probe query executor

  **What to do**:
  - Create `test/scenario-engine/probes/probe-executor.ts`:
    - `executeProbes(story: Story, handle: ScenarioHandle): Promise<ProbeResult[]>` — runs all story probes against the populated database. Extracts `sql`, `entityIdMap`, and `services` from `handle.infra`.
    - For each probe, based on `retrievalMethod`:
      - `narrative_search`: Call `handle.infra.services.narrativeSearch.searchNarrative()` with probe query and viewer context
      - `cognition_search`: Call `handle.infra.services.cognitionSearch.searchCognition()` with probe query and viewer context
      - `memory_read`: Call `handle.infra.services.retrieval.readByEntity()` with probe's target pointer_key
      - `memory_explore`: Call `handle.infra.services.navigator.explore()` with probe query, mode, and viewer context
    - ViewerContext construction: resolve probe's `viewerPerspective` (pointer_key) to a `ViewerContext` using `handle.infra.entityIdMap` for `viewer_agent_id` and story's location context for `current_area_id`
    - Pass results through `matchProbeResults()` from Task 10, using `mode: "deterministic"` for scripted/settlement and `mode: "live"` for live writePath
    - Return all `ProbeResult[]` for reporting

  **Must NOT do**:
  - Do NOT generate reports (that's Task 15)
  - Do NOT invent new retrieval methods — use existing service interfaces only

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (parallel with Task 13 after Task 11c)
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 15
  - **Blocked By**: Tasks 10, 11c

  **References**:
  - `src/memory/retrieval.ts` — `RetrievalService`. `searchVisibleNarrative()`, `readByEntity()`.
  - `src/memory/narrative/narrative-search.ts` — `NarrativeSearchService.searchNarrative()`.
  - `src/memory/cognition/cognition-search.ts` — `CognitionSearchService.searchCognition()`.
  - `src/memory/navigator.ts` — `GraphNavigator.explore()` for memory_explore probes.
  - `src/memory/types.ts:1-4` — `ViewerContext`: `{ viewer_agent_id, viewer_role, session_id, current_area_id }`.
  - `test/scenario-engine/runner/infra.ts` — `ScenarioHandle`, `ScenarioInfra` from Task 11a.
  - `test/scenario-engine/probes/probe-matcher.ts` — `matchProbeResults()` from Task 10.

  **Acceptance Criteria**:
  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Probe executor runs all probe types
    Tool: Bash (bun test, requires PG_TEST_URL)
    Preconditions: Scenario already run with mini story (DB populated)
    Steps:
      1. Execute probes for mini story: executeProbes(miniSample, handle)
      2. Assert ProbeResult[] length matches mini-sample probe count
      3. Assert each entry has non-empty hits array
    Expected Result: All probe types executed and returned results
    Evidence: .sisyphus/evidence/task-14-all-probes-run.txt

  Scenario: Probe results contain expected fragments
    Tool: Bash (bun test, requires PG_TEST_URL)
    Steps:
      1. Execute probes for mini story
      2. Assert narrative_search probe result.passed === true
      3. Assert cognition_search probe result.passed === true
    Expected Result: Expected fragments found in retrieval results
    Evidence: .sisyphus/evidence/task-14-fragments-found.txt
  ```

  **Commit**: YES (C7)
  - Message: `feat(scenario-engine): probe query executor using existing retrieval APIs`
  - Files: `test/scenario-engine/probes/probe-executor.ts`

- [x] 15. Probe assertions + report generator + comparison alignment

  **What to do**:
  - Create `test/scenario-engine/probes/report-generator.ts`:
    - `generateReport(probeResults: ProbeResult[], runResult: ScenarioRunResult): string` — primary report (markdown):
      ```markdown
      # Scenario Report: {story title}
      WritePath: {live | scripted | settlement}
      Duration: {elapsed}ms
      ## Summary
      - Beats: {N} processed, {M} errors
      - Probes: {passed}/{total} passed (threshold: {1.0 | 0.7})
      ## Per-Beat Memory Write Summary
      | Beat ID | Entities | Episodes | Assertions | Evaluations | Errors |
      ## Probe Results
      ### ✅ narrative_search: "silver key hidden" — Score: 1.0
      ### ❌ cognition_search: "butler denies" — Score: 0.5, Missed: [...]
      ```
    - **Semantic alignment layer** (for comparison reports):
      - `alignProbeResults(scriptedResults, settlementResults, story): AlignedComparison[]` — matches across schemas using `(probe.query, probe.viewerPerspective)` as join key, compares hit content via substring similarity
      - `alignCognitionState(scriptedInfra, settlementInfra, story): CognitionAlignment[]` — queries `private_cognition_current` in both schemas, aligns by `(pointer_key_pair, predicate)` for assertions and `(pointer_key, dimension_name)` for evaluations. Reports entries in settlement-only as "gaps" and scripted-only as "surprises"
    - `generateComparisonReport(aligned: AlignedComparison[], cognitionAlignment: CognitionAlignment[], story): string`:
      ```markdown
      ## Scripted (Thinker Actual) vs Settlement (DSL Expected)
      ### Probe Score Comparison
      | Probe | Scripted | Settlement | Delta |
      ### Cognition Alignment (by pointer_key + predicate)
      | Beat | Pointer Key Pair | Predicate | Settlement? | Scripted? |
      ## Extraction Gaps / Surprises
      ```
    - **Report hierarchy**:
      - **Primary regression**: `{storyId}-scripted-report.md` — daily check
      - **Comparison diagnostic**: `{storyId}-comparison-report.md` — occasional extraction quality analysis
      - **Live diagnostic**: `{storyId}-live-report.md` — only when refreshing baseline
    - `saveReport(content: string, storyId: string, suffix: string): void`
  - Create `test/scenario-engine/probes/probe-assertions.ts`:
    - `assertAllProbesPass(results: ProbeResult[]): void` — throws with detailed diff if any probe fails
    - Error message includes: probe query, expected fragments, actual top-K hits, matched/missed

  **Must NOT do**:
  - Do NOT create web UI / HTML reports
  - Do NOT compare by DB-internal IDs (entity_id, cognition_key) — always align by pointer_key + predicate

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4
  - **Blocks**: Task 17
  - **Blocked By**: Task 14

  **References**:
  - `test/scenario-engine/probes/probe-types.ts` — `ProbeResult`, `ScenarioProbeReport` from Task 10.
  - `test/scenario-engine/runner/infra.ts` — `ScenarioRunResult`, `ScenarioHandle`, `ScenarioInfra` from Task 11a. `ScenarioInfra.repos.cognition` needed for cognition alignment queries.
  - `src/memory/cognition/cognition-search.ts` — For querying private_cognition_current in alignment.
  - `src/memory/types.ts` — `NodeRef`, `CanonicalNodeRefKind` for interpreting cognition entries.

  **Acceptance Criteria**:
  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Report generator produces readable markdown
    Tool: Bash
    Steps:
      1. Generate report from mini story probe results + run result
      2. Assert output contains "## Summary", "## Probe Results", "## Per-Beat Memory Write Summary"
      3. Assert passing probes show ✅, failing probes show ❌
    Expected Result: Well-structured markdown with all sections
    Evidence: .sisyphus/evidence/task-15-report-format.txt

  Scenario: Comparison alignment matches by pointer_key not DB ID
    Tool: Bash (bun test)
    Steps:
      1. Create mock scriptedResults and settlementResults with different entity_ids but same pointer_keys
      2. Call alignCognitionState()
      3. Assert alignment correctly pairs entries by (pointer_key, predicate)
    Expected Result: Alignment ignores DB IDs, uses semantic keys
    Evidence: .sisyphus/evidence/task-15-alignment.txt

  Scenario: assertAllProbesPass throws on failure with diagnostic info
    Tool: Bash (bun test)
    Steps:
      1. Call assertAllProbesPass with results containing one failed probe
      2. Assert thrown error message includes probe query and missed fragments
    Expected Result: Clear error identifying which probe failed and why
    Evidence: .sisyphus/evidence/task-15-assertion-throws.txt
  ```

  **Commit**: YES (C7)
  - Message: `feat(scenario-engine): probe assertions, report generator, comparison alignment`
  - Files: `test/scenario-engine/probes/report-generator.ts`, `test/scenario-engine/probes/probe-assertions.ts`

- [x] 16a. Manor intrigue — story outline + characters

  **What to do**:
  - Create `test/scenario-engine/stories/manor-intrigue.ts` with the story SKELETON:
    - **Characters (8+)**: Head maid (protagonist), Butler Oswin, Maid Mira, Cook Henrik, Gardener Elara, Guest Lord Ashworth, Housekeeper Mrs. Chen, Stable boy Finn — each with surface motives, hidden commitments, initial evaluations, aliases
    - **Locations (5+)**: Greenhouse, Archive annex, Courtyard, Kitchen, Guest quarters, Cellar
    - **Clue objects**: Silver key, Ledger, Wax-sealed letter, Broken clock, Door latch
    - **Plot outline** (phases only, NO beats yet): Phase A-F
    - **Main causal chain**: Ashworth → Oswin → Silver key theft → Ledger tampering → Elara (witness) → Head maid
    - **Red herrings (3+)**: Mira's ledger behavior, Henrik's meetings, Broken clock
    - Beats/probes arrays: EMPTY — filled in 16b/16c

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (parallel with Task 15)
  - **Blocks**: Task 16b
  - **Blocked By**: Tasks 2, 3

  **References**:
  - `test/scenario-engine/dsl/story-types.ts` — DSL types.
  - `test/helpers/pg-long-rp-memory-scenario.ts` — Existing narrative universe.
  - `docs/RP_SUSPICION_COOPERATION_TEST.zh-CN.md` — Multi-phase structure precedent.

  **Acceptance Criteria**:
  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Story outline compiles and has correct structure
    Tool: Bash (bun run)
    Steps:
      1. Import manor-intrigue.ts, assert characters.length >= 8, locations.length >= 5
      2. Assert each character has pointer_key, hiddenCommitments, aliases
    Expected Result: Skeleton is well-formed
    Evidence: .sisyphus/evidence/task-16a-outline.txt
  ```

  **Commit**: YES (C8)
  - Message: `feat(scenario-engine): manor intrigue story outline — characters, locations, causal chain`
  - Files: `test/scenario-engine/stories/manor-intrigue.ts`

- [x] 16b. Manor intrigue — per-phase beats + memory effects

  **What to do**:
  - Fill in the `beats` array (25-30 beats across 6 phases A-F)
  - Each beat has complete `memoryEffects` (episodes, assertions, evaluations, commitments, logic edges)
  - Retrieval challenges embedded: timeline conflicts, red herring noise, long-distance causality (20+ beat gap)
  - Event relations: causal/temporal/same_episode links between beats
  - Run `validateStory()` after each phase for incremental verification

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Blocks**: Task 16c
  - **Blocked By**: Task 16a

  **References**:
  - `test/scenario-engine/stories/manor-intrigue.ts` — Skeleton from 16a.
  - `test/scenario-engine/dsl/story-validation.ts` — Incremental validation.
  - `src/runtime/rp-turn-contract.ts` — Cognition types for memory effects.

  **Acceptance Criteria**:
  **QA Scenarios (MANDATORY):**
  ```
  Scenario: All beats pass validation and form causal chain
    Tool: Bash (bun run)
    Steps:
      1. validateStory() passes with zero errors
      2. Assert beats.length >= 25
      3. Verify main causal chain: path from Phase A beat to Phase E beat via "causal" eventRelations
    Expected Result: Beats valid, causal chain connected
    Evidence: .sisyphus/evidence/task-16b-beats-valid.txt
  ```

  **Commit**: YES (C8)
  - Message: `feat(scenario-engine): manor intrigue — 25+ beats with memory effects`
  - Files: `test/scenario-engine/stories/manor-intrigue.ts`

- [x] 16c. Manor intrigue — probes + event relations + validation

  **What to do**:
  - Fill in `probes` array (15-20 probes): narrative_search, cognition_search, memory_read, memory_explore; multi-viewer probes; negative probes (red herrings should NOT dominate top-K)
  - Run `validateStory()` on completed story
  - Estimate dialogue turns: beats × 4-8 ≥ 100

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Blocks**: Task 17
  - **Blocked By**: Task 16b

  **Acceptance Criteria**:
  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Story complete with probes and scale
    Tool: Bash (bun run)
    Steps:
      1. validateStory() passes, probes.length >= 15
      2. Probes cover all 4 retrieval methods, >= 2 viewer perspectives
      3. Estimated dialogue turns >= 100
    Expected Result: Story meets completeness and scale requirements
    Evidence: .sisyphus/evidence/task-16c-complete.txt
  ```

  **Commit**: YES (C8)
  - Message: `feat(scenario-engine): manor intrigue — probes, event relations, final validation`
  - Files: `test/scenario-engine/stories/manor-intrigue.ts`

- [x] 17. Full scenario end-to-end test

  **What to do**:
  - Create `test/scenario-engine/scenarios/manor-intrigue.test.ts`:
    - Full e2e test of the 100+ turn manor intrigue story
    - Primary baseline: `writePath: "scripted"` (replaying cached live results)
    - **First-ever run bootstrap** (separate script): `writePath: "live"` generates both dialogue and tool call caches. **Two-phase LLM cost**: first LLM call generates dialogue (Task 8), second LLM call lets thinker process dialogue (Task 11b live path). For 25-30 beats × ~6 turns each, expect ~150-240 LLM calls total across both phases. Document expected latency (10-30 min) and cost.
    - Test structure uses `ScenarioHandle`:
      ```typescript
      describe.skipIf(skipPgTests)("Manor Intrigue Full Scenario", () => {
        let handle: ScenarioHandle;
        let probeResults: ProbeResult[];
        beforeAll(async () => {
          handle = await runScenario(manorIntrigueStory, {
            writePath: "scripted", phase: "full", compareWithSettlement: true,
          });
          probeResults = await executeProbes(manorIntrigueStory, handle);
          await saveReport(generateReport(probeResults, handle.runResult), "manor-intrigue", "scripted");
        }, 30 * 60 * 1000);
        it("all beats processed without errors", () => { expect(handle.runResult.errors).toHaveLength(0); });
        it("all probes pass", () => { assertAllProbesPass(probeResults); });
        it("reports generated", () => { /* check file existence */ });
      });
      ```
    - Use `describe.skipIf(skipPgTests)` guard, 30 min timeout

  **Must NOT do**:
  - Do NOT run in CI
  - Do NOT set tight timeout

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 15, 16c

  **References**:
  - `test/scenario-engine/stories/manor-intrigue.ts` — Full story from Tasks 16a-16c.
  - `test/scenario-engine/runner/orchestrator.ts` — `runScenario()` from Task 11c.
  - `test/scenario-engine/runner/infra.ts` — `ScenarioHandle` from Task 11a.
  - `test/scenario-engine/probes/probe-executor.ts` — `executeProbes(story, handle)` from Task 14.
  - `test/scenario-engine/probes/probe-assertions.ts` — `assertAllProbesPass()` from Task 15.
  - `test/scenario-engine/probes/report-generator.ts` — Report generator from Task 15.

  **Acceptance Criteria**:
  **QA Scenarios (MANDATORY):**
  ```
  Scenario: Full 100+ turn scenario completes (scripted baseline)
    Tool: Bash (bun test, requires PG_TEST_URL + embedding API)
    Preconditions: Tool call cache exists (from prior live run)
    Steps:
      1. PG_TEST_URL=<url> bun test test/scenario-engine/scenarios/manor-intrigue.test.ts --timeout 1800000
      2. Assert exit code 0
    Expected Result: Scripted baseline produces deterministic memory state
    Evidence: .sisyphus/evidence/task-17-full-scenario-pass.txt

  Scenario: All probes pass on scripted baseline
    Tool: Bash (bun test)
    Steps:
      1. Assert no probe results have passed === false
    Expected Result: Expected fragments found in retrieval results
    Evidence: .sisyphus/evidence/task-17-probes-pass.txt

  Scenario: Probe-only re-run in seconds
    Tool: Bash (bun test, requires PG_TEST_URL)
    Preconditions: Prior run with keepSchema (default true)
    Steps:
      1. runScenario(story, { writePath: "scripted", phase: "probe_only" })
      2. executeProbes → assert identical results
      3. Assert elapsed < 30s
    Expected Result: Instant re-test against populated schema
    Evidence: .sisyphus/evidence/task-17-probe-only.txt

  Scenario: Comparison report generated
    Tool: Bash (bun test, requires PG_TEST_URL)
    Steps:
      1. Assert reports/manor-intrigue-comparison-report.md exists
      2. Assert contains "Cognition Alignment" section
    Expected Result: Scripted vs settlement diff report readable
    Evidence: .sisyphus/evidence/task-17-comparison.txt
  ```

  **Commit**: YES (C9)
  - Message: `test(scenario-engine): full manor intrigue end-to-end scenario test`
  - Files: `test/scenario-engine/scenarios/manor-intrigue.test.ts`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` + `bun test test/scenario-engine/`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp).
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state. Run the full 100+ turn scenario end-to-end. Execute EVERY QA scenario from EVERY task. Verify probe report is generated, readable, and contains expected sections. Test re-run with cache deletion. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Full Run [PASS/FAIL] | Report [PASS/FAIL] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Detect cross-task contamination. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | VERDICT`

---

## Commit Strategy

| Phase | Commit | Content | Gate |
|-------|--------|---------|------|
| Foundation | C1 | Scaffolding + DSL types + validation + mini-sample (~12 beats) | `bun test test/scenario-engine/dsl/` passes |
| Investigation | C2 | Settlement pipeline discovery doc | Document complete with code path traced |
| Generators | C3 | Settlement generator + scripted provider (from cached live) | `bun test test/scenario-engine/generators/` passes |
| Generators | C4 | Dialogue generator + scenario cache layer | Cache write/read roundtrip passes |
| Generators | C5 | Probe types + matching logic | `bun test test/scenario-engine/probes/` passes |
| Runner | C6 | Runner infra (11a) + writePaths (11b) + orchestrator (11c) + GraphOrganizer + smoke test | Mini-sample smoke test passes e2e |
| Probes | C7 | Probe executor + assertions + report + comparison alignment | Smoke test probes pass, report generated |
| Story | C8 | Manor intrigue outline (16a) + beats (16b) + probes (16c) | Validation passes, scale requirements met |
| Integration | C9 | Full e2e test + baseline report | Full pipeline completes, all probes pass |

---

## Success Criteria

### Verification Commands
```bash
bun test test/scenario-engine/dsl/        # DSL validation tests pass
bun test test/scenario-engine/generators/  # Generator tests pass
bun test test/scenario-engine/probes/      # Probe matching tests pass
bun test test/scenario-engine/             # ALL scenario-engine tests pass
```

### Final Checklist
- [ ] All "Must Have" present — DSL types import domain enums, validation catches illegal states, settlement generator produces valid payloads, probes use existing retrieval APIs
- [ ] All "Must NOT Have" absent — no custom domain abstractions, no custom query language, no web UI, no CI integration, no inter-story dependencies
- [ ] All tests pass — `bun test test/scenario-engine/` exit code 0
- [ ] Domain concept coverage — mini-sample exercises all 7 stances, all 5 bases, all 3 cognition kinds, all 4 episode categories, all 4 logic edge types
- [ ] Retrieval scale coverage — manor-intrigue tests timeline conflicts, red herring resistance, multi-viewer perspectives, long-distance causal chains
- [ ] Report generated — `test/scenario-engine/reports/` contains readable markdown with probe results
- [ ] Re-run works — delete cache, re-run, new report generated with consistent probe results
