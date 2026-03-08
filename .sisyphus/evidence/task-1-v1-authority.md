# Task 1 Evidence: V1 Authority Language Rewrite

**Date**: 2026-03-08
**File edited**: `.sisyphus/plans/maidsclaw-v1.md`
**Scope**: Terminology section (line 138), Narrative Plane field list (line 148), Ownership Table (lines 309, 314, 316), Interpretation notes (line 335), Lore note (line 346)

---

## Changes Made

### Line 138 — `Projection` terminology definition
**Before**: "Projections are never canonical truth."
**After**: Reframed as write paths into the Public Narrative Store. Both RuntimeProjection and Delayed Public Materialization produce authoritative shared narrative evidence in `event_nodes`. Added `event_origin` persistence note.

### Line 148 — `event_nodes` field list in Public Narrative Store bullet
**Before**: `visibility_scope + location_entity_id + event_category + promotion_class + source_record_id`
**After**: Added `event_origin` to the field list.

### Line 309 — Lore ownership row in Ownership Table
**Before**: Conflict Priority column was `—`
**After**: `Authoritative for authored canon, world rules, and static definitions`

### Line 314 — Public Narrative Store ownership row
**Before**: Conflict Priority column was `scope-local (same scope only)`
**After**: `Authoritative for runtime-emergent shared narrative records and promoted public facts`

### Line 316 — RuntimeProjection/Delayed Materialization row
**Before**: "AreaStateResolver distinguishes current (runtime-projected) vs historical (delayed-materialized)."
**After**: Row renamed to "area_visible write paths". AreaStateResolver reads persisted `event_origin`. Both are authoritative once written.

### Line 335 — Interpretation note (lore authority)
**Before**: "Read the lore row as 'always authoritative' rather than 'always inject all lore content'."
**After**: Explicit two-domain model: Lore Canon = authored canon; Public Narrative Store = runtime-emergent narrative. Non-overlapping, neither supersedes the other.

### Line 346 — Lore note
**Before**: "lore remains authoritative even when Prompt Builder injects only a selective subset of lore content for a given agent turn."
**After**: Full two-domain explanation: Lore answers what the world is authored to be; Public Narrative Store answers what publicly happened at runtime. Runtime must not silently rewrite Lore Canon.

---

## Verification

```
grep -n "never canonical truth" ".sisyphus/plans/maidsclaw-v1.md"
```
**Output**: No matches ✅

```
grep -n "runtime-emergent|authoritative for authored canon|event_origin" ".sisyphus/plans/maidsclaw-v1.md"
```
**Output**: 6 matches at lines 138, 148, 314, 316, 335, 346 ✅

---

## Acceptance Criteria

- [x] `.sisyphus/plans/maidsclaw-v1.md` no longer contains `Projections are never canonical truth`
- [x] `.sisyphus/plans/maidsclaw-v1.md` explicitly distinguishes authored canon authority from runtime-emergent narrative authority
- [x] `.sisyphus/plans/maidsclaw-v1.md` includes `event_origin` in the `event_nodes` field list and references runtime write paths as creation paths into authoritative public rows
