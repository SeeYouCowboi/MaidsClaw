# Area State Authority Domain Definition

**Status**: Architectural contract document  
**Scope**: `area_state_current`, `area_state_events`, `area_narrative_current` tables and their write paths  
**Last updated**: 2026-04-02

---

## 1. Authority Domain Classification

Area State is a **semi-independent authority domain with a dual-surface model**. It is not purely derived from narrative, nor is it a free-standing truth store. The distinction is precise:

- The **event ledger** (`area_state_events`) is append-only and is the canonical truth plane for area state. Any write to area state goes there first, permanently.
- The **current projection** (`area_state_current`) is a rebuildable view over that ledger: it holds the latest value per `(agent_id, area_id, key)` triple, derived by taking the event with the highest `(committed_time, id)`.

This means area state has its own independent storage identity, separate from the narrative graph (`event_nodes`, `public_events`) and from the private cognition ledger. A write to area state does not require a public graph event to exist, and a public graph event does not automatically produce an area state row.

**The authority question answered directly**: Area State is not derived from `narrative_outward_projection` or `public_materialization`. It is written to independently by the three projection triggers (`publication`, `materialization`, `promotion`), each through its own path in `AreaWorldProjectionRepo`. The narrative surface (`area_narrative_current`) is written as a *side-effect* of some area state writes, not the other way around.

---

## 2. Storage Architecture

Two tables serve area state:

### `area_state_events` (truth plane, append-only)

Defined in `src/storage/pg-app-schema-truth.ts`. This is the canonical record. Rows are never updated or deleted in normal operation.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | Monotone insert order |
| `agent_id` | TEXT | Scoped per agent |
| `area_id` | INTEGER | Location entity ID |
| `key` | TEXT | Arbitrary state key |
| `value_json` | JSONB | State payload |
| `surfacing_classification` | TEXT | See §4 |
| `source_type` | TEXT | See §3 |
| `valid_time` | BIGINT nullable | When the fact became true in the world |
| `committed_time` | BIGINT NOT NULL | When this write was committed |
| `settlement_id` | TEXT NOT NULL | Links to the settlement batch that produced this write |
| `created_at` | BIGINT NOT NULL | Row insertion time |

Indexes: `(agent_id, area_id, key, committed_time DESC)`, `(settlement_id)`, `(agent_id, area_id, valid_time DESC)`

### `area_state_current` (current projection, rebuildable)

Defined in `src/storage/pg-app-schema-derived.ts`. Holds one row per `(agent_id, area_id, key)`. Can be fully rebuilt from `area_state_events` via `PgProjectionRebuilder.rebuildAreaStateCurrent()` or `AreaWorldProjectionRepo.rebuildAreaCurrentFromEvents()`.

The rebuild logic is: for each unique `(agent_id, area_id, key)`, select the `area_state_events` row with the highest `(committed_time DESC, id DESC)`.

**Classification**: `area_state_current` is a **rebuildable current projection**, not a canonical truth store. It mirrors the latest value from the truth plane. If it is lost or corrupted, it can be reconstructed without data loss.

### `area_narrative_current` (narrative surface, side-effect)

Defined in `src/storage/pg-app-schema-derived.ts`. One row per `(agent_id, area_id)`. Stores a human-readable `summary_text` string. Written only when an area state write has `surfacing_classification = 'public_manifestation'`. This table has no event ledger backing; it cannot be rebuilt from other tables.

---

## 3. `source_type` Catalog

The `source_type` column is enforced by a database `CHECK` constraint on both `area_state_events` and `area_state_current`. The canonical values are defined in `src/memory/projection/area-world-projection-repo.ts`:

```typescript
export const AREA_STATE_SOURCE_TYPES = ["system", "gm", "simulation", "inferred_world"] as const;
```

The default value is `"system"` when no `sourceType` is provided to `upsertAreaState`.

### Value semantics

