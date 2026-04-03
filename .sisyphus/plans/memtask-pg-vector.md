# MemoryTaskAgent Full PG Migration + Vector Branch Wiring

## TL;DR

> **Quick Summary**: Migrate all ~50 `db.prepare()`/`db.exec()` calls across 5 components (MemoryTaskAgent, CognitionRepository, RelationBuilder, ExplicitSettlementProcessor, relation-intent-resolver) from SQLite `Db` to PG-native async repos. Additionally, make EmbeddingService fully async (remove Bun.peek sync bridge) and wire the `localizeSeedsHybrid` vector/semantic search branch so GraphNavigator produces query embeddings for hybrid lexical+vector retrieval.
> 
> **Deliverables**:
> - PgRelationWriteRepo (NEW — covers memory_relations writes for RelationBuilder + relation-intent-resolver)
> - Extended PgSearchProjectionRepo (add `updateCognitionSearchDocStance`)
> - PG-native CognitionRepository (refactored from SQLite db to PG repos, ~25 calls migrated)
> - PG-native RelationBuilder (refactored, ~8 calls)
> - PG-native ExplicitSettlementProcessor (refactored, ~6 calls)
> - PG-native relation-intent-resolver (refactored, ~3 calls)
> - PG-native MemoryTaskAgent (refactored, ~11 calls, `sql.begin()` transactions)
> - Async EmbeddingService (queryNearestNeighbors returns Promise, Bun.peek removed)
> - Vector branch wired: GraphNavigator generates queryEmbedding → passes to localizeSeedsHybrid
> - Runtime.ts re-wired with PG repos, `throwingMemoryDbAdapter` removed
> - TDD test suite for every migrated component
> 
> **Estimated Effort**: XL
> **Parallel Execution**: YES — 4 waves
> **Critical Path**: T1-T2 (parallel) → T3-T6 (parallel) → T7-T8 → T9-T10 (parallel) → T11-T12 → T13 → F1-F4

---

## Context

### Original Request
User identified that MemoryTaskAgent's flush chain crashes at runtime because bootstrap passes `throwingMemoryDbAdapter` — all `db.prepare()`/`db.exec()` calls throw "SQLite is retired". Additionally, `localizeSeedsHybrid` vector branch never fires because `queryEmbedding` is never generated or passed.

### Interview Summary
**Key Discussions**:
- Migration scope: **A) Full migration** — all 5 components, ~50 db calls
- Vector strategy: **Full async化** — remove Bun.peek sync bridge
- Test strategy: **TDD** (RED-GREEN-REFACTOR)
- Event-sourcing pattern: **Keep dual-write** (append event + direct UPSERT) for safer mechanical port
- Transaction management: **Use PgSettlementUnitOfWork pattern** (`sql.begin()` with tx-scoped repos)
- FTS table: **Drop search_docs_cognition_fts sync** — PG trigram on search_docs_cognition replaces SQLite FTS5

**Research Findings**:
- 5 components with db dependencies (not 4 — relation-intent-resolver is separate)
- ~50 total db.prepare/exec calls (not ~45)
- CognitionRepository is the largest (1065 lines, ~25 calls, 7-stance state machine)
- Existing PG repos cover ~60% of needed queries; ~40% need new repo methods
- EmbeddingLinker and GraphOrganizer are additional callers of queryNearestNeighbors
- MemoryTaskModelProviderAdapter.embed() already exists and works

### Metis Review
**Identified Gaps** (addressed):
- **relation-intent-resolver is a 5th unmigrated component**: 3 db.prepare calls. Added as explicit scope.
- **search_docs_cognition_fts has no PG equivalent**: SQLite FTS5 table. Decision: DROP sync calls (PG trigram replaces FTS5).
- **Event-sourcing pattern mismatch**: CognitionRepo does dual-write; PgCognitionProjectionRepo is event-driven. Decision: Keep dual-write for safe mechanical port.
- **EmbeddingLinker + GraphOrganizer are additional async callers**: Added to scope (trivial await additions).
- **PgSettlementUnitOfWork should be used for transactions**: Agreed — consistent with codebase pattern.
- **Null vs undefined semantics differ**: PG returns `[]` not `undefined` for no-row. All `.get()` conversions must check `.length`.
- **CognitionRepository created multiple times**: Lines 628, 678. Decision: Create once in constructor, inject.
- **Missing PG repo methods**: `updateCognitionSearchDocStance`, entity resolution, `upsertCognitionDoc` interface gap.

---

## Work Objectives

### Core Objective
Eliminate all SQLite `Db`/`DbLike` dependencies from the memory flush/settlement chain (MemoryTaskAgent → CognitionRepository → RelationBuilder → ExplicitSettlementProcessor → relation-intent-resolver) so that `runMigrateInternal()` runs without error against PG. Simultaneously make EmbeddingService fully async and wire the vector/semantic search branch.

### Concrete Deliverables
- `src/storage/domain-repos/pg/relation-write-repo.ts` — NEW: memory_relations writes
- `src/storage/domain-repos/contracts/relation-write-repo.ts` — NEW: write contract
- `src/storage/domain-repos/pg/search-projection-repo.ts` — EXTENDED: add missing methods
- `src/memory/cognition/cognition-repo.ts` — REFACTORED: PG-native, all ~25 db calls replaced
- `src/memory/cognition/cognition-event-repo.ts` — REFACTORED if needed
- `src/memory/cognition/relation-builder.ts` — REFACTORED: PG-native, ~8 db calls
- `src/memory/cognition/relation-intent-resolver.ts` — REFACTORED: ~3 db calls
- `src/memory/explicit-settlement-processor.ts` — REFACTORED: ~6 db calls
- `src/memory/task-agent.ts` — REFACTORED: ~11 db calls, sql.begin() transactions
- `src/memory/embeddings.ts` — REFACTORED: async, Bun.peek removed
- `src/memory/navigator.ts` — MODIFIED: generates queryEmbedding, passes to localizeSeedsHybrid
- `src/memory/retrieval.ts` — MODIFIED: accepts embed provider
- `src/bootstrap/runtime.ts` — RE-WIRED: PG repos, throwingMemoryDbAdapter removed

