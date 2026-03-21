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

## [T9 Complete] Task: T9 — Publication Hot-Path Materialization
- materializePublications() is a standalone exported function in materialization.ts (not a class method) — avoids needing Database from bun:sqlite in TurnService
- MaterializationService.materializePublications() delegates to the standalone function for backward compat
- createProjectedEvent() now accepts optional sourceSettlementId, sourcePubIndex, visibilityScope; defaults visibilityScope to 'area_visible'
- Search doc sync routes world_public events to search_docs_world (not search_docs_area)
- Publication kind mapping: speech/record/broadcast -> speech, display -> observation
- Publication scope mapping: current_area -> area_visible, world_public -> world_public
- current_area publications without locationEntityId are skipped; world_public can use sentinel 'world' entity
- Idempotency via ux_event_nodes_publication_scope unique index: duplicate inserts caught as SQLite constraint errors and counted as reconciled
- TurnService._graphStorage renamed to graphStorage (removed underscore prefix); publication materialization happens AFTER settlement transaction (non-fatal on failure)
- publicReply alone never triggers publication materialization — only explicit publications[] array
- Test count: 1195 pass, 0 fail across 84 files (+9 new tests)

## [T10 Complete] Task: T10 — Mixed-History Flush Support
- PendingSettlementSweeper already handles v3/v4 transparently: it does NOT inspect schema version, just forwards records to MemoryTaskAgent → MemoryIngestionPolicy → ExplicitSettlementProcessor
- loadExistingContext() was already upgraded in T6 to read canonical stance/basis via CognitionRepository.getAssertions() and getCommitments()
- Legacy rows (with only epistemic_status/belief_type, no stance/basis) are canonicalized by CognitionRepository.toCanonicalAssertion() via EPISTEMIC_STATUS_TO_STANCE and BELIEF_TYPE_TO_BASIS fallback maps
- No confidence or epistemic_status fields leak into the model provider context — only stance/basis are exposed
- Commitments are included in loadExistingContext with synthetic stance: status="active" → "accepted", else → "rejected"
- The sweeper's range advancement is monotonic: markProcessed(sessionId, rangeEnd) covers all records ≤ rangeEnd regardless of settlement schema version
- Backoff policy for COGNITION_UNRESOLVED_REFS unchanged: 5min base, 6h max, 5 failures → blocked_manual
- No code changes were needed in sweeper or task-agent — T6 and T8 already handled the canonical read and write paths
- Test count: 1201 pass, 0 fail across 84 files (+6 new tests: 2 sweeper mixed v3/v4, 4 loadExistingContext canonical/legacy/commitment/backoff)

## [T11 Complete] Task: T11 — Split Narrative Retrieval
- NarrativeSearchService (`src/memory/narrative/narrative-search.ts`) is the canonical narrative-only search layer
- Queries ONLY `search_docs_area` + `search_docs_world` FTS5 tables — never `search_docs_private`
- Visibility gated on `current_area_id` presence (not `viewer_role`): area searched when `current_area_id != null`, world always searched
- `RetrievalService.searchVisibleNarrative()` now delegates to `NarrativeSearchService.searchNarrative()`
- `RetrievalService.generateMemoryHints()` now delegates to `NarrativeSearchService.generateMemoryHints()`
- Removed `escapeFtsQuery()` and `mapSearchRow()` from RetrievalService (now only in NarrativeSearchService)
- `localizeSeedsHybrid()` unchanged — still calls `searchVisibleNarrative()` which now returns narrative-only
- 6 existing tests updated to reflect narrative/cognition split: private docs no longer surface via narrative search
- `getMemoryHints()` in prompt-data.ts unchanged (signature preserved, behavior correctly narrowed to narrative-only)
- VisibilityPolicy already uses `viewer_agent_id` + `current_area_id` only — confirmed with 2 new tests
- Test count: 1206 pass, 0 fail across 84 files (+5 new tests: 3 NarrativeSearchService, 2 visibility-policy viewer_role irrelevance)

