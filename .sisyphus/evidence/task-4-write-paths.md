# Task 4: Write-Path Storage API Unification — Evidence

## Changes Made

### Edit 1 — Write-path summary (line 113)
- Added `canonical_extraction` to the `event_origin` enum list
- Added **Storage entry points** section: `createProjectedEvent()` is the sole storage entry point for RuntimeProjection and Delayed Public Materialization `area_visible` events; `createEvent()` serves canonical dialogue extraction (Task Agent Call 1) and Promotion Pipeline `world_public` writes

### Edit 2 — `createEvent()` storage API (line 1236)
- Added `eventOrigin` as required parameter (placed after `eventCategory`)
- Scoped: **canonical public writes only** — Task Agent Call 1 dialogue extraction and Promotion Pipeline world_public rows
- `eventOrigin` values: `'canonical_extraction'` (Task Agent Call 1) or `'promotion'` (Promotion Pipeline)
- Added explicit prohibition: **MUST NOT** be used for RuntimeProjection or Delayed Public Materialization `area_visible` events

### Edit 3 — `createProjectedEvent()` storage API (line 1237)
- Changed `origin` description to explicitly state it is persisted as `event_origin` column
- Changed "ONLY storage entry point" → **"sole storage entry point"** (matches acceptance criteria grep pattern)
- Added explicit: `createEvent()` MUST NOT be used for these

### Edit 4 — Task Agent Call 1 `create_event()` tool (line 1751)
- Added `event_origin` as required parameter (MUST be `'canonical_extraction'`)
- Scoped: canonical public event extraction from dialogue — world_public facts/events, area_visible events that were not runtime-projected
- Added prohibition: MUST NOT be used for RuntimeProjection or Delayed Public Materialization events

### Edit 5 — CHECK constraint (line 890)
- Added `'canonical_extraction'` to allowed `event_origin` values

### Edit 6 — Cross-field invariant (line 891)
- Added `createEvent()` to the enforcement list (alongside `createProjectedEvent()` and Promotion Pipeline)
- Added mapping: `event_origin='canonical_extraction' => visibility_scope IN ('area_visible','world_public')`

## NOT Changed
- Line 760 (DDL comment for `event_origin`) — per task constraint "Do NOT change schema DDL (that was T3's job)"
- No files other than `.sisyphus/plans/memory-system.md`

## Verification

### Acceptance Criteria
1. ✅ `createProjectedEvent()` signature includes `origin` parameter persisted as `event_origin`
2. ✅ `createProjectedEvent()` documented as **sole storage entry point** for projected/materialized `area_visible` public events
3. ✅ `createEvent()` explicitly scoped to canonical public writes and promotion — NOT area_visible projected events
4. ✅ Task Agent Call 1 `create_event()` tool scoped to canonical public writes with `event_origin='canonical_extraction'`; NOT for projected events
5. ✅ `grep -n "sole.*entry point" memory-system.md` matches at line 113 and line 1237 near `createProjectedEvent()`

### grep verification
```
$ grep -n "sole.*entry point" .sisyphus/plans/memory-system.md
113:... `createProjectedEvent()` is the sole storage entry point ...
1237:... This is the **sole storage entry point** for projected/materialized ...
```