### Definition of Done
- [ ] `bun run build` — zero type errors
- [ ] `bun test` — all tests pass
- [ ] `ast_grep_search` for `this.db.prepare` in src/memory/ → ZERO results
- [ ] `ast_grep_search` for `this.db.exec` in src/memory/ → ZERO results
- [ ] `ast_grep_search` for `Bun.peek` in src/memory/ → ZERO results
- [ ] `throwingMemoryDbAdapter` removed from runtime.ts
- [ ] `MemoryTaskAgent.runMigrateInternal()` completes without error when flush triggers
- [ ] `localizeSeedsHybrid` vector branch fires when embedding model is configured
- [ ] All 7 cognition stances produce correct PG writes (assertion/evaluation/commitment)

### Must Have
- All ~50 db.prepare/exec calls replaced with PG repo async equivalents
- Transaction boundaries via `sql.begin()` (not `BEGIN IMMEDIATE`)
- CognitionRepository: event append + projection update remain atomic within sql.begin()
- RelationBuilder: ON CONFLICT DO UPDATE semantics preserved for memory_relations
- search_docs_cognition_fts sync calls removed (PG trigram replaces SQLite FTS5)
- EmbeddingService.queryNearestNeighbors returns Promise (not sync via Bun.peek)
- GraphNavigator.explore() generates queryEmbedding via MemoryTaskModelProviderAdapter.embed()
- TDD for every component

### Must NOT Have (Guardrails)
- ❌ Do NOT modify `belief-revision.ts` — pure domain logic, stance transitions unchanged
- ❌ Do NOT change the public API of MemoryTaskAgent (same method signatures)
- ❌ Do NOT change CognitionRepository's 7-stance state machine logic
- ❌ Do NOT optimize PG queries during migration — 1:1 semantic port first
- ❌ Do NOT migrate GraphOrganizer or CoreMemoryIndexUpdater internal logic (only update their await calls)
- ❌ Do NOT change the event-sourcing invariant: append to events BEFORE projecting to current
- ❌ Do NOT add new search capabilities while wiring vector branch
- ❌ Do NOT create PG integration test infrastructure (use interface-based unit tests; integration tests are follow-up)
- ❌ Do NOT add unnecessary abstractions — each PG method maps 1:1 to existing db.prepare call
- ❌ Do NOT add AI slop: excessive JSDoc, over-abstraction, generic variable names

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: TDD (RED-GREEN-REFACTOR)
- **Framework**: bun test
- **Pattern**: Interface-based unit tests with mocked PG repos. Each task writes tests FIRST.

### QA Policy
Every task MUST include agent-executed QA scenarios. Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — new PG repos):
├── Task 1: PgRelationWriteRepo (NEW — memory_relations writes) [deep]
└── Task 2: Extend PgSearchProjectionRepo + PgCognitionProjectionRepo [quick]

Wave 2 (After Wave 1 — component migrations, MAX PARALLEL):
├── Task 3: Migrate CognitionRepository to PG [deep]
├── Task 4: Migrate CognitionEventRepo to PG [quick]
├── Task 5: Migrate RelationBuilder to PG [deep]
└── Task 6: Migrate relation-intent-resolver to PG [quick]

Wave 3 (After Wave 2 — consumers):
├── Task 7: Migrate ExplicitSettlementProcessor to PG [deep]
└── Task 8: Migrate MemoryTaskAgent to PG + sql.begin() transactions [deep]

Wave 4 (After Wave 3 — async + vector, PARALLEL):
├── Task 9: EmbeddingService async化 (remove Bun.peek) [deep]
└── Task 10: Wire vector branch in GraphNavigator [quick]

Wave 5 (After Wave 4 — wiring + cleanup):
├── Task 11: Re-wire runtime.ts (remove throwingMemoryDbAdapter) [deep]
└── Task 12: Remove all DbLike/MemoryTaskDbAdapter types + dead imports [quick]

Wave 6 (After all — integration):
└── Task 13: Full chain integration test [deep]

Wave FINAL (After ALL — 4 parallel reviews):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real manual QA (unspecified-high)
└── F4: Scope fidelity check (deep)
→ Present results → Get explicit user okay

