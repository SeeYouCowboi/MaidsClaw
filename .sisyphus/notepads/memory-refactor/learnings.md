# Memory Refactor - Learnings

## Baseline
- `bun test` baseline: **1144 pass, 0 fail** across 83 files (captured 2026-03-20)
- Test runner: `bun test` (only automated verification entry point)
- No CI / pre-commit hooks

## Key Files
- `src/memory/schema.ts` — DDL/migration with `MEMORY_DDL`, `MigrationStep[]`, `addColumnIfMissing()` pattern
- `src/memory/storage.ts` — Central write path
- `src/runtime/rp-turn-contract.ts` — Turn/cognition contracts (v3 only currently)
- `src/interaction/contracts.ts` — TurnSettlementPayload (no version field)
- `src/memory/retrieval.ts` — Mixed narrative+cognition retrieval (to be split)
- `src/bootstrap/runtime.ts` — Assembles MemoryTaskAgent/PendingSettlementSweeper/TurnService
- `src/bootstrap/tools.ts` — Registers memory_search/memory_explore
- `src/memory/prompt-data.ts` — Consumes retrieval/core-memory output
- `src/core/prompt-data-adapters/memory-adapter.ts` — MemoryAdapter (facade must stay stable)

## Critical Constraints
- v3/v4 mixed-history MUST coexist - compatibility-first
- `viewer_role` MUST NOT enter VisibilityPolicy/SQL predicates (only for template defaults)
- `source_record_id` = idempotency only; publication lineage = `source_settlement_id + source_pub_index`
- dual-read/dual-write must be collected in repository/adapter, not scattered
- cleanup != dropping old columns (keep for compat, stop using for canonical reads)

## [T1 Complete] Task: T1
- normalizeRpTurnOutcome() is the single entry point for all v3/v4 normalization
- validateRpTurnOutcome() is kept as backward-compat alias
- EPISTEMIC_STATUS_TO_STANCE and BELIEF_TYPE_TO_BASIS are deterministic mapping constants
- CanonicalRpTurnOutcome always has publications: [] (never undefined)
- publicReply="" + publications[] non-empty = valid (no "empty turn" error)

## [T3 Complete] Task: T3
- Migrations 004-006 add canonical columns additively; old columns preserved
- contested constraint is APP-LAYER only for existing tables (SQLite ALTER TABLE doesn't support CHECK)
- MEMORY_DDL updated for fresh installs to include new columns
- Backfill maps: confirmed->confirmed, suspected->tentative, hypothetical->hypothetical, retracted->rejected
- Backfill maps: observation->first_hand, inference->inference, suspicion->inference, intention->introspection
- source_settlement_id+source_pub_index+visibility_scope unique index on event_nodes for publication dedup

## [T2 Complete] Task: T2
- NormalizedSettlementPayload always has publications: [] and schemaVersion: "turn_settlement_v4"
- normalizeSettlementPayload() is the single adapter; consumers don't inspect raw payload shape
- detectSettlementVersion() returns "v3" if no explicit v4 marker
- TurnSettlementPayload.privateCommit is now typed as v3 | v4 union

## [T4 Complete] Task: T4
- memory_relations: supports/conflicts_with/derived_from/supersedes, NO self-ref, strength+directness+source_kind metadata
- search_docs_cognition: indexed by agent_id+kind+stance, FTS5 trigram for content search
- NODE_REF_KINDS: UNCHANGED (assertion=private_belief, evaluation/commitment=private_event)
- migration 007 is idempotent

## [T4 Follow-up] schema count correction
- `src/memory/schema.test.ts` must count non-FTS tables with `sql NOT LIKE '%fts5%'`, which includes FTS shadow tables
- current `createMemorySchema` baseline is `41` non-FTS rows in `sqlite_master` and `4` FTS5 virtual tables

## [T5 Complete] Task: T5
- 6 Shared Block tables: shared_blocks, shared_block_sections, shared_block_admins, shared_block_attachments, shared_block_patch_log, shared_block_snapshots
- target_kind='agent' is the ONLY allowed value in V1 (CHECK constraint)
- section path: ^[a-z0-9_-]+(/[a-z0-9_-]+)*$ — no uppercase, no empty segments, no leading/trailing slash
- patch_seq uniqueness by (block_id, patch_seq) UNIQUE index
- schema count tests updated: non-FTS tables count increased from 21 to 27, migration count from 7 to 8

## [T6 Complete] Task: T6
- CognitionRepository is the single canonical layer for assertion/evaluation/commitment
- Dual-write: new canonical columns + old compat columns written together
- Read: prefer new stance/basis, fall back to epistemic_status/belief_type for legacy
- GraphStorageService explicit methods now delegate to CognitionRepository
- loadExistingContext() now returns canonical stance/basis not confidence/epistemic_status

## [T7 Complete] Task: T7
- State machine enforced in CognitionRepository.upsertAssertion()
- Validation order: read existing -> check terminal -> check transition -> check basis upgrade
- Error codes: COGNITION_ILLEGAL_STANCE_TRANSITION, COGNITION_ILLEGAL_BASIS_DOWNGRADE, COGNITION_TERMINAL_KEY_REUSE, COGNITION_MISSING_PRE_CONTESTED_STANCE, COGNITION_DOUBLE_RETRACT
- Dual-write compat mapping: accepted->confirmed in epistemic_status (not just confirmed->confirmed)

## [T7 Fix] Double retract behavior
- Retract on already-retracted cognition key is idempotent no-op in CognitionOpCommitter
- Terminal key reuse remains enforced for upsert; retract semantics are intentionally tolerant across rounds

## [T8 Complete] Task: T8 — Settlement Write Path Unification
- normalizeRpTurnOutcome() is now non-swallowable in TurnService: failures emit RP_OUTCOME_NORMALIZATION_FAILED and abort the turn (no silent fallback)
- All settlement payload fields (publicReply, privateCommit, publications) now sourced from canonical outcome, not raw buffered result
- structuredClone() before normalizeRpTurnOutcome is necessary — normalizer mutates assertion records in-place (deletes confidence, rewrites stance/basis)
- ExplicitSettlementProcessor now uses CognitionRepository directly instead of CognitionOpCommitter → GraphStorageService chain
- CognitionRepository.upsertAssertion handles entity resolution via resolveEntityByPointerKey; evaluation/commitment target resolution done by caller
- touch ops now properly rejected by normalizer rather than silently stored
- InteractionStore.runInTransaction() wraps SQLite BEGIN IMMEDIATE/COMMIT/ROLLBACK — ensures atomic settlement writes
- Double-retract idempotency (T7) means CognitionOpCommitter.isAlreadyRetracted optimization not needed in direct repo calls
- Tests feeding v3 schemas via `as unknown as` show LSP type errors — intentional test-level bypasses, not runtime issues