| `source_type` | Authority level | Meaning |
|---------------|----------------|---------|
| `system` | Highest (runtime default) | Written by engine infrastructure as part of normal turn processing. Settlement-backed. This is the most common value and covers publication, materialization, and promotion writes. |
| `gm` | Game-master authority | Explicitly injected by a game master or operator, bypassing normal agent turn flow. Higher semantic authority than inferred values; represents deliberate world-state overrides. |
| `simulation` | Simulation authority | Written by a simulation layer or background world process, not tied to an agent's narrative output. Represents autonomous world evolution. |
| `inferred_world` | Lowest | Derived or inferred from other evidence rather than observed directly. Represents the system's best estimate when a direct observation is unavailable. |

These values form an **informational provenance chain**, not a strict override hierarchy in the current implementation. The codebase does not currently enforce read-time precedence rules between `source_type` values (e.g., `gm` does not automatically overwrite `system`). Consumers that need provenance-based resolution must implement their own comparison logic.

---

## 4. `surfacing_classification` Catalog

The `surfacing_classification` column controls whether and how an area state entry surfaces to narrative-facing layers. Enforced by `CHECK` constraint on both tables, and validated at write time via `assertSurfacingClassification()`:

```typescript
export const SURFACING_CLASSIFICATIONS = [
  "public_manifestation",
  "latent_state_update",
  "private_only",
] as const;
```

| Value | Meaning |
|-------|---------|
| `public_manifestation` | The state change is visible to the narrative surface. When written to `area_state_current`, this also triggers a write to `area_narrative_current` (the summary text). This is the default classification for all three projection triggers. |
| `latent_state_update` | The state change is recorded in the area state ledger but does not surface to `area_narrative_current`. It exists in the system's knowledge without a narrative manifestation. |
| `private_only` | State that should not surface outside private scopes. Not currently routed to any narrative surface. |

**World state restriction**: The `assertWorldClassification()` guard in `AreaWorldProjectionRepo` enforces that world-scoped projections (`applyPromotionProjection`, world-branch of `applyPublicationProjection`) only accept `public_manifestation`. Latent or private state is area-scoped only.

---

## 5. Latent State — Independent Existence Without Narrative Events

**Latent area state can exist without a triggering narrative event.** This is a first-class design property of the storage model, not an edge case.

The evidence:

1. `upsertAreaState()` / `upsertAreaStateCurrent()` accept any `surfacingClassification` including `latent_state_update`. No check requires a corresponding public narrative event to exist.
2. The `area_state_events` ledger is independent of `event_nodes` and `private_episode_events`. There is no foreign key connecting them.
3. `latent_state_update` entries write to `area_state_current` but do not write to `area_narrative_current`. The narrative surface is therefore unaffected.
4. The `settlement_id` field links a write to a *settlement batch*, not to a specific narrative event. A settlement can contain area state writes without any publication or materialization.

**What this means in practice**: An area state key can be written and maintained entirely in the background, accumulating history in `area_state_events`, with the current projection always up to date in `area_state_current`, without any `area_narrative_current` row ever being created for that key. This is the intended use case for `latent_state_update`.

**What is not yet implemented** (V3 deferred scope per §3 of `MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md`): A dedicated "independent background authority" model that allows latent state to evolve outside the publication/materialization/promotion trigger chain entirely. Currently, all writes to area state go through one of those three triggers or through a direct `upsertAreaState` call. There is no autonomous world-simulation write path yet.

---

## 6. Relationship to `narrative_outward_projection` and Graph Edges

Area state does not derive from or depend on the memory graph (entity nodes, fact edges, event nodes). The relationship is directional and one-way:

```
Publication / Materialization / Promotion trigger
           |
           v
  area_state_events  (truth plane write)
           |
           v
  area_state_current (current projection update, upsert on conflict)
           |
           |-- if surfacing_classification == 'public_manifestation'
           v
  area_narrative_current (summary text update)
```

The memory graph (public events, entities, facts) and the area state ledger are **sibling systems**. Both are written during materialization and promotion, but neither derives from the other. Specifically:

- `applyMaterializationProjection` writes to area state after `createProjectedEvent` creates a graph node. Area state holds a structured record referencing the event IDs; the graph holds the event entity itself.
- `applyPublicationProjection` writes to area state for `current_area` scope publications and to both world state and narrative for `world_public` scope publications.
- `applyPromotionProjection` writes only to world state and world narrative, never to area state.

