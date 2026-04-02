

## [2026-04-03] Task 7: Refactor AliasService — Replace DbLike with PgAliasRepo

- Refactored `src/memory/alias.ts` to use `AliasRepo` contract interface instead of `DbLike`:
  - Constructor changed from `db: DbLike` to `repo: AliasRepo`
  - Removed all `this.db.prepare(...)` calls, now delegates to repo methods
  - All 5 public methods are now async:
    1. `resolveAlias(alias, ownerAgentId?)` → `Promise<number | null>`
    2. `resolveAliases(aliases, ownerAgentId?)` → `Promise<Map<string, number | null>>`
    3. `createAlias(canonicalId, alias, aliasType?, ownerAgentId?)` → `Promise<number>`
    4. `getAliasesForEntity(canonicalId, ownerAgentId?)` → `Promise<EntityAlias[]>`
    5. `resolveParticipants(participantsJson)` → `Promise<Array<{ref, entityId|null}>>`

- Implementation notes:
  - `resolveAlias` and `resolveAliases` now delegate directly to repo (pass-through)
  - `resolveParticipants` keeps same JSON parsing logic but awaits async repo calls
  - Internal cascade: `resolveAliases` awaits `resolveAlias`, `resolveParticipants` awaits `resolveAlias`
  - `resolveParticipants` uses `findEntityById` for numeric IDs and `resolveAlias` for string refs

- Pattern followed (from narrative-search.ts):
  - Service takes repo interface in constructor, NOT database connection
  - All methods async with Promise return types
  - Clean separation: service contains business logic, repo handles persistence

- Test approach:
  - Created `test/memory/alias-service-pg.test.ts` with StubAliasRepo implementing AliasRepo
  - 26 tests covering all 5 public methods
  - Tests verify both pass-through delegation and `resolveParticipants` logic
  - Used in-memory stub to avoid PG dependency for unit tests

- Verification:
  - `grep -n "DbLike\|db.prepare\|from.*db-types" src/memory/alias.ts` → zero matches
  - `bun test test/memory/alias-service-pg.test.ts` → 26 pass, 0 fail

- LSP errors in navigator.ts are expected (T8 will fix callers)


## [2026-04-03] Task 8: Refactor RetrievalService + navigator.ts + tools.ts

- Refactored `src/memory/retrieval.ts` to be PG-repo-driven:
  - Removed all SQLite `Db` dependencies and `db.prepare()` read paths.
  - Constructor now accepts only deps with `retrievalRepo: RetrievalReadRepo`.
  - Removed SQLite union constructor path and static `create(db)` factory.
  - `readByEntity`, `readByTopic`, `readByEventIds`, `readByFactIds` are now async and delegate to `retrievalRepo`.
  - `resolveRedirect` and `resolveEntityByPointer` are now async pass-throughs to `retrievalRepo`.
  - `localizeSeedsHybrid()` now uses `await retrievalRepo.countNodeEmbeddings()`.
  - Orchestrator auto-construction via `EpisodeRepository(db)` removed; `orchestrator` is now required (throws if missing).

- Async cascade updated in `src/memory/navigator.ts`:
  - `analyzeQuery()` changed to async returning `Promise<QueryAnalysis>`.
  - Alias resolution now awaits `this.alias.resolveAlias(...)`.
  - `explore()` now awaits `this.analyzeQuery(...)`.

- Async cascade updated in `src/memory/tools.ts`:
  - `makeMemoryRead` handler is now async and awaits all retrieval read calls.
  - `makeCognitionSearch` handler is now async and awaits `searchCognition()`.
  - `MemoryToolServices.cognitionSearch.searchCognition()` return type updated to `Promise<unknown>`.

- Build fallout fixed due to `RetrievalService.create(db)` removal:
  - `src/memory/prompt-data.ts` no longer creates/caches retrieval service by `Db`; now requires injected `retrievalService` (throws if missing).
  - `src/core/prompt-data-adapters/memory-adapter.ts` now accepts optional injected `RetrievalService` and passes it into `getTypedRetrievalSurfaceAsync(...)`.

