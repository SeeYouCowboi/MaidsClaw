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
> **Parallel Execution**: YES — 6 waves + FINAL
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
- [ ] `ast_grep_search` for `this.db.prepare` in the following migrated files → ZERO results:
  - `src/memory/task-agent.ts`
  - `src/memory/cognition/cognition-repo.ts`
  - `src/memory/cognition/cognition-event-repo.ts`
  - `src/memory/cognition/relation-builder.ts`
  - `src/memory/cognition/relation-intent-resolver.ts`
  - `src/memory/explicit-settlement-processor.ts`
- [ ] `ast_grep_search` for `this.db.exec` in the same migrated files → ZERO results
- [ ] `ast_grep_search` for `Bun.peek` in `src/memory/embeddings.ts` → ZERO results
- [ ] `Bun.peek`/`resolveSettledNow` removed from `createSettlementLedgerAdapter()` in `src/bootstrap/runtime.ts` — adapter now passes through async `SettlementLedgerRepo` calls directly
- [ ] `SettlementLedger` interface (`src/memory/settlement-ledger.ts`) is fully async — all methods return `Promise`
- [ ] `ExistingContextLoader` and `CallOneApplier` types in ESP are async (`Promise` return types)
- [ ] `loadExistingContext()` and `applyCallOneToolCalls()` in `task-agent.ts` are async methods
- [ ] **NOTE**: Other `src/memory/` files (`promotion.ts`, `materialization.ts`, `storage.ts`, `projection/area-world-projection-repo.ts`, `shared-blocks/shared-block-repo.ts`, `transaction-batcher.ts`) still contain `db.prepare`/`Bun.peek` patterns — these are OUT OF SCOPE for this plan and will be migrated in a follow-up. **WHY `storage.ts` and `materialization.ts` are out of scope despite being called during flush**: `runMigrateInternal()` currently calls `this.storage.*` and `this.materialization.*` sync facades which use `Bun.peek` internally. Task 8 BYPASSES these facades entirely — replacing all calls within `runMigrateInternal()` with direct async calls to tx-scoped PG repos (e.g., `txGraphMutableStoreRepo.upsertEntity()` instead of `this.storage.upsertEntity()`). The sync facades remain unchanged for other callers outside the migration scope (e.g., GraphOrganizer, CoreMemoryIndexUpdater). They will be migrated in a follow-up plan.
- [ ] `throwingMemoryDbAdapter` removed from runtime.ts
- [ ] `MemoryTaskAgent.runMigrateInternal()` completes without error when flush triggers
- [ ] `CoreMemoryIndexUpdater.updateIndex()` call is AFTER `sql.begin()` completes (not inside the transaction block) — avoids holding DB connection during LLM network round-trip
- [ ] `localizeSeedsHybrid` vector branch fires when embedding model is configured
- [ ] All 7 cognition stances produce correct PG writes (assertion/evaluation/commitment)

### Must Have
- All ~50 db.prepare/exec calls replaced with PG repo async equivalents
- Transaction boundaries via `sql.begin()` (not `BEGIN IMMEDIATE`)
- **Transaction-scoped repo pattern (tx-propagation)**: All PG repos participating in MemoryTaskAgent's flush transaction MUST accept `postgres.Sql | postgres.TransactionSql` in their constructor. Inside `sql.begin(async (tx) => { ... })`, create **new tx-scoped repo instances** with `tx` so all operations share the same transaction connection. Pattern: `const txCognitionProjectionRepo = new PgCognitionProjectionRepo(tx); const txCognitionRepo = new CognitionRepository({ cognitionProjectionRepo: txCognitionProjectionRepo, ... });`. This is critical because the existing `createLazyPgRepo()` pattern in runtime.ts creates repos bound to the pool — NOT to a transaction. Repos created from pool connections will NOT participate in `sql.begin()` transactions. See `src/bootstrap/runtime.ts:202-213` for the lazy proxy pattern that CANNOT be used inside transactions.
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
- ❌ Do NOT create NEW PG integration test infrastructure — reuse the existing harness at `test/memory/pg-memory-chain-integration.test.ts` for Task 13's integration tests. Do NOT build new test helpers, fixtures, or PG setup/teardown utilities.
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

- [x] 1. PgRelationWriteRepo — NEW PG repo for memory_relations writes

  **What to do**:
  - RED: Write tests for `PgRelationWriteRepo` covering all write operations on `memory_relations`
  - GREEN: Implement in `src/storage/domain-repos/pg/relation-write-repo.ts`
  - Queries to implement (from RelationBuilder + relation-intent-resolver):
    1. `upsertRelation(params)` — `INSERT INTO memory_relations ... ON CONFLICT(source_node_ref, target_node_ref, relation_type, source_kind, source_ref) DO UPDATE SET strength=?, directness=?, updated_at=?` (RelationBuilder L139-157, relation-intent-resolver L214-228)
    2. `getRelationsBySource(sourceNodeRef, relationType?)` — `SELECT FROM memory_relations WHERE source_node_ref=?` (RelationBuilder L170-178)
    3. `getRelationsForNode(nodeRef, relationTypes)` — `SELECT FROM memory_relations WHERE (source_node_ref=? OR target_node_ref=?) AND relation_type IN (...)` (RelationBuilder L204-213)
  - Define contract interface in `src/storage/domain-repos/contracts/relation-write-repo.ts`
   - Note: PgRelationReadRepo (from Plan B Task 3) already exists for read-only conflict queries AND for `resolveSourceAgentId()` / `resolveCanonicalCognitionRefByKey()` — Task 5 (RelationBuilder) should depend on BOTH PgRelationWriteRepo (this task) for writes AND the existing PgRelationReadRepo for entity/cognition resolution reads. Do NOT duplicate resolution logic.

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

