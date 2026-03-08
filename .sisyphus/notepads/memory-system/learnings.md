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
