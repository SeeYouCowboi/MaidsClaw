# Plan B: PG-Native RetrievalService — Close GAP-A/B/C/E, Partially Close GAP-G

## TL;DR

> **Quick Summary**: Migrate RetrievalService and all its dependencies from SQLite (`Db`) to PG-native repos, then wire through runtime so TYPED_RETRIEVAL prompt slot produces real content, all 6 memory tools work, and GraphNavigator is alive. GAP-G is partially closed: GraphNavigator operates with lexical-only seed retrieval; the vector/semantic branch (`queryEmbedding` + `modelId` chain) is a pre-existing gap left for Phase 2.
> 
> **Deliverables**:
> - PgRetrievalReadRepo (replaces 15 `db.prepare()` calls)
> - PgCognitionSearchRepo (FTS → trigram search migration)
> - PgRelationReadRepo (read-path only)
> - PgAliasRepo (entity alias resolution)
> - Refactored RetrievalService (PG-native, async-first)
> - Refactored MemoryAdapter (revived from dead code)
> - Refactored prompt-data.ts (no more `Db` param)
> - Wired runtime.ts (real services, no stubs)
> - GraphNavigator instantiated and callable
> - Full TDD test suite for every layer
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES — 4 waves
> **Critical Path**: Tasks 1-4 (parallel) → Task 5-6 → Tasks 7-9 (parallel) → Task 10-11 → Task 12 → F1-F4

---

## Context

### Original Request
User requested analysis of `MEMORY_PROMPT_CONVERSATION_INTEGRATION_GAP_ANALYSIS_2026-04-02.zh-CN.md`, cross-referenced with all project docs, and deep codebase exploration to determine the optimal conversation memory strategy. After comprehensive analysis with 5 parallel agents, three plans were proposed (A: minimal bypass, B: PG-native正攻法, C: full architecture upgrade). User chose **Plan B**.

### Interview Summary
**Key Discussions**:
- RetrievalService migration strategy: **In-place refactor** (not new class) — remove `Db`, inject PG repos
- MemoryAdapter strategy: **Revive existing dead-code class** (not keep inline stub)
- CognitionSearch/Alias migration: **Use existing PG repos directly** where possible
- Test strategy: **TDD** (RED-GREEN-REFACTOR) with bun test
- Scope: Phase 1 only (Phases 2-3 are incremental improvements later)

**Research Findings**:
- All 8 gaps (A-H) from gap analysis doc confirmed OPEN via code verification
- 3 of 5 GraphNavigator deps already PG-ready (GraphReadQueryRepo, NarrativeSearchService, EpisodeRepository)
- 2 deps need migration (AliasService: uses DbLike, CognitionSearchService: uses Db + internal SQLite deps)
- EmbeddingService is PG-native for writes but RetrievalService still does raw `db.prepare` for count query on `node_embeddings`
- `MemoryAdapter` class exists at `src/core/prompt-data-adapters/memory-adapter.ts` — fully implemented, exported, **zero imports anywhere**

### Metis Review
**Identified Gaps** (addressed):
- **PgCognitionSearchRepo is a NEW build, not a repo swap**: CognitionSearchService (439 lines) does FTS5, filtering, sorting, conflict enrichment — existing PG repos cover ~20%. Added as dedicated task.
- **PgRelationReadRepo missing**: RelationBuilder used internally by CognitionSearch for conflict enrichment. Read-path migration needed. Added.
- **PgPointerRedirectRepo missing**: RetrievalService.resolveRedirect() queries `pointer_redirects`. Folded into PgRetrievalReadRepo.
- **prompt-data.ts refactor missing**: `getTypedRetrievalSurfaceAsync()` takes `db: Db` parameter and has `WeakMap<Db, RetrievalService>` cache. Must refactor to accept RetrievalService directly. Added.
- **Sync→async cascade not acknowledged**: `readByEntity`, `readByTopic`, `readByEventIds`, `readByFactIds` are sync → must become async. All callers (tools.ts, retrieval-orchestrator.ts, navigator.ts) must update. Documented in tasks.
- **VisibilityPolicy SQL fragments**: `eventVisibilityPredicate()` may generate SQLite-specific SQL. Must verify and adapt for PG.
- **Scope creep traps locked down**: CognitionRepository write path (1065 lines), PrivateCognitionProjectionRepo writes, RelationBuilder writes — all explicitly EXCLUDED.

---

## Work Objectives

### Core Objective
Eliminate all SQLite (`Db`) dependencies from the memory retrieval chain so that TYPED_RETRIEVAL prompt slot produces real content, all 6 memory tools are callable without error, and GraphNavigator is functional — using PG-native repos throughout.

### Concrete Deliverables
- `src/storage/domain-repos/pg/retrieval-read-repo.ts` — New PG repo
- `src/storage/domain-repos/pg/cognition-search-repo.ts` — New PG repo
- `src/storage/domain-repos/pg/relation-read-repo.ts` — New PG repo
- `src/storage/domain-repos/pg/alias-repo.ts` — New PG repo
- `src/memory/retrieval.ts` — Refactored (PG-native, async-first)
- `src/memory/cognition/cognition-search.ts` — Refactored (PG repos)
- `src/memory/alias.ts` — Refactored (PG repo)
- `src/memory/prompt-data.ts` — Refactored (no Db param)
- `src/core/prompt-data-adapters/memory-adapter.ts` — Refactored (accepts RetrievalService)
- `src/bootstrap/runtime.ts` — Wired (real services, stubs removed)
- Test files for every new/modified module

### Definition of Done
- [ ] `bun test` — all existing tests still pass (no regressions)
- [ ] `TYPED_RETRIEVAL` slot returns non-empty content when memory data exists in PG
- [ ] `memory_read` tool returns entity/topic/event/fact data from PG
- [ ] `narrative_search` tool returns search results from PG
- [ ] `cognition_search` tool returns cognition search results from PG
- [ ] `memory_explore` tool invokes GraphNavigator successfully (lexical-only seed retrieval; vector/semantic branch is a pre-existing gap — see "Must NOT Have")
- [ ] `core_memory_append` and `core_memory_replace` continue working (no regressions)
- [ ] No `db.prepare()` calls remain in RetrievalService, CognitionSearchService, AliasService, prompt-data.ts
- [ ] No `lazyRetrieval` throw-proxy in runtime.ts
- [ ] No inline anonymous memoryAdapter stub in runtime.ts

### Must Have
- All 15 `db.prepare()` calls in RetrievalService replaced with PG repo calls
- CognitionSearchService fully functional with PG (FTS via trigram/tsvector, filtering, sorting, conflict enrichment)
- AliasService PG-native (entity_aliases, entity_nodes queries)
- MemoryAdapter revived and wired into PromptBuilder
- GraphNavigator instantiated in runtime.ts with all 3 deps (RetrievalService, PgGraphReadQueryRepo, AliasService)
- Full sync→async migration for `readByEntity`, `readByTopic`, `readByEventIds`, `readByFactIds`
- VisibilityPolicy SQL fragments verified PG-compatible (or adapted)
- TDD: Every new repo and refactored service has passing tests

### Must NOT Have (Guardrails)
- ❌ Do NOT touch `CognitionRepository` write path (1065 lines, `src/memory/cognition/cognition-repo.ts`)
- ❌ Do NOT migrate `PrivateCognitionProjectionRepo` write methods (`upsertFromEvent`, `rebuild`, retract)
- ❌ Do NOT migrate `RelationBuilder` write methods (`writeContestRelations`, `writeRelation`)
- ❌ Do NOT touch settlement/organizer pipeline write paths
- ❌ Do NOT add per-turn dynamic retrieval/write template modification (consensus constraint)
- ❌ Do NOT add cross-agent authorization to VisibilityPolicy (consensus constraint)
- ❌ Do NOT use `viewer_role` for visibility decisions (consensus constraint, template defaults only)
- ❌ Do NOT create new SQLite `Db` dependencies — only remove them
- ❌ Do NOT abstract with unnecessary interface layers where direct PG repo usage suffices
- ❌ Do NOT add AI slop: excessive JSDoc, over-abstraction, generic variable names (`data`, `result`, `item`, `temp`)
- ❌ Do NOT modify `search_docs_cognition_fts` (SQLite FTS5 table) — it stays for SQLite path; we build PG equivalent
- ❌ Do NOT fix the semantic/vector search chain in `localizeSeedsHybrid` — this is a PRE-EXISTING gap, not a regression from this migration. Specifically:
  - `navigator.ts:209` calls `localizeSeedsHybrid(query, viewerContext, seedCount)` without `queryEmbedding` (4th param) → vector branch never fires
  - `retrieval.ts:275-276` only enters vector branch when `queryEmbedding` is non-null AND embeddings exist → always skips to lexical-only RRF
  - `embedding-repo.ts:143` requires `modelId` in options → would throw if vector branch was reached, but current call at `retrieval.ts:276` doesn't pass `modelId`
  - `embeddings.ts:83-96` uses `Bun.peek()` sync bridge → fragile on unresolved PG promises
  These are all pre-existing issues. `localizeSeedsHybrid` has always operated in lexical-only mode. Fixing the vector chain is Phase 2 work.
- ❌ Do NOT modify `EmbeddingService.queryNearestNeighbors()` or its `Bun.peek` sync bridge — out of scope for this plan

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.
> Acceptance criteria requiring "user manually tests/confirms" are FORBIDDEN.

### Test Decision
- **Infrastructure exists**: YES (100+ test files, `test/` directory)
- **Automated tests**: TDD (RED-GREEN-REFACTOR)
- **Framework**: bun test
- **Pattern**: Each task writes tests FIRST (RED), then implements to make them pass (GREEN), then cleans up (REFACTOR)

### QA Policy
Every task MUST include agent-executed QA scenarios. Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **PG repos**: Use Bash (bun test) — run test file, verify pass count
- **Service refactors**: Use Bash (bun test) — run test file + integration test
- **Runtime wiring**: Use Bash (bun test) — run integration test that exercises full chain
- **API/tool verification**: Use Bash (bun test or curl) — invoke tool, assert response shape

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — PG repos + interfaces, MAX PARALLEL):
├── Task 1: PgRetrievalReadRepo [deep]
├── Task 2: PgCognitionSearchRepo [deep]
├── Task 3: PgRelationReadRepo [quick]
├── Task 4: PgAliasRepo [quick]
└── Task 5: Sync→Async cascade analysis + interface contracts [quick]

Wave 2 (After Wave 1 — service refactors):
├── Task 6: Refactor CognitionSearchService (depends: 2, 3) [deep]
├── Task 7: Refactor AliasService (depends: 4) [quick]
├── Task 8: Refactor RetrievalService (depends: 1, 5, 6, 7) [deep]
└── Task 9: Refactor prompt-data.ts (depends: 5) [quick]

Wave 3 (After Wave 2 — adapter + wiring):
├── Task 10: Refactor MemoryAdapter (depends: 8) [quick]
└── Task 11: Wire runtime.ts (depends: 7, 8, 9, 10) [deep]

