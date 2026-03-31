# Phase 3 SQLite Retirement — Learnings

## Project Conventions
- Runtime: Bun + TypeScript (strict)
- Test framework: `bun test`
- Build check: `bun run build` (tsc --noEmit)
- PG container: `docker-compose.pg.yml` → `app-pg` on port 55433
- PG credentials: `postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app`
- **TWO env vars needed** for PG tests: `PG_TEST_URL` AND `PG_APP_TEST_URL` (both must be set)
- SQLite test helper: `test/helpers/memory-test-utils.ts` → `createTempDb()`, `seedStandardEntities()`
- PG test helper: `test/helpers/pg-app-test-utils.ts` → `createTestPgAppPool()`, `withTestAppSchema()`
- PG test guard: `describe.skipIf(skipPgTests)` from `test/helpers/pg-test-utils.ts`
- `skipPgTests` reads `PG_TEST_URL` (not PG_APP_TEST_URL)
- Evidence files go in `.sisyphus/evidence/task-{N}-{slug}.txt`

## Architecture
- `createAppHost()` at `src/app/host/create-app-host.ts` — unified factory (431 lines)
- 16 PG domain repos already exist in `src/storage/domain-repos/pg/`
- PG schema bootstrap: truth/ops/derived 3 layers via `PgBackendFactory.initialize()`
- `resolveBackendType()` at `src/storage/backend-types.ts:40-44` — currently defaults to "sqlite"
- `AppMaintenanceFacade.drain()` exists at `src/app/host/maintenance-facade.ts`
- 4 scripts already migrated: memory-maintenance, memory-replay, search-rebuild, memory-rebuild-derived

## Key File References
- Bootstrap: `src/bootstrap/runtime.ts` (570 lines) — core branching target
- Types: `src/bootstrap/types.ts` — RuntimeBootstrapResult with db/rawDb fields
- Navigator: `src/memory/navigator.ts` (1477 lines) — 20+ SQLite prepare queries
- Storage: `src/memory/storage.ts` (1448 lines)
- Backend types: `src/storage/backend-types.ts`

## Postgres Library (porsager v3.4.8) Quirks
- **Extended query protocol hangs on RAISE EXCEPTION**: `sql.unsafe()` promise never resolves when a PG trigger fires `RAISE EXCEPTION`. Workaround: prepend `SELECT 1;` to force simple query protocol (multi-statement mode).
- **Bun's `expect().rejects.toThrow()` hangs with postgres promises**: Even with simple protocol, Bun's assertion helper hangs. Workaround: use manual try-catch instead.
- **`pg_trigger` is a global catalog**: Checking trigger existence via `pg_trigger` without schema filtering will find triggers in ALL schemas. Must JOIN `pg_class` + `pg_namespace` and filter by `current_schema()`.

## Test Infrastructure Helpers
- `simpleProtocol(sql, statement)` — forces simple query protocol to avoid extended protocol hang
- `expectTriggerReject(sql, statement, pattern)` — asserts trigger rejection using try-catch (not rejects.toThrow)
- Both in `test/helpers/pg-app-test-utils.ts`

## PG Test Environment
- Two Docker containers needed: `maidsclaw-app-pg` (port 55433, pgvector) and `maidsclaw-jobs-pg` (port 55432, postgres:16)
- Test databases: `maidsclaw_app_test` and `maidsclaw_jobs_test`
- Orphan test schemas (`test_*`) can accumulate from failed test runs — clean up before full runs

## Task 5 — Read-side query contracts added (Wave 1)

### `GraphReadQueryRepo` (`src/storage/domain-repos/contracts/graph-read-query-repo.ts`)
- Scope: navigator + graph-edge-view read surfaces, including beam expansion dependencies.
- Method summary:
  - `getNodeSalience(nodeRefs)` — batch salience read for seed scoring.
  - `readLogicEdges(frontierEventRefs, viewerContext, timeSlice?)` — logic edges with visibility/time filters.
  - `readMemoryRelationEdges(frontierNodeRefs, viewerContext, timeSlice?)` — memory_relations traversal edges.
  - `readSemanticEdges(frontierNodeRefs, viewerContext, timeSlice?)` — heuristic semantic edge traversal.
  - `readStateFactEdges(frontierEventRefs, viewerContext, timeSlice?)` — event->fact state support edges.
  - `readEventParticipantContexts(frontierEventRefs, viewerContext)` — participant/actor contexts for event expansion.
  - `readActiveFactsForEntityFrontier(entityRefs)` — active fact graph rows for entity frontier.
  - `readVisibleEventsForEntityFrontier(entityRefs, viewerContext)` — entity->event participant expansion.
  - `readAgentAssertionsLinkedToEntities(agentId, entityRefs)` — entity-linked assertion frontier expansion.
  - `readAgentAssertionDetails(agentId, assertionRefs, asOfCommittedTime?)` — time-sliced assertion details.
  - `resolveEntityRefByPointerKey(pointerKey, viewerAgentId)` — pointer-key to visible entity ref resolution.
  - `getNodeSnapshots(nodeRefs)` — summary/timestamp snapshots for rerank recency.
  - `getNodeVisibility(nodeRefs)` — visibility envelopes used by redaction safety net.
  - `getPrivateNodeOwners(nodeRefs)` — private cognition ownership checks.
  - `listRelationTypesForFrontier(frontierRefs)` — relation telemetry/introspection surface.

