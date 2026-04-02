# Search Authority Matrix

> Wave 0 / T2 — 2026-03-27
>
> This document defines the authority source, allowed write paths, and repair strategy for every
> `search_docs_*` table in the MaidsClaw memory system. It is the reference contract for T7
> (`search.rebuild` job implementation).
>
> Evidence file: `.sisyphus/evidence/task-2-write-paths.txt`
> Gap analysis reference: `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md` §5.2

---

## Terminology

| Term | Meaning |
|---|---|
| **sync_projection** | Written inline, in the same transaction as the canonical write. Always consistent with authority source at commit time. |
| **async_refresh** | Written by a background job (GraphOrganizer) after the canonical write. May lag or be missing until the job runs. |
| **cache_index** | FTS5 virtual table. Derived from the main `search_docs_*` row. Disposable — can be rebuilt by re-inserting from the main table. |
| **authority source** | The canonical table whose rows are the ground truth for rebuilding this search doc. |
| **repair order** | `authority source → search_docs_* main table → *_fts virtual table`. Never repair FTS before the main table. |

---

## Table: search_docs_private

**Schema** (`schema.ts:81`):
```sql
CREATE TABLE IF NOT EXISTS search_docs_private (
  id INTEGER PRIMARY KEY,
  doc_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
```

- **Authority Source:** `entity_nodes` (memory_scope = 'private_overlay'), `private_cognition_current` (kind IN assertion/evaluation/commitment, status != retracted/rejected/abandoned)
- **Role:** `sync_projection` (primary path via `storage.syncSearchDoc`) + `async_refresh` (secondary path via `GraphOrganizer.syncSearchProjection`)
- **Scope key:** `agent_id` — rows are per-agent, not shared

### Write Paths

| File | Line | Operation | Trigger | Description |
|---|---|---|---|---|
| `src/memory/storage.ts` | 710 | `INSERT OR REPLACE` | `syncSearchDoc(scope="private")` | Upsert private doc; called inline from event/entity writes |
| `src/memory/storage.ts` | 762 | `DELETE` | `removeSearchDoc(scope="private")` | Remove private doc by source_ref |
| `src/memory/graph-organizer.ts` | 420 | via `syncSearchDoc("private")` | `syncSearchProjection()` — entity, private_overlay | Async refresh: entity display_name + summary |
| `src/memory/graph-organizer.ts` | 435 | via `removeSearchDoc("private")` | `syncSearchProjection()` — evaluation/commitment, retracted | Async remove on retraction |
| `src/memory/graph-organizer.ts` | 439 | via `syncSearchDoc("private")` | `syncSearchProjection()` — evaluation/commitment, active | Async refresh: private_notes + summary_text |
| `src/memory/graph-organizer.ts` | 451 | via `removeSearchDoc("private")` | `syncSearchProjection()` — assertion, rejected/abandoned | Async remove on stance change |
| `src/memory/graph-organizer.ts` | 461 | via `syncSearchDoc("private")` | `syncSearchProjection()` — assertion, active | Async refresh: summary_text + provenance |

### Repair Strategy

1. Truncate `search_docs_private` and `search_docs_private_fts`.
2. For each `entity_nodes` row where `memory_scope = 'private_overlay'`: insert `(doc_type='entity', source_ref='entity:{id}', agent_id=owner_agent_id, content=display_name+summary)`.
3. For each `private_cognition_current` row where `kind IN ('evaluation','commitment')` and `status != 'retracted'`: insert `(doc_type=kind, source_ref='{kind}:{id}', agent_id, content=private_notes+summary_text)`.
4. For each `private_cognition_current` row where `kind = 'assertion'` and `stance NOT IN ('rejected','abandoned')`: insert `(doc_type='assertion', source_ref='assertion:{id}', agent_id, content=summary_text+provenance)`.
5. Rebuild `search_docs_private_fts` from the repaired main table.

---

## Table: search_docs_area

**Schema** (`schema.ts:84`):
```sql
CREATE TABLE IF NOT EXISTS search_docs_area (
  id INTEGER PRIMARY KEY,
  doc_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  location_entity_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
```

- **Authority Source:** `event_nodes` (visibility_scope = 'area_visible')
- **Role:** `sync_projection` (primary path via `storage.syncSearchDoc`) + `async_refresh` (secondary path via `GraphOrganizer.syncSearchProjection`)
- **Scope key:** `location_entity_id` — rows are per-location

### Write Paths

