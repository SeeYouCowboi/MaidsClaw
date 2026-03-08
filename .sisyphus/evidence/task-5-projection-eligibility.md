# Task 5 Evidence: Runtime-Projection Eligibility Contract Unification

**Date**: 2026-03-08  
**Task**: Rewrite runtime-projection eligibility contract to unify both plan files

## Changes Made

### maidsclaw-v1.md (line 380) — ProjectionAppendix Contract

Added two sentences to the existing paragraph:

1. `RuntimeProjection MUST NOT parse or reprocess assistant message text to infer observability — it consumes ONLY the pre-generated \`ProjectionAppendix\`.`
2. `V1 direct runtime projection allows assistant \`message\` only for \`speech\` event_category; \`action\` / \`observation\` / \`state_change\` event categories must originate from structured \`tool_result\` or \`task_result\` records with a valid \`ProjectionAppendix\`.`

### memory-system.md (line 2442) — Note after payload mapping table

Inserted two sentences into the existing **Note** paragraph:

`RuntimeProjection MUST NOT parse or reprocess \`InteractionRecord.payload.content\` (assistant message text) to infer observability or generate \`public_summary_seed\`. It consumes ONLY the pre-generated \`ProjectionAppendix\` attached by the producer.`

### memory-system.md (line 2463) — Eligibility table row for `message`

Old:
```
| `message` (role='assistant') | YES | RP Agent speech/action in an area |
```

New:
```
| `message` (role='assistant') | YES (speech only) | RP Agent speech in an area. V1 direct runtime projection for `message` is restricted to `event_category='speech'` only. `action` / `observation` / `state_change` from assistant output MUST originate from structured `tool_result` or `task_result` records, not from reparsing assistant message text. |
```

## Acceptance Criteria Verification

### grep -n "speech" memory-system.md (relevant lines)

Line 2453: `event_category: 'speech' | 'action' | 'observation' | 'state_change';`  
Line 2463: `| \`message\` (role='assistant') | YES (speech only) | RP Agent speech in an area. V1 direct runtime projection for \`message\` is restricted to \`event_category='speech'\` only...`

Speech-only wording confirmed in eligibility table row for `message`.

### grep -n "status.*NO|NO.*status" memory-system.md

Line 2467: `| \`status\` | NO | System lifecycle, not narrative |`

`status` remains non-projectable.

### grep -n "MUST NOT parse|reprocess" both files

Both files contain explicit `RuntimeProjection MUST NOT parse or reprocess` language.

## Contract Rules Now Consistent Across Both Files

1. Records without a valid `ProjectionAppendix` are NOT runtime-projectable (flush to memory, follow Delayed Public Materialization instead)
2. RuntimeProjection must never parse or reprocess assistant message text
3. V1 direct runtime projection for `message` is restricted to `speech` only
4. `action` / `observation` / `state_change` must come from structured `tool_result` or `task_result` records
5. `status` remains NO (system lifecycle, not narrative)
