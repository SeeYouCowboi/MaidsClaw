# Memory System - Learnings

## Project Setup
- Runtime: Bun (bun:sqlite, bun test)
- Language: TypeScript (strict mode, ESNext)
- No ORM - raw parameterized SQL via db.prepare().run()
- No better-sqlite3 or sql.js - bun:sqlite ONLY
- Test: `bun test src/memory/`

## Key Constants
- MAX_INTEGER = Number.MAX_SAFE_INTEGER (2^53 - 1) for t_invalid/t_expired sentinels
- NodeRef format: `event:{id}`, `entity:{id}`, `fact:{id}`, `private_event:{id}`, `private_belief:{id}`

## Schema Facts
- 16 core tables + 3 search_projection tables + 3 FTS5 virtual tables = 22 total
- FTS5 uses trigram tokenizer only (no ICU). CJK requires ≥3 char queries.
- entity_nodes uses partial unique indexes (not standard UNIQUE):
  - ux_entity_public_pointer: (pointer_key) WHERE memory_scope='shared_public'
  - ux_entity_private_pointer: (owner_agent_id, pointer_key) WHERE memory_scope='private_overlay'
- event_nodes: visibility_scope in ('area_visible','world_public') ONLY - no 'owner_private'
- event_nodes: event_category in ('speech','action','observation','state_change') - NO 'thought'
- agent_event_overlay: event_category includes 'thought' (private only)
- fact_edges: world_public stable facts ONLY (not area_visible transient state)

## Architecture Rules
- createProjectedEvent(): SOLE entry point for area_visible events (runtime_projection + delayed_materialization)
- createPromotedEvent(): SOLE entry point for world_public events from Promotion Pipeline
- event_origin invariants (cross-field, enforced at app layer):
  - runtime_projection | delayed_materialization => visibility_scope='area_visible'
  - promotion => visibility_scope='world_public'
- VisibilityPolicy: ALL retrieval MUST go through it - no bare table access
- Viewer Context unforgeable - ToolExecutor injects from system state

## Bun-Specific Notes
- bun:sqlite is synchronous - no async mutex needed for TransactionBatcher
- Use `db.run("BEGIN IMMEDIATE")` / `db.run("COMMIT")` pattern for transactions

## Type System Patterns
- Use `satisfies Record<string, TypeName>` for enum-like constants (NOT TypeScript `enum` keyword)
- NodeRef uses template literal type: `\`kind:${number}\`` union of 5 variants
- NavigatorEdgeKind has EXACTLY 10 values: 4 logic + 2 fact + 1 participant + 3 semantic
- VisibilityScope has EXACTLY 4 values: system_only, owner_private, area_visible, world_public
- event_category 'thought' is ONLY valid for AgentEventOverlay, NOT EventNode
- projection_class is ONLY on agent_event_overlay (none | area_candidate)
- promotion_class is ONLY on event_nodes (none | world_candidate)
- Buffer type used for BLOB columns in bun:sqlite (NodeEmbedding.embedding)
- read_only uses number (0|1) for SQLite boolean compatibility
- Interface naming: I-prefixed for service interfaces (IMemoryStorage, IMemoryRetrieval, etc.)
- Result types use discriminated unions: `{ success: true; ... } | { success: false; ... }`

## Task 1 Implementation Learnings
- db.prepare(sql).run() works for DDL, CREATE VIRTUAL TABLE, and transaction control (BEGIN/COMMIT/ROLLBACK)
- FTS5 trigram tokenizer confirmed working in bun:sqlite on Windows x64 (Bun v1.3.10)
- FTS5 creates 5 shadow tables per virtual table (_data, _idx, _content, _docsize, _config) - all have 'fts' in name
- sqlite_master counts: 19 non-FTS (16 app tables + 3 infra tables), 3 FTS5 virtual tables
- Infrastructure tables (_migrations, _memory_runtime_state, _memory_maintenance_jobs) included in non-FTS count
- Schema uses `import { Database } from 'bun:sqlite'` directly (not the Db wrapper) for portability with :memory: dbs
- TransactionBatcher uses db.prepare('BEGIN IMMEDIATE').run() pattern (not db.exec)
- Module imports in bun test: use bare path (no extension) e.g. `from './schema'`

## Schema Test Compatibility Fixes - 2026-03-08

### Changes Made
- Added DEFAULT values to fact_edges.t_invalid and fact_edges.t_expired columns (DEFAULT MAX_INTEGER)
- Changed inline UNIQUE constraints to named indexes:
  - ux_core_memory_agent_label on core_memory_blocks(agent_id, label)
  - ux_node_embeddings_ref_view_model on node_embeddings(node_ref, view_type, model_id)
- Exported runMemoryMigrations function that accepts Db interface (uses db.transaction)
- Exported createMemorySchema function that accepts Database from bun:sqlite (uses prepare().run())
- Fixed TransactionBatcher.runInTransaction to properly return callback result
- Added enum-like const objects to schema exports: VisibilityScope, MemoryScope, EventCategory, ProjectionClass, PromotionClass

