# Memory V3 Closeout — Learnings

## Task 2: graph_nodes schema + catch fix

### Pattern: pg-app-schema-derived.ts
- All tables use `await sql.unsafe(...)` with raw SQL template strings
- Pattern: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
- Embedding dimension is parameterized via `${embeddingDim}` in VECTOR() type
- Tables are created sequentially in bootstrapDerivedSchema()

### Column discovery approach
- Read the INSERT statement in the consuming code FIRST, then match CREATE TABLE columns exactly
- registerGraphNodeShadows uses parseNodeRef() to split kind/id from a NodeRef
- ON CONFLICT (node_kind, node_id) means those must have a UNIQUE constraint

### Test patterns
- `describe.skipIf(skipPgTests)` — tests skip when PG is unavailable (port 55433)
- `withTestAppSchema(sql, async (pool) => { ... })` — creates isolated schema, drops after test
- Tests connect to `maidsclaw_app_test` DB at `127.0.0.1:55433`
- Baseline: 868 pass / 349 skip / 21 fail (all PG ECONNREFUSED at :5432)

### Empty catch anti-pattern
- Found `catch {}` swallowing errors silently in registerGraphNodeShadows
- Fix: log with console.error including context (nodeRefs), but don't re-throw (fire-and-forget is intentional)
- Pattern: `catch (error) { console.error('[methodName] ...', error, { context }); }`

## Task 5: Retire legacy `user` label + clarify `index` label

### Label taxonomy (V3 canonical)
- **Canonical (V3)**: `persona`, `pinned_summary`, `pinned_index` — active write targets
- **System-managed**: `index` — actively written by `CoreMemoryIndexUpdater` (NOT legacy)
- **Legacy**: `user` — read-only, no longer prompt-surfaced, DB rows retained for compat
- **Already removed**: `character` — not in `CORE_MEMORY_LABELS` at all

### index vs pinned_index
- `index`: system-managed by `CoreMemoryIndexUpdater.updateIndex()` → calls `replaceBlock(agentId, "index", ...)`
- `pinned_index`: canonical RP-facing version, read-only for RP (in `RP_READ_ONLY`)
- Both are read-only for RP agents but `index` is actively written by the task-agent pipeline

### Prompt surfacing mechanism
- `SHARED_LABELS` in `prompt-data.ts` controls which core memory blocks appear as `<shared_block>` in prompts
- `PINNED_LABELS` controls which appear as `<pinned_block>` in prompts
- Removing a label from these arrays stops prompt injection without touching DB rows
- `getSharedBlocks()` / `getSharedBlocksAsync()` filter `getAllBlocks()` by these label lists

### Safe retirement pattern
- Keep label in `CORE_MEMORY_LABELS` (type union) and `BLOCK_DEFAULTS` (DB init) for compat
- Remove from `SHARED_LABELS` / `PINNED_LABELS` to stop prompt injection
- Add `@deprecated` JSDoc with explicit retirement condition
- No runtime errors: empty filter result → empty string → no prompt section

## Task 6: Annotate compat surfaces + classify recent_cognition_slots

### Reference style for @deprecated
From `src/terminal-cli/app-client-runtime.ts`:
```typescript
/**
 * @deprecated Use `createAppHost()` directly instead. This bridge type exists
 * only so that any remaining `createAppClientRuntime()` call sites continue to
 * compile while migration to `AppHost` completes.
 */
```

Key pattern: explain what to use instead + why it exists + retirement condition.

### SQLite compat surfaces annotated

1. **Db interface** (`src/storage/db-types.ts`)
   - SQLite-shaped synchronous interface (`prepare()`, `lastInsertRowid`)
   - PG-only system still uses it — must be explicit about why and when to retire
   - Retirement: when all src/memory/ consumers migrate to PG async repos