Wave 4 (After Wave 3 — integration):
└── Task 12: Full chain integration tests (depends: 11) [deep]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: T1+T2+T3+T4+T5 (parallel) → T6+T7 → T8 → T10 → T11 → T12 → F1-F4
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 5 (Wave 1)
```

### Dependency Matrix

| Task | Blocked By | Blocks |
|------|-----------|--------|
| T1 (PgRetrievalReadRepo) | — | T8 |
| T2 (PgCognitionSearchRepo) | — | T6 |
| T3 (PgRelationReadRepo) | — | T6 |
| T4 (PgAliasRepo) | — | T7 |
| T5 (Sync→Async analysis) | — | T8, T9 |
| T6 (CognitionSearchService) | T2, T3 | T8 |
| T7 (AliasService) | T4 | T11 |
| T8 (RetrievalService) | T1, T5, T6, T7 | T10, T11, T12 |
| T9 (prompt-data.ts) | T5 | T10 |
| T10 (MemoryAdapter) | T8, T9 | T11 |
| T11 (Wire runtime.ts) | T7, T8, T9, T10 | T12 |
| T12 (Integration tests) | T11 | F1-F4 |
| F1-F4 (Final verification) | T12 | User okay |

### Agent Dispatch Summary

- **Wave 1**: **5** — T1 → `deep`, T2 → `deep`, T3 → `quick`, T4 → `quick`, T5 → `quick`
- **Wave 2**: **4** — T6 → `deep`, T7 → `quick`, T8 → `deep`, T9 → `quick`
- **Wave 3**: **2** — T10 → `quick`, T11 → `deep`
- **Wave 4**: **1** — T12 → `deep`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.

- [x] 1. PgRetrievalReadRepo — PG repo for all RetrievalService read queries

  **What to do**:
  - RED: Write tests for a new `PgRetrievalReadRepo` class that implements all 15 read queries currently done via `db.prepare()` in `src/memory/retrieval.ts`
  - GREEN: Implement `PgRetrievalReadRepo` in `src/storage/domain-repos/pg/retrieval-read-repo.ts`
  - Queries to implement (map each `db.prepare()` call in retrieval.ts — **read the actual SQL, not summaries**):
    1. `readByEntity` (lines 96-128): 3 queries on 3 DIFFERENT tables:
       - `fact_edges` (line 103-107): `SELECT * FROM fact_edges WHERE (source_entity_id=? OR target_entity_id=?) AND t_invalid=?`
       - `event_nodes` (line 110-116): `SELECT * FROM event_nodes WHERE (participants LIKE ? OR primary_actor_entity_id=?) AND ${eventVisibilityPredicate}`
       - `private_episode_events` (line 118-125): `SELECT ... FROM private_episode_events WHERE agent_id=? AND location_entity_id=?`
    2. `readByTopic` (lines 130-149): 2 queries — does NOT read facts:
       - `topics` (line 132): `SELECT * FROM topics WHERE name=?`
       - `event_nodes` (line 138-144): `SELECT * FROM event_nodes WHERE topic_id=? AND ${eventVisibilityPredicate}`
       - episodes is hardcoded to `[]` (line 147: "Private episodes have no topic FK")
    3. `readByEventIds` (lines 152-166): reads `event_nodes` (NOT private_episode_events):
       - `event_nodes` (line 159-165): `SELECT * FROM event_nodes WHERE id IN (...) AND ${eventVisibilityPredicate}`
    4. `readByFactIds` (lines 168-177): reads `fact_edges` (NOT memory_relation_edges):
       - `fact_edges` (line 174-176): `SELECT * FROM fact_edges WHERE id IN (...) AND t_invalid=?`
    5. `resolveRedirect` (lines 343-358): pointer_redirects (agent-scoped then global, 2 queries)
    6. `resolveEntityByPointer` (lines 361-404): entity_nodes + entity_aliases (5 queries)
    7. `countNodeEmbeddings` (line ~272 in localizeSeedsHybrid): SELECT count(*) FROM node_embeddings (1 query)
  - Define contract interface in `src/storage/domain-repos/contracts/retrieval-read-repo.ts`
  - All methods MUST be async (return `Promise<...>`)
  - Handle `VisibilityPolicy.eventVisibilityPredicate()` — verify the generated SQL WHERE fragments are PG-compatible. If they use SQLite-specific syntax (e.g., `json_extract`), adapt them. Document findings.
  - Handle `participants LIKE '%entity:{id}%'` pattern (retrieval.ts line 116) — use PG-compatible pattern matching (`LIKE` works in PG, but verify column is text not jsonb)
  - REFACTOR: Clean up naming, remove any SQLite-isms

  **Must NOT do**:
  - Do NOT modify write paths (no INSERT/UPDATE/DELETE queries)
  - Do NOT change the existing SQLite RetrievalService yet (Task 8 does that)
  - Do NOT touch `CognitionRepository` or settlement pipeline

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 15 queries to migrate, requires understanding PG SQL patterns, visibility policy SQL generation, and careful schema mapping
  - **Skills**: []
    - No specialized skills needed — this is pure TypeScript + PG SQL work
  - **Skills Evaluated but Omitted**:
    - `playwright`: No browser interaction needed
    - `git-master`: Standard commit, no complex git operations

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4, 5)
  - **Blocks**: Task 8 (RetrievalService refactor)
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL):

  **Pattern References** (existing code to follow):
  - `src/storage/domain-repos/pg/embedding-repo.ts` — PgEmbeddingRepo: Template for PG repo class structure (constructor takes `postgres.Sql`, async methods, SQL template literals)
  - `src/storage/domain-repos/pg/graph-read-query-repo.ts` — PgGraphReadQueryRepo: Complex PG read repo with multiple query methods (closest pattern to what we're building)
  - `src/storage/domain-repos/pg/narrative-search-repo.ts` — PgNarrativeSearchRepo: Search repo using `similarity()` trigram matching
  - `src/storage/domain-repos/pg/episode-repo.ts` — PgEpisodeRepo: Simple PG repo pattern

  **API/Type References** (contracts to implement against):
  - `src/memory/retrieval.ts:101-404` — All 15 `db.prepare()` calls: the exact queries to replicate in PG SQL
  - `src/memory/retrieval.ts:68-98` — RetrievalService constructor and fields: understand what data shapes are expected
  - `src/memory/types.ts` — `EntityReadResult`, `TopicReadResult`, `EventNode`, `FactEdge`, `SeedCandidate` and other return types
  - `src/storage/db-types.ts` — `Db` interface: understand the SQLite API being replaced
  - `src/memory/contracts/visibility-policy.ts` — `VisibilityPolicy` interface: `eventVisibilityPredicate(viewerContext)` returns SQL WHERE fragment

  **Test References** (testing patterns to follow):
  - `test/pg-app/pg-graph-store-repo.test.ts` — PG repo test pattern with real PG connection
  - `test/pg-app/pg-embedding-repo.test.ts` — PG repo test with seed data
  - `test/pg-app/pg-narrative-search-repo.test.ts` — Search repo test pattern

  **WHY Each Reference Matters**:
  - embedding-repo.ts: Shows how to structure constructor, use `sql` template literals, handle async
  - retrieval.ts:101-404: The exact source queries — each `db.prepare().all()/get()` must map to a PG equivalent
  - visibility-policy.ts: The SQL fragment generator — must verify its output is PG-valid
  - pg-graph-store-repo.test.ts: Shows how to seed PG test data and assert query results

  **Acceptance Criteria**:

  **TDD:**
  - [ ] Contract interface created: `src/storage/domain-repos/contracts/retrieval-read-repo.ts`
  - [ ] Test file created: `test/pg-app/pg-retrieval-read-repo.test.ts`
  - [ ] `bun test test/pg-app/pg-retrieval-read-repo.test.ts` → PASS (all query methods tested)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Entity read returns correct data from PG
    Tool: Bash (bun test)
    Preconditions: PG database with seeded entity_nodes, fact_edges, event_nodes, private_episode_events, topics
    Steps:
      1. Run `bun test test/pg-app/pg-retrieval-read-repo.test.ts`
      2. Verify test output shows: readByEntity returns entity with events and facts
      3. Verify test output shows: readByTopic returns matching entities
      4. Verify test output shows: readByEventIds returns correct events
      5. Verify test output shows: readByFactIds returns correct facts
    Expected Result: All tests pass, 0 failures
    Failure Indicators: Any test failure or "db.prepare is not a function" error
    Evidence: .sisyphus/evidence/task-1-entity-read.txt

  Scenario: Pointer resolution handles redirects and aliases
    Tool: Bash (bun test)
    Preconditions: PG database with pointer_redirects entries and entity_aliases
    Steps:
      1. Run `bun test test/pg-app/pg-retrieval-read-repo.test.ts --filter "redirect|alias|pointer"`
      2. Verify resolveRedirect finds agent-scoped redirect first, then global
      3. Verify resolveEntityByPointer resolves via alias when direct lookup fails
    Expected Result: All redirect/alias tests pass
    Failure Indicators: Null returns when data exists, wrong redirect priority
    Evidence: .sisyphus/evidence/task-1-pointer-resolution.txt

  Scenario: Visibility predicate SQL is PG-compatible
    Tool: Bash (bun test)
    Preconditions: PG database with events having different visibility levels
    Steps:
      1. Run test that calls readByEntity with a ViewerContext
      2. Verify the VisibilityPolicy-generated WHERE clause executes without PG syntax errors
      3. Verify filtered results match expected visibility rules
    Expected Result: No SQL syntax errors, correct filtering
    Failure Indicators: PG error mentioning "json_extract" or other SQLite-specific functions
    Evidence: .sisyphus/evidence/task-1-visibility-pg-compat.txt
  ```

  **Evidence to Capture:**
  - [ ] task-1-entity-read.txt — Full test output
  - [ ] task-1-pointer-resolution.txt — Redirect/alias test output
  - [ ] task-1-visibility-pg-compat.txt — Visibility SQL compatibility test output

  **Commit**: YES (groups with T2, T3, T4)
  - Message: `feat(storage): add PG repos for retrieval read, cognition search, relation read, alias`
  - Files: `src/storage/domain-repos/pg/retrieval-read-repo.ts`, `src/storage/domain-repos/contracts/retrieval-read-repo.ts`, `test/pg-app/pg-retrieval-read-repo.test.ts`
  - Pre-commit: `bun test test/pg-app/pg-retrieval-read-repo.test.ts`

