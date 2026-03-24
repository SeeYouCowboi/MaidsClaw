# Explain Tool Facets Evaluation

**Task**: T28 — §26 Explain 工具面评估  
**Date**: 2026-03-24  
**Status**: COMPLETE — all facets DEFER  
**Blocks**: T33 (Explain Detail Levels 评估)

---

## 1. Current Tool: `memory_explore`

### Definition
```
src/memory/tools.ts → makeMemoryExplore()
```

`memory_explore` is the unified graph-traversal explain entry point. It delegates to
`GraphNavigator.explore()` and renders via `toExplainShell()`.

### Parameters
| Param | Type | Notes |
|---|---|---|
| `query` | string (required) | Natural language or pointer-annotated |
| `mode` | `why \| timeline \| relationship \| state \| conflict` | Optional. Overrides auto-detected query type |
| `focusRef` | NodeRef | Optional seed anchor (`event:12`, `fact:3`) |
| `focusCognitionKey` | string | Optional cognition thread anchor |
| `asOfTime` + `timeDimension` | number + enum | Canonical time-slice params (T26 forward) |
| `asOfValidTime` / `asOfCommittedTime` | number | Legacy time-slice params (compat) |

### Kernel: `GraphNavigator`
The navigator kernel (`src/memory/navigator.ts`) handles all explain modes:

```typescript
const QUERY_TYPE_PRIORITY = {
  entity:       ["fact_relation", "participant", "fact_support", "semantic_similar"],
  event:        ["same_episode", "temporal_prev", "temporal_next", "causal", "fact_support"],
  why:          ["causal", "fact_support", "fact_relation", "temporal_prev"],
  relationship: ["fact_relation", "fact_support", "participant", "semantic_similar"],
  timeline:     ["temporal_prev", "temporal_next", "same_episode", "causal", "fact_support"],
  state:        ["fact_relation", "conflict_or_update", "fact_support", "temporal_next"],
  conflict:     ["conflict_or_update", "fact_relation", "fact_support", "causal", "temporal_prev"],
};
```

Each mode drives a different beam-expansion priority without any duplication of traversal logic.

### Output shape (via `toExplainShell`)
```typescript
{
  query: string,
  query_type: QueryType,
  summary: string,
  drilldown?: { mode, focus_ref, focus_cognition_key, as_of_valid_time, as_of_committed_time, time_sliced_paths },
  evidence_paths: Array<{
    rank, summary, score, seed, depth,
    visible_steps, redacted, supporting_facts
  }>
}
```

This output shape is **identical for all modes**. The only mode-specific data is `query_type` inside
`drilldown`, and the relative ordering/weighting of evidence paths (driven by the edge priority table).

---

## 2. Candidate Facet Evaluations

### `memory_explain` — General graph explanation

- **Query intent**: "Explain the relationship/reason for X" — general purpose, no mode bias
- **Overlaps with `memory_explore`**: **YES** — `memory_explore` with no `mode` (defaults to auto-detect)
  or `mode=why` / `mode=relationship` covers this completely
- **Return structure difference**: None. Both return the same `NavigatorResult` → `toExplainShell` shape
- **Capability/audit impact**: None. Already `read_only` + `trace_visibility: public`. A separate
  tool name doesn't improve audit traceability over the existing `memory_explore` with `query_type`
  in its response
- **Kernel sharing**: Trivially yes — it would just call `navigator.explore()` with no mode override,
  which is what `memory_explore` already does
- **Recommendation**: **KEEP_UNIFIED**
- **Rationale**: This facet is `memory_explore` with no meaningful parameter restriction. Creating a
  separate `memory_explain` tool adds a redundant entry to the tool list without new capability or
  structural differentiation. Auto-mode detection via `analyzeQuery()` already handles the general
  case well.

---

### `memory_timeline` — Chronological timeline for an agent/entity

