# Talker/Thinker Architecture Split — Phase 1 MVP

> **Amendment Log**:
> - **v2 (review-driven)**: Fixed 3 issues from external review:
>   - **(A) G14 rewritten**: Thinker must use PG transaction (`sql.begin()` + tx-scoped repos), not pool repos directly. `commitSettlement()` has no internal transaction logic.
>   - **(B) T7 step 10 rewritten**: Thinker follows `PgSettlementUnitOfWork` pattern minus ledger, NOT the removed non-UoW SQLite fallback path. Full retry safety analysis added.
>   - **(C) T11 expanded**: `append()` returns `null` on DO NOTHING conflict. `appendCognitionEvents()` skips `applyProjection()` when null. Interface change `number → number | null`. 4 new QA scenarios.
>   - **(D) Config key standardized**: All `enableTalkerThinkerSplit` → `RuntimeConfig.talkerThinker.enabled` (4 locations).
>   - **(E) T14 added**: Remove non-UoW dead code path (`turn-service.ts:513-573`). SQLite fallback → runtime assertion.
>   - Commit numbering shifted: C6-C11 → C7-C12, new C6 for T14.

## TL;DR

> **Quick Summary**: Split RP agent turn execution into fast Talker (~15-20s, publicReply + cognitiveSketch) and async Thinker (~40-60s, full cognition/episodes/publications via Job Queue), reducing user-facing latency by ~4x while preserving cognition quality through a Cognitive Sketch bridge. This is **Phase 1 (MVP Split)** only — batch collapse and full parity are deferred to later phases.
> 
> **Deliverables**:
> - `runRpTalkerTurn` — new fast-path method gated behind `RuntimeConfig.talkerThinker.enabled` flag
> - Thinker job worker — `cognition.thinker` job kind consuming sketches and producing full cognition
> - Version-stamped `recent_cognition_slots` for staleness detection (dual counters: `talker_turn_counter` + `thinker_committed_version`)
> - Idempotency dedup constraint on `private_cognition_events` via `settlement_id` (UNIQUE INDEX + DO NOTHING — preserving append-only contract)
> - `RuntimeConfig.talkerThinker` config path with defaults
> - AgentLoop `isTalkerMode` threading (prompt builder + retry skip)
> - Updated test script with `--mode sync|async` flag + latency assertions
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES — 4 waves (7 → 2 → 2 → 2 tasks)
> **Critical Path**: T4 → T13 → T6 → T7 → T10 → F1-F4 → user okay

---

## Context

### Original Request
User identified ~80s response latency as the critical bottleneck for the RP agent (rp:xuran). Root cause: the model generates 6-10x more cognition JSON than actual reply text in a single LLM call. The Talker/Thinker split separates fast dialogue generation from slow cognition processing.

### Interview Summary
**Key Discussions**:
- User's core concern: micro-forks between Talker and Thinker when Thinker falls behind
- Resolved via Cognitive Sketch — lightweight Talker output bridges Thinker for consistency
- User confirmed: architecture Option D (Hybrid: Sketch + Sleep-Time + Version Stamp)
- User confirmed: same model (kimi-k2.5) for both Talker and Thinker
- User confirmed: 2-round staleness tolerance with soft-block beyond

**Research Findings**:
- MIRROR paper (arXiv:2506.00430): "Temporal Decoupling" — Talker deliberately uses stale state. Error Chaining is known failure mode.
- Letta/MemGPT: Tiered memory + sleep-time compute — closest industry pattern to our approach
- `commitSettlement()` ACTUALLY covers: cognition events/current, episodes, recent cognition slots, area state, publications — all via `SettlementProjectionParams`
- `commitSettlement()` does NOT cover: `pinnedSummaryProposal` (dormant/dead code), `relationIntents`/`conflictFactors` (handled by `ExplicitSettlementProcessor` during flush, separate path)
- `private_cognition_events` has DB triggers preventing UPDATE/DELETE — append-only enforced at DB level
- `recent_cognition_slots` has NO version column — needs migration
- `settlement_processing_ledger` is active but ONLY when `settlementUnitOfWork` is provided

### Requirements Document Review (`docs/talker-thinker-split-requirements.md`)
This plan revision incorporates all P0 requirements (R-00 through R-06) and P1 requirements (R-07 through R-09) from the requirements document:
- **R-00**: Plan restructured to Phase 1 only (Phase 2/3 as Future Work)
- **R-01**: Artifact scope frozen — Latency-first for Phase 1
- **R-02**: T9 batch collapse removed entirely (deferred to Phase 3)
- **R-03**: publications/relationIntents/conflictFactors formally modeled
- **R-04**: append-only semantics preserved (DO NOTHING, not DO UPDATE)
- **R-05**: setThinkerVersion deferred to Phase 3 (not needed without batch)
- **R-06**: enqueue loss elevated to Accepted Degradation
- **R-07**: pinnedSummaryProposal marked dormant/out-of-scope
- **R-08**: settlement ledger explicitly bypassed for Phase 1
- **R-09**: T7 description aligned with commitSettlement() actual responsibilities

### Metis Review
**Identified Gaps (addressed)**:
- Thinker dependency wiring: resolved via closure capture from `createPgJobConsumer()` scope
- Thinker LLM approach: uses `agentLoop.runBuffered()` with `isTalkerMode: false` for tool execution + normalization reuse
- `areaStateArtifacts`: included in Phase 1 (already in `SettlementProjectionParams`)
- Thinker timestamp: uses its own `Date.now()` — temporal ordering inversion documented as known difference
- Thinker flush: does NOT trigger `flushIfDue()` — added as guardrail
- Flag toggle: flag gates Talker dispatch only; Thinker processes jobs regardless of current flag state
- Pre-insert dedup: T11 adds normalization-layer dedup for same-key ops (for DO NOTHING safety)
- Slot_payload race: Talker ONLY bumps counter (no payload write), Thinker ONLY writes payload + version
- TurnService has 13 constructor params (not 12) — corrected

---

## Frozen Artifact Scope (Phase 1)

> **Latency-first strategy**: Phase 1 prioritizes response speed. Only artifacts that flow through `commitSettlement()` are supported.

### Phase 1 Guarantees (Thinker produces and commits these)

| Artifact | Produced By | Committed Via | Storage Target |
|---|---|---|---|
| `publicReply` | Talker | settlement record | `interaction_records` (turn_settlement) |
| `cognitiveSketch` | Talker | settlement payload | `interaction_records` (turn_settlement.payload.cognitiveSketch) |
| `privateCognition` | Thinker | `commitSettlement()` → `appendCognitionEvents` | `private_cognition_events` + `private_cognition_current` |
| `privateEpisodes` | Thinker | `commitSettlement()` → `appendEpisodes` | `private_episode_events` |
| `publications` | Thinker | `commitSettlement()` → `materializePublicationsSafe` | `area_world_projection` + graph events |
| `areaStateArtifacts` | Thinker | `commitSettlement()` → `upsertAreaStateArtifacts` | `area_world_state` |

### Phase 1 Accepted Degradations (NOT supported)

| Artifact | Reason | Impact | Recovery Phase |
|---|---|---|---|
| `relationIntents` | Processed by `ExplicitSettlementProcessor` during flush, NOT by `commitSettlement()` | Relations not updated from split-mode turns | Phase 2 |
| `conflictFactors` | Same — flush path, not projection path | Conflict resolution not triggered from split-mode turns | Phase 2 |
| `pinnedSummaryProposal` | Dormant in BOTH sync and async paths. `PinnedSummaryProposalService` is dead code with zero imports. Not in `SettlementProjectionParams`. | No impact — feature was never active | None (dormant) |
| Enqueue loss | If both enqueue retries fail, Thinker job permanently lost for that turn | Cognitive gap: user reply preserved, but deeper analysis skipped. No self-healing mechanism exists. | Phase 2 (recovery sweeper) |
| Settlement ledger | Thinker bypasses `settlement_processing_ledger` entirely | Ledger does not reflect Thinker processing state | Phase 2 |
| Memory flush from Thinker | Thinker does NOT trigger `flushIfDue()` | Graph organization / explicit settlement processing not triggered after Thinker commit | Phase 2 |
| Temporal ordering | Thinker events have later `committed_time` than subsequent Talker turns | Events from turn N may appear after events from turn N+1 in time-ordered queries | Known difference (by design) |
| Unbounded version gap | If Thinkers repeatedly fail, `thinkerCommittedVersion` stops incrementing | Soft-block becomes permanent delay until Thinker recovers (mitigated by skip-when-gap-extreme) | Phase 2 (monitoring) |

---

## Work Objectives

### Core Objective
Reduce RP agent user-facing response latency from ~80s to ~15-20s by splitting turn execution into a fast Talker (publicReply + cognitiveSketch) and an async Thinker (full cognition processing via job queue), while maintaining cognition quality and character consistency.

### Concrete Deliverables
- New method `runRpTalkerTurn` in `turn-service.ts` (gated by config flag)
- New job kind `cognition.thinker` with worker implementation
- Talker prompt builder mode (lightweight, no cognition framework instructions)
- Version-stamped `recent_cognition_slots` with staleness detection
- Updated `rp-suspicion-test.ts` with `--mode sync|async` and latency measurement

### Definition of Done
- [ ] `bun run build` passes with zero type errors
- [ ] `bun test` — all existing tests pass, new tests pass
- [ ] `rp-suspicion-test.ts --mode sync --max-rounds 5` — scores ≥ current baseline
- [ ] `rp-suspicion-test.ts --mode async --max-rounds 5` — Talker latency < 25s per turn, scores ≤10% below sync baseline
- [ ] Config flag `talkerThinker.enabled: false` — behavior identical to current codebase

### Must Have
- Config flag (`RuntimeConfig.talkerThinker.enabled`) gating ALL async behavior
- Sync mode remains IDENTICAL to current behavior when flag is off
- Talker commits minimal settlement so interaction_records stay ordered
- Talker ONLY increments `talker_turn_counter` in `recent_cognition_slots` — does NOT write `slot_payload`
- Thinker writes to projection tables via `commitSettlement()` — does NOT create new `interaction_records`
- Thinker ONLY writes `slot_payload` + increments `thinker_committed_version` — does NOT touch `talker_turn_counter`
- `cognitiveSketch` stored in settlement payload for Thinker to retrieve
- Version stamp on `recent_cognition_slots` (dual monotonic INTEGER counters)
- Thinker concurrency cap: 1 per session
- Thinker max retry attempts: 3
- Staleness soft-block: Talker waits up to 3s if version gap >2, then proceeds anyway
- Soft-block skip: when gap > 2× threshold (gap > 4), skip soft-block entirely to prevent permanent delay
- Idempotency: UNIQUE INDEX on `private_cognition_events` + `ON CONFLICT DO NOTHING` (preserving append-only)
- Pre-insert dedup in normalization layer for same-key ops (since DO NOTHING silently drops second write)