- [ ] 2. PgCognitionSearchRepo — PG-native cognition search replacing SQLite FTS5

  **What to do**:
  - RED: Write tests for a new `PgCognitionSearchRepo` class that replicates CognitionSearchService's query layer in PG
  - GREEN: Implement in `src/storage/domain-repos/pg/cognition-search-repo.ts`
  - **This is a NEW build**, not a simple repo swap. CognitionSearchService (439 lines) does:
    1. FTS search via `search_docs_cognition_fts` (SQLite FTS5 MATCH) → Replace with PG `similarity()` (trigram) or `tsvector` full-text search. Follow `PgSearchProjectionRepo.searchCognition()` pattern using `similarity()`.
    2. Index search with kind/stance/basis/activeOnly WHERE clauses → Implement with PG WHERE clauses
    3. `filterActiveCommitments` — checks `private_cognition_current.status` → PG WHERE
    4. `sortCommitments` — uses `json_extract(record_json, '$.priority')` → Replace with PG `(record_json->>'priority')::integer`
    5. `getActiveCurrent` — reads from `private_cognition_current` → PG query
    6. `resolveCognitionKey` — queries `private_cognition_current` by id → PG query
  - Define contract interface in `src/storage/domain-repos/contracts/cognition-search-repo.ts`
  - All methods MUST be async
  - **FTS translation decision**: Use `similarity()` trigram matching (same pattern as PgSearchProjectionRepo) since pg_trgm is already available. Do NOT attempt to replicate FTS5 token-level semantics exactly — "roughly equivalent search quality" is acceptable.
  - Remove `escapeFtsQuery()` function (SQLite FTS5-specific, lines 384-399) — not needed for PG trigram search

  **Must NOT do**:
  - Do NOT touch CognitionRepository write path (`src/memory/cognition/cognition-repo.ts`, 1065 lines)
  - Do NOT migrate `PrivateCognitionProjectionRepo` write methods (upsertFromEvent, rebuild, retract)
  - Do NOT try to replicate SQLite FTS5 MATCH semantics exactly — trigram similarity is sufficient
  - Do NOT modify `search_docs_cognition_fts` table or its population logic

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex FTS migration, multiple query patterns, JSON operator translation, needs careful testing
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: No browser work

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3, 4, 5)
  - **Blocks**: Task 6 (CognitionSearchService refactor)
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL):

  **Pattern References** (existing code to follow):
  - `src/storage/domain-repos/pg/search-projection-repo.ts` — `PgSearchProjectionRepo.searchCognition()`: **PRIMARY PATTERN** — shows how to do trigram similarity search in PG for cognition data. Copy this approach.
  - `src/storage/domain-repos/pg/cognition-projection-repo.ts` — `PgCognitionProjectionRepo`: Existing PG repo for cognition projection reads (getCurrent, getAllCurrent)
  - `src/storage/domain-repos/pg/cognition-event-repo.ts` — `PgCognitionEventRepo`: PG repo for cognition events

  **API/Type References** (contracts to implement against):
  - `src/memory/cognition/cognition-search.ts:67-439` — Full CognitionSearchService: every method to replicate at repo level
  - `src/memory/cognition/cognition-search.ts:384-399` — `escapeFtsQuery()`: SQLite FTS5 syntax to understand what it does (NOT to replicate)
  - `src/memory/cognition/cognition-search.ts:33-45` — `CognitionHit` type (the actual return element type of `searchCognition()`). Note: `CognitionHit` is defined in `cognition-search.ts`, NOT in `types.ts`. There is NO `CognitionSearchResult` type — `searchCognition()` returns `CognitionHit[]` directly.

  **Test References** (testing patterns to follow):
  - `test/pg-app/pg-narrative-search-repo.test.ts` — Similar search repo test pattern
  - `test/pg-app/pg-search-projection-repo.test.ts` — Cognition search test via PG

  **WHY Each Reference Matters**:
  - search-projection-repo.ts: The closest existing PG cognition search — shows `similarity()` usage, threshold values, result mapping
  - cognition-search.ts: The source of truth for what queries must be replicated — 8 distinct query patterns
  - cognition-projection-repo.ts: Existing PG repo for some cognition reads — may be reusable for `getActiveCurrent`

  **Acceptance Criteria**:

  **TDD:**
  - [ ] Contract interface created: `src/storage/domain-repos/contracts/cognition-search-repo.ts`
  - [ ] Test file created: `test/pg-app/pg-cognition-search-repo.test.ts`
  - [ ] `bun test test/pg-app/pg-cognition-search-repo.test.ts` → PASS

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Trigram search finds relevant cognition entries
    Tool: Bash (bun test)
    Preconditions: PG database with seeded private_cognition_current entries and search_docs content
    Steps:
      1. Run `bun test test/pg-app/pg-cognition-search-repo.test.ts --filter "search"`
      2. Verify FTS-equivalent search returns results with similarity scores
      3. Verify results are ordered by relevance (highest similarity first)
    Expected Result: Search returns matching entries with similarity > threshold
    Failure Indicators: Empty results when matching data exists, no ordering
    Evidence: .sisyphus/evidence/task-2-trigram-search.txt

  Scenario: Filtering by kind/stance/basis/activeOnly works
    Tool: Bash (bun test)
    Preconditions: PG database with cognition entries of different kinds, stances, statuses
    Steps:
      1. Run `bun test test/pg-app/pg-cognition-search-repo.test.ts --filter "filter"`
      2. Verify kind filter returns only matching kinds
      3. Verify activeOnly filter excludes non-active entries
      4. Verify stance filter works correctly
    Expected Result: All filter combinations produce correct subsets
    Failure Indicators: Unfiltered results, wrong counts
    Evidence: .sisyphus/evidence/task-2-filter-queries.txt

  Scenario: JSON operator translation correct (sortCommitments)
    Tool: Bash (bun test)
    Preconditions: PG database with cognition entries having record_json with priority and horizon fields
    Steps:
      1. Run `bun test test/pg-app/pg-cognition-search-repo.test.ts --filter "sort|commitment"`
      2. Verify sorting by priority uses PG jsonb operator (record_json->>'priority')
      3. Verify results ordered correctly by priority (descending)
    Expected Result: Commitments sorted by priority from record_json
    Failure Indicators: PG syntax error on json_extract, wrong sort order
    Evidence: .sisyphus/evidence/task-2-json-sort.txt
  ```

  **Evidence to Capture:**
  - [ ] task-2-trigram-search.txt
  - [ ] task-2-filter-queries.txt
  - [ ] task-2-json-sort.txt

  **Commit**: YES (groups with T1, T3, T4)
  - Message: `feat(storage): add PG repos for retrieval read, cognition search, relation read, alias`
  - Files: `src/storage/domain-repos/pg/cognition-search-repo.ts`, `src/storage/domain-repos/contracts/cognition-search-repo.ts`, `test/pg-app/pg-cognition-search-repo.test.ts`
  - Pre-commit: `bun test test/pg-app/pg-cognition-search-repo.test.ts`

- [ ] 3. PgRelationReadRepo — Read-path PG repo for RelationBuilder conflict queries

  **What to do**:
  - RED: Write tests for `PgRelationReadRepo` covering conflict evidence and history queries
  - GREEN: Implement in `src/storage/domain-repos/pg/relation-read-repo.ts`
  - Queries to implement (read-path ONLY from RelationBuilder):
    1. `getConflictEvidence(cognitionKey, agentId)` — reads `memory_relations` for contested evidence
    2. `getConflictHistory(cognitionKey, agentId)` — reads `memory_relations` for conflict history
    3. `resolveSourceAgentId(eventId)` — queries `private_cognition_current` and `private_episode_events`
    4. `resolveCanonicalCognitionRefByKey(cognitionKey)` — queries `private_cognition_current`
  - Define contract interface in `src/storage/domain-repos/contracts/relation-read-repo.ts`
  - All methods MUST be async

  **Must NOT do**:
  - Do NOT implement `writeContestRelations()` or `writeRelation()` — those are write-path (settlement pipeline)
  - Do NOT modify `RelationBuilder` class itself — Task 6 will use this repo through CognitionSearchService

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 4 straightforward read queries, clear patterns from existing PG repos, limited scope
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - None relevant

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4, 5)
  - **Blocks**: Task 6 (CognitionSearchService refactor)
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL):

  **Pattern References**:
  - `src/storage/domain-repos/pg/graph-read-query-repo.ts` — PgGraphReadQueryRepo: PG read repo pattern with multiple query methods
  - `src/storage/domain-repos/pg/cognition-projection-repo.ts` — PgCognitionProjectionRepo: PG repo for cognition reads

  **API/Type References**:
  - `src/memory/cognition/relation-builder.ts` — RelationBuilder class: exact methods to replicate (read-path only)
  - `src/memory/types.ts` — Return types for conflict evidence/history

  **Test References**:
  - `test/pg-app/pg-graph-store-repo.test.ts` — PG repo test pattern
  - `test/memory/relation-contract.test.ts` — Existing relation contract tests (understand expected behavior)

  **WHY Each Reference Matters**:
  - relation-builder.ts: Source of truth for the 4 read queries — exact SQL to replicate
  - relation-contract.test.ts: Shows expected behavior/contracts for relation operations

  **Acceptance Criteria**:

  **TDD:**
  - [ ] Contract interface created: `src/storage/domain-repos/contracts/relation-read-repo.ts`
  - [ ] Test file created: `test/pg-app/pg-relation-read-repo.test.ts`
  - [ ] `bun test test/pg-app/pg-relation-read-repo.test.ts` → PASS

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Conflict evidence query returns correct relations
    Tool: Bash (bun test)
    Preconditions: PG database with seeded memory_relations entries
    Steps:
      1. Run `bun test test/pg-app/pg-relation-read-repo.test.ts`
      2. Verify getConflictEvidence returns relations for given cognition key
      3. Verify getConflictHistory returns historical conflict data
    Expected Result: All tests pass, correct relation data returned
    Failure Indicators: Empty results when data exists, wrong agent filtering
    Evidence: .sisyphus/evidence/task-3-relation-read.txt

  Scenario: Empty database returns empty arrays (not errors)
    Tool: Bash (bun test)
    Preconditions: PG database with no matching memory_relations
    Steps:
      1. Run `bun test test/pg-app/pg-relation-read-repo.test.ts --filter "empty"`
      2. Verify all methods return empty arrays, not null or throw
    Expected Result: Empty arrays returned gracefully
    Failure Indicators: Null returns, thrown errors
    Evidence: .sisyphus/evidence/task-3-empty-state.txt
  ```

  **Evidence to Capture:**
  - [ ] task-3-relation-read.txt
  - [ ] task-3-empty-state.txt

  **Commit**: YES (groups with T1, T2, T4)
  - Message: `feat(storage): add PG repos for retrieval read, cognition search, relation read, alias`
  - Files: `src/storage/domain-repos/pg/relation-read-repo.ts`, `src/storage/domain-repos/contracts/relation-read-repo.ts`, `test/pg-app/pg-relation-read-repo.test.ts`
  - Pre-commit: `bun test test/pg-app/pg-relation-read-repo.test.ts`

