## Task 5 Evidence — Visibility SQL Compatibility Assessment

### Files inspected

- `src/memory/contracts/visibility-policy.ts`
- `src/memory/visibility-policy.ts`

### Findings

1. `src/memory/contracts/visibility-policy.ts` is only a re-export:
   - `export { VisibilityPolicy } from "../visibility-policy.js";`

2. Actual SQL fragment logic is in `src/memory/visibility-policy.ts:eventVisibilityPredicate()`:
   - When `current_area_id == null`:
     - `(<alias?>visibility_scope = 'world_public')`
   - Otherwise:
     - `(<alias?>visibility_scope = 'world_public' OR (<alias?>visibility_scope = 'area_visible' AND <alias?>location_entity_id = <number>))`

3. SQLite-specific function check (`json_extract`, `typeof`, `ifnull`, `group_concat`) in `visibility-policy.ts`:
   - `json_extract`: not present
   - `typeof`: not present
   - `ifnull`: not present
   - `group_concat`: not present

### Verdict

**PG-compatible: YES**

Rationale: generated predicate uses plain boolean logic and equality comparisons on `visibility_scope` and `location_entity_id` only; no SQLite-only functions or syntax constructs are used.