## [T12 Complete] Task: T12 — Cognition Search
- `CognitionSearchService` (`src/memory/cognition/cognition-search.ts`) is the canonical cognition-only search layer
- Queries ONLY `search_docs_cognition` + `search_docs_cognition_fts` — never narrative tables
- Accepts `{ agentId, query?, kind?, stance?, basis?, activeOnly?, limit? }`
- Returns `CognitionHit[]` with `kind`, `basis`, `stance`, `source_ref`, `content`, `updated_at`
- Commitment default: `activeOnly=true` when `kind === "commitment"`
- Commitment sorting: `priority ASC → horizon_rank ASC → updated_at DESC` (immediate=1, near=2, long=3, null=99)
- `CognitionRepository.syncCognitionSearchDoc()` populates `search_docs_cognition` + FTS on every upsert (assertion/evaluation/commitment)
- `CognitionRepository.retractCognition()` now also updates `search_docs_cognition.stance` to `rejected`/`abandoned`
- Content format: assertion=`"{predicate}: {source} → {target}"`, commitment=`"{mode}: {JSON target}"`, evaluation=`"evaluation: {notes}"`
- Source ref: assertion=`private_belief:{id}`, evaluation/commitment=`private_event:{id}`
- `activeOnly` SQL: `(d.stance IS NULL OR d.stance NOT IN ('rejected', 'abandoned'))` — NULL stance passes through for commitments, then post-filtered by `cognition_status = 'active'`
- `getAssertions()` now accepts `{ stance?, basis? }` filters; `getCommitments()` accepts `{ mode? }` filter
- Cognition hits never appear in `NarrativeSearchService` results — complete scope isolation
- Test count: 1214 pass, 0 fail across 84 files (+8 new tests: 4 retrieval-search CognitionSearchService, 4 cognition-commit search by kind/stance/basis)

## [T13 Complete] Task: T13 — Retrieval Orchestrator & Contract Types
- `src/memory/contracts/` directory created with 4 files: retrieval-template.ts, write-template.ts, visibility-policy.ts, agent-permissions.ts
- `RetrievalTemplate`: narrativeEnabled, cognitionEnabled, maxNarrativeHits, maxCognitionHits — role-based defaults via `getDefaultTemplate(role)`
- `WriteTemplate`: allowPublications, allowCognitionWrites — role-based defaults via `getDefaultWriteTemplate(role)`
- `AgentPermissions`: simple type with `canAccessCognition`/`canWriteCognition` booleans, defaults derived from role (`rp_agent` = true for both)
- `visibility-policy.ts`: re-export only, no duplication of VisibilityPolicy logic
- `AgentProfile` now has optional `retrievalTemplate?` and `writeTemplate?` fields — fully additive, no existing code breaks
- `AgentFileEntry` extended with same optional fields; `toAgentProfile()` passes them through
- `task/profile.ts`: no changes needed — object spread in `createTaskProfile()` and `spawnFromConfig()` naturally preserves optional fields
- `presets.ts`: no changes needed — optional fields default to `undefined`, orchestrator applies role defaults
- `RetrievalOrchestrator.search()` resolves effective template via `resolveTemplate(agentProfile.role, agentProfile.retrievalTemplate)` then dispatches to NarrativeSearchService/CognitionSearchService
- `resolveTemplate()` and `resolveWriteTemplate()` merge profile override on top of role defaults (partial override, not full replacement)
- `viewer_role` NOT used in any new code — template defaults keyed on `agentProfile.role`, visibility still via `viewer_agent_id` + `current_area_id`
- Test count: 1217 pass, 0 fail across 84 files (+3 new tests: 2 agent-loader template roundtrip, 1 bootstrap preset merge)