- [ ] 4. PgAliasRepo — PG repo for AliasService entity alias operations

  **What to do**:
  - RED: Write tests for `PgAliasRepo` covering all alias read/write operations
  - GREEN: Implement in `src/storage/domain-repos/pg/alias-repo.ts`
  - Queries to implement — **MUST match actual AliasService API** at `src/memory/alias.ts:11-127`:
    1. `resolveAlias(alias, ownerAgentId?)` (line 21-50) — 4 queries: agent-specific alias → shared alias → private entity_nodes by pointer_key → public entity_nodes by pointer_key. Returns `canonical_id | null`.
    2. `resolveAliases(aliases, ownerAgentId?)` (line 55-57) — bulk version, calls resolveAlias in loop. Returns `Map<string, number | null>`. (Can be implemented at service level using repo's resolveAlias, or as a batch query in the repo.)
    3. `createAlias(canonicalId, alias, aliasType?, ownerAgentId?)` (line 63-82) — **NOTE: The method is called `createAlias`, NOT `registerAlias`**. Uses `INSERT OR IGNORE` then SELECT. **CRITICAL**: `entity_aliases` table has NO unique constraint — only a regular index `idx_entity_aliases_alias_owner`. Use the **check-then-insert** pattern (same as `PgGraphMutableStoreRepo.createEntityAlias()` at `graph-mutable-store-repo.ts:437-448`): SELECT first, INSERT only if no match, then SELECT to return id.
    4. `getAliasesForEntity(canonicalId, ownerAgentId?)` (line 88-94) — query entity_aliases filtered by canonical_id and (owner IS NULL OR owner = agentId)
    5. `resolveParticipants(participantsJson)` (line 100-126) — parses JSON array of refs, resolves each via numeric ID lookup (`entity_nodes WHERE id=?`) or alias resolution (`resolveAlias`). Returns `Array<{ref, entityId|null}>`. This method has internal `db.prepare` calls that need PG equivalents.
  - The above covers ALL 5 public methods of AliasService. Do NOT invent methods that don't exist (no `lookupEntity`, `findEntityByName`, `getEntityById` — these are NOT in the current API).
  - The entity_nodes pointer_key lookups that `resolveAlias` does internally (lines 37-47) should be repo methods (e.g., `findEntityByPointerKey(pointerKey, scope, ownerAgentId?)`) since they are reused by both resolveAlias and resolveParticipants.
  - Define contract interface in `src/storage/domain-repos/contracts/alias-repo.ts`
  - All methods MUST be async

  **Must NOT do**:
  - Do NOT modify AliasService class itself — Task 7 will refactor it to use this repo

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 6 straightforward CRUD queries, clear SQLite→PG translations, small scope
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3, 5)
  - **Blocks**: Task 7 (AliasService refactor)
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL):

  **Pattern References**:
  - `src/storage/domain-repos/pg/embedding-repo.ts` — PgEmbeddingRepo: Clean PG repo with async methods
  - `src/storage/domain-repos/pg/graph-read-query-repo.ts:resolveEntityRefByPointerKey` — Already does entity pointer resolution in PG

  **API/Type References**:
  - `src/memory/alias.ts:11-80` — AliasService class: all methods to replicate at repo level
  - `src/memory/types.ts` — Entity-related types

  **Test References**:
  - `test/pg-app/pg-embedding-repo.test.ts` — Simple PG repo test pattern

  **WHY Each Reference Matters**:
  - alias.ts: Source of truth for all 6 queries — exact SQL to replicate
  - graph-read-query-repo.ts: Already has `resolveEntityRefByPointerKey` — potential reuse or pattern reference

  **Acceptance Criteria**:

  **TDD:**
  - [ ] Contract interface created: `src/storage/domain-repos/contracts/alias-repo.ts`
  - [ ] Test file created: `test/pg-app/pg-alias-repo.test.ts`
  - [ ] `bun test test/pg-app/pg-alias-repo.test.ts` → PASS

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: PgAliasRepo methods match actual AliasService needs
    Tool: Bash (bun test)
    Preconditions: PG database with entity_aliases and entity_nodes entries
    Steps:
      1. Run `bun test test/pg-app/pg-alias-repo.test.ts`
      2. Verify resolveAlias query path: agent-scoped alias → shared alias → private entity pointer_key → public entity pointer_key
      3. Verify createAlias with duplicate is idempotent (check-then-insert per graph-mutable-store-repo.ts:437 pattern, no duplicate rows)
      4. Verify getAliasesForEntity returns correct aliases filtered by owner
      5. Verify entity_nodes lookup by id (for resolveParticipants numeric refs)
    Expected Result: All tests pass
    Failure Indicators: Duplicate rows on createAlias, null for known aliases
    Evidence: .sisyphus/evidence/task-4-alias-repo.txt

  Scenario: Unknown alias returns null gracefully
    Tool: Bash (bun test)
    Preconditions: PG database without matching alias or entity
    Steps:
      1. Run `bun test test/pg-app/pg-alias-repo.test.ts --filter "unknown|missing"`
      2. Verify resolveAlias returns null for unknown alias (all 4 lookup paths return nothing)
      3. Verify entity_nodes lookup returns null for unknown id
    Expected Result: Null returns, no errors
    Failure Indicators: Thrown errors, undefined returns
    Evidence: .sisyphus/evidence/task-4-alias-unknown.txt
  ```

  **Evidence to Capture:**
  - [ ] task-4-alias-repo.txt
  - [ ] task-4-alias-unknown.txt

  **Commit**: YES (groups with T1, T2, T3)
  - Message: `feat(storage): add PG repos for retrieval read, cognition search, relation read, alias`
  - Files: `src/storage/domain-repos/pg/alias-repo.ts`, `src/storage/domain-repos/contracts/alias-repo.ts`, `test/pg-app/pg-alias-repo.test.ts`
  - Pre-commit: `bun test test/pg-app/pg-alias-repo.test.ts`

- [ ] 5. Sync→Async Cascade Analysis + Interface Contracts

  **What to do**:
  - Analyze and document ALL sync→async cascading changes needed before any service refactor begins
  - Use `lsp_find_references` on EVERY method across ALL services being changed from sync→async:
  - **RetrievalService methods** (sync→async):
    - `readByEntity()` — find all callers
    - `readByTopic()` — find all callers
    - `readByEventIds()` — find all callers
    - `readByFactIds()` — find all callers
  - **CognitionSearchService methods** (sync→async):
    - `searchCognition()` — find all callers. CRITICAL: `retrieval-orchestrator.ts:130` calls this SYNCHRONOUSLY, must become `await`
    - `filterActiveCommitments()` — find all callers
  - **CurrentProjectionReader methods** (sync→async):
    - `getActiveCurrent()` — CRITICAL: `retrieval-orchestrator.ts:99` calls `this.currentProjectionReader.getActiveCurrent(agentId)` SYNCHRONOUSLY. If backed by PG, must become `await`
  - **EpisodeRepository methods** (sync→async):
    - `readByAgent()` — CRITICAL: `retrieval-orchestrator.ts:386` calls `this.episodeRepository.readByAgent(agentId, limit)` SYNCHRONOUSLY. `PgEpisodeRepo` is async. Must become `await`
    - `readBySettlement()` — find all callers
  - **AliasService methods** (sync→async):
    - `resolveAlias()` — CRITICAL: `navigator.ts:316` calls `this.alias.resolveAlias(aliasToken, agentId)` SYNCHRONOUSLY inside `analyzeQuery()` which is itself NOT async. Must make `analyzeQuery()` async, which cascades to its caller `explore()`
  - For each method found: document the caller file:line, whether the caller is sync or async, and what change is needed (add `await`, make caller async, etc.)
  - Create/update TypeScript interface that defines the async API contract for RetrievalService:
    - Define `RetrievalServiceLike` interface (or update existing if one exists) with all methods as `Promise<...>`
    - This interface will be the target for Task 8's refactor
  - Document the complete caller map in `.sisyphus/drafts/sync-async-cascade.md` with a table format:
    ```
    | Method | Current | Caller File:Line | Caller Is Async? | Change Needed |
    ```
  - Check `VisibilityPolicy.eventVisibilityPredicate()` — read its implementation, document whether it generates PG-compatible SQL or needs adaptation. This finding feeds into Task 1.

  **Must NOT do**:
  - Do NOT modify any service implementations yet — this is analysis + interface definition only
  - Do NOT change any callers yet

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: LSP reference lookups + interface definition, no complex logic
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3, 4)
  - **Blocks**: Tasks 8 (RetrievalService refactor), 9 (prompt-data.ts refactor)
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL):

  **Pattern References**:
  - `src/memory/retrieval.ts:68-98` — RetrievalService class: all public methods
  - `src/memory/cognition/cognition-search.ts:67-100` — CognitionSearchService: public API

  **API/Type References**:
  - `src/memory/contracts/` — Existing contracts directory for memory services
  - `src/core/prompt-data-sources.ts` — `MemoryDataSource` type: defines the adapter interface that ultimately consumes RetrievalService
  - `src/memory/tools.ts` — Tool handler functions: callers of sync methods
  - `src/memory/retrieval/retrieval-orchestrator.ts` — RetrievalOrchestrator: calls CognitionSearchService.searchCognition()
  - `src/memory/navigator.ts` — GraphNavigator: calls RetrievalService methods
  - `src/memory/contracts/visibility-policy.ts` — VisibilityPolicy: eventVisibilityPredicate implementation

  **WHY Each Reference Matters**:
  - Each caller file must be updated to `await` the now-async methods — the cascade map prevents missed callers
  - visibility-policy.ts: If it generates SQLite SQL, Task 1 needs to know before implementing PG queries

  **Acceptance Criteria**:

  **TDD:**
  - [ ] Interface file created/updated with async signatures
  - [ ] Cascade analysis document complete at `.sisyphus/drafts/sync-async-cascade.md`

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Cascade map is complete — no caller missed
    Tool: Bash (grep) + LSP tools (lsp_find_references if available in agent environment)
    Preconditions: Interface file exists
    Steps:
      1. PRIMARY (agent has LSP): Use `lsp_find_references` on each method being migrated (readByEntity, readByTopic, readByEventIds, readByFactIds, searchCognition, resolveAlias, readByAgent, getActiveCurrent)
      2. FALLBACK (no LSP): Use `grep -rn "readByEntity\|readByTopic\|readByEventIds\|readByFactIds" src/ --include="*.ts"` to find all callers. Repeat for searchCognition, resolveAlias, readByAgent, getActiveCurrent.
      3. Use `grep -rn "\.resolveAlias(" src/ --include="*.ts"` to find all AliasService callers
      4. Cross-reference all found callers against the cascade analysis document
      5. Verify every caller file:line is listed in the cascade document
    Expected Result: Zero undocumented callers — every grep/LSP hit appears in cascade doc
    Failure Indicators: Any caller found by grep that is not in the cascade document
    Evidence: .sisyphus/evidence/task-5-cascade-analysis.md

  Scenario: VisibilityPolicy SQL compatibility assessed
    Tool: Bash (grep)
    Preconditions: visibility-policy.ts readable
    Steps:
      1. Read VisibilityPolicy.eventVisibilityPredicate() implementation
      2. Search for SQLite-specific functions: json_extract, typeof, ifnull, group_concat
      3. Document PG equivalents or confirm compatibility
    Expected Result: Clear YES/NO on PG compatibility with specific findings
    Failure Indicators: Ambiguous assessment
    Evidence: .sisyphus/evidence/task-5-visibility-sql-compat.md
  ```

  **Evidence to Capture:**
  - [ ] task-5-cascade-analysis.md — Complete caller map
  - [ ] task-5-visibility-sql-compat.md — SQL compatibility assessment

  **Commit**: YES (standalone)
  - Message: `refactor(memory): define async interface contracts for retrieval service migration`
  - Files: Interface file, `.sisyphus/drafts/sync-async-cascade.md`
  - Pre-commit: `bun test` (no regressions)