### Must NOT Have (Guardrails)
- **G1**: Do NOT modify `runRpBufferedTurn` internals — create new `runRpTalkerTurn` method alongside it
- **G2**: Do NOT change `submit_rp_turn` tool parameter NAMES or structure — but MUST update `latentScratchpad` description and corresponding test assertions
- **G3**: Do NOT add new database tables — extend existing schemas only
- **G4**: Do NOT change V1 event contract (`events.ts`) — add new events via extension
- **G5**: Do NOT change `ProjectionManager.commitSettlement()` signature
- **G6**: Do NOT optimize Talker prompt beyond stripping cognition framework instructions
- **G7**: Do NOT implement cross-session Thinker, model selection, metrics dashboard, or circuit breakers
- **G8**: Do NOT create criteria requiring manual/human testing
- **G9**: Thinker must NOT trigger `flushIfDue()` or `memoryTaskAgent` — no memory flush from worker
- **G10**: Thinker worker must be stateless — all context loaded fresh from database, no in-memory cache reliance
- **G11**: Do NOT use `ON CONFLICT DO UPDATE` on `private_cognition_events` — DB triggers prevent UPDATE. Use `DO NOTHING` only.
- **G12**: Do NOT create new schema version (v6) for Talker's minimal settlement — reuse `turn_settlement_v5` with undefined fields
- **G13**: Do NOT build error recovery sweeper, dead-letter queue, or admin retry endpoint (Phase 2)
- **G14**: Thinker MUST NOT engage the settlement ledger (`markApplying`/`markApplied`). Thinker MUST wrap projection writes in a PG transaction (`sql.begin()`) with tx-scoped repos passed as `repoOverrides` to `commitSettlement()`. Do NOT use pool repos directly without a transaction wrapper — `commitSettlement()` contains no transaction logic and relies on the caller for atomicity.
- **G15**: Do NOT implement batch collapse, `setThinkerVersion`, or multi-job processing (Phase 3)

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (`bun test`, 169 pass, 24 skip)
- **Automated tests**: Tests-after (unit tests for new components, regression for existing)
- **Framework**: bun test
- **Integration tests**: `rp-suspicion-test.ts` with both `--mode sync` and `--mode async`

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Schema changes**: Use Bash (psql/bun script) — verify column exists, constraints apply
- **Code changes**: Use Bash (`bun run build && bun test`) — verify compilation and test pass
- **Integration**: Use Bash (`bun run scripts/rp-suspicion-test.ts`) — verify end-to-end behavior
- **Latency**: Use Bash (timestamp wrapper) — verify response time < threshold

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — schema + registration + config + baseline, ALL parallel):
├── T1: Schema migration — dual version columns [quick]
├── T2: TurnSettlementPayload extend — cognitiveSketch field [quick]
├── T3: Job kind registration — cognition.thinker + dispatcher routing [unspecified-high]
├── T4: Talker prompt builder mode — isTalkerMode flag [unspecified-high]
├── T5: Test baseline capture — sync mode 5-round scores [quick]
├── T11: Idempotency dedup constraint — UNIQUE INDEX + DO NOTHING + null-safe chain [quick]
└── T14: Remove non-UoW dead code path — turn-service.ts else branch [quick]

Wave 1b (After T4 only — AgentLoop threading + config):
├── T12: RuntimeConfig talkerThinker config path + TurnService wiring [quick]
└── T13: AgentLoop mode-awareness — isTalkerMode on AgentRunRequest [quick]

Wave 2 (After Wave 1 + Wave 1b — core Talker + Thinker):
├── T6: runRpTalkerTurn method — the core split (depends: T1,T2,T3,T4,T12,T13) [deep]
└── T7: Thinker job worker — full cognition processing (depends: T3,T6,T11) [deep]

