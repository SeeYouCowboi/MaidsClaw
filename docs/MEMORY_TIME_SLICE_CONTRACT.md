# Memory Time-Slice Truth Model Contract

> **Status**: Frozen capability boundary (V3 cutover 2026-04-02)
>
> This document defines the **actual** time-slice query capability of each memory
> surface. It is the authoritative source for what supports historical queries and
> what does not.

---

## Core Concepts

### `valid_time` — World Truth

> "When was this fact TRUE in the world?"

`valid_time` records the point in time when an event or state **actually occurred
or became true** in the simulated world, regardless of when the agent learned
about it.

**Example**: A character died at 14:00 (`valid_time = 14:00`), but the agent
only heard the rumor at 16:00.

### `committed_time` — Agent Knowledge

> "When did the agent LEARN about this fact?"

`committed_time` records the point in time when a fact was **committed into the
agent's knowledge graph** — i.e., when the settlement pipeline processed and
stored it.

**Example**: The death happened at 14:00 (`valid_time`), the agent heard at
16:00, and the settlement pipeline committed it at 16:05 (`committed_time`).

### `current_only` — No Historical Support

The surface only exposes the **latest snapshot**. Old values are overwritten
(upsert/ON CONFLICT DO UPDATE) and cannot be recovered from the current table
alone.

> **Important distinction**: Some `current_only` surfaces have companion
> append-only `_events` tables in the truth schema. The `_events` table preserves
> full history, but the `_current` derived table does not expose an `asOf` query
> API. Historical queries against the events table require a dedicated `getAsOf()`
> method.

---

## Surface Capability Matrix

| Surface | Table(s) | Historical Query | Time Dimensions | `getAsOf()` API |
|---|---|---|---|---|
| `area_state` | `area_state_events` (truth) + `area_state_current` (derived) | **Yes** — via events table | `committed_time` | `getAreaStateAsOf(agentId, areaId, key, asOfCommittedTime)` |
| `world_state` | `world_state_events` (truth) + `world_state_current` (derived) | **Yes** — via events table | `committed_time` | `getWorldStateAsOf(key, asOfCommittedTime)` |
| `cognition` | `private_cognition_events` (truth) + `private_cognition_current` (derived) | **Not supported** | Has `committed_time` column in events, no `asOf` API | — |
| `episode` | `private_episode_events` (truth only, no current table) | **Not supported** | Has `valid_time` + `committed_time` columns, no `asOf` API | — |
| `search_docs_*` | `search_docs_private`, `search_docs_area`, `search_docs_world`, `search_docs_cognition` (all derived) | **Not supported** | No time-slice columns; only `created_at` | — |
| `node_embeddings` | `node_embeddings` (derived) | **Not supported** | Only `updated_at`; upsert overwrites | — |
| `graph edges` (via navigator) | In-memory beam expansion | **Yes** — post-retrieval filter | `valid_time` + `committed_time` | `filterEvidencePathsByTimeSlice()` in navigator `explore()` |

---

## Per-Surface Detail

### `area_state`

**Designation**: **Historical** (committed_time dimension)

- **Truth table**: `area_state_events` — append-only ledger with `valid_time` and `committed_time` columns.
- **Derived table**: `area_state_current` — ON CONFLICT DO UPDATE snapshot with `valid_time` and `committed_time` columns (latest only).
- **Historical query**: `PgAreaWorldProjectionRepo.getAreaStateAsOf(agentId, areaId, key, asOfCommittedTime)` queries the events table with `committed_time <= asOfCommittedTime`, ordered by `committed_time DESC, id DESC`.
- **Rebuild**: `rebuildAreaCurrentFromEvents()` can reconstruct the current table from the events ledger.
- **Limitation**: `getAreaStateAsOf()` only supports `committed_time` dimension. There is no `asOfValidTime` variant for area state queries via the repo API.

### `world_state`

**Designation**: **Historical** (committed_time dimension)

- **Truth table**: `world_state_events` — append-only ledger with `valid_time` and `committed_time` columns.
- **Derived table**: `world_state_current` — ON CONFLICT DO UPDATE snapshot with `valid_time` and `committed_time` columns (latest only).
- **Historical query**: `PgAreaWorldProjectionRepo.getWorldStateAsOf(key, asOfCommittedTime)` queries the events table with `committed_time <= asOfCommittedTime`, ordered by `committed_time DESC, id DESC`.
- **Rebuild**: `rebuildWorldCurrentFromEvents()` can reconstruct the current table from the events ledger.
- **Limitation**: Same as area_state — only `committed_time` dimension supported in the repo `asOf` API.

### `cognition`

**Designation**: **current_only** (no historical query API)

- **Truth table**: `private_cognition_events` — append-only ledger with `committed_time` column (no `valid_time`).
- **Derived table**: `private_cognition_current` — maintains latest cognition per `(agent_id, cognition_key)`.
- **No `asOf` API**: The `PgCognitionProjectionRepo` only has current-projection methods. No `getCognitionAsOf()` exists.
- **Navigator path**: The navigator reads from `private_cognition_current` directly (e.g., `expandPrivateBeliefFrontier()`), which is always-current.
- **Future**: A `getCognitionAsOf()` method could be built against the events table, but this is a V3.1+ item.