- [ ] 6. Refactor CognitionSearchService — Replace Db with PgCognitionSearchRepo + PgRelationReadRepo

  **What to do**:
  - RED: Write tests for the refactored CognitionSearchService that uses PG repos instead of `Db`
  - GREEN: Modify `src/memory/cognition/cognition-search.ts`:
    1. Change constructor: remove `db: Db`, accept `PgCognitionSearchRepo` + `PgRelationReadRepo` (or their contract interfaces)
    2. Replace all `this.db.prepare(...)` calls with repo method calls
    3. Remove internal `new PrivateCognitionProjectionRepo(this.db)` — use `PgCognitionProjectionRepo` via repo
    4. Remove internal `new RelationBuilder(this.db)` — use `PgRelationReadRepo` for read queries
    5. Make `searchCognition()` async (it was sync returning `CognitionHit[]`, now returns `Promise<CognitionHit[]>` — note: the type is `CognitionHit[]` defined at `cognition-search.ts:33`, there is NO `CognitionSearchResult` type)
    6. Make `filterActiveCommitments()` async
    7. Remove `escapeFtsQuery()` helper function (FTS5-specific, no longer needed)
    8. **Refactor `CurrentProjectionReader` class** (`cognition-search.ts:407-437`):
       - Make ALL methods async (return `Promise<...>`) — `getCurrent()`, `getAllCurrent()`, `getAllCurrentByKind()`, `getActiveCurrent()`
       - Change constructor: accept PG-backed repo (e.g. `PgCognitionProjectionRepo`) instead of SQLite-backed `PrivateCognitionProjectionRepo`
       - The class currently delegates every call to `this.repo.getCurrent()` / `this.repo.getAllCurrent()` — when repo becomes PG, these return Promises, so every method in the reader MUST become async
    9. **Refactor `createCurrentProjectionReader()` factory** (`cognition-search.ts:402-404`):
       - Currently: `return new CurrentProjectionReader(new PrivateCognitionProjectionRepo(this.db))` — uses `this.db` (SQLite)
       - After: accept/inject a PG-backed projection repo instead of constructing `PrivateCognitionProjectionRepo(this.db)`
       - This factory is how `RetrievalOrchestrator` gets its `currentProjectionReader` — if the factory still uses `this.db`, the async cutover at the call site (`retrieval-orchestrator.ts:99`) will silently break
  - REFACTOR: Clean up SQLite-isms (json_extract → jsonb operators handled by repo layer)
  - Update ALL callers identified in Task 5's cascade analysis to `await` the now-async methods:
    - `RetrievalOrchestrator.search()` (line 128-136) → `await this.cognitionService.searchCognition(...)` (currently sync call, MUST add await)
    - `RetrievalOrchestrator.search()` (line 98-99) → `await this.currentProjectionReader.getActiveCurrent(...)` if currentProjectionReader is backed by PG (check cascade doc)
    - Any tool handlers in tools.ts that call cognition methods
    - Any other callers found in Task 5's cascade analysis

  **Must NOT do**:
  - Do NOT touch CognitionRepository write path (`src/memory/cognition/cognition-repo.ts`)
  - Do NOT modify `PrivateCognitionProjectionRepo` write methods
  - Do NOT modify `RelationBuilder` write methods
  - Do NOT create new tables or modify PG schema

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex refactor — 439-line class, sync→async cascade, multiple internal dependency replacements
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 7)
  - **Parallel Group**: Wave 2 (with Task 7)
  - **Blocks**: Task 8 (RetrievalService refactor)
  - **Blocked By**: Task 2 (PgCognitionSearchRepo), Task 3 (PgRelationReadRepo)

  **References** (CRITICAL):

  **Pattern References**:
  - `src/memory/narrative/narrative-search.ts:20` — NarrativeSearchService: **MODEL REFACTOR** — already takes `NarrativeSearchRepo` interface, not `Db`. Copy this constructor pattern.
  - `src/storage/domain-repos/contracts/cognition-search-repo.ts` — Created in Task 2: the contract interface to depend on

  **API/Type References**:
  - `src/memory/cognition/cognition-search.ts:67-439` — Current CognitionSearchService: every method being refactored
  - `src/memory/cognition/relation-builder.ts` — RelationBuilder: internal dependency being replaced
  - `src/memory/cognition/private-cognition-current.ts` — PrivateCognitionProjectionRepo: internal dependency being replaced
  - `.sisyphus/drafts/sync-async-cascade.md` — Cascade analysis from Task 5: which callers need updating

  **Test References**:
  - `src/memory/cognition/belief-revision.test.ts` — Existing cognition test (maintain compatibility)
  - `test/pg-app/pg-cognition-search-repo.test.ts` — PG repo tests from Task 2

  **WHY Each Reference Matters**:
  - narrative-search.ts: Shows the exact pattern to follow — constructor takes repo interface, delegates all DB work
  - cascade analysis: Lists every caller that must be updated to await the now-async methods
  - belief-revision.test.ts: Existing tests that must not break

  **Acceptance Criteria**:

  **TDD:**
  - [ ] Test file created/updated: `test/memory/cognition-search-pg.test.ts`
  - [ ] `bun test test/memory/cognition-search-pg.test.ts` → PASS
  - [ ] `bun test src/memory/cognition/belief-revision.test.ts` → PASS (no regressions)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: CognitionSearchService works with PG repos
    Tool: Bash (bun test)
    Preconditions: PgCognitionSearchRepo and PgRelationReadRepo available (from Tasks 2, 3)
    Steps:
      1. Run `bun test test/memory/cognition-search-pg.test.ts`
      2. Verify searchCognition returns results via PG trigram search
      3. Verify filterActiveCommitments returns only active items
      4. Verify conflict enrichment works via PgRelationReadRepo
    Expected Result: All tests pass, same behavior as SQLite version
    Failure Indicators: Import errors, "db.prepare is not a function", missing methods
    Evidence: .sisyphus/evidence/task-6-cognition-search-refactor.txt

  Scenario: No Db import remains in cognition-search.ts
    Tool: Bash (grep)
    Preconditions: Refactor complete
    Steps:
      1. Run `grep -n "import.*Db\|db.prepare\|db.query\|from.*db-types" src/memory/cognition/cognition-search.ts`
      2. Verify zero matches
    Expected Result: No SQLite references remain
    Failure Indicators: Any grep match
    Evidence: .sisyphus/evidence/task-6-no-sqlite-refs.txt

  Scenario: CurrentProjectionReader is fully async and uses PG repo
    Tool: Bash (grep + bun test)
    Preconditions: Task 6 refactor complete
    Steps:
      1. Run `grep -n "async getCurrent\|async getAllCurrent\|async getAllCurrentByKind\|async getActiveCurrent" src/memory/cognition/cognition-search.ts`
      2. Verify 4 matches — ALL 4 methods of CurrentProjectionReader are now async
      3. Run `grep -n "PrivateCognitionProjectionRepo" src/memory/cognition/cognition-search.ts`
      4. Verify zero matches — no SQLite-backed projection repo remains
      5. Run `grep -n "createCurrentProjectionReader" src/memory/cognition/cognition-search.ts`
      6. Verify factory no longer instantiates `PrivateCognitionProjectionRepo(this.db)`
      7. Run `grep -n "await.*getActiveCurrent\|await.*currentProjectionReader" src/memory/retrieval/retrieval-orchestrator.ts`
      8. Verify caller at line ~99 now uses `await`
    Expected Result: Reader class fully async, no SQLite repo, caller properly awaits
    Failure Indicators: Missing async keyword on any reader method, PrivateCognitionProjectionRepo still imported, caller not awaiting
    Evidence: .sisyphus/evidence/task-6-current-projection-reader-async.txt
  ```

  **Evidence to Capture:**
  - [ ] task-6-cognition-search-refactor.txt
  - [ ] task-6-no-sqlite-refs.txt
  - [ ] task-6-current-projection-reader-async.txt

  **Commit**: YES (groups with T7)
  - Message: `refactor(memory): migrate CognitionSearchService and AliasService to PG repos`
  - Files: `src/memory/cognition/cognition-search.ts`, `src/memory/retrieval/retrieval-orchestrator.ts`, `test/memory/cognition-search-pg.test.ts`
  - Pre-commit: `bun test test/memory/`

- [ ] 7. Refactor AliasService — Replace DbLike with PgAliasRepo

  **What to do**:
  - RED: Write tests for refactored AliasService using PG repo
  - GREEN: Modify `src/memory/alias.ts`:
    1. Change constructor: remove `db: DbLike`, accept `AliasRepo` contract interface (from Task 4)
    2. Replace all `this.db.prepare(...)` calls with repo method calls
    3. Make all methods async (they were sync with SQLite)
  - REFACTOR: Clean up, remove unused imports
  - Update callers (from Task 5 cascade analysis):
    - GraphNavigator constructor passes AliasService
    - Any other callers identified

  **Must NOT do**:
  - Do NOT change the public API surface beyond sync→async
  - Do NOT add new methods or features

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Class is 127 lines with 5 public methods, straightforward constructor swap + sync→async
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 6)
  - **Parallel Group**: Wave 2 (with Task 6)
  - **Blocks**: Task 11 (Wire runtime.ts — needs PG-native AliasService for GraphNavigator)
  - **Blocked By**: Task 4 (PgAliasRepo)

  **References** (CRITICAL):

  **Pattern References**:
  - `src/memory/narrative/narrative-search.ts:20` — NarrativeSearchService: Model pattern — constructor takes repo interface

  **API/Type References**:
  - `src/memory/alias.ts:11-127` — Current AliasService: full class to refactor (5 public methods: resolveAlias, resolveAliases, createAlias, getAliasesForEntity, resolveParticipants)
  - `src/storage/domain-repos/contracts/alias-repo.ts` — Created in Task 4: the contract interface to depend on
  - `.sisyphus/drafts/sync-async-cascade.md` — Cascade analysis from Task 5

  **Test References**:
  - `test/pg-app/pg-alias-repo.test.ts` — PG repo tests from Task 4

  **WHY Each Reference Matters**:
  - alias.ts: The class being refactored — need to understand current structure
  - alias-repo.ts contract: The interface to inject instead of DbLike

  **Acceptance Criteria**:

  **TDD:**
  - [ ] Test file created: `test/memory/alias-service-pg.test.ts`
  - [ ] `bun test test/memory/alias-service-pg.test.ts` → PASS

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: AliasService works with PG repo — all 5 public methods
    Tool: Bash (bun test)
    Preconditions: PgAliasRepo available (from Task 4)
    Steps:
      1. Run `bun test test/memory/alias-service-pg.test.ts`
      2. Verify resolveAlias(alias, ownerAgentId) returns correct entity via PG (agent-scoped → shared → pointer_key fallback)
      3. Verify resolveAliases(aliases, ownerAgentId) bulk resolves correctly
      4. Verify createAlias(canonicalId, alias, aliasType, ownerAgentId) is idempotent via PG (check-then-insert, returns id)
      5. Verify getAliasesForEntity(canonicalId, ownerAgentId) returns matching aliases
      6. Verify resolveParticipants(participantsJson) parses JSON and resolves entity refs
    Expected Result: All 5 methods work via PG repo
    Failure Indicators: "db.prepare is not a function", wrong method names, missing methods
    Evidence: .sisyphus/evidence/task-7-alias-service.txt

  Scenario: No Db/DbLike import remains in alias.ts
    Tool: Bash (grep)
    Preconditions: Refactor complete
    Steps:
      1. Run `grep -n "DbLike\|db.prepare\|from.*db-types" src/memory/alias.ts`
      2. Verify zero matches
    Expected Result: No SQLite references remain
    Failure Indicators: Any grep match
    Evidence: .sisyphus/evidence/task-7-no-sqlite-refs.txt
  ```

  **Evidence to Capture:**
  - [ ] task-7-alias-service.txt
  - [ ] task-7-no-sqlite-refs.txt

  **Commit**: YES (groups with T6)
  - Message: `refactor(memory): migrate CognitionSearchService and AliasService to PG repos`
  - Files: `src/memory/alias.ts`, `test/memory/alias-service-pg.test.ts`
  - Pre-commit: `bun test test/memory/alias-service-pg.test.ts`

