# Memory Refactor V3 — Learnings

## [2026-03-24] Wave 0-3 Architecture Facts

### Schema Migrations
- `memory:019` — DB constraints (append-only triggers on private_cognition_events, private_episode_events)
- `memory:020` — Projection dual-layer (valid_time/committed_time on area/world tables)
- `memory:021` — Symbolic Relation Layer CHECK constraint update
- `memory:022` — node_id column to node_embeddings + node_kind/node_id columns for GraphNodeRef (Method B)
- `memory:023` — source_type column to area_state_current (system/gm/simulation/inferred_world)

### Key Types & Constants
- `MemoryRelationType` / `MemoryRelationRecord` — exported from `src/memory/types.ts`
- `CanonicalNodeRefKind` / `LEGACY_NODE_REF_KINDS` — in `src/memory/types.ts`
- `GraphNodeRef` — in `src/memory/types.ts`, parsed via `parseGraphNodeRef()`
- `CANONICAL_PINNED_LABELS` = ["pinned_summary", "pinned_index"] — already in types.ts (V2)
- `COMPAT_ALIAS_MAP` — maps old labels to new (V2 already)
- `READ_ONLY_LABELS` — set of read-only labels (V2 already)
- `BLOCK_DEFAULTS` — in `core-memory.ts:11-12`, contains "character"/"user" — T21 target

### RetrievalService Pattern
- `RetrievalService.create(db)` creates a NEW instance each time (NOT a singleton)
- Session boundary in tests = new RetrievalService.create(db) + same DB (different instances)
- `RetrievalOrchestrator` takes `episodeRepository` as dependency
- Episode recall is AUTO-TRIGGERED by `EPISODE_QUERY_TRIGGER` regex (no manual tool call)
- Default `episodeBudget: 0` but `queryEpisodeBoost: 1` means queries with temporal/recall keywords auto-get episodes

### ProjectionManager
- `commitSettlement()` runs SYNC projections: episodes, cognition events, recent_cognition_slot, area state upsert, publications
- ASYNC projections (embeddings, semantic edges, node scoring) go through `GraphOrganizerJob` via MemoryTaskAgent
- `areaWorldProjectionRepo` is an optional constructor param (null if not needed)
- `areaStateArtifacts` is optional param to `SettlementProjectionParams`

### Core Memory Labels — CURRENT STATE (pre-T21)
- Schema CHECK: `CHECK (label IN ('character','user','index','pinned_summary','pinned_index'))` in migration:014
- `PINNED_LABELS = ["pinned_summary", "character"]` in prompt-data.ts:19-20
- `SHARED_LABELS = ["user"]` in prompt-data.ts:20
- tools.ts enum includes: character, user, pinned_summary, pinned_index
- T21 needs to ADD `persona` label, retire `character`/`user` write path

### Guardrails (Global)
- NEVER UPDATE/DELETE private_cognition_events or private_episode_events (append-only)
- NEVER remove agent_fact_overlay table (unkeyed rows still needed)
- NEVER add `as any` type assertions in src/memory/
- Pre-existing LSP errors in core-memory.test.ts and prompt-data.test.ts (Database→Db type mismatch) — DO NOT FIX

### Testing Patterns
- Use `bun test` (NOT jest/vitest)
- Pre-existing 4 failures in `test/runtime/private-thoughts-behavioral.test.ts` (config-dependent "mei" persona — NOT V3 regressions)
- Test baseline as of Wave 3 gate: 1613 pass / 4 fail (4 are config-dependent pre-existing)
- Memory tests: 420 pass / 0 fail

### Environment
- Windows win32 — use Git Bash for bash commands
- `bun run build` = `tsc -p tsconfig.build.json --noEmit`
- No `madge` installed — use `bun run build` for circular import detection

## [2026-03-24] Wave 4 Pre-Work

### T21 Scope — Core Memory Label Replacement
- Must ADD `persona` to schema CHECK constraint (migration needed after :023)
- Must retire `character`/`user` as writable labels (make them read-only)
- V2 has: CANONICAL_PINNED_LABELS, COMPAT_ALIAS_MAP, READ_ONLY_LABELS already
- Files to touch: core-memory.ts, types.ts, prompt-data.ts, tools.ts, schema.ts, test files
- COMPAT_ALIAS_MAP should map character→persona, user→shared for reads

### T21-T23 Parallelization
- T21 and T23 CAN run in parallel (no file conflicts)
- T22 blocked by T21
- T24 blocked by T23

## [2026-03-24] T21 — Persona/Pinned/Shared Label Migration

- Latest migration is now memory:024 (adds persona to core_memory_blocks CHECK)
- schema.test.ts has a hardcoded migration count assertion — must update when adding migrations
- BLOCK_DEFAULTS now has 6 entries: character(ro), user(ro), index(ro), pinned_summary, pinned_index(ro), persona
- READ_ONLY_LABELS = [index, pinned_index, character, user]
- Tool enums are ["persona"] — only persona is writable via RP tools
- PINNED_LABELS = [pinned_summary, persona]; SHARED_LABELS = [user] (legacy compat read)
- prompt-data.test.ts has a test writing to character for shared block coexistence — updated to persona

## [2026-03-24] T22 — PinnedSummaryProposal Persistence

- Migration memory:025 creates `pinned_summary_proposals` table with status CHECK ('pending','applied','rejected')
- Index: `idx_psp_agent_status` on (agent_id, status)
- `PinnedSummaryProposalService` constructor now takes `Db` instead of using in-memory Map
- New method: `markRejected(agentId, settlementId)` — state machine: pending → rejected
- `StoredProposal` type now includes `id`, `status` fields
- Tests use `openDatabase({ path: ":memory:" })` for in-memory Db + `freshFileDb()` for restart simulation
- schema.test.ts migration count assertion updated: 24 → 25
- Memory test baseline: 451 pass / 0 fail (was 420 before T21/T22)

## [2026-03-24] T24 — Shared Blocks Multi-Agent Collaboration

- Migration memory:026 adds retrieval_only column to shared_blocks
- Baseline DDL for shared_blocks is at line ~119 in schema.ts (MEMORY_DDL array), not inside migration:008
- SharedBlockPermissions now has: canGrantAdmin (owner-only), isMember, getRole, isRetrievalOnly
- PatchSeqConflictError added to shared-block-patch-service.ts with retryable=true
- Concurrent patch conflict test uses stale-db wrapper to simulate getNextPatchSeq returning stale value
- SharedBlock type now includes retrievalOnly boolean field
- schema.test.ts migration count assertion updated: 25 -> 26
- Shared blocks test baseline: 63 pass / 0 fail