- [x] 2. Extend PgSearchProjectionRepo + PgCognitionProjectionRepo — Add missing methods

  **What to do**:
  - RED: Write tests for new methods
  - GREEN: Add to existing PG repos:
    1. `PgSearchProjectionRepo.updateCognitionSearchDocStanceBySourceRef(sourceRef, agentId, stance, updatedAt)` — `UPDATE search_docs_cognition SET stance=?, updated_at=? WHERE source_ref=? AND agent_id=?` (CognitionRepo L956, L973). **IMPORTANT**: `search_docs_cognition` has NO `cognition_key` column — the table uses `source_ref` (e.g. `"assertion:123"`) + `agent_id` as identifiers (see schema at `pg-app-schema-derived.ts:156-172`). The caller (CognitionRepository) is responsible for: (a) querying `private_cognition_current WHERE agent_id=? AND cognition_key=?` to get row IDs, then (b) building `source_ref = '{kind}:{id}'` for each row, and calling this method per source_ref.
    2. `PgCognitionProjectionRepo.updateConflictFactors(agentId, cognitionKey, conflictSummary, conflictFactorRefsJson, updatedAt)` — `UPDATE private_cognition_current SET conflict_summary=?, conflict_factor_refs_json=?, updated_at=? WHERE agent_id=? AND cognition_key=?` (ESP L417-431)
    3. `PgCognitionProjectionRepo.patchRecordJsonSourceEventRef(id, sourceEventRef, updatedAt)` — `UPDATE private_cognition_current SET record_json = record_json || jsonb_build_object('sourceEventRef', ?::text), updated_at=? WHERE id=?` (MemoryTaskAgent L819-821). **IMPORTANT**: `private_cognition_current` has NO `source_event_ref` column — only `source_event_id BIGINT` which tracks the cognition event ID, not the episode event ref. The `sourceEventRef` (a NodeRef like `"private_episode:123"`) is semantically different and is stored/read via `record_json` (see `graph-read-query-repo.ts:1029-1038` which parses `sourceEventRef` from `record_json`). Do NOT attempt `SET source_event_ref = ?` — the column does not exist in PG schema (`pg-app-schema-derived.ts:17-36`).
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
  - `src/storage/pg-app-schema-derived.ts:17-36` — PG schema for `private_cognition_current` (has `source_event_id BIGINT`, NO `source_event_ref`)
  - `src/storage/pg-app-schema-derived.ts:156-172` — PG schema for `search_docs_cognition` (has `source_ref`, `agent_id`, NO `cognition_key`)
  - `src/storage/domain-repos/pg/graph-read-query-repo.ts:1029-1038` — Read side: parses `sourceEventRef` from `record_json`
  - `src/memory/cognition/cognition-repo.ts:783-818,956,973` — Source SQL for entity resolution, stance update (note: stance update uses two-step: query current by cognition_key → update search_docs by source_ref)
  - `src/memory/explicit-settlement-processor.ts:417-431` — Source SQL for conflict factor update

  **Acceptance Criteria**:
  - [ ] `bun test test/pg-app/pg-search-projection-repo.test.ts` → PASS (new methods)
  - [ ] `bun test test/pg-app/pg-cognition-projection-repo.test.ts` → PASS (new methods)  
  - [ ] `upsertCognitionDoc` is on the SearchProjectionRepo contract interface

  **QA Scenarios**:
  ```
  Scenario: updateCognitionSearchDocStanceBySourceRef updates only stance column
    Tool: Bash (bun test)
    Steps: Seed doc with known source_ref → update stance via source_ref + agent_id → verify only stance and updated_at changed.
    Evidence: .sisyphus/evidence/task-2-stance-update.txt

  Scenario: patchRecordJsonSourceEventRef merges into record_json without overwriting
    Tool: Bash (bun test)
    Steps: Seed row with existing record_json → patch sourceEventRef → verify sourceEventRef added, other record_json fields preserved.
    Evidence: .sisyphus/evidence/task-2-source-event-ref-patch.txt

  Scenario: resolveEntityByPointerKey returns private_overlay before shared_public
    Tool: Bash (bun test)
    Steps: Seed entity with both scopes → resolve → verify private_overlay wins.
    Evidence: .sisyphus/evidence/task-2-entity-resolution.txt
  ```

  **Commit**: YES (groups with T1)

- [x] 3. Migrate CognitionRepository to PG — Replace all ~25 db.prepare calls

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

- [x] 4. Migrate CognitionEventRepo internal SQLite adapter to PG

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

- [x] 5. Migrate RelationBuilder to PG — Replace ~8 db.prepare calls

  **What to do**:
  - RED: Write tests for PG-native RelationBuilder
  - GREEN: Refactor `src/memory/cognition/relation-builder.ts`:
     1. Change constructor: remove `db: DbLike`, accept `{ relationWriteRepo, relationReadRepo, cognitionProjectionRepo }` (from Tasks 1, existing PgRelationReadRepo, 2)
    2. Replace `writeRelation()` (L139-157) with `relationWriteRepo.upsertRelation()`
    3. Replace `getRelationsBySource()` (L170-178) with `relationWriteRepo.getRelationsBySource()`
    4. Replace `getRelationsForNode()` (L204-213) with `relationWriteRepo.getRelationsForNode()`
     5. Replace entity resolution queries (L256-287 `resolveSourceAgentId`) — **reuse `PgRelationReadRepo.resolveSourceAgentId()`** which already implements the exact same logic (assertion/episode/evaluation/commitment ref → agent_id lookup). Do NOT use `cognitionProjectionRepo.getCurrent()` — wrong API surface. Accept `relationReadRepo: PgRelationReadRepo` in constructor deps alongside `relationWriteRepo`.
     6. Replace cognition key resolution (L298-331 `resolveCanonicalCognitionRefByKey`) — **reuse `PgRelationReadRepo.resolveCanonicalCognitionRefByKey()`** which already implements the exact same query (cognition_key → canonical `assertion:N` / `evaluation:N` / `commitment:N` ref with ordering). Do NOT use `cognitionProjectionRepo.getCurrent()` — wrong API surface.
    7. Make all methods async
  - `writeContestRelations()` — the main write method called by ExplicitSettlementProcessor

  **Must NOT do**: Do NOT change the conflict detection logic (which edges to create)

  **Recommended Agent Profile**: `deep`
  **Parallelization**: Wave 2, parallel with T3/T4/T6. Blocks T7. Blocked by T1.

  **References**:
  - `src/memory/cognition/relation-builder.ts` — Full class being migrated
  - `src/storage/domain-repos/pg/relation-write-repo.ts` — From Task 1 (write ops)
  - `src/storage/domain-repos/pg/relation-read-repo.ts:87-169` — **Already implements** `resolveSourceAgentId()` and `resolveCanonicalCognitionRefByKey()` — reuse directly instead of reimplementing via `cognitionProjectionRepo.getCurrent()`
  - `src/storage/domain-repos/contracts/relation-read-repo.ts` — Read contract for type reference

  **Acceptance Criteria**:
  - [ ] Test: `test/memory/relation-builder-pg.test.ts` → PASS
  - [ ] `writeContestRelations` creates correct memory_relations rows via PG
  - [ ] ZERO `DbLike`/`db.prepare` references remain

  **Commit**: YES (groups with T6)

- [x] 6. Migrate relation-intent-resolver to PG — Replace ~3 db.prepare calls

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