### Key Compatibility Patterns
- Db interface (from storage/database.ts) and Database (from bun:sqlite) both have exec() method
- runMemoryMigrations works with Db (has transaction method)
- createMemorySchema works with Database (has prepare().run() method)
- TransactionBatcher needs to support both enqueue/flush API and runInTransaction API
- runInTransaction<T>(fn: () => T): T executes fn within BEGIN/COMMIT or ROLLBACK on error

### Test Results
- src/memory/schema.test.ts: 29 tests passing
- test/memory/schema.test.ts: 4 tests passing
- Full suite: 320 tests passing


## Core Memory Service - 2026-03-08

### Implementation
- CoreMemoryService class in src/memory/core-memory.ts
- 5 methods: initializeBlocks, getBlock, getAllBlocks, appendBlock, replaceBlock
- Uses INSERT OR IGNORE for idempotent block initialization
- 3 default blocks: character (4000), user (3000), index (1500 read_only)
- index block enforces callerRole='task-agent' for writes; rp-agent/undefined rejected
- AppendResult and ReplaceResult types added to types.ts (discriminated unions)
- replaceBlock uses String.prototype.replace (first occurrence only)
- All SQL via db.prepare().run() / .get() / .all() — no db.exec()

### Test Results
- src/memory/core-memory.test.ts: 20 tests passing
- Full suite: 340 tests passing (up from 320)

## Retrieval + Embeddings Services - 2026-03-08

### Implementation
- Added `EmbeddingService` in `src/memory/embeddings.ts` with cosine similarity, Float32Array<->BLOB serialization helpers, transactional batch upsert into `node_embeddings`, and brute-force nearest-neighbor retrieval.
- `queryNearestNeighbors` now supports optional `agentId` filtering and excludes foreign private refs by validating `private_event:{id}` ownership via `agent_event_overlay` and `private_belief:{id}` ownership via `agent_fact_overlay`.
- Added `RetrievalService` in `src/memory/retrieval.ts` covering pointer redirects, entity/topic reads, scoped event/fact reads, scope-partitioned FTS search, memory hint generation, and hybrid lexical+semantic seed localization.
- Added read result/search types in `src/memory/types.ts`: `SearchResult`, `EntityReadResult`, `TopicReadResult`.
- FTS query safety pattern: escape quotes and tokenize multi-word queries into quoted term OR expressions (improves retrieval for natural-language prompts like "Tell me about coffee").

### Testing
- Added `src/memory/embeddings.test.ts` (7 tests): similarity math, serialization round-trip, batch persistence, nearest-neighbor ordering, and private-scope filtering.
- Added `src/memory/retrieval.test.ts` (12 tests): redirect resolution, private-over-shared entity precedence, alias resolution, visibility filtering, private/area/world search behavior, short-query guardrails, hints, hybrid seed fusion, and private-scope isolation.

### Verification Results
- `bun test src/memory/retrieval.test.ts`: pass
- `bun test src/memory/embeddings.test.ts`: pass
- `bun test`: 393 pass / 0 fail

## Graph Storage Service - 2026-03-08

### Implementation
- Added `GraphStorageService` in `src/memory/storage.ts` with synchronous, parameterized write APIs for public narrative, private overlays, facts, topics, aliases, redirects, search docs, embeddings, semantic edges, and node scores
- `createProjectedEvent()` is area-visible only (`event_origin` runtime_projection or delayed_materialization) and always writes `raw_text=NULL`, `promotion_class='none'`, then syncs to `search_docs_area` + `search_docs_area_fts`
- `createPromotedEvent()` is world-public only (`event_origin='promotion'`) and syncs to `search_docs_world` + `search_docs_world_fts`
- Entity upsert uses required INSERT OR IGNORE + UPDATE + SELECT pattern and NFC normalization for `pointer_key` / `display_name`
- Fact writes implement scope-local conflict behavior: invalidate existing current triple (`t_invalid=MAX_INTEGER`) before inserting a new current row
- `upsertSemanticEdge()` enforces private-node isolation by resolving `agent_id` from `private_event:{id}` / `private_belief:{id}` refs and rejecting cross-agent private edges
- `createSameEpisodeEdges()` sorts by `(session_id, topic_id, timestamp)`, links adjacent pairs within 24h in both directions, and runs atomically via `TransactionBatcher.runInTransaction`

### Testing
- Added `src/memory/storage.test.ts` with 17 scenarios covering all required QA paths (entity scope behavior, fact invalidation, private event/belief rules, FTS sync/search, projected/promoted invariants, embeddings, same_episode adjacency, and transactional rollback)
- Targeted: `bun test src/memory/storage.test.ts` -> 17 pass
- Full suite: `bun test` -> 381 pass, 0 fail