## [T14 Complete] Task: T14 — Migrate Search Tool Facade
- `narrative_search` tool added: same schema/behavior as old `memory_search`, delegates to `NarrativeSearchService.searchNarrative()` when available, falls back to `RetrievalService.searchVisibleNarrative()`
- `cognition_search` tool added: params `{ query?, kind?, stance?, basis?, active_only? }`, delegates to `CognitionSearchService.searchCognition()`, returns error object when service unavailable
- `memory_search` preserved as compatibility alias: calls identical `narrativeSearchHandler()` as `narrative_search`, schema unchanged (no cognition params)
- `MemoryToolServices` extended with optional `narrativeSearch` and `cognitionSearch` service interfaces (structural typing, no concrete class imports in tools.ts)
- `src/bootstrap/tools.ts` instantiates `NarrativeSearchService(services.db)` and `CognitionSearchService(services.db)` and passes to `buildMemoryTools`
- `RP_AUTHORIZED_TOOLS` now 7 entries: added `narrative_search` and `cognition_search`
- `tool-access-policy.ts` unchanged — generic allowlist pattern, no hardcoded tool names; new tools pass through automatically via `RpToolPolicy.toToolPermissions()`
- `tool-adapter.ts` unchanged — generic adapter pattern, no tool-name awareness needed
- Tool count: 5 → 7 (narrative_search, cognition_search added)
- Test count: 1223 pass, 0 fail across 84 files (+6 new tests: 3 narrative_search, 2 cognition_search, 1 alias behavior verification)

## [T15 Complete] Task: T15 — Migrate Memory Explore
- `GraphNavigator` constructor now accepts optional `narrativeSearch?: NarrativeSearchServiceLike` and `cognitionSearch?: CognitionSearchServiceLike` (positions 5 and 6, after `_modelProvider`)
- Duck-type interfaces exported from `navigator.ts`: `NarrativeSearchServiceLike` (requires `searchNarrative(query, viewerContext) → Promise<Array<{source_ref}>>`) and `CognitionSearchServiceLike` (requires `searchCognition(params) → Array<{source_ref}>`)
- Seed enhancement: after `localizeSeedsHybrid()`, `collectSupplementalSeeds()` queries narrative (score 0.7, scope "world") and cognition (score 0.6, scope "private") services, deduplicates against existing seeds by node_ref
- `mergeSeeds()` ensures no duplicate node_refs between primary and supplemental seed sets
- `getRelatedNodeRefs(nodeRef)` queries `memory_relations` table for both source/target directions; returns `[]` on any error (table missing, no rows)
- `expandRelationEdges()` called in `fetchNeighborsByFrontier()` after all existing expand calls; adds edges with kind="fact_relation", weight=0.6, summary="memory_relation"
- Beam expansion algorithm, query type routing, edge scoring, and all 6 query types (entity/event/why/relationship/timeline/state) unchanged
- `memory_explore` tool name unchanged; `GraphNavigatorLike` duck-type in tools.ts unchanged
- `src/bootstrap/tools.ts` now passes `narrativeSearch` and `cognitionSearch` to `GraphNavigator` (reordered declarations so services are created before navigator)
- Graceful degradation: all three enhancement paths (narrative seeds, cognition seeds, relation expansion) use try/catch with empty-result fallback
- Test count: 1229 pass, 0 fail across 84 files (+6 new tests: 2 narrative/cognition seed merge, 1 empty relations graceful degradation, 1 relation-based beam expansion, 1 existing query types backward compat, 1 tools.test memory_explore with full services)

## [T16 Complete] Task: T16 — Render Contested Evidence
- `RelationBuilder` (`src/memory/cognition/relation-builder.ts`): new class with `writeContestRelation()` and `getConflictEvidence()` — writes/reads `conflicts_with` rows in `memory_relations`
- `writeContestRelation()` uses `source_node_ref = "private_belief:{id}"`, `target_node_ref = "cognition_key:{cognitionKey}"` (virtual ref to avoid self-ref CHECK constraint), `relation_type = "conflicts_with"`, `strength = 0.8`, `directness = "direct"`, `source_kind = "agent_op"`, `source_ref = settlementId`
- `source_kind` must be one of CHECK-allowed values: `'turn' | 'job' | 'agent_op' | 'system'` — used `'agent_op'` for assertion transitions
- `CognitionRepository.upsertAssertion()`: calls `writeContestRelation()` after UPDATE and INSERT paths when `params.stance === "contested"` and cognition key is present
- No-key INSERT path skips relation (no cognition key means no virtual target ref to write)
- `CognitionSearchService.searchCognition()`: new `enrichContestedHits()` step — for contested hits, queries `getConflictEvidence(source_ref, 3)` and populates `conflictEvidence?: string[]` field
- `CognitionHit` type extended with optional `conflictEvidence?: string[]`
- `prompt-data.ts`: `RecentCognitionEntry` extended with optional `stance?`, `preContestedStance?`, `conflictEvidence?: string[]`
- `formatContestedEntry()` exported helper: renders `• [kind:key] [CONTESTED: was {preContestedStance}] {summary} | Conflicts: {evidence1}; {evidence2}`
- `getRecentCognition()` render loop: checks `stance === "contested"` before rendering, delegates to `formatContestedEntry()`
- `logic_edges` untouched — only `memory_relations` used for cognition relations
- `INSERT OR REPLACE` handles re-contests of same source+target+type triple (UNIQUE constraint)
- Test count: 1237 pass, 0 fail across 84 files (+8 new tests: 2 cognition-commit contest relation, 2 retrieval-search contested evidence inline, 4 prompt-data contested rendering)