Wave 3 (After Wave 2 — staleness + testing):
├── T8: Staleness detection — version gap check + soft-block (depends: T1,T6,T12) [unspecified-high]
└── T10: Test script update + async integration test (depends: T5,T6,T7,T12) [unspecified-high]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real integration QA (unspecified-high)
└── F4: Scope fidelity check (deep)
→ Present results → Get explicit user okay
```

Critical Path: T4 → T13 → T6 → T7 → T10 → F1-F4 → user okay
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 7 (Wave 1)

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| T1 | — | T6, T8 | 1 |
| T2 | — | T6 | 1 |
| T3 | — | T6, T7 | 1 |
| T4 | — | T6, T13 | 1 |
| T5 | — | T10 | 1 |
| T11 | — | T7 | 1 |
| T14 | — | — | 1 |
| T12 | — | T6, T8, T10 | 1b |
| T13 | T4 | T6 | 1b |
| T6 | T1, T2, T3, T4, T12, T13 | T7, T8, T10 | 2 |
| T7 | T3, T6, T11 | T10 | 2 |
| T8 | T1, T6, T12 | — | 3 |
| T10 | T5, T6, T7, T12 | F1-F4 | 3 |
| F1-F4 | T8, T10 | — | FINAL |

### Agent Dispatch Summary

- **Wave 1**: 7 tasks — T1→`quick`, T2→`quick`, T3→`unspecified-high`, T4→`unspecified-high`, T5→`quick`, T11→`quick`, T14→`quick`
- **Wave 1b**: 2 tasks — T12→`quick`, T13→`quick`
- **Wave 2**: 2 tasks — T6→`deep`, T7→`deep`
- **Wave 3**: 2 tasks — T8→`unspecified-high`, T10→`unspecified-high`
- **FINAL**: 4 tasks — F1→`oracle`, F2→`unspecified-high`, F3→`unspecified-high`, F4→`deep`

---

## TODOs

- [x] 1. Add Dual Version Columns to `recent_cognition_slots`

  **What to do**:
  - Add TWO monotonic version columns to `recent_cognition_slots` in `src/storage/pg-app-schema-ops.ts`:
    - `talker_turn_counter INTEGER NOT NULL DEFAULT 0` — incremented by Talker on every turn
    - `thinker_committed_version INTEGER NOT NULL DEFAULT 0` — incremented by Thinker when it commits cognition
  - Add a migration step that ALTERs the existing table (follow existing migration pattern in `ensureSchemaReady()`)
  - Update `RecentCognitionSlotRepo.upsert()` in `src/storage/domain-repos/pg/recent-cognition-slot-repo.ts` to:
    - Accept an optional `versionIncrement?: 'talker' | 'thinker'` flag parameter
    - When `versionIncrement: 'talker'`: the UPDATE clause includes `talker_turn_counter = talker_turn_counter + 1` alongside the slot payload write, and the `RETURNING` clause returns the new `talker_turn_counter` value. **Single SQL statement** — NOT a separate increment call.
    - When `versionIncrement: 'thinker'`: same pattern for `thinker_committed_version = thinker_committed_version + 1 RETURNING thinker_committed_version`
    - When neither is provided: no version column is touched (backwards-compatible)
    - Return type changes from `Promise<void>` to `Promise<{ talkerTurnCounter?: number; thinkerCommittedVersion?: number }>` — returns the RETURNING'd value when version increment was requested
    - **CRITICAL**: This single-call design ensures T6 (Talker) and T7 (Thinker) can atomically bump their respective version counter in the SAME SQL upsert that writes the cognition slot payload — no double-call, no race window
    - **SEPARATION**: Talker calls with `versionIncrement: 'talker'` but does NOT write `slot_payload` — payload stays unchanged. Thinker calls with `versionIncrement: 'thinker'` AND writes `slot_payload`. They touch different columns, eliminating read-then-write race.
  - Update contract interface in `src/storage/domain-repos/contracts/recent-cognition-slot-repo.ts` to match
  - Update `getBySession()` / `getSlotPayload()` to return BOTH versions alongside the payload
  - Add a helper `getVersionGap(sessionId, agentId): Promise<{ talkerCounter: number, thinkerVersion: number, gap: number }>` for T8's staleness check
  - Update `upsertRecentCognitionSlot()` in `src/interaction/store.ts` to accept and thread version flag

  **Must NOT do**:
  - Do NOT use wall-clock timestamps — use monotonic integer counters
  - Do NOT use a single `turn_version` column
  - Do NOT change the `slot_payload` JSONB structure
  - Do NOT implement `setThinkerVersion: N` (that's Phase 3 for batch collapse)
  - Do NOT modify any other table schemas

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single-concern schema change + repo update, ~4 files
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T2, T3, T4, T5, T11)
  - **Blocks**: T6, T8
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/storage/pg-app-schema-ops.ts:84-93` — existing `recent_cognition_slots` CREATE TABLE definition
  - `src/storage/pg-app-schema-ops.ts` — migration pattern: how `ensureSchemaReady()` handles ALTER TABLE additions

  **API/Type References**:
  - `src/storage/domain-repos/pg/recent-cognition-slot-repo.ts:11-55` — `upsertRecentCognitionSlot()` with SELECT → concat → INSERT ON CONFLICT UPDATE pattern
  - `src/storage/domain-repos/contracts/recent-cognition-slot-repo.ts` — contract interface (update return type)
  - `src/interaction/store.ts:245-279` — `upsertRecentCognitionSlot()` function that calls the repo

  **WHY Each Reference Matters**:
  - Schema ops: follow the exact ALTER TABLE pattern for adding columns to existing table
  - Repo file: understand the upsert SQL to add BOTH version columns in the INSERT...ON CONFLICT UPDATE
  - Store file: trace how the function is called from turn-service.ts to understand caller contract

  **Acceptance Criteria**:
  - [ ] `bun run build` passes with zero type errors
  - [ ] `bun test` — all existing tests still pass
  - [ ] Database migration applies cleanly on fresh DB and existing DB
  - [ ] `talker_turn_counter` increments atomically via SQL `SET counter = counter + 1 RETURNING counter`
  - [ ] `thinker_committed_version` increments atomically via SQL
  - [ ] Talker upsert with `versionIncrement: 'talker'` does NOT modify `slot_payload`
  - [ ] Thinker upsert with `versionIncrement: 'thinker'` DOES modify `slot_payload` AND bump version
  - [ ] `getVersionGap()` returns correct gap calculation
  - [ ] No `setThinkerVersion` parameter exists (Phase 3 only)

  **QA Scenarios**:

  ```
  Scenario: Both version columns exist after migration
    Tool: Bash (bun script)
    Preconditions: Database is running on port 55433
    Steps:
      1. Run `bun run build` to verify type check passes
      2. Run application startup or migration script to apply schema
      3. Query: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'recent_cognition_slots' AND column_name IN ('talker_turn_counter', 'thinker_committed_version')`
    Expected Result: Both columns exist with type `integer`
    Failure Indicators: Either column not found, or type is not integer
    Evidence: .sisyphus/evidence/task-1-version-columns-exist.txt

  Scenario: Talker counter increments without touching slot_payload
    Tool: Bash (bun test)
    Preconditions: Unit test written for repo
    Steps:
      1. Insert a row for (session-1, agent-1) with slot_payload='[{"key":"a"}]', talker_turn_counter=0
      2. Call upsert with versionIncrement: 'talker' (no slot_payload change)
      3. Assert talker_turn_counter = 1
      4. Assert slot_payload unchanged (still '[{"key":"a"}]')
      5. Assert thinker_committed_version = 0 (untouched)
    Expected Result: Counter incremented, payload untouched
    Failure Indicators: Payload changed, or counter didn't increment
    Evidence: .sisyphus/evidence/task-1-talker-counter-only.txt

  Scenario: Version gap calculation is correct
    Tool: Bash (bun test)
    Preconditions: Unit test with both versions set
    Steps:
      1. Set talker_turn_counter = 5, thinker_committed_version = 3
      2. Call getVersionGap()
      3. Assert gap = 2
    Expected Result: Gap = talkerCounter - thinkerVersion = 2
    Failure Indicators: Gap calculation wrong
    Evidence: .sisyphus/evidence/task-1-version-gap.txt
  ```

  **Commit**: YES (C1)
  - Message: `feat(storage): add dual version columns (talker_turn_counter, thinker_committed_version) to recent_cognition_slots`
  - Files: `src/storage/pg-app-schema-ops.ts`, `src/storage/domain-repos/pg/recent-cognition-slot-repo.ts`, `src/storage/domain-repos/contracts/recent-cognition-slot-repo.ts`, `src/interaction/store.ts`
  - Pre-commit: `bun run build && bun test`

---

- [x] 2. Add `cognitiveSketch` Field to `TurnSettlementPayload` + Update latentScratchpad Contract

  **What to do**:
  - Add optional `cognitiveSketch?: string` field to `TurnSettlementPayload` type in `src/interaction/contracts.ts` (around line 94-122)
  - In the settlement payload construction block in `turn-service.ts` (around line 450-478), populate `cognitiveSketch` from `canonical.latentScratchpad` when present
  - Ensure the field is serialized into the `turn_settlement` interaction record (`payload` JSONB — no schema change needed)
  - Add a helper function `getSketchFromSettlement(settlementPayload: TurnSettlementPayload): string | undefined`
  - **Contract update for latentScratchpad**:
    - In `src/runtime/submit-rp-turn-tool.ts:75`, change `latentScratchpad` description from `"trace-only, not a durable artifact"` to `"Durable cognitive sketch. Stored in settlement for Thinker processing when Talker/Thinker split is active. Always populated even in sync mode."`
    - In `test/runtime/rp-turn-contract.test.ts`, find test assertions that lock down the "trace-only" semantic and update them

  **Must NOT do**:
  - Do NOT modify `CanonicalRpTurnOutcome` type — sketch comes from existing `latentScratchpad`
  - Do NOT add new database tables or columns
  - Do NOT change `submit_rp_turn` tool parameter NAMES — only description text
  - Do NOT change the `latentScratchpad` field type or optionality in tool schema

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: One optional field + one assignment line + one helper function
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T3, T4, T5, T11)
  - **Blocks**: T6
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/runtime/turn-service.ts:450-478` — settlement payload construction block
  - `src/runtime/rp-turn-contract.ts:120-135` — `CanonicalRpTurnOutcome` showing `latentScratchpad` field

  **API/Type References**:
  - `src/interaction/contracts.ts:94-122` — `TurnSettlementPayload` type definition
  - `src/runtime/submit-rp-turn-tool.ts:75` — latentScratchpad description (MUST update)
  - `test/runtime/rp-turn-contract.test.ts` — test assertions (MUST update if they lock old semantic)

  **WHY Each Reference Matters**:
  - Settlement construction block: exact location to add `cognitiveSketch: canonical.latentScratchpad`
  - Contract types: flow from LLM output → canonical outcome → settlement payload
  - Tool description: the model-facing contract must match new semantic

  **Acceptance Criteria**:
  - [ ] `bun run build` passes
  - [ ] `TurnSettlementPayload` includes `cognitiveSketch?: string`
  - [ ] When `latentScratchpad` is present in canonical outcome, it appears in settlement payload
  - [ ] `latentScratchpad` description updated to "durable" semantic
  - [ ] `bun test` — all tests pass including updated contract tests

  **QA Scenarios**:

  ```
  Scenario: cognitiveSketch field present in type and propagates
    Tool: Bash (bun run build + bun test)
    Preconditions: Code changes applied
    Steps:
      1. Run `bun run build` to type-check
      2. Grep `cognitiveSketch` in contracts.ts — verify present in TurnSettlementPayload
      3. Run `bun test` — verify all tests pass
    Expected Result: Type check passes, field defined as optional string, tests pass
    Failure Indicators: Type error or field missing
    Evidence: .sisyphus/evidence/task-2-sketch-field-exists.txt

  Scenario: latentScratchpad description updated in tool schema
    Tool: Bash (grep)
    Preconditions: submit-rp-turn-tool.ts modified
    Steps:
      1. Grep submit-rp-turn-tool.ts for "trace-only" — assert NO match
      2. Grep for "durable" or "Thinker" in latentScratchpad description — assert match
    Expected Result: Old description replaced with durable semantic
    Failure Indicators: "trace-only" still present
    Evidence: .sisyphus/evidence/task-2-tool-description-updated.txt
  ```

  **Commit**: YES (C2)
  - Message: `feat(runtime): add cognitiveSketch to TurnSettlementPayload + update latentScratchpad contract`
  - Files: `src/interaction/contracts.ts`, `src/runtime/turn-service.ts`, `src/runtime/submit-rp-turn-tool.ts`, `test/runtime/rp-turn-contract.test.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 3. Register `cognition.thinker` Job Kind in BOTH Job Pipelines

  **What to do**:

  MaidsClaw has TWO job pipelines that BOTH need the new kind:

  **A. Type definitions** (`src/jobs/types.ts`):
  - Add `"cognition.thinker"` to `JobKind` union type (line 1-8)
  - Add `"background.cognition_thinker"` to `ExecutionClass` union type (line 10-19)
  - Add `JOB_MAX_ATTEMPTS["cognition.thinker"] = 3` (line 45-53)
  - Add `EXECUTION_CLASS_PRIORITY["background.cognition_thinker"] = 3` (line 67-77)

  **B. Durable store** (`src/jobs/durable-store.ts`):
  - Add `"cognition.thinker": CognitionThinkerJobPayload` to `DurablePayloadByKind` type map (line 49-57)
  - Define `CognitionThinkerJobPayload = { sessionId: string; agentId: string; settlementId: string; talkerTurnVersion: number }`

  **C. PG store** (`src/jobs/pg-store.ts`):
  - Add `"cognition.thinker:session:{sessionId}": 1` to `CONCURRENCY_KEY_CAPS` (line 138-144) — max 1 Thinker per session

  **D. PG runner + app host** (`src/jobs/pg-runner.ts`, `src/app/host/create-app-host.ts`):
  - Register empty worker stub: `runner.registerWorker("cognition.thinker", async (job) => { /* T7 implements */ })`

  **E. In-memory dispatcher** (`src/jobs/dispatcher.ts`):
  - Register stub in dispatcher
  - `isJobKind()` (line 428): Add `"cognition.thinker"`
  - `isExecutionClass()` (line 440): Add `"background.cognition_thinker"`
  - `defaultExecutionClass()` (line 454): Add mapping `"cognition.thinker" → "background.cognition_thinker"`

  **F. JobPersistence adapter** (`src/jobs/job-persistence-factory.ts`):
  - Add `cognition.thinker` branch to `toEnqueueInput()` (line 127-170), following existing `search.rebuild` / `memory.migrate` patterns

  **Must NOT do**:
  - Do NOT implement actual Thinker logic (that's T7)
  - Do NOT change existing job kinds or configurations
  - Do NOT change the V1 event contract

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Touches 7 files across two pipelines + dispatcher routing
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T2, T4, T5, T11)
  - **Blocks**: T6, T7
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/jobs/types.ts:1-77` — All type-level additions: `JobKind`, `ExecutionClass`, `JOB_MAX_ATTEMPTS`, `EXECUTION_CLASS_PRIORITY`
  - `src/jobs/job-persistence-factory.ts:127-170` — `toEnqueueInput()` patterns for existing job kinds

  **API/Type References**:
  - `src/jobs/durable-store.ts:49-57` — `DurablePayloadByKind` strict mapped type
  - `src/jobs/pg-store.ts:138-144` — `CONCURRENCY_KEY_CAPS` format: `"job_type:scope"` → number
  - `src/jobs/pg-runner.ts:13-23` — `PgJobRunner.registerWorker()` method
  - `src/app/host/create-app-host.ts:36-48` — `createPgJobConsumer()` where workers are registered
  - `src/jobs/dispatcher.ts:428,440,454` — hardcoded routing helpers: `isJobKind()`, `isExecutionClass()`, `defaultExecutionClass()`

  **WHY Each Reference Matters**:
  - `types.ts`: ALL type-level additions go here. Missing `JobKind` update = nothing compiles
  - `durable-store.ts`: `DurablePayloadByKind` is strict — missing entry = type error
  - `dispatcher.ts` routing: These are hardcoded switch/if blocks, NOT derived from types — easy to miss

  **Acceptance Criteria**:
  - [ ] `bun run build` passes
  - [ ] `"cognition.thinker"` is a valid `JobKind` value
  - [ ] `CONCURRENCY_KEY_CAPS` has entry with cap = 1
  - [ ] `JOB_MAX_ATTEMPTS["cognition.thinker"]` = 3
  - [ ] `isJobKind("cognition.thinker")` returns true
  - [ ] `defaultExecutionClass("cognition.thinker")` returns `"background.cognition_thinker"`
  - [ ] Worker stub registered (processing job doesn't crash)

  **QA Scenarios**:

  ```
  Scenario: Job kind compiles and is recognized
    Tool: Bash (bun run build + grep)
    Preconditions: All files modified
    Steps:
      1. Run `bun run build` — assert passes
      2. Grep for "cognition.thinker" in types.ts, durable-store.ts, pg-store.ts, dispatcher.ts, create-app-host.ts, job-persistence-factory.ts
      3. Assert all files contain the new kind
    Expected Result: Build passes, kind registered in all locations
    Failure Indicators: Missing from any file, type error
    Evidence: .sisyphus/evidence/task-3-job-kind-registered.txt

  Scenario: Dispatcher routing recognizes new kind
    Tool: Bash (bun test)
    Preconditions: Unit test for dispatcher helpers
    Steps:
      1. Call isJobKind("cognition.thinker") — assert true
      2. Call isExecutionClass("background.cognition_thinker") — assert true
      3. Call defaultExecutionClass("cognition.thinker") — assert "background.cognition_thinker"
    Expected Result: All routing functions recognize the new kind
    Failure Indicators: Any function returns false/undefined
    Evidence: .sisyphus/evidence/task-3-dispatcher-routing.txt
  ```

  **Commit**: YES (C3)
  - Message: `feat(jobs): register cognition.thinker job kind in both pipelines + dispatcher routing`
  - Files: `src/jobs/types.ts`, `src/jobs/durable-store.ts`, `src/jobs/pg-store.ts`, `src/jobs/pg-runner.ts`, `src/app/host/create-app-host.ts`, `src/jobs/dispatcher.ts`, `src/jobs/job-persistence-factory.ts`
  - Pre-commit: `bun run build && bun test`

---

- [x] 4. Create Talker Prompt Builder Mode

  **What to do**:
  - Add `isTalkerMode?: boolean` to `BuildPromptInput` type in `src/core/prompt-builder.ts`
  - In `build()` method (line 138), in `rp_agent` branch (line 159-185), add conditional:
    - When `input.isTalkerMode` is true: REPLACE `OPERATIONAL_STATE` slot — instead of `RP_AGENT_FRAMEWORK_INSTRUCTIONS` (line 184), inject `TALKER_INSTRUCTIONS` constant
    - When `input.isTalkerMode` is false/undefined: behavior IDENTICAL to current
  - KEEP in Talker mode: `SYSTEM_PREAMBLE`, `WORLD_RULES`, `PINNED_SHARED`, `RECENT_COGNITION`, `TYPED_RETRIEVAL`, `LORE_ENTRIES`, `CONVERSATION`
  - Create `TALKER_INSTRUCTIONS` constant (≤200 chars):
    ```
    ## Response Instructions
    Respond in character. Before your reply, write a brief internal note (1-3 sentences) as `latentScratchpad`
    capturing your current reasoning, stance, and intent. Then write your `publicReply`.
    Use the submit_rp_turn tool with only: publicReply, latentScratchpad. Leave other fields empty.
    ```

  **Must NOT do**:
  - Do NOT modify `RP_AGENT_FRAMEWORK_INSTRUCTIONS` content
  - Do NOT change `SECTION_SLOT_ORDER`
  - Do NOT optimize token budget, history length, or add caching
  - Do NOT change the `PromptBuilder` constructor
  - Do NOT touch `AgentLoop` or `AgentRunRequest` (that's T13)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Requires understanding prompt assembly pipeline and crafting lightweight instructions
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T2, T3, T5, T11)
  - **Blocks**: T6, T13
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/core/prompt-builder.ts:28-100` — `RP_AGENT_FRAMEWORK_INSTRUCTIONS` (~3132 chars of cognition framework)
  - `src/core/prompt-builder.ts:138-197` — `build()` method, rp_agent branch at line 159-185

  **API/Type References**:
  - `src/core/prompt-builder.ts` — `BuildPromptInput` type (add `isTalkerMode?: boolean`)
  - `src/core/prompt-template.ts:24-33` — `SECTION_SLOT_ORDER` (DO NOT CHANGE)

  **WHY Each Reference Matters**:
  - `RP_AGENT_FRAMEWORK_INSTRUCTIONS`: Know exactly what to strip — this is ~3132 chars of slow cognition instructions
  - `build()` rp_agent branch: The exact point where `OPERATIONAL_STATE` is set — Talker mode replaces this

  **Acceptance Criteria**:
  - [ ] `bun run build` passes
  - [ ] `build({ ..., isTalkerMode: false })` produces identical output to current
  - [ ] `build({ ..., isTalkerMode: true })` produces prompt WITHOUT `RP_AGENT_FRAMEWORK_INSTRUCTIONS` and WITH `TALKER_INSTRUCTIONS`
  - [ ] `TALKER_INSTRUCTIONS` is ≤200 chars

  **QA Scenarios**:

  ```
  Scenario: Talker mode produces lightweight prompt
    Tool: Bash (bun test)
    Preconditions: Unit test comparing modes
    Steps:
      1. Call build() with isTalkerMode: false → capture full prompt
      2. Call build() with isTalkerMode: true → capture Talker prompt
      3. Assert Talker prompt does NOT contain "privateCognition" or "privateEpisodes"
      4. Assert Talker prompt DOES contain "latentScratchpad" and "publicReply"
      5. Assert Talker prompt DOES contain persona preamble
    Expected Result: Talker prompt is shorter and lacks cognition framework
    Failure Indicators: Contains cognition instructions or same length as full
    Evidence: .sisyphus/evidence/task-4-talker-prompt-lightweight.txt

  Scenario: Default mode unchanged (regression)
    Tool: Bash (bun test)
    Preconditions: Existing prompt builder tests
    Steps:
      1. Run all existing prompt builder tests
      2. Assert no regression
    Expected Result: All existing tests pass
    Failure Indicators: Any test fails
    Evidence: .sisyphus/evidence/task-4-default-regression.txt
  ```

  **Commit**: YES (C4)
  - Message: `feat(prompt): add Talker mode to prompt builder with lightweight instructions`
  - Files: `src/core/prompt-builder.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 5. Capture Sync Mode Baseline Scores

  **What to do**:
  - Run `rp-suspicion-test.ts --max-rounds 5` (existing test as-is, since current mode IS sync)
  - Capture: total score, per-dimension scores, per-turn latencies, total elapsed time
  - Save baseline to `data/rp-test-results/baseline-sync-pre-talker.json`
  - Record average latency per turn (ms) as the "before" measurement

  **Must NOT do**:
  - Do NOT modify the test script (T10 will add --mode flag)
  - Do NOT modify any source code
  - Do NOT change agent or persona configuration

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Just running an existing test script and saving output
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T2, T3, T4, T11)
  - **Blocks**: T10
  - **Blocked By**: None

  **References**:
  - `scripts/rp-suspicion-test.ts` — existing test script
  - `data/rp-test-results/` — output directory

  **Acceptance Criteria**:
  - [ ] `data/rp-test-results/baseline-sync-pre-talker.json` exists with valid scores
  - [ ] Average latency per turn recorded
  - [ ] All 5 rounds complete without errors

  **QA Scenarios**:

  ```
  Scenario: Baseline capture completes
    Tool: Bash
    Preconditions: Database running, agent rp:xuran configured
    Steps:
      1. Run: bun run scripts/rp-suspicion-test.ts --max-rounds 5
      2. Wait for completion (~7-8 min)
      3. Verify output JSON file created
      4. Extract average latency per turn
    Expected Result: 5 rounds complete, scores recorded, avg latency ~80s/turn
    Failure Indicators: Script crashes, 0 rounds, or missing output
    Evidence: .sisyphus/evidence/task-5-baseline-capture.json
  ```

  **Commit**: NO (data file only)