Critical Path: T1+T2 → T3 → T7 → T8 → T11 → T13 → F1-F4
Max Concurrent: 4 (Wave 2)
```

### Dependency Matrix

| Task | Blocked By | Blocks |
|------|-----------|--------|
| T1 (PgRelationWriteRepo) | — | T5, T6 |
| T2 (Extend PG repos) | — | T3, T7 |
| T3 (CognitionRepository) | T2 | T7, T8 |
| T4 (CognitionEventRepo) | — | T3 |
| T5 (RelationBuilder) | T1 | T7 |
| T6 (relation-intent-resolver) | T1 | T7 |
| T7 (ExplicitSettlementProcessor) | T3, T5, T6 | T8 |
| T8 (MemoryTaskAgent) | T3, T7 | T11 |
| T9 (EmbeddingService async) | — | T10, T11 |
| T10 (Vector branch) | T9 | T11 |
| T11 (Wire runtime.ts) | T8, T10 | T12 |
| T12 (Cleanup dead types) | T11 | T13 |
| T13 (Integration tests) | T12 | F1-F4 |

### Agent Dispatch Summary

- **Wave 1**: **2** — T1 → `deep`, T2 → `quick`
- **Wave 2**: **4** — T3 → `deep`, T4 → `quick`, T5 → `deep`, T6 → `quick`
- **Wave 3**: **2** — T7 → `deep`, T8 → `deep`
- **Wave 4**: **2** — T9 → `deep`, T10 → `quick`
- **Wave 5**: **2** — T11 → `deep`, T12 → `quick`
- **Wave 6**: **1** — T13 → `deep`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [ ] 1. PgRelationWriteRepo — NEW PG repo for memory_relations writes

  **What to do**:
  - RED: Write tests for `PgRelationWriteRepo` covering all write operations on `memory_relations`
  - GREEN: Implement in `src/storage/domain-repos/pg/relation-write-repo.ts`
  - Queries to implement (from RelationBuilder + relation-intent-resolver):
    1. `upsertRelation(params)` — `INSERT INTO memory_relations ... ON CONFLICT(source_node_ref, target_node_ref, relation_type, source_kind, source_ref) DO UPDATE SET strength=?, directness=?, updated_at=?` (RelationBuilder L139-157, relation-intent-resolver L214-228)
    2. `getRelationsBySource(sourceNodeRef, relationType?)` — `SELECT FROM memory_relations WHERE source_node_ref=?` (RelationBuilder L170-178)
    3. `getRelationsForNode(nodeRef, relationTypes)` — `SELECT FROM memory_relations WHERE (source_node_ref=? OR target_node_ref=?) AND relation_type IN (...)` (RelationBuilder L204-213)
  - Define contract interface in `src/storage/domain-repos/contracts/relation-write-repo.ts`
  - Note: PgRelationReadRepo (from Plan B Task 3) already exists for read-only conflict queries — this new repo handles writes + the reads that RelationBuilder needs internally

  **Must NOT do**:
  - Do NOT modify PgRelationReadRepo — it stays for CognitionSearchService
  - Do NOT change the memory_relations schema or constraints

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Tasks 5, 6
  - **Blocked By**: None

  **References**:
  - `src/memory/cognition/relation-builder.ts:139-213` — Source SQL for all 3 write/read queries
  - `src/memory/cognition/relation-intent-resolver.ts:214-228` — Duplicate upsert pattern
  - `src/storage/domain-repos/pg/relation-read-repo.ts` — Existing read repo pattern
  - `src/storage/domain-repos/contracts/relation-read-repo.ts` — Existing contract
  - `test/pg-app/pg-relation-read-repo.test.ts` — Test pattern to follow

  **Acceptance Criteria**:
  - [ ] Contract: `src/storage/domain-repos/contracts/relation-write-repo.ts`
  - [ ] Impl: `src/storage/domain-repos/pg/relation-write-repo.ts`
  - [ ] Test: `test/pg-app/pg-relation-write-repo.test.ts` → PASS
  - [ ] ON CONFLICT upsert semantics verified (unique constraint on 5-column key)

  **QA Scenarios**:
  ```
  Scenario: Upsert relation creates new and updates existing
    Tool: Bash (bun test)
    Steps: Insert new relation → verify created. Insert same key with different strength → verify updated (not duplicated).
    Evidence: .sisyphus/evidence/task-1-relation-upsert.txt

  Scenario: Query by source and type filters correctly
    Tool: Bash (bun test)
    Steps: Insert 3 relations with different types → query by specific type → verify only matching returned.
    Evidence: .sisyphus/evidence/task-1-relation-query.txt
  ```

  **Commit**: YES (groups with T2)

- [ ] 2. Extend PgSearchProjectionRepo + PgCognitionProjectionRepo — Add missing methods

  **What to do**:
  - RED: Write tests for new methods
  - GREEN: Add to existing PG repos:
    1. `PgSearchProjectionRepo.updateCognitionSearchDocStance(agentId, cognitionKey, stance, updatedAt)` — `UPDATE search_docs_cognition SET stance=?, updated_at=? WHERE agent_id=? AND cognition_key=?` (CognitionRepo L956, L973)
    2. `PgCognitionProjectionRepo.updateConflictFactors(agentId, cognitionKey, conflictSummary, conflictFactorRefsJson, updatedAt)` — `UPDATE private_cognition_current SET conflict_summary=?, conflict_factor_refs_json=?, updated_at=? WHERE agent_id=? AND cognition_key=?` (ESP L417-431)
    3. `PgCognitionProjectionRepo.updateSourceEventRef(id, sourceEventRef, updatedAt)` — `UPDATE private_cognition_current SET source_event_ref=?, updated_at=? WHERE id=?` (MemoryTaskAgent L819-821)
    4. `PgCognitionProjectionRepo.resolveEntityByPointerKey(pointerKey, agentId)` — `SELECT id FROM entity_nodes WHERE pointer_key=? AND (memory_scope='private_overlay' AND owner_agent_id=?)` then fallback to `shared_public` (CognitionRepo L783-818). NOTE: PgGraphMutableStoreRepo already has a similar method — check if reusable.
    5. Extend `SearchProjectionRepo` contract interface to include `upsertCognitionDoc()` (currently on impl only, not interface)
  - Drop `search_docs_cognition_fts` sync methods — not needed in PG (trigram on `search_docs_cognition` replaces FTS5)

  **Must NOT do**:
  - Do NOT change existing method signatures — only add new ones
  - Do NOT modify the search_docs_cognition table schema

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Tasks 3, 7
  - **Blocked By**: None

  **References**:
  - `src/storage/domain-repos/pg/search-projection-repo.ts` — Existing repo to extend
  - `src/storage/domain-repos/pg/cognition-projection-repo.ts` — Existing repo to extend
  - `src/memory/cognition/cognition-repo.ts:783-818,956,973` — Source SQL for entity resolution, stance update
  - `src/memory/explicit-settlement-processor.ts:417-431` — Source SQL for conflict factor update

  **Acceptance Criteria**:
  - [ ] `bun test test/pg-app/pg-search-projection-repo.test.ts` → PASS (new methods)
  - [ ] `bun test test/pg-app/pg-cognition-projection-repo.test.ts` → PASS (new methods)  
  - [ ] `upsertCognitionDoc` is on the SearchProjectionRepo contract interface

  **QA Scenarios**:
  ```
  Scenario: updateCognitionSearchDocStance updates only stance column
    Tool: Bash (bun test)
    Steps: Seed doc → update stance → verify only stance and updated_at changed.
    Evidence: .sisyphus/evidence/task-2-stance-update.txt

  Scenario: resolveEntityByPointerKey returns private_overlay before shared_public
    Tool: Bash (bun test)
    Steps: Seed entity with both scopes → resolve → verify private_overlay wins.
    Evidence: .sisyphus/evidence/task-2-entity-resolution.txt
  ```

  **Commit**: YES (groups with T1)

- [ ] 3. Migrate CognitionRepository to PG — Replace all ~25 db.prepare calls

  **What to do**:
  - RED: Write tests for every public method with PG-backed repos
  - GREEN: Refactor `src/memory/cognition/cognition-repo.ts`:
    1. Change constructor: remove `db: DbLike`, accept PG repos: `{ cognitionProjectionRepo, cognitionEventRepo, searchProjectionRepo, entityResolver }` where `entityResolver` is a function `(pointerKey: string, agentId: string) => Promise<number | null>`
    2. Replace all ~25 `this.db.prepare(...)` calls with corresponding PG repo method calls
    3. Make ALL public methods async (return `Promise<...>`)
    4. Replace `runInTransaction()` with PG transaction scoping — the caller (MemoryTaskAgent) manages the `sql.begin()`, CognitionRepo operates within passed transaction context
    5. Replace `new CognitionEventRepo(db)` with injected PgCognitionEventRepo
    6. Drop `search_docs_cognition_fts` DELETE/INSERT calls (L1018-1020) — PG trigram replaces FTS5
    7. Replace `INSERT OR REPLACE INTO search_docs_cognition` with `searchProjectionRepo.upsertCognitionDoc()` (from Task 2)
    8. Replace stance update on search_docs with `searchProjectionRepo.updateCognitionSearchDocStance()` (from Task 2)
    9. Replace entity_nodes pointer resolution with `entityResolver` function (uses PgCognitionProjectionRepo.resolveEntityByPointerKey from Task 2, or PgGraphMutableStoreRepo)
  - Keep the dual-write pattern: append event → project to current (do NOT switch to event-only replay)
  - Preserve all 7-stance state machine logic exactly as-is

  **Must NOT do**:
  - Do NOT modify `belief-revision.ts`
  - Do NOT change stance transition rules
  - Do NOT change the event append → projection update ordering
  - Do NOT optimize queries during migration

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 1065 lines, ~25 db calls, 7-stance state machine — highest risk component
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T4, T5, T6)
  - **Parallel Group**: Wave 2
  - **Blocks**: Tasks 7, 8
  - **Blocked By**: Task 2 (extended PG repos)

  **References**:
  - `src/memory/cognition/cognition-repo.ts:136-1065` — Full class being migrated
  - `src/memory/cognition/belief-revision.ts` — Pure logic, DO NOT TOUCH
  - `src/storage/domain-repos/pg/cognition-projection-repo.ts` — PG repo for private_cognition_current
  - `src/storage/domain-repos/pg/cognition-event-repo.ts` — PG repo for private_cognition_events
  - `src/storage/domain-repos/pg/search-projection-repo.ts` — PG repo for search_docs_cognition

  **Acceptance Criteria**:
  - [ ] Test: `test/memory/cognition-repo-pg.test.ts` → PASS
  - [ ] All 7 assertion stances tested: hypothetical, tentative, accepted, confirmed, contested, rejected, abandoned
  - [ ] Event append + projection UPSERT verified atomic within PG transaction
  - [ ] Entity pointer resolution: private_overlay priority over shared_public
  - [ ] search_docs_cognition sync verified (upsert + stance update)
  - [ ] ZERO `db.prepare()` / `DbLike` references remain in cognition-repo.ts
  - [ ] `belief-revision.ts` unchanged (`git diff` shows zero changes)

  **QA Scenarios**:
  ```
  Scenario: Full 7-stance assertion lifecycle via PG
    Tool: Bash (bun test)
    Steps: Create hypothetical → upgrade to tentative → confirmed → contested (with preContestedStance) → verify all PG writes correct. Separately test rejected + abandoned terminal stances.
    Evidence: .sisyphus/evidence/task-3-stance-lifecycle.txt

  Scenario: Retraction is idempotent
    Tool: Bash (bun test)
    Steps: Retract assertion → retract again → verify no error (double-retract is silent no-op).
    Evidence: .sisyphus/evidence/task-3-retraction.txt

  Scenario: No DbLike references remain
    Tool: Bash (grep)
    Steps: `grep -n "DbLike\|db\.prepare\|db\.exec" src/memory/cognition/cognition-repo.ts` → zero matches.
    Evidence: .sisyphus/evidence/task-3-no-sqlite.txt
  ```

  **Commit**: YES (groups with T4)

- [ ] 4. Migrate CognitionEventRepo internal SQLite adapter to PG

  **What to do**:
  - CognitionRepository creates `new CognitionEventRepo(db)` internally. CognitionEventRepo (`src/memory/cognition/cognition-event-repo.ts`) wraps `db` for append/read operations on `private_cognition_events`.
  - PgCognitionEventRepo already exists. Task: Make CognitionRepository (from Task 3) accept and use PgCognitionEventRepo directly instead of creating its own `new CognitionEventRepo(db)`.
  - This is mostly a wiring change — verify PgCognitionEventRepo's interface matches CognitionEventRepo's API surface.
  - If interface mismatch: create thin adapter or extend PgCognitionEventRepo.

  **Recommended Agent Profile**: `quick`
  **Parallelization**: Wave 2, parallel with T3/T5/T6. Blocks T3 (CognitionRepo needs PG event repo). Blocked by nothing.

  **References**:
  - `src/memory/cognition/cognition-event-repo.ts` — Current SQLite-based event repo
  - `src/storage/domain-repos/pg/cognition-event-repo.ts` — PG version

  **Acceptance Criteria**:
  - [ ] PgCognitionEventRepo interface covers all methods used by CognitionRepository
  - [ ] Test verifying event append + read works via PG repo

  **Commit**: YES (groups with T3)

- [ ] 5. Migrate RelationBuilder to PG — Replace ~8 db.prepare calls

  **What to do**:
  - RED: Write tests for PG-native RelationBuilder
  - GREEN: Refactor `src/memory/cognition/relation-builder.ts`:
    1. Change constructor: remove `db: DbLike`, accept `{ relationWriteRepo, cognitionProjectionRepo }` (from Tasks 1, 2)
    2. Replace `writeRelation()` (L139-157) with `relationWriteRepo.upsertRelation()`
    3. Replace `getRelationsBySource()` (L170-178) with `relationWriteRepo.getRelationsBySource()`
    4. Replace `getRelationsForNode()` (L204-213) with `relationWriteRepo.getRelationsForNode()`
    5. Replace entity resolution queries (L256-283) with `cognitionProjectionRepo.getCurrent()` or similar
    6. Replace cognition key resolution (L302-325) with `cognitionProjectionRepo.getCurrent()`
    7. Make all methods async
  - `writeContestRelations()` — the main write method called by ExplicitSettlementProcessor

  **Must NOT do**: Do NOT change the conflict detection logic (which edges to create)

  **Recommended Agent Profile**: `deep`
  **Parallelization**: Wave 2, parallel with T3/T4/T6. Blocks T7. Blocked by T1.

  **References**:
  - `src/memory/cognition/relation-builder.ts` — Full class being migrated
  - `src/storage/domain-repos/pg/relation-write-repo.ts` — From Task 1

  **Acceptance Criteria**:
  - [ ] Test: `test/memory/relation-builder-pg.test.ts` → PASS
  - [ ] `writeContestRelations` creates correct memory_relations rows via PG
  - [ ] ZERO `DbLike`/`db.prepare` references remain

  **Commit**: YES (groups with T6)

- [ ] 6. Migrate relation-intent-resolver to PG — Replace ~3 db.prepare calls

  **What to do**:
  - Refactor `src/memory/cognition/relation-intent-resolver.ts`:
    1. `materializeRelationIntents()` (L214-228): currently accepts `db: DbLike`. Change to accept `relationWriteRepo` from Task 1.
    2. `resolveConflictFactors()` / `resolveFactorNodeRef()` (L340-353): currently accepts `db: DbLike`. Change to accept `cognitionProjectionRepo` for cognition key lookups.
    3. These are FREE FUNCTIONS (not class methods). Change parameter types from `DbLike` to PG repo interfaces.
    4. Make all functions async.
  - Update ExplicitSettlementProcessor callers to pass PG repos instead of `this.db`.

  **Recommended Agent Profile**: `quick`
  **Parallelization**: Wave 2, parallel with T3/T4/T5. Blocks T7. Blocked by T1.

  **References**:
  - `src/memory/cognition/relation-intent-resolver.ts:214-353` — Functions being migrated
  - `src/memory/explicit-settlement-processor.ts:180,182` — Callers

  **Acceptance Criteria**:
  - [ ] Test: `test/memory/relation-intent-resolver-pg.test.ts` → PASS
  - [ ] ZERO `DbLike` references remain in relation-intent-resolver.ts

  **Commit**: YES (groups with T5)

- [ ] 7. Migrate ExplicitSettlementProcessor to PG — Replace ~6 db.prepare calls

  **What to do**:
  - RED: Write tests for PG-backed ExplicitSettlementProcessor
  - GREEN: Refactor `src/memory/explicit-settlement-processor.ts`:
    1. Change `ExplicitSettlementProcessorDeps.db` type: from `ExplicitSettlementDbAdapter` to PG repos (or remove `db` entirely, replace with specific repos)
    2. Replace L341-347 (`SELECT FROM private_episode_events WHERE settlement_id=?`) with `episodeRepo.readBySettlement()`
    3. Replace L360-366 (`SELECT FROM event_nodes WHERE source_settlement_id=?`) with new repo method or direct PG query
    4. Replace L417-431 (`UPDATE private_cognition_current SET conflict_summary=?`) with `cognitionProjectionRepo.updateConflictFactors()` (from Task 2)
    5. Update calls to `materializeRelationIntents()` and `resolveConflictFactors()` — pass PG repos (from Task 6)
    6. Constructor no longer receives `db` — receives PG repos for cognitionRepo, relationBuilder (both migrated in T3, T5)

  **Must NOT do**: Do NOT change settlement processing logic (which ops are processed, in what order)

  **Recommended Agent Profile**: `deep`
  **Parallelization**: Wave 3, with T8. Blocks T8. Blocked by T3, T5, T6.

  **References**:
  - `src/memory/explicit-settlement-processor.ts:61-602` — Full class
  - `src/storage/domain-repos/pg/episode-repo.ts` — PgEpisodeRepo.readBySettlement()

  **Acceptance Criteria**:
  - [ ] Test: `test/memory/explicit-settlement-processor-pg.test.ts` → PASS
  - [ ] ZERO `ExplicitSettlementDbAdapter`/`db.prepare` references remain
  - [ ] Settlement flow: settlement ledger check → cognition upsert → relation materialization → conflict factors all work via PG

  **Commit**: YES (groups with T8)

- [ ] 8. Migrate MemoryTaskAgent to PG — Replace ~11 db calls + sql.begin() transactions

  **What to do**:
  - RED: Write tests for PG-backed MemoryTaskAgent
  - GREEN: Refactor `src/memory/task-agent.ts`:
    1. Change `MemoryTaskAgentDeps`: remove `db: MemoryTaskDbAdapter`, accept PG repos + `sql: postgres.Sql` for transaction management
    2. Replace `this.db.exec("BEGIN IMMEDIATE")` / `COMMIT` / `ROLLBACK` (L430, 485, 487) with `this.sql.begin(async (tx) => { ... })` pattern following PgSettlementUnitOfWork
    3. `loadExistingContext()` (L617-655):
       - Replace `this.db.prepare(SELECT entity_nodes...)` (L618-626) with `graphReadQueryRepo.getEntitiesForContext(agentId, limit=200)` or new repo method
       - Replace `new CognitionRepository(this.db)` (L628) with injected PG CognitionRepository
    4. `applyCallOneToolCalls()` (L657-858):
       - Replace `new CognitionRepository(this.db)` (L678) with injected PG CognitionRepository
       - Replace `this.db.prepare(SELECT private_episode_events WHERE id=?)` (L742-744) with `episodeRepo.readById()` or new method
       - Replace `this.db.prepare(UPDATE private_cognition_current...)` (L819-821) with `cognitionProjectionRepo.updateSourceEventRef()` (from Task 2)
    5. `createSameEpisodeEdgesForBatch()` (L860-920):
       - Replace `this.db.prepare(SELECT event_nodes WHERE id IN ...)` (L869-876) with `graphReadQueryRepo` method
       - Replace `this.db.prepare(INSERT INTO logic_edges...)` (L898-900) with `graphMutableStoreRepo.createLogicEdge()`
    6. `resolveEntityReference()` (L922-956):
       - Replace `this.db.prepare(SELECT entity_nodes...)` (L939-949) with `graphMutableStoreRepo.resolveEntityByPointerKey()` or similar
    7. CognitionRepository: create ONCE in constructor (not per-method at L628, L678)
    8. Remove `MemoryTaskDbAdapter` type export (will be cleaned in T12)

  **Must NOT do**:
  - Do NOT change MemoryTaskAgent's public API (runMigrate, runOrganize)
  - Do NOT change the ingestion pipeline logic
  - Do NOT change the organizer dispatch logic

  **Recommended Agent Profile**: `deep`
  **Parallelization**: Wave 3, with T7. Blocks T11. Blocked by T3, T7.

  **References**:
  - `src/memory/task-agent.ts:339-1006` — Full class
  - `src/storage/pg-settlement-uow.ts` — Transaction pattern to follow
  - `src/bootstrap/runtime.ts:879-882` — Existing sql.begin() pattern

  **Acceptance Criteria**:
  - [ ] Test: `test/memory/task-agent-pg.test.ts` → PASS
  - [ ] `runMigrateInternal()` uses `sql.begin()` (not `BEGIN IMMEDIATE`)
  - [ ] Transaction rollback on error verified
  - [ ] `loadExistingContext()` returns entities + cognition from PG
  - [ ] `createSameEpisodeEdgesForBatch()` creates logic_edges via PG
  - [ ] `resolveEntityReference()` resolves via PG (private_overlay → shared_public)
  - [ ] ZERO `MemoryTaskDbAdapter`/`db.prepare`/`db.exec` references remain

  **Commit**: YES (groups with T7)

- [ ] 9. EmbeddingService async化 — Remove Bun.peek sync bridge

  **What to do**:
  - RED: Write tests for async `queryNearestNeighbors`
  - GREEN: Refactor `src/memory/embeddings.ts`:
    1. Make `queryNearestNeighbors()` return `Promise<Array<...>>` (currently sync via Bun.peek)
    2. Make `batchStoreEmbeddings()` async — currently uses `resolveNow()` inside transaction
    3. Remove `private resolveNow<T>()` method entirely (L83-96)
    4. Remove `Bun.peek` import/usage
  - Update ALL callers (3 locations found by Metis):
    1. `RetrievalService.localizeSeedsHybrid()` (retrieval.ts:181) — `await this.embeddingService.queryNearestNeighbors(...)`
    2. `EmbeddingLinker.link()` (embedding-linker.ts:~50) — add `await`
    3. `GraphOrganizer.isMutualTopFive()` (graph-organizer.ts:~175) — add `await`
  - `batchStoreEmbeddings` callers: GraphOrganizer uses this for storing embeddings. Make caller await.

  **Must NOT do**:
  - Do NOT change embedding algorithm or similarity thresholds
  - Do NOT change PgEmbeddingRepo — it's already async

  **Recommended Agent Profile**: `deep`
  **Parallelization**: Wave 4, parallel with T10. Blocks T10, T11. Blocked by nothing (independent).

  **References**:
  - `src/memory/embeddings.ts:20-97` — Full class being refactored
  - `src/memory/embedding-linker.ts` — Caller (EmbeddingLinker.link)
  - `src/memory/graph-organizer.ts` — Caller (isMutualTopFive)
  - `src/memory/retrieval.ts:181` — Caller (localizeSeedsHybrid)

  **Acceptance Criteria**:
  - [ ] Test: `test/memory/embeddings-async.test.ts` → PASS
  - [ ] `queryNearestNeighbors` returns `Promise<...>`
  - [ ] ZERO `Bun.peek` references remain in embeddings.ts
  - [ ] ZERO `resolveNow` method remains
  - [ ] All 3 callers properly `await` the async result
  - [ ] `bun run build` passes (no type errors from callers)

  **QA Scenarios**:
  ```
  Scenario: queryNearestNeighbors is properly async
    Tool: Bash (grep + bun test)
    Steps: grep for Bun.peek in embeddings.ts → zero matches. Run tests → pass.
    Evidence: .sisyphus/evidence/task-9-async-embedding.txt

  Scenario: All callers await correctly
    Tool: Bash (grep)
    Steps: grep for "await.*queryNearestNeighbors" in retrieval.ts, embedding-linker.ts, graph-organizer.ts → 3 matches.
    Evidence: .sisyphus/evidence/task-9-callers-await.txt
  ```

  **Commit**: YES (groups with T10)

- [ ] 10. Wire vector branch in GraphNavigator — Generate queryEmbedding

  **What to do**:
  - RED: Write test verifying GraphNavigator passes queryEmbedding to localizeSeedsHybrid
  - GREEN: Modify `src/memory/navigator.ts`:
    1. Add embed provider to GraphNavigator constructor: accept optional `embedProvider: { embed(texts: string[], purpose: string, modelId: string): Promise<Float32Array[]> }` — matches MemoryTaskModelProvider.embed() signature
    2. In `explore()` method, before calling `localizeSeedsHybrid`:
       - If embedProvider is available: `const [queryEmbedding] = await this.embedProvider.embed([query], "query_expansion", this.embeddingModelId)`
       - Pass `queryEmbedding` as 4th parameter: `this.retrieval.localizeSeedsHybrid(query, viewerContext, seedCount, queryEmbedding)`
    3. Add `embeddingModelId` to constructor (from config or MemoryTaskModelProviderAdapter.defaultEmbeddingModelId)
  - Modify `src/memory/retrieval.ts` if needed:
    1. `localizeSeedsHybrid` 4th param is already defined (`queryEmbedding?: Float32Array`) — no signature change needed
    2. The semantic branch (`if (embeddingCount > 0 && queryEmbedding)`) already exists — it will fire now

  **Must NOT do**:
  - Do NOT change the RRF fusion logic in localizeSeedsHybrid
  - Do NOT add new retrieval capabilities — just wire existing vector branch

  **Recommended Agent Profile**: `quick`
  **Parallelization**: Wave 4, parallel with T9. Blocks T11. Blocked by T9.

  **References**:
  - `src/memory/navigator.ts:209` — Where localizeSeedsHybrid is called without queryEmbedding
  - `src/memory/retrieval.ts:165-246` — localizeSeedsHybrid with existing vector branch
  - `src/memory/model-provider-adapter.ts:52-56` — MemoryTaskModelProviderAdapter.embed()
  - `src/memory/task-agent.ts:104-108` — MemoryTaskModelProvider interface

  **Acceptance Criteria**:
  - [ ] Test: `test/memory/navigator-vector.test.ts` → PASS
  - [ ] GraphNavigator.explore() generates queryEmbedding when embedProvider available
  - [ ] localizeSeedsHybrid receives 4th parameter (queryEmbedding)
  - [ ] Vector branch fires when embeddings exist + queryEmbedding provided

  **Commit**: YES (groups with T9)

- [ ] 11. Re-wire runtime.ts — Remove throwingMemoryDbAdapter, wire all PG repos

  **What to do**:
  - Modify `src/bootstrap/runtime.ts`:
    1. **Remove `throwingMemoryDbAdapter`** (L215-226): delete entirely
    2. **Remove `MemoryTaskDbAdapter` type** from MemoryTaskAgent constructor call: pass PG repos instead
    3. **Create PG-backed CognitionRepository** in bootstrap:
       ```
       const cognitionRepo = new CognitionRepository({
         cognitionProjectionRepo, cognitionEventRepo, searchProjectionRepo,
         entityResolver: (pointerKey, agentId) => pgCognitionProjectionRepo.resolveEntityByPointerKey(pointerKey, agentId)
       })
       ```
    4. **Create PG-backed RelationBuilder** in bootstrap: `new RelationBuilder({ relationWriteRepo: pgRelationWriteRepo, cognitionProjectionRepo })`
    5. **Create PG-backed ExplicitSettlementProcessor**: pass PG cognitionRepo + relationBuilder (no more raw db)
    6. **Update MemoryTaskAgent constructor**: pass `sql` for transactions, PG repos, PG-backed CognitionRepo
    7. **Wire embedProvider to GraphNavigator**: pass `memoryTaskModelProvider` (or adapter) + `effectiveOrganizerEmbeddingModelId`
    8. **Instantiate new repos**: `PgRelationWriteRepo(sql)` (from Task 1)
    9. Verify `memoryPipelineReady` derivation still works correctly

  **Must NOT do**:
  - Do NOT change PromptBuilder wiring (already working from Plan B)
  - Do NOT change agent loop or turn service

  **Recommended Agent Profile**: `deep`
  **Parallelization**: Wave 5, with T12. Blocks T12. Blocked by T8, T10.

  **References**:
  - `src/bootstrap/runtime.ts:215-226` — throwingMemoryDbAdapter to DELETE
  - `src/bootstrap/runtime.ts:1073-1086` — MemoryTaskAgent construction to UPDATE
  - `src/bootstrap/runtime.ts:987-1001` — RetrievalService + GraphNavigator wiring (may need embedProvider)

  **Acceptance Criteria**:
  - [ ] `throwingMemoryDbAdapter` completely removed from runtime.ts
  - [ ] `MemoryTaskDbAdapter` not referenced in runtime.ts
  - [ ] MemoryTaskAgent constructed with PG repos (no db adapter)
  - [ ] GraphNavigator constructed with embedProvider
  - [ ] `bun run build` passes
  - [ ] `bun test` passes (all existing + new tests)

  **Commit**: YES (groups with T12)

- [ ] 12. Cleanup — Remove all DbLike/MemoryTaskDbAdapter types + dead imports

  **What to do**:
  - Remove `MemoryTaskDbAdapter` type export from `src/memory/task-agent.ts`
  - Remove `ExplicitSettlementDbAdapter` type from `src/memory/explicit-settlement-processor.ts`
  - Remove `DbLike` type definitions from:
    - `src/memory/cognition/cognition-repo.ts`
    - `src/memory/cognition/relation-builder.ts`
    - `src/memory/cognition/relation-intent-resolver.ts`
    - Any other files that defined local `DbLike` types
  - Verify: `ast_grep_search` for `DbLike` in `src/memory/` → zero matches
  - Verify: `ast_grep_search` for `MemoryTaskDbAdapter` → zero matches
  - Verify: `ast_grep_search` for `ExplicitSettlementDbAdapter` → zero matches
  - Clean dead imports (`import type { Db }` etc.)

  **Recommended Agent Profile**: `quick`
  **Parallelization**: Wave 5, with T11. Blocks T13. Blocked by T11.

  **Acceptance Criteria**:
  - [ ] ZERO `DbLike`, `MemoryTaskDbAdapter`, `ExplicitSettlementDbAdapter` references in src/
  - [ ] ZERO dead `Db` type imports in migrated files
  - [ ] `bun run build` passes

  **Commit**: YES (groups with T11)

- [ ] 13. Full chain integration test — MemoryTaskAgent flush + vector retrieval

  **What to do**:
  - Write integration tests verifying the FULL flush chain works:
    1. **Flush test**: Seed PG with interaction records → trigger `memoryTaskAgent.runMigrate()` → verify:
       - Entities created in `entity_nodes`
       - Cognition entries in `private_cognition_current`
       - Search docs synced in `search_docs_cognition`
       - Logic edges in `logic_edges`
       - Transaction atomicity: error mid-flush → verify rollback (no partial writes)
    2. **Settlement test**: Create settlement payload with privateCognition ops → process through ExplicitSettlementProcessor → verify cognition upserts + relation materialization
    3. **Vector retrieval test**: Seed PG with embeddings + events → call GraphNavigator.explore() → verify:
       - queryEmbedding generated (not null)
       - localizeSeedsHybrid semantic branch fires
       - Results include both lexical AND semantic hits
    4. **End-to-end**: Seed data → flush → then retrieve via memory_explore tool → verify data flows correctly
  - Use interface-based testing with mocked PG repos

  **Recommended Agent Profile**: `deep`
  **Parallelization**: Wave 6 (final implementation task). Blocks F1-F4. Blocked by T12.

  **Acceptance Criteria**:
  - [ ] Test: `test/memory/memtask-pg-integration.test.ts` → PASS
  - [ ] Flush chain: interaction records → migration → PG authority tables verified
  - [ ] Settlement chain: cognition ops → entity resolution → relation writes verified
  - [ ] Vector chain: query → embed → localizeSeedsHybrid semantic branch → results verified
  - [ ] `bun test` full suite PASSES

  **Commit**: YES (standalone)

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check evidence files exist. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, commented-out code, unused imports. Verify no `db.prepare()` calls remain. Verify no `Bun.peek` calls remain.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Execute EVERY QA scenario from EVERY task. Test cross-component integration (MemoryTaskAgent → CognitionRepo → PG). Test edge cases: empty DB, invalid cognition keys, concurrent entity resolution. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: verify "What to do" matches actual diff. Check "Must NOT do" compliance. Verify belief-revision.ts untouched. Verify no write-path semantics changed. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | VERDICT`