### `NodeScoringQueryRepo` (`src/storage/domain-repos/contracts/node-scoring-query-repo.ts`)
- Scope: graph-organizer read side (content rendering, score features, shadow registration support).
- Method summary:
  - `getNodeRenderingPayload(nodeRef)` — typed rendered content for embedding.
  - `getLatestNodeEmbedding(nodeRef)` — latest embedding lookup for pairwise checks.
  - `registerGraphNodeShadows(nodes, registeredAt?)` — idempotent graph_nodes shadow refresh.
  - `listSemanticNeighborWeights(nodeRef)` — one-hop semantic neighbors + weights.
  - `hasNodeScore(nodeRef)` — persistence signal for salience computation.
  - `getNodeRecencyTimestamp(nodeRef)` — normalized recency timestamp across node kinds.
  - `getEventLogicDegree(nodeRef)` — event logic-edge degree lookup.
  - `getNodeTopicCluster(nodeRef)` — topic-cluster lookup for bridge score.
  - `getSearchProjectionMaterial(nodeRef, fallbackAgentId)` — search projection sync/remove material.

### `PromotionQueryRepo` (`src/storage/domain-repos/contracts/promotion-query-repo.ts`)
- Scope: promotion + materialization read decisions (candidate identification and entity/public resolution).
- Method summary:
  - `findPromotionEventCandidates(criteria?)` — area-visible event candidates under spoken/stable filters.
  - `findStableFactCandidates(criteria?)` — repeated-summary fact crystallization candidates.
  - `getEntityRecord(entityRef)` — entity lookup for resolution decisions.
  - `findSharedEntityByPointerKey(pointerKey)` — shared-public pointer-key reuse lookup.
  - `getEventRecord(eventRef)` — source event payload for promoted write.
  - `findPublicEventBySourceRecordId(sourceRecordId)` — reconciliation lookup by source_record_id.
  - `resolvePublicEntityDecision({ sourceEntityRef, timestamp, isLocation })` — reuse/promote/block decision.
  - `resolveCandidateTimestamp(sourceRef)` — timestamp resolution for candidate refs.
  - `toPublicEventCategory(category)` — private->public event category mapping.

### `NarrativeSearchRepo` (`src/storage/domain-repos/contracts/narrative-search-repo.ts`)
- Scope: backend-agnostic narrative FTS abstraction for area/world surfaces.
- Method summary:
  - `searchNarrative(query, viewerContext)` — narrative search by semantic query object (`text`, optional `limit`, optional `minScore`, and area/world toggles), returning typed hits with `scope` + score.

### Contract design conventions captured
- Method names reflect business intent (candidate finding, traversal reads, resolution decisions), not SQL verbs.
- Interface signatures avoid `Database` / `bun:sqlite` types.
- Return values are typed DTOs per semantic use-case rather than raw row shapes.

## Wave 0 Task 2 (E2E Multi-Agent Migration)
- Added a dedicated multi-agent migration E2E case in `test/pg-app/e2e-migration.test.ts` that seeds 2 agents into SQLite, exports JSONL+manifest, imports into PG, and asserts truth-plane parity mismatches are zero across all truth surfaces.
- For parity assertions in this file, `verifyTruthPlane()` is stable for migration parity checks even when current projection rows are not rebuilt in the import path.
- `PgBackendFactory.initialize()` can bootstrap extensions in the database default search path; for schema-isolated tests, pass a schema-scoped PG URL (`options=-c search_path=<schema>,public`) to avoid cross-schema extension/index bootstrap conflicts.

## Task 7 — TransactionBatcher interface + PG no-op strategy
- Transaction batcher interface location: `src/memory/transaction-batcher.ts`
  - `ITransactionBatcher.runInTransaction<T>(fn: () => T): T`
- SQLite implementation remains `TransactionBatcher` (same file) and now explicitly `implements ITransactionBatcher`.
- PG no-op implementation location: `src/memory/pg-transaction-batcher.ts`
  - `PgTransactionBatcher.runInTransaction<T>(fn: () => T): T` executes `fn()` directly.