- **Query intent**: "Show me what happened to X in order" — temporal sequencing focus
- **Overlaps with `memory_explore`**: **PARTIAL** — `memory_explore` with `mode=timeline` handles
  the same traversal (edge priority: `temporal_prev → temporal_next → same_episode → causal`).
  The timeline keyword detector in `analyzeQuery` (`when`, `timeline`, `before`, `after`, `sequence`)
  auto-routes to this mode without explicit `mode=timeline`
- **Return structure difference**: Minimal. The `time_sliced_paths` field in `drilldown` gives
  temporal metadata when `asOfValidTime` / `asOfCommittedTime` are set. A dedicated tool could
  make `from_time` / `to_time` first-class params rather than the current `asOfTime + timeDimension`
  pattern. However the *output envelope* remains the same `evidence_paths` array — no new structure
- **Capability/audit impact**: Low. Timeline queries don't require different capabilities than
  general exploration. Audit: `query_type: "timeline"` is already present in all `memory_explore`
  responses when mode is `timeline`, providing sufficient signal
- **Kernel sharing**: Trivially yes — would just call `navigator.explore(q, ctx, { mode: "timeline" })`
- **Recommendation**: **DEFER**
- **Rationale**: The capability and output structure are fully covered by `memory_explore`. A dedicated
  tool would be pure syntax sugar. Deferring until T33 (Explain Detail Levels) determines whether
  timeline queries warrant a different *output format* (e.g., a sorted event list vs. evidence paths)
  makes more sense — that format change is the only scenario that would justify a split.

---

### `memory_conflicts` — Conflict/contested state display

- **Query intent**: "Show all contradictions/disputes around topic X or cognition key K"
- **Overlaps with `memory_explore`**: **PARTIAL** — `memory_explore` with `mode=conflict` + optional
  `focusCognitionKey` handles the same traversal (edge priority: `conflict_or_update → fact_relation →
  fact_support → causal → temporal_prev`). The keyword detector auto-routes conflict/contradict/
  contested queries to this mode
- **Return structure difference**: A strong case could be made for a "contested sides" view:
  presenting conflicting paths as *paired oppositions* (`claim_A` vs `claim_B`) rather than a ranked
  flat list. However `NavigatorResult.evidence_paths` has no pairing structure. Implementing a
  `ConflictResult` type would require changes to the kernel output contract or a post-processing
  step — this is T33-scope work (output format redesign)
- **Capability/audit impact**: Medium. Conflict queries are sensitive — separating them could enable
  a distinct `conflict_read` capability requirement in the execution contract. However, no such
  capability exists yet in the authorization model (T8 completed visibility/auth without a
  `conflict_read` capability). Adding it now is premature
- **Kernel sharing**: Yes — would call `navigator.explore(q, ctx, { mode: "conflict", focusCognitionKey })`
- **Recommendation**: **DEFER**
- **Rationale**: The structural argument for splitting (paired opposition view) is the strongest among
  all candidates, but implementing it requires T33's output format work first. The capability argument
  (separate `conflict_read`) requires T8 extensions not yet planned. Splitting now would create an
  identical-but-named wrapper. Revisit after T33 — if T33 defines a `ConflictView` output type, split
  then with the real structural justification.

---

### `memory_state_trace` — How a belief/assertion evolved over time

- **Query intent**: "Show me how assertion/belief K evolved from first appearance to current state"
- **Overlaps with `memory_explore`**: **PARTIAL** — `memory_explore` with `mode=state` + `focusCognitionKey`
  + `asOfCommittedTime` handles this. The combination covers: state-query edge priority
  (`fact_relation → conflict_or_update → fact_support → temporal_next`), cognition thread anchoring,
  and committed-time slicing for belief-at-time queries
- **Return structure difference**: A genuine case exists for a "state evolution" view: ordered
  checkpoints `[initial_belief → contested → updated → resolved]` rather than ranked evidence paths.
  This is fundamentally a *different presentation* of the same underlying graph traversal data.
  Again, this falls into T33-scope format work