**`area_narrative_current` is not a projection of narrative outward.** It is a side-effect of area state writes. It summarizes what the area state system last surfaced, not what the narrative graph contains.

---

## 7. Write Paths and Trigger Contract

All writes to area state are gated by exactly one of three `ProjectionUpdateTrigger` values, enforced at the entry points in `AreaWorldProjectionRepo`:

| Trigger | Entry point | Area state written? | World state written? | Narrative written? |
|---------|-------------|---------------------|----------------------|--------------------|
| `publication` | `applyPublicationProjection` | Yes (if `targetScope == current_area`) | Yes (if `targetScope == world_public`) | Yes (if `public_manifestation`) |
| `materialization` | `applyMaterializationProjection` | Yes | No | Yes (if `public_manifestation`) |
| `promotion` | `applyPromotionProjection` | No | Yes | Yes (always) |

The trigger value is validated at write time; passing a wrong trigger to a method throws immediately.

**Direct write path**: `upsertAreaState()` and `upsertAreaStateCurrent()` accept writes without a trigger. These are lower-level methods for cases that don't fit the publication/materialization/promotion model. The `source_type` defaults to `"system"` when not provided.

**Settlement linkage**: Every area state event row carries a `settlement_id`. This links the write to a settlement batch for recovery and audit purposes. If no explicit `settlementId` is passed, the system auto-generates one as `legacy:auto:{committedTime}`.

---

## 8. Bridge Contract: Area State to Narrative Surfaces

The bridge between area state and narrative is conditional and explicit. It runs only when `surfacing_classification == 'public_manifestation'`:

```
area_state_current write (any surfacing_classification)
      |
      |-- surfacing_classification == 'public_manifestation'?
      |       YES: upsertAreaNarrativeCurrent(agentId, areaId, summaryText)
      |       NO:  skip
```

The `area_narrative_current` table stores one summary per `(agent_id, area_id)` pair. Each `public_manifestation` area state write overwrites the previous summary for that pair. It is **not a log** and has no history; the latest summary wins.

**What `area_narrative_current` represents**: The most recent human-readable summary of what was publicly surfaced in this area by this agent. It is suitable for prompt injection ("what is the current public state of this area") but not for historical queries.

**What it does not represent**: It does not encode the full structured state. The structured key-value state is in `area_state_current`. Narrative is a lossy projection of the structured state, not the other way around.

**Consumers**: Prompt assembly reads `area_narrative_current` for area context summaries. Structured state consumers read `area_state_current` directly via `getAreaStateCurrent()` or `getAreaStateAsOf()`.

---

## 9. Historical Query Capability

Current capability is **current-only**. This is intentional and documented as a capability boundary freeze.

- `getAreaStateCurrent(agentId, areaId, key)`: returns the latest value from `area_state_current`.
- `getAreaStateAsOf(agentId, areaId, key, asOfCommittedTime)`: queries `area_state_events` directly, returning the most recent event row at or before `asOfCommittedTime`. This is the only time-slice read path.

The `area_state_current` table is a live overwrite projection. It cannot answer "what was the state at time T" for T in the past without going to `area_state_events`.

Full historical projection (rebuilding a past-state snapshot of `area_state_current`) is a V3 deferred item per §5 of the candidates document.

---

## 10. Authority Model Summary

| Question | Answer |
|----------|--------|
| Is area state an independent authority domain? | Semi-independent. It has its own append-only truth plane (`area_state_events`) and does not derive from narrative. |
| Is `area_state_current` canonical? | No. It is a rebuildable current projection over `area_state_events`. |
| Can area state exist without a narrative event? | Yes. `latent_state_update` writes exist in the ledger with no narrative surface. |
| Does narrative drive area state? | No. Area state drives (a subset of) narrative — specifically `area_narrative_current`. |
| Is `area_narrative_current` canonical? | No. It has no backing ledger and cannot be rebuilt. It is a lossy summary cache. |
| Can area state be written directly without a trigger? | Yes, via `upsertAreaState()`. Trigger methods are the standard path; direct upsert exists for edge cases. |
| What is the default `source_type`? | `"system"` |
| What is the default `surfacing_classification`? | `"public_manifestation"` (set by all three trigger methods) |