- [ ] 8. Refactor RetrievalService — Remove Db, inject PG repos, make sync methods async

  **What to do**:
  - RED: Write tests for refactored RetrievalService using PG repos
  - GREEN: Modify `src/memory/retrieval.ts`:
    1. Change constructor: remove `db: Db`, accept:
       - `PgRetrievalReadRepo` (from Task 1) — for all entity/topic/event/fact/pointer queries
       - `CognitionSearchService` (refactored in Task 6) — now PG-native
       - `EmbeddingService` — already PG-native (keep as-is)
       - `NarrativeSearchService` — already PG-native via PgNarrativeSearchRepo (keep as-is)
       - Optional: `RetrievalOrchestrator`, `VisibilityPolicy`, `EpisodeRepository` (already have PG impls)
    2. Replace all 15 `this.db.prepare(...)` calls with `this.retrievalRepo.methodName(...)` calls
    3. Make `readByEntity()`, `readByTopic()`, `readByEventIds()`, `readByFactIds()` async (return `Promise<...>`)
    4. Remove `resolveRedirect()` direct SQL — delegate to `this.retrievalRepo.resolveRedirect()`
    5. Remove `resolveEntityByPointer()` direct SQL — delegate to `this.retrievalRepo.resolveEntityByPointer()`
    6. In `localizeSeedsHybrid()`: replace `this.db.prepare("SELECT count(*) FROM node_embeddings")` with `this.retrievalRepo.countNodeEmbeddings()`
  - REFACTOR: Remove `import { Db } from '../storage/db-types'`, clean up
  - Update ALL callers identified in Task 5's cascade analysis (known critical ones below + any others found):
    - `tools.ts` memory_read handler: `await retrieval.readByEntity(...)` (was sync)
    - `tools.ts` narrative_search handler: already async (verify)
    - `retrieval-orchestrator.ts:386`: `await this.episodeRepository.readByAgent(agentId, limit)` — currently SYNC, PgEpisodeRepo is async. `resolveEpisodeHints()` (line 377) must become async, which cascades to `search()`.
    - `retrieval-orchestrator.ts:99`: `await this.currentProjectionReader.getActiveCurrent(agentId)` — currently SYNC, if PG-backed must become async
    - `navigator.ts:316`: `await this.alias.resolveAlias(aliasToken, agentId)` — currently SYNC (from AliasService refactor in Task 7). `analyzeQuery()` (line 302) is NOT async — must become async, which cascades to `explore()`.
    - Any others from Task 5's cascade analysis document

  **Must NOT do**:
  - Do NOT change the semantic behavior of any method — same inputs should produce same outputs
  - Do NOT add new features or methods
  - Do NOT touch the write path (no organizer/settlement changes)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Core migration task — 15 query replacements, sync→async cascade through multiple callers, highest risk task in the plan
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential after T6, T7)
  - **Blocks**: Tasks 10 (MemoryAdapter), 11 (Wire runtime.ts), 12 (Integration tests)
  - **Blocked By**: Tasks 1 (PgRetrievalReadRepo), 5 (Cascade analysis), 6 (CognitionSearch refactored), 7 (AliasService refactored)

  **References** (CRITICAL):

  **Pattern References**:
  - `src/memory/narrative/narrative-search.ts` — Model service: already PG-native, repo-injected. Copy the constructor pattern.
  - `src/storage/domain-repos/contracts/retrieval-read-repo.ts` — Created in Task 1: the contract to inject

  **API/Type References**:
  - `src/memory/retrieval.ts:68-404` — Current RetrievalService: the class being refactored
  - `src/memory/types.ts` — Return types: EntityReadResult, TopicReadResult, EventNode, FactEdge
  - `.sisyphus/drafts/sync-async-cascade.md` — Complete caller map from Task 5
  - `src/memory/tools.ts` — Tool handlers that call RetrievalService methods
  - `src/memory/navigator.ts` — GraphNavigator: calls RetrievalService methods
  - `src/memory/retrieval/retrieval-orchestrator.ts` — RetrievalOrchestrator: calls methods

  **Test References**:
  - `test/pg-app/pg-retrieval-read-repo.test.ts` — PG repo tests from Task 1
  - `test/memory/pipeline-e2e.test.ts` — E2E memory pipeline test (must not break)

  **WHY Each Reference Matters**:
  - retrieval.ts: THE file being refactored — every line matters
  - sync-async-cascade.md: Prevents missing any caller that needs async updates
  - tools.ts: Memory tools are the primary consumers — must verify they work after refactor
  - pipeline-e2e.test.ts: Regression test for the memory pipeline

  **Acceptance Criteria**:

  **TDD:**
  - [ ] Test file created: `test/memory/retrieval-service-pg.test.ts`
  - [ ] `bun test test/memory/retrieval-service-pg.test.ts` → PASS
  - [ ] `bun test test/memory/pipeline-e2e.test.ts` → PASS (no regressions)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: RetrievalService methods work with PG repos
    Tool: Bash (bun test)
    Preconditions: All PG repos wired (Tasks 1-4 complete)
    Steps:
      1. Run `bun test test/memory/retrieval-service-pg.test.ts`
      2. Verify readByEntity returns entity data from PG
      3. Verify readByTopic returns topic data from PG
      4. Verify readByEventIds returns events from PG
      5. Verify readByFactIds returns facts from PG
      6. Verify searchVisibleNarrative delegates to NarrativeSearchService
      7. Verify generateTypedRetrieval produces non-empty content
    Expected Result: All methods functional via PG
    Failure Indicators: "db.prepare is not a function", empty results from PG
    Evidence: .sisyphus/evidence/task-8-retrieval-service.txt

  Scenario: No Db import remains in retrieval.ts
    Tool: Bash (grep)
    Preconditions: Refactor complete
    Steps:
      1. Run `grep -n "import.*Db\b\|db\.prepare\|from.*db-types" src/memory/retrieval.ts`
      2. Verify zero matches
    Expected Result: No SQLite references remain
    Failure Indicators: Any grep match
    Evidence: .sisyphus/evidence/task-8-no-sqlite-refs.txt

  Scenario: All callers updated to await async methods
    Tool: Bash (bun test)
    Preconditions: All callers updated per cascade analysis
    Steps:
      1. Run `bun test` (full suite)
      2. Verify no "Promise returned but not awaited" warnings
      3. Verify tools.ts handlers work correctly
    Expected Result: Full test suite passes
    Failure Indicators: Unhandled promise, type errors about Promise vs value
    Evidence: .sisyphus/evidence/task-8-full-test-suite.txt
  ```

  **Evidence to Capture:**
  - [ ] task-8-retrieval-service.txt
  - [ ] task-8-no-sqlite-refs.txt
  - [ ] task-8-full-test-suite.txt

  **Commit**: YES (groups with T9)
  - Message: `refactor(memory): make RetrievalService PG-native and refactor prompt-data.ts`
  - Files: `src/memory/retrieval.ts`, `src/memory/tools.ts`, `src/memory/navigator.ts`, `src/memory/retrieval/retrieval-orchestrator.ts`, `test/memory/retrieval-service-pg.test.ts`
  - Pre-commit: `bun test`

- [ ] 9. Refactor prompt-data.ts — Remove Db parameter from getTypedRetrievalSurfaceAsync

  **What to do**:
  - RED: Write test for refactored `getTypedRetrievalSurfaceAsync` accepting `RetrievalService` directly
  - GREEN: Modify `src/memory/prompt-data.ts`:
    1. Current signature (line 292-297): `getTypedRetrievalSurfaceAsync(userMessage: string, viewerContext: ViewerContext, db: Db, repos: PromptDataRepos, retrievalService?: RetrievalService)`
       New signature: `getTypedRetrievalSurfaceAsync(userMessage: string, viewerContext: ViewerContext, retrieval: RetrievalService, repos: PromptDataRepos)`
       Remove `db: Db` param, make `retrieval` required (not optional)
    2. Remove `const retrievalServiceByDb = new WeakMap<Db, RetrievalService>()` (line 28)
    3. Remove `function resolveRetrievalService(db: Db, retrievalService?: RetrievalService)` (lines 30-45) — this function lazily creates a RetrievalService from Db with WeakMap caching. No longer needed since caller provides the service directly.
    4. Replace `const retrieval = resolveRetrievalService(db, retrievalService)` (line 303) with direct use of the `retrieval` parameter
    5. Remove `import type { Db } from '../storage/db-types'` (line 1)
    6. Remove `import { RetrievalService } from './retrieval'` at top-level if it was only used by resolveRetrievalService — but keep the TYPE import if needed for the new parameter
  - REFACTOR: Simplify the function now that it receives a ready-to-use service instead of building one
  - Update callers:
    - `MemoryAdapter.getTypedRetrievalSurface()` (Task 10 will handle this, but ensure the interface matches)

  **Must NOT do**:
  - Do NOT change the output format of `getTypedRetrievalSurfaceAsync` — same prompt text shape
  - Do NOT add new retrieval types or change token budgets

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small focused refactor — one function signature change, remove cache, update import
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 6, 7, 8 — but only after Task 5)
  - **Parallel Group**: Wave 2 (can run parallel with T6/T7)
  - **Blocks**: Task 10 (MemoryAdapter refactor)
  - **Blocked By**: Task 5 (Cascade analysis — to know all callers)

  **References** (CRITICAL):

  **Pattern References**:
  - `src/memory/prompt-data.ts:292-338` — `getTypedRetrievalSurfaceAsync()`: THE function being refactored

  **API/Type References**:
  - `src/memory/prompt-data.ts:1-50` — Imports and type definitions
  - `src/core/prompt-data-adapters/memory-adapter.ts` — MemoryAdapter: primary caller of this function
  - `.sisyphus/drafts/sync-async-cascade.md` — Caller map

  **WHY Each Reference Matters**:
  - prompt-data.ts:292-338: The exact function being changed — need to understand the WeakMap cache pattern and why it existed
  - memory-adapter.ts: The caller that must match the new signature

  **Acceptance Criteria**:

  **TDD:**
  - [ ] Test added to existing test file or new: `test/memory/prompt-data-pg.test.ts`
  - [ ] `bun test test/memory/prompt-data-pg.test.ts` → PASS

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: getTypedRetrievalSurfaceAsync accepts RetrievalService directly
    Tool: Bash (bun test)
    Preconditions: RetrievalService refactored (Task 8)
    Steps:
      1. Run `bun test test/memory/prompt-data-pg.test.ts`
      2. Verify function accepts RetrievalService, not Db
      3. Verify output format unchanged (same prompt text structure)
    Expected Result: Tests pass, output format preserved
    Failure Indicators: Type errors, changed output format
    Evidence: .sisyphus/evidence/task-9-prompt-data.txt

  Scenario: No Db reference remains in prompt-data.ts
    Tool: Bash (grep)
    Preconditions: Refactor complete
    Steps:
      1. Run `grep -n "import.*Db\b\|WeakMap.*Db\|db: Db\|from.*db-types" src/memory/prompt-data.ts`
      2. Verify zero matches
    Expected Result: No SQLite references remain
    Failure Indicators: Any grep match
    Evidence: .sisyphus/evidence/task-9-no-sqlite-refs.txt
  ```

  **Evidence to Capture:**
  - [ ] task-9-prompt-data.txt
  - [ ] task-9-no-sqlite-refs.txt

  **Commit**: YES (groups with T8)
  - Message: `refactor(memory): make RetrievalService PG-native and refactor prompt-data.ts`
  - Files: `src/memory/prompt-data.ts`, `test/memory/prompt-data-pg.test.ts`
  - Pre-commit: `bun test test/memory/prompt-data-pg.test.ts`