- EmbeddingService PG strategy documentation added in `src/memory/embeddings.ts`:
  - Constructor contract: PG path injects `PgTransactionBatcher` now, and T14 moves DB reads/writes to `EmbeddingRepo`.
  - `batchStoreEmbeddings(...)` → target repo method in T14: `EmbeddingRepo.upsert(...)`.
  - `queryNearestNeighbors(...)` → target repo methods in T14: `EmbeddingRepo.query(...)` / `EmbeddingRepo.cosineSearch(...)`.
  - `isNodeVisibleForAgent(...)` is currently sqlite-side visibility helper; in T14 this visibility logic should live in PG repository SQL.

## Task 6: New PG Test Factory API

### createPgTestDb() Factory

Location: `test/helpers/pg-app-test-utils.ts`

Purpose: One-stop factory for creating a fully-bootstrapped PostgreSQL test database with:
- Automatic schema creation and isolation
- Truth + ops + derived schema bootstrap
- Standard entity seeding (Alice, User, Test Room, Bob)
- Built-in cleanup

**API:**
```typescript
export async function createPgTestDb(
  options?: { embeddingDim?: number }
): Promise<{
  pool: postgres.Sql;
  schemaName: string;
  entities: { selfId, userId, locationId, bobId };
  cleanup: () => Promise<void>;
}>
```

**Usage:**
```typescript
describe.skipIf(skipPgTests)("My Test", () => {
  let testDb: Awaited<ReturnType<typeof createPgTestDb>>;
  
  beforeAll(async () => {
    testDb = await createPgTestDb();
  });
  
  afterAll(async () => {
    await testDb.cleanup();
  });
  
  it("works", async () => {
    const { pool, entities } = testDb;
    // entities.selfId, entities.userId, etc.
  });
});
```

**Migration from SQLite:**
- `createTempDb()` → `await createPgTestDb()`
- `db.query()` → `pool\`query\``
- `seedStandardEntities(db)` → `testDb.entities`
- `cleanupDb(db, dbPath)` → `await testDb.cleanup()`

### seedStandardPgEntities() Helper

Location: `test/helpers/pg-app-test-utils.ts`

Seeds the 4 standard test entities using PgGraphMutableStoreRepo:
- `__self__` (Alice) - person
- `__user__` (User) - person
- `test-room` (Test Room) - location
- `bob` (Bob) - person

Returns: `{ selfId, userId, locationId, bobId }`

## Task 4: RuntimeBootstrapResult Type Loosening

### Changes Made

**Files Modified:**
- `src/bootstrap/types.ts` - Made `db` and `rawDb` optional, removed `bun:sqlite` import
- `src/bootstrap/tools.ts` - Added existence checks for `services.db` and `services.rawDb`

**Type Changes:**
```typescript
// Before:
export type RuntimeServices = {
  db: Db;
  rawDb: Database;  // from bun:sqlite
  // ...
};

export type RuntimeBootstrapResult = {
  db: Db;
  rawDb: Database;  // from bun:sqlite
  // ...
};

// After:
export type RuntimeServices = {
  db?: Db;
  rawDb?: unknown;  // removed bun:sqlite dependency
  // ...
};

export type RuntimeBootstrapResult = {
  db?: Db;
  rawDb?: unknown;  // removed bun:sqlite dependency
  // ...
};
```

### Consumer Updates

**tools.ts changes:**
Added runtime check to ensure db/rawDb are available before use:
```typescript
export function registerRuntimeTools(toolExecutor: ToolExecutor, services: RuntimeServices): void {
  if (!services.db || !services.rawDb) {
    throw new Error("registerRuntimeTools requires db and rawDb (SQLite backend only)");
  }
  const coreMemory = new CoreMemoryService(services.db);
  const alias = new AliasService(services.rawDb as never);
  // ...
}
```

### Rationale

- Removed `import type { Database } from "bun:sqlite"` to decouple types from SQLite-specific types
- Made fields optional (`db?: Db`, `rawDb?: unknown`) to support PG backend where these don't exist
- Used `unknown` instead of `Database | undefined` to avoid importing SQLite types
- Cast to `never` for rawDb consumers since the AliasService and GraphNavigator expect Database type

### Verification

- Build: `bun run build` → 0 errors
- Tests: `bun test` → 1938 pass, 396 skip, 4 fail (failures are pre-existing config-related issues)
- Evidence saved to `.sisyphus/evidence/task-4-*.txt`

### Notes for Future Work

- Task 8 will handle `bootstrapRuntime()` branching to skip SQLite initialization for PG backend
- The existence check in tools.ts will need to be replaced with proper PG-aware tool registration
- Consider adding a discriminated union type based on `backendType` for better type safety

