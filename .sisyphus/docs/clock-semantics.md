# Clock Semantics in the Settlement Pipeline

**Generated:** 2026-03-27
**Scope:** Settlement pipeline `Date.now()` call sites and per-surface clock source definitions

---

## Overview

The settlement pipeline touches multiple data surfaces, each with its own time column and clock source. Currently, a single settlement commit can produce timestamps from **multiple independent `Date.now()` calls**, meaning the "time of this settlement" is not a single canonical value across all surfaces.

This document enumerates every `Date.now()` call site in the settlement path, defines the clock source for each data surface, and identifies the specific divergence that T10 must fix.

---

## Data Plane Definitions

### 1. Canonical Ledger Clock (`committed_time`)

**Tables:** `private_episode_events`, `private_cognition_events`
**Semantics:** The wall-clock time at which a settlement was committed to the append-only ledger. This is the authoritative event time for all canonical records produced by a settlement. All rows written in the same `commitSettlement()` call should share a single `committed_time` value.

**Current source:** `projection-manager.ts:90` — `const now = Date.now()` at the top of `commitSettlement()`. This value is passed down to `appendEpisodes()` and `appendCognitionEvents()` as the `now` parameter, so both ledgers share the same clock reading.

**Schema columns:**
- `private_episode_events.committed_time INTEGER NOT NULL`
- `private_cognition_events.committed_time INTEGER NOT NULL`

---

### 2. Cache / Projection Clock (`updated_at`)

**Tables:** `recent_cognition_slots`, `private_cognition_current`, `area_state_current`, `world_state_current`, `core_memory_blocks`
**Semantics:** The wall-clock time at which a projection or cache row was last refreshed. This is independent of settlement time and only carries freshness semantics. It does not represent when the underlying event occurred.

**Current source:** Multiple independent `Date.now()` calls, each taken at the moment the cache row is written. These are not coordinated with the canonical ledger clock.

**Schema columns:**
- `recent_cognition_slots.updated_at INTEGER NOT NULL`
- `private_cognition_current.updated_at INTEGER NOT NULL`
- `area_state_current.updated_at INTEGER NOT NULL`
- `world_state_current.updated_at INTEGER NOT NULL`
- `core_memory_blocks.updated_at INTEGER NOT NULL`

---

### 3. Derived / Async Clock (no time guarantee)

**Surfaces:** Publication materialization (`event_nodes`), graph organizer jobs, embedding generation
**Semantics:** These surfaces are written asynchronously or via a separate code path that takes its own `Date.now()`. The timestamp on these rows reflects when the async work ran, not when the originating settlement was committed. No ordering guarantee relative to the canonical ledger clock.

**Schema columns:**
- `event_nodes.timestamp INTEGER NOT NULL` (set at materialization time)
- `event_nodes.created_at INTEGER NOT NULL`

---

## Date.now() Call Sites in the Settlement Pipeline

The following sites are all confirmed by `grep -rn "Date.now()" src/` output. Each entry includes the exact file:line, the variable or field it populates, and its clock role.

### Site 1 — Canonical settlement clock origin

**Location:** `src/memory/projection/projection-manager.ts:90`

```typescript
commitSettlement(params: SettlementProjectionParams): void {
    const now = Date.now();   // <-- line 90

    this.appendEpisodes(params, now);
    this.appendCognitionEvents(params, now);
    ...
    this.upsertAreaStateArtifacts(params, now);
```

**Role:** Canonical Ledger clock. This `now` is passed to `appendEpisodes` (writes `private_episode_events.committed_time`) and `appendCognitionEvents` (writes `private_cognition_events.committed_time` and `private_cognition_current.committed_time`). It is also passed to `upsertAreaStateArtifacts` as `updatedAt`.

**Clock plane:** Canonical Ledger

---

### Site 2 — Publication materialization independent clock

**Location:** `src/memory/projection/projection-manager.ts:202`

```typescript
materializePublications(this.graphStorage, params.publications, params.settlementId, {
    sessionId: params.sessionId,
    locationEntityId: params.viewerSnapshot?.currentLocationEntityId,
    timestamp: Date.now(),   // <-- line 202
}, {
```

**Role:** A fresh `Date.now()` call taken *after* the canonical ledger writes at line 90 have already completed. This timestamp is used as `event_nodes.timestamp` for all publication events materialized from this settlement. It is **not** the same value as `now` from line 90.

**Clock plane:** Derived / Async (independent from canonical ledger)

**This is the T10 bug.** See Gap Analysis section below.