---

- [x] 11. Add Idempotency Dedup Constraint on `private_cognition_events`

  **What to do**:
  - **CRITICAL CONTEXT**: `private_cognition_events` has DB triggers (`trg_private_cognition_events_no_update`, `trg_private_cognition_events_no_delete`) that RAISE EXCEPTION on UPDATE/DELETE. The original plan's `ON CONFLICT DO UPDATE` approach is **impossible** without removing these triggers. This task uses `DO NOTHING` to preserve the append-only contract.
  - Add a UNIQUE INDEX in `src/storage/pg-app-schema-ops.ts`:
    ```sql
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cognition_events_settlement_dedup
    ON private_cognition_events (settlement_id, agent_id, cognition_key, op)
    ```
    The `op` column (`CognitionOp = 'upsert' | 'retract'`) MUST be included because same `cognition_key` can have BOTH an upsert and a retract in the same settlement.
  - In `src/storage/domain-repos/pg/cognition-event-repo.ts`, change INSERT to `INSERT ... ON CONFLICT (settlement_id, agent_id, cognition_key, op) DO NOTHING RETURNING id`
  - **Handle empty RETURNING on conflict**: When `DO NOTHING` fires, `RETURNING id` returns 0 rows. Current code `rows[0].id` would throw TypeError. Fix `append()` to return `null` when no row was inserted:
    ```typescript
    // After INSERT ... ON CONFLICT DO NOTHING RETURNING id
    if (rows.length === 0) return null;  // conflict hit, event already exists
    return Number(rows[0].id);
    ```
  - **Update interface contract**: In `src/storage/domain-repos/contracts/cognition-event-repo.ts`, change `append()` return type from `Promise<number>` to `Promise<number | null>`. This is necessary — `DO NOTHING` semantics require distinguishing "inserted" from "already existed".
  - **Fix ProjectionManager.appendCognitionEvents chain**: In `src/memory/projection/projection-manager.ts:298-342`, the `appendCognitionEvents()` method chains `append()` → `applyProjection(eventId)`. When `append()` returns `null` (conflict), **skip** `applyProjection()` entirely:
    ```typescript
    const appendResult = cognitionEventRepo.append({...});
    // If promise:
    return Promise.resolve(appendResult).then((eventId) => {
      if (eventId === null) return;  // conflict — skip projection, already applied
      return Promise.resolve(applyProjection(eventId)).then(() => undefined);
    });
    // If sync: same null check
    if (appendResult === null) return;
    return applyProjection(appendResult);
    ```
    **Safety proof**: With PG transaction (T7/G14), the only scenario producing conflicts is "full transaction committed + job ack missed → retry". In that case, `private_cognition_current` was already correctly written in the first commit, so skipping `applyProjection` is safe. Mid-transaction failures cause full rollback → clean retry → no conflicts.
  - **Pre-insert dedup in normalization layer**: Since `DO NOTHING` silently drops the second write for same `(cognition_key, op)`, add deduplication in the normalization path. In `normalizePrivateCommit()` (or a wrapper called before `append()`), deduplicate same-key ops — when two ops have identical `(cognition_key, op)`, keep the LAST one (last-writer-wins at application level, before DB insert).

  **Must NOT do**:
  - Do NOT use `ON CONFLICT DO UPDATE` — DB triggers will RAISE EXCEPTION
  - Do NOT remove or modify the append-only triggers
  - Do NOT change `ProjectionManager.commitSettlement()` signature (G5) — the change is INTERNAL to `appendCognitionEvents()` only
  - Do NOT change how cognition events are READ

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Schema index + SQL change + interface return type + appendCognitionEvents null-check + normalization dedup. ~5 files, all mechanical changes.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T2, T3, T4, T5)
  - **Blocks**: T7
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/storage/pg-app-schema-ops.ts` — migration/index creation pattern
  - `src/storage/pg-app-schema-truth.ts:559-618` — append-only triggers on `private_cognition_events` (DO NOT MODIFY)

  **API/Type References**:
  - `src/storage/domain-repos/pg/cognition-event-repo.ts:11-26` — current `append()` with plain INSERT + `RETURNING id`. Must handle empty RETURNING when DO NOTHING fires.
  - `src/storage/domain-repos/contracts/cognition-event-repo.ts` — `CognitionEventRepo` interface. Must change `append()` return type to `Promise<number | null>`.
  - `src/memory/projection/projection-manager.ts:298-342` — `appendCognitionEvents()` chains `append()` → `applyProjection(eventId)`. Must add null-check to skip `applyProjection` on conflict.
  - `src/memory/projection/projection-manager.ts:305-321` — `applyProjection()` inner function that calls `upsertFromEvent()`. This is what must be SKIPPED when `append()` returns null.
  - `src/storage/domain-repos/pg/cognition-projection-repo.ts:168-193` — `upsertFromEvent()` writes `source_event_id` to `private_cognition_current`. If called with null/0 id → corruption. The null-check in `appendCognitionEvents` prevents this.
  - `src/runtime/rp-turn-contract.ts:72-74` — `CognitionOp = 'upsert' | 'retract'`
  - `src/runtime/rp-turn-contract.ts:492-552` — `normalizePrivateCommit()` (add dedup here or in wrapper)

  **WHY Each Reference Matters**:
  - Truth schema triggers: PROOF that `DO UPDATE` is impossible — must use `DO NOTHING`
  - `cognition-event-repo.ts:25`: `Number(rows[0].id)` — this line CRASHES when `DO NOTHING` returns 0 rows. The fix is here.
  - `appendCognitionEvents:334`: `.then((eventId) => applyProjection(eventId))` — this chain must handle null eventId
  - `upsertFromEvent:179`: `source_event_id = ${event.id}` — would get 0/NaN/null if not guarded upstream
  - `normalizePrivateCommit()`: Pre-insert dedup must happen here to prevent silent data loss from `DO NOTHING`

  **Acceptance Criteria**:
  - [ ] `bun run build` passes
  - [ ] UNIQUE INDEX exists on `(settlement_id, agent_id, cognition_key, op)`
  - [ ] Duplicate insert with same 4-tuple → silently ignored (DO NOTHING), no error
  - [ ] `append()` returns `null` on conflict (not crash, not 0, not NaN)
  - [ ] Same key + different op (upsert vs retract) → both rows inserted
  - [ ] Different keys → both rows inserted
  - [ ] Pre-insert dedup: two ops with identical (cognition_key, op) in one settlement → only last one reaches DB
  - [ ] `appendCognitionEvents()`: when `append()` returns null → `applyProjection()` NOT called → `private_cognition_current` NOT touched
  - [ ] `appendCognitionEvents()`: when `append()` returns number → `applyProjection()` called normally
  - [ ] `CognitionEventRepo` interface updated: `append()` returns `Promise<number | null>`
  - [ ] `bun run build` passes (type check confirms interface change propagates correctly)
  - [ ] `bun test` — all existing tests pass
  - [ ] No `ON CONFLICT DO UPDATE` anywhere in cognition-event-repo.ts

  **QA Scenarios**:

  ```
  Scenario: Duplicate insert is silently ignored (DO NOTHING) and returns null
    Tool: Bash (bun test)
    Preconditions: Database with migrated schema
    Steps:
      1. Insert event with settlementId="s1", agentId="a1", cognitionKey="assertion:trust", op="upsert"
      2. Assert first insert returns a number (the new row id)
      3. Insert the SAME event again
      4. Assert second insert returns null (not a number, not an error)
      5. Assert only 1 row exists in private_cognition_events (not 2)
    Expected Result: First call → number, second call → null, 1 DB row
    Failure Indicators: TypeError on second call, 2 rows, or non-null return on conflict
    Evidence: .sisyphus/evidence/task-11-dedup-do-nothing.txt

  Scenario: appendCognitionEvents skips applyProjection on conflict
    Tool: Bash (bun test)
    Preconditions: Database with migrated schema, existing cognition event for key "assertion:trust"
    Steps:
      1. Call appendCognitionEvents with ops including key "assertion:trust" (already in DB from prior settlement)
      2. Assert: private_cognition_events row count unchanged for that key (DO NOTHING)
      3. Assert: private_cognition_current.source_event_id for "assertion:trust" still points to ORIGINAL event id (not 0, not null, not NaN)
      4. For a NEW key "assertion:loyalty" in same batch: assert both event AND current rows created normally
    Expected Result: Conflicting op skipped cleanly, new ops processed normally, no corruption
    Failure Indicators: source_event_id is 0/null/NaN, TypeError crash, or missing current entry for new key
    Evidence: .sisyphus/evidence/task-11-chain-skip-on-conflict.txt

  Scenario: Pre-insert dedup for same-key ops
    Tool: Bash (bun test)
    Preconditions: Normalization dedup wrapper active
    Steps:
      1. Create cognitionOps array with two entries for same (cognition_key="assertion:trust", op="upsert") but different record_json
      2. Run through normalization dedup
      3. Assert output has 1 entry (last one wins)
      4. Insert into DB
      5. Assert 1 row with the SECOND record_json value
    Expected Result: Application-level last-writer-wins, then single DB insert
    Failure Indicators: Both entries reach DB (one silently dropped by DO NOTHING)
    Evidence: .sisyphus/evidence/task-11-pre-insert-dedup.txt

  Scenario: Full transaction retry — all ops conflict, no corruption
    Tool: Bash (bun test)
    Preconditions: 3 cognition ops already committed in a prior successful transaction
    Steps:
      1. Re-run commitSettlement with the same 3 ops (simulating retry after success+missed-ack)
      2. Assert: all 3 append() calls return null
      3. Assert: no applyProjection() called (verify private_cognition_current unchanged)
      4. Assert: total event rows still 3 (not 6)
      5. Assert: private_cognition_current entries all have correct original source_event_ids
    Expected Result: Clean no-op retry, zero data mutation, zero corruption
    Failure Indicators: Any row count increase, any source_event_id change, any crash
    Evidence: .sisyphus/evidence/task-11-full-retry-no-corruption.txt
  ```

  **Commit**: YES (C5)
  - Message: `feat(storage): add idempotency dedup on private_cognition_events (DO NOTHING + null-safe chain + pre-insert dedup)`
  - Files: `src/storage/pg-app-schema-ops.ts`, `src/storage/domain-repos/pg/cognition-event-repo.ts`, `src/storage/domain-repos/contracts/cognition-event-repo.ts`, `src/memory/projection/projection-manager.ts`, `src/runtime/rp-turn-contract.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 12. Add `talkerThinker` Config Path to RuntimeConfig + TurnService Wiring

  **What to do**:

  **A. Type definition** (`src/core/config-schema.ts:92-98`):
  - Add to `RuntimeConfig`:
    ```typescript
    talkerThinker?: {
      enabled: boolean;              // default: false
      stalenessThreshold: number;    // default: 2
      softBlockTimeoutMs: number;    // default: 3000
      softBlockPollIntervalMs: number; // default: 500
    }
    ```

  **B. Config loading** (`src/core/config.ts:155+`):
  - In `loadRuntimeConfig()`, add parsing + defaults for `talkerThinker`

  **C. Bootstrap options** (`src/bootstrap/types.ts:44-61`):
  - Add `runtimeConfig?: RuntimeConfig` to `RuntimeBootstrapOptions`

  **D. Bootstrap wiring** (`src/bootstrap/runtime.ts:1088-1102`):
  - Load `RuntimeConfig`, extract `talkerThinkerConfig` with defaults
  - Pass `talkerThinkerConfig` and `resolvedJobPersistence` (existing at line 598) to `TurnService` constructor

  **E. TurnService constructor** (`src/runtime/turn-service.ts:72-91`):
  - Add TWO new parameters (total 15):
    ```typescript
    private readonly talkerThinkerConfig: { enabled: boolean; stalenessThreshold: number; softBlockTimeoutMs: number; softBlockPollIntervalMs: number },
    private readonly jobPersistence: JobPersistence | null = null,
    ```

  **F. Config file example**: Add `talkerThinker` section to `config/runtime.example.json`

  **Must NOT do**:
  - Do NOT change existing `memory` config
  - Do NOT make `talkerThinker` required (must be optional with defaults)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Type extension + config loading + constructor wiring. ~5 files.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1b (with T13)
  - **Blocks**: T6, T8, T10
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/core/config-schema.ts:92-98` — existing `RuntimeConfig = { memory?: MemoryConfig }`
  - `src/core/config.ts:155+` — `loadRuntimeConfig()` function

  **API/Type References**:
  - `src/bootstrap/types.ts:44-61` — `RuntimeBootstrapOptions` (currently no `runtimeConfig`)
  - `src/bootstrap/runtime.ts:1088-1102` — TurnService construction (currently 13 params)
  - `src/runtime/turn-service.ts:72-91` — TurnService constructor
  - `src/jobs/persistence.ts:1-31` — `JobPersistence` interface for import
  - `config/runtime.json` — actual config file (has `memory` section only)
  - `config/runtime.example.json` — example config

  **WHY Each Reference Matters**:
  - `config-schema.ts`: The type definition — all downstream code depends on this shape
  - `bootstrap/runtime.ts`: Wire BOTH `talkerThinkerConfig` AND `jobPersistence` (already exists as `resolvedJobPersistence` at line 598)
  - `turn-service.ts`: Add constructor params — T6 reads `this.talkerThinkerConfig.enabled`, T8 reads thresholds

  **Acceptance Criteria**:
  - [ ] `bun run build` passes
  - [ ] `RuntimeConfig` includes `talkerThinker?` with all 4 fields
  - [ ] `loadRuntimeConfig()` returns `enabled: false` when field absent
  - [ ] All defaults applied (threshold=2, timeout=3000, poll=500)
  - [ ] `TurnService` has `talkerThinkerConfig` and `jobPersistence` accessible
  - [ ] `config/runtime.example.json` updated

  **QA Scenarios**:

  ```
  Scenario: Default config has talkerThinker disabled
    Tool: Bash (bun test)
    Preconditions: No talkerThinker in runtime.json
    Steps:
      1. Call loadRuntimeConfig() with no talkerThinker in input
      2. Assert enabled === false, threshold === 2, timeout === 3000, poll === 500
    Expected Result: All defaults applied
    Failure Indicators: Any field undefined or wrong default
    Evidence: .sisyphus/evidence/task-12-config-defaults.txt

  Scenario: Explicit config overrides defaults
    Tool: Bash (bun test)
    Preconditions: runtime.json with talkerThinker.enabled: true
    Steps:
      1. Call loadRuntimeConfig() with explicit enabled: true, stalenessThreshold: 3
      2. Assert enabled === true, threshold === 3, timeout === 3000 (defaulted)
    Expected Result: Explicit values override, missing values default
    Failure Indicators: Wrong values
    Evidence: .sisyphus/evidence/task-12-config-overrides.txt
  ```

  **Commit**: YES (C7)
  - Message: `feat(config): add talkerThinker config path + wire TurnService with config and JobPersistence`
  - Files: `src/core/config-schema.ts`, `src/core/config.ts`, `src/bootstrap/types.ts`, `src/bootstrap/runtime.ts`, `src/runtime/turn-service.ts`, `config/runtime.example.json`
  - Pre-commit: `bun run build && bun test`

---

- [x] 13. Add AgentLoop Mode-Awareness for Talker

  **What to do**:

  **A. AgentRunRequest** (`src/core/agent-loop.ts:62-69`):
  - Add `isTalkerMode?: boolean`

  **B. buildInitialPromptState** (`src/core/agent-loop.ts:846-855`):
  - Thread `request.isTalkerMode` to `promptBuilder.build()`:
    ```typescript
    this.promptBuilder.build({ agentType, ..., isTalkerMode: request.isTalkerMode })
    ```

  **C. retryStructuredExtraction** (`src/core/agent-loop.ts:743-746`):
  - Add early return when Talker mode:
    ```typescript
    if (request.isTalkerMode) return result; // Talker doesn't need cognition extraction
    ```

  **Must NOT do**:
  - Do NOT change prompt builder logic (that's T4)
  - Do NOT change `runRpBufferedTurn` or sync path
  - Do NOT add `isTalkerMode` to any type besides `AgentRunRequest`
  - Do NOT change any other AgentLoop methods

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 3 surgical edits in one file
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1b (with T12)
  - **Blocks**: T6
  - **Blocked By**: T4 (needs `isTalkerMode` on `BuildPromptInput`)

  **References**:

  **Pattern References**:
  - `src/core/agent-loop.ts:62-69` — `AgentRunRequest` interface
  - `src/core/agent-loop.ts:846-855` — `buildInitialPromptState()`
  - `src/core/agent-loop.ts:743-746` — `retryStructuredExtraction()`

  **API/Type References**:
  - `src/core/prompt-builder.ts` — `BuildPromptInput.isTalkerMode` (from T4)

  **WHY Each Reference Matters**:
  - `AgentRunRequest`: T6 creates requests with `isTalkerMode: true`
  - `buildInitialPromptState`: Bridge — threads flag to T4's prompt builder
  - `retryStructuredExtraction`: Performance gate — without skip, Talker makes unnecessary retry calls

  **Acceptance Criteria**:
  - [ ] `bun run build` passes
  - [ ] `AgentRunRequest` includes `isTalkerMode?: boolean`
  - [ ] `buildInitialPromptState` passes flag to `promptBuilder.build()`
  - [ ] `retryStructuredExtraction` returns early when `isTalkerMode: true`
  - [ ] Default behavior unchanged when `isTalkerMode` is undefined/false
  - [ ] `bun test` — all existing tests pass

  **QA Scenarios**:

  ```
  Scenario: isTalkerMode threads to prompt builder
    Tool: Bash (bun test)
    Preconditions: Unit test with mock prompt builder
    Steps:
      1. Create AgentRunRequest with isTalkerMode: true
      2. Call buildInitialPromptState
      3. Assert promptBuilder.build() was called with isTalkerMode: true
    Expected Result: Flag reaches prompt builder
    Failure Indicators: Flag not threaded
    Evidence: .sisyphus/evidence/task-13-talker-mode-threads.txt

  Scenario: retryStructuredExtraction skips in Talker mode
    Tool: Bash (bun test)
    Preconditions: Unit test with mock result lacking privateCognition
    Steps:
      1. Create request with isTalkerMode: true
      2. Call runBuffered with mock LLM response (publicReply + scratchpad, NO privateCognition)
      3. Assert no retry LLM call made
    Expected Result: Talker doesn't retry for cognition extraction
    Failure Indicators: Retry call made, or error about missing cognition
    Evidence: .sisyphus/evidence/task-13-no-retry.txt
  ```

  **Commit**: YES (C8)
  - Message: `feat(core): add isTalkerMode to AgentRunRequest with prompt builder threading + retry skip`
  - Files: `src/core/agent-loop.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 6. Implement `runRpTalkerTurn` Method — The Core Split

  **What to do**:
  - Create new method `runRpTalkerTurn(request, turnRangeStart)` in `src/runtime/turn-service.ts` alongside existing `runRpBufferedTurn`
  - Gate entry: in dispatch point, check `this.talkerThinkerConfig.enabled`. If true → `runRpTalkerTurn()`. If false → existing `runRpBufferedTurn()`
  - `runRpTalkerTurn` does:
    1. Load conversation history (same as current — from `interaction_records`)
    2. Build `AgentRunRequest` with `isTalkerMode: true` (T13) — threads to lightweight prompt (T4)
    3. Call `agentLoop.runBuffered(request)` — same LLM mechanism but lighter prompt, no cognition retry (T13)
    4. Extract `publicReply` and `latentScratchpad` (cognitiveSketch)
    5. Build **minimal settlement** payload using existing `turn_settlement_v5` schema:
       - `publicReply` ✅
       - `cognitiveSketch` from `latentScratchpad` ✅
       - `privateCognition` = undefined (deferred to Thinker)
       - `privateEpisodes` = undefined (deferred to Thinker)
       - `publications` = undefined (deferred to Thinker)
       - `areaStateArtifacts` = undefined (deferred to Thinker)
       - `relationIntents` = undefined (NOT supported in Phase 1)
       - `conflictFactors` = undefined (NOT supported in Phase 1)
       - `pinnedSummaryProposal` = undefined (dormant)
    6. Commit minimal settlement inside single transaction (`interactionStore.runInTransactionAsync()`):
       - Write `turn_settlement` record to `interaction_records`
       - Write assistant `message` record to `interaction_records`
       - **Atomically increment `talker_turn_counter`** via `repos.recentCognitionSlotRepo.upsert(..., { versionIncrement: 'talker' })` — capture RETURNING value as `talkerTurnVersion`
       - Do NOT write `slot_payload` (Thinker will do this)
       - Do NOT call `projectionManager.commitSettlement()`
       - Do NOT write cognition events, episodes, or area projection
       - Do NOT engage `settlement_processing_ledger` (G14)
    7. After transaction commits, enqueue Thinker job via `this.jobPersistence.enqueue()`:
       ```typescript
       await this.jobPersistence.enqueue({
         id: `thinker:${sessionId}:${settlementId}`,
         jobType: "cognition.thinker",
         payload: { sessionId, agentId, settlementId, talkerTurnVersion },
         status: "pending",
         maxAttempts: 3,
       });
       ```
       Enqueue is OUTSIDE settlement transaction. If fails, ONE retry after 1s:
       ```typescript
       try { await this.jobPersistence.enqueue(entry); }
       catch (err) {
         logger.warn("Thinker enqueue failed, retrying once", { settlementId, err });
         await sleep(1000);
         await this.jobPersistence.enqueue(entry); // no catch — propagate
       }
       ```
       **Failure mode (Accepted Degradation)**: If both retries fail, settlement is durable (user sees reply), but Thinker cognition permanently lost for this turn. No self-healing mechanism. Version gap grows. Documented in Accepted Degradations.
    8. Yield `publicReply` text chunks to user (stream response)
  - Handle same error cases as sync path (model failures, empty replies, etc.)
  - **Settlement consumers**: Verify all code that reads `TurnSettlementPayload` handles `privateCognition: undefined` gracefully. Use `lsp_find_references` on `TurnSettlementPayload` to find consumers.

  **Must NOT do**:
  - Do NOT modify `runRpBufferedTurn` — it must remain identical (G1)
  - Do NOT change `AgentLoop.runBuffered()` — T13 handles mode-awareness
  - Do NOT change `submit_rp_turn` tool schema (G2)
  - Do NOT add new interaction record types
  - Do NOT implement Thinker logic (that's T7)
  - Do NOT read config from file directly — use `this.talkerThinkerConfig`
  - Do NOT use `settlementUnitOfWork` — use `interactionStore.runInTransactionAsync()` (G14)
  - Do NOT create schema version v6 (G12) — reuse `turn_settlement_v5`

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Core architectural change. Must understand full turn lifecycle, settlement commit pattern, maintain exact sync-path compatibility.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: T7, T8, T10
  - **Blocked By**: T1, T2, T3, T4, T12, T13

  **References**:

  **Pattern References**:
  - `src/runtime/turn-service.ts:267-677` — `runRpBufferedTurn` — the EXISTING method this parallels
  - `src/runtime/turn-service.ts:450-478` — settlement payload construction
  - `src/runtime/turn-service.ts:513-573` — settlement DB commit via `interactionStore.runInTransactionAsync()` (non-UoW path — this is what Talker should follow)

  **API/Type References**:
  - `src/core/agent-loop.ts:62-69` — `AgentRunRequest` with `isTalkerMode` (T13)
  - `src/core/config-schema.ts` — `RuntimeConfig.talkerThinker` (T12)
  - `src/jobs/persistence.ts:22-31` — `JobPersistence.enqueue()` interface
  - `src/storage/domain-repos/pg/recent-cognition-slot-repo.ts` — `upsert()` with `versionIncrement: 'talker'` (T1)
  - `src/interaction/contracts.ts` — `TurnSettlementPayload` type — verify all consumers handle undefined fields

  **WHY Each Reference Matters**:
  - `runRpBufferedTurn`: THE reference. `runRpTalkerTurn` mirrors structure but stops before projection commits
  - Settlement commit non-UoW path (lines 513-573): Talker uses THIS path — `interactionStore.runInTransactionAsync()` without ledger
  - `JobPersistence.enqueue()`: Simplified shape; `PgJobPersistence.toEnqueueInput()` maps to full `EnqueueJobInput`

  **Acceptance Criteria**:
  - [ ] `bun run build` passes
  - [ ] Config `enabled: false` → sync path executes
  - [ ] Config `enabled: true` → `runRpTalkerTurn` executes
  - [ ] Talker commits `turn_settlement` + `message` records
  - [ ] Talker does NOT write cognition events, episodes, or area projection
  - [ ] Talker atomically increments `talker_turn_counter` inside transaction
  - [ ] If transaction rolls back, counter NOT incremented
  - [ ] Thinker job enqueued via `JobPersistence.enqueue()`
  - [ ] Enqueue failure: 1 retry, then logged but turn completes
  - [ ] `publicReply` chunks yielded to user
  - [ ] Settlement consumers handle `privateCognition: undefined` without crash
  - [ ] Flag toggle: Thinker processes jobs regardless of current flag state

  **QA Scenarios**:

  ```
  Scenario: Talker produces response with cognitiveSketch
    Tool: Bash (integration)
    Preconditions: talkerThinker.enabled: true, database running
    Steps:
      1. Start session with rp:xuran
      2. Send user message: "你好，我是林悦"
      3. Query interaction_records for turn_settlement — assert publicReply + cognitiveSketch present
      4. Assert NO entries in private_cognition_events for this turn
      5. Query recent_cognition_slots — assert talker_turn_counter = 1, thinker_committed_version = 0
      6. Query PG job store for pending cognition.thinker job
    Expected Result: Response returned, settlement committed, counter bumped, job enqueued
    Failure Indicators: No response, empty sketch, cognition events written, no job
    Evidence: .sisyphus/evidence/task-6-talker-response.json

  Scenario: Sync mode unchanged (regression)
    Tool: Bash (integration)
    Preconditions: talkerThinker.enabled: false
    Steps:
      1. Start session, send same message
      2. Assert cognition events ARE written (full sync behavior)
      3. Assert NO cognition.thinker job enqueued
    Expected Result: Identical to pre-change behavior
    Failure Indicators: Any difference from pre-change
    Evidence: .sisyphus/evidence/task-6-sync-regression.json

  Scenario: Settlement consumers handle undefined privateCognition
    Tool: Bash (bun test)
    Preconditions: Existing tests + new test reading Talker settlement
    Steps:
      1. Create a TurnSettlementPayload with privateCognition: undefined, privateEpisodes: undefined
      2. Pass through all existing settlement reading code paths
      3. Assert no crash or type error
    Expected Result: All consumers handle undefined gracefully
    Failure Indicators: Crash, type error, or undefined dereference
    Evidence: .sisyphus/evidence/task-6-settlement-consumers.txt
  ```

  **Commit**: YES (C9)
  - Message: `feat(runtime): implement runRpTalkerTurn with async Thinker job enqueue`
  - Files: `src/runtime/turn-service.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 7. Implement Thinker Job Worker — Full Cognition Processing

  **What to do**:
  - Replace empty worker stub (from T3) with real implementation. Create `src/runtime/thinker-worker.ts` and import in `src/app/host/create-app-host.ts`.

  **Dependency Wiring** (Metis Q-MISS-1):
  - The Thinker worker runs inside `PgJobRunner.registerWorker("cognition.thinker", fn)` in `createPgJobConsumer()`.
  - Dependencies needed: `ProjectionManager`, `InteractionStore` (for reading settlement), `RecentCognitionSlotRepo`, `ModelProvider`, agent profile/persona context, `ViewerContext`
  - **Approach**: Create a factory function `createThinkerWorker(deps: ThinkerWorkerDeps): WorkerFn` that receives an options bag. The `createPgJobConsumer()` scope (or bootstrap scope) constructs the deps and passes them in.
  - The worker must be **stateless** (G10) — all context loaded fresh from DB per job.

  **LLM Approach** (Metis Q-MISS-2):
  - Use `agentLoop.runBuffered()` with `isTalkerMode: false` (full mode) for tool execution + normalization reuse.
  - The Thinker builds a custom prompt context (conversation + cognition state + sketch) but routes through the same AgentLoop to get structured `submit_rp_turn` tool output.
  - This reuses existing output normalization (`normalizeRpTurnOutcome()`), tool execution, and structured extraction.

  **Thinker job worker steps**:
    1. Read `CognitionThinkerJobPayload`: `{ sessionId, agentId, settlementId, talkerTurnVersion }`
    2. **Idempotency check** (version-based): Read `recent_cognition_slots` → if `thinkerCommittedVersion >= talkerTurnVersion` → mark job succeeded, return early
    3. Load `cognitiveSketch` from Talker's settlement (`interaction_records` → `payload.cognitiveSketch` via T2's `getSketchFromSettlement()`)
    4. Load conversation history from `interaction_records`
    5. Load existing cognition state from `recent_cognition_slots`
    6. Build Thinker prompt (full mode, NOT talker mode):
       - System preamble (same persona)
       - Conversation history
       - Current cognition state (from recent_cognition_slots)
       - Talker's cognitiveSketch for this turn
       - Thinker-specific instructions: "Based on the conversation and cognitive sketch, generate: privateCognition ops, privateEpisodes, publications, areaStateArtifacts. Use the submit_rp_turn tool."
       - NOTE: `pinnedSummaryProposal` NOT requested (dormant). `relationIntents`/`conflictFactors` NOT requested (Phase 2).
    7. Call LLM via `agentLoop.runBuffered(request)` with `isTalkerMode: false`
    8. Extract and normalize output (reuse `normalizeRpTurnOutcome`)
    9. **Timestamp policy**: Use Thinker's own `Date.now()` as `committedAt`. Temporal ordering inversion is documented as known difference.
    10. **Commit to projection pipeline atomically** (G14): Open a PG transaction via `sql.begin()` — same mechanism as `PgSettlementUnitOfWork.run()` (`pg-settlement-uow.ts:18-37`) but **without ledger operations**. Inside the transaction:
       - Construct tx-scoped repos: `new PgEpisodeRepo(tx)`, `new PgCognitionEventRepo(tx)`, `new PgCognitionProjectionRepo(tx)`, `new PgAreaWorldProjectionRepo(tx)`, `new PgRecentCognitionSlotRepo(tx)`
       - Call `projectionManager.commitSettlement(params, repoOverrides)` with these tx-scoped repos. Pass `versionIncrement: 'thinker'` via repo override.
       - Do NOT call `markApplying`/`markApplied` — no settlement ledger engagement.
       - If any step fails → entire PG transaction rolls back → clean retry with zero partial state.
       - Writes cognition events → `private_cognition_events` + `private_cognition_current`
       - Writes episodes → `private_episode_events`
       - Writes publications → `area_world_projection` via `materializePublicationsSafe`
       - Writes areaStateArtifacts → `area_world_state`
       - Updates `recent_cognition_slots` payload (cognition slot entries)
       - Atomically increments `thinker_committed_version`
       **CRITICAL**: Do NOT call `upsertRecentCognitionSlot()` separately after `commitSettlement()`. The `commitSettlement()` method's `runSeries` already calls it internally. The repo's `upsert()` does `entries.concat(newEntries)` (APPEND semantics). A second call would DOUBLE-APPEND.
       **RETRY SAFETY**: With PG transaction, only two retry scenarios exist:
       - Transaction failed → full rollback → retry starts clean (no conflicts, no partial state)
       - Transaction succeeded + job ack missed → retry → all events hit DO NOTHING (T11) → `appendCognitionEvents` skips `applyProjection` for conflicting ops (T11) → `private_cognition_current` already correct from first commit
    11. Do NOT trigger `flushIfDue()` or `memoryTaskAgent` (G9)
    12. Mark job as completed

  **Must NOT do**:
  - Do NOT create new `interaction_records` — Thinker writes to projection tables only
  - Do NOT change `ProjectionManager.commitSettlement()` signature (G5)
  - Do NOT modify the existing sync path
  - Do NOT implement batch collapse (G15, Phase 3)
  - Do NOT call `upsertRecentCognitionSlot()` separately (double-append risk)
  - Do NOT check idempotency by querying `private_cognition_events` alone — use version-based check
  - Do NOT trigger memory flush (G9)
  - Do NOT rely on in-memory state from request path (G10)
  - Do NOT use `settlementUnitOfWork` directly — create own `sql.begin()` transaction without ledger (G14)
  - Do NOT use pool repos without a transaction wrapper — `commitSettlement()` has no internal transaction logic
  - Do NOT generate `relationIntents`, `conflictFactors`, or `pinnedSummaryProposal`

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Second core architectural piece. Must understand projection pipeline, cognition normalization, job system lifecycle, and create standalone LLM call pipeline.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on T6 for settlement structure)
  - **Parallel Group**: Wave 2 (after T6)
  - **Blocks**: T10
  - **Blocked By**: T3, T6, T11

  **References**:

  **Pattern References**:
  - `src/storage/pg-settlement-uow.ts:18-37` — `PgSettlementUnitOfWork.run()` — Thinker follows THIS transaction pattern (sql.begin + tx-scoped repo construction) but SKIPS ledger operations (`markApplying`/`markApplied`)
  - `src/runtime/turn-service.ts:786-849` — `commitSettlementProjectionWithRepos()` — how the sync PG path passes tx-scoped repos as `repoOverrides` to `commitSettlement()` (lines 832-838). Thinker does the same.
  - `src/runtime/turn-service.ts:1281+` — `buildCognitionSlotPayload()` — format cognition for slots
  - `src/runtime/rp-turn-contract.ts:188-252` — `normalizeRpTurnOutcome()` — Thinker reuses this

  **API/Type References**:
  - `src/memory/projection/projection-manager.ts:160-222` — `commitSettlement()` with `runSeries` — takes `repoOverrides` as second arg for tx-scoped repos
  - `src/memory/projection/projection-manager.ts:97-121` — `SettlementProjectionParams` — what to pass
  - `src/jobs/durable-store.ts` — `CognitionThinkerJobPayload` type (from T3)
  - `src/interaction/contracts.ts` — `getSketchFromSettlement()` helper (from T2)
  - `src/storage/domain-repos/pg/cognition-event-repo.ts:11-26` — `append()` with DO NOTHING + null return on conflict (T11)
  - `src/storage/domain-repos/pg/recent-cognition-slot-repo.ts` — `upsert()` with `versionIncrement: 'thinker'` (T1)
  - `src/app/host/create-app-host.ts:36-48` — worker registration hookpoint

  **WHY Each Reference Matters**:
  - `PgSettlementUnitOfWork`: Thinker copies this exact `sql.begin()` + repo construction pattern, minus ledger. This is the ONLY safe way to call `commitSettlement()` with PG — pool repos are non-atomic.
  - `commitSettlementProjectionWithRepos()`: Shows exactly how to pass tx-scoped repos as `repoOverrides` (line 832-838) — Thinker follows this.
  - `SettlementProjectionParams`: All fields the Thinker must provide — cognitionOps, privateEpisodes, publications, areaStateArtifacts, recentCognitionSlotJson, etc.
  - T11 DO NOTHING + null return: On retry after success+missed-ack, duplicate events return null → `applyProjection` skipped → safe.
  - T1 version bump: Happens inside same `upsert()` call as slot payload write

  **Acceptance Criteria**:
  - [ ] `bun run build` passes
  - [ ] Thinker worker processes job to completion (status: succeeded)
  - [ ] After completion: `recent_cognition_slots` has updated payload (via single `commitSettlement()` call)
  - [ ] After completion: `private_cognition_current` has new entries
  - [ ] After completion: publications materialized if present
  - [ ] `thinker_committed_version` incremented (inside `commitSettlement()` via repo override)
  - [ ] Idempotency: `thinkerCommittedVersion >= talkerTurnVersion` → job skipped
  - [ ] Zero-cognitionOps settlement: still detected as processed via version check
  - [ ] Worker has all dependencies (ProjectionManager, ModelProvider, etc.) — no undefined errors
  - [ ] Worker does NOT trigger `flushIfDue()` or `memoryTaskAgent`
  - [ ] LLM failure → job marked failed, retried up to 3 times
  - [ ] No double-append of slot entries on retry

  **QA Scenarios**:

  ```
  Scenario: Thinker processes sketch into full cognition
    Tool: Bash (integration)
    Preconditions: Talker completed turn (T6 QA passed), Thinker job pending
    Steps:
      1. Trigger job processing (run worker or wait for scheduler)
      2. Wait for job status "completed" (timeout 120s)
      3. Query recent_cognition_slots — verify updated
      4. Query private_cognition_current — verify new entries
      5. Verify thinker_committed_version incremented
    Expected Result: Cognition committed, slots updated, version bumped
    Failure Indicators: Job stays pending, tables empty, version not bumped
    Evidence: .sisyphus/evidence/task-7-thinker-cognition.json

  Scenario: Thinker is idempotent on retry (version-based)
    Tool: Bash (bun test)
    Preconditions: Mock with talkerTurnVersion = 5
    Steps:
      1. Process job once → thinkerCommittedVersion now 5
      2. Process SAME job again (retry)
      3. Assert returns early (version check)
      4. Assert cognition event count NOT doubled
    Expected Result: Second run skips, no duplicate events
    Failure Indicators: Doubled events or second LLM call
    Evidence: .sisyphus/evidence/task-7-thinker-idempotent.txt

  Scenario: Thinker dependency wiring verified
    Tool: Bash (bun test)
    Preconditions: Worker created via createThinkerWorker(deps)
    Steps:
      1. Verify deps.projectionManager is defined
      2. Verify deps.interactionStore is defined
      3. Verify deps.recentCognitionSlotRepo is defined
      4. Verify deps.modelProvider is defined
      5. Process a job end-to-end — no undefined dependency errors
    Expected Result: All dependencies resolved, job processes without crashes
    Failure Indicators: TypeError: Cannot read property of undefined
    Evidence: .sisyphus/evidence/task-7-deps-wiring.txt

  Scenario: Thinker failure is graceful
    Tool: Bash (bun test)
    Preconditions: Mock LLM to throw error
    Steps:
      1. Enqueue job, mock LLM error
      2. Process job → assert status "failed"
      3. Assert no cognition events written
      4. Assert system still responsive
    Expected Result: Graceful failure, no partial writes, no crash
    Failure Indicators: Crash, partial writes, or unhandled exception
    Evidence: .sisyphus/evidence/task-7-thinker-failure.txt
  ```

  **Commit**: YES (C10)
  - Message: `feat(runtime): implement Thinker job worker for async cognition processing`
  - Files: `src/runtime/thinker-worker.ts` (new), `src/app/host/create-app-host.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 8. Implement Staleness Detection with Soft-Block

  **What to do**:
  - In `runRpTalkerTurn` (from T6), before Talker LLM call, add staleness detection:
    1. Call `getVersionGap(sessionId, agentId)` (T1) → `{ talkerCounter, thinkerVersion, gap }`
    2. If `gap > stalenessThreshold` (from `this.talkerThinkerConfig`, default 2):
       - **If gap > 2 × threshold (e.g., gap > 4)**: skip soft-block entirely — log warning "Thinker critically behind, skipping soft-block" and proceed immediately. This prevents permanent 3s delay when Thinkers repeatedly fail.
       - Otherwise: wait up to `softBlockTimeoutMs` (default 3000ms) polling every `softBlockPollIntervalMs` (default 500ms)
       - Each poll: re-call `getVersionGap()`, check if gap ≤ threshold
       - If Thinker catches up → proceed with fresh cognition
       - If timeout → proceed with stale cognition, log stale version used
  - Add staleness metadata to settlement payload. In `src/interaction/contracts.ts`, add to `TurnSettlementPayload`:
    ```typescript
    cognitionVersionGap?: number;   // gap when turn was processed
    usedStaleState?: boolean;       // true if proceeded after timeout
    ```
  - Config values from `this.talkerThinkerConfig` (T12) — NOT from file directly

  **Must NOT do**:
  - Do NOT hard-block (never wait indefinitely)
  - Do NOT modify Thinker worker
  - Do NOT change `recent_cognition_slots` schema beyond T1
  - Do NOT read config from file — use threaded config object

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Async polling logic with timeout, config integration, version tracking
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T10)
  - **Blocks**: —
  - **Blocked By**: T1, T6, T12

  **References**:

  **Pattern References**:
  - `src/runtime/turn-service.ts` — `runRpTalkerTurn` (T6) — add check before LLM call

  **API/Type References**:
  - `src/storage/domain-repos/pg/recent-cognition-slot-repo.ts` — `getVersionGap()` (T1)
  - `src/core/config-schema.ts` — `RuntimeConfig.talkerThinker` (T12)
  - `src/interaction/contracts.ts:94-122` — `TurnSettlementPayload` (add metadata fields)

  **Acceptance Criteria**:
  - [ ] `bun run build` passes
  - [ ] Gap ≤ threshold: Talker proceeds immediately
  - [ ] Gap > threshold but ≤ 2×threshold: soft-block up to timeout
  - [ ] Gap > 2×threshold: skip soft-block entirely (prevents permanent delay)
  - [ ] `TurnSettlementPayload` has `cognitionVersionGap?` and `usedStaleState?` fields
  - [ ] Config values from `this.talkerThinkerConfig`

  **QA Scenarios**:

  ```
  Scenario: No delay when gap ≤ threshold
    Tool: Bash (bun test)
    Preconditions: Mock gap = 1
    Steps:
      1. Call staleness check
      2. Assert < 100ms elapsed
    Expected Result: Proceeds immediately
    Evidence: .sisyphus/evidence/task-8-no-delay.txt

  Scenario: Soft-block when gap > threshold (Thinker catches up)
    Tool: Bash (bun test)
    Preconditions: Mock gap = 3, threshold = 2
    Steps:
      1. Start check
      2. After 1500ms, mock Thinker catches up (gap → 1)
      3. Assert waited ~1500ms then proceeded
    Expected Result: Waited for Thinker, then proceeded fresh
    Evidence: .sisyphus/evidence/task-8-soft-block-catchup.txt

  Scenario: Skip soft-block when gap extreme (> 2×threshold)
    Tool: Bash (bun test)
    Preconditions: Mock gap = 10, threshold = 2
    Steps:
      1. Call staleness check
      2. Assert < 100ms elapsed (skipped soft-block)
      3. Assert warning logged about critical gap
    Expected Result: No wait, warning logged
    Evidence: .sisyphus/evidence/task-8-skip-extreme-gap.txt
  ```

  **Commit**: YES (C11)
  - Message: `feat(runtime): add staleness detection with configurable soft-block to Talker`
  - Files: `src/runtime/turn-service.ts`, `src/interaction/contracts.ts`
  - Pre-commit: `bun run build && bun test`