| File | Line | Operation | Trigger | Description |
|---|---|---|---|---|
| `src/memory/storage.ts` | 731 | `INSERT OR REPLACE` | `syncSearchDoc(scope="area")` | Upsert area doc; called inline from `createEvent()` when visibility_scope='area_visible' |
| `src/memory/storage.ts` | 773 | `DELETE` | `removeSearchDoc(scope="area")` | Remove area doc by source_ref |
| `src/memory/graph-organizer.ts` | 399 | via `syncSearchDoc("area")` | `syncSearchProjection()` — event, area_visible | Async refresh: event summary with location |

### Repair Strategy

1. Truncate `search_docs_area` and `search_docs_area_fts`.
2. For each `event_nodes` row where `visibility_scope = 'area_visible'` and `summary IS NOT NULL`: insert `(doc_type='event', source_ref='event:{id}', location_entity_id, content=summary)`.
3. Rebuild `search_docs_area_fts` from the repaired main table.

---

## Table: search_docs_world

**Schema** (`schema.ts:87`):
```sql
CREATE TABLE IF NOT EXISTS search_docs_world (
  id INTEGER PRIMARY KEY,
  doc_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
```

- **Authority Source:** `event_nodes` (visibility_scope = 'world_public'), `entity_nodes` (memory_scope = 'shared_public'), `fact_edges`
- **Role:** `sync_projection` (primary path via `storage.syncSearchDoc`) + `async_refresh` (secondary path via `GraphOrganizer.syncSearchProjection` and `promotion.crystallizeFact`)
- **Scope key:** none — globally visible

### Write Paths

| File | Line | Operation | Trigger | Description |
|---|---|---|---|---|
| `src/memory/storage.ts` | 747 | `INSERT OR REPLACE` | `syncSearchDoc(scope="world")` | Upsert world doc; called inline from `createEvent()` when visibility_scope='world_public' |
| `src/memory/storage.ts` | 261 | via `syncSearchDoc("world")` | `createPromotedEvent()` | Promoted events always land in world scope |
| `src/memory/storage.ts` | 783 | `DELETE` | `removeSearchDoc(scope="world")` | Remove world doc by source_ref |
| `src/memory/graph-organizer.ts` | 401 | via `syncSearchDoc("world")` | `syncSearchProjection()` — event, world_public | Async refresh: event summary |
| `src/memory/graph-organizer.ts` | 422 | via `syncSearchDoc("world")` | `syncSearchProjection()` — entity, shared_public | Async refresh: entity display_name + summary |
| `src/memory/graph-organizer.ts` | 471 | via `syncSearchDoc("world")` | `syncSearchProjection()` — fact_edge | Async refresh: source_entity predicate target_entity |
| `src/memory/promotion.ts` | 336 | via `syncSearchDoc("world")` | `crystallizeFact()` | Fact promotion writes world search doc inline |

### Repair Strategy

1. Truncate `search_docs_world` and `search_docs_world_fts`.
2. For each `event_nodes` row where `visibility_scope = 'world_public'` and `summary IS NOT NULL`: insert `(doc_type='event', source_ref='event:{id}', content=summary)`.
3. For each `entity_nodes` row where `memory_scope = 'shared_public'`: insert `(doc_type='entity', source_ref='entity:{id}', content=display_name+summary)`.
4. For each `fact_edges` row: insert `(doc_type='fact', source_ref='fact:{id}', content=source_entity_id+predicate+target_entity_id)`.
5. Rebuild `search_docs_world_fts` from the repaired main table.

---

## Table: search_docs_cognition

**Schema** (`schema.ts:89`):
```sql
CREATE TABLE IF NOT EXISTS search_docs_cognition (
  id INTEGER PRIMARY KEY,
  doc_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assertion', 'evaluation', 'commitment')),
  basis TEXT CHECK (basis IN ('first_hand', 'hearsay', 'inference', 'introspection', 'belief')),
  stance TEXT CHECK (stance IN ('hypothetical', 'tentative', 'accepted', 'confirmed', 'contested', 'rejected', 'abandoned')),
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)
```

- **Authority Source:** `private_cognition_current` (the current-state projection of the cognition event log)
- **Role:** `sync_projection` — written inline in the same transaction as every cognition upsert. No async path. Stance updates are also synchronous.
- **Scope key:** `agent_id` + `kind` + `stance` — rows are per-agent cognition item

### Write Paths