- **Capability/audit impact**: Medium. Tracing cognition evolution is a private-agent operation —
  `focusCognitionKey` already scopes it to the viewer agent's cognition. A separate tool with
  `capability_requirements: ["cognition_read"]` in `executionContract` would improve audit
  clarity. However, `cognition_search` already handles the `cognition_read` capability pattern;
  `memory_state_trace` doesn't need to duplicate it
- **Kernel sharing**: Yes — would call `navigator.explore(q, ctx, { mode: "state", focusCognitionKey })`
  with committed-time slice parameters
- **Recommendation**: **DEFER**
- **Rationale**: The "state evolution" output format (checkpoint list) is the clearest structural
  differentiation among all candidates. However, implementing it correctly requires:
  (a) A new output type (`StateEvolutionResult`) beyond `NavigatorResult`
  (b) Post-processing of evidence paths to extract temporal checkpoints
  This is design work for T33. Without that format, `memory_state_trace` is a named alias for
  `memory_explore?mode=state&focusCognitionKey=K`. Premature splitting without the format
  change would create confusing tool duplication.

---

## 3. Recommendation Summary

| Candidate | Recommendation | Key Reason |
|---|---|---|
| `memory_explain` | **KEEP_UNIFIED** | Identical to `memory_explore` with no mode; no new capability |
| `memory_timeline` | **DEFER** | Fully covered by `mode=timeline`; format differentiation belongs in T33 |
| `memory_conflicts` | **DEFER** | Paired opposition view requires T33 format work; no capability difference yet |
| `memory_state_trace` | **DEFER** | Checkpoint evolution view requires T33 format work; strongest future case |

### Decision: No code changes

All candidates are **KEEP_UNIFIED** or **DEFER**. `memory_explore` remains the single unified entry
point. No new tool files or registrations are needed.

---

## 4. Code Changes

None. `memory_explore` is preserved as-is. No new tools registered.

---

## 5. Architecture Invariants Confirmed

1. **`memory_explore` is the unified entry point** — all graph explain queries route through it
2. **`GraphNavigator.explore()` is the single traversal kernel** — no duplication exists or will be
   introduced
3. **`QUERY_TYPE_PRIORITY` encodes all mode-specific behavior** — adding new modes requires only a
   new entry in this table plus keyword detection, not a new tool
4. **`toExplainShell` is the single output formatter** — it produces the same envelope for all modes

---

## 6. T33 Trigger Conditions

T33 (Explain Detail Levels 评估) should revisit this evaluation if:

1. **`memory_timeline`** — T33 decides on a sorted-event-list output format (not evidence paths)
2. **`memory_conflicts`** — T33 defines a `ConflictView` type with paired opposition structure  
3. **`memory_state_trace`** — T33 defines a `StateEvolutionResult` type with temporal checkpoints
4. **Any facet** — T8-extended authorization model introduces `conflict_read` or `state_trace_read`
   capabilities that necessitate per-tool execution contracts

---

## 7. References

| File | Role |
|---|---|
| `src/memory/tools.ts:439-532` | `makeMemoryExplore` definition |
| `src/memory/tools.ts:264-302` | `toExplainShell` formatter |
| `src/memory/tools.ts:538-550` | `TOOL_FACTORIES` registration list |
| `src/memory/navigator.ts:89-97` | `QUERY_TYPE_PRIORITY` per-mode edge weights |
| `src/memory/navigator.ts:128-199` | `GraphNavigator.explore()` kernel |
| `src/memory/navigator.ts:242-287` | `analyzeQuery()` mode auto-detection |
| `src/memory/types.ts:32-39` | `QueryType` / `ExploreMode` type definitions |
| `src/memory/types.ts:380-439` | `NavigatorResult` / `MemoryExploreInput` shapes |
| `.sisyphus/plans/memory-refactor-v3.md:1864-1914` | T28 full spec |