- [x] 7. Migrate ExplicitSettlementProcessor to PG — Replace ~6 db.prepare calls

   **What to do**:
   - RED: Write tests for PG-backed ExplicitSettlementProcessor
   - GREEN: Refactor `src/memory/explicit-settlement-processor.ts`:
     1. Change `ExplicitSettlementProcessorDeps.db` type: from `ExplicitSettlementDbAdapter` to PG repos (or remove `db` entirely, replace with specific repos)
     2. Replace L341-347 (`SELECT FROM private_episode_events WHERE settlement_id=?`) with `episodeRepo.readBySettlement()`
     3. Replace L360-366 (`SELECT FROM event_nodes WHERE source_settlement_id=?`) with new repo method or direct PG query
     4. Replace L417-431 (`UPDATE private_cognition_current SET conflict_summary=?`) with `cognitionProjectionRepo.updateConflictFactors()` (from Task 2)
     5. Update calls to `materializeRelationIntents()` and `resolveConflictFactors()` — pass PG repos (from Task 6)
     6. Constructor no longer receives `db` — receives PG repos for cognitionRepo, relationBuilder (both migrated in T3, T5)
     7. **CRITICAL — async化 SettlementLedger interface**: The current `SettlementLedger` interface (`settlement-ledger.ts:13-23`) is fully synchronous (`check()` returns `SettlementLedgerCheckResult`, mark methods return `void`). The `createSettlementLedgerAdapter()` at `runtime.ts:241-309` bridges the async `SettlementLedgerRepo` to this sync interface using `resolveSettledNow()`/`Bun.peek()` — this WILL throw with PG async I/O. **FIX**:
        - Change `SettlementLedger` interface to async: `check()` → `Promise<SettlementLedgerCheckResult>`, all `mark*()` → `Promise<void>`
        - Update `createSettlementLedgerAdapter()` in `runtime.ts` to pass through `SettlementLedgerRepo` calls directly (remove `resolveSettledNow()` wrappers — the repo is already async)
        - Update ESP call sites to `await`: `this.settlementLedger?.check(...)` (L123) → `await this.settlementLedger?.check(...)`, `this.settlementLedger?.markApplying(...)` (L128) → `await this.settlementLedger?.markApplying(...)`, `this.settlementLedger?.markApplied(...)` (L202) → `await ...`, `this.settlementLedger?.markFailed(...)` (L204) → `await ...`
        - **NOTE on optional chaining + await**: `await this.settlementLedger?.check(...)` works correctly — if `settlementLedger` is undefined, expression evaluates to `undefined` which is harmlessly awaited
        - **NOTE on tx-scoping**: Settlement ledger operations are idempotent state machine transitions on a separate table (`settlement_ledger`). They do NOT need to participate in the same transaction as the core cognition flush. If the main transaction rolls back, the ledger state ("applying") is harmless — the next retry re-checks and re-processes correctly. Therefore, the ledger remains pool-bound (uses pool `sql` connection, not `tx`). This is an intentional design choice, not an oversight.
     8. **CRITICAL — async化 `ExistingContextLoader` and `CallOneApplier` callback types**: ESP receives these as constructor params (L88-89). Currently sync:
        - `ExistingContextLoader = (agentId: string) => { entities: unknown[]; privateBeliefs: unknown[] }` (L50)
        - `CallOneApplier = (flushRequest, toolCalls, created) => void` (L51)
        After Task 8 migrates `MemoryTaskAgent.loadExistingContext()` and `applyCallOneToolCalls()` to use PG repos, these become async. **FIX**:
        - Change `ExistingContextLoader` → `(agentId: string) => Promise<{ entities: unknown[]; privateBeliefs: unknown[] }>`
        - Change `CallOneApplier` → `(flushRequest: MemoryFlushRequest, toolCalls: Array<...>, created: CreatedState) => Promise<void>`
        - Update ESP call sites: `this.loadExistingContext(agentId)` (L135) → `await this.loadExistingContext(agentId)`, `this.applyCallOneToolCalls(...)` (L151) → `await this.applyCallOneToolCalls(...)`
        - **Coordination with Task 8**: T8 changes the implementation (in `task-agent.ts`), T7 changes the types and call sites (in `explicit-settlement-processor.ts`). Both must agree on the async signatures. Since T7 and T8 are in the same wave and commit group, this is safe.

  **Must NOT do**: Do NOT change settlement processing logic (which ops are processed, in what order)

  **Recommended Agent Profile**: `deep`
  **Parallelization**: Wave 3, with T8. Blocks T8. Blocked by T3, T5, T6.

  **References**:
  - `src/memory/explicit-settlement-processor.ts:61-602` — Full class
  - `src/memory/explicit-settlement-processor.ts:50-51` — `ExistingContextLoader` (sync) and `CallOneApplier` (sync) type definitions — change to async
  - `src/memory/explicit-settlement-processor.ts:84-95` — Constructor accepting sync callbacks + optional `SettlementLedger`
  - `src/memory/explicit-settlement-processor.ts:123,128,135,151,202,204` — Call sites for `settlementLedger`, `loadExistingContext`, `applyCallOneToolCalls` — add `await`
  - `src/memory/settlement-ledger.ts:13-23` — `SettlementLedger` interface (sync → async)
  - `src/bootstrap/runtime.ts:241-309` — `createSettlementLedgerAdapter()` sync bridge using `resolveSettledNow()`/`Bun.peek` — remove sync bridge, pass-through async
  - `src/storage/domain-repos/pg/episode-repo.ts` — PgEpisodeRepo.readBySettlement()

  **Acceptance Criteria**:
  - [ ] Test: `test/memory/explicit-settlement-processor-pg.test.ts` → PASS
  - [ ] ZERO `ExplicitSettlementDbAdapter`/`db.prepare` references remain
  - [ ] Settlement flow: settlement ledger check → cognition upsert → relation materialization → conflict factors all work via PG
  - [ ] `SettlementLedger` interface is fully async (all methods return `Promise`)
  - [ ] `createSettlementLedgerAdapter()` no longer uses `resolveSettledNow()`/`Bun.peek()` — passthrough to async `SettlementLedgerRepo`
  - [ ] `ExistingContextLoader` type returns `Promise<...>`, `CallOneApplier` type returns `Promise<void>`
  - [ ] All ESP call sites for `settlementLedger.*`, `loadExistingContext()`, `applyCallOneToolCalls()` use `await`

  **Commit**: YES (groups with T8)