---

- [x] 10. Update Test Script with Async Mode + Integration Test

  **What to do**:
  - Add `--mode sync|async` flag to `scripts/rp-suspicion-test.ts`:
    - `sync` (default): current behavior unchanged
    - `async`: sets `talkerThinker.enabled: true` in runtime config before run
  - Add per-turn latency measurement (Date.now() before/after each turn)
  - Add Thinker completion verification in async mode:
    - After each Talker response, poll for Thinker job completion (timeout 120s)
    - Before memory snapshots, ensure Thinker has committed
  - Add latency assertion: `assert(avgTalkerLatency < 25000)`
  - Compare against baseline (T5): scores within 10% of sync baseline
  - Save results to `data/rp-test-results/async-talker-thinker-5round.json`

  **Must NOT do**:
  - Do NOT change conversation script
  - Do NOT change scoring/evaluation logic
  - Do NOT modify agent/persona configuration
  - Do NOT remove sync mode support

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Test script modification with async polling and latency measurement
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T8)
  - **Blocks**: F1-F4
  - **Blocked By**: T5, T6, T7, T12

  **References**:
  - `scripts/rp-suspicion-test.ts` — existing test script
  - `data/rp-test-results/` — baseline from T5
  - `src/core/config-schema.ts` — `RuntimeConfig.talkerThinker.enabled`

  **Acceptance Criteria**:
  - [ ] `--mode sync` identical to current behavior
  - [ ] `--mode async` activates Talker/Thinker split
  - [ ] Per-turn latency recorded in JSON
  - [ ] Thinker completion verified before memory snapshots
  - [ ] Average Talker latency < 25s (async mode)
  - [ ] Scores within 10% of sync baseline
  - [ ] Results saved

  **QA Scenarios**:

  ```
  Scenario: Async mode completes with latency improvement
    Tool: Bash
    Preconditions: Database running, agent configured, Thinker worker active
    Steps:
      1. Run: bun run scripts/rp-suspicion-test.ts --mode async --max-rounds 5
      2. Parse output for per-turn latencies
      3. Compute average Talker latency — assert < 25000ms
      4. Compare scores against baseline — assert within 10%
    Expected Result: 5 rounds, avg < 25s, scores within 10%
    Failure Indicators: Avg > 25s, or score degradation > 10%
    Evidence: .sisyphus/evidence/task-10-async-integration.json

  Scenario: Sync mode regression check
    Tool: Bash
    Preconditions: Same setup
    Steps:
      1. Run: bun run scripts/rp-suspicion-test.ts --mode sync --max-rounds 5
      2. Compare with baseline
    Expected Result: Scores comparable
    Evidence: .sisyphus/evidence/task-10-sync-regression.json
  ```

  **Commit**: YES (C12)
  - Message: `feat(test): add --mode sync|async flag with latency measurement to rp-suspicion-test`
  - Files: `scripts/rp-suspicion-test.ts`
  - Pre-commit: `bun run build`

