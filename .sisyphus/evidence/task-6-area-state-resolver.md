# Task 6 Evidence: AreaStateResolver Scope Narrowing

**Date**: 2026-03-08

## Changes Made

### memory-system.md (~lines 463-470)

Replaced the old 3-line AreaStateResolver section with a 5-line expanded version that:
- Defines AreaStateResolver as reading persisted `event_origin` for retrieval interpretation only
- Maps `event_origin='runtime_projection'` to **live perception**
- Maps `event_origin='delayed_materialization'` or `event_origin='canonical_extraction'` to **historical recall**
- Explicitly excludes V1 durable current-state inference, `state_effect` model, state snapshots, and current-state derivation engine

**Old text (lines 464-466)**:
```
- Runtime-projected area events = "current visible state" source (what agents perceive as happening now)
- Delayed materialized public events = "historical narrative" (for memory recall, not real-time perception)
- AreaStateResolver is a runtime retrieval policy, defined in the core runtime plan
```

**New text**:
```
- Reads persisted `event_origin` on `event_nodes` to classify authoritative public events for retrieval interpretation only — NOT to determine truth level (all written public events are authoritative).
- `event_origin='runtime_projection'` → classified as **live perception** (what agents perceive as happening now in the area)
- `event_origin='delayed_materialization'` or `event_origin='canonical_extraction'` → classified as **historical recall** (for memory recall, not real-time perception)
- V1 scope: AreaStateResolver is a live perception / historical recall classifier only. It does NOT infer durable current state from `event_nodes` alone. No `state_effect` model, no state snapshots, no current-state derivation engine in V1.
- AreaStateResolver is a runtime retrieval policy, defined in the core runtime plan (maidsclaw-v1.md)
```

### maidsclaw-v1.md (line 316)

Line 316 already contained live perception / historical recall language from T1. Appended V1 exclusion clause to the ownership table row:

**Added**: "V1: AreaStateResolver does NOT infer durable current state from `event_nodes` alone — no `state_effect` model, no state snapshots."

## Verification

Both acceptance criteria grep commands confirmed matches after editing (see next section).
