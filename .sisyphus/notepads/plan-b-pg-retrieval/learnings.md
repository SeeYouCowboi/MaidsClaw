## [2026-04-03] Task 3: PgRelationReadRepo

- Implemented `RelationReadRepo` contract and `PgRelationReadRepo` PG implementation with 4 read-only query methods:
  1. `getConflictEvidence(sourceNodeRef, limit)` - Queries `memory_relations` for contested evidence, returns strongest-first
  2. `getConflictHistory(nodeRef, limit)` - Queries conflict/resolution chain with types `conflicts_with`, `resolved_by`, `downgraded_by`
  3. `resolveSourceAgentId(sourceNodeRef)` - Resolves agent_id from assertions, evaluations, commitments, and private_episodes
  4. `resolveCanonicalCognitionRefByKey(cognitionKey, sourceAgentId)` - Resolves canonical node refs by cognition key

- Pattern notes:
  - Following TDD: Tests written first, then implementation
  - Constructor takes `postgres.Sql` (consistent with embedding-repo pattern)
  - All methods async with proper Promise return types
  - Uses parameterized sql template literals
  - Returns empty arrays (not null/throw) when no data exists
  - Cognition key resolution uses `COGNITION_KEY_PREFIX` ("cognition_key:") from RelationBuilder

- Test structure: 19 tests covering all methods with proper PG schema bootstrap
  - Tests skipped when PG_TEST_URL not available
  - Schema bootstraps only required tables (memory_relations, private_cognition_current, private_episode_events)

## [2026-04-03] Task 5: Sync→Async Cascade + RetrievalServiceLike Contract

- Built cascade map for sync→async cutover targets and wrote:
  - `.sisyphus/drafts/sync-async-cascade.md`
  - `.sisyphus/evidence/task-5-cascade-analysis.md`

- High-risk cascades confirmed:
  - `retrieval-orchestrator.ts:99` must await `CurrentProjectionReader.getActiveCurrent(...)`
  - `retrieval-orchestrator.ts:130` must await `CognitionSearchService.searchCognition(...)`
  - `retrieval-orchestrator.ts:386` must await `EpisodeRepository.readByAgent(...)` (forces async `resolveEpisodeHints()`)
  - `navigator.ts:316` sync `resolveAlias(...)` inside `analyzeQuery()` forces `analyzeQuery()` async and cascades to `explore()`

- Tool-level cascade captured:
  - `memory_read` handler in `tools.ts` currently sync-returns `readByEntity/readByTopic/readByEventIds/readByFactIds`; all require async handler + await in Task 8.
  - `cognition_search` handler in `tools.ts` currently sync-returns `searchCognition`; must become async handler + await.

- Added async target contract:
  - `src/memory/contracts/retrieval-service-contract.ts`
  - `RetrievalServiceLike` Promise-first signatures include required methods:
    `readByEntity`, `readByTopic`, `readByEventIds`, `readByFactIds`,
    `resolveEntityByPointer`, `resolveRedirect`, `searchVisibleNarrative`,
    `generateTypedRetrieval`, `localizeSeedsHybrid` (plus `generateMemoryHints` for parity).

- Visibility SQL compatibility re-check:
  - `src/memory/contracts/visibility-policy.ts` is re-export only.
  - Real `eventVisibilityPredicate()` in `src/memory/visibility-policy.ts` uses only `visibility_scope` + `location_entity_id` conditions.
  - No `json_extract`, `typeof`, `ifnull`, `group_concat` usage in predicate path; PG compatibility = YES.