## [2026-04-01] Task 8: bootstrapRuntime() branching
- InteractionStore/CommitService/FlushSelector: for PG bootstrap path, added an in-memory `createPgInteractionStoreShim()` so `TurnService` can still be constructed without opening SQLite. SQLite branch remains on real `InteractionStore(db)`.
- EmbeddingService db arg: constructor still requires `Db`; PG path now injects `PgTransactionBatcher` and passes `undefined as Db` placeholder (pipeline remains disabled in PG branch until Wave 3/T14 decoupling).
- Episode/projection repos: PG branch now wires `PgEpisodeRepo`, `PgCognitionEventRepo`, `PgCognitionProjectionRepo`, `PgAreaWorldProjectionRepo` (lazy via `pgFactory.getPool()`), while SQLite keeps existing repos.
- shutdown(): kept sync signature `() => void`; added PG cleanup via `void pgFactory.close().catch(() => undefined)` and preserved SQLite close behavior behind backend guard.
- Any TODOs left for Wave 3
  - Replace PG in-memory InteractionStore shim with full PG-native TurnService composition (remove temporary shim path).
  - Enable PG memory pipeline components (`GraphStorageService`/`MemoryTaskAgent`/typed retrieval) once async service contracts are fully decoupled.

## [2026-04-01] Task 8: bootstrapRuntime() branching complete
- InteractionStore/CommitService/FlushSelector: kept SQLite behavior unchanged; PG path uses the existing in-memory `createPgInteractionStoreShim()` so `TurnService` construction does not require SQLite `InteractionStore`.
- EmbeddingService db arg: still required; PG path continues passing the existing cast placeholder with `PgTransactionBatcher` (T14 will remove this coupling).
- PgPendingFlushRecoveryRepo: used for PG path.
- Shutdown: fire-and-forget `pgFactory.close()` to keep sync type.
- All `db!` references safely gated behind `backendType === "sqlite"` checks.

## [2026-04-01] Task 9: DDL Migration Routing + PG Schema Bootstrap Verification
- SQLite migration functions (`runInteractionMigrations`, `runMemoryMigrations`, `runSessionMigrations`) are all inside `if (backendType === "sqlite" && db)` block (runtime.ts:616-630). PG branch never calls them.
- `PgBackendFactory.initialize()` (backend-types.ts:82-89) calls all 3 layers: `bootstrapTruthSchema`, `bootstrapOpsSchema`, `bootstrapDerivedSchema`.
- Async entry point `initializePgBackendForRuntime()` (runtime.ts:1124-1132) wraps `pgFactory.initialize()`.
- Pre-existing PG test bugs fixed:
  - `pg-derived-schema.test.ts`: pgvector requires `[...]` bracket literal format; plain array serializes without brackets via postgres library.
  - `pg-ops-schema.test.ts`: PG `bigserial` returns string through postgres library; need `Number()` cast for `toBeGreaterThan()`.
- All 26 PG schema tests pass against real container (port 55433).
- `bun:test` type definitions don't include `describe.skipIf` — LSP shows errors but tests run fine at runtime.

## Task 10: PG Pool Cleanup in shutdown()

- shutdown() in runtime.ts correctly uses fire-and-forget pattern for PG pool cleanup
- void pgFactory.close().catch(...) keeps shutdown() sync while allowing async cleanup
- PgBackendFactory.close() calls pool.end() and nullifies the reference
- Lifecycle test verifies: no hanging, idempotent close, proper error after close

## [2026-04-01] Task 11: settlement-ledger + explicit-settlement-processor decoupled from bun:sqlite

### DbLike pattern for bun:sqlite decoupling
- Both settlement-ledger.ts and explicit-settlement-processor.ts used `import type { Database } from "bun:sqlite"` only for the `Database` type in constructor parameters.
- Replaced with local structural `DbLike` type: `{ prepare(sql: string): { run(...): ...; all(...): ...; get(...): ... } }`
- This matches the pattern already used by cognition-repo.ts, relation-builder.ts, and relation-intent-resolver.ts.
- `db.raw` (the actual bun:sqlite Database instance) structurally satisfies `DbLike`, so no changes to runtime.ts were needed.
- The `SqliteSettlementLedger` class remains in settlement-ledger.ts — it's still the SQLite implementation, just no longer importing bun:sqlite types directly.

### Existing infrastructure that required no changes
- `SettlementLedgerRepo` contract already exists at `src/storage/domain-repos/contracts/settlement-ledger-repo.ts`
- `SqliteSettlementLedgerRepoAdapter` already exists at `src/storage/domain-repos/sqlite/settlement-ledger-repo.ts`
- `PgSettlementLedgerRepo` already exists at `src/storage/domain-repos/pg/settlement-ledger-repo.ts`
- runtime.ts injection was already correct — settlementLedger only created in `if (backendType === "sqlite" && db)` block

### Key insight: ExplicitSettlementProcessor's db usage goes beyond settlement ledger
- `this.db` in ExplicitSettlementProcessor is used for: episode queries, publication queries, relation materialization, conflict factor resolution, and contest conflict factor application.
- All these pass through to CognitionRepository, RelationBuilder, materializeRelationIntents, and resolveConflictFactors — all of which already use their own `DbLike` types.
- Decoupling ExplicitSettlementProcessor from `Database` type is therefore safe — structural typing handles the rest.