2. **LegacyDbLike** (`src/memory/navigator.ts`)
   - Active safety net — runs when PG repos don't implement full interface
   - Must NOT be accidentally removed (it's actively used)
   - Retirement: when isFullGraphReadRepo() returns true for all repos

3. **useLegacySyncSafetyNet flag** (`src/memory/navigator.ts`)
   - Set when `!isFullGraphReadRepo(readRepo) && legacyDb !== null`
   - Gates legacy fallback path in `applyPostFilterSafetyNet()`
   - Retirement: remove when legacy safety net no longer needed

4. **isFullGraphReadRepo()** (`src/memory/navigator.ts`)
   - Gate function for legacy safety net
   - Checks for all required GraphReadQueryRepo methods
   - When this returns true for all repos, LegacyDbLike can be removed

### Classification: prompt_cache

**recent_cognition_slots** is a prompt cache, NOT a canonical projection:

- Canonical source: `private_cognition_events` (append-only ledger)
- This table: denormalized prompt convenience cache
- Properties:
  - Session-scoped
  - Trimmed to 64 entries
  - Can be rebuilt from ledger if lost
  - No dedicated rebuild path exists (V3.1+ candidate per §14.3)

**Why classification matters:**
- Future hardening: knows which data is authoritative vs derived
- Recovery planning: prompt caches can be rebuilt; canonical data cannot
- Maintenance: prompt caches can be dropped/truncated; canonical tables must be migrated

**Annotation style:**
```typescript
/**
 * @classification: prompt_cache
 * Canonical source is private_cognition_events (append-only ledger).
 * This table/repo manages a denormalized prompt convenience cache...
 */

## Task 4: Remove dead SQLite residue

### databasePath field removal
- Field `databasePath?: string` removed from `StorageConfig` type in `src/core/config-schema.ts`
- Confirmed zero callers/parsers via grep across entire codebase
- Only documentation references remained (in docs/ folder)

### PRAGMA reference cleanup
- File `src/memory/maintenance-report.ts` deleted by concurrent Task 3
- Contained dead SQLite-specific functions with PRAGMA commands:
  - `runIntegrityCheck()` - PRAGMA integrity_check
  - `getPageSize()` - PRAGMA page_size  
  - `getDatabaseSize()` - PRAGMA page_size, PRAGMA page_count
  - `getOldestRecord()` - PRAGMA table_info
- All functions had zero external callers (confirmed via grep)
- PostgreSQL equivalents (`gatherPgReportRows`, `getPgTableRowCount`) also had zero callers

### Verification approach
1. Grep for `databasePath` in src/ → confirm no references
2. Grep for `PRAGMA` in src/ → confirm no references
3. Run build → exit 0
4. Run tests → verify no new failures beyond baseline (21 pre-existing)

### Dead code detection pattern
- Search for function definitions with `export function`
- Grep for function names across src/ to find callers
- If zero callers found, mark as dead code candidate
- Check if function uses deprecated APIs (SQLite PRAGMA in PG codebase)
- Safe to remove when: zero callers + deprecated API usage + replacement exists
```

## Task 3: Dead code removal

### Verification pattern for file deletion
1. Grep entire repo for filename references (not just src/ — include docs/, scripts/, config/)
2. Check for barrel exports in index.ts files
3. Verify no actual importers exist (docs-only references are safe to delete)
4. Update barrel files to remove exports of deleted modules
5. Confirm build passes after deletion

### Files removed
- src/storage/migrations.ts — SQLite migration framework (45 lines)
- src/memory/maintenance-report.ts — SQLite PRAGMA maintenance  
- src/memory/search-rebuild-job.ts — old SQLite FTS rebuild (replaced by search-rebuild-pg.ts)

### Key insight
Barrel exports (index.ts) can create false positives — check if the barrel itself is imported before assuming the module has callers.

## Task 7: MemoryTaskAgent constructor refactor (PG-native deps)

### Chosen approach
- **Approach C**: remove SQLite-shaped constructor normalization and inject explicit settlement dependencies directly.
- `MemoryTaskAgent` now accepts a dependency object (`MemoryTaskAgentDeps`) with `db` adapter plus optional prebuilt explicit-settlement deps.
- `ExplicitSettlementProcessor` now accepts explicit deps (`db`, `cognitionRepo`, `relationBuilder`) instead of a `DbLike` it internally wraps.

### What changed
- Removed `RawDatabaseLike`, `normalizeDbInput`, and `isDb` from `src/memory/task-agent.ts`.
- Added exported adapter/dependency types:
  - `MemoryTaskDbAdapter`
  - `MemoryTaskAgentDeps`
  - `ExplicitSettlementDbAdapter`
  - `ExplicitSettlementProcessorDeps`
- Preserved behavior by defaulting to legacy internals when explicit deps are not provided:
  - `MemoryTaskAgent` still constructs `CognitionRepository` + `RelationBuilder` from the injected `db` adapter when `explicitSettlement` is omitted.

### Gotcha
- `task-agent.ts` and `explicit-settlement-processor.ts` still depend on synchronous `prepare(...).run/all/get` operations deeply in flush/settlement flow.
- Constructor wiring is now PG/bootstrap-friendly, but full async PG execution path still requires downstream migration of these sync query sites.

## Task 7: MemoryTaskAgent constructor refactor (G2a)

### Approach used: Hybrid (C + B)
- Extracted `ExplicitSettlementProcessorDeps` — allows injecting PG repos for `cognitionRepo` and `relationBuilder`
- `MemoryTaskAgentDeps.db` still SQLite-shaped (`MemoryTaskDbAdapter`) but lighter (no `query`, no `run`)
- `RawDatabaseLike`, `normalizeDbInput`, `isDb` all removed

### CRITICAL for T8: this.db is still used SQLite-style
- `this.db.exec("BEGIN IMMEDIATE")` at line 430 — SQLite-specific transaction
- `this.db.prepare(...)` used at lines 726, 803, 882, 923, 931 for direct SQL queries
- T8 must provide a `MemoryTaskDbAdapter`-compatible shim from PG pool
- Options: (1) no-op transaction wrapper + postgres.js sync-like operations, (2) remove SQLite transaction wrapper, (3) create PG shim implementing MemoryTaskDbAdapter

### ExplicitSettlementProcessorDeps
- `cognitionRepo: Pick<CognitionRepository, 'upsertAssertion'|...>` — can be PG repo
- `relationBuilder: Pick<RelationBuilder, 'writeContestRelations'>` — can be PG repo
- When `deps.explicitSettlement` is omitted, falls back to creating CognitionRepository(db)/RelationBuilder(db)

### Files changed
- `src/memory/task-agent.ts` — constructor signature, removed normalizeDbInput/RawDatabaseLike/isDb
- `src/memory/explicit-settlement-processor.ts` — added ExplicitSettlementProcessorDeps type, injectable deps

## Task 8: construct-but-gate bootstrap wiring (G2b)

### Services that existed vs what had to be created
- Existing in `runtime.ts`: `resolvePgPool()`, `pendingFlushRepo`, `ProjectionManager`, `TurnService` wiring skeleton, and hardcoded `memoryTaskAgent: null`.
- Missing and created for wiring:
  - `GraphStorageService` via PG repos (`PgGraphMutableStoreRepo`, `PgSearchProjectionRepo`, `PgEmbeddingRepo`, `PgSemanticEdgeRepo`, `PgNodeScoreRepo`)
  - `CoreMemoryService` (bound to throw-fast legacy DB shim)
  - `EmbeddingService` with `PgTransactionBatcher`
  - `MaterializationService` (throw-fast DB shim + `PgPromotionQueryRepo`)
  - `NodeScoringQueryRepo` via `PgNodeScoringQueryRepo`
  - settlement ledger adapter over `PgSettlementLedgerRepo` using `Bun.peek` sync bridge
  - `MemoryTaskModelProviderAdapter` (with explicit throw-fast fallback provider when model resolution fails)

### Construct-but-gate decisions
- `MemoryTaskAgent` is now constructed when `memoryEmbeddingModelId` exists.
- `memoryPipelineReady` intentionally remains `false`.
- `TurnService` flush paths (`flushOnSessionClose`, `flushIfDue`, `runFlush`) now require `memoryPipelineReady` in addition to non-null agent.
- `PendingSettlementSweeper` is instantiated + `start()` called, but sweep execution is gated by an `isEnabled` option tied to `memoryPipelineReady`.

### Publication sweeper compatibility gotcha
- `PublicationRecoverySweeper` is still SQLite-table based (`_memory_maintenance_jobs`) while current PG ops schema uses `pending_settlement_recovery`.
- Kept compatibility guard false for now; constructor path remains wired conditionally (`memoryTaskAgent !== null && schemaCompatible`) without enabling an incompatible runtime path.

### Pipeline status semantics
- Added `"partial"` to `MemoryPipelineStatus` and used it when embedding model exists but pipeline is intentionally gated off.
- Retained existing unavailable states (`chat_model_unavailable`, `embedding_model_unavailable`, organizer variant) for semantic correctness.

## Task 9: Pipeline wiring verification tests (G2c)

### Test approach
- Unit-style tests in `test/bootstrap/pipeline-wiring.test.ts` — no PG, no full bootstrap
- TurnService constructed directly with stubs to test flush gate behavior
- PendingSettlementSweeper constructed with `isEnabled: () => false` to verify gate
- Pipeline status logic replicated inline (the IIFE in runtime.ts is not exportable)

### Key findings
- TurnService constructor has 13 positional params; `buildTurnService()` helper avoids repetition
- `memoryPipelineReady` defaults to `true` in TurnService constructor (line 90) — must explicitly pass `false`
- PendingSettlementSweeper `isEnabled` gate at line 67: `!this.options.isEnabled?.() && this.options.isEnabled !== undefined`
- TS narrows IIFE return type — `expect(status).not.toBe("ready")` fails typecheck; use `status as string`
- 10 tests, 0 failures, no PG required

## Task 10: Register memory tools in ToolExecutor

### Key type mismatch: MemoryToolDefinition vs ToolDefinition
- `MemoryToolDefinition` uses `handler(args: Record<string, unknown>, viewerContext: ViewerContext)`
- `ToolDefinition` uses `execute(params: unknown, context?: DispatchContext)`
- Cannot pass `ToolExecutor` directly to `registerMemoryTools` — need adapter wrapper
- Adapter extracts `context?.viewerContext` and delegates to `handler`

### RetrievalService stub
- `RetrievalService` has private class members → cannot `as RetrievalService` on plain object
- `createLazyPgRepo<RetrievalService>(() => throw)` works because generic type params bypass private member checks
- Services only invoked at handler execution time, not registration time — stubs safe for schema visibility

### Placement in runtime.ts
- `registerMemoryTools` call placed after `coreMemoryService` creation (line ~1018)
- Uses block scope `{ }` to contain `lazyRetrieval` variable
- All 6 tools registered (2 write + 4 read-only)

## Task 11: organizer strict mode

### Changes to organizer fallback (task-agent.ts lines 499-533)
- `strictDurableMode=true` + enqueue failure → re-throws (no background fallback). Server/worker failures are visible.
- `strictDurableMode=true` + no jobPersistence → throws with descriptive error. Strict mode requires durable infrastructure.
- `strictDurableMode=false` + enqueue failure → `console.error` with structured log (operation, jobType, batchId, agentId, error message) + `launchBackgroundOrganize`.
- `strictDurableMode=false` + no jobPersistence → `console.error` with deprecation warning + `launchBackgroundOrganize`.
- Changed from `console.warn` to `console.error` for all fallback paths (errors should be visible in log aggregation).

### Backward compat path (formerly lines 512-517)
- Split into `else if (this.strictDurableMode)` → throw, and `else` → @deprecated fallback.
- @deprecated JSDoc block added with retirement condition: "Remove when all deployments supply JobPersistence."
- `launchBackgroundOrganize` already had @deprecated annotation (preserved).

### Test approach (organizer-enqueue-failure.test.ts)
- 4 tests: strict+enqueue-fail, non-strict+enqueue-fail, strict+no-persistence, non-strict+no-persistence.
- `applyCallOneToolCalls` stub must push to `created.changedNodeRefs` — otherwise `enqueueOrganizerJobs` returns early (line 573-575) and never calls `enqueue()`.
- `makeStubAgent` accepts optional `jobPersistence` (was required before).
- Structured log assertions verify operation, jobType, batchId, agentId, error fields.

## Task 15 (G6): Area State Authority Domain Definition

### Key architectural finding
Area State is a **semi-independent authority domain**, not derived from narrative:
- `area_state_events`: append-only truth plane (canonical)
- `area_state_current`: rebuildable current projection (NOT canonical)
- `area_narrative_current`: lossy narrative summary cache (NO backing ledger, cannot be rebuilt)

### source_type values (AREA_STATE_SOURCE_TYPES const)
- `system` (default) — engine writes via publication/materialization/promotion
- `gm` — game master overrides
- `simulation` — autonomous world-process writes
- `inferred_world` — derived/estimated state (lowest provenance)
No runtime precedence enforcement — consumers must implement if needed.

### surfacing_classification values (SURFACING_CLASSIFICATIONS const)
- `public_manifestation` — also writes area_narrative_current
- `latent_state_update` — state exists, no narrative surface
- `private_only` — no surfacing at all
World-scoped projections (promotion, world_public publication) are restricted to public_manifestation only.

### Latent state verdict
Latent area state CAN exist without narrative events. area_state_events has no FK to event_nodes or private_episode_events. A settlement_id links to a settlement batch, not a narrative event.

### Three write trigger paths
- `publication` (applyPublicationProjection): area OR world, classification default = public_manifestation
- `materialization` (applyMaterializationProjection): area only, classification default = public_manifestation
- `promotion` (applyPromotionProjection): world only, always public_manifestation, never area state

### bridge contract
area_state writes -> area_narrative_current ONLY when surfacing_classification == 'public_manifestation'
area_narrative_current = one row per (agent_id, area_id), overwrites on each public_manifestation write, no ledger, no rebuild path.

### Historical query capability
Current-only freeze: getAreaStateCurrent() + getAreaStateAsOf() only.
getAreaStateAsOf() queries area_state_events directly (not current projection).
Full historical snapshot rebuild is V3 DEFERRED (§5 candidates doc).