- Verification:
  - `bun run build` passes (`.sisyphus/evidence/task-8-build.txt`).
  - `bun test` executed; fails from pre-existing environment/runtime issues (missing chat provider config and local PG auth), not from this refactor (`.sisyphus/evidence/task-8-tests.txt`).
  - No `as any` or `@ts-ignore` introduced in modified target files.
  - No new `db: Db` or `db.prepare()` usage in `retrieval.ts`, `navigator.ts`, or `tools.ts`.

## [2026-04-03] Task 10: MemoryAdapter cleanup

### Changes Made
1. Removed `import type { Db }` from `src/core/prompt-data-adapters/memory-adapter.ts`
2. Removed `_db: Db,` parameter from MemoryAdapter constructor
3. Constructor signature is now: `constructor(private readonly repos: PromptDataRepos, private readonly retrievalService?: RetrievalService)`
4. All 5 MemoryDataSource methods remain intact and functional

### Test Coverage
- Created `test/core/memory-adapter-pg.test.ts` with 7 unit tests
- Tests verify:
  - MemoryAdapter can be instantiated with repos only (retrievalService optional)
  - MemoryAdapter can be instantiated with both repos and retrievalService
  - All 5 interface methods exist and are callable:
    - getPinnedBlocks
    - getSharedBlocks
    - getRecentCognition
    - getAttachedSharedBlocks
    - getTypedRetrievalSurface

### Verification
- `bun run build` exits 0
- `bun test test/core/memory-adapter-pg.test.ts` passes (7/7)
- No SQLite references remain in memory-adapter.ts

### Notes
- No callers of `new MemoryAdapter(...)` exist in the codebase, so the constructor signature change is safe
- The inline stub in runtime.ts uses an anonymous object, not the MemoryAdapter class
- retrievalService remains optional for now; Task 11 will make it required

## [2026-04-03] Task 11: Wire runtime.ts

- Replaced PG bootstrap memory retrieval stubs with fully wired real services in `src/bootstrap/runtime.ts`:
  - Removed anonymous `memoryAdapter` object (including `getTypedRetrievalSurface` empty-string stub).
  - Removed `lazyRetrieval` throw-proxy block and its deferred registration path.
- Added typed `promptDataRepos: PromptDataRepos` near prompt adapter setup, then instantiated real `MemoryAdapter(promptDataRepos, retrievalService)` after retrieval service wiring.
- Resolved ordering constraints by moving `PromptBuilder` construction to after retrieval service initialization, so `memory` now receives the real `MemoryAdapter` instance.
- Added six lazy PG retrieval-chain repos after `embeddingRepo`:
  - `pgRetrievalReadRepo`, `pgCognitionSearchRepo`, `pgRelationReadRepo`, `pgAliasRepo`, `pgGraphReadQueryRepo`, `pgNarrativeSearchRepo`.
- Added and wired real services in dependency order:
  - `AliasService` → `NarrativeSearchService` → `CognitionSearchService` (+ `createCurrentProjectionReader()`) → `RetrievalOrchestrator` → `RetrievalService` → `GraphNavigator` → `MemoryAdapter`.
- Updated memory tool registration to pass full real service bag:
  - `coreMemory`, `retrieval`, `navigator`, `narrativeSearch`, `cognitionSearch`.
  - Kept existing `toolExecutor.registerLocal` wrapper pattern and viewerContext guard intact.
- Import surface updated for all new runtime wiring classes/repos; removed obsolete inline prompt-data helper imports and `MemoryDataSource` type-only dependency from runtime.
- Verification outcome:
  - `lsp_diagnostics` clean on changed TS file.
  - `bun run build` passes.
  - `bun test` fails only with pre-existing environment/config issues (missing configured model/provider and local PG auth), with no new wiring compile regressions.
