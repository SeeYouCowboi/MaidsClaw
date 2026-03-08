## T8 Evidence — Checklist/QA Refresh

### Stale phrase removal
- `never canonical truth`: zero matches — phrase was not present in either file before edits and remains absent
- `speech/action in an area`: zero matches — phrase was not present in either file before edits and remains absent

Both greps confirmed via `grep -n "never canonical truth\|speech/action in an area"` against both plan files with no output.

### event_origin in schema checklists

- **maidsclaw-v1.md line ~928**: confirmed `event_origin` added to event_nodes column list in the final checklist bullet (`event_nodes=area_visible/world_public only with promotion_class + source_record_id + event_origin`)
- **memory-system.md line ~886**: confirmed present (pre-existing from T3) — `event_origin` listed in schema task summary for event_nodes
- **memory-system.md line ~894**: confirmed present (pre-existing from T3) — CHECK constraint `event_nodes.event_origin IN ('runtime_projection','delayed_materialization','promotion','canonical_extraction')` listed
- **memory-system.md line ~982**: confirmed present (pre-existing from T3) — `event_origin` in `PRAGMA table_info(event_nodes)` verification step 7

### QA/checklist coverage of new contract

- **Reconciliation QA (memory-system.md ~2268)**: added new acceptance criterion bullet — "Reconciliation is link-only: delayed materialization finding an existing RuntimeProjection row links the private_event to it, preserves `event_origin='runtime_projection'` unchanged, and creates no new `event_nodes` row; original `area_visible` row is never overwritten". QA scenario at ~2303 also already verified event_origin immutability explicitly.

- **End-to-end integration test (memory-system.md TF1 ~2482)**: expanded main scenario text to add four explicit additional checks:
  (a) every `event_nodes` row has `event_origin` set (runtime_projection / delayed_materialization / promotion)
  (b) authority split — Shared Lore Canon for world rules/authored canon; Public Narrative Store for runtime-emergent shared narrative records
  (c) direct runtime projection restricted to `speech` event_category for assistant message records (no text reparsing; ProjectionAppendix required)
  (d) AreaStateResolver is retrieval-only — classifies events as live perception vs historical recall; no durable state derivation or state snapshots

- **Final materialization checklist (memory-system.md ~2531, ~2532)**: added two bullets:
  - Reconciliation is link-only (source_record_id match links, event_origin stays 'runtime_projection', no new row)
  - All event_nodes rows have non-null event_origin with CHECK constraint enforced at DB level

- **Final schema checklist (memory-system.md ~2555)**: confirmed `event_origin` added to the event_nodes column list alongside event_category, primary_actor_entity_id, promotion_class, source_record_id

- **maidsclaw-v1.md DoD (~582)**: added new bullet confirming event_origin persisted on every event_nodes row with the full 4-value enum and cross-field invariant, and AreaStateResolver is retrieval-only (no state_effect model in V1)

- **maidsclaw-v1.md final checklist (~930)**: added new bullet confirming authority split (Shared Lore Canon vs Public Narrative Store non-overlapping domains), AreaStateResolver retrieval-only scope, and direct runtime projection restricted to speech event_category only for assistant messages

### Verification grep commands (reproducible)

```bash
# Confirm event_origin in maidsclaw-v1.md final checklist (line ~928)
grep -n "event_origin" H:/MaidsClaw/.sisyphus/plans/maidsclaw-v1.md

# Confirm event_origin in memory-system.md final schema checklist (line ~2555)
grep -n "event_origin" H:/MaidsClaw/.sisyphus/plans/memory-system.md | grep -i "schema has\|column"

# Confirm link-only in memory-system.md
grep -n "link-only" H:/MaidsClaw/.sisyphus/plans/memory-system.md

# Confirm authority split in maidsclaw-v1.md
grep -n "authority split" H:/MaidsClaw/.sisyphus/plans/maidsclaw-v1.md

# Confirm stale phrases absent
grep -n "never canonical truth\|speech/action in an area" H:/MaidsClaw/.sisyphus/plans/maidsclaw-v1.md H:/MaidsClaw/.sisyphus/plans/memory-system.md
```