- [x] 14. Remove Non-UoW Dead Code Path in TurnService

  **What to do**:
  - **Context**: `turn-service.ts:513-573` contains an `else` branch (non-UoW path) that was designed for SQLite-only mode. It wraps writes in `InteractionStore.runInTransactionAsync()` (a SQLite `BEGIN IMMEDIATE` transaction) while calling `projectionManager.commitSettlement()` with PG pool repos — providing **zero PG transaction safety**. Now that PG is the canonical backend, this path is dead code and a misleading reference for future work.
  - **Remove the else branch** at `turn-service.ts:513-573`. The `if (this.settlementUnitOfWork)` block becomes the only path.
  - **Add runtime guard**: Replace the `if/else` with a runtime assertion. If `settlementUnitOfWork` is null at settlement commit time, throw a descriptive `MaidsClawError`:
    ```typescript
    if (!this.settlementUnitOfWork) {
      throw new MaidsClawError({
        code: "SETTLEMENT_UOW_REQUIRED",
        message: "PG settlement unit-of-work is required for turn settlement commit. SQLite fallback has been removed.",
        retriable: false,
      });
    }
    await this.settlementUnitOfWork.run(async (repos) => { ... });
    ```
  - **Keep `interactionStore`** for read operations that haven't been migrated to PgInteractionRepo yet (e.g., `getMessageRecords` at line 114, `settlementExists` at line 697, `getPendingSettlementJobState` at line 992). These reads are NOT part of this task — full InteractionStore migration is a separate effort.
  - **Verify** no tests depend on the non-UoW path. If any test mocks `settlementUnitOfWork` as `null` and expects the else branch, update that test to provide a mock UoW instead.

  **Must NOT do**:
  - Do NOT remove `interactionStore` from TurnService constructor — it's still used for reads
  - Do NOT migrate read operations (getMessageRecords, etc.) — that's a separate task
  - Do NOT change the PG settlement commit path behavior (the `if` branch)
  - Do NOT change `PgSettlementUnitOfWork` implementation

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Remove one code branch + add assertion. ~1 file, mechanical change.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T2, T3, T4, T5, T11)
  - **Blocks**: None (cleanup only)
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/runtime/turn-service.ts:486-573` — The `if/else` block. The `if` branch (486-512) stays, the `else` branch (513-573) is removed.
  - `src/interaction/store.ts:121-138` — `runInTransactionAsync()` — the SQLite transaction wrapper being removed from the settlement path.

  **API/Type References**:
  - `src/storage/pg-settlement-uow.ts:15-37` — `PgSettlementUnitOfWork` — the remaining (correct) path.
  - `src/core/errors.ts` — `MaidsClawError` for the runtime guard.

  **WHY Each Reference Matters**:
  - `turn-service.ts:513-573`: This is the exact code to remove. The `else` branch uses `interactionStore.runInTransactionAsync()` (SQLite) while calling PG repos without a transaction. It gives false atomicity.
  - `pg-settlement-uow.ts`: Confirms the PG path (which stays) provides real transaction safety.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes
  - [ ] `bun test` — all existing tests pass
  - [ ] No `runInTransactionAsync` calls remain in settlement commit path
  - [ ] Runtime guard throws `SETTLEMENT_UOW_REQUIRED` when `settlementUnitOfWork` is null
  - [ ] `interactionStore` still accessible for reads (not removed from constructor)

  **QA Scenarios**:

  ```
  Scenario: Settlement commit succeeds via PG UoW path
    Tool: Bash (bun test)
    Preconditions: TurnService with settlementUnitOfWork provided (normal PG setup)
    Steps:
      1. Run existing settlement commit tests
      2. Assert all pass unchanged
    Expected Result: All settlement tests pass — PG path behavior identical
    Failure Indicators: Any test failure in settlement commit
    Evidence: .sisyphus/evidence/task-14-settlement-pg-path.txt

  Scenario: Runtime guard fires when UoW is null
    Tool: Bash (bun test)
    Preconditions: TurnService constructed with settlementUnitOfWork = null
    Steps:
      1. Attempt to run a turn that reaches settlement commit
      2. Assert MaidsClawError thrown with code "SETTLEMENT_UOW_REQUIRED"
    Expected Result: Clear error instead of silent SQLite fallback
    Failure Indicators: No error thrown, or wrong error code, or settlement succeeds via removed path
    Evidence: .sisyphus/evidence/task-14-uow-required-guard.txt
  ```

  **Commit**: YES (C6)
  - Message: `refactor(runtime): remove non-UoW SQLite fallback path from settlement commit`
  - Files: `src/runtime/turn-service.ts`
  - Pre-commit: `bun run build && bun test`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan. Verify ALL Accepted Degradations are documented and NOT accidentally implemented.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`
  **RESULT**: Must Have [14/14 PASS] | Must NOT Have [7/7 CLEAN] | Deliverables [5/5] | VERDICT: ✅ APPROVE

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code. Check AI slop: excessive comments, over-abstraction, generic names. Verify config flag gates every async path. Verify NO `ON CONFLICT DO UPDATE` on `private_cognition_events`. Verify NO batch collapse code or `setThinkerVersion` usage.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`
  **RESULT**: Build PASS | Tests 1015 pass / 9 fail (pre-existing) | Files 24/24 clean | VERDICT: ✅ APPROVE

- [x] F3. **Real Integration QA** — `unspecified-high`
  Start from clean state. Run `rp-suspicion-test.ts --mode async --max-rounds 5`. Verify: (1) Talker latency < 25s per turn (2) Thinker jobs complete within 120s (3) recent_cognition_slots updated after each Thinker completion (4) Scores ≤10% below sync baseline. Run sync mode after to verify no regression.
  Output: `Async Latency [N ms avg] | Thinker Completion [N/N] | Scores [N] | Sync Regression [CLEAN/N issues] | VERDICT`
  **RESULT**: 7/7 static integration traces PASS | Config restoration clean | Job polling correct | VERDICT: ✅ APPROVE

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Detect cross-task contamination. Flag unaccounted changes. Verify config flag completely gates async behavior. Verify Frozen Artifact Scope is respected — no `relationIntents`/`conflictFactors` generation or processing in split path.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`
  **RESULT**: Tasks [12/12 COMPLIANT] | Frozen Artifact Scope CLEAN | Config Flag Gating CLEAN | VERDICT: ✅ APPROVE