- [ ] 10. Refactor MemoryAdapter — Accept RetrievalService, revive from dead code

  **What to do**:
  - RED: Write tests for MemoryAdapter using RetrievalService instead of Db
  - GREEN: Modify `src/core/prompt-data-adapters/memory-adapter.ts`:
    1. Change constructor: remove `db: Db`, accept `RetrievalService` (or its interface). Keep `repos: PromptDataRepos` as-is (most methods delegate to repos, not to Db).
       Current constructor: `constructor(private readonly db: Db, private readonly repos: PromptDataRepos)`
       New constructor: `constructor(private readonly retrieval: RetrievalService, private readonly repos: PromptDataRepos)`
    2. Update `getTypedRetrievalSurface(userMessage, viewerContext)` to pass `this.retrieval` instead of `this.db` to `getTypedRetrievalSurfaceAsync()`
       Current: `getTypedRetrievalSurfaceAsync(userMessage, viewerContext, this.db, this.repos)`
       New: Pass RetrievalService directly (after Task 9 refactors prompt-data.ts to accept it)
    3. Verify all 5 ACTUAL `MemoryDataSource` interface methods work (see `src/core/prompt-data-sources.ts:15-21`):
       - `getPinnedBlocks(agentId)` → delegates to `getPinnedBlocksAsync(agentId, this.repos)` (already works, no Db needed)
       - `getSharedBlocks(agentId)` → delegates to `getSharedBlocksAsync(agentId, this.repos)` (already works)
       - `getRecentCognition(viewerContext)` → delegates to `getRecentCognitionAsync(agentId, sessionId, this.repos)` (already works)
       - `getAttachedSharedBlocks(agentId)` → delegates to `getAttachedSharedBlocksAsync(agentId, this.repos)` (already works)
       - `getTypedRetrievalSurface(userMessage, viewerContext)` → THIS is the method that needs the Db→RetrievalService change
       **CRITICAL**: The method signature is `(userMessage: string, viewerContext: ViewerContext)` — two params, NOT one.
  - REFACTOR: Ensure the class is clean and ready to be imported in runtime.ts (Task 11)

  **Must NOT do**:
  - Do NOT add new methods to MemoryAdapter beyond what MemoryDataSource requires
  - Do NOT change the MemoryDataSource interface itself

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small class (~35 lines), single constructor change, method delegation update
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (with Task 11)
  - **Blocks**: Task 11 (Wire runtime.ts)
  - **Blocked By**: Tasks 8 (RetrievalService), 9 (prompt-data.ts)

  **References** (CRITICAL):

  **Pattern References**:
  - `src/core/prompt-data-adapters/memory-adapter.ts:12-34` — Current MemoryAdapter: the class being revived

  **API/Type References**:
  - `src/core/prompt-data-sources.ts` — `MemoryDataSource` type: the interface MemoryAdapter must implement
  - `src/memory/prompt-data.ts` — `getTypedRetrievalSurfaceAsync()`: now accepts RetrievalService (from Task 9)

  **Test References**:
  - `test/core/prompt-builder.test.ts` — PromptBuilder tests: will exercise MemoryAdapter through the prompt pipeline

  **WHY Each Reference Matters**:
  - memory-adapter.ts: The exact file being refactored — need to understand all 5 interface methods
  - prompt-data-sources.ts: The contract that MemoryAdapter implements — must not change

  **Acceptance Criteria**:

  **TDD:**
  - [ ] Test file created: `test/core/memory-adapter-pg.test.ts`
  - [ ] `bun test test/core/memory-adapter-pg.test.ts` → PASS

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: MemoryAdapter implements MemoryDataSource with PG-backed RetrievalService
    Tool: Bash (bun test)
    Preconditions: RetrievalService PG-native (Task 8), prompt-data.ts refactored (Task 9)
    Steps:
      1. Run `bun test test/core/memory-adapter-pg.test.ts`
      2. Verify getTypedRetrievalSurface(userMessage, viewerContext) returns non-empty content when PG has memory data
      3. Verify all 5 ACTUAL MemoryDataSource methods callable: getPinnedBlocks, getSharedBlocks, getRecentCognition, getAttachedSharedBlocks, getTypedRetrievalSurface
    Expected Result: All tests pass, MemoryAdapter fully functional
    Failure Indicators: "db is not defined", empty TYPED_RETRIEVAL when data exists, wrong method signatures
    Evidence: .sisyphus/evidence/task-10-memory-adapter.txt

  Scenario: No Db import remains in memory-adapter.ts
    Tool: Bash (grep)
    Preconditions: Refactor complete
    Steps:
      1. Run `grep -n "import.*Db\b\|db: Db\|from.*db-types" src/core/prompt-data-adapters/memory-adapter.ts`
      2. Verify zero matches
    Expected Result: No SQLite references remain
    Failure Indicators: Any grep match
    Evidence: .sisyphus/evidence/task-10-no-sqlite-refs.txt
  ```

  **Evidence to Capture:**
  - [ ] task-10-memory-adapter.txt
  - [ ] task-10-no-sqlite-refs.txt

  **Commit**: YES (groups with T11)
  - Message: `feat(runtime): wire real RetrievalService, MemoryAdapter, GraphNavigator — remove stubs`
  - Files: `src/core/prompt-data-adapters/memory-adapter.ts`, `test/core/memory-adapter-pg.test.ts`
  - Pre-commit: `bun test test/core/memory-adapter-pg.test.ts`

- [ ] 11. Wire runtime.ts — Instantiate real services, remove stubs, bring GraphNavigator alive

  **What to do**:
  - This is the capstone wiring task. Modify `src/bootstrap/runtime.ts` to:
    1. **Remove inline anonymous memoryAdapter stub** (lines 754-797):
       - Delete the anonymous object that returns `""` for `getTypedRetrievalSurface`
       - Import and instantiate real `MemoryAdapter` class: `new MemoryAdapter(retrievalService, promptDataRepos)` where `promptDataRepos` is a `PromptDataRepos` object with `{ coreMemoryBlockRepo, recentCognitionSlotRepo, interactionRepo, sharedBlockRepo }` (some of these repos may already be available in runtime.ts)
    2. **Remove lazyRetrieval throw-proxy** (lines 978-990):
       - Delete `createLazyPgRepo<RetrievalService>(() => { throw new Error(...) })`
       - Instantiate real `RetrievalService` with PG repos:
         ```
         const retrievalService = new RetrievalService(
           pgRetrievalReadRepo,      // new (from Task 1)
           embeddingService,          // already wired via PgEmbeddingRepo
           narrativeSearchService,    // MUST INSTANTIATE — NarrativeSearchService(pgNarrativeSearchRepo), neither repo nor service exist in runtime.ts yet
           cognitionSearchService,    // from Task 6 (refactored to PG)
           retrievalOrchestrator,     // optional, pure logic
           visibilityPolicy,          // from config
           episodeRepo                // already instantiated at runtime.ts:916
         )
         ```
         NOTE: Verify the actual constructor signature in `src/memory/retrieval.ts` before writing — the refactored constructor from Task 8 may differ from the example above.
    3. **Instantiate GraphNavigator** (currently dead code, never instantiated):
       **CRITICAL**: Constructor parameter order is `(readRepo, retrieval, alias, modelProvider?, narrativeSearch?, cognitionSearch?, ...)`. Do NOT swap readRepo and retrieval.
       ```
       const graphNavigator = new GraphNavigator(
         pgGraphReadQueryRepo,     // param 1: readRepo (GraphReadQueryRepo)
         retrievalService,         // param 2: retrieval (RetrievalService)
         aliasService,             // param 3: alias (AliasService, from Task 7)
         undefined,                // param 4: modelProvider (optional, not needed now)
         narrativeSearchService,   // param 5: narrativeSearch (now available)
         cognitionSearchService,   // param 6: cognitionSearch (now available, from Task 6)
       )
       ```
       Verify against `src/memory/navigator.ts:174-184` before writing.
    4. **Update registerMemoryTools call** (lines 991-1020):
       - Change from `{ coreMemory: coreMemoryService, retrieval: lazyRetrieval }`
       - To include all services: `{ coreMemory: coreMemoryService, retrieval: retrievalService, navigator: graphNavigator, narrativeSearch: narrativeSearchService, cognitionSearch: cognitionSearchService }`
    5. **Wire MemoryAdapter into PromptBuilder**:
       - Replace inline memoryAdapter with real `MemoryAdapter` instance
       - Ensure PromptBuilder receives it via its `MemoryDataSource` parameter
    6. **Instantiate ALL PG repos needed** — check runtime.ts:916-975 for what exists vs what's missing:
       **Already instantiated in runtime.ts** (verified):
       - `PgEpisodeRepo` ✅ (line 916-918)
       - `PgCognitionEventRepo` ✅ (line 919-921)
       - `PgCognitionProjectionRepo` ✅ (line 922-924)
       - `PgSearchProjectionRepo` ✅ (line 931-933)
       - `PgEmbeddingRepo` ✅ (line 934-936)
       **NOT yet instantiated — MUST ADD these:**
       - `PgGraphReadQueryRepo(sql)` — ❌ NOT in runtime.ts. Must add `createLazyPgRepo(() => new PgGraphReadQueryRepo(resolvePgPool()))`
       - `PgNarrativeSearchRepo(sql)` — ❌ NOT in runtime.ts. Must add `createLazyPgRepo(() => new PgNarrativeSearchRepo(resolvePgPool()))`
       - `NarrativeSearchService(pgNarrativeSearchRepo)` — ❌ NOT in runtime.ts. Must instantiate after creating the repo
       - `PgRetrievalReadRepo(sql)` — new (from Task 1)
       - `PgCognitionSearchRepo(sql)` — new (from Task 2)
       - `PgRelationReadRepo(sql)` — new (from Task 3)
       - `PgAliasRepo(sql)` — new (from Task 4)
       **Import all new repos at the top of runtime.ts** and add them to the instantiation block alongside existing repos (lines 916-975)

  **Must NOT do**:
  - Do NOT change the PromptBuilder or PromptRenderer logic (just wire correct data sources)
  - Do NOT add new memory tools beyond the existing 6
  - Do NOT modify agent role routing (maiden/rp_agent/task_agent)
  - Do NOT touch settlement/organizer pipeline

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Critical wiring task touching runtime bootstrap — high impact, must be precise. Multiple service instantiations and dependency injections.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (sequential after T10)
  - **Blocks**: Task 12 (Integration tests)
  - **Blocked By**: Tasks 7 (AliasService), 8 (RetrievalService), 9 (prompt-data.ts), 10 (MemoryAdapter)

  **References** (CRITICAL):

  **Pattern References**:
  - `src/bootstrap/runtime.ts:754-797` — Inline memoryAdapter stub: **DELETE THIS** and replace with real MemoryAdapter
  - `src/bootstrap/runtime.ts:978-1020` — lazyRetrieval proxy + registerMemoryTools: **DELETE PROXY** and wire real services
  - `src/bootstrap/runtime.ts:1-100` — Existing PG repo instantiations at top of file: follow this pattern for new repos

  **API/Type References**:
  - `src/memory/retrieval.ts` — RetrievalService constructor (refactored in Task 8): know what params to pass
  - `src/memory/navigator.ts` — GraphNavigator constructor: know what params to pass
  - `src/memory/tools.ts` — `registerMemoryTools()` function signature: know what services object shape to pass
  - `src/core/prompt-data-adapters/memory-adapter.ts` — MemoryAdapter constructor (refactored in Task 10)
  - `src/core/prompt-builder.ts` — PromptBuilder: where MemoryDataSource is consumed

  **Test References**:
  - `test/bootstrap/memory-tool-registration.test.ts` — **WARNING: This test only verifies 6 tool SCHEMAS are registered (name exists in getSchemas()). It does NOT verify the tools work, nor that stubs are removed. It will pass even with the throw-proxy still present. Do NOT use as sole acceptance criteria.**
  - `test/bootstrap/pipeline-wiring.test.ts` — **WARNING: This test only verifies pipeline GATING (memoryPipelineReady boolean, memoryTaskAgent null/non-null). It does NOT test service instantiation or wiring. It will pass even if no services are wired. Do NOT use as sole acceptance criteria.**

  **WHY Each Reference Matters**:
  - runtime.ts:754-797: The stub being deleted — must understand what it currently provides to ensure replacement covers everything
  - runtime.ts:978-1020: The proxy being deleted — must understand what `registerMemoryTools` expects
  - navigator.ts:174-184: GraphNavigator constructor — parameter order is `(readRepo, retrieval, alias, modelProvider?, narrativeSearch?, cognitionSearch?, ...)`. Must match exactly.
  - The existing bootstrap tests (memory-tool-registration, pipeline-wiring) are too weak to validate this task. The QA scenarios below (grep + bun test) are the REAL acceptance criteria.

  **Acceptance Criteria**:

  **TDD:**
  - [ ] `bun test test/bootstrap/memory-tool-registration.test.ts` → PASS (baseline, NOT sufficient alone)
  - [ ] `bun test test/bootstrap/pipeline-wiring.test.ts` → PASS (baseline, NOT sufficient alone)
  - [ ] `bun test` (full suite) → PASS
  - [ ] **NEW test** or extension to existing: verify that `lazyRetrieval` throw-proxy no longer exists, that `RetrievalService` instance is real, and that `GraphNavigator` is instantiated. This test must FAIL if stubs are still present.

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: No throw-proxy or empty-string stubs remain in runtime.ts
    Tool: Bash (grep)
    Preconditions: Wiring complete
    Steps:
      1. Run `grep -n "lazyRetrieval\|createLazyPgRepo.*RetrievalService\|getTypedRetrievalSurface.*return.*\"\"" src/bootstrap/runtime.ts`
      2. Verify zero matches for throw-proxy patterns
      3. Verify zero matches for empty-string stub patterns
    Expected Result: All stubs removed
    Failure Indicators: Any grep match
    Evidence: .sisyphus/evidence/task-11-no-stubs.txt

  Scenario: GraphNavigator is instantiated and reachable
    Tool: Bash (grep)
    Preconditions: Wiring complete
    Steps:
      1. Run `grep -n "new GraphNavigator" src/bootstrap/runtime.ts`
      2. Verify GraphNavigator instantiation exists with correct param order (readRepo, retrieval, alias, ...)
      3. Run `grep -n "navigator:" src/bootstrap/runtime.ts` to verify it's passed to registerMemoryTools
      4. Verify the navigator property is non-null in the services object
    Expected Result: GraphNavigator instantiated and wired to memory_explore
    Failure Indicators: No instantiation found, tool registration test fails
    Evidence: .sisyphus/evidence/task-11-navigator-wired.txt

  Scenario: MemoryAdapter is imported and used (not inline stub)
    Tool: Bash (grep)
    Preconditions: Wiring complete
    Steps:
      1. Run `grep -n "import.*MemoryAdapter\|new MemoryAdapter" src/bootstrap/runtime.ts`
      2. Verify MemoryAdapter is imported and instantiated
      3. Verify no anonymous object with getTypedRetrievalSurface remains
    Expected Result: Real MemoryAdapter class used
    Failure Indicators: Still using anonymous object, no MemoryAdapter import
    Evidence: .sisyphus/evidence/task-11-memory-adapter-wired.txt

  Scenario: Runtime bootstrap passes full test suite
    Tool: Bash (bun test)
    Preconditions: All services wired
    Steps:
      1. Run `bun test`
      2. Verify all existing tests still pass (no regressions)
      3. Verify no "cannot read property of null" from missing service wiring
    Expected Result: Full test suite green
    Failure Indicators: Any regression, null reference from missing wiring
    Evidence: .sisyphus/evidence/task-11-full-suite.txt
  ```

  **Evidence to Capture:**
  - [ ] task-11-no-stubs.txt
  - [ ] task-11-navigator-wired.txt
  - [ ] task-11-memory-adapter-wired.txt
  - [ ] task-11-full-suite.txt

  **Commit**: YES (groups with T10)
  - Message: `feat(runtime): wire real RetrievalService, MemoryAdapter, GraphNavigator — remove stubs`
  - Files: `src/bootstrap/runtime.ts`
  - Pre-commit: `bun test`