---

### Site 3 — Cognition slot payload clock

**Location:** `src/runtime/turn-service.ts:1033`

```typescript
function buildCognitionSlotPayload(
    ops: CognitionOp[],
    settlementId: string,
): RecentCognitionEntry[] {
    const committedAt = Date.now();   // <-- line 1033
```

**Role:** Populates `committedAt` on each `RecentCognitionEntry` written into the `recent_cognition_slots` cache. This is called from the turn-service path, independently of the `ProjectionManager.commitSettlement()` clock at line 90.

**Clock plane:** Cache / Projection (`updated_at` semantics)

---

### Site 4 — Recent cognition slot cache write

**Location:** `src/interaction/store.ts:246`

```typescript
this.db.raw.prepare(
    `INSERT OR REPLACE INTO recent_cognition_slots (session_id, agent_id, last_settlement_id, slot_payload, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
).run(sessionId, agentId, settlementId, JSON.stringify(entries), Date.now());   // <-- line 246
```

**Role:** Writes `recent_cognition_slots.updated_at`. This is a third independent `Date.now()` call for the same settlement, taken at the moment the cache row is persisted.

**Clock plane:** Cache / Projection (`updated_at` semantics)

---

### Site 5 — Turn-service fallback publication materialization

**Location:** `src/runtime/turn-service.ts:551`

```typescript
materializePublications(this.graphStorage, publications, settlementId, {
    sessionId: effectiveRequest.sessionId,
    locationEntityId: viewerSnapshot?.currentLocationEntityId,
    timestamp: Date.now(),   // <-- line 551
}, {
```

**Role:** A fallback path in `turn-service.ts` that calls `materializePublications` directly when `this.projectionManager` is null. Same semantics as site 2: an independent `Date.now()` used as `event_nodes.timestamp`.

**Clock plane:** Derived / Async (independent from canonical ledger)

---

### Site 6 — Materialization fallback timestamp

**Location:** `src/memory/materialization.ts:373`

```typescript
const timestamp = ctx.timestamp ?? Date.now();   // <-- line 373
```

**Role:** Inside `materializePublications()`, if the caller did not supply a `ctx.timestamp`, a fresh `Date.now()` is taken. This is the final fallback that ensures `event_nodes.timestamp` is always set, but it means the timestamp can drift even further from the canonical ledger clock if the caller omits the field.

**Clock plane:** Derived / Async

---

### Site 7 — Interaction commit-service record clock

**Location:** `src/interaction/commit-service.ts:111`

```typescript
private buildRecord(input: CommitInput, recordId: string, recordIndex: number): InteractionRecord {
    const committedAt = Date.now();   // <-- line 111
```

**Role:** Stamps `InteractionRecord.committedAt` for every interaction log entry (turn settlements, status records, etc.). This is the interaction-layer clock, separate from the memory-layer canonical ledger clock.

**Clock plane:** Interaction log (separate from memory settlement pipeline)

---

### Site 8 — Explicit settlement processor conflict update

**Location:** `src/memory/explicit-settlement-processor.ts:379`

```typescript
.run(
    summary,
    JSON.stringify(validRefs),
    Date.now(),   // <-- line 379
    agentId,
    assertion.cognitionKey,
);
```

**Role:** Updates `private_cognition_current.updated_at` when a conflict is detected during settlement processing. Independent clock, not coordinated with the canonical ledger `now` from `projection-manager.ts:90`.

**Clock plane:** Cache / Projection (`updated_at` semantics)

---

## Schema Time Columns Summary

From `src/memory/schema.ts`:

| Table | Column | Semantics |
|---|---|---|
| `private_episode_events` | `committed_time INTEGER NOT NULL` | Canonical ledger — settlement commit time |
| `private_cognition_events` | `committed_time INTEGER NOT NULL` | Canonical ledger — settlement commit time |
| `private_cognition_current` | `updated_at INTEGER NOT NULL` | Cache — last projection refresh time |
| `recent_cognition_slots` | `updated_at INTEGER NOT NULL` | Cache — last slot write time |
| `area_state_current` | `updated_at INTEGER NOT NULL` | Cache — last area state refresh time |
| `area_state_current` | `committed_time INTEGER` | Canonical — settlement commit time (nullable) |
| `area_state_current` | `valid_time INTEGER` | Event time — when the state became true in-world |
| `world_state_current` | `updated_at INTEGER NOT NULL` | Cache — last world state refresh time |
| `world_state_current` | `committed_time INTEGER` | Canonical — settlement commit time (nullable) |
| `world_state_current` | `valid_time INTEGER` | Event time — when the state became true in-world |
| `event_nodes` | `timestamp INTEGER NOT NULL` | Derived — materialization time (not settlement time) |
| `event_nodes` | `created_at INTEGER NOT NULL` | Derived — row insertion time |

---

## Clock Source Definitions Per Data Plane

| Data Plane | Clock Source | Column | Coordinated? |
|---|---|---|---|
| Canonical ledger (episodes) | `projection-manager.ts:90` `now` | `committed_time` | Yes — shared with cognition events |
| Canonical ledger (cognition events) | `projection-manager.ts:90` `now` | `committed_time` | Yes — shared with episodes |
| Cognition current projection | `projection-manager.ts:90` `now` (via `appendCognitionEvents`) | `committed_time` | Yes |
| Area state projection | `projection-manager.ts:90` `now` (via `upsertAreaStateArtifacts`) | `updated_at`, `committed_time` | Yes |
| Recent cognition slot cache | `interaction/store.ts:246` independent `Date.now()` | `updated_at` | No |
| Cognition slot entries | `turn-service.ts:1033` independent `Date.now()` | `committedAt` in JSON | No |
| Publication events (via ProjectionManager) | `projection-manager.ts:202` independent `Date.now()` | `event_nodes.timestamp` | No — **T10 bug** |
| Publication events (turn-service fallback) | `turn-service.ts:551` independent `Date.now()` | `event_nodes.timestamp` | No |
| Interaction log records | `commit-service.ts:111` independent `Date.now()` | `committedAt` | No (separate layer) |
| Conflict resolution updates | `explicit-settlement-processor.ts:379` independent `Date.now()` | `updated_at` | No |

---

## Gap Analysis

### The T10 Bug: `projection-manager.ts:202`

The core problem is that `materializePublicationsSafe()` takes a fresh `Date.now()` **after** the canonical ledger writes have already completed with the `now` captured at line 90.

```typescript
// Line 89-105 in projection-manager.ts
commitSettlement(params: SettlementProjectionParams): void {
    const now = Date.now();                          // clock reading A

    this.appendEpisodes(params, now);                // uses clock A
    this.appendCognitionEvents(params, now);         // uses clock A

    params.upsertRecentCognitionSlot(...);           // independent clock

    this.upsertAreaStateArtifacts(params, now);      // uses clock A

    this.materializePublicationsSafe(params);        // calls Date.now() again (clock B)
}

// Line 194-212 in projection-manager.ts
private materializePublicationsSafe(params: SettlementProjectionParams): void {
    if (params.publications.length === 0 || !this.graphStorage) {
        return;
    }

    materializePublications(this.graphStorage, params.publications, params.settlementId, {
        sessionId: params.sessionId,
        locationEntityId: params.viewerSnapshot?.currentLocationEntityId,
        timestamp: Date.now(),   // <-- line 202: clock B, independent of clock A
    }, { ... });
}
```

**What this means:**

- `private_episode_events.committed_time` = clock A
- `private_cognition_events.committed_time` = clock A
- `event_nodes.timestamp` (for publications from the same settlement) = clock B

Clock B is always >= clock A (both are monotonically increasing wall-clock readings), but they are not the same value. The gap between them is the time taken to execute `appendEpisodes`, `appendCognitionEvents`, and `upsertAreaStateArtifacts`.

**Fix required by T10:**

Pass `now` (clock A) from `commitSettlement()` into `materializePublicationsSafe()` so that all surfaces written during a single settlement share the same canonical timestamp:

```typescript
// Proposed fix
commitSettlement(params: SettlementProjectionParams): void {
    const now = Date.now();

    this.appendEpisodes(params, now);
    this.appendCognitionEvents(params, now);
    params.upsertRecentCognitionSlot(...);
    this.upsertAreaStateArtifacts(params, now);
    this.materializePublicationsSafe(params, now);   // pass now
}

private materializePublicationsSafe(params: SettlementProjectionParams, now: number): void {
    ...
    materializePublications(this.graphStorage, params.publications, params.settlementId, {
        sessionId: params.sessionId,
        locationEntityId: params.viewerSnapshot?.currentLocationEntityId,
        timestamp: now,   // use canonical clock A
    }, { ... });
}
```

The same fix applies to the fallback path at `turn-service.ts:551`, which should receive the settlement's canonical `committed_time` from the caller rather than calling `Date.now()` independently.

---

*References: `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md` §5.4*
