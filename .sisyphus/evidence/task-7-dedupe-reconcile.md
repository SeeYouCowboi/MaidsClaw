# Task 7 — Dedupe & Reconciliation Mechanics Evidence

## Edits Applied

### Edit 1 — RuntimeProjection event_origin (line 440)
Added: `Created event has event_origin='runtime_projection'. This event_origin value is preserved permanently — Delayed Public Materialization reconciliation MUST NOT change it.`

### Edit 2 — Delayed Public Materialization reconciliation (line 449)
Replaced generic "reconcile/link, no duplicate creation" with explicit:
`link private_event.event_id to the existing public event, no duplicate creation. The existing event's event_origin='runtime_projection' is preserved — reconciliation is link-only, do NOT update event_origin.`

### Edit 3 — Promotion Pipeline projected write (line 494)
Added: `The new world_public event row has event_origin='promotion'. The original area_visible event row is preserved intact — Promotion creates a new row, never modifies the original.`

### Edit 4 — Materialization algorithm step 2 (line 2218)
Replaced generic "reconcile: link..." with explicit:
`link private_event.event_id to the existing public event row. Do NOT create a duplicate area_visible row. Do NOT update the existing row's event_origin — it remains 'runtime_projection'. Reconciliation is link-only.`

### QA Additions
- Reconciliation QA (line 2303): Added assertion `event_origin` remains `'runtime_projection'`
- Promotion QA (line 2406): Added assertion new world_public event has `event_origin='promotion'`

## Grep Verification

### Verification 1: link-only / reconcile link / no duplicate
```
grep -n "link.*only\|reconcile.*link\|no duplicate" ".sisyphus/plans/memory-system.md"
```
Matches found at:
- Line 449: reconciliation is link-only
- Line 473: reconcile/link only — no duplicate creation
- Line 2218: Reconciliation is link-only
- Line 2301: no duplicate created
- Line 2304: no duplicate, private_event linked

### Verification 2: event_origin promotion
```
grep -n "event_origin.*promotion\|promotion.*event_origin" ".sisyphus/plans/memory-system.md"
```
Matches found at:
- Line 494: event_origin='promotion' in Promotion Pipeline section
- Line 764: DDL comment
- Line 895: cross-field invariant
- Line 1240: createEvent signature
- Line 2406: Promotion QA assertion

## Key Invariants Established
1. One non-null `source_record_id` → at most one `area_visible` public event (line 473)
2. Reconciliation is link-only — preserves existing `event_origin` (lines 449, 2218)
3. Promotion creates new `world_public` row with `event_origin='promotion'`, original `area_visible` preserved (line 494)
4. `event_origin` is immutable after write (lines 440, 449, 2218, 2303)
