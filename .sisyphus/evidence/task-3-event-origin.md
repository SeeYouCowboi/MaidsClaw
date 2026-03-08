# Task 3: Add event_origin to event_nodes DDL and Schema Documentation

## Date: 2026-03-08

## Changes Made

### Edit 1 — DDL (line 759-760): Added `event_origin` column
- `source_record_id TEXT,` — trailing comma added, comment updated to "event-scoped observable identity"
- `event_origin TEXT NOT NULL` — new column with allowed values and cross-field invariant in comment

### Edit 2 — source_record_id definition (lines 468-471): Tightened wording
- Renamed from "reconciliation key" to "event-scoped observable identity"
- Added dedupe invariant: one non-null source_record_id → at most one area_visible public event
- Format clarified: "not a raw record bucket — one source identity per observable outcome"

### Edit 3 — CHECK constraints (lines 890-891): Added event_origin constraints
- `event_nodes.event_origin` in ('runtime_projection','delayed_materialization','promotion')
- Cross-field invariant documented: runtime_projection/delayed_materialization => area_visible; promotion => world_public

### Edit 4 — T1 schema task description (line 882): Added `event_origin` to column list
- `event_origin` appended to event_nodes column enumeration

### Edit 5 — PRAGMA checklist (line 978): Added `event_origin` to verification
- `event_origin` added to PRAGMA table_info check columns

## Verification: grep results

```
Line 113: ...Persists `event_origin` on `event_nodes`... (existing architectural text)
Line 760: event_origin TEXT NOT NULL  -- 'runtime_projection' | ... (DDL)
Line 882: ...`source_record_id`, `event_origin`)... (T1 schema summary)
Line 890: - Add CHECK constraint: `event_nodes.event_origin`... (constraint notes)
Line 891: - Cross-field invariant... `event_origin IN...` (cross-field invariant)
Line 978: ...source_record_id, event_origin columns exist... (PRAGMA checklist)
```

All 6 matches confirmed across DDL, schema summary, constraint notes, cross-field invariant, and PRAGMA checklist.

## Acceptance Criteria Status
- [x] DDL includes `event_origin TEXT NOT NULL` with allowed values comment
- [x] Cross-field invariant documented: runtime_projection/delayed_materialization => area_visible; promotion => world_public
- [x] source_record_id defined as event-scoped observable identity with dedupe invariant
- [x] T1 schema summary updated to include event_origin
- [x] PRAGMA checklist step updated to verify event_origin column
- [x] grep confirms matches in DDL, schema summary, constraint notes, and PRAGMA checklist