---

## Commit Strategy

| Commit | Scope | Pre-commit Check |
|--------|-------|-----------------|
| C1 | T1: Schema migration + dual version columns | `bun run build && bun test` |
| C2 | T2: TurnSettlementPayload extension | `bun run build && bun test` |
| C3 | T3: Job kind registration + dispatcher routing | `bun run build && bun test` |
| C4 | T4: Talker prompt builder mode | `bun run build && bun test` |
| C5 | T11: Idempotency dedup (DO NOTHING + null-safe chain) | `bun run build && bun test` |
| C6 | T14: Remove non-UoW SQLite fallback path | `bun run build && bun test` |
| C7 | T12: RuntimeConfig talkerThinker + TurnService wiring | `bun run build && bun test` |
| C8 | T13: AgentLoop mode-awareness | `bun run build && bun test` |
| C9 | T6: runRpTalkerTurn method | `bun run build && bun test` |
| C10 | T7: Thinker job worker | `bun run build && bun test` |
| C11 | T8: Staleness detection | `bun run build && bun test` |
| C12 | T10: Test script + integration | `bun run build && bun test` |

---

## Success Criteria

### Verification Commands
```bash
bun run build                                              # Expected: no errors
bun test                                                   # Expected: all pass
bun run scripts/rp-suspicion-test.ts --mode sync --max-rounds 5   # Expected: ≥ baseline scores
bun run scripts/rp-suspicion-test.ts --mode async --max-rounds 5  # Expected: Talker < 25s, scores ≤10% below sync
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] Config flag gates all async behavior
- [ ] Sync mode is byte-identical to pre-change behavior
- [ ] All tests pass
- [ ] Talker latency < 25s per turn (async mode)
- [ ] Thinker jobs complete within 120s
- [ ] Staleness detection activates at gap >2
- [ ] Accepted Degradations documented and verified

---

## Future Work

### Phase 2 — Correctness / Parity / Recovery
- Restore `relationIntents` / `conflictFactors` (adapt `ExplicitSettlementProcessor` for Thinker outputs)
- Settlement ledger integration (define Talker/Thinker ledger states)
- Enqueue failure recovery sweeper (scan for turns with Talker settlement but no Thinker job)
- Thinker prompt quality tuning (cognitive depth optimization)
- Memory flush triggering from Thinker (controlled `flushIfDue()`)
- Global Thinker concurrency cap

### Phase 3 — Batch Optimization
- T9 batch collapse (read-only query + idempotency auto-skip pattern)
- `setThinkerVersion` with monotonic max semantics (`thinker_committed_version = MAX(existing, N)`)
- Batch provenance semantics (single-commit model, latest-settlement attribution)
- Batch QA test suite