## [T17 Complete] Task: T17 — Shared Block Services V1
- 4 service files: `shared-block-repo.ts`, `shared-block-permissions.ts`, `shared-block-attach-service.ts`, `shared-block-patch-service.ts`
- `SharedBlockRepo`: createBlock (with baseline snapshot seq=0), getBlock, getSections, getSection, plus low-level upsertSection/deleteSection/renameSection/setTitle/writeSnapshot
- `SharedBlockPermissions`: isOwner (created_by_agent_id), isAdmin (owner OR shared_block_admins), canEdit (isAdmin), canRead (isAdmin OR attached)
- `SharedBlockAttachService`: attachBlock (admin-only, agent-only target_kind, idempotent via INSERT OR IGNORE), detachBlock (admin-only), getAttachments
- `SharedBlockPatchService`: applyPatch wraps entire op+log+auto-snapshot in a single transaction; patch_seq monotonic via `COALESCE(MAX(patch_seq), 0) + 1`
- `MoveTargetConflictError` custom error with `retryable = true` for move_section target collision
- Auto-snapshot interval: every 25 patches (`patch_seq % 25 === 0`); snapshot_seq = patch_seq value
- Path validation: uses `assertSectionPath()` from section-path-validator.ts before set_section and move_section (both source and target)
- DbLike duck-type pattern: each service defines its own minimal `DbLike` (prepare/get/all/run/transaction as needed), avoiding import of full `Db` type
- Test wrapper `wrapDb()` bridges `bun:sqlite` `Database` to `DbLike` interface for in-memory testing
- `bun:test` lacks `toMatchObject` — use individual field assertions instead
- Test count: 1267 pass, 0 fail across 85 files (+30 new tests: 7 repo, 4 permissions, 7 attach, 12 patch including auto-snapshot-at-25)

## [T19 Complete] Task: T19 — Canonical-Read Audit
- Only `graph-organizer.ts` had actual canonical-read violations (SQL SELECTs reading `epistemic_status` as primary column)
- Fix pattern: SELECT both `stance` and `epistemic_status`, use `row.stance ?? row.epistemic_status` for display (fallback for legacy rows with NULL stance)
- Retraction check upgraded: `row.stance === "rejected" || row.stance === "abandoned" || row.epistemic_status === "retracted"` covers both old and new rows
- `task-agent.ts` input schema (`epistemic_status: { type: ["string", "null"] }`) and call arg parsing are compat input paths, NOT DB reads — kept as-is
- `task-agent.ts` `loadExistingContext()` already uses CognitionRepository (T6/T10) — no changes needed
- `storage.ts` write path (`epistemic_status` in INSERT) is intentional dual-write compat — kept as-is
- `viewer_role` usages confirmed clean: type definition, context construction, comments only — no SQL predicates
- Remaining `epistemic_status` in src/*.ts (excluding tests/schema/cognition-repo): only fallback reads in graph-organizer, type def in storage, input schema in task-agent, and write-path in storage — all acceptable
- Test count: 1273 pass, 0 fail across 85 files (no new tests needed — existing tests cover the read paths)