---

## Commit Strategy

| After Tasks | Commit Message | Pre-commit Test |
|-------------|---------------|-----------------|
| T1-T2 | `feat(storage): add PgRelationWriteRepo, extend search/cognition projection repos` | `bun test test/pg-app/` |
| T3-T4 | `refactor(memory): migrate CognitionRepository + CognitionEventRepo to PG repos` | `bun test test/memory/` |
| T5-T6 | `refactor(memory): migrate RelationBuilder + relation-intent-resolver to PG repos` | `bun test test/memory/` |
| T7-T8 | `refactor(memory): migrate ExplicitSettlementProcessor + MemoryTaskAgent to PG, sql.begin() transactions` | `bun test` |
| T9-T10 | `refactor(memory): async EmbeddingService, wire vector branch in GraphNavigator` | `bun test` |
| T11-T12 | `feat(runtime): remove throwingMemoryDbAdapter, wire PG repos, cleanup dead types` | `bun test` |
| T13 | `test(memory): full chain integration tests for PG flush + vector retrieval` | `bun test` |

---

## Success Criteria

### Verification Commands
```bash
bun run build                              # Expected: zero errors
bun test                                    # Expected: ALL pass
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] Zero `db.prepare()`/`db.exec()`/`Bun.peek()` in migrated files
- [ ] `throwingMemoryDbAdapter` removed
- [ ] MemoryTaskAgent flush chain runs without error
- [ ] Vector branch fires when embedding model configured