- [ ] 12. Full Chain Integration Tests — Verify TYPED_RETRIEVAL, 6 tools, and GraphNavigator

  **What to do**:
  - Write comprehensive integration tests that verify the FULL chain works end-to-end:
    1. **TYPED_RETRIEVAL slot test**: Seed PG with memory data → build prompt → verify slot 5 contains non-empty retrieval content
    2. **memory_read tool test**: Call `memory_read` with entity/topic/event/fact params → verify correct data returned from PG
    3. **narrative_search tool test**: Call `narrative_search` with query → verify search results from PG
    4. **cognition_search tool test**: Call `cognition_search` with query → verify cognition results from PG
    5. **memory_explore tool test**: Call `memory_explore` → verify GraphNavigator executes query, returns exploration results
    6. **core_memory_append/replace regression**: Verify these 2 working tools still work (no regressions)
    7. **Cross-tool integration**: memory_read → then narrative_search on same entity → verify consistent results
  - Use existing PG test patterns from `test/pg-app/` for database seeding and connection
  - Each test must seed its own data and clean up (no shared state between tests)

  **Must NOT do**:
  - Do NOT test write paths (organizer, settlement)
  - Do NOT test agent loop or turn service (too broad — just test memory chain)
  - Do NOT modify any production code in this task — tests only

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex integration tests covering full chain, multiple seeding patterns, cross-component verification
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (final implementation task)
  - **Blocks**: F1-F4 (Final verification wave)
  - **Blocked By**: Task 11 (Wire runtime.ts — everything must be wired first)

  **References** (CRITICAL):

  **Pattern References**:
  - `test/pg-app/pg-narrative-search-repo.test.ts` — PG integration test with data seeding (best pattern for this task — shows how to seed PG data and assert search results)
  - `test/runtime/rp-turn-contract.test.ts` — Turn-level test pattern (shows full request lifecycle)
  - ~~`test/pg-app/backend-aware-boot.test.ts`~~ — **DO NOT USE**: This test only checks `resolveBackendType()` defaults and `PgBackendFactory` init errors (line 24-40). It does NOT boot the runtime, does NOT instantiate retrieval/navigator/prompt-builder, and has zero memory-chain coverage. Not a valid pattern for integration tests.

  **API/Type References**:
  - `src/memory/tools.ts` — Tool handler signatures: the entry points to test
  - `src/core/prompt-builder.ts:193-249` — Role-specific prompt building: verify TYPED_RETRIEVAL slot
  - `src/core/prompt-template.ts` — `SECTION_SLOT_ORDER`: verify slot 5 position
  - `src/memory/tool-names.ts` — Tool name constants

  **WHY Each Reference Matters**:
  - pg-narrative-search-repo.test.ts: Best existing example of PG test with seed data + search verification
  - tools.ts: The exact functions being tested — need to know parameter shapes and return types
  - prompt-builder.ts: Need to verify the TYPED_RETRIEVAL slot is populated in the built prompt

  **Acceptance Criteria**:

  **TDD:**
  - [ ] Test file created: `test/memory/pg-memory-chain-integration.test.ts`
  - [ ] `bun test test/memory/pg-memory-chain-integration.test.ts` → PASS (all 7 test groups pass)

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: TYPED_RETRIEVAL slot produces content via full pipeline
    Tool: Bash (bun test)
    Preconditions: PG seeded with entity_nodes, fact_edges, event_nodes, private_episode_events, topics, search_docs (for narrative search), AND recent_cognition_slot + interaction records (for dedup context per prompt-data.ts:304-329)
    Steps:
      1. Run `bun test test/memory/pg-memory-chain-integration.test.ts --filter "TYPED_RETRIEVAL"`
      2. Verify getTypedRetrievalSurfaceAsync() is called with (userMessage, viewerContext, retrievalService, repos) — not with db: Db
      3. Verify it calls retrievalService.generateTypedRetrieval() with dedupContext containing recentCognitionKeys, recentCognitionTexts, conversationTexts
      4. Verify prompt build produces non-empty content in slot 5
      5. Verify content includes entity names, event summaries, or fact descriptions from seeded data
    Expected Result: Slot 5 has substantive content (not "" or undefined), generated via real PG retrieval pipeline
    Failure Indicators: Empty string, undefined, "RetrievalService is not yet available" error, or db.prepare errors
    Evidence: .sisyphus/evidence/task-12-typed-retrieval.txt

  Scenario: All 6 memory tools return valid responses (ACTUAL return shapes)
    Tool: Bash (bun test)
    Preconditions: Runtime wired (Task 11), PG seeded with test data
    Steps:
      1. Run `bun test test/memory/pg-memory-chain-integration.test.ts --filter "tool"`
      2. Verify memory_read: for entity query → returns EntityReadResult directly (NOT {success:true} wrapped); for topic → TopicReadResult; for event_ids → EventNode[]; for fact_ids → FactEdge[]. Only the error path returns {success:false, error:"..."} (see tools.ts:264-278)
      3. Verify narrative_search: returns { results: NarrativeSearchHit[] } (NOT {success:true} wrapped, see tools.ts:286-297)
      4. Verify cognition_search: returns `CognitionHit[]` directly (the `searchCognition()` return value, type defined at `cognition-search.ts:33`). Only guard failure returns `{success:false}` when `cognitionSearch` service is null (see tools.ts:420-432)
      5. Verify memory_explore: returns toExplainShell format: { query, query_type, summary, evidence_paths: [...] }. Only guard failure returns {success:false} (see tools.ts:496-530)
      6. Verify core_memory_append: returns {success: true} (these DO use the success wrapper)
      7. Verify core_memory_replace: returns {success: true}
    Expected Result: All 6 tools return their respective response shapes without thrown errors
    Failure Indicators: Thrown errors, "not implemented" messages, "not available" guard failures, undefined returns
    Evidence: .sisyphus/evidence/task-12-all-tools.txt

  Scenario: memory_read returns empty result for non-existent entity (graceful failure)
    Tool: Bash (bun test)
    Preconditions: PG with no matching entity
    Steps:
      1. Run `bun test test/memory/pg-memory-chain-integration.test.ts --filter "not found|empty|missing"`
      2. Verify memory_read returns graceful empty result (not crash)
      3. Verify narrative_search with no-match query returns empty results array
    Expected Result: Graceful empty responses, no crashes
    Failure Indicators: Unhandled errors, null reference exceptions
    Evidence: .sisyphus/evidence/task-12-graceful-empty.txt

  Scenario: Conversation-aware dedup filters overlapping content from TYPED_RETRIEVAL (persisted conversation)
    Tool: Bash (bun test)
    Preconditions: PG seeded with: (a) cognition entries with specific summaries, (b) recent_cognition_slot with overlapping keys/summaries, (c) interaction records with last 12 messages containing text that matches some cognition summaries
    Steps:
      1. Run `bun test test/memory/pg-memory-chain-integration.test.ts --filter "dedup|conversation"`
      2. Seed cognition entry with summary "Alice moved to the garden at dawn"
      3. Seed recent cognition slot with key matching that cognition entry
      4. Seed interaction messages containing "Alice moved to the garden at dawn" in recent 12 messages
      5. Call getTypedRetrievalSurfaceAsync with a query about Alice
      6. Verify the output does NOT contain the duplicate cognition entry that was already in recent cognition or conversation
      7. Verify the dedup context (recentCognitionKeys, recentCognitionTexts, conversationTexts) is correctly passed to generateTypedRetrieval (see prompt-data.ts:304-335)
    Expected Result: Overlapping content filtered out — TYPED_RETRIEVAL does not repeat what's already in recent cognition or persisted conversation history
    Failure Indicators: Duplicate content appears in slot 5 that also appears in recent cognition slot or persisted last 12 messages
    Known Limitation: This test verifies dedup against PERSISTED conversation (interactionRepo.getMessageRecords, prompt-data.ts:322). The current turn's in-flight user message (appended at turn-service.ts:130 but not yet persisted) is NOT included in the dedup's conversationTexts. This is a pre-existing architectural limitation in getTypedRetrievalSurfaceAsync — it reads from PG, not from the in-memory message array. Fixing this would require turn-service-level changes which are explicitly out of scope for this plan.
    Evidence: .sisyphus/evidence/task-12-dedup-conversation.txt
  ```

  **Evidence to Capture:**
  - [ ] task-12-typed-retrieval.txt
  - [ ] task-12-all-tools.txt
  - [ ] task-12-graceful-empty.txt
  - [ ] task-12-dedup-conversation.txt

  **Commit**: YES (standalone)
  - Message: `test(memory): add full chain integration tests for PG memory retrieval`
  - Files: `test/memory/pg-memory-chain-integration.test.ts`
  - Pre-commit: `bun test test/memory/pg-memory-chain-integration.test.ts`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run `bun test`, grep for removed patterns). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, `console.log` in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp). Verify no `db.prepare()` calls remain in modified files.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (TYPED_RETRIEVAL slot → RetrievalService → PG repos → real data). Test edge cases: empty DB, missing entities, invalid tool inputs. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance — especially: no CognitionRepository write path touched, no RelationBuilder writes, no settlement pipeline changes. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| After Tasks | Commit Message | Pre-commit Test |
|-------------|---------------|-----------------|
| T1-T4 | `feat(storage): add PG repos for retrieval read, cognition search, relation read, alias` | `bun test test/pg-app/` |
| T5 | `refactor(memory): define async interface contracts for retrieval service migration` | `bun test` |
| T6-T7 | `refactor(memory): migrate CognitionSearchService and AliasService to PG repos` | `bun test test/memory/` |
| T8-T9 | `refactor(memory): make RetrievalService PG-native and refactor prompt-data.ts` | `bun test` |
| T10-T11 | `feat(runtime): wire real RetrievalService, MemoryAdapter, GraphNavigator — remove stubs` | `bun test` |
| T12 | `test(memory): add full chain integration tests for PG memory retrieval` | `bun test` |

---

## Success Criteria

### Verification Commands
```bash
bun test                                    # Expected: ALL tests pass, 0 failures
bun test test/pg-app/                       # Expected: All PG repo tests pass
bun test test/memory/                       # Expected: All memory tests pass
bun test test/bootstrap/memory-tool-registration.test.ts  # Expected: pass
```

### Final Checklist
- [ ] All "Must Have" present (15 db.prepare replaced, CognitionSearch PG-native, etc.)
- [ ] All "Must NOT Have" absent (no CognitionRepo writes, no RelationBuilder writes, etc.)
- [ ] All tests pass (`bun test` green)
- [ ] TYPED_RETRIEVAL slot returns non-empty content
- [ ] All 6 memory tools callable without error
- [ ] GraphNavigator reachable via `memory_explore`
- [ ] No `Db` / `DbLike` imports remain in modified files
- [ ] No throw-proxy or empty-string stubs in runtime.ts