| File | Line | Operation | Trigger | Description |
|---|---|---|---|---|
| `src/memory/cognition/cognition-repo.ts` | 1000 | `INSERT OR REPLACE` | `syncCognitionSearchDoc()` | Upsert cognition search doc; called from every `upsertAssertion`, `upsertEvaluation`, `upsertCommitment` |
| `src/memory/cognition/cognition-repo.ts` | 957 | `UPDATE ... SET stance` | `updateCognitionStance()` — evaluation/commitment branch | Stance-only update; does NOT re-insert FTS |
| `src/memory/cognition/cognition-repo.ts` | 974 | `UPDATE ... SET stance` | `updateCognitionStance()` — assertion branch | Stance-only update; does NOT re-insert FTS |
| `src/memory/cognition/cognition-repo.ts` | 1018 | `DELETE` (FTS) | `syncCognitionSearchDoc()` | Delete old FTS row before re-insert |
| `src/memory/cognition/cognition-repo.ts` | 1020 | `INSERT` (FTS) | `syncCognitionSearchDoc()` | Re-insert FTS row with new content |
| `src/memory/schema.ts` | 796 | `DELETE` | Migration `memory:029` | One-time purge of legacy `private_event:*` and `private_belief:*` refs |

**Note on stance updates:** `updateCognitionStance()` (lines 957, 974) updates `stance` and `updated_at` on the main table but does NOT touch `search_docs_cognition_fts`. This is intentional — stance is a filter column, not a content column. FTS content does not change on stance transitions.

### Repair Strategy

1. Truncate `search_docs_cognition` and `search_docs_cognition_fts`.
2. For each `private_cognition_current` row: insert `(doc_type=kind, source_ref='{kind}:{id}', agent_id, kind, basis, stance, content=summary_text, updated_at, created_at=updated_at)`.
3. Rebuild `search_docs_cognition_fts` from the repaired main table.
4. Do NOT include rows where `source_ref LIKE 'private_event:%' OR source_ref LIKE 'private_belief:%'` (legacy refs, purged by migration 029).

---

## FTS Sidecar Tables

Each main `search_docs_*` table has a paired FTS5 virtual table:

| Main table | FTS sidecar | Tokenizer |
|---|---|---|
| `search_docs_private` | `search_docs_private_fts` | `trigram` |
| `search_docs_area` | `search_docs_area_fts` | `trigram` |
| `search_docs_world` | `search_docs_world_fts` | `trigram` |
| `search_docs_cognition` | `search_docs_cognition_fts` | `trigram` |

- **Role:** `cache_index` — disposable, always derived from the main table
- **Authority Source:** the paired main `search_docs_*` table (not the canonical source tables)
- **Write rule:** FTS rows are always written/deleted as a sidecar to the main table write. Never written independently.
- **Repair:** `DELETE FROM {table}_fts; INSERT INTO {table}_fts(rowid, content) SELECT id, content FROM {table};`
- **Known gap:** `updateCognitionStance()` updates the main table but skips FTS. This is safe because stance is not a content field, but it means FTS content can be stale if content was also changed via a stance-only path. The `search.rebuild` job must handle this.

---

## Role Summary

| Table | Role | Primary Write Owner | Has Async Path |
|---|---|---|---|
| `search_docs_private` | sync_projection + async_refresh | `GraphStorageService.syncSearchDoc` | Yes (GraphOrganizer) |
| `search_docs_area` | sync_projection + async_refresh | `GraphStorageService.syncSearchDoc` | Yes (GraphOrganizer) |
| `search_docs_world` | sync_projection + async_refresh | `GraphStorageService.syncSearchDoc` | Yes (GraphOrganizer + promotion) |
| `search_docs_cognition` | sync_projection | `CognitionRepository.syncCognitionSearchDoc` | No |
| `*_fts` (all four) | cache_index | sidecar to main table write | No |

---

## Repair Order Contract

For any repair or rebuild job, the order is fixed:

```
authority source tables
  → search_docs_* main tables
    → *_fts virtual tables
```

Reversing this order (e.g., rebuilding FTS before the main table) produces incorrect results and must never happen.

---

## Known Gaps (for T7)

1. `updateCognitionStance()` updates `stance` on `search_docs_cognition` but does not re-sync FTS. If content also changed, FTS may be stale. The rebuild job should re-sync FTS unconditionally.
2. The async `GraphOrganizer` path can overwrite a sync-written doc with stale content if the organizer job runs against an older snapshot. The rebuild job must read from authority source, not from existing `search_docs_*` rows.
3. No delete propagation exists for `fact_edges` deletions to `search_docs_world`. The rebuild job must treat the full scan as the source of truth and remove orphaned rows.
4. FTS failure in `syncFtsRow` currently only logs (see `storage.ts:904`). The rebuild job must treat FTS inconsistency as a recoverable error, not a fatal one.
