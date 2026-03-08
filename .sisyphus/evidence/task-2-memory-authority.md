# Task 2 Evidence: Memory Authority Rewrite

**Date**: 2026-03-08  
**File edited**: `.sisyphus/plans/memory-system.md`  
**Scope**: Terminology and Source of Truth sections only (lines 111, 113, 150, 158-159)

---

## Changes Made

### Line 111 — Public Narrative Store definition (#6)
**Before**: "Graph is one implementation form within the Narrative Plane, not the totality of shared knowledge."  
**After**: Explicit authority claim — "Authoritative for runtime-emergent shared narrative records and promoted public facts." Added: "Does not own authored canon, world rules, or static definitions — those remain in Shared Lore Canon (T17)."

### Line 113 — RuntimeProjection definition (#8)
**Before**: AreaStateResolver framing implied RuntimeProjection/Delayed Public Materialization were non-authoritative projection layers.  
**After**: Both are described as "write paths into the authoritative Public Narrative Store — not cache or projection layers." Added: `event_origin` persisted on `event_nodes` (`runtime_projection | delayed_materialization | promotion`). Clarified AreaStateResolver reads `event_origin` for retrieval classification, but both event types are authoritative once written.

### Line 150 — Source of Truth table row (Public Narrative Store)
**Before**: `Source of Truth — shared canonical world events and stable public facts` (implied all shared knowledge including authored canon)  
**After**: `Authoritative for runtime-emergent shared narrative records and promoted public facts — what publicly happened or became true at runtime. Not authoritative for authored canon, world rules, or static definitions.`

### Line 158 — Critical invariant
**Before**: Single-sentence claim with no authority-domain distinction.  
**After**: Two-domain model explicit: (1) Shared Lore Canon (T17) = authored canon, world rules, character definitions, static settings. (2) Public Narrative Store = runtime-emergent shared narrative records and promoted public facts. "Neither domain supersedes the other. Runtime must not silently rewrite Lore Canon."

### Line 159 — Authority domains note (added)
New standalone paragraph after the critical invariant:  
> "Authority domains: Shared Lore Canon (T17) is authoritative for authored canon, world rules, and static definitions. Public Narrative Store is authoritative for runtime-emergent shared narrative records and promoted public facts. These are non-overlapping domains — neither supersedes the other."

---

## Verification

```
grep -n "runtime-emergent\|authoritative for" ".sisyphus/plans/memory-system.md"
```

**Output** (4 matches, all in terminology/Source of Truth sections):
```
111: Public Narrative Store ... Authoritative for runtime-emergent shared narrative records and promoted public facts.
150: | Authoritative for runtime-emergent shared narrative records and promoted public facts ...
158: ... (2) Public Narrative Store is authoritative for runtime-emergent shared narrative records and promoted public facts ...
159: ... Public Narrative Store is authoritative for runtime-emergent shared narrative records and promoted public facts.
```

---

## Acceptance Criteria

- [x] Public Narrative Store explicitly framed as authoritative for runtime-emergent narrative, not all authored canon
- [x] No wording implicitly replaces Lorebook/Lore Canon as owner of authored canon (line 111 explicitly defers to T17)
- [x] Authority wording consistent: Lore = authored canon; Public Narrative Store = runtime-emergent narrative
- [x] Grep returns matches in terminology (line 111) and Source of Truth (lines 150, 158, 159)
- [x] RuntimeProjection and Delayed Public Materialization framed as write paths, not non-authoritative projections
- [x] `event_origin` field noted as persisted on `event_nodes` with AreaStateResolver reading it at retrieval