### `episode`

**Designation**: **current_only** (no historical query API)

- **Truth table**: `private_episode_events` — append-only ledger with `valid_time` and `committed_time` columns.
- **No derived table**: Episodes are truth-only; there is no `episode_current` materialization.
- **No `asOf` API**: The `PgEpisodeRepo` does not expose time-slice query methods. Episodes are queried by `agent_id` and `created_at` ordering.
- **Schema support**: The events table has both `valid_time` and `committed_time` columns, so the data foundation exists for future `asOf` queries.

### `search_docs_*`

**Designation**: **current_only** (no time-slice support)

- **Tables**: `search_docs_private`, `search_docs_area`, `search_docs_world`, `search_docs_cognition` — all derived/projection tables.
- **No time-slice columns**: These tables only have `created_at` (and `updated_at` for cognition). No `valid_time` or `committed_time`.
- **Upsert semantics**: Content is updated in-place via ON CONFLICT DO UPDATE.
- **Not designed for historical query**: These are full-text search acceleration surfaces, not temporal truth stores.

### `node_embeddings`

**Designation**: **current_only** (no time-slice support)

- **Table**: `node_embeddings` — derived table storing vector embeddings per `(node_ref, view_type, model_id)`.
- **No time-slice columns**: Only `updated_at` exists; no `valid_time` or `committed_time`.
- **Upsert semantics**: ON CONFLICT `(node_ref, view_type, model_id)` DO UPDATE — old embeddings are overwritten.
- **Not designed for historical query**: Embeddings represent the current vectorization of a node; historical embeddings are not retained.

### Graph Edges (Navigator Evidence Paths)

**Designation**: **Historical** (both dimensions, post-retrieval filter)

- **Mechanism**: The `memory_explore` tool accepts `asOfTime` + `timeDimension` parameters (or legacy `asOfValidTime` / `asOfCommittedTime`).
- **Implementation**: `GraphNavigator.explore()` calls `filterEvidencePathsByTimeSlice(assembled, input)` at line 251 of `navigator.ts`, filtering already-retrieved evidence paths by time constraints.
- **Both dimensions**: Edges carry `valid_time`, `committed_time`, and `timestamp` fields. The filter supports both dimensions simultaneously.
- **Important caveat**: This is a **post-retrieval filter** — seeds are located without time constraints, then the beam-expanded paths are filtered. This means seed selection is not time-aware; only path edges are filtered.

---

## Tool Layer: `memory_explore`

The `memory_explore` tool (registered in `tools.ts`) is the primary agent-facing API for time-slice queries.

**Parameters**:
- `asOfTime` (number) + `timeDimension` ("valid_time" | "committed_time") — preferred API
- `asOfValidTime` (number) — legacy, direct valid-time cutoff
- `asOfCommittedTime` (number) — legacy, direct committed-time cutoff

**Resolution**: `asOfTime` + `timeDimension` is converted via `buildTimeSliceQuery()` to populate `asOfValidTime` / `asOfCommittedTime` on the `MemoryExploreInput`, which is then passed through the navigator's `explore()` flow.

**What it filters**: Evidence path edges (graph traversal results). It does NOT time-slice projection lookups (area_state, world_state, cognition) that may occur during retrieval.

---

## What Is NOT Supported (Explicit Declarations)

1. **Cognition historical query**: No `getCognitionAsOf()` API exists. The events table has `committed_time` but no query method uses it for point-in-time reconstruction.

2. **Episode historical query**: No `getEpisodeAsOf()` API exists. The events table has both `valid_time` and `committed_time` but no query method uses them for time-slice filtering.

3. **Search docs time-slice**: No time-slice columns exist on any `search_docs_*` table. These are acceleration caches, not temporal stores.

4. **Node embeddings time-slice**: No time-slice columns exist. Embeddings are overwritten on re-computation.

5. **Seed selection time-awareness**: `localizeSeedsHybrid()` does not respect time-slice parameters. Seeds are selected based on current relevance, then evidence paths are filtered post-retrieval.

6. **`valid_time` dimension for area/world state repo queries**: `getAreaStateAsOf()` and `getWorldStateAsOf()` only accept `committed_time` cutoffs. A `valid_time`-based query against the events table is not implemented (though the column and index exist).

---

## Summary: Capability Boundary

```
HISTORICAL (has asOf API):
  ├── area_state     → getAreaStateAsOf()      [committed_time only]
  ├── world_state    → getWorldStateAsOf()      [committed_time only]
  └── graph edges    → filterEvidencePathsByTimeSlice()  [both dimensions]

CURRENT_ONLY (no asOf API):
  ├── cognition      → events table has committed_time, no query API
  ├── episode        → events table has valid_time + committed_time, no query API
  ├── search_docs_*  → no time-slice columns at all
  └── node_embeddings → no time-slice columns at all
```

---

*Document generated as part of Memory V3 closeout. This is a frozen capability
boundary — changes require updating this contract.*