### Remaining bun:sqlite imports in task-agent.ts
- `src/memory/task-agent.ts` still imports `Database` from bun:sqlite and creates `SqliteSettlementLedger(this.rawDb)` and `ExplicitSettlementProcessor(this.rawDb, ...)`.
- This is out of scope for T11 but should be addressed in a future task to complete full decoupling of the memory pipeline.

## [2026-04-01] Task 17: interaction/store.ts + shared-block-attach-service.ts decoupled from raw SQLite

### interaction/store.ts — db.raw removal
- Replaced `db.raw.inTransaction` with a private `_inTransaction: boolean` flag, toggled in `beginTransaction()`/`commitTransaction()`/`rollbackTransaction()` methods with `finally` blocks to guarantee reset.
- Replaced `db.raw.prepare("BEGIN IMMEDIATE").run()` → `this.db.exec("BEGIN IMMEDIATE")` (and same for COMMIT/ROLLBACK). The `Db` interface's `exec()` method handles raw SQL statements without needing `prepare()`.
- Replaced `this.db.raw.prepare(upsertSql).run(...)` in `upsertRecentCognitionSlot` → `this.db.run(upsertSql, [...params])`. The `Db.run()` method accepts parameterized SQL.
- Result: zero `db.raw` references remain in store.ts.

### shared-block-attach-service.ts — DbLike removal
- Removed local `DbLike` type and `SharedBlockPermissions` import entirely.
- Constructor changed from `DbLike` to `SharedBlockRepo` contract dependency.
- All methods made async, delegating to repo contract methods: `isBlockAdmin`, `attachBlock`, `detachBlock`, `getAttachments`.
- `SharedBlockAttachment` type moved to contract file (`shared-block-repo.ts`), re-exported from service file for backward compatibility.

### SharedBlockRepo contract expansion
- Added `SharedBlockAttachment` type to contract.
- Added 4 new methods: `isBlockAdmin(blockId, agentId)`, `attachBlock(blockId, targetType, targetId, attachedBy)`, `detachBlock(blockId, targetType, targetId)`, `getAttachments(blockId)`.
- Both PG and SQLite implementations added.

