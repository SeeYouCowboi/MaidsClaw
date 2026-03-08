# Task 10 Evidence: Plan Consistency Remediation

**Date**: 2026-03-08
**Files edited**:
- `.sisyphus/plans/maidsclaw-v1.md`
- `.sisyphus/plans/memory-system.md`

## Issues Resolved

1. **Task Agent write contract drift**
- Removed wording that implied Task Agent directly writes public `event_nodes` / `fact_edges`.
- Unified both plans around the locked contract:
  - Task Agent writes owner-private cognitive records.
  - Task Agent may directly write shared entities/topics/logic data.
  - Public events/facts arise only via RuntimeProjection / Delayed Public Materialization / Promotion.

2. **RuntimeProjection / ProjectionAppendix drift**
- Fixed V1 plan wording so RuntimeProjection is described as consuming producer-generated `ProjectionAppendix`, not structured `private_event` fields.
- Added the missing `projection_class='area_candidate'` requirement to the V1 appendix summary.

3. **Unstable line-number references**
- Replaced stale `This plan L...`, `Draft L...`, and `maidsclaw-v1.md:...` references in `memory-system.md` with stable section-name references.
- Removed task references to deleted draft-only anchors.

4. **ViewerContext example type mismatch**
- Updated QA examples so `current_area_id` uses numeric IDs consistently with the formal `ViewerContext` type.

## Verification

Targeted searches executed after edits:

```powershell
Select-String -Path .sisyphus\plans\memory-system.md -Pattern 'This plan L|Draft L|draft L|\(L[0-9]+|maidsclaw-v1.md:[0-9]+'
Select-String -Path .sisyphus\plans\maidsclaw-v1.md,.sisyphus\plans\memory-system.md -Pattern 'dual-write|writes to Public Narrative Store|shared \+ private overlays|shared events/facts|dual-write pipeline'
Select-String -Path .sisyphus\plans\memory-system.md -Pattern "current_area_id: '"
```

**Result**:
- No stale line-number or draft references remain.
- No residual Task Agent wording implies direct public event/fact writes.
- No `current_area_id` string examples remain.

## Outcome

The two plan files now agree on:
- Task Agent authority boundaries
- RuntimeProjection input source
- ProjectionAppendix summary contract
- Stable internal references for downstream execution
- Numeric `ViewerContext.current_area_id` examples