- [x] 8. Migrate MemoryTaskAgent to PG — Replace ~11 db calls + sql.begin() transactions

  **What to do**:
  - RED: Write tests for PG-backed MemoryTaskAgent
  - GREEN: Refactor `src/memory/task-agent.ts`:
     1. Change `MemoryTaskAgentDeps`: remove `db: MemoryTaskDbAdapter`, accept PG repos + `sql: postgres.Sql` for transaction management. **Additional deps needed**: `graphMutableStoreRepo: PgGraphMutableStoreRepo` (for entity upserts, private event creation, logic edge creation, entity alias creation, entity lookups — currently done via `this.storage.*` sync facade), `relationWriteRepo: PgRelationWriteRepo` (for relation materialization inside tx), `promotionQueryRepo: PgPromotionQueryRepo` (for `materializeDelayed` entity/event promotion decisions — see item 9), `areaWorldProjectionRepo: PgAreaWorldProjectionRepo` (for `materializeDelayed` area-world projections — see item 9), `episodeRepo: PgEpisodeRepo` (for private_episode_events read-back at L742-744 — `this.db.prepare(SELECT private_episode_events WHERE id=?)` → `episodeRepo.readById()`)
    2. Replace `this.db.exec("BEGIN IMMEDIATE")` / `COMMIT` / `ROLLBACK` (L430, 485, 487) with `this.sql.begin(async (tx) => { ... })` pattern following PgSettlementUnitOfWork
       **CRITICAL — `CoreMemoryIndexUpdater.updateIndex()` (L483)**: This call currently sits between `BEGIN IMMEDIATE` (L430) and `COMMIT` (L485) in the SQLite code. However, `updateIndex()` (`core-memory-index-updater.ts:15-46`) makes an LLM call (`this.modelProvider.chat(...)`) and writes via pool-bound `CoreMemoryBlockRepo` (instantiated via `createLazyPgRepo()` at `runtime.ts:688`). **Move `updateIndex()` OUTSIDE `sql.begin()`** — place it AFTER the `sql.begin()` block completes successfully. Rationale:
       - (a) `updateIndex()` involves a network round-trip to an LLM — holding a DB transaction connection open during LLM inference is an anti-pattern that risks connection pool exhaustion under load
       - (b) `CoreMemoryBlockRepo` is pool-bound (not tx-scoped) — it would NOT participate in the `sql.begin()` transaction anyway, so including it inside `sql.begin()` gives a false sense of transactionality
       - (c) Core memory index updates are idempotent and self-correcting: `updateIndex()` reads the current block, asks the LLM to update it, then replaces the block. If the main flush tx rolls back, the index will be slightly stale but will self-correct on the next flush cycle
       - (d) The guardrail "Do NOT migrate CoreMemoryIndexUpdater internal logic" (L119) means we don't tx-scope its repos — moving the call outside `sql.begin()` is the correct architectural choice
    3. **CRITICAL — tx-propagation**: Inside `sql.begin(async (tx) => { ... })`, create NEW tx-scoped repo instances using `tx` (NOT `this.sql`). The existing repos injected via constructor use pool connections and will NOT participate in the transaction. Pattern:
       ```
       await this.sql.begin(async (tx) => {
         // --- Cognition repos (tx-scoped) ---
         const txCognitionProjectionRepo = new PgCognitionProjectionRepo(tx);
         const txCognitionEventRepo = new PgCognitionEventRepo(tx);
         const txSearchProjectionRepo = new PgSearchProjectionRepo(tx);
         const txCognitionRepo = new CognitionRepository({
           cognitionProjectionRepo: txCognitionProjectionRepo,
           cognitionEventRepo: txCognitionEventRepo,
           searchProjectionRepo: txSearchProjectionRepo,
           entityResolver: (pk, aid) => txCognitionProjectionRepo.resolveEntityByPointerKey(pk, aid),
         });
          // --- Graph/storage repos (tx-scoped) ---
          const txGraphMutableStoreRepo = new PgGraphMutableStoreRepo(tx);
          const txRelationWriteRepo = new PgRelationWriteRepo(tx);
          const txRelationReadRepo = new PgRelationReadRepo(tx);
           // --- Episode repo (tx-scoped for private_episode_events read-back at L742) ---
           const txEpisodeRepo = new PgEpisodeRepo(tx);
           // --- Materialization repos (tx-scoped for materializeDelayed — see item 9) ---
           const txPromotionQueryRepo = new PgPromotionQueryRepo(tx);
           const txAreaWorldProjectionRepo = new PgAreaWorldProjectionRepo(tx);
          // --- RelationBuilder + ESP (tx-scoped) ---
         const txRelationBuilder = new RelationBuilder({
           relationWriteRepo: txRelationWriteRepo,
           relationReadRepo: txRelationReadRepo,
           cognitionProjectionRepo: txCognitionProjectionRepo,
         });
         const txSettlementProcessor = new ExplicitSettlementProcessor({
           cognitionRepo: txCognitionRepo,
           relationBuilder: txRelationBuilder,
           // ... other tx-scoped deps
         });
         // ALL flush operations use tx-scoped repos — NO pool-bound repos
       });
       ```
       **WHY**: `createLazyPgRepo()` in runtime.ts (`runtime.ts:202-213`) binds repos to the pool via Proxy. Each method call resolves to a new repo with its own connection. `sql.begin()` scopes a transaction to a SINGLE connection — only repos constructed with `tx` participate. Without this, `sql.begin()` wraps nothing, and errors mid-flush leave partial writes (no atomicity). This is the same pattern used by PgSettlementUnitOfWork (`pg-settlement-uow.ts`).
     4. **CRITICAL — bypass `this.storage.*` and `this.materialization.*` sync facades**: `runMigrateInternal()` currently calls `this.storage.upsertEntity()` (L705), `this.storage.createPrivateEvent()` (L726), `this.storage.createEntityAlias()` (L834), `this.storage.createLogicEdge()` (L849), `this.storage.getEntityById()` (L795, L799), and `this.materialization.materializeDelayed()` (L478). These facade methods use `Bun.peek()` / `resolveNow()` as sync bridges (`storage.ts:275-295`, `storage.ts:184-186`, `materialization.ts:240-253`). PG I/O returns unresolved promises, so `Bun.peek()` will throw at runtime. **FIX**: Replace ALL `this.storage.*` calls within `runMigrateInternal()` with direct async calls to `txGraphMutableStoreRepo.*`:
        - `this.storage.upsertEntity(...)` → `await txGraphMutableStoreRepo.upsertEntity(...)`
        - `this.storage.createPrivateEvent(...)` → `await txGraphMutableStoreRepo.createPrivateEvent(...)` — writes to `private_episode_events` (NOT `createProjectedEvent`, which writes PUBLIC events to `event_nodes`)
        - `this.storage.createEntityAlias(...)` → `await txGraphMutableStoreRepo.createEntityAlias(...)`
        - `this.storage.createLogicEdge(...)` → `await txGraphMutableStoreRepo.createLogicEdge(...)`
        - `this.storage.getEntityById(source/target)?.pointerKey` (L795, L799) → `(await txGraphMutableStoreRepo.getEntityById(source/target))?.pointerKey` — **NOTE**: `getEntityById(id: number): Promise<{ pointerKey: string } | null>` exists on the `GraphMutableStoreRepo` contract (`graph-mutable-store-repo.ts:56`) but does NOT yet have a PG implementation in `PgGraphMutableStoreRepo`. The executor MUST add this method to `PgGraphMutableStoreRepo` — it's a simple `SELECT pointer_key FROM entity_nodes WHERE id = $1` query. Alternatively, use an existing repo method if one covers this lookup.
        - `this.materialization.materializeDelayed(...)` → see item 9 below for full dependency analysis and inline replication strategy
       **NOTE**: `storage.ts` and `materialization.ts` themselves remain OUT OF SCOPE — they keep their `Bun.peek` sync bridges for other non-migration callers. Task 8 bypasses them ONLY within `runMigrateInternal()`.
     5. **async化 `loadExistingContext()`** (L617-655) — make method return `Promise<{ entities: unknown[]; privateBeliefs: unknown[] }>`:
       - Replace `this.db.prepare(SELECT entity_nodes...)` (L618-626) with `await graphReadQueryRepo.getEntitiesForContext(agentId, limit=200)` or new repo method
       - Replace `new CognitionRepository(this.db)` (L628) with injected PG CognitionRepository
       - Add `async` keyword to method signature
       - **Coordination with T7**: The `ExistingContextLoader` type in ESP (L50) must match — T7 item 8 changes the type to `Promise<...>`. The ESP call site at L135 adds `await`.
      6. **async化 `applyCallOneToolCalls()`** (L657-858) — make method return `Promise<void>` (or `Promise<CreatedPrivateEvents>`):
        - Replace `new CognitionRepository(this.db)` (L678) with injected PG CognitionRepository
        - Replace `this.db.prepare(SELECT private_episode_events WHERE id=?)` (L742-744) with `await txEpisodeRepo.readById(id)` — must use **tx-scoped** `txEpisodeRepo` to see uncommitted writes within the transaction (the event was just created at L726 within the same `sql.begin()` block)
        - Replace `this.db.prepare(UPDATE private_cognition_current...)` (L819-821) with `cognitionProjectionRepo.patchRecordJsonSourceEventRef()` (from Task 2) — stores `sourceEventRef` in `record_json` JSONB, NOT as a direct column (column `source_event_ref` does not exist in PG schema)
        - **Replace `this.storage.upsertEntity(...)` (L705)** with `await txGraphMutableStoreRepo.upsertEntity(...)` — see item 4 above
        - **Replace `this.storage.createPrivateEvent(...)` (L726)** with `await txGraphMutableStoreRepo.createPrivateEvent(...)` — see item 4 above (NOT `createProjectedEvent` — that's for PUBLIC events)
        - **Replace `this.storage.getEntityById(source)?.pointerKey` (L795) and `this.storage.getEntityById(target)?.pointerKey` (L799)** with `(await txGraphMutableStoreRepo.getEntityById(source))?.pointerKey` and `(await txGraphMutableStoreRepo.getEntityById(target))?.pointerKey` — see item 4 above. These entity lookups at L795/L799 feed `createSameEpisodeEdgesForBatch()`. Uses tx-scoped repo to see entities created earlier in the same transaction.
        - **Replace `this.storage.createEntityAlias(...)` (L834)** with `await txGraphMutableStoreRepo.createEntityAlias(...)` — see item 4 above
        - **Replace `this.storage.createLogicEdge(...)` (L849)** with `await txGraphMutableStoreRepo.createLogicEdge(...)` — see item 4 above
        - Add `async` keyword to method signature
        - **Coordination with T7**: The `CallOneApplier` type in ESP (L51) must match — T7 item 8 changes the type to `Promise<void>`. The ESP call site at L151 adds `await`.
        - **Call sites in `runMigrateInternal()`**: `this.applyCallOneToolCalls(...)` (L475) must become `await this.applyCallOneToolCalls(...)`; `this.loadExistingContext(...)` (L421) must become `await this.loadExistingContext(...)`
    7. `createSameEpisodeEdgesForBatch()` (L860-920):
       - Replace `this.db.prepare(SELECT event_nodes WHERE id IN ...)` (L869-876) with `graphReadQueryRepo` method
       - Replace `this.db.prepare(INSERT INTO logic_edges...)` (L898-900) with `txGraphMutableStoreRepo.createLogicEdge()` (use tx-scoped repo if inside transaction)
    8. `resolveEntityReference()` (L922-956):
       - Replace `this.db.prepare(SELECT entity_nodes...)` (L939-949) with `txGraphMutableStoreRepo.resolveEntityByPointerKey()` or similar (use tx-scoped repo if inside transaction)
     9. **CRITICAL — Replace `this.materialization.materializeDelayed(...)` (L478)** — `materializeDelayed()` (`materialization.ts:65-164`) is a complex pipeline with the following ACTUAL dependencies (NOT `txCognitionProjectionRepo`/`txSearchProjectionRepo` as previously stated):
        - **`PromotionQueryRepo`** (injected via `MaterializationService` constructor):
          - `.findPublicEventBySourceRecordId(sourceRecordId)` (L168-169, via L86) — checks if a public event already exists for this private event
          - `.resolvePublicEntityDecision({sourceEntityRef, timestamp, isLocation})` (L189-195, via L94/100) — decides whether to promote, reuse, or block an entity for public graph
          - `.toPublicEventCategory(privateCategory)` (L105) — maps private event category to public
        - **`GraphStorageService.createProjectedEvent(...)`** (L121) — creates a PUBLIC event in `event_nodes` table. **IMPORTANT**: This is `createProjectedEvent`, NOT `createPrivateEvent` — they write to different tables (`event_nodes` vs `private_episode_events`)
        - **`GraphStorageService.upsertEntity(...)`** (L218, L229) — creates/updates public entities during promotion
        - **`AreaWorldProjectionRepo.applyMaterializationProjection(...)`** (L135) — records materialization projection for area-world state tracking
        - **`MaterializationService.resolveNow()`** (L240-253) — `Bun.peek()` sync bridge, same issue as `storage.ts`

        **Inline replication strategy**: Within `runMigrateInternal()`, replicate the `materializeDelayed` logic directly using tx-scoped repos:
        ```
        // Inside sql.begin(async (tx) => { ... })
        const txGraphMutableStoreRepo = new PgGraphMutableStoreRepo(tx);
        const txPromotionQueryRepo = new PgPromotionQueryRepo(tx);  // tx-scoped for read consistency
         const txAreaWorldProjectionRepo = new PgAreaWorldProjectionRepo(tx);  // tx-scoped — constructor accepts postgres.Sql (area-world-projection-repo.ts:27), works with both pool and tx

        // Replicate materializeDelayed loop:
        for (const privateEvent of delayedEvents) {
          // 1. Check existing public event via txPromotionQueryRepo.findPublicEventBySourceRecordId()
          // 2. Resolve entities via txPromotionQueryRepo.resolvePublicEntityDecision()
          //    → If "promote_full"/"promote_placeholder": txGraphMutableStoreRepo.upsertEntity()
          // 3. Get public event category via txPromotionQueryRepo.toPublicEventCategory()
          // 4. Create public event via txGraphMutableStoreRepo.createProjectedEvent() ← PUBLIC events
          // 5. Apply projection via txAreaWorldProjectionRepo.applyMaterializationProjection()
        }
        ```
        **Alternative**: If inlining is too complex, consider making `MaterializationService.materializeDelayed()` async and accepting tx-scoped repos as parameters. This would be cleaner but increases the change surface. The executor should evaluate complexity and choose. Either way, the key requirement is: ALL repo calls within the materialization flow must use `tx`-scoped repos, NOT pool-bound ones, and NO `Bun.peek()` / `resolveNow()`.

        **Additional deps for `MemoryTaskAgentDeps`**: Add `promotionQueryRepo: PgPromotionQueryRepo` and `areaWorldProjectionRepo: PgAreaWorldProjectionRepo` (or access via an injected `MaterializationService` that accepts tx-scoped repos).
    10. CognitionRepository: create ONCE in constructor (not per-method at L628, L678). The pool-bound instance is used for read operations outside transactions; tx-scoped instances are created inside `sql.begin()` (item 3).
    11. Remove `MemoryTaskDbAdapter` type export (will be cleaned in T12)

  **Must NOT do**:
  - Do NOT change MemoryTaskAgent's public API (runMigrate, runOrganize)
  - Do NOT change the ingestion pipeline logic
  - Do NOT change the organizer dispatch logic

  **Recommended Agent Profile**: `deep`
  **Parallelization**: Wave 3, with T7. Blocks T11. Blocked by T3, T7.

  **References**:
  - `src/memory/task-agent.ts:339-1006` — Full class
  - `src/memory/task-agent.ts:617-655` — `loadExistingContext()` — sync method using `this.db.prepare()`, must become async
  - `src/memory/task-agent.ts:690-739` — `applyCallOneToolCalls()` internals — sync, calls `this.storage.*`, must become async
   - `src/memory/storage.ts:160-198,275-295` — GraphStorageService sync facade methods + `resolveNow`/`Bun.peek` (calls being BYPASSED, not migrated — see item 4)
   - `src/memory/storage.ts:184-186` — `getEntityById()` sync facade: `this.resolveNow(this.delegates.graphStoreRepo.getEntityById(id))` — uses `Bun.peek`, called at task-agent.ts:795,799
   - `src/storage/domain-repos/contracts/graph-mutable-store-repo.ts:56` — `getEntityById(id: number): Promise<{ pointerKey: string } | null>` — exists on contract but NOT yet implemented in `PgGraphMutableStoreRepo`. Executor must add PG implementation (simple `SELECT pointer_key FROM entity_nodes WHERE id = $1`).
   - `src/storage/domain-repos/pg/episode-repo.ts` — PgEpisodeRepo: needed for tx-scoped `readById()` at L742-744 read-back
  - `src/memory/materialization.ts:65-164` — `materializeDelayed()` full implementation — ACTUAL deps: `PromotionQueryRepo` (L86,94,105), `GraphStorageService.createProjectedEvent()` (L121, PUBLIC events), `GraphStorageService.upsertEntity()` (L218,229, entity promotion), `AreaWorldProjectionRepo.applyMaterializationProjection()` (L135)
  - `src/memory/materialization.ts:240-253` — `resolveNow()`/`Bun.peek` sync bridge (calls being BYPASSED — see item 9)
  - `src/storage/domain-repos/pg/graph-mutable-store-repo.ts` — PgGraphMutableStoreRepo: `createPrivateEvent()` (L527, private events) and `createProjectedEvent()` (public events) — two DIFFERENT methods
  - `src/storage/domain-repos/contracts/promotion-query-repo.ts:94-114` — PromotionQueryRepo methods used by materializeDelayed
  - `src/storage/domain-repos/pg/promotion-query-repo.ts` — PgPromotionQueryRepo implementation (tx-scopable)
  - `src/storage/pg-settlement-uow.ts` — Transaction pattern to follow (tx-scoped repo construction)
  - `src/bootstrap/runtime.ts:879-882` — Existing sql.begin() pattern
   - `src/bootstrap/runtime.ts:202-213` — createLazyPgRepo() — pool-bound proxy that CANNOT participate in sql.begin() transactions
   - `src/memory/core-memory-index-updater.ts:15-46` — `updateIndex()`: makes LLM call (`this.modelProvider.chat(...)`) + writes via pool-bound `CoreMemoryBlockRepo` — must be moved OUTSIDE `sql.begin()` (see item 2)
   - `src/bootstrap/runtime.ts:688` — `PgCoreMemoryBlockRepo` instantiated via `createLazyPgRepo()` (pool-bound, not tx-scoped)

  **Acceptance Criteria**:
  - [ ] Test: `test/memory/task-agent-pg.test.ts` → PASS
   - [ ] `runMigrateInternal()` uses `sql.begin()` (not `BEGIN IMMEDIATE`)
   - [ ] `CoreMemoryIndexUpdater.updateIndex()` call is OUTSIDE `sql.begin()` — placed after the transaction completes successfully (not inside the transaction block). Verify: no LLM call occurs while a PG transaction is held open.
  - [ ] Transaction rollback on error verified — inject a repo that throws mid-flush, assert no partial writes in PG
   - [ ] **tx-propagation verified**: Inside `sql.begin()`, repos are constructed with `tx` not pool `sql`. Test: mock/spy confirms all repo calls within transaction use same connection. ALL repos participating in flush (cognition, graph mutable store, relation write/read, search projection, promotion query, area-world projection, episode) are tx-scoped.
   - [ ] **Sync facade bypass verified**: ZERO calls to `this.storage.upsertEntity`, `this.storage.createPrivateEvent`, `this.storage.createEntityAlias`, `this.storage.createLogicEdge`, `this.storage.getEntityById`, or `this.materialization.materializeDelayed` remain inside `runMigrateInternal()` — replaced with direct `txGraphMutableStoreRepo.*`, `txEpisodeRepo.*`, `txPromotionQueryRepo.*` / `txAreaWorldProjectionRepo.*` async calls
  - [ ] `loadExistingContext()` is async, returns entities + cognition from PG repos
   - [ ] `applyCallOneToolCalls()` is async, returns `Promise<void>` (or `Promise<CreatedPrivateEvents>`), all internal `this.storage.*` calls replaced with tx-scoped repo calls, `this.db.prepare(SELECT private_episode_events...)` replaced with `txEpisodeRepo.readById()`, `this.storage.getEntityById()` at L795/L799 replaced with `txGraphMutableStoreRepo.getEntityById()`
  - [ ] `createSameEpisodeEdgesForBatch()` creates logic_edges via PG
  - [ ] `resolveEntityReference()` resolves via PG (private_overlay → shared_public)
  - [ ] ZERO `MemoryTaskDbAdapter`/`db.prepare`/`db.exec` references remain in migrated files:
   - `src/memory/task-agent.ts`
   - `src/memory/cognition/cognition-repo.ts`
   - `src/memory/cognition/cognition-event-repo.ts`
   - `src/memory/cognition/relation-builder.ts`
   - `src/memory/cognition/relation-intent-resolver.ts`
   - `src/memory/explicit-settlement-processor.ts`
- [ ] `PgGraphMutableStoreRepo.getEntityById()` implemented (contract exists at `graph-mutable-store-repo.ts:56` but PG impl was missing — needed for L795/L799 entity lookups)
  - [ ] `materializeDelayed` replication uses correct repos: `txPromotionQueryRepo`, `txGraphMutableStoreRepo.createProjectedEvent()` (PUBLIC events), `txGraphMutableStoreRepo.upsertEntity()` (entity promotion), `txAreaWorldProjectionRepo.applyMaterializationProjection()`

  **Commit**: YES (groups with T7)

- [x] 9. EmbeddingService async化 — Remove Bun.peek sync bridge

  **What to do**:
  - RED: Write tests for async `queryNearestNeighbors`
  - GREEN: Refactor `src/memory/embeddings.ts`:
    1. Make `queryNearestNeighbors()` return `Promise<Array<...>>` (currently sync via Bun.peek)
    2. Make `batchStoreEmbeddings()` async — currently uses `resolveNow()` inside transaction
    3. Remove `private resolveNow<T>()` method entirely (L83-96)
    4. Remove `Bun.peek` import/usage
  - Update ALL callers (3 locations found by Metis):
    1. `RetrievalService.localizeSeedsHybrid()` (retrieval.ts:181) — `await this.embeddingService.queryNearestNeighbors(...)`. **CRITICAL — modelId**: The current call at L181 does NOT pass `modelId` in options, but `PgEmbeddingRepo.cosineSearch()` THROWS if `modelId` is missing (`embedding-repo.ts:142-144`: `throw new Error("modelId is required for cosineSearch...")`). Fix: `localizeSeedsHybrid` must accept a `modelId` parameter and pass it through to `queryNearestNeighbors({ ..., modelId })`. The modelId must match the model used when storing node embeddings (`effectiveOrganizerEmbeddingModelId` from runtime config — see `runtime.ts:700-702`).
    2. `EmbeddingLinker.link()` (embedding-linker.ts:~50) — add `await`. Also verify modelId is passed (EmbeddingLinker likely already has it from constructor).
    3. `GraphOrganizer.isMutualTopFive()` (graph-organizer.ts:~175) — add `await`. Verify modelId is passed.
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

- [x] 10. Wire vector branch in GraphNavigator — Generate queryEmbedding

  **What to do**:
  - RED: Write test verifying GraphNavigator passes queryEmbedding AND modelId to localizeSeedsHybrid
  - GREEN: Modify `src/memory/navigator.ts`:
    1. Add embed provider to GraphNavigator constructor: accept optional `embedProvider: { embed(texts: string[], purpose: string, modelId: string): Promise<Float32Array[]> }` — matches MemoryTaskModelProvider.embed() signature
    2. In `explore()` method, before calling `localizeSeedsHybrid`:
       - If embedProvider is available: `const [queryEmbedding] = await this.embedProvider.embed([query], "query_expansion", this.embeddingModelId)`
       - Pass `queryEmbedding` AND `modelId` to localizeSeedsHybrid: `this.retrieval.localizeSeedsHybrid(query, viewerContext, seedCount, queryEmbedding, this.embeddingModelId)`
    3. Add `embeddingModelId` to constructor — **MUST use `effectiveOrganizerEmbeddingModelId`** (from runtime config `runtime.ts:700-702`), NOT `memoryEmbeddingModelId`. This is because node embeddings are stored using `effectiveOrganizerEmbeddingModelId` (via GraphOrganizer), and query embeddings MUST use the same model to produce compatible vectors for cosine similarity. Using a different model would produce vectors in a different embedding space, making cosine search return garbage results.
  - Modify `src/memory/retrieval.ts`:
    1. Add `modelId` as 5th parameter to `localizeSeedsHybrid`: `localizeSeedsHybrid(query, viewerContext, limit, queryEmbedding?, modelId?)`
    2. Pass `modelId` through to `this.embeddingService.queryNearestNeighbors(queryEmbedding, { agentId, limit, modelId })` at L181
    3. **CRITICAL**: Without `modelId`, `PgEmbeddingRepo.cosineSearch()` throws (`embedding-repo.ts:142-144`). The current code at retrieval.ts:181 will crash at runtime because it omits `modelId` from the options object.

  **Must NOT do**:
  - Do NOT change the RRF fusion logic in localizeSeedsHybrid
  - Do NOT add new retrieval capabilities — just wire existing vector branch

  **Recommended Agent Profile**: `quick`
  **Parallelization**: Wave 4, parallel with T9. Blocks T11. Blocked by T9.

  **References**:
  - `src/memory/navigator.ts:209` — Where localizeSeedsHybrid is called without queryEmbedding
  - `src/memory/retrieval.ts:165-246` — localizeSeedsHybrid with existing vector branch; L181 omits `modelId` from queryNearestNeighbors options
  - `src/storage/domain-repos/pg/embedding-repo.ts:142-144` — `cosineSearch` throws if `modelId` missing: `"modelId is required for cosineSearch to enforce model epoch binding"`
  - `src/bootstrap/runtime.ts:700-702` — `memoryEmbeddingModelId` vs `effectiveOrganizerEmbeddingModelId` — query embedding MUST use `effectiveOrganizerEmbeddingModelId` to match stored node embeddings
  - `src/memory/model-provider-adapter.ts:52-56` — MemoryTaskModelProviderAdapter.embed()
  - `src/memory/task-agent.ts:104-108` — MemoryTaskModelProvider interface

  **Acceptance Criteria**:
  - [ ] Test: `test/memory/navigator-vector.test.ts` → PASS
  - [ ] GraphNavigator.explore() generates queryEmbedding when embedProvider available
  - [ ] localizeSeedsHybrid receives queryEmbedding AND modelId
  - [ ] `modelId` is `effectiveOrganizerEmbeddingModelId` (matching stored node embedding model epoch)
  - [ ] `queryNearestNeighbors` at retrieval.ts:181 passes `modelId` in options (prevents cosineSearch throw)
  - [ ] Vector branch fires when embeddings exist + queryEmbedding + modelId provided

  **Commit**: YES (groups with T9)

 - [x] 11. Re-wire runtime.ts — Remove throwingMemoryDbAdapter, wire all PG repos

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
     4. **Create PG-backed RelationBuilder** in bootstrap: `new RelationBuilder({ relationWriteRepo: pgRelationWriteRepo, relationReadRepo: pgRelationReadRepo, cognitionProjectionRepo })`
    5. **Create PG-backed ExplicitSettlementProcessor**: pass PG cognitionRepo + relationBuilder (no more raw db)
    6. **Update MemoryTaskAgent constructor**: pass `sql` for transactions, PG repos, PG-backed CognitionRepo
    7. **Wire embedProvider to GraphNavigator**: pass `memoryTaskModelProvider` (or adapter) + `effectiveOrganizerEmbeddingModelId`
     8. **Instantiate new repos**: `PgRelationWriteRepo(sql)` (from Task 1). `PgRelationReadRepo(sql)` already exists in runtime.ts (L916-917, instantiated via `createLazyPgRepo()` and passed to `CognitionSearchService` at L975-977) — needs **additional wiring** to also pass to RelationBuilder's constructor for entity/cognition resolution reads.
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
  - `src/storage/domain-repos/pg/relation-read-repo.ts` — PgRelationReadRepo class (already instantiated in runtime.ts at L916-917 for CognitionSearchService — needs additional wiring to RelationBuilder)

  **Acceptance Criteria**:
  - [ ] `throwingMemoryDbAdapter` completely removed from runtime.ts
  - [ ] `MemoryTaskDbAdapter` not referenced in runtime.ts
  - [ ] MemoryTaskAgent constructed with PG repos (no db adapter)
  - [ ] GraphNavigator constructed with embedProvider
  - [ ] `bun run build` passes
  - [ ] `bun test` passes (all existing + new tests)

  **Commit**: YES (groups with T12)

 - [x] 12. Cleanup — Remove DbLike/MemoryTaskDbAdapter types + dead imports from MIGRATED files

  **What to do**:
  - Remove `MemoryTaskDbAdapter` type export from `src/memory/task-agent.ts`
  - Remove `ExplicitSettlementDbAdapter` type from `src/memory/explicit-settlement-processor.ts`
  - Remove `DbLike` type definitions from migrated files ONLY:
    - `src/memory/cognition/cognition-repo.ts`
    - `src/memory/cognition/relation-builder.ts`
    - `src/memory/cognition/relation-intent-resolver.ts`
  - **DO NOT touch** `DbLike` in files outside this plan's scope (e.g., `src/memory/shared-blocks/shared-block-repo.ts`, `src/memory/projection/area-world-projection-repo.ts`, `src/memory/transaction-batcher.ts`) — those are follow-up migration targets
  - Verify: `ast_grep_search` for `DbLike` in the 5 migrated files listed above → zero matches
  - Verify: `ast_grep_search` for `MemoryTaskDbAdapter` across `src/` → zero matches
  - Verify: `ast_grep_search` for `ExplicitSettlementDbAdapter` across `src/` → zero matches
  - Clean dead imports (`import type { Db }` etc.) in migrated files only

  **Recommended Agent Profile**: `quick`
  **Parallelization**: Wave 5, with T11. Blocks T13. Blocked by T11.

  **Acceptance Criteria**:
  - [ ] ZERO `DbLike` references in the 5 migrated files (cognition-repo, relation-builder, relation-intent-resolver, task-agent, explicit-settlement-processor)
  - [ ] ZERO `MemoryTaskDbAdapter`, `ExplicitSettlementDbAdapter` references across src/
  - [ ] ZERO dead `Db` type imports in migrated files
  - [ ] `DbLike` in non-migrated files (shared-block-repo.ts, area-world-projection-repo.ts, transaction-batcher.ts) is UNTOUCHED
  - [ ] `bun run build` passes

  **Commit**: YES (groups with T11)

 - [x] 13. Full chain integration test — MemoryTaskAgent flush + vector retrieval

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
   - **Use the existing PG integration test harness** at `test/memory/pg-memory-chain-integration.test.ts:69` — reuse its PG setup/teardown, connection, and transaction rollback pattern. Do NOT create new PG test infrastructure. Do NOT use interface-based mocks for these integration tests (they need real PG to verify actual data flow).

  **Recommended Agent Profile**: `deep`
  **Parallelization**: Wave 6 (final implementation task). Blocks F1-F4. Blocked by T12.

  **References**:
  - `test/memory/pg-memory-chain-integration.test.ts:69` — Existing PG integration test harness — reuse setup/teardown/connection pattern
  - `src/memory/task-agent.ts` — MemoryTaskAgent.runMigrateInternal() entry point
  - `src/memory/explicit-settlement-processor.ts` — Settlement chain entry point
  - `src/memory/navigator.ts` — GraphNavigator.explore() for vector retrieval test
  - `src/memory/retrieval.ts` — localizeSeedsHybrid for semantic branch verification

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

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check evidence files exist. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, commented-out code, unused imports. Verify no `db.prepare()` calls remain **in the 6 migrated files** (cognition-repo.ts, cognition-event-repo.ts, relation-builder.ts, relation-intent-resolver.ts, explicit-settlement-processor.ts, task-agent.ts). Verify no `Bun.peek` calls remain **in `embeddings.ts`** and **in `createSettlementLedgerAdapter()` at `runtime.ts:241-309`** (replaced with direct async passthrough per T7 item 7). Verify `SettlementLedger` interface (`settlement-ledger.ts`) is fully async (all methods return `Promise`). Verify `CoreMemoryIndexUpdater.updateIndex()` is called OUTSIDE `sql.begin()` in `runMigrateInternal()`. Verify ZERO `this.storage.*` sync facade calls remain inside `runMigrateInternal()` (including `this.storage.getEntityById`). Verify `PgGraphMutableStoreRepo` implements `getEntityById()`. NOTE: `db.prepare`/`Bun.peek` in non-migrated files (`storage.ts`, `materialization.ts`, `promotion.ts`, `shared-block-repo.ts`, `area-world-projection-repo.ts`, `transaction-batcher.ts`) are expected and OUT OF SCOPE — do NOT flag them.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
  Execute EVERY QA scenario from EVERY task. Test cross-component integration (MemoryTaskAgent → CognitionRepo → PG). Test edge cases: empty DB, invalid cognition keys, concurrent entity resolution. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
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