### Key design notes
- `SharedBlockPermissions` class still exists with its own `DbLike` but is now orphaned (no importers found). Left in place since task only scoped the attach service.
- No runtime.ts changes needed — `SharedBlockAttachService` is not wired in runtime.ts (it's constructed ad-hoc in memory pipeline code).
- The `Db` interface's `exec()` method is the correct replacement for raw transaction control SQL — it doesn't return results but handles DDL/TCL statements.

### GraphStorageService decoupled from bun:sqlite (T15-storage)
- `GraphStorageService.db` public field was NEVER accessed externally — safe to remove entirely.
- `normalizeDbInput()` in storage.ts was dead code: all callers (runtime.ts:669, tests) already pass `Db`, not raw `Database`.
- `SqliteGraphStorageLegacyImpl` already uses `Db` interface (not raw `Database`), so delegate layer needed no changes.
- `withDomainRepos()` factory now takes only `(repoRegistry, jobPersistence?)` — no `db` parameter. Uses a Proxy stub that throws if accidentally accessed.
- The delegate pattern (`GraphStorageDelegateRegistry`) was already complete — the "extraction" had been done; the task was really about removing the import and unnecessary `Database` type references.
- File went from 1449 → 1400 lines. Clean removal, no architecture changes needed.

## [2026-04-01] Task 16 (GAP-C3): task-agent.ts + projection-manager.ts decoupled from bun:sqlite

### task-agent.ts — RawDatabaseLike structural type pattern
- Added `RawDatabaseLike` structural type (duck-type matching `bun:sqlite Database`) to support backward-compatible constructor that accepts raw `Database` objects from tests.
- `normalizeDbInput()` wraps a `RawDatabaseLike` into a full `Db` adapter, or passes through existing `Db` directly via `isDb()` guard.
- `isDb()` discriminates by checking for `query` function + `raw` property — `Db` has both, raw `Database` has neither.
- `ExplicitSettlementProcessor` now receives `this.db` (Db) instead of `this.rawDb` — works because ESP accepts `DbLike` (structural type).
- `SqliteSettlementLedger` and `GraphOrganizer` receive `this.db.raw` — they still need `Database` but get it transitively through `Db.raw`.
- Removed `private readonly rawDb: Database` field entirely.

### projection-manager.ts — Db["raw"] transitive type
- Constructor changed from `private readonly db?: Database` to `private readonly rawDb?: Db["raw"]`.
- `Db["raw"]` resolves to `Database` at the type level without importing `bun:sqlite` — the `Db` interface (from `src/storage/database.ts`) already has `raw: Database`.
- Only usage was passing through to `materializePublications()` which expects `db?: Database`.

### Key pattern: Db["raw"] for transitive type access
- When a module needs the `Database` type but shouldn't import `bun:sqlite`, use `Db["raw"]` as an indexed access type.
- This works because `Db` interface in `src/storage/database.ts` declares `raw: Database` — TypeScript resolves the type transitively.
- Prefer `Db["raw"]` over structural duck-typing when the value will simply be passed through to another API that expects `Database`.

## [2026-04-01] Task 12: navigator.ts + graph-edge-view.ts decoupled from bun:sqlite via GraphReadQueryRepo

### Core decoupling outcome
- `src/memory/graph-edge-view.ts` no longer imports `bun:sqlite` or reads tables directly; it now delegates all read surfaces to `GraphReadQueryRepo` and maps `GraphReadEdgeRecord` into `GraphEdgeReadResult`.
- `src/memory/navigator.ts` now operates on `GraphReadQueryRepo` and propagates async through beam expansion/reranking/safety pipeline where reads occur.

### Practical compatibility insight (important)
- Existing navigator tests (and potentially call sites) still construct `new GraphNavigator(db, ...)` with raw SQLite `Database` while the new constructor expects a query repo.
- To avoid a broad cross-task migration blast radius, `GraphNavigator` now has a compatibility coercion:
  - If the first constructor arg is a full `GraphReadQueryRepo`, use it directly.
  - Else if it looks like legacy DB (`prepare(...)`), auto-wrap with `SqliteGraphReadQueryRepo`.
- This keeps T12 focused while preserving legacy constructor behavior for old tests.

### Sync/async edge-case insight in safety net
- `applyPostFilterSafetyNet` is now async for repo-backed visibility, but some tests call it synchronously via `(navigator as any).applyPostFilterSafetyNet(...)`.
- Added a legacy sync fallback branch (enabled only when constructed from legacy DB) so these direct sync invocations still return `EvidencePath | null` rather than `Promise`.
- Production repo-backed path remains async and awaited by `assembleEvidence`.

### SQLite adapter shape detection pitfall
- In `SqliteGraphReadQueryRepo`, detecting Db adapter with `"query" in this.db` is unsafe because raw bun:sqlite `Database` also has `query` API.
- Correct guard is checking for wrapper-specific `Db.raw` presence (`typeof db.raw === "object"`) before using adapter-style `.query/.get`.
- Without this, raw `Database` gets mis-routed and throws invalid private-field errors at runtime.

### Verification-specific findings
- T12-targeted suites (`src/memory/navigator.test.ts`, `test/memory/navigator.test.ts`, `test/memory/validation-explain-visibility.test.ts`) pass after compatibility fixes.
- `bun run build` passes.
- `ast-grep` confirms no `import { Database } from "bun:sqlite"` in `navigator.ts` / `graph-edge-view.ts`.
- Full `bun test` and `bun test src/memory/` still contain pre-existing unrelated failures (embeddings/materialization/promotion/shared-blocks/runtime-behavioral baselines).

## [2026-04-01] Task 13: organizer/promotion read-side decoupling
- GraphOrganizer no longer reads sqlite tables directly; it now consumes NodeScoringQueryRepo for content rendering, embedding lookup, one-hop neighbors, recency/logic/cluster features, and search projection material.
- PromotionService no longer reads sqlite tables directly; it now consumes PromotionQueryRepo for event/fact candidate discovery, entity decisioning, event lookup, and timestamp resolution.
- For synchronous memory APIs that still require immediate results, sqlite repo methods can return already-resolved promises; when necessary, service-layer sync bridges use Bun.peek and throw explicit errors if unresolved promises leak into sync paths.
- T13 surfaced constructor ripple effects: organizer now needs a query repo dependency, which required task-agent wiring updates and test setup updates (graph-node-registry and promotion.test).
- Validation outcome for this checkpoint: bun run build passes; bun test fails on pre-existing non-T13 dirty-tree failures; focused bun test src/memory/promotion.test.ts passes.

## [2026-04-01] Task 14: materialization + embeddings decoupled from bun:sqlite
-  now depends on  +  instead of direct sqlite  queries; sqlite creation path moved to  helper for compatibility in tests/runtime wiring.
- Added/expanded  to own sqlite persistence/query behavior (upsert, cosine query, visibility filtering), so service layer stays backend-agnostic while preserving algorithm behavior.
-  constructor now accepts , normalizes internally to , and resolves entity/public-event decisions through  (sqlite impl: ) instead of inline entity SQL decision logic.
- Runtime PG branch now injects  + ; sqlite branch injects  +  and passes  into materialization wiring.
- T14 commit intentionally excluded T18 surfaces (, ) and left unrelated  working-tree changes untouched.

## [2026-04-01] Task 14 follow-up: corrected notes
- EmbeddingService now depends on EmbeddingRepo and ITransactionBatcher; SQLite construction path uses EmbeddingService.fromSqlite(...) for compatibility.
- SqliteEmbeddingRepoAdapter owns SQLite embedding persistence and nearest-neighbor query filtering, keeping EmbeddingService backend-neutral.
- MaterializationService removed direct SQLite-specific type import and routes public-entity/public-event resolution through PromotionQueryRepo (sqlite implementation injected in runtime).
- Runtime wiring now injects PgEmbeddingRepo plus PgTransactionBatcher on PG path, and SqliteEmbeddingRepoAdapter plus TransactionBatcher on SQLite path.
- T14 commit intentionally excluded T18 files (narrative-search.ts and area-world-projection-repo.ts).

## [2026-04-01] Task 18: Narrative search + projection repo decoupling
-  now accepts either  or ; default SQLite path wraps  via , so memory-layer search no longer embeds SQL directly.
- Added  using FTS5  for area/world narrative surfaces with query-object support (, , , , ).
- Added  using  (, , ) and explicit score thresholding; no SQLite /FTS5 syntax used in PG path.
-  removed direct  type import by introducing an internal  shape for  surface compatibility.
-  needed  at publication materialization options boundary to satisfy TS structural typing after DB-like narrowing.

## [2026-04-01] Task 18 correction: escaped markdown details
- `NarrativeSearchService` now accepts `NarrativeSearchRepo | Db`; SQLite default wiring uses `SqliteNarrativeSearchRepo` so the service no longer embeds backend-specific FTS SQL.
- Added `SqliteNarrativeSearchRepo` with FTS5 `MATCH` queries for area/world narrative surfaces and support for `NarrativeSearchQuery` knobs (`text`, `limit`, `minScore`, `includeArea`, `includeWorld`).
- Added `PgNarrativeSearchRepo` using `pg_trgm` operators/functions (`%`, `similarity`, `word_similarity`) with score filtering; no FTS5 `MATCH` syntax in PG implementation.
- `src/memory/projection/area-world-projection-repo.ts` removed direct `bun:sqlite` type import via structural `DbLike` (`exec` + `prepare` surface).
- `projection-manager.ts` keeps `db: this.rawDb as never` at the materialization call boundary to satisfy narrowed DB-like typing under strict TS checks.

## [2026-04-01] Wave 3 regression fix notes (post T12-T18)
- `EmbeddingService` sync call paths (`batchStoreEmbeddings`, `queryNearestNeighbors`) are sensitive to unresolved Promises because `resolveNow` uses `Bun.peek()`. SQLite adapter repos should return synchronous values (or already-settled values), not async microtask-delayed results.
- For shared-block attachment tests, `SharedBlockAttachService` now requires `SharedBlockRepo` contract implementation (`SqliteSharedBlockRepoAdapter`), not raw `DbLike`; tests must also `await` async attach/detach/list methods.
- Durable organizer queue tests should not assume fixed processing order of chunk jobs; assert retryable transitions by processing until observed rather than expecting first processed job to be the fail-target.
- Promotion/materialization entity resolution blocks names with private-existence markers (`secret`, `private`, etc.); test fixtures expecting promotion should avoid those markers unless explicitly validating block behavior.

## [2026-04-01] Task 19: Remaining SQLite-coupled scripts migrated to bootstrapRuntime()

### Scripts migrated
- `scripts/memory-backfill.ts`: Replaced `openDatabase()` + `runMemoryMigrations()` with `bootstrapRuntime({ databasePath })`. Added `--backend pg` + `--pg-url` support via `PgBackendFactory`.
- `scripts/graph-registry-coverage.ts`: Same pattern. Extracted `printReport()` helper to share between SQLite and PG branches.
- `scripts/memory-verify.ts`: Replaced the remaining `openDatabase()` call (line 1483) with `bootstrapRuntime()`. PG branch was already working via `PgBackendFactory`. Removed `runMemoryMigrations` import (handled by bootstrap).
- `scripts/qa-task18.ts`: Replaced `openDatabase({ path: tempPath })` with `bootstrapRuntime({ databasePath: tempPath })`. QA script is SQLite-only (creates temp DB), no PG path needed.

### Pattern: bootstrapRuntime() vs createAppHost() for diagnostic scripts
- `createAppHost()` returns `AppHost` which exposes high-level facades (`maintenance`, `admin`, `user`) but NOT the raw `db` handle.
- Scripts that need raw SQL queries (count queries, direct inserts) must use `bootstrapRuntime()` directly to obtain `runtime.db`.
- `bootstrapRuntime()` handles `openDatabase()` + all migrations internally, so scripts don't need to import either.
- For PG paths in diagnostic scripts, use `PgBackendFactory` directly (same pattern as `memory-verify.ts` PG branch).
- `runtime.shutdown()` replaces `db.close()` for proper lifecycle cleanup.

### Key insight: no openDatabase imports remain in migrated scripts
- `grep -r "openDatabase" scripts/ --include="*.ts"` returns only `parity-verify.ts` (out-of-scope parity script).
- All 4 migrated scripts use `bootstrapRuntime()` for SQLite path and `PgBackendFactory` for PG path where applicable.

---

## T21: Remaining Test Fixture Migration (2026-04-01)

### Pattern: Most SQLite test files CANNOT be mechanically migrated to PG
- 12 out of 17 non-memory SQLite test files pass `db: Database` directly to service constructors (`InteractionStore(db)`, `TurnService(db, ...)`, `JobPersistenceFactory(db)`, etc.)
- These constructors accept SQLite `Database` types, not PG connection objects
- Mechanical `createTempDb()` → `createPgTestDb()` swapping is impossible without rewriting the service constructors
- The right approach: identify COVERAGE GAPS in existing PG tests, then write NEW PG-native tests for those gaps

### Pattern: Audit-first approach for test migration
- Step 1: Grep all files using `createTempDb()`/`openDatabase()` to build complete inventory
- Step 2: Categorize each file: (a) SQLite-coupled, (b) potentially migratable, (c) SQLite-specific
- Step 3: Cross-reference against existing `test/pg-app/` coverage to find real gaps
- Step 4: Write new PG tests only for genuine coverage gaps
- This avoids wasting effort on impossible migrations and duplicate test coverage

### Discovery: porsager/postgres v3.4.8 JSONB string bug
- When storing JSONB via `${JSON.stringify(val)}::jsonb`, the library returns the value as a RAW STRING on read, not a parsed object
- `typeof row.payload` is `"string"`, not `"object"`
- This breaks any code that does `typeof payload !== "object"` checks or direct property access like `payload.ownerAgentId`
- Affected methods in `PgInteractionRepo`: `getSettlementPayload()`, `listStalePendingSettlementSessions()`, `rowToRecord()`
- The existing `pg-interaction-session-repo.test.ts` already has 5 pre-existing failures from this bug
- Fix: either use `JSON.parse()` on read, or use postgres library's built-in JSONB handling (e.g., `sql.json(val)`)

### Pattern: New PG test file follows established conventions
- Import `skipPgTests` from `test/helpers/pg-test-utils.ts` as the skip guard
- Use `withTestAppSchema()` from `test/helpers/pg-app-test-utils.ts` for schema setup/teardown
- Use `createPgTestDb()` for creating the `PgTestDb` connection object
- Create repo instances directly: `new PgInteractionRepo(testDb.sql)`
- Use `afterAll(() => testDb.close())` for cleanup
- Wrap each describe with `describe.skipIf(skipPgTests)(...)`

### Key insight: 4 real PG coverage gaps in PgInteractionRepo
- `getSettlementPayload` — returns latest settlement payload for session+request
- `getMessageRecords` filtering — returns only message records, excluding status/settlement
- `findSessionIdByRequestId` REQUEST_ID_AMBIGUOUS error path — throws when request maps to multiple sessions
- `listStalePendingSettlementSessions` — finds sessions with stale unprocessed settlements
- All 4 now have test coverage via `pg-interaction-request-lookup.test.ts` (7 test cases)

## [2026-04-01] Task 22: SQLite producer freeze toggle
- `resolveBackendType()` now enforces freeze guard: when backend resolves to `sqlite` and `MAIDSCLAW_SQLITE_FREEZE=true`, startup throws a hard error with explicit PG fallback guidance.
- `MAIDSCLAW_SQLITE_FREEZE=true` remains safe for PG runtime startup because guard only applies when resolved backend is `sqlite`.
- `AppMaintenanceFacadeImpl.drain()` now integrates freeze behavior by setting `MAIDSCLAW_SQLITE_FREEZE=true` for sqlite backend before marking drain mode, while keeping drain callable/idempotent.
- Added `scripts/freeze-sqlite.ts` as an ops probe: prints current freeze status and exits `0` when frozen, `1` when not frozen.

## [2026-04-01] Task 23: Drain Gate CLI Enhancement
- bun:sqlite `new Database(path, { readonly: false })` causes SQLITE_MISUSE error; for write access use `new Database(path)` without options (default is read-write).
- `forceDrain()` added to `src/jobs/sqlite-drain-check.ts`: updates pending/processing/retryable rows to 'exhausted' status (never deletes data).
- CLI argument parsing uses manual `process.argv` iteration — no external deps needed for simple flag/value pairs.
- Polling loop pattern: `while(true)` with deadline check, `setTimeout`-based sleep, and explicit exit codes (0=ready, 1=not-ready/timeout, 2=error).
- JSON audit output includes full `DrainCheckReport` nested under `report` field plus top-level summary fields (`ready`, `activeJobs`, `pendingJobs`, `timestamp`, `polls`, `forceDrained`).
- Original one-shot behavior (no args) preserved exactly as before — backward compatible.
